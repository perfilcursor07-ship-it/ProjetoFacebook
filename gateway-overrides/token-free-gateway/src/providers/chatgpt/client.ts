import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BrowserManager } from "../../browser/manager.ts";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import { throwIfSessionExpired } from "../shared/error-guard.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import { textToStream } from "../shared/stream-helpers.ts";
import type { StreamResult } from "../types.ts";
import type { ChatGPTWebAuth } from "./auth.ts";
import { parseChatGPTStream } from "./stream.ts";

/** Até o ChatGPT começar a responder (sentinela + primeiro byte). */
const SEND_TIMEOUT_MS = 120_000;
/**
 * viralizeai: sem nenhum byte novo por este tempo, a resposta é dada como
 * travada. Não é limite da resposta inteira: pesquisa + imagem gerada passam
 * fácil de 2 minutos, mas o ChatGPT manda sinal de vida o tempo todo.
 */
const IDLE_TIMEOUT_MS = 180_000;
/** De quanto em quanto tempo os pedaços já recebidos na aba são trazidos. */
const POLL_MS = 120;
/**
 * viralizeai: ponteiro de uma conversa real do ChatGPT, devolvido ao cliente
 * no fim de cada resposta (`conversa_chatgpt`) e mandado de volta como
 * `conversation_id` na mensagem seguinte. Assim cada conversa do ViralizeAI é
 * uma conversa do chatgpt.com (a mesma que aparece no Chrome do servidor) e o
 * gateway não precisa guardar estado entre reinícios.
 */
const PONTEIRO_CONVERSA = /^chatgpt:([0-9a-z-]{8,80}):([0-9a-z-]{8,80})/i;

type Fio = { conversationId?: string; parentMessageId?: string; externo: boolean };

