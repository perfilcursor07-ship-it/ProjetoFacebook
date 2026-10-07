/**
 * Classificação dos erros do claude.ai. Fica fora do client.ts para poder
 * ser testada sem navegador.
 */
import { ProviderApiError, SessionExpiredError } from "../types.ts";

interface ClaudeErrorInfo {
	type: string;
	code: string;
	message: string;
}

/**
 * O corpo chega como "[completion] 429 {json}" e pode estar cortado em 500
 * caracteres. Formatos conhecidos:
 *   {"type":"error","error":{"type":"rate_limit_error","message":"…"}}
 *   {"error_code":"model_not_available","message":"…"}
 */
export function parseClaudeErrorBody(raw: string): ClaudeErrorInfo {
	let json: Record<string, any> | null = null;
	const start = raw.indexOf("{");
	if (start !== -1) {
		try {
			json = JSON.parse(raw.slice(start));
		} catch {
			/* corpo cortado: cai no regex abaixo */
		}
	}
	const err = json?.error && typeof json.error === "object" ? json.error : (json ?? {});
	let message = String(err.message ?? json?.message ?? "").trim();
	if (!message) {
		const match = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
		message = match?.[1]?.replace(/\\"/g, '"') ?? "";
	}
	return {
		type: String(err.type ?? ""),
		code: String(json?.error_code ?? err.error_code ?? err.code ?? ""),
		message,
	};
}

// Só termos específicos de limite de uso. Palavras genéricas como
// "exceeded", "quota" ou "too many" também aparecem em "prompt is too long",
// e antes faziam esses erros serem tratados como rate limit.
const RATE_LIMIT_TEXT = /rate.?limit|usage.?limit|exceeded_limit|out of (?:free )?messages/i;
const RATE_LIMIT_CODE = /rate_limit_error|exceeded_limit/;

function isRateLimit(status: number, info: ClaudeErrorInfo, raw: string): boolean {
	return (
		status === 429 ||
		info.type === "rate_limit_error" ||
		RATE_LIMIT_TEXT.test(info.code) ||
		RATE_LIMIT_TEXT.test(info.message) ||
		RATE_LIMIT_CODE.test(raw)
	);
}

/**
 * Converte a resposta de erro do claude.ai no erro que a rota deve devolver.
 * - 401                    → SessionExpiredError (rota responde 401)
 * - modelo indisponível    → ProviderApiError 400
 * - limite de uso          → ProviderApiError 429
 * - 403 sem causa conhecida → "dom-fallback"
 * - outros 4xx             → ProviderApiError com o mesmo status
 * - 5xx                    → Error comum (rota responde 502)
 */
export function classifyClaudeError(
	providerId: string,
	status: number,
	raw: string,
): Error | "dom-fallback" {
	if (status === 401) return new SessionExpiredError(providerId, raw);

	const info = parseClaudeErrorBody(raw);
	const detail = info.message || `Claude API error ${status}`;

	if (info.code === "model_not_available" || /model.*not available/i.test(info.message)) {
		return new ProviderApiError(400, detail);
	}
	if (isRateLimit(status, info, raw)) {
		return new ProviderApiError(
			429,
			`Claude rate limit reached (HTTP ${status}). Wait for the limit to reset. ${detail}`.trim(),
		);
	}
	if (status === 403) return "dom-fallback";
	if (status >= 400 && status < 500) return new ProviderApiError(status, detail);
	return new Error(detail);
}

const LIMIT_REPLY = [
	/you[’']ve (?:hit|reached) your (?:usage )?limit/i,
	/limits? will reset/i,
	/out of free messages/i,
];

/**
 * Resposta lida pelo DOM que na verdade é o aviso de limite da interface.
 * Só respostas curtas: uma matéria que cite "limite de uso" não é um aviso.
 */
export function looksLikeRateLimitReply(text: string): boolean {
	return text.length < 400 && LIMIT_REPLY.some((pattern) => pattern.test(text));
}
