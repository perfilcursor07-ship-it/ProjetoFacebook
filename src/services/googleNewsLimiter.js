/**
 * Ritmo das chamadas ao Google News.
 *
 * O radar monta uma rajada: 12 temas x 2 consultas x 2 coletores = até 48
 * requisições disparadas de uma vez em `Promise.allSettled`. O Google responde
 * HTTP 503 a essa rajada e, pior, cada falha do RSS caía no fallback em Python
 * — que abre outro processo e bate no Google de novo. A tempestade causava o
 * 503 e o 503 alimentava a tempestade.
 *
 * Diferente do YouTube, aqui não serializamos: uma chamada a cada 5s deixaria o
 * radar levando minutos. O que resolve é um teto de chamadas simultâneas, um
 * respiro entre os inícios e uma pausa geral ao primeiro sinal de limite.
 *
 * Ajustável no .env:
 *   GOOGLE_NEWS_PARALELO      chamadas simultâneas (padrão 4)
 *   GOOGLE_NEWS_INTERVALO_MS  respiro entre inícios (padrão 150)
 *   GOOGLE_NEWS_PAUSA_MIN     1ª pausa após bloqueio, em minutos (padrão 5)
 *   GOOGLE_NEWS_PAUSA_MAX_MIN teto da pausa, que dobra a cada bloqueio (padrão 30)
 */

// Dentro do `node --test` não há por que esperar entre chamadas simuladas.
//
// O intervalo é global, então ele é o piso de latência do radar: 48 consultas
// a 150ms levam ~7s no cache frio (contra ~2s na rajada que tomava 503). As
// repetições saem do cache, então esse custo só aparece na primeira rodada.
// Ambos os valores são ajustáveis porque a tolerância real do Google não é
// documentada — se o 503 voltar, aumente o intervalo.
const INTERVALO_PADRAO_MS = process.env.NODE_TEST_CONTEXT ? 0 : 150;
const LIMITE_PARALELO = Math.max(1, Number(process.env.GOOGLE_NEWS_PARALELO) || 4);
const INTERVALO_MS = Math.max(
  0,
  Number(process.env.GOOGLE_NEWS_INTERVALO_MS ?? INTERVALO_PADRAO_MS) || 0
);
const PAUSA_MS = Math.max(1, Number(process.env.GOOGLE_NEWS_PAUSA_MIN) || 5) * 60_000;
const PAUSA_MAX_MS = Math.max(
  PAUSA_MS,
  (Number(process.env.GOOGLE_NEWS_PAUSA_MAX_MIN) || 30) * 60_000
);

let ativos = 0;
let espera = [];
let ultimoInicio = 0;
let pausadoAte = 0;
let motivoDaPausa = '';
let bloqueiosSeguidos = 0;
/** Pausa venceu, mas ainda falta confirmar que o Google voltou. */
let aguardandoSonda = false;
let sondaEmVoo = false;

function hora(ms) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Araguaina',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

function emPausa(agora = Date.now()) {
  return pausadoAte > agora;
}

function erroDePausa() {
  const err = new Error(
    `O Google News limitou este servidor (${motivoDaPausa}). As consultas estão em pausa até ${hora(
      pausadoAte
    )} para o bloqueio passar.`
  );
  err.status = 503;
  err.code = 'GOOGLE_NEWS_EM_PAUSA';
  return err;
}

/**
 * Enquanto a sonda não responde, o resto da rajada espera a próxima rodada em
 * vez de bater no Google junto com ela.
 */
function erroDeSondagem() {
  const err = new Error(
    'O Google News está sendo testado depois de um bloqueio. Tente de novo em instantes.'
  );
  err.status = 503;
  err.code = 'GOOGLE_NEWS_EM_SONDAGEM';
  return err;
}

/** O erro indica limite por IP? (503/429 ou página de tráfego incomum) */
function tipoDeBloqueio(err) {
  if (err?.code === 'GOOGLE_NEWS_EM_PAUSA' || err?.code === 'GOOGLE_NEWS_EM_SONDAGEM') return null;
  const status = Number(err?.response?.status || err?.status || 0);
  const texto = String(err?.message || err || '').toLowerCase();
  if (status === 429 || /\bstatus code 429\b/.test(texto) || texto.includes('too many requests')) {
    return '429';
  }
  // 503 é a resposta que o Google News dá quando está recusando o IP.
  if (status === 503 || /\bstatus code 503\b/.test(texto)) return '503';
  if (texto.includes('unusual traffic') || texto.includes('/sorry/')) return 'antibot';
  return null;
}

/**
 * Avisa o limitador de uma falha. Devolve true quando ela iniciou (ou
 * confirmou) a pausa.
 */
