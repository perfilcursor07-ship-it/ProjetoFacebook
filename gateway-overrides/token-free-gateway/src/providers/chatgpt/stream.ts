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
	/** status "finished_successfully" (ou end_turn) já chegou. */
	terminou?: boolean;
	/** Último caminho de delta desta mensagem (`{"v":…}` sem caminho). */
	caminho?: string;
};

const PADRAO_IMAGEM = /^(https?:\/\/|file-service:\/\/|sediment:\/\/)/i;

export function mensagemVisivel(m: { papel?: string; tipo?: string; destino?: string }): boolean {
	return (
		m.papel === "assistant" &&
		(!m.tipo || m.tipo === "text") &&
		(!m.destino || m.destino === "all")
	);
}

/**
 * Foto que o ChatGPT achou na web para um `<AsyncImage query="…"/>`: o
 * servidor dele busca, e devolve em `images.openai.com` (abre sem login).
 */
const FOTO_DO_CHATGPT = /^https:\/\/images\.openai\.com\//i;

/**
 * Lista de imagens com ordem de preferência.
 *
 * As fotos que a tela do ChatGPT MOSTRA (resultado do <AsyncImage>, em
 * `…opGenui.componentResults` / `genui_components`) vêm primeiro; o resto —
 * miniaturas das páginas citadas, que também ficam em images.openai.com —
 * só no fim. Antes valia a ordem de chegada, e a miniatura do link citado
 * (o banner da SOLA Network) ganhava da foto do pastor que aparecia na tela.
 *
 * `paginas`: de qual site veio cada foto (o selo "lagunabaptist.org" da tela),
 * para o crédito.
 */
export type ListaDeImagens = string[] & { prioritarias?: number; paginas?: Record<string, string> };

const DO_COMPONENTE = /genui|componentresults|opgenui|asyncimage/i;

function adicionarImagem(destino: ListaDeImagens, v: string, prioridade: boolean, pagina?: string) {
	const prio = destino.prioritarias ?? 0;
	const i = destino.indexOf(v);
	if (i >= 0) {
		if (!prioridade || i < prio) return;
		destino.splice(i, 1);
	}
	if (prioridade) {
		destino.splice(prio, 0, v);
		destino.prioritarias = prio + 1;
	} else if (i < 0) {
		destino.push(v);
	}
	if (pagina && /^https?:\/\//i.test(pagina) && !FOTO_DO_CHATGPT.test(pagina)) {
		destino.paginas = destino.paginas ?? {};
		destino.paginas[v] = destino.paginas[v] ?? pagina;
	}
}

/** Junta `nova` em `base` mantendo as fotos da tela na frente. */
export function juntarImagens(base: ListaDeImagens, nova: ListaDeImagens): ListaDeImagens {
	const prio = nova.prioritarias ?? 0;
	nova.forEach((v, i) => adicionarImagem(base, v, i < prio, nova.paginas?.[v]));
	return base;
}

