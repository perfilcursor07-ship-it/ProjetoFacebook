import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeepSeekStream } from "../src/providers/deepseek/stream.ts";
import { sse, streamOf } from "./helpers.ts";

test("remendos sem caminho seguem o fragmento aberto (THINK → RESPONSE)", async () => {
	const deltas: string[] = [];
	const result = await parseDeepSeekStream(
		streamOf(
			sse(
				{ v: { response: { fragments: [{ type: "THINK", content: "Let me" }] } } },
				{ v: " think" },
				{ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "Olá" }] },
				{ v: " mundo" },
				{ p: "response/status", o: "SET", v: "FINISHED" },
			),
		),
		(d) => deltas.push(d),
	);
	assert.equal(result.thinkingText, "Let me think");
	assert.equal(result.text, "Olá mundo");
	assert.deepEqual(deltas, ["Olá", " mundo"]);
});

test("BATCH aplica os remendos internos com o prefixo", async () => {
	const result = await parseDeepSeekStream(
		streamOf(
			sse(
				{ v: { response: { fragments: [{ type: "RESPONSE", content: "A" }] } } },
				{ p: "response", o: "BATCH", v: [{ p: "fragments/-1/content", o: "APPEND", v: "B" }] },
			),
		),
	);
	assert.equal(result.text, "AB");
});

test("SET em conteúdo não duplica texto já entregue", async () => {
	const result = await parseDeepSeekStream(
		streamOf(
			sse(
				{ v: { response: { fragments: [{ type: "RESPONSE", content: "texto" }] } } },
				{ p: "response/fragments/-1/content", o: "SET", v: "texto" },
			),
		),
	);
	assert.equal(result.text, "texto");
});

test("tags <think> divididas entre pedaços", async () => {
	const result = await parseDeepSeekStream(
		streamOf(
			sse({ choices: [{ delta: { content: "<thi" } }] }),
			sse({ choices: [{ delta: { content: "nk>segredo</think>visível" } }] }),
		),
	);
	assert.equal(result.thinkingText, "segredo");
	assert.equal(result.text, "visível");
});

test("um '<' comum não segura o resto da resposta até o fim", async () => {
	const deltas: string[] = [];
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const parsing = parseDeepSeekStream(body, (d) => deltas.push(d));
	const encoder = new TextEncoder();
	const tail = "x".repeat(250);
	controller.enqueue(encoder.encode(sse({ choices: [{ delta: { content: "se a < b " } }] })));
	controller.enqueue(encoder.encode(sse({ choices: [{ delta: { content: tail } }] })));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.match(deltas.join(""), /x{250}$/, "texto deveria sair antes do stream terminar");
	controller.close();
	assert.equal((await parsing).text, `se a < b ${tail}`);
});

test("formato OpenAI com reasoning_content e tokens de controle", async () => {
	const result = await parseDeepSeekStream(
		streamOf(
			sse(
				{ choices: [{ delta: { reasoning_content: "raciocínio" } }] },
				{ choices: [{ delta: { content: "<|endoftext|>" } }] },
				{ choices: [{ delta: { content: "resposta" } }] },
			),
		),
	);
	assert.equal(result.thinkingText, "raciocínio");
	assert.equal(result.text, "resposta");
});