function registrarFalha(err) {
  const tipo = tipoDeBloqueio(err);
  if (!tipo) return false;
  const agora = Date.now();
  if (emPausa(agora)) return true;
  aguardandoSonda = false;
  bloqueiosSeguidos += 1;
  const duracao = Math.min(PAUSA_MAX_MS, PAUSA_MS * 2 ** (bloqueiosSeguidos - 1));
  pausadoAte = agora + duracao;
  motivoDaPausa =
    tipo === '429'
      ? 'HTTP 429, requisições demais'
      : tipo === '503'
        ? 'HTTP 503, requisições demais'
        : 'tráfego incomum';
  console.warn(
    `[google-news] bloqueio (${motivoDaPausa}): consultas em pausa por ${Math.round(
      duracao / 60_000
    )} min, até ${hora(pausadoAte)}`
  );
  return true;
}

/** Uma resposta boa fecha o circuito: a próxima pausa volta ao tempo inicial. */
function registrarSucesso() {
  bloqueiosSeguidos = 0;
  pausadoAte = 0;
  aguardandoSonda = false;
}

function liberarVaga() {
  ativos -= 1;
  const proximo = espera.shift();
  if (proximo) {
    ativos += 1;
    proximo();
  }
}

function pegarVaga() {
  if (ativos < LIMITE_PARALELO) {
    ativos += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => espera.push(resolve));
}

/**
 * Decide se esta chamada pode falar com o Google: 'normal' quando o circuito
 * está fechado, 'sonda' para a única chamada que testa a volta depois de uma
 * pausa. As demais são recusadas sem gerar tráfego.
 */
function pedirPassagem() {
  const agora = Date.now();
  if (pausadoAte > agora) throw erroDePausa();

  // A pausa venceu. Liberar as 48 de uma vez só renovaria o bloqueio: primeiro
  // uma sonda confirma que o Google voltou a responder.
  if (pausadoAte !== 0) aguardandoSonda = true;

  if (aguardandoSonda) {
    if (sondaEmVoo) throw erroDeSondagem();
    sondaEmVoo = true;
    return 'sonda';
  }
  return 'normal';
}

/**
 * Roda `tarefa` respeitando o teto de simultâneas, o respiro entre inícios e a
 * pausa por bloqueio. Lança GOOGLE_NEWS_EM_PAUSA (ou EM_SONDAGEM), sem chamar o
 * Google, enquanto durar o bloqueio — inclusive para quem já estava na fila.
 */
async function executar(tarefa) {
  const papel = pedirPassagem();
  await pegarVaga();
  try {
    // A sonda atravessa a pausa de propósito: é ela que vai derrubá-la.
    if (papel !== 'sonda' && emPausa()) throw erroDePausa();
    const falta = ultimoInicio + INTERVALO_MS - Date.now();
    if (falta > 0) await new Promise((resolve) => setTimeout(resolve, falta));
    if (papel !== 'sonda' && emPausa()) throw erroDePausa();
    ultimoInicio = Date.now();

    const resultado = await tarefa();
    if (papel === 'sonda') {
      console.info('[google-news] sonda respondeu: consultas liberadas de novo');
    }
    registrarSucesso();
    return resultado;
  } catch (err) {
    registrarFalha(err);
    throw err;
  } finally {
    // Falha que não é bloqueio (timeout, DNS) não prova que o Google voltou:
    // soltar a marca deixa a próxima chamada sondar de novo.
    if (papel === 'sonda') sondaEmVoo = false;
    liberarVaga();
  }
}

/** A falha veio de limite do Google (ou da pausa)? Quem chama usa para não insistir. */
function ehBloqueio(err) {
  return (
    err?.code === 'GOOGLE_NEWS_EM_PAUSA' ||
    err?.code === 'GOOGLE_NEWS_EM_SONDAGEM' ||
    tipoDeBloqueio(err) !== null
  );
}

function estado() {
  const pausado = emPausa();
  return {
    pausado,
    ate: pausado ? new Date(pausadoAte).toISOString() : null,
    motivo: pausado ? motivoDaPausa : null,
    testando: !pausado && aguardandoSonda,
    ativos,
    naFila: espera.length,
    limiteParalelo: LIMITE_PARALELO,
    intervaloMs: INTERVALO_MS,
  };
}

/** Só para testes. */
function reiniciar() {
  ativos = 0;
  espera = [];
  ultimoInicio = 0;
  pausadoAte = 0;
  motivoDaPausa = '';
  bloqueiosSeguidos = 0;
  aguardandoSonda = false;
  sondaEmVoo = false;
}

module.exports = {
  executar,
  ehBloqueio,
  erroDeSondagem,
  registrarFalha,
  registrarSucesso,
  tipoDeBloqueio,
  emPausa,
  erroDePausa,
  estado,
  reiniciar,
  LIMITE_PARALELO,
  INTERVALO_MS,
};
