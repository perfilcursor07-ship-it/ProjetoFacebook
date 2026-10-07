/**
 * ReadableStream alimentado aos poucos de fora (pedaços do SSE que a aba do
 * Chrome repassa pela função exposta). Fica fora do client.ts para poder ser
 * testado sem navegador.
 */

export interface ChunkSink {
	push(chunk: string): void;
	/** Encerra o stream; com `error`, o leitor recebe a falha. */
	end(error?: string): void;
}

export interface ChunkStreamOptions {
	label: string;
	/** Tempo máximo sem receber nenhum pedaço. */
	idleTimeoutMs: number;
	/** Tempo máximo total da resposta. */
	maxDurationMs: number;
	/** O leitor desistiu ou um limite de tempo estourou: pare a origem. */
	onCancel?: () => void;
	/** Chamado uma única vez quando o stream termina, por qualquer motivo. */
	onSettled?: () => void;
}

export function createChunkStream(options: ChunkStreamOptions): {
	stream: ReadableStream<Uint8Array>;
	sink: ChunkSink;
} {
	const { label, idleTimeoutMs, maxDurationMs, onCancel, onSettled } = options;
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let settled = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let maxTimer: ReturnType<typeof setTimeout> | undefined;

	const settle = (): boolean => {
		if (settled) return false;
		settled = true;
		clearTimeout(idleTimer);
		clearTimeout(maxTimer);
		onSettled?.();
		return true;
	};

	const end = (error?: string) => {
		if (!settle()) return;
		try {
			if (error) controller?.error(new Error(error));
			else controller?.close();
		} catch {
			/* leitor já cancelou */
		}
	};

	const expire = (reason: string) => {
		end(`${label} ${reason}`);
		onCancel?.();
	};

	const armIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => expire(`idle for ${idleTimeoutMs / 1000}s`), idleTimeoutMs);
	};

	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			armIdle();
			maxTimer = setTimeout(
				() => expire(`exceeded ${maxDurationMs / 1000}s`),
				maxDurationMs,
			);
		},
		cancel() {
			if (settle()) onCancel?.();
		},
	});

	const sink: ChunkSink = {
		push(chunk) {
			if (settled || !chunk) return;
			armIdle();
			controller?.enqueue(encoder.encode(chunk));
		},
		end,
	};

	return { stream, sink };
}
