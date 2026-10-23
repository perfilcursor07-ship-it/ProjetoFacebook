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

// A matéria da Sued Silva saiu com cada trecho duas vezes, intercalado:
// "Cantora Sued Silva surpreende ao encerrar" / o mesmo de novo / "ciclo na
// gravadora…" / "A cantora…" / "ciclo na gravadora…" / "A cantora…".
const TEXTO = "Cantora Sued Silva surpreende ao encerrar ciclo\n\nA cantora gospel anunciou uma mudança.";
const pedacos = ["Cantora Sued Silva surpreende ao encerrar", " ciclo\n\nA cantora", " gospel anunciou", " uma mudança."];

test("mesma resposta por dois caminhos (pedaços + fotografias com outro id): sai uma vez só", async () => {
	const deltas: string[] = [];
	const fotografia = (t: string) =>
		`data: ${JSON.stringify({ message: { id: "copia", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [t] } }, conversation_id: CONVERSA })}\n\n`;
	let acumulado = "";
	const eventos: string[] = [add("a-1", "assistant")];
	for (const p of pedacos) {
		eventos.push(linha({ v: p }));
		acumulado += p;
		eventos.push(fotografia(acumulado));
	}
	eventos.push("data: [DONE]\n\n");
	const r = await parseChatGPTStream(streamOf(...eventos), (d) => deltas.push(d));
	assert.equal(r.text, TEXTO);
	assert.equal(deltas.join(""), TEXTO, "na tela, também uma vez só");
});

test("duas versões em paralelo (índice c) com o mesmo texto: sai uma vez só", async () => {
	const deltas: string[] = [];
	const eventos: string[] = [
		linha({ p: "", o: "add", v: { message: { id: "x", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } } }, c: 1 }),
		linha({ p: "", o: "add", v: { message: { id: "y", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } } }, c: 2 }),
	];
	for (const p of pedacos) {
		eventos.push(linha({ c: 1, v: p }));
		eventos.push(linha({ c: 2, v: p }));
	}
	eventos.push("data: [DONE]\n\n");
	const r = await parseChatGPTStream(streamOf(...eventos), (d) => deltas.push(d));
	assert.equal(r.text, TEXTO);
	assert.equal(deltas.join(""), TEXTO);
});

test("segunda versão DIFERENTE em paralelo: fica de fora (nada de duas matérias misturadas)", async () => {
	const eventos: string[] = [
		linha({ p: "", o: "add", v: { message: { id: "x", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } } }, c: 1 }),
		linha({ p: "", o: "add", v: { message: { id: "y", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } } }, c: 2 }),
		linha({ c: 1, v: "Versão A do título" }),
		linha({ c: 2, v: "Versão B, outro texto" }),
		linha({ c: 1, v: " e corpo A." }),
		"data: [DONE]\n\n",
	];
	const r = await parseChatGPTStream(streamOf(...eventos));
	assert.equal(r.text, "Versão A do título e corpo A.");
});

test("antes e depois de uma pesquisa: as duas partes entram, separadas por parágrafo", async () => {
	const r = await parseChatGPTStream(
		streamOf(
			add("a-1", "assistant"),
			linha({ v: "Vou pesquisar." }),
			add("a-busca", "assistant", { recipient: "web.run", content: { content_type: "code", parts: [""] } }),
			linha({ v: '{"q":"x"}' }),
			add("a-2", "assistant"),
			linha({ v: "Matéria pronta." }),
			"data: [DONE]\n\n",
		),
	);
	assert.equal(r.text, "Vou pesquisar.\n\nMatéria pronta.");
});

