import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaudeStream } from "../src/providers/claude/stream.ts";
import { sse, streamOf } from "./helpers.ts";

const delta = (text: string) => ({ type: "content_block_delta", delta: { text } });

test("junta os deltas e repassa cada um para onDelta", async () => {
	const deltas: string[] = [];
	const result = await parseClaudeStream(
		streamOf(sse(delta("Olá"), delta(", mundo")), "data: [DONE]\n\n"),
		(d) => deltas.push(d),
	);
	assert.equal(result.text, "Olá, mundo");
	assert.deepEqual(deltas, ["Olá", ", mundo"]);
});

test("evento cortado no meio entre dois pedaços da rede", async () => {
	const full = sse(delta("primeiro"), delta(" segundo"));
	const cut = full.indexOf("segundo");
	const result = await parseClaudeStream(streamOf(full.slice(0, cut), full.slice(cut)));
	assert.equal(result.text, "primeiro segundo");
});

test("caractere UTF-8 dividido entre pedaços", async () => {
	const bytes = new TextEncoder().encode(sse(delta("ação")));
	const split = bytes.indexOf(0xc3) + 1; // no meio do "ç"
	const result = await parseClaudeStream(streamOf(bytes.slice(0, split), bytes.slice(split)));
	assert.equal(result.text, "ação");
});

test("bloco de raciocínio fica fora do texto", async () => {
	const deltas: string[] = [];
	const result = await parseClaudeStream(
		streamOf(
			sse(
				{ type: "content_block_start", content_block: { type: "thinking" } },
				delta("pensando"),
				{ type: "content_block_stop" },
				delta("resposta"),
			),
		),
		(d) => deltas.push(d),
	);
	assert.equal(result.text, "resposta");
	assert.equal(result.thinkingText, "pensando");
	assert.deepEqual(deltas, ["resposta"]);
});

test("fontes da pesquisa web viram lista no final, sem repetir as citadas", async () => {
	const result = await parseClaudeStream(
		streamOf(
			sse(
				{ type: "tool_result", content: [{ url: "https://g1.globo.com/a", title: "G1" }] },
				{ type: "tool_result", content: [{ url: "https://www.uol.com.br/b" }] },
				delta("Veja https://g1.globo.com/a"),
			),
		),
	);
	assert.match(
		result.text,
		/Fontes consultadas:\n- \[uol\.com\.br\]\(https:\/\/www\.uol\.com\.br\/b\)$/,
	);
	assert.doesNotMatch(result.text, /\[G1\]/);
});

test("URL malformada não derruba a resposta", async () => {
	const result = await parseClaudeStream(
		streamOf(sse({ type: "tool_result", content: [{ url: "https://" }] }, delta("ok"))),
	);
	assert.equal(result.text, "ok");
});
