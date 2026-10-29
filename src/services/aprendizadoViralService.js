/**
 * Aprender com as matérias que bombaram.
 *
 * O aprendizado que já existia (`editorialLearningService`) olha as CORREÇÕES
 * do editor — o que ele reescreveu à mão. Isso ensina a voz da casa, mas não
 * ensina o que o público responde: uma matéria pode estar impecável e não
 * render nada.
 *
 * Aqui o sinal é o desempenho real do post: curtidas, comentários,
 * compartilhamentos e views já gravados em `publications`. A IA lê as que
 * melhor performaram NA PÁGINA e escreve uma receita curta — o que elas têm
 * em comum — que entra no prompt de quem escreve.
 *
 * Três cuidados que vêm de como o resto do projeto erra:
 *
 * 1. Uma receita POR PÁGINA. Públicos diferentes, receitas diferentes;
 *    misturar ensinaria a média de ninguém.
 * 2. A receita descreve FORMA (ângulo, tipo de título, tamanho, abertura),
 *    nunca assunto. Receita que fixa tema faz o dot reescrever a mesma
 *    notícia para sempre.
 * 3. A amostra fica guardada. Receita que o editor não pode conferir é
 *    palpite com cara de ciência.
 */
const db = require('../config/db');
const { env } = require('../config/env');

const TABELA = 'aprendizado_viral';

/** Dias de histórico considerados. Mais que isso vira retrato de outra época. */
const DIAS_PADRAO = Math.min(180, Math.max(7, Number(process.env.VIRAL_DIAS) || 60));
/** Abaixo disso não há padrão, há coincidência. */
const MINIMO_MATERIAS = Math.max(3, Number(process.env.VIRAL_MINIMO) || 5);
/** Quantas entram na análise (as melhores). */
const AMOSTRA_MAX = 12;
/** Receita mais velha que isso é refeita na próxima vez que alguém precisar. */
const VALIDADE_MS = Math.max(1, Number(process.env.VIRAL_VALIDADE_HORAS) || 24) * 3_600_000;

