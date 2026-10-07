/**
 * Claude Web client (CDP-based).
 * Sends messages to claude.ai API using Chrome browser context to bypass
 * Cloudflare bot protection, similar to ChatGPT and Kimi clients.
 */
import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import { textToStream } from "../shared/stream-helpers.ts";
import type { ModelInfo, StreamResult } from "../types.ts";
import { ProviderApiError, SessionExpiredError, withTimeout } from "../types.ts";
import type { ClaudeWebAuth } from "./auth.ts";
import { type ChunkSink, createChunkStream } from "./chunk-stream.ts";
import { classifyClaudeError, looksLikeRateLimitReply } from "./errors.ts";
import { parseClaudeStream } from "./stream.ts";

/** Até o claude.ai responder os cabeçalhos (ou a resposta inteira, sem streaming). */
const SEND_TIMEOUT_MS = 120_000;
const STREAM_IDLE_TIMEOUT_MS = 180_000;
const STREAM_MAX_DURATION_MS = 600_000;
const NATIVE_TOOLS_TTL_MS = 30 * 60 * 1000;
/** Função exposta na aba que repassa os pedaços do SSE para o gateway. */
const CHUNK_BINDING = "__tfgClaudeChunk";

export const CLAUDE_WEB_MODELS: ModelInfo[] = [
	{ id: "claude-sonnet-5", name: "Claude Sonnet 5" },
	{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
	{ id: "claude-opus-4-20250514", name: "Claude Opus 4" },
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6" },
	{ id: "claude-haiku-4-20250514", name: "Claude Haiku 4" },
	{ id: "claude-haiku-4-6", name: "Claude Haiku 4.6" },
];

type NativeToolTemplate = {
	tools: unknown[];
	toolStates?: unknown[];
	personalizedStyles: unknown[];
};

/** `streamed`: a página está repassando o corpo por CHUNK_BINDING. */
type CompletionResult =
	| { ok: true; data: string; streamed: boolean }
	| { ok: false; status: number; error: string };

// A função exposta pertence à aba e sobrevive à recriação do cliente (evict
// após sessão expirada) e ao hot reload; por isso o estado fica no globalThis.
const chunkState = ((globalThis as { __tfgClaudeChunks?: unknown }).__tfgClaudeChunks ??= {
	sinks: new Map<string, ChunkSink>(),
	pages: new WeakSet<Page>(),
}) as { sinks: Map<string, ChunkSink>; pages: WeakSet<Page> };

async function ensureChunkBinding(page: Page): Promise<boolean> {
	if (chunkState.pages.has(page)) return true;
	try {
		await page.exposeFunction(CHUNK_BINDING, (id: string, kind: string, payload: string) => {
			const sink = chunkState.sinks.get(id);
			if (!sink) return;
			if (kind === "data") sink.push(payload);
			else sink.end(kind === "error" ? payload || "Claude stream failed" : undefined);
		});
	} catch (err) {
		if (!/already registered/i.test(String(err))) {
			console.warn(`[ClaudeWeb] Streaming indisponível, usando resposta inteira: ${String(err)}`);
			return false;
		}
	}
	chunkState.pages.add(page);
	return true;
}

/** Aborta o fetch que a aba está fazendo para este pedido. */
async function abortInPage(page: Page, requestId: string): Promise<void> {
	await page
		.evaluate((id: string) => {
			const aborts = (window as unknown as { __tfgClaudeAborts?: Map<string, AbortController> })
				.__tfgClaudeAborts;
			aborts?.get(id)?.abort();
		}, requestId)
		.catch(() => {});
}

/** UUID estável por conversa local; sem chave preserva o comportamento antigo. */
async function conversationUuidForKey(key?: string): Promise<string> {
	const value = String(key || "").trim();
	if (!value) return crypto.randomUUID();
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
	// O endpoint web do Claude valida UUID v4 ao criar conversas. Mantemos os
	// bytes determinísticos, mas marcamos o identificador no formato aceito.
	digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
	digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class ClaudeWebClient extends BaseApiClient<ClaudeWebAuth> {
	readonly providerId = "claude-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "claude.ai",
		startUrl: "https://claude.ai/",
		cookieDomain: ".claude.ai",
		defaultModel: "claude-sonnet-5",
		models: CLAUDE_WEB_MODELS,
	};

	private readonly baseUrl = "https://claude.ai/api";
	private organizationId?: string;
	private cookie: string;
	private nativeToolTemplate: { value: NativeToolTemplate; expiresAt: number } | null = null;
	private nativeToolTemplatePromise: Promise<NativeToolTemplate> | null = null;

	constructor(auth: ClaudeWebAuth) {
		super(auth);
		this.cookie = auth.cookie || `sessionKey=${auth.sessionKey}`;
		this.organizationId = auth.organizationId;
	}

	protected getCookies() {
		return parseCookieHeader(this.cookie, this.config.cookieDomain);
	}

	/**
	 * Abre uma aba temporária no mesmo perfil. Navegar a aba principal
	 * destruiria o contexto das respostas que ainda estão chegando por ela
	 * ("Execution context was destroyed").
	 */
	private async withProbePage<T>(fn: (probe: Page) => Promise<T>): Promise<T> {
		const page = await this.getPage();
		const probe = await page.context().newPage();
		try {
			return await fn(probe);
		} finally {
			await probe.close().catch(() => {});
		}
	}

	/**
	 * Captura uma requisição da própria interface do Claude e reaproveita
	 * somente a lista de ferramentas/estados liberados para esta conta. A
	 * requisição de sondagem é abortada antes de chegar ao servidor.
	 */
	private async getNativeToolTemplate(): Promise<NativeToolTemplate> {
		if (this.nativeToolTemplate && Date.now() < this.nativeToolTemplate.expiresAt) {
			return structuredClone(this.nativeToolTemplate.value);
		}
		if (this.nativeToolTemplatePromise) {
			return structuredClone(await this.nativeToolTemplatePromise);
		}

		this.nativeToolTemplatePromise = this.withProbePage(async (probe) => {
			let resolveCapture: ((value: NativeToolTemplate) => void) | null = null;
			let rejectCapture: ((reason: Error) => void) | null = null;
			const captured = new Promise<NativeToolTemplate>((resolve, reject) => {
				resolveCapture = resolve;
				rejectCapture = reject;
			});
			const matchesCompletion = (url: URL) =>
				url.origin === "https://claude.ai" &&
				/\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion$/.test(url.pathname);

			await probe.route(matchesCompletion, async (route) => {
				try {
					const request = route.request();
					const raw = request.postData();
					if (request.method() !== "POST" || !raw) {
						throw new Error("requisição nativa sem corpo");
					}
					const payload = JSON.parse(raw) as Record<string, unknown>;
					const template: NativeToolTemplate = {
						tools: Array.isArray(payload.tools) ? structuredClone(payload.tools) : [],
						personalizedStyles: Array.isArray(payload.personalized_styles)
							? structuredClone(payload.personalized_styles)
							: [],
						...(Array.isArray(payload.tool_states)
							? { toolStates: structuredClone(payload.tool_states) }
							: {}),
					};
					await route.abort();
					if (!template.tools.length) {
						throw new Error("a interface do Claude não anunciou ferramentas para esta conta");
					}
					resolveCapture?.(template);
				} catch (err) {
					await route.abort().catch(() => {});
					rejectCapture?.(err instanceof Error ? err : new Error(String(err)));
				}
			});

			await probe.goto("https://claude.ai/new", {
				waitUntil: "domcontentloaded",
				timeout: 60_000,
			});
			const input = probe.locator("div[contenteditable='true']").first();
			await input.waitFor({ state: "visible", timeout: 15_000 });
			await input.fill("Olá");
			await probe.keyboard.press("Enter");
			const template = await withTimeout(captured, 20_000, "Claude native tools capture");
			this.nativeToolTemplate = {
				value: structuredClone(template),
				expiresAt: Date.now() + NATIVE_TOOLS_TTL_MS,
			};
			console.log(`[ClaudeWeb] Captured ${template.tools.length} native account tool(s)`);
			return template;
		});

		try {
			return structuredClone(await this.nativeToolTemplatePromise);
		} finally {
			this.nativeToolTemplatePromise = null;
		}
	}

	protected override async onInit(): Promise<void> {
		if (this.organizationId) return;
		try {
			const page = await this.getPage();
			const orgResult = await page.evaluate(async (baseUrl: string) => {
				const res = await fetch(`${baseUrl}/organizations`, { credentials: "include" });
				if (!res.ok) return null;
				const orgs = (await res.json()) as Array<{ uuid: string }>;
				return orgs[0]?.uuid ?? null;
			}, this.baseUrl);
			if (orgResult) {
				this.organizationId = orgResult;
				console.log(`[ClaudeWeb] Discovered organization: ${this.organizationId}`);
			}
		} catch {
			/* ignore */
		}
	}

	/** Contrato do BaseApiClient: resposta inteira, sem streaming. */
	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		return this.requestCompletion(page, params, crypto.randomUUID(), false);
	}

	/**
	 * Cria/reaproveita a conversa e faz o POST de completion dentro da aba.
	 * Com `stream`, a aba devolve assim que os cabeçalhos chegam e repassa o
	 * corpo por CHUNK_BINDING; sem ele, lê tudo e devolve o texto.
	 */
	private async requestCompletion(
		page: Page,
		params: NormalizedSendParams,
		requestId: string,
		stream: boolean,
	): Promise<CompletionResult> {
		const conversationUuid = await conversationUuidForKey(params.conversationId);
		const orgId = this.organizationId;
		const baseUrl = this.baseUrl;
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const conversationName = String(params.conversationName || "")
			.trim()
			.slice(0, 100);
		let nativeTools: NativeToolTemplate | null = null;
		if (params.webSearch) {
			try {
				nativeTools = await this.getNativeToolTemplate();
			} catch (err) {
				return {
					ok: false,
					status: 503,
					error: `[native_web_search] ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		}
		if (params.signal?.aborted) throw new Error("Claude request cancelled");

		const evaluatePromise = page.evaluate(
			async ({
				baseUrl: apiBase,
				orgId: org,
				conversationUuid: convUuid,
				model: mdl,
				timezone: tz,
				message: msg,
				conversationName: convName,
				nativeTools: native,
				requestId: reqId,
				binding,
			}): Promise<CompletionResult> => {
				const w = window as unknown as Record<string, any>;
				const aborts: Map<string, AbortController> = (w.__tfgClaudeAborts ??= new Map());
				const ctrl = new AbortController();
				aborts.set(reqId, ctrl);
				let handedOff = false;
				try {
					const createUrl = org
						? `${apiBase}/organizations/${org}/chat_conversations`
						: `${apiBase}/chat_conversations`;
					const createConversation = (uuid: string) =>
						fetch(createUrl, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							credentials: "include",
							body: JSON.stringify({ name: convName, uuid }),
							signal: ctrl.signal,
						});
					const createRes = await createConversation(convUuid);
					let conv: { uuid: string } = { uuid: convUuid };
					if (!createRes.ok) {
						const text = await createRes.text();
						// UUID estável já existe: reutiliza a conversa em vez de criar outra.
						const existingRes = await fetch(`${createUrl}/${convUuid}`, {
							credentials: "include",
							signal: ctrl.signal,
						});
						if (!existingRes.ok) {
							// Conversas apagadas ou UUIDs antigos podem ficar inválidos na API.
							// Recupera a chamada com um UUID v4 novo em vez de falhar a pesquisa.
							const replacementUuid = crypto.randomUUID();
							const replacementRes = await createConversation(replacementUuid);
							if (!replacementRes.ok) {
								const replacementText = await replacementRes.text();
								return {
									ok: false as const,
									status: replacementRes.status,
									error: `[create_conversation_retry] ${replacementRes.status} ${replacementText.slice(0, 500)}; original=${createRes.status} ${text.slice(0, 240)}`,
								};
							}
							const replacement = (await replacementRes.json()) as { uuid?: string };
							conv = { uuid: replacement.uuid || replacementUuid };
						}
					} else {
						const created = (await createRes.json()) as { uuid?: string };
						conv = { uuid: created.uuid || convUuid };
					}
					const completionUrl = org
						? `${apiBase}/organizations/${org}/chat_conversations/${conv.uuid}/completion`
						: `${apiBase}/chat_conversations/${conv.uuid}/completion`;
					const completionRes = await fetch(completionUrl, {
						method: "POST",
						headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
						credentials: "include",
						signal: ctrl.signal,
						body: JSON.stringify({
							prompt: msg,
							parent_message_uuid: "00000000-0000-4000-8000-000000000000",
							model: mdl,
							timezone: tz,
							rendering_mode: "messages",
							attachments: [],
							files: [],
							locale: "en-US",
							personalized_styles: native?.personalizedStyles || [],
							sync_sources: [],
							tools: native?.tools || [],
							...(native?.toolStates ? { tool_states: native.toolStates } : {}),
						}),
					});
					if (!completionRes.ok) {
						const text = await completionRes.text();
						return {
							ok: false as const,
							status: completionRes.status,
							error: `[completion] ${completionRes.status} ${text.slice(0, 500)}`,
						};
					}
					const reader = completionRes.body?.getReader();
					if (!reader)
						return { ok: false as const, status: 500, error: "No response body from Claude API" };

					const push = binding ? w[binding] : null;
					if (typeof push === "function") {
						// Devolve já e repassa o corpo em segundo plano.
						handedOff = true;
						void (async () => {
							const decoder = new TextDecoder();
							try {
								while (true) {
									const { done, value } = await reader.read();
									if (done) break;
									const text = decoder.decode(value, { stream: true });
									if (text) await push(reqId, "data", text);
								}
								const tail = decoder.decode();
								if (tail) await push(reqId, "data", tail);
								await push(reqId, "end", "");
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								await Promise.resolve(push(reqId, "error", message)).catch(() => {});
							} finally {
								aborts.delete(reqId);
							}
						})();
						return { ok: true as const, data: "", streamed: true };
					}

					const decoder = new TextDecoder();
					let fullText = "";
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						fullText += decoder.decode(value, { stream: true });
					}
					return { ok: true as const, data: fullText, streamed: false };
				} finally {
					if (!handedOff) aborts.delete(reqId);
				}
			},
			{
				baseUrl,
				orgId: orgId ?? null,
				conversationUuid,
				model: params.model,
				timezone,
				message: params.message,
				conversationName,
				nativeTools,
				requestId,
				binding: stream ? CHUNK_BINDING : null,
			},
		);
		try {
			return await withTimeout(evaluatePromise, SEND_TIMEOUT_MS, "Claude request");
		} catch (err) {
			await abortInPage(page, requestId);
			throw err;
		}
	}

	/**
	 * Abre a resposta do Claude como stream. Quando a função exposta funciona,
	 * os pedaços chegam enquanto o Claude escreve; senão, cai na resposta
	 * inteira de uma vez (comportamento antigo).
	 */
	private async openCompletion(
		page: Page,
		params: NormalizedSendParams,
	): Promise<EvalResult<ReadableStream<Uint8Array>>> {
		const requestId = crypto.randomUUID();
		const { signal } = params;
		const onAbort = () => {
			void abortInPage(page, requestId);
			chunks?.sink.end("Claude request cancelled");
		};
		const release = () => {
			chunkState.sinks.delete(requestId);
			signal?.removeEventListener("abort", onAbort);
		};

		const chunks = (await ensureChunkBinding(page))
			? createChunkStream({
					label: "Claude stream",
					idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
					maxDurationMs: STREAM_MAX_DURATION_MS,
					onCancel: () => void abortInPage(page, requestId),
					onSettled: release,
				})
			: null;
		if (chunks) chunkState.sinks.set(requestId, chunks.sink);
		signal?.addEventListener("abort", onAbort, { once: true });

		let result: CompletionResult;
		try {
			result = await this.requestCompletion(page, params, requestId, Boolean(chunks));
		} catch (err) {
			chunks?.sink.end(String(err));
			release();
			throw err;
		}

		if (result.ok && result.streamed && chunks) return { ok: true, data: chunks.stream };
		chunks?.sink.end();
		release();
		if (!result.ok) return result;
		console.log(`[ClaudeWeb] Response length: ${result.data.length} bytes`);
		return { ok: true, data: textToStream(result.data) };
	}

	/**
	 * Custom sendMessage to handle Claude-specific error flows:
	 * - 401 → SessionExpiredError + auto-refresh retry
	 * - 429 / limite de uso → ProviderApiError 429
	 * - 403 (other) → DOM fallback
	 * - outros 4xx → ProviderApiError com o mesmo status
	 */
	override async sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
		conversationId?: string;
		conversationName?: string;
		webSearch?: boolean;
	}): Promise<ReadableStream<Uint8Array>> {
		try {
			return await this.doSendMessage(params);
		} catch (err) {
			if (err instanceof SessionExpiredError) {
				console.warn("[ClaudeWeb] Session expired, attempting auto-refresh...");
				const refreshed = await this.refreshSession();
				if (refreshed) {
					console.log("[ClaudeWeb] Session refreshed, retrying request...");
					return this.doSendMessage(params);
				}
			}
			throw err;
		}
	}

	private async doSendMessage(params: {
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
		const result = await this.openCompletion(page, normalized);
		if (result.ok) return result.data;

		const errBody = result.error ?? "";
		console.warn(`[ClaudeWeb] API error ${result.status}: ${errBody.slice(0, 500)}`);
		const failure = classifyClaudeError(this.providerId, result.status, errBody);
		if (failure !== "dom-fallback") throw failure;

		// O prompt inteiro (instruções + histórico), não só a última mensagem:
		// sem isso a matéria saía sem as regras de escrita.
		console.warn(
			`[ClaudeWeb] 403 (unknown cause), falling back to DOM simulation (${params.message.length} chars)`,
		);
		return this.chatCompletionsViaDOM({ message: params.message, signal: params.signal });
	}

	async checkSession(): Promise<{ valid: boolean; reason?: string }> {
		try {
			const page = await this.getPage();
			const result = await page.evaluate(async (baseUrl: string) => {
				const res = await fetch(`${baseUrl}/organizations`, { credentials: "include" });
				return { status: res.status, ok: res.ok };
			}, this.baseUrl);
			if (result.ok) return { valid: true };
			return { valid: false, reason: `Claude API returned ${result.status}` };
		} catch (err) {
			return { valid: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	async refreshSession(): Promise<boolean> {
		try {
			this.page = null;
			await this.getPage();
			// Recarrega o claude.ai numa aba à parte para renovar os cookies sem
			// derrubar outras respostas que estão chegando pela aba principal.
			await this.withProbePage(async (probe) => {
				await probe.goto("https://claude.ai/", { waitUntil: "domcontentloaded", timeout: 15000 });
				await probe.waitForTimeout(2000);
			});
			const check = await this.checkSession();
			if (check.valid) {
				this.organizationId = undefined;
				await this.onInit();
				console.log("[ClaudeWeb] Session refresh succeeded");
				return true;
			}
			console.warn(`[ClaudeWeb] Session refresh failed: ${check.reason}`);
			return false;
		} catch (err) {
			console.error(
				`[ClaudeWeb] Session refresh error: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	private async chatCompletionsViaDOM(params: {
		message: string;
		signal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const inputSelectors = [
			'div.ProseMirror[contenteditable="true"]',
			'[contenteditable="true"]',
			"textarea",
		];
		let inputHandle = null;
		for (const sel of inputSelectors) {
			inputHandle = await page.$(sel);
			if (inputHandle) break;
		}
		if (!inputHandle)
			throw new Error("Claude DOM fallback failed: chat input not found. Is claude.ai loaded?");
		await inputHandle.click();
		await page.waitForTimeout(300);
		await pasteText(page, params.message, inputHandle);
		await page.keyboard.press("Enter");
		console.log(
			`[ClaudeWeb] DOM: pasted message (${params.message.length} chars) and pressed Enter`,
		);

		const maxWaitMs = 120000;
		const pollIntervalMs = 2000;
		let lastText = "";
		let stableCount = 0;
		for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
			if (params.signal?.aborted) throw new Error("Claude request cancelled");
			await new Promise((r) => setTimeout(r, pollIntervalMs));
			const result = await page.evaluate(() => {
				const clean = (t: string) => t.replace(/[​-‍﻿]/g, "").trim();
				const assistantMessages = document.querySelectorAll(
					'[data-is-streaming], [class*="response"], [class*="assistant"], [class*="markdown"]',
				);
				let text = "";
				if (assistantMessages.length > 0) {
					const last = assistantMessages[assistantMessages.length - 1];
					if (last) text = clean((last as HTMLElement).innerText ?? "");
				}
				const stopBtn = document.querySelector(
					'button[aria-label*="Stop"], [class*="stop-button"]',
				);
				return { text, isStreaming: !!stopBtn };
			});
			if (result.text && result.text.length >= 20) {
				if (result.text !== lastText) {
					lastText = result.text;
					stableCount = 0;
				} else {
					stableCount++;
					if (!result.isStreaming && stableCount >= 2) break;
				}
			}
		}
		if (!lastText)
			throw new Error(
				"Claude DOM fallback: no assistant reply detected. Ensure claude.ai is open and logged in.",
			);
		if (looksLikeRateLimitReply(lastText))
			throw new ProviderApiError(
				429,
				"Claude rate limit reached. Please wait for the limit to reset or upgrade your plan.",
			);
		const fakeSse = `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: lastText } })}\n\ndata: [DONE]\n\n`;
		return textToStream(fakeSse);
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseClaudeStream(body, onDelta);
	}
}
