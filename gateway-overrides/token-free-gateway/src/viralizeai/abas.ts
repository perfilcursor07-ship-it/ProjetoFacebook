import type { Page } from "playwright-core";

/**
 * viralizeai: recarrega de tempos em tempos as abas fixas do gateway.
 *
 * As abas do ChatGPT, do Claude e do DeepSeek ficam abertas dias a fio no
 * Chrome do servidor (o mesmo do VNC). O site vai acumulando memória — a do
 * ChatGPT chegou a 1,2 GB depois de 13 h parada numa conversa cheia de
 * imagens — e o servidor foi parar no swap.
 *
 * A cada `TFG_RECARREGAR_ABAS_MIN` minutos (padrão 180) cada aba volta para a
 * página inicial do site, que solta essa memória. Só acontece sem nenhum
 * pedido em andamento, e um pedido que chega durante a recarga espera ela
 * terminar em vez de usar uma página no meio do carregamento.
 *
 * Recarregar é seguro: login fica nos cookies, a ligação de streaming do
 * Claude (`exposeFunction`) sobrevive à navegação e o estado do DeepSeek e do
 * ChatGPT fica no Node, não na página.
 */

const minutos = Number(process.env.TFG_RECARREGAR_ABAS_MIN);
export const RECARREGAR_MS = (Number.isFinite(minutos) && minutos > 0 ? minutos : 180) * 60_000;
const VERIFICAR_MS = 5 * 60_000;

let pedidosAtivos = 0;
let recarregando: Promise<void> | null = null;
const abertaDesde = new WeakMap<Page, number>();
const paginas = new Set<Page>();

/**
 * viralizeai: abas de apoio — as que NÃO devem ser entregues como a aba
 * principal de um provedor.
 *
 * A leitura da conversa do ChatGPT usa uma aba fixa própria, parada em
 * `chatgpt.com/c/<id>`. `BrowserManager.getPage` escolhe a primeira aba cuja
 * URL contenha o domínio: sem esta marca, um dia em que a aba principal
 * morresse ela devolveria a aba de leitura, e as duas passariam a navegar
 * uma por cima da outra no meio de um pedido.
 */
const auxiliares = new WeakSet<Page>();

export function marcarAbaAuxiliar(page: Page): void {
	auxiliares.add(page);
}

export function ehAbaAuxiliar(page: Page): boolean {
	return auxiliares.has(page);
}

/** Aba entregue a um provedor (chamado por BrowserManager.getPage). */
export function registrarPagina(page: Page, agora = Date.now()): void {
	if (paginas.has(page)) return;
	paginas.add(page);
	if (!abertaDesde.has(page)) abertaDesde.set(page, agora);
	page.once?.("close", () => paginas.delete(page));
}

/**
 * Marca um pedido em andamento. Devolve a função que o encerra (pode ser
 * chamada mais de uma vez). Se uma recarga estiver acontecendo, espera.
 */
export async function comecarPedido(): Promise<() => void> {
	while (recarregando) await recarregando.catch(() => {});
	pedidosAtivos += 1;
	let encerrado = false;
	return () => {
		if (encerrado) return;
		encerrado = true;
		pedidosAtivos = Math.max(0, pedidosAtivos - 1);
	};
}

/** Para onde cada site volta: a página inicial, sem conversa aberta. */
export function enderecoLimpo(url: string): string | null {
	let host = "";
	try {
		host = new URL(url).hostname;
	} catch {
		return null;
	}
	if (/(^|\.)chatgpt\.com$/i.test(host)) return "https://chatgpt.com/";
	if (/(^|\.)claude\.ai$/i.test(host)) return "https://claude.ai/new";
	if (/(^|\.)deepseek\.com$/i.test(host)) return "https://chat.deepseek.com/";
	return null;
}

/** Recarrega as abas que passaram do tempo. Devolve quantas recarregou. */
export async function recarregarAbasVelhas(agora = Date.now()): Promise<number> {
	if (pedidosAtivos > 0 || recarregando) return 0;
	const velhas = [...paginas].filter((p) => {
		if (p.isClosed()) {
			paginas.delete(p);
			return false;
		}
		return agora - (abertaDesde.get(p) ?? agora) >= RECARREGAR_MS;
	});
	if (!velhas.length) return 0;

	recarregando = (async () => {
		for (const page of velhas) {
			const antes = page.url();
			const destino = enderecoLimpo(antes);
			try {
				if (destino && antes !== destino) {
					await page.goto(destino, { waitUntil: "domcontentloaded", timeout: 45_000 });
				} else {
					await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
				}
				console.log(`[viralizeai-abas] aba recarregada para liberar memória: ${destino ?? antes}`);
			} catch (err) {
				console.warn(
					`[viralizeai-abas] não recarreguei ${antes}: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				abertaDesde.set(page, Date.now());
			}
		}
	})();
	try {
		await recarregando;
	} finally {
		recarregando = null;
	}
	return velhas.length;
}

const timer = setInterval(() => {
	recarregarAbasVelhas().catch(() => {});
}, VERIFICAR_MS);
(timer as { unref?: () => void }).unref?.();

/** Só para teste. */
export function _estado() {
	return { pedidosAtivos, paginas: paginas.size, recarregando: Boolean(recarregando) };
}