function corta(texto, max) {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Primeiro parágrafo da matéria — é a abertura que decide se o leitor fica.
 * O título já vem separado, então ele é descartado quando abre o corpo.
 */
function aberturaDaMateria(materia, titulo) {
  const linhas = String(materia || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const t = String(titulo || '').trim().toLowerCase();
  const primeira = linhas.find((l) => l.toLowerCase() !== t && l.length > 40);
  return corta(primeira || linhas[0] || '', 300);
}

/**
 * As matérias que melhor performaram nesta página.
 *
 * Usa o mesmo score do resto do sistema (`AiMatters.VIRAL_SCORE_SQL`), para
 * "bombou" querer dizer a mesma coisa aqui e na aba Viralizou.
 */
async function materiasQueBombaram({ userId, pageId = null, dias = DIAS_PADRAO, limite = AMOSTRA_MAX }) {
  const desde = new Date(Date.now() - dias * 86_400_000);
  const score =
    '(COALESCE(publications.fb_likes, 0) + COALESCE(publications.fb_comments, 0) * 3 ' +
    '+ COALESCE(publications.fb_shares, 0) * 5 + LEAST(COALESCE(publications.fb_views, 0), 5000) / 50)';

  const query = db('ai_matters')
    .join('publications', 'publications.id', 'ai_matters.publication_id')
    .where('ai_matters.user_id', userId)
    .where('ai_matters.status', 'publicado')
    .where('ai_matters.updated_at', '>=', desde)
    .whereRaw(`${score} > 0`)
    .select(
      'ai_matters.id',
      'ai_matters.titulo',
      'ai_matters.materia',
      'publications.fb_likes',
      'publications.fb_comments',
      'publications.fb_shares',
      'publications.fb_views'
    )
    .select(db.raw(`${score} as score`))
    .orderByRaw(`${score} DESC`)
    .limit(limite);

  if (pageId) query.where('ai_matters.facebook_page_id', pageId);

  const linhas = await query.catch((err) => {
    console.warn('[viral] consulta:', err.message);
    return [];
  });

  return linhas.map((m) => ({
    id: m.id,
    titulo: String(m.titulo || '').trim(),
    abertura: aberturaDaMateria(m.materia, m.titulo),
    curtidas: Number(m.fb_likes) || 0,
    comentarios: Number(m.fb_comments) || 0,
    compartilhamentos: Number(m.fb_shares) || 0,
    views: Number(m.fb_views) || 0,
    score: Math.round(Number(m.score) || 0),
  }));
}

const SISTEMA = [
  'Você analisa o DESEMPENHO de matérias de uma página de notícias no Facebook.',
  '',
  'Recebe as que mais engajaram. Devolva o que elas têm em comum na FORMA —',
  'tipo de título, ângulo, tamanho, abertura, uso de número, nome próprio,',
  'pergunta, tensão. Nada de assunto: "falar de política" não é regra de forma,',
  'e fixar tema faria o redator reescrever a mesma notícia para sempre.',
  '',
  'Responda JSON: { "regras": ["...", "..."], "resumo": "uma frase" }',
  'De 3 a 6 regras, cada uma curta, no imperativo e aplicável a QUALQUER pauta.',
  'Regra que não dá para seguir numa notícia nova não serve — descarte.',
  'Se a amostra não mostrar padrão nenhum, devolva regras: [].',
].join('\n');

function montarMensagens(materias) {
  const lista = materias
    .map(
      (m, i) =>
        `${i + 1}. [${m.score} pts | ${m.curtidas} curtidas, ${m.comentarios} comentários, ` +
        `${m.compartilhamentos} compartilhamentos]\n   TÍTULO: ${m.titulo}\n   ABERTURA: ${m.abertura}`
    )
    .join('\n\n');
  return [
    { role: 'system', content: SISTEMA },
    { role: 'user', content: `Matérias que mais engajaram nesta página:\n\n${lista}` },
  ];
}

function iaConfigurada() {
  try {
    return (
      require('./editorialLearningService') &&
      (env.deepseekApiKey || env.anthropicApiKey || require('./deepseekService').deepseekPeloGateway())
    );
  } catch {
    return false;
  }
}

async function chamarIa(messages) {
  const usarClaude = (() => {
    try {
      return require('./deepseekService').usarClaude('auxiliar');
    } catch {
      return false;
    }
  })();

  if (usarClaude) {
    return require('./claudeService').chatCompletion(messages, {
      json: true,
      tarefa: 'auxiliar',
      maxTokens: 900,
    });
  }

  // DeepSeek web do gateway com o token-free ligado; API oficial só sem ele
  // (ou com DEEPSEEK_USAR_API=true).
  return require('./deepseekService').chatCompletionDeepseekDireto(messages, {
    temperature: 0.2,
    json: true,
    timeout: 90_000,
  });
}

/** Regras devolvidas pela IA, limpas e contidas. */
function lerRegras(bruto) {
  let dados;
  try {
    dados = JSON.parse(String(bruto || '{}'));
  } catch {
    return { regras: [], resumo: '' };
  }
  const regras = (Array.isArray(dados.regras) ? dados.regras : [])
    .map((r) => corta(String(r || '').replace(/^\s*[-•*\d.)\s]+/, ''), 200))
    .filter((r) => r.length >= 10)
    .slice(0, 6);
  return { regras, resumo: corta(dados.resumo, 240) };
}

/**
 * Refaz a receita desta página e guarda. Nunca lança: aprendizado é extra, e
 * derrubar a escrita do dot por causa dele seria péssimo negócio.
 */
async function gerarReceita({ userId, pageId = null, dias = DIAS_PADRAO }) {
  const registrar = async (patch) => {
    const chave = { user_id: userId, facebook_page_id: pageId || null };
    const existe = await db(TABELA).where(chave).first('id').catch(() => null);
    const dados = { ...patch, updated_at: db.fn.now() };
    if (existe) await db(TABELA).where({ id: existe.id }).update(dados).catch(() => {});
    else await db(TABELA).insert({ ...chave, ...dados }).catch(() => {});
  };

  try {
    const materias = await materiasQueBombaram({ userId, pageId, dias });
    if (materias.length < MINIMO_MATERIAS) {
      const motivo =
        `Só ${materias.length} matéria(s) com engajamento nos últimos ${dias} dias. ` +
        `Preciso de ${MINIMO_MATERIAS} para achar padrão em vez de coincidência.`;
      await registrar({ total_materias: materias.length, ultimo_erro: motivo, gerado_em: new Date() });
      return { ok: false, motivo, materias };
    }

    if (!iaConfigurada()) {
      const motivo = 'Nenhuma IA configurada para analisar o desempenho.';
      await registrar({ total_materias: materias.length, ultimo_erro: motivo });
      return { ok: false, motivo, materias };
    }

    const { regras, resumo } = lerRegras(await chamarIa(montarMensagens(materias)));
    if (!regras.length) {
      const motivo = 'A análise não achou padrão de forma nessas matérias.';
      await registrar({ total_materias: materias.length, ultimo_erro: motivo, gerado_em: new Date() });
      return { ok: false, motivo, materias };
    }

    const media = Math.round(materias.reduce((s, m) => s + m.score, 0) / materias.length);
    await registrar({
      regras: JSON.stringify({ regras, resumo }),
      amostra: JSON.stringify(
        materias.map((m) => ({ id: m.id, titulo: m.titulo, score: m.score }))
      ),
      total_materias: materias.length,
      media_score: media,
      gerado_em: new Date(),
      ultimo_erro: null,
    });
    console.log(
      `[viral] receita da página ${pageId || '(todas)'}: ${regras.length} regra(s) de ${materias.length} matérias`
    );
    return { ok: true, regras, resumo, materias, mediaScore: media };
  } catch (err) {
    console.warn('[viral] gerar receita:', err.message);
    await registrar({ ultimo_erro: corta(err.message, 480) });
    return { ok: false, motivo: err.message, materias: [] };
  }
}

/** A receita guardada desta página, sem refazer. */
async function receitaGuardada({ userId, pageId = null }) {
  const linha = await db(TABELA)
    .where({ user_id: userId, facebook_page_id: pageId || null })
    .first()
    .catch(() => null);
  if (!linha) return null;
  let conteudo = { regras: [], resumo: '' };
  try {
    conteudo = JSON.parse(linha.regras || '{}');
  } catch {
    /* receita corrompida vale como ausente */
  }
  let amostra = [];
  try {
    amostra = JSON.parse(linha.amostra || '[]');
  } catch {
    /* idem */
  }
  return {
    regras: Array.isArray(conteudo.regras) ? conteudo.regras : [],
    resumo: conteudo.resumo || '',
    amostra: Array.isArray(amostra) ? amostra : [],
    totalMaterias: Number(linha.total_materias) || 0,
    mediaScore: Number(linha.media_score) || null,
    geradoEm: linha.gerado_em || null,
    ultimoErro: linha.ultimo_erro || null,
  };
}

function receitaVencida(receita) {
  if (!receita?.geradoEm) return true;
  const t = new Date(receita.geradoEm).getTime();
  return !Number.isFinite(t) || Date.now() - t > VALIDADE_MS;
}

/**
 * Receita pronta para usar: devolve a guardada e, se estiver velha, refaz.
 * Refazer em silêncio é de propósito — o dot não pode parar para isso.
 */
async function receitaParaEscrever({ userId, pageId = null }) {
  const guardada = await receitaGuardada({ userId, pageId });
  // Tentativa recente vale mesmo sem regra: "ainda não há matérias
  // suficientes" também é resposta, e `gerar_em` é gravado nesse caso. Sem
  // esta saída, uma página sem histórico pediria análise à IA a CADA matéria
  // escrita, de graça.
  if (guardada && !receitaVencida(guardada)) {
    return guardada.regras.length ? guardada : null;
  }

  const nova = await gerarReceita({ userId, pageId });
  if (nova.ok) return receitaGuardada({ userId, pageId });
  // Receita velha é melhor que nenhuma enquanto a nova não sai.
  return guardada?.regras?.length ? guardada : null;
}

/**
 * O trecho que entra no prompt de quem escreve.
 *
 * Deixa explícito que são regras de FORMA e que nenhuma delas autoriza
 * inventar fato — o resto do projeto aprendeu isso do jeito difícil.
 */
function receitaParaPrompt(receita) {
  if (!receita?.regras?.length) return null;
  return [
    'O QUE FUNCIONA NESTA PÁGINA (aprendido do desempenho real das matérias publicadas):',
    ...receita.regras.map((r) => `- ${r}`),
    'São regras de FORMA (ângulo, título, tamanho, abertura). Não mudam o assunto',
    'da notícia que você recebeu e não autorizam inventar fato nem exagerar o que',
    'a fonte diz. Na dúvida entre seguir a regra e ser fiel à fonte, seja fiel.',
  ].join('\n');
}

module.exports = {
  materiasQueBombaram,
  gerarReceita,
  receitaGuardada,
  receitaParaEscrever,
  receitaParaPrompt,
  receitaVencida,
  lerRegras,
  aberturaDaMateria,
  DIAS_PADRAO,
  MINIMO_MATERIAS,
  VALIDADE_MS,
};
