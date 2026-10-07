import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyClaudeError, looksLikeRateLimitReply } from "../src/providers/claude/errors.ts";
import { ProviderApiError, SessionExpiredError } from "../src/providers/types.ts";

const body = (status: number, error: object) => `[completion] ${status} ${JSON.stringify(error)}`;

function statusOf(result: Error | "dom-fallback"): number | string {
	if (result === "dom-fallback") return result;
	if (result instanceof ProviderApiError) return result.httpStatus;
	if (result instanceof SessionExpiredError) return "session";
	return "error";
}

test("429 vira ProviderApiError 429", () => {
	const raw = body(429, { type: "error", error: { type: "rate_limit_error", message: "x" } });
	assert.equal(statusOf(classifyClaudeError("claude-web", 429, raw)), 429);
});

test("prompt longo com 'exceeded' não é rate limit", () => {
	const raw = body(400, {
		type: "error",
		error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens exceeded" },
	});
	const result = classifyClaudeError("claude-web", 400, raw);
	assert.equal(statusOf(result), 400);
	assert.match((result as Error).message, /prompt is too long/);
});

test("limite de uso com status diferente de 429 ainda é 429", () => {
	const raw = body(403, { error: { type: "rate_limit_error", message: '{"type":"exceeded_limit"}' } });
	assert.equal(statusOf(classifyClaudeError("claude-web", 403, raw)), 429);
});

test("modelo indisponível vira 400", () => {
	const raw = body(404, { error_code: "model_not_available", message: "Model not available" });
	const result = classifyClaudeError("claude-web", 404, raw);
	assert.equal(statusOf(result), 400);
	assert.equal((result as Error).message, "Model not available");
});

test("401 é sessão expirada", () => {
	assert.equal(statusOf(classifyClaudeError("claude-web", 401, "[completion] 401 {}")), "session");
});

test("403 sem causa conhecida vai para o fallback do DOM", () => {
	const raw = body(403, { error: { type: "permission_error", message: "forbidden" } });
	assert.equal(classifyClaudeError("claude-web", 403, raw), "dom-fallback");
});

test("5xx vira Error comum (rota responde 502)", () => {
	assert.equal(statusOf(classifyClaudeError("claude-web", 500, "[completion] 500 oops")), "error");
});

test("corpo JSON cortado ainda rende a mensagem", () => {
	const raw =
		'[completion] 400 {"type":"error","error":{"type":"invalid_request_error","message":"bad \\"input\\" here","det';
	const result = classifyClaudeError("claude-web", 400, raw);
	assert.equal((result as Error).message, 'bad "input" here');
});

test("aviso de limite na interface é detectado só em respostas curtas", () => {
	assert.equal(looksLikeRateLimitReply("You’ve hit your limit. Your limits will reset at 5 PM."), true);
	assert.equal(looksLikeRateLimitReply("Faça o upgrade para o plano Pro e ganhe mais."), false);
	const article = `${"Texto da matéria. ".repeat(40)} Os limites will reset amanhã.`;
	assert.equal(looksLikeRateLimitReply(article), false);
});