export class ChatGPTWebClient extends BaseApiClient<ChatGPTWebAuth> {
	readonly providerId = "chatgpt-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "chatgpt.com",
		startUrl: "https://chatgpt.com/",
		cookieDomain: ".chatgpt.com",
		// O alias gpt-5.6 é resolvido pelo ChatGPT como GPT-5.6 Sol.
		// Não anunciar variantes que a interface padrão do ChatGPT não deixa
		// selecionar diretamente evita que o painel prometa uma troca falsa.
		defaultModel: "gpt-5.6",
		models: [
			{ id: "gpt-5.6", name: "GPT-5.6 Sol" },
		],
	};

	private accessToken: string;
	private cookie: string;
	private conversationId: string | undefined;
	private parentMessageId: string | undefined;

	constructor(auth: ChatGPTWebAuth) {
		super(auth);
		this.accessToken = auth.accessToken;
		this.cookie = auth.cookie || `__Secure-next-auth.session-token=${auth.accessToken}`;
	}

	protected getCookies() {
		return parseCookieHeader(this.cookie.trim(), this.config.cookieDomain);
	}

	/** Custom page bootstrapping: wait for oaistatic scripts. */
	protected override async getPage(): Promise<Page> {
		if (this.page) {
			try {
				await this.page.evaluate(() => document.readyState);
				return this.page;
			} catch {
				this.page = null;
			}
		}
		const bm = BrowserManager.getInstance();
		console.log("[ChatGPT Web] Connecting via BrowserManager...");
		this.page = await bm.getPage(this.config.hostKey, this.config.startUrl);
		console.log(`[ChatGPT Web] Using page: ${this.page.url()}`);
		await this.ensureChatGptPageReady();
		console.log("[ChatGPT Web] Connected to Chrome successfully");
		const cookies = this.getCookies();
		if (cookies.length > 0) await bm.addCookies(cookies);
		return this.page;
	}

	private async ensureChatGptPageReady() {
		if (!this.page) return;
		if (!this.page.url().includes("chatgpt.com")) {
			await this.page.goto("https://chatgpt.com/", { waitUntil: "load" });
		}
		try {
			await this.page.waitForFunction(
				() => {
					const scripts = Array.from(document.scripts);
					return scripts.some((s) => s.src?.includes("oaistatic.com") && s.src?.endsWith(".js"));
				},
				{ timeout: 15000 },
			);
		} catch {
			console.warn("[ChatGPT Web] oaistatic script not found in 15s, continuing anyway");
		}
		await new Promise((r) => setTimeout(r, 2000));
	}

	/**
	 * viralizeai: de qual conversa do ChatGPT esta mensagem faz parte.
	 *
	 * - `chatgpt:<conversa>:<mensagem>` → continua aquela conversa real;
	 * - outro `conversation_id` qualquer → conversa nova no chatgpt.com
	 *   (antes TODA chamada caía na última conversa usada, de qualquer
	 *   editor, e o histórico ia se empilhando numa conversa só);
	 * - sem `conversation_id` → comportamento original do gateway.
	 */
	private fioDaMensagem(params: NormalizedSendParams): Fio {
		const externo = String(params.conversationId || "").trim();
		if (!externo) {
			return {
				conversationId: this.conversationId,
				parentMessageId: this.parentMessageId,
				externo: false,
			};
		}
		const m = externo.match(PONTEIRO_CONVERSA);
		return m ? { conversationId: m[1], parentMessageId: m[2], externo: true } : { externo: true };
	}

	/** Corpo do POST /backend-api/conversation, igual ao que a interface manda. */
	private corpoDaMensagem(params: NormalizedSendParams, fio: Fio) {
		return {
			action: "next",
			messages: [
				{
					id: randomUUID(),
					author: { role: "user" },
					content: { content_type: "text", parts: [params.message] },
				},
			],
			parent_message_id: fio.parentMessageId ?? randomUUID(),
			model: params.model,
			timezone_offset_min: new Date().getTimezoneOffset(),
			conversation_id: fio.conversationId,
			history_and_training_disabled: false,
			conversation_mode: { kind: "primary_assistant", plugin_ids: null },
			force_paragen: false,
			force_paragen_model_slug: "",
			force_rate_limit: false,
			reset_rate_limits: false,
			force_use_sse: true,
		};
	}

	/**
	 * Dispara o pedido DENTRO da aba logada e devolve na hora, sem esperar a
	 * resposta terminar. Os pedaços do SSE ficam numa fila da página
	 * (`window.__viralizeaiStreams[id]`) que `lerFila` esvazia.
	 *
	 * Antes a página lia o SSE inteiro e só então devolvia o texto: o editor
	 * olhava uma tela parada enquanto o ChatGPT já estava escrevendo, e tudo
	 * aparecia de uma vez no fim (ou estourava os 120 s quando havia imagem).
	 */
	private iniciarNaPagina(page: Page, body: unknown, streamId: string): Promise<unknown> {
		const pageUrl = page.url();
		return page.evaluate(
			async ({ body: reqBody, pageUrl: refUrl, streamId: id }) => {
				type Fila = {
					status: number;
					chunks: string[];
					done: boolean;
					error?: string;
					sentinelError?: string;
					cancelar?: boolean;
				};
				const w = window as unknown as { __viralizeaiStreams?: Record<string, Fila> };
				w.__viralizeaiStreams ??= {};
				const fila: Fila = { status: 0, chunks: [], done: false };
				w.__viralizeaiStreams[id] = fila;
				try {
					const baseHeaders = (accessToken: string | undefined, deviceId: string) => ({
						"Content-Type": "application/json",
						Accept: "text/event-stream",
						"oai-device-id": deviceId,
						"oai-language": "en-US",
						Referer: refUrl || "https://chatgpt.com/",
						"sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
						"sec-ch-ua-mobile": "?0",
						"sec-ch-ua-platform": '"macOS"',
						...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
					});
					async function warmupSentinel(accessToken: string | undefined, deviceId: string) {
						const h = baseHeaders(accessToken, deviceId);
						for (const caminho of [
							"conversation/init",
							"sentinel/chat-requirements/prepare",
							"sentinel/chat-requirements/finalize",
						]) {
							await fetch(`https://chatgpt.com/backend-api/${caminho}`, {
								method: "POST",
								headers: h,
								body: "{}",
								credentials: "include",
							}).catch(() => {});
						}
					}
					async function getSession() {
						const r = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include" });
						return r.ok ? r.json() : null;
					}
					async function tryFetchWithSentinel(accessToken: string | undefined, deviceId: string) {
						await warmupSentinel(accessToken, deviceId);
						const assetSrc = Array.from(document.scripts)
							.map((s) => s.src)
							.find((s) => s?.includes("oaistatic.com") && s.endsWith(".js"));
						const assetUrl = assetSrc || "https://cdn.oaistatic.com/assets/i5bamk05qmvsi6c3.js";
						try {
							const g = await import(/* @vite-ignore */ assetUrl);
							if (typeof g.bk !== "function" || typeof g.fX !== "function")
								return { error: `Sentinel asset missing bk/fX (asset: ${assetUrl})` };
							const z = await g.bk();
							const turnstileKey = z?.turnstile?.bx ?? z?.turnstile?.dx;
							if (!turnstileKey) return { error: "Sentinel chat-requirements missing turnstile" };
							const r = await g.bi(turnstileKey);
							let arkose: unknown = null;
							try {
								arkose = await g.bl?.getEnforcementToken?.(z);
							} catch {
								/* Arkose may fail */
							}
							let p: unknown = null;
							try {
								p = await g.bm?.getEnforcementToken?.(z);
							} catch {
								/* Proof token may fail */
							}
							const extraHeaders = await g.fX(z, arkose, r, p, null);
							const res = await fetch("https://chatgpt.com/backend-api/conversation", {
								method: "POST",
								headers: {
									...baseHeaders(accessToken, deviceId),
									...(typeof extraHeaders === "object" ? extraHeaders : {}),
								},
								body: JSON.stringify(reqBody),
								credentials: "include",
							});
							return { res };
						} catch (e: unknown) {
							return { error: `Sentinel token failed: ${e instanceof Error ? e.message : String(e)}` };
						}
					}
					const session = await getSession();
					const accessToken = session?.accessToken as string | undefined;
					const deviceId =
						(session as { oaiDeviceId?: string })?.oaiDeviceId ??
						globalThis.crypto?.randomUUID?.() ??
						Math.random().toString(36).slice(2);
					const sentinelResult = await tryFetchWithSentinel(accessToken, deviceId);
					const res =
						sentinelResult.res ??
						(await fetch("https://chatgpt.com/backend-api/conversation", {
							method: "POST",
							headers: baseHeaders(accessToken, deviceId),
							body: JSON.stringify(reqBody),
							credentials: "include",
						}));
					fila.sentinelError = "error" in sentinelResult ? sentinelResult.error : undefined;
					if (!res.ok) {
						fila.error = await res.text();
						fila.status = res.status;
						return;
					}
					const reader = res.body?.getReader();
					if (!reader) {
						fila.error = "No response body";
						fila.status = 500;
						return;
					}
					fila.status = res.status;
					const decoder = new TextDecoder();
					while (true) {
						if (fila.cancelar) {
							await reader.cancel().catch(() => {});
							break;
						}
						const { done, value } = await reader.read();
						if (done) break;
						fila.chunks.push(decoder.decode(value, { stream: true }));
					}
				} catch (e: unknown) {
					fila.error = e instanceof Error ? e.message : String(e);
					if (!fila.status) fila.status = 500;
				} finally {
					fila.done = true;
				}
			},
			{ body, pageUrl, streamId },
		);
	}

	/** Esvazia a fila da página: pedaços novos + situação do pedido. */
	private lerFila(page: Page, streamId: string) {
		return page.evaluate((id) => {
			const w = window as unknown as {
				__viralizeaiStreams?: Record<
					string,
					{ status: number; chunks: string[]; done: boolean; error?: string; sentinelError?: string }
				>;
			};
			const fila = w.__viralizeaiStreams?.[id];
			if (!fila) return null;
			const data = fila.chunks.splice(0).join("");
			if (fila.done && w.__viralizeaiStreams) delete w.__viralizeaiStreams[id];
			return {
				status: fila.status,
				done: fila.done,
				error: fila.error,
				sentinelError: fila.sentinelError,
				data,
			};
		}, streamId);
	}

	private cancelarNaPagina(page: Page, streamId: string) {
		return page
			.evaluate((id) => {
				const w = window as unknown as { __viralizeaiStreams?: Record<string, { cancelar?: boolean }> };
				const fila = w.__viralizeaiStreams?.[id];
				if (fila) fila.cancelar = true;
			}, streamId)
			.catch(() => {});
	}

	/**
	 * Manda a mensagem e devolve um stream que vai sendo preenchido enquanto o
	 * ChatGPT escreve. Só volta depois que o ChatGPT aceitou o pedido (status
	 * HTTP conhecido), para erro de sessão/403 continuar virando erro HTTP.
	 */
	protected async callApi(
		page: Page,
		params: NormalizedSendParams,
	): Promise<EvalResult & { sentinelError?: string; stream?: ReadableStream<Uint8Array> }> {
		const fio = this.fioDaMensagem(params);
		console.log(
			`[ChatGPT Web] Sending message, Conversation ID: ${fio.conversationId ?? "new"}, Model: ${params.model}`,
		);
		const streamId = randomUUID();
		let terminou = false;
		let falhaNaPagina: unknown = null;
		this.iniciarNaPagina(page, this.corpoDaMensagem(params, fio), streamId)
			.catch((err) => {
				falhaNaPagina = err;
			})
			.finally(() => {
				terminou = true;
			});

		const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
		let pendente = "";
		const limiteInicio = Date.now() + SEND_TIMEOUT_MS;
		for (;;) {
			if (params.signal?.aborted) {
				await this.cancelarNaPagina(page, streamId);
				throw new Error("ChatGPT request cancelled");
			}
			if (falhaNaPagina) throw falhaNaPagina;
			const fila = await this.lerFila(page, streamId).catch(() => null);
			if (fila?.data) pendente += fila.data;
			if (fila?.status) {
				if (fila.status >= 400 || (fila.done && fila.error && !pendente)) {
					return {
						ok: false,
						status: fila.status,
						error: fila.error || "",
						sentinelError: fila.sentinelError,
					};
				}
				if (fila.done) {
					const pronto = textToStream(pendente);
					this.fios.set(pronto, fio);
					return { ok: true, data: "", stream: pronto };
				}
				break;
			}
			if (terminou && !fila) throw new Error("ChatGPT request: a aba perdeu o pedido antes da resposta");
			if (Date.now() > limiteInicio) {
				await this.cancelarNaPagina(page, streamId);
				throw new Error(`ChatGPT request timed out after ${SEND_TIMEOUT_MS / 1000}s`);
			}
			await esperar(POLL_MS);
		}

		const encoder = new TextEncoder();
		let ultimoByte = Date.now();
		const signal = params.signal;
		const stream = new ReadableStream<Uint8Array>({
			pull: async (controller) => {
				if (pendente) {
					controller.enqueue(encoder.encode(pendente));
					pendente = "";
					ultimoByte = Date.now();
					return;
				}
				for (;;) {
					if (signal?.aborted) {
						await this.cancelarNaPagina(page, streamId);
						controller.error(new Error("ChatGPT request cancelled"));
						return;
					}
					const fila = await this.lerFila(page, streamId).catch((err) => {
						falhaNaPagina = falhaNaPagina ?? err;
						return null;
					});
					if (fila?.data) {
						controller.enqueue(encoder.encode(fila.data));
						ultimoByte = Date.now();
						if (fila.done) controller.close();
						return;
					}
					if (fila?.done || (!fila && terminou && !falhaNaPagina)) {
						if (fila?.error) console.warn(`[ChatGPT Web] stream terminou com erro: ${fila.error}`);
						controller.close();
						return;
					}
					if (!fila && falhaNaPagina) {
						controller.error(falhaNaPagina);
						return;
					}
					if (Date.now() - ultimoByte > IDLE_TIMEOUT_MS) {
						await this.cancelarNaPagina(page, streamId);
						controller.error(new Error(`ChatGPT parou de responder por ${IDLE_TIMEOUT_MS / 1000}s`));
						return;
					}
					await esperar(POLL_MS);
				}
			},
			cancel: () => this.cancelarNaPagina(page, streamId),
		});
		this.fios.set(stream, fio);
		return { ok: true, data: "", stream };
	}

	/** Conversa de cada stream em andamento (parseStream recebe só o stream). */
	private fios = new WeakMap<ReadableStream<Uint8Array>, Fio>();

	/**
	 * Override sendMessage for custom error handling:
	 * - 403 → DOM fallback
	 * - 401 → SessionExpiredError
	 * - sentinelError hint
	 */
	override async sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
		conversationId?: string;
		conversationName?: string;
		webSearch?: boolean;
	}): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const normalized: NormalizedSendParams = {
			message: params.message,
			model: params.model || this.config.defaultModel,
			signal: params.signal,
			conversationId: params.conversationId,
			conversationName: params.conversationName,
			webSearch: params.webSearch,
		};
		const responseData = await this.callApi(page, normalized);
		if (!responseData.ok) {
			if (responseData.status === 403) {
				console.log("[ChatGPT Web] 403 from API, falling back to DOM simulation");
				return this.chatCompletionsViaDOM({ message: params.message, signal: params.signal });
			}
			throwIfSessionExpired(
				this.providerId,
				responseData.status,
				"ChatGPT authentication failed. Re-run webauth to refresh the session.",
			);
			const sentinelHint = responseData.sentinelError
				? ` Sentinel: ${responseData.sentinelError}`
				: " If 403 persists, check oaistatic export names in the chatgpt.com console.";
			throw new Error(
				`ChatGPT API error ${responseData.status}: ${responseData.error?.slice(0, 200) || ""}${sentinelHint}`,
			);
		}
		if (responseData.stream) return responseData.stream;
		return textToStream(responseData.data ?? "");
	}

	override async parseStream(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		const fio = this.fios.get(body) ?? { externo: false };
		this.fios.delete(body);
		const atual: { conversationId?: string; parentMessageId?: string } = {};
		const resultado = await parseChatGPTStream(body, onDelta, (meta) => {
			if (meta.conversationId) atual.conversationId = meta.conversationId;
			if (meta.parentMessageId) atual.parentMessageId = meta.parentMessageId;
		});
		// Sem conversation_id do cliente: guarda na instância, como antes.
		if (!fio.externo) {
			if (atual.conversationId) this.conversationId = atual.conversationId;
			if (atual.parentMessageId) this.parentMessageId = atual.parentMessageId;
		}
		const conversa = atual.conversationId ?? fio.conversationId;
		// viralizeai: ponteiro para a próxima mensagem continuar ESTA conversa.
		if (conversa && atual.parentMessageId) {
			resultado.conversa = `chatgpt:${conversa}:${atual.parentMessageId}`;
			resultado.conversaUrl = `https://chatgpt.com/c/${conversa}`;
		}
		// viralizeai: ponteiro interno -> URL baixável.
		resultado.imagens = await this.resolverImagens(resultado.imagens);
		return resultado;
	}

	/**
	 * viralizeai: deixa as imagens da resposta em formato que o ViralizeAI
	 * consiga baixar.
	 *
	 * URL pública (foto que o ChatGPT achou navegando) passa direto. Imagem
	 * que ELE gerou vem como ponteiro (`file-service://file-…`) e não é
	 * baixável de fora: aqui, na página já logada, ela é trocada pela URL
	 * assinada que o próprio ChatGPT usa para mostrar a foto na conversa.
	 *
	 * Nunca lança: imagem é acessório, e o texto da matéria não pode se
	 * perder porque um ponteiro não resolveu.
	 */
	private async resolverImagens(valores?: string[]): Promise<string[]> {
		const entrada = (valores ?? []).filter(Boolean);
		if (!entrada.length) return [];
		const prontas: string[] = [];
		const ponteiros: string[] = [];
		for (const v of entrada) {
			if (v.startsWith("http://") || v.startsWith("https://")) prontas.push(v);
			else ponteiros.push(v);
		}
		if (!ponteiros.length) return prontas;
		// O id do arquivo é o que vem depois do "//" do ponteiro.
		const ids = [
			...new Set(
				ponteiros
					.map((v) => (v.split("//").pop() || "").split("?")[0] || "")
					.filter((id) => id.startsWith("file")),
			),
		];
		if (!ids.length) return prontas;
		try {
			const page = await this.getPage();
			const urls = await page.evaluate(async (lista: string[]) => {
				let token: string | undefined;
				try {
					const s = await fetch("https://chatgpt.com/api/auth/session", {
						credentials: "include",
					});
					if (s.ok) token = ((await s.json()) as { accessToken?: string }).accessToken;
				} catch {
					/* sem token: o cookie de sessão sozinho costuma bastar */
				}
				const saida: string[] = [];
				for (const id of lista) {
					try {
						const r = await fetch(
							`https://chatgpt.com/backend-api/files/${encodeURIComponent(id)}/download`,
							{
								credentials: "include",
								headers: token ? { Authorization: `Bearer ${token}` } : {},
							},
						);
						if (!r.ok) continue;
						const d = (await r.json()) as { download_url?: string };
						if (d.download_url) saida.push(d.download_url);
					} catch {
						/* este arquivo não resolveu; os outros seguem */
					}
				}
				return saida;
			}, ids);
			for (const u of urls) if (!prontas.includes(u)) prontas.push(u);
			if (!urls.length) {
				console.warn(`[viralizeai-imagem] ponteiro nao resolvido: ${ids.join(", ")}`);
			}
		} catch (err) {
			console.warn(
				`[viralizeai-imagem] falha ao resolver ponteiro: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return prontas;
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return this.parseStream(body, onDelta);
	}

	async checkSession(): Promise<{ valid: boolean; reason?: string }> {
		try {
			const page = await this.getPage();
			const result = await page.evaluate(async () => {
				const r = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include" });
				if (!r.ok) return { status: r.status, hasToken: false };
				const data = (await r.json()) as { accessToken?: string };
				return { status: r.status, hasToken: !!data.accessToken };
			});
			if (result.hasToken) return { valid: true };
			return { valid: false, reason: `ChatGPT session returned ${result.status}, no access token` };
		} catch (err) {
			return { valid: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	private async chatCompletionsViaDOM(params: {
		message: string;
		signal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const inputSelectors = [
			"#prompt-textarea",
			"textarea[placeholder]",
			"textarea",
			'[contenteditable="true"]',
		];
		let inputHandle = null;
		for (const sel of inputSelectors) {
			inputHandle = await page.$(sel);
			if (inputHandle) break;
		}
		if (!inputHandle) throw new Error("ChatGPT DOM simulation failed: input not found");
		await inputHandle.click();
		await page.waitForTimeout(300);
		await pasteText(page, params.message, inputHandle);
		await page.waitForTimeout(300);
		await page.keyboard.press("Enter");
		console.log("[ChatGPT Web] DOM: pasted message and pressed Enter");
		const maxWaitMs = 90000;
		const pollIntervalMs = 2000;
		let lastText = "";
		let stableCount = 0;
		for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
			if (params.signal?.aborted) throw new Error("ChatGPT request cancelled");
			await new Promise((r) => setTimeout(r, pollIntervalMs));
			const result = await page.evaluate(() => {
				const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
				const els = document.querySelectorAll(
					'div[data-message-author-role="assistant"], .agent-turn [data-message-author-role="assistant"], [class*="markdown"], [class*="assistant"]',
				);
				const last = els.length > 0 ? els[els.length - 1] : null;
				const text = last ? clean(last.textContent ?? "") : "";
				const stopBtn = document.querySelector('button.bg-black .icon-lg, [aria-label*="Stop"]');
				return { text, isStreaming: !!stopBtn };
			});
			if (result.text && result.text !== lastText) {
				lastText = result.text;
				stableCount = 0;
			} else if (result.text) {
				stableCount++;
				if (!result.isStreaming && stableCount >= 2) break;
			}
		}
		if (!lastText)
			throw new Error(
				"ChatGPT DOM simulation: no assistant reply detected. Ensure chatgpt.com is open, logged in, and the input is visible.",
			);
		const fakeSse = `data: ${JSON.stringify({ message: { id: "dom-fallback", content: { parts: [lastText] } } })}\n\ndata: [DONE]\n\n`;
		return textToStream(fakeSse);
	}
}
