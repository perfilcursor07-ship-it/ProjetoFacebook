/**
 * Claude Web SSE stream parser.
 * Handles multiple Claude response formats including thinking blocks.
 */

import type { StreamResult } from "../types.ts";

function extractDelta(data: any): string | undefined {
	if (data.type === "content_block_delta" && typeof data.delta?.text === "string") {
		return data.delta.text;
	}
	if (typeof data.text === "string") return data.text;
	if (typeof data.content === "string") return data.content;
	if (typeof data.delta === "string") return data.delta;
	if (typeof data.choices?.[0]?.delta?.content === "string") {
		return data.choices[0].delta.content;
	}
	return undefined;
}

function parseSseData(dataStr: string): any | null {
	if (!dataStr || dataStr === "[DONE]") return null;
	try {
		return JSON.parse(dataStr);
	} catch {
		return null;
	}
}

function stripInlineThinkTags(text: string): { text: string; thinking: string } {
	const open = text.indexOf("<think>");
	if (open === -1) return { text, thinking: "" };
	const close = text.indexOf("</think>", open);
	if (close === -1) return { text, thinking: "" };
	return {
		text: text.slice(0, open) + text.slice(close + 8),
		thinking: text.slice(open + 7, close),
	};
}

class Accumulator {
	text = "";
	thinkingText = "";
	readonly sources = new Map<string, string>();
	private inThinking = false;

	private collectSources(value: unknown, depth = 0): void {
		if (!value || depth > 8) return;
		if (Array.isArray(value)) {
			for (const item of value) this.collectSources(item, depth + 1);
			return;
		}
		if (typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		const url = typeof record.url === "string" ? record.url.trim() : "";
		if (/^https?:\/\//i.test(url)) {
			const title =
				typeof record.title === "string" && record.title.trim()
					? record.title.trim()
					: typeof record.name === "string" && record.name.trim()
						? record.name.trim()
						: new URL(url).hostname.replace(/^www\./, "");
			this.sources.set(url, title);
		}
		for (const child of Object.values(record)) this.collectSources(child, depth + 1);
	}

	processLine(line: string, onDelta?: (delta: string) => void): void {
		if (!line.startsWith("data:")) return;
		const data = parseSseData(line.slice(5).trim());
		if (!data) return;
		this.collectSources(data);

		if (data.type === "content_block_start" && data.content_block?.type === "thinking") {
			this.inThinking = true;
			return;
		}
		if (data.type === "content_block_stop" && this.inThinking) {
			this.inThinking = false;
			return;
		}

		const delta = extractDelta(data);
		if (!delta) return;

		if (this.inThinking) {
			this.thinkingText += delta;
		} else {
			this.text += delta;
			onDelta?.(delta);
		}
	}
}

export async function parseClaudeStream(
	body: ReadableStream<Uint8Array>,
	onDelta?: (delta: string) => void,
): Promise<StreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const acc = new Accumulator();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.trim()) acc.processLine(buffer.trim(), onDelta);
				break;
			}
			const chunk = decoder.decode(value, { stream: true });
			const combined = buffer + chunk;
			const parts = combined.split("\n");
			buffer = parts.pop() || "";
			for (const part of parts) {
				const trimmed = part.trim();
				if (trimmed) acc.processLine(trimmed, onDelta);
			}
		}
	} finally {
		reader.releaseLock();
	}

	const stripped = stripInlineThinkTags(acc.text);
	const text = stripped.text.trim();
	const fontes = [...acc.sources.entries()]
		.filter(([url]) => !text.includes(url))
		.slice(0, 10)
		.map(([url, title]) => `- [${title.replace(/[\[\]]/g, "")}](${url})`);
	const sourceSuffix = fontes.length ? `\n\nFontes consultadas:\n${fontes.join("\n")}` : "";
	if (sourceSuffix && onDelta) onDelta(sourceSuffix);
	return {
		text: `${text}${sourceSuffix}`.trim(),
		thinkingText: (acc.thinkingText + stripped.thinking).trim(),
	};
}