// O ChatGPT escreve <AsyncImage query="…"/> e o servidor dele busca a foto e a
// devolve 1–2 s depois nos metadados (model_dil_v2…componentResults), em
// images.openai.com. Era a foto que aparecia na tela dele e não chegava aqui.
test("<AsyncImage>: a foto que o servidor do ChatGPT resolveu entra; o link da página não", async () => {
	const r = await parseChatGPTStream(
		streamOf(
			add("a-1", "assistant"),
			linha({ v: '<AsyncImage query="Ella Langley performing live" aspectRatio="16:9" alt="A cantora"/>\n**Ella Langley surpreende público**' }),
			linha({
				p: "/message/metadata",
				o: "append",
				v: {
					model_dil_v2: {
						appData: {
							opGenui: {
								componentResults: {
									c1: {
										status: "loaded",
										images: [{ content_url: "https://images.openai.com/thumbnails/url/ella.jpg", url: "https://parade.com/news/ella-langley" }],
									},
								},
							},
						},
					},
				},
			}),
			"data: [DONE]\n\n",
		),
	);
	assert.deepEqual(r.imagens, ["https://images.openai.com/thumbnails/url/ella.jpg"]);
	assert.equal(r.aguardandoImagem, true, "com <AsyncImage> o client ainda confere a conversa salva");
});

// Caso do pastor Jon Szeto: a tela do ChatGPT mostrou a foto do pastor
// (lagunabaptist.org), mas a miniatura do link citado (banner da SOLA Network)
// chegou antes e virou a capa.
test("foto da tela ganha da miniatura do link citado, mesmo chegando depois", async () => {
	const r = await parseChatGPTStream(
		streamOf(
			add("a-1", "assistant", {
				metadata: {
					content_references: [
						{ type: "grouped_webpages", items: [{ url: "https://sola.network/article/x", thumbnail_url: "https://images.openai.com/thumbnails/sola-banner.jpg" }] },
					],
				},
			}),
			linha({ v: '<AsyncImage query="Pastor Jon Szeto" aspectRatio="16:9"/>\nPastor de 45 anos recebe diagnóstico' }),
			linha({
				p: "/message/metadata",
				o: "append",
				v: { model_dil_v2: { appData: { opGenui: { componentResults: { c1: { images: [{ content_url: "https://images.openai.com/thumbnails/jon-szeto.jpg", url: "https://lagunabaptist.org/staff/jon" }] } } } } } },
			}),
			"data: [DONE]\n\n",
		),
	);
	assert.deepEqual(r.imagens, ["https://images.openai.com/thumbnails/jon-szeto.jpg", "https://images.openai.com/thumbnails/sola-banner.jpg"]);
	assert.equal(r.fotosDaTela, 1);
	assert.equal(r.paginasDasImagens?.["https://images.openai.com/thumbnails/jon-szeto.jpg"], "https://lagunabaptist.org/staff/jon");
});

// Caso Tyler Perry: a matéria saiu inteira e, logo depois, inteira de novo —
// a segunda em markdown simples (*The Gospel of Christmas*), a versão
// "fallbackMarkdown" que o ChatGPT gera junto da versão com componentes.
const COM_COMPONENTES =
	'Filme de Tyler Perry reúne estrelas da música gospel\n\nO cineasta divulgou o trailer de The Gospel of Christmas. <Cite refs={["turn1search0"]}/>\n\nFonte: People — https://people.com/x';
const EM_MARKDOWN =
	'**Filme de Tyler Perry reúne estrelas da música gospel**\n\nO cineasta divulgou o trailer de *The Gospel of Christmas*.\n\nFonte: People — https://people.com/x';

test("versão em markdown da mesma resposta, depois da original terminar: não entra de novo", async () => {
	const r = await parseChatGPTStream(
		streamOf(
			add("a-1", "assistant"),
			linha({ v: COM_COMPONENTES }),
			linha({ p: "/message/status", o: "replace", v: "finished_successfully" }),
			add("a-md", "assistant"),
			linha({ v: EM_MARKDOWN }),
			"data: [DONE]\n\n",
		),
	);
	assert.equal(r.text, COM_COMPONENTES);
});

test("mesmo com uma ferramenta entre as duas versões, a cópia não entra", async () => {
	const r = await parseChatGPTStream(
		streamOf(
			add("a-1", "assistant"),
			linha({ v: COM_COMPONENTES }),
			add("t-img", "tool", { content: { content_type: "text", parts: ["busca de imagem"] } }),
			add("a-md", "assistant"),
			linha({ v: EM_MARKDOWN.slice(0, 40) }),
			linha({ v: EM_MARKDOWN.slice(40) }),
			"data: [DONE]\n\n",
		),
	);
	assert.equal(r.text, COM_COMPONENTES);
});