/** Recolhe ponteiros/URLs de imagem de qualquer objeto da resposta. */
export function coletarImagens(alvo: unknown, destino: ListaDeImagens, profundidade = 0, doComponente = false): void {
	if (!alvo || profundidade > 12) return;
	if (typeof alvo === "string") {
		if (FOTO_DO_CHATGPT.test(alvo)) adicionarImagem(destino, alvo, doComponente);
		return;
	}
	if (Array.isArray(alvo)) {
		for (const item of alvo) coletarImagens(item, destino, profundidade + 1, doComponente);
		return;
	}
	if (typeof alvo !== "object") return;
	const o = alvo as Record<string, unknown>;
	const ehImagem =
		o.content_type === "image_asset_pointer" ||
		typeof o.asset_pointer === "string" ||
		/image/i.test(String(o.content_type ?? o.type ?? ""));
	// No resultado do componente, `url` é a página de onde a foto veio.
	const paginaDaFoto = typeof o.url === "string" && typeof o.content_url === "string" ? o.url : undefined;
	for (const campo of ["asset_pointer", "image_url", "thumbnail_url", "url", "src", "content_url"]) {
		const v = o[campo];
		if (typeof v !== "string" || !PADRAO_IMAGEM.test(v)) continue;
		// URL comum só conta quando o objeto é claramente uma imagem (senão
		// todo link citado viraria "imagem").
		if (/^https?:/i.test(v) && !ehImagem && campo === "url") continue;
		adicionarImagem(destino, v, doComponente, campo === "url" ? undefined : paginaDaFoto);
	}
	// Todos os campos, não só os conhecidos: a foto do <AsyncImage> fica em
	// `model_dil_v2.appData.opGenui.componentResults[…].images[]` e em
	// `genui_components` — nomes que mudam. Lá dentro só entra o que é
	// claramente imagem (campos acima) ou foto de images.openai.com.
	for (const [chave, valor] of Object.entries(o)) {
		const filho = doComponente || DO_COMPONENTE.test(chave);
		if (valor && typeof valor === "object") coletarImagens(valor, destino, profundidade + 1, filho);
		else if (typeof valor === "string" && chave !== "url") coletarImagens(valor, destino, profundidade + 1, filho);
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
	const imagens: ListaDeImagens = [];
	const mensagens: Mensagem[] = [];
	let atual: Mensagem | null = null;
	let ultimoCaminho = "";
	let texto = "";
	// Mensagens por "c" (índice que o formato delta põe nas operações).
	const porIndice = new Map<number, Mensagem>();

	/**
	 * Um texto só, mesmo quando a MESMA resposta chega por dois caminhos.
	 *
	 * O ChatGPT passou a mandar a resposta em pedaços e, junto, cópias dela
	 * (outra mensagem, outro id, às vezes uma segunda versão em paralelo). Cada
	 * caminho era emitido e a matéria saía com cada trecho duas vezes,
	 * intercalado ("A A B C B C…"). Agora:
	 * - texto que continua o que já saiu: sai só o pedaço novo;
	 * - cópia atrasada do que já saiu: ignorada;
	 * - conteúdo diferente: só vira um novo trecho (separado por parágrafo) se
	 *   veio DEPOIS de uma pesquisa/ferramenta ou com o anterior terminado — a
	 *   resposta antes e depois de buscar. Versão paralela fica de fora.
	 */
	let bloco: { dono: Mensagem; texto: string } | null = null;
	let ferramentaDepoisDoBloco = false;
	// Para o log: quantas vezes a mesma resposta chegou por outro caminho.
	const ignorados = { copias: 0, paralelas: 0, donos: new Set<Mensagem>() };
	const sair = (pedaco: string) => {
		if (!pedaco) return;
		texto += pedaco;
		onDelta?.(pedaco);
	};
	const sincronizar = (m: Mensagem) => {
		if (!mensagemVisivel(m) || !m.texto) return;
		const t = m.texto;
		if (!bloco) {
			bloco = { dono: m, texto: t };
			sair(t);
			return;
		}
		if (t.startsWith(bloco.texto)) {
			sair(t.slice(bloco.texto.length));
			bloco.texto = t;
			if (bloco.dono !== m) ignorados.donos.add(m);
			bloco.dono = m;
			return;
		}
		if (bloco.texto.startsWith(t)) {
			if (bloco.dono !== m) ignorados.copias += 1;
			return;
		}
		if (bloco.dono === m) return;
		if (ferramentaDepoisDoBloco || bloco.dono.terminou) {
			sair("\n\n");
			bloco = { dono: m, texto: t };
			ferramentaDepoisDoBloco = false;
			sair(t);
			return;
		}
		ignorados.paralelas += 1;
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
		if (msg.status === "finished_successfully" || msg.end_turn === true) m.terminou = true;
		if (m.papel !== "user" && !mensagemVisivel(m) && bloco) ferramentaDepoisDoBloco = true;
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
		// Fotografia velha (mais curta) não apaga o que já chegou.
		if (completo && completo.length >= m.texto.length) m.texto = completo;
		sincronizar(m);
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
				// `{"v":"…"}` sem caminho logo depois de abrir é texto da mensagem.
				ultimoCaminho = "/message/content/parts/0";
				const parte = ((env.message as Record<string, unknown>).content as Record<string, unknown> | undefined)
					?.parts as unknown[] | undefined;
				if (typeof parte?.[0] === "string" && parte[0]) {
					atual.texto = parte[0];
					sincronizar(atual);
				}
			}
			return;
		}
		const m = atual as Mensagem | null;
		if (!m || m.papel === "user") return;
		if (/^\/message\/content\/parts\/0$/.test(caminho) && typeof v === "string") {
			if (o === "append") m.texto += v;
			else if (o === "replace") m.texto = v;
			sincronizar(m);
			return;
		}
		if (caminho === "/message/status" && v === "finished_successfully") m.terminou = true;
		if (caminho === "/message/end_turn" && v === true) m.terminou = true;
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
			const indice = typeof d.c === "number" ? d.c : null;
			const abre = d.p === "" && d.o === "add";
			// Operação de outra mensagem (índice "c"): troca a mensagem atual.
			if (indice !== null && !abre && porIndice.has(indice)) {
				const alvo = porIndice.get(indice) as Mensagem;
				if (alvo !== atual) {
					if (atual) (atual as Mensagem).caminho = ultimoCaminho;
					atual = alvo;
					ultimoCaminho = alvo.caminho ?? "/message/content/parts/0";
				}
			}
			aplicar(d);
			if (indice !== null && abre && atual) porIndice.set(indice, atual);
			if (atual) (atual as Mensagem).caminho = ultimoCaminho;
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

	if (ignorados.copias || ignorados.paralelas || ignorados.donos.size) {
		console.log(
			`[ChatGPT Web] a resposta chegou por mais de um caminho — cópias ignoradas: ${ignorados.copias}, versões paralelas ignoradas: ${ignorados.paralelas}, mensagens com o mesmo texto: ${ignorados.donos.size + 1}`,
		);
	}
	// Imagem gerada pela ferramenta, ou <AsyncImage>/galeria que o servidor do
	// ChatGPT resolve 1–2 s depois: vale ler a conversa salva em seguida.
	const aguardandoImagem =
		mensagens.some((m) => m.papel !== "user" && /image|dalle|t2uay3k/i.test(`${m.destino ?? ""} ${m.tipo ?? ""}`)) ||
		/<AsyncImage(?:Group)?\b|\ue200image_group\ue202/.test(texto);
	return {
		text: texto.trim(),
		thinkingText: "",
		imagens: [...imagens],
		aguardandoImagem,
		fotosDaTela: imagens.prioritarias ?? 0,
		paginasDasImagens: imagens.paginas,
	};
}
