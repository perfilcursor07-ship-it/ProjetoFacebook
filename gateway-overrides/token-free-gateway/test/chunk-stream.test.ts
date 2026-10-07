import assert from "node:assert/strict";
import { test } from "node:test";
import { createChunkStream } from "../src/providers/claude/chunk-stream.ts";

const options = { label: "Test stream", idleTimeoutMs: 1_000, maxDurationMs: 5_000 };

function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

test("entrega os pedaços na ordem e fecha", async () => {
	let settled = 0;
	const { stream, sink } = createChunkStream({ ...options, onSettled: () => settled++ });
	sink.push("a");
	sink.push("b");
	sink.end();
	sink.push("ignorado");
	assert.equal(await readAll(stream), "ab");
	assert.equal(settled, 1);
});

test("end com erro chega ao leitor", async () => {
	const { stream, sink } = createChunkStream(options);
	sink.push("parcial");
	sink.end("falhou na aba");
	await assert.rejects(readAll(stream), /falhou na aba/);
});

test("leitor que desiste avisa a origem uma única vez", async () => {
	let cancels = 0;
	let settled = 0;
	const { stream, sink } = createChunkStream({
		...options,
		onCancel: () => cancels++,
		onSettled: () => settled++,
	});
	await stream.cancel();
	sink.end();
	assert.equal(cancels, 1);
	assert.equal(settled, 1);
});

test("sem pedaços por muito tempo, encerra com erro e cancela a origem", async () => {
	let cancels = 0;
	const { stream } = createChunkStream({ ...options, idleTimeoutMs: 30, onCancel: () => cancels++ });
	await assert.rejects(readAll(stream), /Test stream idle/);
	assert.equal(cancels, 1);
});

test("duração máxima vale mesmo com pedaços chegando", async () => {
	const { stream, sink } = createChunkStream({ ...options, maxDurationMs: 60 });
	const feeder = setInterval(() => sink.push("."), 10);
	try {
		await assert.rejects(readAll(stream), /Test stream exceeded/);
	} finally {
		clearInterval(feeder);
	}
});
