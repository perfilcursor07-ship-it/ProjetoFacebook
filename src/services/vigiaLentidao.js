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

/**
 * Requisições em andamento AGORA.
 *
 * "[travado] Node parado por 65024ms — rodando: nenhuma tarefa de fundo"
 * dizia que não era tarefa de fundo, e só. Sobrava adivinhar, e eu adivinhei
 * errado pelo menos uma vez. Quem segura o processo por um minuto é quase
 * sempre uma requisição; saber QUAL encerra a discussão.
 */
const emAndamento = new Set();

/** Middleware: anota as requisições que passaram de LENTIDAO_PAGINA_MS. */
function medirRequisicao(req, res, next) {
  if (!ligado()) return next();
  const inicio = process.hrtime.bigint();
  const caminho = String(req.originalUrl || req.url || '').split('?')[0];
  const emCurso = { metodo: req.method, caminho, desde: Date.now() };
  emAndamento.add(emCurso);
  res.on('finish', () => {
    emAndamento.delete(emCurso);
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    if (ms < PAGINA_LENTA_MS) return;
    console.warn(`[lento] ${req.method} ${caminho} ${Math.round(ms)}ms (status ${res.statusCode})`);
  });
  // `finish` não dispara quando o cliente desconecta no meio: sem isto a
  // requisição ficaria no conjunto para sempre e poluiria todo log seguinte.
  res.on('close', () => emAndamento.delete(emCurso));
  next();
}

/** As requisições abertas, da mais antiga para a mais nova. */
function requisicoesEmAndamento(agora = Date.now()) {
  return [...emAndamento]
    .sort((a, b) => a.desde - b.desde)
    .map((r) => `${r.metodo} ${r.caminho} (há ${Math.round((agora - r.desde) / 1000)}s)`);
}

let timer = null;

/**
 * Confere a cada 250 ms se o relógio andou o esperado. Quando atrasa, alguém
 * segurou o processo — e o log diz quais tarefas estavam rodando nessa hora.
 * @param {() => Iterable<string>} [tarefasRodando]
 */
function iniciar(tarefasRodando = () => [], processo = '') {
  const rotulo = processo ? `[travado][${processo}]` : '[travado]';
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
    const abertas = requisicoesEmAndamento(agora);
    console.warn(
      `${rotulo} Node parado por ${atraso}ms — rodando: ${nomes.length ? nomes.join(', ') : 'nenhuma tarefa de fundo'}` +
        (abertas.length ? ` | requisições abertas: ${abertas.slice(0, 5).join(' ; ')}` : ' | nenhuma requisição aberta')
    );
  }, PASSO_MS);
  timer.unref?.();
}

module.exports = { medirRequisicao, iniciar, requisicoesEmAndamento };
