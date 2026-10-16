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

	// Sem o ponteiro, a MESMA conversa do ViralizeAI continua na mesma do ChatGPT.
	await c.parseStream(await c.sendMessage({ message: "4", conversationId: "viralizeai:chatgpt:chat:8" }));
	assert.equal((corpos[3] as { conversation_id?: string }).conversation_id, "6710a1b2-0000-4000-8000-00000000c0de");

	// Tarefa interna nunca reaproveita conversa.
	await c.parseStream(await c.sendMessage({ message: "5", conversationId: "viralizeai:internal:conversa" }));
	await c.parseStream(await c.sendMessage({ message: "6", conversationId: "viralizeai:internal:conversa" }));
	assert.equal((corpos[5] as { conversation_id?: string }).conversation_id, undefined);
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

test("stream sem texto reconhecível: o texto e a imagem vêm da conversa salva", { skip: pular }, async () => {
	const conversa = "6710a1b2-0000-4000-8000-00000000c0de";
	// Um formato que o leitor não conhece: só o id da conversa é aproveitado.
	const { page } = paginaFalsa([{ conversation_id: conversa, formato_novo: { texto: "???" } }], { pausaMs: 1 });
	const g = globalThis as Record<string, unknown>;
	const anterior = g.fetch as (u: string, i?: RequestInit) => Promise<Response>;
	const lidas: string[] = [];
	g.fetch = async (url: string, init?: RequestInit) => {
		if (String(url).includes(`/backend-api/conversation/${conversa}`)) {
			lidas.push(url);
			return new Response(
				JSON.stringify({
					current_node: "a-2",
					mapping: {
						"u-1": { message: { author: { role: "user" }, content: { content_type: "text", parts: ["pedido"] } } },
						"a-1": { parent: "u-1", message: { author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["Título\n\nCorpo."] } } },
						"t-1": { parent: "a-1", message: { author: { role: "tool" }, content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file_123" }] } } },
						"a-2": { parent: "t-1", message: { author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } } },
					},
				}),
				{ status: 200 },
			);
		}
		if (String(url).includes("/backend-api/files/download/file_123")) {
			return new Response(JSON.stringify({ download_url: "https://files.oaiusercontent.com/file_123.png" }), { status: 200 });
		}
		// A URL assinada só abre com a sessão: o arquivo é baixado na própria aba.
		if (String(url) === "https://files.oaiusercontent.com/file_123.png") {
			return new Response(new Uint8Array(2048).fill(7), { status: 200, headers: { "Content-Type": "image/png" } });
		}
		return anterior(url, init);
	};
	// FileReader é do navegador; aqui, o mínimo que a página usa.
	g.FileReader = class {
		result: string | null = null;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		error = null;
		readAsDataURL(blob: Blob) {
			blob.arrayBuffer().then((b) => {
				this.result = `data:${blob.type};base64,${Buffer.from(b).toString("base64")}`;
				this.onload?.();
			});
		}
	};
	const c = cliente(page);
	const deltas: string[] = [];
	const r = await c.parseStream(await c.sendMessage({ message: "oi", conversationId: "viralizeai:chatgpt:chat:9" }), (d) =>
		deltas.push(d),
	);
	assert.equal(r.text, "Título\n\nCorpo.");
	assert.deepEqual(deltas, ["Título\n\nCorpo."], "o texto recuperado também vai para a tela");
	assert.equal(r.imagens?.length, 1);
	assert.match(r.imagens?.[0] ?? "", /^data:image\/png;base64,/, "a imagem sai já baixada, não como URL que dá 403 de fora");
	assert.equal(r.conversa, `chatgpt:${conversa}:a-2`);
	assert.equal(lidas.length, 1);
});

