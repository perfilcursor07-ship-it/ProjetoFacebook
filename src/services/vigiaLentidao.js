/**
 * Mostra no log do PM2 por que o site está lento.
 *
 * O site e as tarefas de fundo (varredura das fontes, monitores, Dots…) rodam
 * no MESMO processo Node. Se uma tarefa trava o processo (parse de HTML de
 * 11 MB, imagem grande, laço pesado), toda página espera, até as leves. Sem
 * medir, só dava para chutar.
 *
 *   [lento] GET /minhas-materias 4210ms (status 200)
 *   [travado] Node parado por 1830ms — rodando: biblioteca-fontes, monitores
 *
 * LENTIDAO_LOG=false desliga.
 */

const PAGINA_LENTA_MS = Number(process.env.LENTIDAO_PAGINA_MS) || 1500;
const TRAVA_MS = Number(process.env.LENTIDAO_TRAVA_MS) || 500;
const PASSO_MS = 250;

const ligado = () => String(process.env.LENTIDAO_LOG ?? 'true').toLowerCase() !== 'false';

/** Middleware: anota as requisições que passaram de LENTIDAO_PAGINA_MS. */
function medirRequisicao(req, res, next) {
  if (!ligado()) return next();
  const inicio = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    if (ms < PAGINA_LENTA_MS) return;
    const caminho = String(req.originalUrl || req.url || '').split('?')[0];
    console.warn(`[lento] ${req.method} ${caminho} ${Math.round(ms)}ms (status ${res.statusCode})`);
  });
  next();
}

let timer = null;

/**
 * Confere a cada 250 ms se o relógio andou o esperado. Quando atrasa, alguém
 * segurou o processo — e o log diz quais tarefas estavam rodando nessa hora.
 * @param {() => Iterable<string>} [tarefasRodando]
 */
function iniciar(tarefasRodando = () => []) {
  if (timer || !ligado()) return;
  let esperado = Date.now() + PASSO_MS;
  timer = setInterval(() => {
    const agora = Date.now();
    const atraso = agora - esperado;
    esperado = agora + PASSO_MS;
    if (atraso < TRAVA_MS) return;
    let nomes = [];
    try {
      nomes = [...tarefasRodando()];
    } catch {
      nomes = [];
    }
    console.warn(
      `[travado] Node parado por ${atraso}ms — rodando: ${nomes.length ? nomes.join(', ') : 'nenhuma tarefa de fundo'}`
    );
  }, PASSO_MS);
  timer.unref?.();
}

module.exports = { medirRequisicao, iniciar };
