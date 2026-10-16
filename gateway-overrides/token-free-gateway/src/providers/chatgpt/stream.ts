import type { StreamResult } from "../types.ts";

/**
 * viralizeai: leitor do SSE do chatgpt.com.
 *
 * O ChatGPT fala dois "dialetos" e troca sem aviso:
 *
 * - antigo: cada evento traz a mensagem INTEIRA (`message.content.parts[0]`
 *   com todo o texto até ali);
 * - delta (`event: delta_encoding` = "v1"): só o que mudou —
 *   `{"p":"/message/content/parts/0","o":"append","v":" texto"}`, `{"v":" texto"}`
 *   (mesmo caminho do anterior) ou `{"o":"patch","v":[…]}`. Mensagem nova
 *   chega como `{"p":"","o":"add","v":{"message":…}}`.
 *
 * O original só entendia o antigo: no delta todo texto era descartado, a
 * resposta saía vazia ("stream vazio") e o editor ficava olhando
 * "pesquisando e escrevendo…" para uma matéria que o ChatGPT já tinha escrito.
 *
 * Texto: só mensagens do assistente para o usuário (`content_type` text,
 * destinatário "all") — chamada de ferramenta, raciocínio e busca ficam de
 * fora. Imagens: de qualquer mensagem que não seja do usuário, porque a
 * imagem GERADA chega numa mensagem da ferramenta, não do assistente.
 */

type Mensagem = {
	id?: string;
	papel?: string;
	tipo?: string;
	destino?: string;
	texto: string;
};

const PADRAO_IMAGEM = /^(https?:\/\/|file-service:\/\/|sediment:\/\/)/i;

export function mensagemVisivel(m: { papel?: string; tipo?: string; destino?: string }): boolean {
	return (
		m.papel === "assistant" &&
		(!m.tipo || m.tipo === "text") &&
		(!m.destino || m.destino === "all")
	);
}

/** Recolhe ponteiros/URLs de imagem de qualquer objeto da resposta. */
export function coletarImagens(alvo: unknown, destino: string[], profundidade = 0): void {
	if (!alvo || profundidade > 6) return;
	if (Array.isArray(alvo)) {
		for (const item of alvo) coletarImagens(item, destino, profundidade + 1);
		return;
	}
	if (typeof alvo !== "object") return;
	const o = alvo as Record<string, unknown>;
	const ehImagem =
		o.content_type === "image_asset_pointer" ||
		typeof o.asset_pointer === "string" ||
		/image/i.test(String(o.content_type ?? o.type ?? ""));
	for (const campo of ["asset_pointer", "image_url", "thumbnail_url", "url", "src", "content_url"]) {
		const v = o[campo];
		if (typeof v !== "string" || !PADRAO_IMAGEM.test(v)) continue;
		// URL comum só conta quando o objeto é claramente uma imagem (senão
		// todo link citado viraria "imagem").
		if (/^https?:/i.test(v) && !ehImagem && campo === "url") continue;
		if (!destino.includes(v)) destino.push(v);
	}
	for (const campo of ["parts", "images", "image_results", "content_references", "metadata", "content", "items", "assets"]) {
		if (o[campo]) coletarImagens(o[campo], destino, profundidade + 1);
	}
}

