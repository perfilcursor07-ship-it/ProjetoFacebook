/**
 * "Corrigir texto" do título escrito pelo editor no /materia-manual.
 *
 * A IA só corrige ortografia, acentuação, pontuação e maiúsculas. Se ela
 * tentar reescrever (trocar palavras, mudar o sentido), o título do editor
 * é mantido: quem escreveu o próprio título não quer o da IA.
 */

const MIN = 8;
const MAX = 180;
/** Fração máxima de palavras que podem mudar além de acento/caixa. */
const LIMITE_MUDANCA = 0.3;

function semAcento(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Quantas palavras mudaram de fato. Acento, caixa e pontuação não contam:
 * "voce" → "Você" é correção; "venceu" → "perdeu" é reescrita.
 */
function proporcaoReescrita(original, corrigido) {
  const a = semAcento(original);
  const b = semAcento(corrigido);
  if (!a.length) return 1;
  // Distância de edição por palavra (inserir, remover ou trocar).
  const dist = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dist[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const igual = a[i - 1] === b[j - 1] || parecidas(a[i - 1], b[j - 1]);
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + (igual ? 0 : 1));
    }
  }
  return dist[a.length][b.length] / a.length;
}

/** Erro de digitação (1 letra trocada, faltando ou sobrando) conta como a mesma palavra. */
function parecidas(x, y) {
  if (Math.abs(x.length - y.length) > 1 || Math.min(x.length, y.length) < 4) return false;
  let i = 0;
  let j = 0;
  let diferencas = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i += 1;
      j += 1;
      continue;
    }
    diferencas += 1;
    if (diferencas > 1) return false;
    if (x.length > y.length) i += 1;
    else if (y.length > x.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return diferencas + (x.length - i) + (y.length - j) <= 1;
}

function limparTitulo(texto) {
  return String(texto || '')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lerResposta(raw) {
  let texto = String(raw || '').trim();
  const cerca = texto.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (cerca) texto = cerca[1].trim();
  try {
    const parsed = JSON.parse(texto);
    return limparTitulo(parsed?.titulo || parsed?.title || '');
  } catch {
    return limparTitulo(texto.split('\n')[0]);
  }
}

async function corrigirTitulo(titulo) {
  const original = limparTitulo(titulo);
  if (original.length < MIN || original.length > MAX) {
    const err = new Error(`Escreva um título entre ${MIN} e ${MAX} caracteres.`);
    err.status = 400;
    throw err;
  }

  const messages = [
    {
      role: 'system',
      content: [
        'Você é um revisor de português do Brasil.',
        'Corrija SOMENTE ortografia, acentuação, pontuação, concordância evidente e uso de maiúsculas do título recebido.',
        'NÃO troque palavras por sinônimos, NÃO reescreva, NÃO encurte, NÃO acrescente informação e NÃO mude o sentido.',
        'Nomes próprios ficam como estão, só com a grafia correta.',
        'Se o título já estiver correto, devolva-o idêntico.',
        'Responda somente com JSON: {"titulo":"..."}',
      ].join(' '),
    },
    { role: 'user', content: original },
  ];

  const deepseek = require('./deepseekService');
  const { comModelo } = require('./tokenFreeGatewayService');
  // Modelo dos títulos fixado em /claude, quando houver.
  const modelo = await require('./iaModeloTarefaService').modeloDaTarefa('titulos').catch(() => null);
  const raw = await comModelo(modelo, () =>
    deepseek.chatCompletion(messages, { json: true, temperature: 0.1, tarefa: 'auxiliar' })
  );
  const corrigido = lerResposta(raw);

  if (!corrigido || corrigido.length > MAX) {
    return { titulo: original, alterado: false, aviso: 'A IA não devolveu uma correção válida; mantive o seu título.' };
  }
  if (proporcaoReescrita(original, corrigido) > LIMITE_MUDANCA) {
    return { titulo: original, alterado: false, aviso: 'A IA tentou reescrever o título; mantive o seu como estava.' };
  }
  return { titulo: corrigido, alterado: corrigido !== original, aviso: null };
}

module.exports = { corrigirTitulo, proporcaoReescrita };
