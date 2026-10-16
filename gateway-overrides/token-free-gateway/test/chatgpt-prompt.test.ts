import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

// chat-completions importa o registro de provedores (resto do gateway): roda
// contra a cópia instalada por `gateway:sync`.
const INSTALADO = new URL("../../../.tools/token-free-gateway/src/openai/chat-completions.ts", import.meta.url);
const pular = existsSync(INSTALADO) ? false : "gateway não instalado (.tools/token-free-gateway)";
const { handleChatCompletions } = pular ? ({} as Record<string, never>) : await import(INSTALADO.href);

function clienteFalso(providerId: string) {
	const enviados: string[] = [];
	return {
		enviados,
		client: {
			providerId,
			init: async () => {},
			listModels: () => [],
			sendMessage: async (p: { message: string }) => {
				enviados.push(p.message);
				return new ReadableStream<Uint8Array>({ start: (c) => c.close() });
			},
			parseStream: async () => ({ text: "ok", thinkingText: "" }),
		},
	};
}

test("ChatGPT recebe o pedido como foi escrito, sem 'Human:'", { skip: pular }, async () => {
	const { client, enviados } = clienteFalso("chatgpt-web");
	const res = await handleChatCompletions(
		{ model: "gpt-5.6", messages: [{ role: "user", content: "uma notícia gospel recente" }] },
		client,
	);
	assert.equal(res.status, 200);
	assert.deepEqual(enviados, ["uma notícia gospel recente"]);
});

test("outros provedores continuam com o formato de sempre", { skip: pular }, async () => {
	const { client, enviados } = clienteFalso("claude-web");
	await handleChatCompletions({ model: "claude-sonnet-5", messages: [{ role: "user", content: "oi" }] }, client);
	assert.match(enviados[0], /^Human: oi/);
});
