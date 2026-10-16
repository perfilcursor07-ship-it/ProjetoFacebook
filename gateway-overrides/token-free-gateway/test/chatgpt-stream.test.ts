import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChatGPTStream } from "../src/providers/chatgpt/stream.ts";
import { streamOf } from "./helpers.ts";

const CONVERSA = "6710a1b2-0000-4000-8000-00000000c0de";
const linha = (o: unknown) => `event: delta\ndata: ${JSON.stringify(o)}\n\n`;
const add = (id: string, role: string, extra: Record<string, unknown> = {}) =>
	linha({
		p: "",
		o: "add",
		v: {
			message: {
				id,
				author: { role },
				content: { content_type: "text", parts: [""] },
				recipient: "all",
				...extra,
			},
			conversation_id: CONVERSA,
		},
		c: 0,
	});

test("formato delta: o texto chega em pedaços e não sai vazio", async () => {
	// Era aqui que dava "stream vazio": o leitor só entendia a mensagem inteira.
	const deltas: string[] = [];
	const metas: Record<string, string>[] = [];
	const r = await parseChatGPTStream(
		streamOf(
			'event: delta_encoding\ndata: "v1"\n\n',
			linha({ type: "input_message", input_message: { author: { role: "user" } } }),
			add("u-1", "user", { content: { content_type: "text", parts: ["pedido"] } }),
			add("a-1", "assistant"),
			linha({ p: "/message/content/parts/0", o: "append", v: "Título" }),
			linha({ v: "\n\nPrimeiro" }),
			linha({
				o: "patch",
				v: [
					{ p: "/message/content/parts/0", o: "append", v: " parágrafo." },
					{ p: "/message/status", o: "replace", v: "finished_successfully" },
				],
			}),
			linha({ type: "message_stream_complete", conversation_id: CONVERSA }),
			"data: [DONE]\n\n",
		),
		(d) => deltas.push(d),
		(m) => metas.push(m as Record<string, string>),
	);
	assert.equal(r.text, "Título\n\nPrimeiro parágrafo.");
	assert.deepEqual(deltas, ["Título", "\n\nPrimeiro", " parágrafo."]);
	assert.ok(metas.some((m) => m.conversationId === CONVERSA));
	assert.ok(metas.some((m) => m.parentMessageId === "a-1"));
	assert.ok(!metas.some((m) => m.parentMessageId === "u-1"), "mensagem do usuário não é ponto de continuação");
});

test("formato delta: busca e chamada de ferramenta não entram no texto; imagem da ferramenta entra", async () => {
	const r = await parseChatGPTStream(
		streamOf(
			add("a-busca", "assistant", { recipient: "web.run", content: { content_type: "code", parts: [""] } }),
			linha({ p: "/message/content/parts/0", o: "append", v: '{"search_query":"igreja"}' }),
			add("t-busca", "tool", { content: { content_type: "text", parts: ["resultados da busca"] } }),
			add("a-1", "assistant"),
			linha({ v: "Matéria pronta." }),
			add("a-img", "assistant", { recipient: "t2uay3k.sj1i4kz", content: { content_type: "code", parts: [""] } }),
			linha({ v: '{"prompt":"igreja lotada"}' }),
			add("t-img", "tool", {
				content: {
					content_type: "multimodal_text",
					parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file_000abc", width: 1024 }],
				},
			}),
			add("a-2", "assistant"),
			linha({ v: "Aqui está a imagem." }),
			"data: [DONE]\n\n",
		),
	);
	assert.equal(r.text, "Matéria pronta.\n\nAqui está a imagem.");
	assert.deepEqual(r.imagens, ["sediment://file_000abc"]);
	assert.equal(r.aguardandoImagem, true);
});

test("formato antigo (mensagem inteira) continua funcionando", async () => {
	const msg = (texto: string) =>
		`data: ${JSON.stringify({
			conversation_id: CONVERSA,
			message: { id: "a-1", author: { role: "assistant" }, content: { content_type: "text", parts: [texto] } },
		})}\n\n`;
	const deltas: string[] = [];
	const r = await parseChatGPTStream(streamOf(msg("Olá"), msg("Olá, mundo"), "data: [DONE]\n\n"), (d) =>
		deltas.push(d),
	);
	assert.equal(r.text, "Olá, mundo");
	assert.deepEqual(deltas, ["Olá", ", mundo"]);
});

test("link citado não vira imagem", async () => {
	const r = await parseChatGPTStream(
		streamOf(
			add("a-1", "assistant", {
				metadata: { content_references: [{ type: "webpage", url: "https://g1.globo.com/noticia" }] },
			}),
			linha({ v: "Texto." }),
			"data: [DONE]\n\n",
		),
	);
	assert.deepEqual(r.imagens, []);
});
