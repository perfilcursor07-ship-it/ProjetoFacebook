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
import type { StreamResult } from "../types.ts";
import { SessionExpiredError, withTimeout } from "../types.ts";
import type { ClaudeWebAuth } from "./auth.ts";
import { parseClaudeStream } from "./stream.ts";

const SEND_TIMEOUT_MS = 120_000;
const NATIVE_TOOLS_TTL_MS = 30 * 60 * 1000;

type NativeToolTemplate = {
	tools: unknown[];
	toolStates?: unknown[];
	personalizedStyles: unknown[];
};

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
		models: [
			{ id: "claude-sonnet-5", name: "Claude Sonnet 5" },
			{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			{ id: "claude-opus-4-20250514", name: "Claude Opus 4" },
			{ id: "claude-opus-4-6", name: "Claude Opus 4.6" },
			{ id: "claude-haiku-4-20250514", name: "Claude Haiku 4" },
			{ id: "claude-haiku-4-6", name: "Claude Haiku 4.6" },
		],
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
	 * Captura uma requisição da própria interface do Claude e reaproveita
	 * somente a lista de ferramentas/estados liberados para esta conta. A
	 * requisição de sondagem é abortada antes de chegar ao servidor.
	 */
	private async getNativeToolTemplate(page: Page): Promise<NativeToolTemplate> {
		if (this.nativeToolTemplate && Date.now() < this.nativeToolTemplate.expiresAt) {
			return structuredClone(this.nativeToolTemplate.value);
		}
		if (this.nativeToolTemplatePromise) return this.nativeToolTemplatePromise;

		this.nativeToolTemplatePromise = (async () => {
			let resolveCapture: ((value: NativeToolTemplate) => void) | null = null;
			let rejectCapture: ((reason: Error) => void) | null = null;
			const captured = new Promise<NativeToolTemplate>((resolve, reject) => {
				resolveCapture = resolve;
				rejectCapture = reject;
			});
			const matchesCompletion = (url: URL) =>
				url.origin === "https://claude.ai" &&
				/\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion$/.test(url.pathname);

			await page.route(matchesCompletion, async (route) => {
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

			try {
				await page.goto("https://claude.ai/new", {
					waitUntil: "domcontentloaded",
					timeout: 60_000,
				});
				const input = page.locator("div[contenteditable='true']").first();
				await input.waitFor({ state: "visible", timeout: 15_000 });
				await input.fill("Olá");
				await page.keyboard.press("Enter");
				const template = await withTimeout(captured, 20_000, "Claude native tools capture");
				this.nativeToolTemplate = {
					value: structuredClone(template),
					expiresAt: Date.now() + NATIVE_TOOLS_TTL_MS,
				};
				console.log(`[ClaudeWeb] Captured ${template.tools.length} native account tool(s)`);
				return template;
			} finally {
				await page.unroute(matchesCompletion).catch(() => {});
			}
		})();

		try {
			return await this.nativeToolTemplatePromise;
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

	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
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
				nativeTools = await this.getNativeToolTemplate(page);
			} catch (err) {
				return {
					ok: false,
					status: 503,
					error: `[native_web_search] ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		}

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
			}) => {
				const createUrl = org
					? `${apiBase}/organizations/${org}/chat_conversations`
					: `${apiBase}/chat_conversations`;
				const createConversation = (uuid: string) => fetch(createUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					credentials: "include",
					body: JSON.stringify({ name: convName, uuid }),
				});
				const createRes = await createConversation(convUuid);
				let conv: { uuid: string } = { uuid: convUuid };
				if (!createRes.ok) {
					const text = await createRes.text();
					// UUID estável já existe: reutiliza a conversa em vez de criar outra.
					const existingRes = await fetch(`${createUrl}/${convUuid}`, {
						credentials: "include",
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
				const decoder = new TextDecoder();
				let fullText = "";
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					fullText += decoder.decode(value, { stream: true });
				}
				return { ok: true as const, data: fullText };
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
			},
		);
		return (await withTimeout(evaluatePromise, SEND_TIMEOUT_MS, "Claude request")) as EvalResult;
	}

	/**
	 * Custom sendMessage to handle Claude-specific error flows:
	 * - 401 → SessionExpiredError + auto-refresh retry
	 * - 403 (rate limit) → clear error
	 * - 403 (other) → DOM fallback
	 * - 429 → rate limit error
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
		const result = await this.callApi(page, normalized);
		if (!result.ok) {
			const errBody = result.error ?? "";
			const errLower = errBody.toLowerCase();
			console.warn(`[ClaudeWeb] API error ${result.status}: ${errBody.slice(0, 500)}`);

			if (result.status === 401) throw new SessionExpiredError(this.providerId, errBody);

			const errorCode = errBody.match(/"error_code"\s*:\s*"([^"]+)"/)?.[1] ?? "";
			const errorMessage =
				errBody.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? `Claude API error ${result.status}`;

			if (errorCode === "model_not_available" || /model.*not available/i.test(errLower))
				throw new Error(errorMessage);

			if (
				result.status === 429 ||
				/rate.?limit|out of (free )?messages|usage.?limit|quota|too many|exceeded/i.test(
					errLower,
				) ||
				/limit.*reset|upgrade.*pro/i.test(errLower)
			) {
				throw new Error(
					`Claude rate limit reached (HTTP ${result.status}). Please wait for the limit to reset or upgrade your plan.`,
				);
			}

			if (result.status === 403) {
				const userMessage = ClaudeWebClient.extractLastUserMessage(params.message);
				console.log(
					`[ClaudeWeb] 403 (unknown cause), falling back to DOM simulation (${userMessage.length} chars)`,
				);
				return this.chatCompletionsViaDOM({ message: userMessage, signal: params.signal });
			}
			throw new Error(errorMessage);
		}
		console.log(`[ClaudeWeb] Response length: ${result.data?.length || 0} bytes`);
		return textToStream(result.data ?? "");
	}

	private static extractLastUserMessage(prompt: string): string {
		const parts = prompt.split(/\n\nHuman:\s*/);
		if (parts.length > 1) {
			const last = parts[parts.length - 1]?.trim();
			if (last) return last;
		}
		return prompt;
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
			const page = this.page!;
			await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded", timeout: 15000 });
			await page.waitForTimeout(2000);
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
				const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
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
		const rateLimitPatterns = [
			/you['']ve hit your limit/i,
			/limits will reset/i,
			/out of free messages/i,
			/upgrade.*pro/i,
			/usage limit/i,
		];
		if (rateLimitPatterns.some((r) => r.test(lastText)))
			throw new Error(
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
