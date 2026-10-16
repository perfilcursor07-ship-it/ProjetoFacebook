import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

// O client depende do resto do gateway (navegador, helpers), que não fica
// nesta pasta: o teste roda contra a cópia instalada por `gateway:sync`.
const INSTALADO = new URL("../../../.tools/token-free-gateway/src/providers/chatgpt/client.ts", import.meta.url);
const pular = existsSync(INSTALADO) ? false : "gateway não instalado (.tools/token-free-gateway)";
const { ChatGPTWebClient } = pular
	? ({} as typeof import("../src/providers/chatgpt/client.ts"))
	: await import(INSTALADO.href);

/**
 * Página falsa: roda o código "da aba" aqui mesmo, com um `fetch` do
 * chatgpt.com que entrega o SSE em pedaços, com pausa entre eles — como o
 * ChatGPT faz enquanto escreve.
 */
function paginaFalsa(eventos: unknown[], { pausaMs = 40 } = {}) {
	const corpos: unknown[] = [];
	const g = globalThis as Record<string, unknown>;
	g.window = g;
	// Sem os scripts de verdade do ChatGPT: o sentinela falha na hora e o
	// pedido segue pelo fetch simples, sem ir à rede buscar o asset.
	g.document = { scripts: [{ src: "data:text/javascript,export%20const%20x=1;//oaistatic.com.js" }] };
	const fimDoSse = { em: 0 };
	g.fetch = async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/api/auth/session")) {
			return new Response(JSON.stringify({ accessToken: "t" }), { status: 200 });
		}
		if (!String(url).endsWith("/backend-api/conversation")) return new Response("{}", { status: 200 });
		corpos.push(JSON.parse(init?.body || "{}"));
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				for (const evento of eventos) {
					await new Promise((r) => setTimeout(r, pausaMs));
					controller.enqueue(enc.encode(`data: ${JSON.stringify(evento)}\n\n`));
				}
				fimDoSse.em = Date.now();
				controller.enqueue(enc.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(body, { status: 200 });
	};
	const page = {
		url: () => "https://chatgpt.com/",
		evaluate: (fn: (arg: unknown) => unknown, arg?: unknown) => Promise.resolve().then(() => fn(arg)),
	};
	return { page, corpos, fimDoSse };
}

function cliente(page: unknown) {
	const c = new ChatGPTWebClient({ accessToken: "t", cookie: "a=b", userAgent: "x" });
	(c as unknown as { getPage: () => Promise<unknown> }).getPage = async () => page;
	return c;
}

const resposta = (texto: string, id = "msg-2") => ({
	conversation_id: "6710a1b2-0000-4000-8000-00000000c0de",
	message: { id, author: { role: "assistant" }, content: { parts: [texto] } },
});

test("o texto chega aos poucos, enquanto o ChatGPT escreve", { skip: pular }, async () => {
	const { page, fimDoSse } = paginaFalsa(
		[resposta("Título"), resposta("Título\n\nPrimeiro"), resposta("Título\n\nPrimeiro parágrafo.")],
		{ pausaMs: 80 },
	);
	const c = cliente(page);
	const stream = await c.sendMessage({ message: "oi", conversationId: "viralizeai:chatgpt:chat:1" });
	// sendMessage volta assim que o ChatGPT aceita, não no fim da resposta.
	assert.equal(fimDoSse.em, 0, "sendMessage esperou a resposta inteira");
	const momentos: number[] = [];
	const result = await c.parseStream(stream, () => momentos.push(Date.now()));
	assert.equal(result.text, "Título\n\nPrimeiro parágrafo.");
	assert.equal(momentos.length, 3);
	assert.ok(momentos[2] - momentos[0] >= 50, "os pedaços chegaram todos juntos");
});

test("devolve o ponteiro da conversa e continua nela na mensagem seguinte", { skip: pular }, async () => {
	const { page, corpos } = paginaFalsa([resposta("ok", "aaaa1111-0000-4000-8000-000000000009")], { pausaMs: 1 });
	const c = cliente(page);
	const r1 = await c.parseStream(await c.sendMessage({ message: "1", conversationId: "viralizeai:chatgpt:chat:7" }));
	assert.equal(r1.conversa, "chatgpt:6710a1b2-0000-4000-8000-00000000c0de:aaaa1111-0000-4000-8000-000000000009");
	assert.equal(r1.conversaUrl, "https://chatgpt.com/c/6710a1b2-0000-4000-8000-00000000c0de");
	const primeiro = corpos[0] as { conversation_id?: string };
	assert.equal(primeiro.conversation_id, undefined, "conversa do ViralizeAI sem ponteiro abre conversa nova");

	await c.parseStream(await c.sendMessage({ message: "2", conversationId: `${r1.conversa}:model:gpt-5.6` }));
	const segundo = corpos[1] as { conversation_id?: string; parent_message_id?: string };
	assert.equal(segundo.conversation_id, "6710a1b2-0000-4000-8000-00000000c0de");
	assert.equal(segundo.parent_message_id, "aaaa1111-0000-4000-8000-000000000009");

	// Outra conversa do ViralizeAI não herda a conversa anterior.
	await c.parseStream(await c.sendMessage({ message: "3", conversationId: "viralizeai:chatgpt:chat:8" }));
	assert.equal((corpos[2] as { conversation_id?: string }).conversation_id, undefined);
});

test("erro HTTP do ChatGPT continua virando erro antes do stream", { skip: pular }, async () => {
	const g = globalThis as Record<string, unknown>;
	const { page } = paginaFalsa([]);
	const original = g.fetch as typeof fetch;
	g.fetch = async (url: string, init?: RequestInit) =>
		String(url).endsWith("/backend-api/conversation")
			? new Response("limite", { status: 429 })
			: original(url, init);
	const c = cliente(page);
	await assert.rejects(c.sendMessage({ message: "oi" }), /429/);
});
