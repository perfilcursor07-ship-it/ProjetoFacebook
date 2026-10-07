/** Monta um stream com os pedaços exatamente como chegam pela rede. */
export function streamOf(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
			}
			controller.close();
		},
	});
}

export function sse(...events: unknown[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