export async function parseChatGPTStream(
	body: ReadableStream<Uint8Array>,
	onDelta?: (delta: string) => void,
	onMeta?: (meta: { conversationId?: string; parentMessageId?: string }) => void,
): Promise<StreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const imagens: string[] = [];
	const mensagens: Mensagem[] = [];
	let atual: Mensagem | null = null;
	let ultimoCaminho = "";
	let texto = "";
	let ultimaVisivelComTexto: Mensagem | null = null;

	const emitir = (m: Mensagem, pedaco: string) => {
		if (!pedaco || !mensagemVisivel(m)) return;
		// Duas mensagens do assistente na mesma resposta (antes e depois de uma
		// ferramenta): separa por parágrafo, como a tela do ChatGPT mostra.
		if (ultimaVisivelComTexto && ultimaVisivelComTexto !== m && texto) {
			texto += "\n\n";
			onDelta?.("\n\n");
		}
		ultimaVisivelComTexto = m;
		texto += pedaco;
		onDelta?.(pedaco);
	};

	const abrirMensagem = (msg: Record<string, unknown>): Mensagem => {
		const autor = (msg.author ?? {}) as Record<string, unknown>;
		const conteudo = (msg.content ?? {}) as Record<string, unknown>;
		const id = typeof msg.id === "string" ? msg.id : undefined;
		let m = id ? mensagens.find((x) => x.id === id) : undefined;
		if (!m) {
			m = { id, texto: "" };
			mensagens.push(m);
		}
		m.papel = String(autor.role ?? msg.role ?? m.papel ?? "");
		m.tipo = String(conteudo.content_type ?? m.tipo ?? "");
		m.destino = String(msg.recipient ?? m.destino ?? "all");
		if (m.papel !== "user") {
			coletarImagens(conteudo.parts, imagens);
			coletarImagens(msg.metadata, imagens);
			if (id) onMeta?.({ parentMessageId: id });
		}
		return m;
	};

	/** Formato antigo: a mensagem inteira a cada evento. */
	const mensagemInteira = (msg: Record<string, unknown>) => {
		const m = abrirMensagem(msg);
		atual = m;
		if (m.papel === "user") return;
		const parte = ((msg.content as Record<string, unknown> | undefined)?.parts as unknown[] | undefined)?.[0];
		const completo =
			typeof parte === "string"
				? parte
				: parte && typeof parte === "object" && typeof (parte as { text?: unknown }).text === "string"
					? (parte as { text: string }).text
					: "";
		if (completo.length > m.texto.length && completo.startsWith(m.texto)) {
			const novo = completo.slice(m.texto.length);
			m.texto = completo;
			emitir(m, novo);
		} else if (completo && completo !== m.texto && !m.texto) {
			m.texto = completo;
			emitir(m, completo);
		}
	};

	/** Formato delta: uma operação sobre a mensagem atual. */
	const aplicar = (op: Record<string, unknown>) => {
		const temCaminho = typeof op.p === "string";
		const caminho = temCaminho ? (op.p as string) : ultimoCaminho;
		if (temCaminho) ultimoCaminho = caminho;
		const v = op.v;
		const o = typeof op.o === "string" ? op.o : Array.isArray(v) ? "patch" : typeof v === "string" ? "append" : "";
		if (o === "patch" && Array.isArray(v)) {
			for (const sub of v) if (sub && typeof sub === "object") aplicar(sub as Record<string, unknown>);
			return;
		}
		if (caminho === "" && o === "add" && v && typeof v === "object") {
			const env = v as Record<string, unknown>;
			if (typeof env.conversation_id === "string") onMeta?.({ conversationId: env.conversation_id });
			if (env.message && typeof env.message === "object") {
				atual = abrirMensagem(env.message as Record<string, unknown>);
				const parte = ((env.message as Record<string, unknown>).content as Record<string, unknown> | undefined)
					?.parts as unknown[] | undefined;
				if (typeof parte?.[0] === "string" && parte[0]) {
					atual.texto = parte[0];
					emitir(atual, parte[0]);
				}
			}
			return;
		}
		const m = atual as Mensagem | null;
		if (!m || m.papel === "user") return;
		if (/^\/message\/content\/parts\/0$/.test(caminho) && typeof v === "string") {
			if (o === "append") {
				m.texto += v;
				emitir(m, v);
			} else if (o === "replace") {
				const novo = v.startsWith(m.texto) ? v.slice(m.texto.length) : "";
				m.texto = v;
				emitir(m, novo);
			}
			return;
		}
		if (caminho.startsWith("/message/content") || caminho.startsWith("/message/metadata")) {
			coletarImagens(v, imagens);
			if (caminho === "/message/content/content_type" && typeof v === "string") m.tipo = v;
		}
		if (caminho === "/message/recipient" && typeof v === "string") m.destino = v;
	};

	const processLine = (line: string) => {
		if (!line?.startsWith("data:")) return;
		const dataStr = line.slice(5).trim();
		if (!dataStr || dataStr === "[DONE]") return;
		let data: unknown;
		try {
			data = JSON.parse(dataStr);
		} catch {
			return; // linha cortada ou não-JSON ("v1" do delta_encoding é JSON; ok)
		}
		if (!data || typeof data !== "object") return;
		const d = data as Record<string, unknown>;
		if (typeof d.conversation_id === "string") onMeta?.({ conversationId: d.conversation_id });
		if (d.message && typeof d.message === "object") {
			mensagemInteira(d.message as Record<string, unknown>);
			return;
		}
		if ("v" in d || "o" in d || "p" in d) {
			aplicar(d);
			return;
		}
		// type: title_generation, message_stream_complete, server_ste_metadata…
		coletarImagens(d, imagens);
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.trim()) processLine(buffer.trim());
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const linhas = buffer.split("\n");
			buffer = linhas.pop() || "";
			for (const l of linhas) processLine(l.trim());
		}
	} finally {
		reader.releaseLock();
	}

	const aguardandoImagem = mensagens.some(
		(m) => m.papel !== "user" && /image|dalle|t2uay3k/i.test(`${m.destino ?? ""} ${m.tipo ?? ""}`),
	);
	return { text: texto.trim(), thinkingText: "", imagens, aguardandoImagem };
}
