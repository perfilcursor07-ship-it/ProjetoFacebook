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
import { coletarImagens, mensagemVisivel, parseChatGPTStream } from "./stream.ts";

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

type Fio = {
	conversationId?: string;
	parentMessageId?: string;
	externo: boolean;
	chave?: string;
	/** O pedido fala em imagem/foto: vale raspar a tela se nada vier pelos dados. */
	pediuImagem?: boolean;
};

const PEDE_IMAGEM = /\b(imagem|imagens|foto|fotos|capa|ilustra[çc][ãa]o|image|photo)\b/i;

/**
 * Sinais, na conversa salva, de que a resposta MOSTROU imagem na tela
 * (galeria de busca, citação de imagem, imagem gerada).
 */
const SINAL_DE_IMAGEM = /image_group|image_v2|image_results|image_asset_pointer|turn\d+image\d+|"image_query"/i;

/**
 * viralizeai: conversa do ChatGPT de cada conversa do "ChatGPT livre"
 * (`viralizeai:chatgpt:…`), para continuar nela mesmo quando o ViralizeAI
 * ainda não tem o ponteiro (resposta anterior falhou no meio, por exemplo).
 * Fica na memória do gateway; o ponteiro salvo no ViralizeAI é o que vale
 * entre reinícios. Tarefas internas não entram aqui: cada uma abre conversa
 * própria, para uma não contaminar a outra.
 */