test("pediu imagem e ela só existe na tela: raspa da conversa e entrega com a origem", { skip: pular }, async () => {
	const conversa = "6710a1b2-0000-4000-8000-00000000c0de";
	const { page } = paginaFalsa([resposta("Matéria pronta.", "aaaa1111-0000-4000-8000-000000000009")], { pausaMs: 1 });
	const g = globalThis as Record<string, unknown>;
	const anterior = g.fetch as (u: string, i?: RequestInit) => Promise<Response>;
	// A conversa salva não traz a foto (é o caso real: "0 imagem(ns)").
	g.fetch = async (url: string, init?: RequestInit) =>
		String(url).includes(`/backend-api/conversation/${conversa}`)
			? new Response(JSON.stringify({ current_node: "a", mapping: {} }), { status: 200 })
			: anterior(url, init);
	const c = cliente(page);
	const raspadas: string[] = [];
	(c as unknown as { imagensDaTela: (id: string) => Promise<string[]> }).imagensDaTela = async (id) => {
		raspadas.push(id);
		return ["data:image/jpeg;origem=web;base64,AAAA"];
	};
	const r = await c.parseStream(
		await c.sendMessage({ message: "faça a matéria e pegue uma imagem para ela", conversationId: "viralizeai:chatgpt:chat:20" }),
	);
	assert.deepEqual(raspadas, [conversa]);
	assert.deepEqual(r.imagens, ["data:image/jpeg;origem=web;base64,AAAA"], "a imagem raspada não se perde no caminho");
});

test("sem pedir imagem e sem sinal dela na conversa: não abre a tela", { skip: pular }, async () => {
	const conversa = "6710a1b2-0000-4000-8000-00000000c0de";
	const { page } = paginaFalsa([resposta("Matéria pronta.", "aaaa1111-0000-4000-8000-000000000009")], { pausaMs: 1 });
	const g = globalThis as Record<string, unknown>;
	const anterior = g.fetch as (u: string, i?: RequestInit) => Promise<Response>;
	g.fetch = async (url: string, init?: RequestInit) =>
		String(url).includes(`/backend-api/conversation/${conversa}`)
			? new Response(JSON.stringify({ current_node: "a", mapping: {} }), { status: 200 })
			: anterior(url, init);
	const c = cliente(page);
	let abriu = false;
	(c as unknown as { imagensDaTela: () => Promise<string[]> }).imagensDaTela = async () => {
		abriu = true;
		return [];
	};
	await c.parseStream(await c.sendMessage({ message: "faça uma matéria sobre o culto", conversationId: "viralizeai:chatgpt:chat:21" }));
	assert.equal(abriu, false);
});

test("foto de site que bloqueia o download na página: baixa o arquivo original por fora (nada de print)", { skip: pular }, async () => {
	const c = cliente({});
	const foto = Buffer.alloc(8_000, 3);
	const pedidos: { url: string; referer?: string }[] = [];
	const abaFalsa = (resposta: { ok: boolean; tipo: string; corpo: Buffer }) => ({
		context: () => ({
			request: {
				get: async (url: string, opcoes: { headers?: Record<string, string> }) => {
					pedidos.push({ url, referer: opcoes?.headers?.Referer });
					return {
						ok: () => resposta.ok,
						headers: () => ({ "content-type": resposta.tipo }),
						body: async () => resposta.corpo,
					};
				},
			},
		}),
	});
	const baixar = (c as unknown as { baixarPorFora: (aba: unknown, src: string) => Promise<string | null> }).baixarPorFora.bind(c);

	const ok = await baixar(abaFalsa({ ok: true, tipo: "image/jpeg; charset=binary", corpo: foto }), "https://www.guiame.com.br/foto.jpg");
	assert.equal(ok, `data:image/jpeg;base64,${foto.toString("base64")}`, "é o arquivo original, byte a byte");
	assert.deepEqual(pedidos[0], { url: "https://www.guiame.com.br/foto.jpg", referer: "https://chatgpt.com/" });

	// Página de erro/HTML no lugar da foto não vira capa.
	assert.equal(await baixar(abaFalsa({ ok: true, tipo: "text/html", corpo: foto }), "https://x/y.jpg"), null);
	assert.equal(await baixar(abaFalsa({ ok: false, tipo: "image/jpeg", corpo: foto }), "https://x/y.jpg"), null);
	// Ícone minúsculo também não.
	assert.equal(await baixar(abaFalsa({ ok: true, tipo: "image/png", corpo: Buffer.alloc(300) }), "https://x/i.png"), null);
});