const conversasDoChatgptLivre = new Map<string, { conversationId: string; parentMessageId: string }>();
const PREFIXO_CHATGPT_LIVRE = "viralizeai:chatgpt:";

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
		return { ...this.fioDaConversa(params), pediuImagem: PEDE_IMAGEM.test(String(params.message || "")) };
	}

	private fioDaConversa(params: NormalizedSendParams): Fio {
		const externo = String(params.conversationId || "").trim();
		if (!externo) {
			return {
				conversationId: this.conversationId,
				parentMessageId: this.parentMessageId,
				externo: false,
			};
		}
		const m = externo.match(PONTEIRO_CONVERSA);
		if (m) return { conversationId: m[1], parentMessageId: m[2], externo: true };
		if (!externo.startsWith(PREFIXO_CHATGPT_LIVRE)) return { externo: true };
		const salva = conversasDoChatgptLivre.get(externo);
		return { ...(salva ?? {}), externo: true, chave: externo };
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

		// viralizeai: plano B — a conversa pronta, lida direto do ChatGPT.
		// Texto que o leitor do stream não entendeu (o ChatGPT muda o formato)
		// e imagem que ainda estava sendo gerada quando o stream fechou.
		const semTexto = !resultado.text;
		const semImagem = !resultado.imagens?.length && Boolean(resultado.aguardandoImagem);
		let sinalDeImagem = false;
		if (conversa && (semTexto || semImagem)) {
			const limite = Date.now() + (semImagem ? 150_000 : 15_000);
			for (let tentativa = 0; Date.now() < limite; tentativa++) {
				if (tentativa) await new Promise((r) => setTimeout(r, 5_000));
				const lida = await this.lerConversa(conversa).catch((err) => {
					console.warn(`[ChatGPT Web] conversa ${conversa} nao lida: ${err instanceof Error ? err.message : err}`);
					return null;
				});
				if (!lida) continue;
				if (lida.ultimoId) atual.parentMessageId = lida.ultimoId;
				sinalDeImagem = sinalDeImagem || lida.sinalDeImagem;
				if (!resultado.text && lida.texto) {
					console.log(`[ChatGPT Web] texto recuperado da conversa (${lida.texto.length} chars)`);
					resultado.text = lida.texto;
					onDelta?.(lida.texto);
				}
				for (const img of lida.imagens) {
					resultado.imagens = resultado.imagens ?? [];
					if (!resultado.imagens.includes(img)) resultado.imagens.push(img);
				}
				const faltaTexto = !resultado.text;
				const faltaImagem = semImagem && !resultado.imagens?.length;
				if (!faltaTexto && !faltaImagem) break;
				if (faltaImagem) console.log("[ChatGPT Web] imagem ainda sendo gerada; aguardando…");
			}
		}

		// viralizeai: plano C — a imagem que aparece NA TELA da conversa.
		//
		// A foto que o ChatGPT acha pesquisando na web e mostra na resposta não
		// vem no stream (o log dizia "0 imagem(ns)" com a foto ali na conversa),
		// e o ViralizeAI saía procurando outra. Quando o pedido falou em imagem
		// e nada veio pelos dados, abre a conversa e pega as imagens grandes da
		// última resposta, como alguém olhando a tela.
		if (conversa && !resultado.imagens?.length) {
			if (!sinalDeImagem && !fio.pediuImagem) {
				const lida = await this.lerConversa(conversa).catch(() => null);
				if (lida?.imagens.length) resultado.imagens = lida.imagens;
				sinalDeImagem = Boolean(lida?.sinalDeImagem);
			}
			if (!resultado.imagens?.length && (fio.pediuImagem || sinalDeImagem)) {
				const daTela = await this.imagensDaTela(conversa).catch((err) => {
					console.warn(`[viralizeai-imagem] tela da conversa não lida: ${err instanceof Error ? err.message : err}`);
					return [] as string[];
				});
				if (daTela.length) {
					console.log(`[viralizeai-imagem] ${daTela.length} imagem(ns) raspada(s) da tela da conversa`);
					resultado.imagens = daTela;
				}
			}
		}

		// Sem conversation_id do cliente: guarda na instância, como antes.
		if (!fio.externo && atual.parentMessageId) this.parentMessageId = atual.parentMessageId;
		if (fio.chave && conversa && atual.parentMessageId) {
			if (conversasDoChatgptLivre.size > 500) conversasDoChatgptLivre.clear();
			conversasDoChatgptLivre.set(fio.chave, { conversationId: conversa, parentMessageId: atual.parentMessageId });
		}
		// viralizeai: ponteiro para a próxima mensagem continuar ESTA conversa.
		if (conversa && atual.parentMessageId) {
			resultado.conversa = `chatgpt:${conversa}:${atual.parentMessageId}`;
			resultado.conversaUrl = `https://chatgpt.com/c/${conversa}`;
		}
		console.log(
			`[ChatGPT Web] resposta: ${resultado.text.length} chars, ${resultado.imagens?.length ?? 0} imagem(ns), conversa ${conversa ?? "-"}`,
		);
		// viralizeai: ponteiro interno -> URL baixável.
		resultado.imagens = await this.resolverImagens(resultado.imagens, conversa);
		return resultado;
	}

	/**
	 * viralizeai: a resposta como ficou salva no chatgpt.com — o texto do
	 * assistente e as imagens desde a última mensagem do usuário (o turno
	 * atual), e o id da última mensagem para continuar a conversa.
	 */
	private async lerConversa(
		conversationId: string,
	): Promise<{ texto: string; imagens: string[]; ultimoId?: string; sinalDeImagem: boolean }> {
		const page = await this.getPage();
		const dados = (await page.evaluate(async (id: string) => {
			let token: string | undefined;
			try {
				const s = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include" });
				if (s.ok) token = ((await s.json()) as { accessToken?: string }).accessToken;
			} catch {
				/* o cookie basta na maioria das vezes */
			}
			const r = await fetch(`https://chatgpt.com/backend-api/conversation/${encodeURIComponent(id)}`, {
				credentials: "include",
				headers: token ? { Authorization: `Bearer ${token}` } : {},
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return r.json();
		}, conversationId)) as {
			current_node?: string;
			mapping?: Record<string, { parent?: string; message?: Record<string, unknown> | null }>;
		};
		const mapa = dados.mapping ?? {};
		const turno: Record<string, unknown>[] = [];
		let no = dados.current_node;
		for (let passos = 0; no && passos < 200; passos++) {
			const msg = mapa[no]?.message;
			if (msg) {
				if ((msg.author as { role?: string } | undefined)?.role === "user") break;
				turno.unshift(msg);
			}
			no = mapa[no]?.parent;
		}
		const textos: string[] = [];
		const imagens: string[] = [];
		for (const msg of turno) {
			const conteudo = (msg.content ?? {}) as { content_type?: string; parts?: unknown[] };
			coletarImagens(conteudo.parts, imagens);
			coletarImagens(msg.metadata, imagens);
			const visivel = mensagemVisivel({
				papel: (msg.author as { role?: string } | undefined)?.role,
				tipo: conteudo.content_type,
				destino: typeof msg.recipient === "string" ? msg.recipient : undefined,
			});
			if (!visivel) continue;
			const parte = conteudo.parts?.[0];
			const t = typeof parte === "string" ? parte : "";
			if (t.trim()) textos.push(t.trim());
		}
		return {
			texto: textos.join("\n\n"),
			imagens,
			ultimoId: dados.current_node,
			sinalDeImagem: SINAL_DE_IMAGEM.test(JSON.stringify(turno)),
		};
	}

	/**
	 * viralizeai: imagens da ÚLTIMA resposta, lidas da tela da conversa.
	 *
	 * Abre `chatgpt.com/c/<id>` numa aba própria (a do gateway segue livre),
	 * marca as imagens grandes do último turno do assistente — ícone de site,
	 * avatar e favicon ficam de fora pelo tamanho — e baixa cada uma dentro da
	 * sessão logada. Site que não deixa baixar (CORS) vira print só da imagem.
	 * Sai como `data:` com a origem (`web` ou `chatgpt`), para o crédito.
	 */
	/**
	 * viralizeai: baixa o arquivo de uma imagem pelo navegador, fora da
	 * página (sem a trava de CORS), com os cookies da sessão. Devolve `data:`
	 * ou null se não for uma imagem de verdade.
	 */
	private async baixarPorFora(aba: Page, src: string): Promise<string | null> {
		try {
			const r = await aba.context().request.get(src, {
				timeout: 30_000,
				headers: { Referer: "https://chatgpt.com/" },
			});
			if (!r.ok()) return null;
			const tipo = (String(r.headers()["content-type"] || "").split(";")[0] ?? "").trim().toLowerCase();
			if (!tipo.startsWith("image/")) return null;
			const corpo = await r.body();
			if (corpo.length < 5_000 || corpo.length > 15 * 1024 * 1024) return null;
			return `data:${tipo};base64,${corpo.toString("base64")}`;
		} catch {
			return null;
		}
	}

	private async imagensDaTela(conversationId: string): Promise<string[]> {
		const ctx = await BrowserManager.getInstance().getContext();
		const aba = await ctx.newPage();
		try {
			// Sem tamanho de tela o ChatGPT pode não desenhar a lista de
			// mensagens numa aba de fundo (o antigo leitor via DOM via 0 turnos).
			await aba.setViewportSize({ width: 1366, height: 1000 }).catch(() => {});
			await aba.goto(`https://chatgpt.com/c/${encodeURIComponent(conversationId)}`, {
				waitUntil: "domcontentloaded",
				timeout: 45_000,
			});
			await aba
				.waitForSelector('[data-message-author-role="assistant"], [data-turn="assistant"]', { timeout: 30_000 })
				.catch(() => {});
			// Leva o último turno para a tela: imagem com loading=lazy só carrega visível.
			await aba
				.evaluate(() => {
					const turnos = Array.from(document.querySelectorAll('article, [data-testid^="conversation-turn"]'));
					turnos[turnos.length - 1]?.scrollIntoView({ block: "start" });
				})
				.catch(() => {});
			await aba.waitForTimeout(3_500);

			const { candidatas, diagnostico } = await aba.evaluate(() => {
				const doAssistente = (el: Element) =>
					el.matches('[data-turn="assistant"]') ||
					Boolean(el.querySelector('[data-message-author-role="assistant"]'));
				const turnos = Array.from(document.querySelectorAll('article, [data-testid^="conversation-turn"]'));
				const ultimo = [...turnos].reverse().find(doAssistente);
				// Turnos não achados (o ChatGPT mudou o DOM): as últimas imagens
				// grandes da página são as da resposta mais recente.
				const imgs = ultimo
					? Array.from(ultimo.querySelectorAll("img"))
					: Array.from((document.querySelector("main") || document.body).querySelectorAll("img"));
				const grandes = imgs
					.map((img, i) => {
						img.setAttribute("data-viralizeai-img", String(i));
						const caixa = img.getBoundingClientRect();
						return {
							i,
							src: img.currentSrc || img.src || "",
							largura: img.naturalWidth || 0,
							altura: img.naturalHeight || 0,
							naTela: caixa.width,
						};
					})
					.filter((c) => c.src && c.largura >= 300 && c.altura >= 200 && c.naTela >= 120);
				return {
					candidatas: (ultimo ? grandes : grandes.slice(-3))
						.sort((a, b) => b.largura * b.altura - a.largura * a.altura)
						.slice(0, 3),
					diagnostico: { turnos: turnos.length, achouTurno: Boolean(ultimo), imagens: imgs.length, grandes: grandes.length },
				};
			});
			if (!candidatas.length) {
				console.log(`[viralizeai-imagem] nenhuma imagem grande na tela da conversa: ${JSON.stringify(diagnostico)}`);
			}

			const saida: string[] = [];
			for (const c of candidatas) {
				const origem = /^(blob:|data:)|chatgpt\.com|oaiusercontent\.com/i.test(c.src) ? "chatgpt" : "web";
				const baixada = await aba
					.evaluate(async (src: string) => {
						try {
							const r = await fetch(src, { credentials: "include" });
							const blob = r.ok ? await r.blob() : null;
							if (!blob || !blob.type.startsWith("image/") || blob.size < 5_000 || blob.size > 15 * 1024 * 1024) {
								return null;
							}
							return await new Promise<string>((resolve, reject) => {
								const leitor = new FileReader();
								leitor.onload = () => resolve(String(leitor.result));
								leitor.onerror = () => reject(leitor.error);
								leitor.readAsDataURL(blob);
							});
						} catch {
							return null; // CORS: cai no print abaixo
						}
					}, c.src)
					.catch(() => null);
				let dado = baixada;
				// Site que bloqueia o download de dentro da página (CORS): baixa o
				// ARQUIVO original pelo navegador, por fora da página. Nada de print
				// da tela — no ChatGPT a foto fica num cartão, cortada e com texto em
				// cima, e o print saía com o cartão inteiro.
				if (!dado && /^https?:/i.test(c.src)) {
					dado = await this.baixarPorFora(aba, c.src);
				}
				if (dado) {
					saida.push(dado.replace(/^data:(image\/[a-z0-9.+-]+)(;[^,]*)?;base64,/i, `data:$1;origem=${origem};base64,`));
				} else if (/^https?:/i.test(c.src)) {
					// Último recurso: o endereço da foto; o ViralizeAI tenta baixar.
					saida.push(c.src);
				}
			}
			return saida;
		} finally {
			await aba.close().catch(() => {});
		}
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
	private async resolverImagens(valores?: string[], conversationId?: string): Promise<string[]> {
		const urls = await this.resolverPonteiros(valores, conversationId);
		return this.baixarNaPagina(urls);
	}

	/**
	 * viralizeai: imagem do próprio ChatGPT vira `data:` aqui dentro.
	 *
	 * A URL assinada (`chatgpt.com/backend-api/estuary/content?…&sig=…`) só
	 * abre com a sessão logada: baixada de fora pelo ViralizeAI dava 403, e a
	 * matéria saía com uma capa gerada por outra IA no lugar da que o editor
	 * viu na conversa. Foto pública achada na web passa como está.
	 */
	private async baixarNaPagina(urls: string[]): Promise<string[]> {
		const daConta = (u: string) => /^https:\/\/([a-z0-9-]+\.)*(chatgpt\.com|oaiusercontent\.com)\//i.test(u);
		if (!urls.some(daConta)) return urls;
		try {
			const page = await this.getPage();
			const baixadas = await page.evaluate(async (lista: string[]) => {
				let token: string | undefined;
				try {
					const s = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include" });
					if (s.ok) token = ((await s.json()) as { accessToken?: string }).accessToken;
				} catch {
					/* o cookie basta na maioria das vezes */
				}
				const saida: (string | null)[] = [];
				for (const url of lista) {
					try {
						const r = await fetch(url, {
							credentials: "include",
							headers: token && url.startsWith("https://chatgpt.com/") ? { Authorization: `Bearer ${token}` } : {},
						});
						const blob = r.ok ? await r.blob() : null;
						if (!blob || !blob.type.startsWith("image/") || blob.size < 1024 || blob.size > 15 * 1024 * 1024) {
							saida.push(null);
							continue;
						}
						saida.push(
							await new Promise<string>((resolve, reject) => {
								const leitor = new FileReader();
								leitor.onload = () => resolve(String(leitor.result));
								leitor.onerror = () => reject(leitor.error);
								leitor.readAsDataURL(blob);
							}),
						);
					} catch {
						saida.push(null);
					}
				}
				return saida;
			}, urls.filter(daConta));
			let i = 0;
			return urls.map((u) => {
				if (!daConta(u)) return u;
				const dado = baixadas[i++];
				if (!dado) console.warn(`[viralizeai-imagem] não baixei na página: ${u.slice(0, 120)}`);
				return dado || u;
			});
		} catch (err) {
			console.warn(`[viralizeai-imagem] download na página falhou: ${err instanceof Error ? err.message : String(err)}`);
			return urls;
		}
	}

	private async resolverPonteiros(valores?: string[], conversationId?: string): Promise<string[]> {
		const entrada = (valores ?? []).filter(Boolean);
		if (!entrada.length) return [];
		const prontas: string[] = [];
		const ponteiros: string[] = [];
		for (const v of entrada) {
			// `data:` já é a imagem baixada (raspada da tela).
			if (v.startsWith("http://") || v.startsWith("https://") || v.startsWith("data:")) prontas.push(v);
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
			const urls = await page.evaluate(async ({ lista, conversa }: { lista: string[]; conversa?: string }) => {
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
					// `file-service://` usa o primeiro endereço; a imagem gerada nova
					// (`sediment://file_…`) só sai pelo segundo, com a conversa.
					const enderecos = [
						`https://chatgpt.com/backend-api/files/${encodeURIComponent(id)}/download`,
						`https://chatgpt.com/backend-api/files/download/${encodeURIComponent(id)}?${
							conversa ? `conversation_id=${encodeURIComponent(conversa)}&` : ""
						}inline=false`,
					];
					for (const endereco of enderecos) {
						try {
							const r = await fetch(endereco, {
								credentials: "include",
								headers: token ? { Authorization: `Bearer ${token}` } : {},
							});
							if (!r.ok) continue;
							const d = (await r.json()) as { download_url?: string };
							if (d.download_url) {
								saida.push(d.download_url);
								break;
							}
						} catch {
							/* tenta o próximo endereço */
						}
					}
				}
				return saida;
			}, { lista: ids, conversa: conversationId });
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
