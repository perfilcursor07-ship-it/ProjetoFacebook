const db = require('../config/db');
const { PLATAFORMAS, ROTULOS, lerConfig } = require('./feedSugeridoConfig');
const { coletarSugeridos, pausaHumana } = require('./feedSugeridoColetor');

/**
 * Feed sugerido → matérias.
 *
 * O editor escolhe as redes (entre as que o admin liberou) e quantos vídeos
 * quer de cada uma. O sistema abre o feed de sugestões da conta dos cookies
 * e pega os N primeiros vídeos que ainda não viraram matéria.
 *
 * - modo "automatico": escreve uma matéria de cada vídeo coletado;
 * - modo "escolher": mostra os vídeos e só escreve os que o editor marcar.
 *
 * Cada matéria passa pelo MESMO fluxo do "Criar matéria" do /materia-manual
 * (transcrição, redator editorial, memória de estilo do editor, rodapé com a
 * fonte), então sai com a mesma qualidade jornalística. Opcionalmente a capa
 * é refeita com o ChatGPT, como no botão "Capa com IA".
 *
 * Um job por vez no servidor: transcrição é pesada e várias coletas em
 * paralelo com a mesma conta é o que faz Instagram/Facebook bloquearem.
 */

const JOBS = 'feed_sugerido_jobs';
const ITENS = 'feed_sugerido_itens';
/** Rodando ou esperando a fila: retomados após reinício do servidor. */
const ATIVOS = ['na_fila', 'coletando', 'processando'];
/** Impedem outra coleta do mesmo editor (inclui a espera pela escolha). */
const EM_ABERTO = [...ATIVOS, 'aguardando_escolha'];
const FINAIS_ITEM = ['pronto', 'ignorado', 'erro'];

const fila = [];
let rodando = false;

function erro(status, mensagem) {
  const e = new Error(mensagem);
  e.status = status;
  return e;
}

function parseJson(valor, padrao) {
  if (valor && typeof valor === 'object') return valor;
  try {
    return JSON.parse(valor || '');
  } catch {
    return padrao;
  }
}

function corta(valor, max) {
  const texto = String(valor ?? '').trim();
  return texto ? texto.slice(0, max) : null;
}

async function resolverModeloDoFeed(pedido) {
  if (!require('./deepseekService').usarTokenFree('conversa')) {
    if (pedido) throw erro(409, 'A seleção de modelos está indisponível. Atualize a página antes de criar as matérias.');
    return null;
  }
  return require('./materiaModelosService').resolverModelo(pedido, { estrito: true });
}

async function atualizarJob(id, dados) {
  await db(JOBS).where({ id }).update({ ...dados, updated_at: db.fn.now() });
}

async function atualizarItem(id, dados) {
  await db(ITENS).where({ id }).update({ ...dados, updated_at: db.fn.now() });
}

async function jobCancelado(id) {
  const job = await db(JOBS).where({ id }).first('status');
  return !job || job.status === 'cancelado';
}

async function encerrarItensAbertos(jobId, etapa) {
  await db(ITENS)
    .where({ job_id: jobId })
    .whereNotIn('status', FINAIS_ITEM)
    .update({ status: 'ignorado', etapa, updated_at: db.fn.now() });
}

// ------------------------------------------------------------------ criação

async function criarJob(userId, entrada = {}) {
  const config = await lerConfig();
  const pedidas = [...new Set((Array.isArray(entrada.plataformas) ? entrada.plataformas : [])
    .map((p) => String(p || '').toLowerCase()))]
    .filter((p) => PLATAFORMAS.includes(p));
  if (!pedidas.length) throw erro(400, 'Marque pelo menos uma rede.');
  const bloqueadas = pedidas.filter((p) => !config.plataformas[p]);
  if (bloqueadas.length) {
    throw erro(403, `O administrador não liberou: ${bloqueadas.map((p) => ROTULOS[p]).join(', ')}.`);
  }

  const quantidade = Math.round(Number(entrada.quantidade) || 10);
  if (quantidade < 1 || quantidade > config.maxPorRede) {
    throw erro(400, `Escolha de 1 a ${config.maxPorRede} vídeos por rede.`);
  }

  const { resolvePageForUser, defaultPageForUser } = require('./facebookPageResolver');
  let page = null;
  if (entrada.facebookPageId) {
    page = await resolvePageForUser(userId, entrada.facebookPageId);
    if (!page) throw erro(400, 'Página do Facebook inválida. Escolha uma das suas páginas em /paginas.');
  } else {
    page = await defaultPageForUser(userId);
  }

  // Uma lista esperando escolha não prende o editor: a nova coleta a substitui.
  const modelo = await resolverModeloDoFeed(entrada.modelo);
  const esperando = await db(JOBS).where({ user_id: userId, status: 'aguardando_escolha' }).select('id');
  for (const { id } of esperando) {
    await atualizarJob(id, { status: 'cancelado', mensagem: 'Substituída por uma nova coleta.', finished_at: db.fn.now() });
    await encerrarItensAbertos(id, 'Não escolhido');
  }
  const ativo = await db(JOBS).where({ user_id: userId }).whereIn('status', ATIVOS).first('id');
  if (ativo) throw erro(409, 'Você já tem uma coleta em andamento. Aguarde terminar ou cancele.');

  const seeds = {};
  for (const rede of pedidas) {
    const link = String(entrada.links?.[rede] || '').trim();
    if (link && /^https?:\/\//i.test(link)) seeds[rede] = link.slice(0, 1000);
  }
  const opcoes = {
    modelo,
    seeds,
    tema: corta(entrada.tema, 120) || config.temaPadrao || '',
    tom: corta(entrada.tom, 30) || 'natural',
    pesquisarWeb: Boolean(entrada.pesquisarWeb),
    modo: entrada.modo === 'escolher' ? 'escolher' : 'automatico',
    imagemChatgpt: Boolean(entrada.imagemChatgpt),
    escolhaFeita: false,
  };

  const [id] = await db(JOBS).insert({
    user_id: userId,
    facebook_page_id: page?.id || null,
    plataformas: pedidas.join(','),
    quantidade,
    opcoes: JSON.stringify(opcoes),
    status: 'na_fila',
    mensagem: 'Na fila para começar…',
  });
  enfileirar(id);
  return obterJob(userId, id);
}

/**
 * O editor marcou quais vídeos viram matéria: na lista de escolha ou, depois
 * de a coleta terminar, entre os que falharam/não foram escolhidos (refazer).
 */
async function escolherItens(userId, jobId, itemIds = [], { modelo } = {}) {
  const job = await db(JOBS).where({ id: jobId, user_id: userId }).first();
  if (!job) throw erro(404, 'Coleta não encontrada.');
  const aguardando = job.status === 'aguardando_escolha';
  const finalizada = ['concluido', 'erro', 'cancelado'].includes(job.status);
  if (!aguardando && !finalizada) throw erro(409, 'Espere esta coleta terminar para escolher outros vídeos.');
  if (finalizada) {
    const ativo = await db(JOBS).where({ user_id: userId }).whereIn('status', ATIVOS).first('id');
    if (ativo) throw erro(409, 'Você já tem uma coleta em andamento. Aguarde terminar ou cancele.');
  }
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(Number).filter(Boolean))];
  if (!ids.length) throw erro(400, 'Marque pelo menos um vídeo.');

  const escolhidos = await db(ITENS)
    .where({ job_id: jobId })
    .whereIn('status', aguardando ? ['pendente'] : ['ignorado', 'erro'])
    .whereIn('id', ids)
    .select('id');
  if (!escolhidos.length) throw erro(400, 'Os vídeos marcados não podem ser escritos nesta coleta.');
  const idsEscolhidos = escolhidos.map((i) => i.id);
  const opcoes = { ...parseJson(job.opcoes, {}), escolhaFeita: true };
  opcoes.modelo = await resolverModeloDoFeed(modelo ?? opcoes.modelo);

  if (aguardando) {
    await db(ITENS)
      .where({ job_id: jobId, status: 'pendente' })
      .whereNotIn('id', idsEscolhidos)
      .update({ status: 'ignorado', etapa: 'Não escolhido', updated_at: db.fn.now() });
  }
  await db(ITENS)
    .whereIn('id', idsEscolhidos)
    .update({ status: 'pendente', etapa: null, erro: null, updated_at: db.fn.now() });

  await atualizarJob(jobId, {
    status: 'na_fila',
    opcoes: JSON.stringify(opcoes),
    total: escolhidos.length,
    concluidos: 0,
    falhas: 0,
    finished_at: null,
    mensagem: `${escolhidos.length} vídeo(s) escolhido(s). Na fila para escrever…`,
  });
  enfileirar(jobId);
  return obterJob(userId, jobId);
}

// --------------------------------------------------------------- consultas

function formatarJob(job, itens = null) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    plataformas: String(job.plataformas || '').split(',').filter(Boolean),
    quantidade: job.quantidade,
    facebook_page_id: job.facebook_page_id,
    total: job.total,
    concluidos: job.concluidos,
    falhas: job.falhas,
    mensagem: job.mensagem,
    opcoes: parseJson(job.opcoes, {}),
    coleta: parseJson(job.coleta, {}),
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    ...(itens ? { itens } : {}),
  };
}

async function obterJob(userId, id) {
  const job = await db(JOBS).where({ id, user_id: userId }).first();
  if (!job) throw erro(404, 'Coleta não encontrada.');
  const itens = await db(ITENS)
    .leftJoin('ai_matters', 'ai_matters.id', `${ITENS}.matter_id`)
    .where(`${ITENS}.job_id`, id)
    .orderBy(`${ITENS}.id`, 'asc')
    .select(
      `${ITENS}.id`,
      `${ITENS}.plataforma`,
      `${ITENS}.url`,
      `${ITENS}.titulo`,
      `${ITENS}.autor`,
      `${ITENS}.thumbnail`,
      `${ITENS}.status`,
      `${ITENS}.etapa`,
      `${ITENS}.erro`,
      `${ITENS}.matter_id`,
      'ai_matters.titulo as materia_titulo'
    );
  return formatarJob(job, itens);
}

async function listarJobs(userId, limite = 8) {
  const jobs = await db(JOBS).where({ user_id: userId }).orderBy('id', 'desc').limit(limite);
  return jobs.map((job) => formatarJob(job));
}

async function cancelarJob(userId, id) {
  const job = await db(JOBS).where({ id, user_id: userId }).first();
  if (!job) throw erro(404, 'Coleta não encontrada.');
  if (!EM_ABERTO.includes(job.status)) return obterJob(userId, id);
  await atualizarJob(id, { status: 'cancelado', mensagem: 'Cancelado pelo editor.', finished_at: db.fn.now() });
  await encerrarItensAbertos(id, 'Cancelado');
  const idx = fila.indexOf(Number(id));
  if (idx >= 0) fila.splice(idx, 1);
  return obterJob(userId, id);
}

// --------------------------------------------------------------- execução

function enfileirar(id) {
  const numero = Number(id);
  if (!fila.includes(numero)) fila.push(numero);
  void drenarFila();
}

async function drenarFila() {
  if (rodando) return;
  rodando = true;
  try {
    while (fila.length) {
      const id = fila.shift();
      try {
        await executarJob(id);
      } catch (err) {
        console.error(`[feed-sugerido] job ${id}:`, err.message);
        await atualizarJob(id, {
          status: 'erro',
          mensagem: corta(err.message, 500),
          finished_at: db.fn.now(),
        }).catch(() => {});
      }
    }
  } finally {
    rodando = false;
  }
}

/** Externos que este usuário já transformou (ou vai transformar) em matéria. */
async function jaAproveitados(userId, plataforma) {
  const linhas = await db(ITENS)
    .where({ user_id: userId, plataforma })
    .whereIn('status', ['pronto', 'escrevendo', 'transcrevendo', 'lendo', 'pendente'])
    .select('external_id');
  return new Set(linhas.map((l) => String(l.external_id)));
}

async function coletar(job, opcoes) {
  const plataformas = String(job.plataformas).split(',').filter(Boolean);
  const coleta = {};
  let total = 0;
  for (const rede of plataformas) {
    if (await jobCancelado(job.id)) return;
    await atualizarJob(job.id, { mensagem: `Abrindo as sugestões do ${ROTULOS[rede]}…` });
    const usados = await jaAproveitados(job.user_id, rede);
    // Pede folga para compensar vídeos que já viraram matéria antes.
    const pedir = Math.min(50, job.quantidade + Math.min(usados.size, job.quantidade) + 3);
    const resultado = await coletarSugeridos(rede, {
      quantidade: pedir,
      seedUrl: opcoes.seeds?.[rede] || '',
      tema: opcoes.tema || '',
    });
    const ineditos = resultado.itens.filter((item) => !usados.has(String(item.externalId)));
    const novos = ineditos.slice(0, job.quantidade);
    coleta[rede] = {
      encontrados: resultado.itens.length,
      novos: novos.length,
      repetidos: resultado.itens.length - ineditos.length,
      origem: resultado.origem,
      motivo: resultado.motivo,
      // Últimos passos (só caminho e status HTTP) para diagnosticar bloqueios.
      passos: resultado.motivo ? (resultado.trace || []).slice(-6) : [],
    };
    console.info(
      `[feed-sugerido] job ${job.id} ${rede}: ${resultado.itens.length} encontrados, ${novos.length} novos` +
        (resultado.motivo ? ` — ${resultado.motivo}` : '')
    );
    if (novos.length) {
      await db(ITENS).insert(
        novos.map((item) => ({
          job_id: job.id,
          user_id: job.user_id,
          plataforma: rede,
          external_id: String(item.externalId).slice(0, 64),
          url: String(item.url).slice(0, 1000),
          titulo: corta(item.titulo, 500),
          autor: corta(item.autor, 160),
          thumbnail: item.thumbnail || null,
          status: 'pendente',
          etapa: null,
        }))
      );
    }
    total += novos.length;
  }
  await atualizarJob(job.id, { coleta: JSON.stringify(coleta), total });
}

async function executarJob(id) {
  let job = await db(JOBS).where({ id }).first();
  if (!job || !ATIVOS.includes(job.status)) return;
  const opcoes = parseJson(job.opcoes, {});

  // Também fixa o padrão uma única vez para coletas antigas sem modelo salvo.
  if (!opcoes.modelo) {
    opcoes.modelo = await resolverModeloDoFeed(null);
    await atualizarJob(id, { opcoes: JSON.stringify(opcoes) });
  }

  const jaTemItens = await db(ITENS).where({ job_id: id }).first('id');
  if (!jaTemItens) {
    await atualizarJob(id, { status: 'coletando', started_at: db.fn.now() });
    await coletar(job, opcoes);
    job = await db(JOBS).where({ id }).first();
    if (!job || job.status === 'cancelado') return;
  }

  const totalGeral = await db(ITENS).where({ job_id: id }).count({ n: '*' }).first();
  if (!Number(totalGeral?.n)) {
    const coleta = parseJson(job.coleta, {});
    const motivos = Object.entries(coleta)
      .map(([rede, c]) => (c.motivo ? `${ROTULOS[rede]}: ${c.motivo}` : c.repetidos ? `${ROTULOS[rede]}: só vídeos já aproveitados` : null))
      .filter(Boolean);
    await atualizarJob(id, {
      status: 'erro',
      mensagem: corta(`Nenhum vídeo novo encontrado. ${motivos.join(' | ')}`, 500),
      finished_at: db.fn.now(),
    });
    return;
  }

  // Modo "escolher": para aqui até o editor marcar os vídeos no painel.
  if (opcoes.modo === 'escolher' && !opcoes.escolhaFeita) {
    await atualizarJob(id, {
      status: 'aguardando_escolha',
      mensagem: 'Escolha quais vídeos devem virar matéria.',
    });
    return;
  }

  const pendentes = await db(ITENS).where({ job_id: id, status: 'pendente' }).orderBy('id', 'asc');
  await atualizarJob(id, { status: 'processando' });
  for (let i = 0; i < pendentes.length; i += 1) {
    if (await jobCancelado(id)) return;
    const item = pendentes[i];
    await atualizarJob(id, {
      mensagem: `Vídeo ${i + 1} de ${pendentes.length} (${ROTULOS[item.plataforma]})…`,
    });
    let ok = false;
    try {
      ok = await processarItem(job, opcoes, item);
    } catch (err) {
      console.warn(`[feed-sugerido] item ${item.id} (${item.url}):`, err.message);
      await atualizarItem(item.id, { status: 'erro', etapa: null, erro: corta(err.message, 500) });
    }
    await db(JOBS)
      .where({ id })
      .increment(ok ? 'concluidos' : 'falhas', 1);
    // Um respiro entre vídeos da Meta evita parecer robô.
    if (i < pendentes.length - 1 && item.plataforma !== 'youtube') await pausaHumana(3000, 7000);
  }

  if (await jobCancelado(id)) return;
  const final = await db(JOBS).where({ id }).first();
  await atualizarJob(id, {
    status: 'concluido',
    mensagem: `${final.concluidos} matéria(s) criada(s)${final.falhas ? `, ${final.falhas} vídeo(s) sem matéria` : ''}.`,
    finished_at: db.fn.now(),
  });
}

/** @returns {Promise<boolean>} true quando a matéria foi criada. */
async function processarItem(job, opcoes, item) {
  const { escreverPeloChat, aplicarCapaChatgpt } = require('./materiaPorChat');
  const chatService = require('./materiaChatService');
  const { comModelo } = require('./tokenFreeGatewayService');

  await atualizarItem(item.id, { status: 'transcrevendo', etapa: 'Lendo o vídeo e transcrevendo…', erro: null });

  // O lote conserva a escolha mesmo após reinício ou mudança do padrão global.
  const modelo = await resolverModeloDoFeed(opcoes.modelo);

  let ultimaEtapa = 0;
  const { matterId, chatId } = await escreverPeloChat({ chatService, comModelo }, {
    userId: job.user_id,
    url: item.url,
    facebookPageId: job.facebook_page_id || null,
    imagemUrl: item.thumbnail,
    modelo,
    tom: opcoes.tom,
    pesquisarWeb: opcoes.pesquisarWeb,
    origem: 'feed',
    onPasso: (texto) => {
      // Mostra no painel o passo atual do chat (transcrição, escrita…).
      if (Date.now() - ultimaEtapa < 1500) return;
      ultimaEtapa = Date.now();
      atualizarItem(item.id, {
        status: /escrev|redig|revis/i.test(texto) ? 'escrevendo' : 'transcrevendo',
        etapa: corta(texto, 255),
      }).catch(() => {});
    },
  });

  // A conversa fica no chat para o editor pedir ajustes, com nome reconhecível.
  const AiMatters = require('../models/AiMatters');
  const matter = matterId ? await AiMatters.findById(matterId) : null;
  try {
    const tituloLimpo = String(matter?.titulo || item.titulo || '').replace(/\[\[|\]\]|\*\*/g, '').trim();
    await chatService.renomearConversa({
      userId: job.user_id,
      chatId,
      titulo: `Feed ${ROTULOS[item.plataforma]} · ${tituloLimpo}`.slice(0, 180),
    });
  } catch {
    // nome da conversa é só conveniência
  }

  let aviso = null;
  if (matterId && opcoes.imagemChatgpt) {
    await atualizarItem(item.id, { status: 'escrevendo', etapa: 'Gerando a capa com o ChatGPT…', matter_id: matterId });
    try {
      await aplicarCapaChatgpt({ userId: job.user_id, matterId, thumbnail: item.thumbnail });
    } catch (err) {
      console.warn(`[feed-sugerido] capa ChatGPT matéria ${matterId}:`, err.message);
      aviso = `Matéria criada com a foto original; a capa do ChatGPT falhou: ${err.message}`;
    }
  }

  await atualizarItem(item.id, {
    status: 'pronto',
    etapa: null,
    erro: corta(aviso, 500),
    matter_id: matterId,
    titulo: corta(item.titulo || matter?.titulo, 500),
  });
  return Boolean(matterId);
}

/**
 * No boot: retoma o que ficou na fila e fecha os vídeos que estavam no meio
 * do caminho (repetir poderia duplicar a matéria).
 */
async function retomarAposReinicio() {
  let jobs = [];
  try {
    jobs = await db(JOBS).whereIn('status', ATIVOS).orderBy('id', 'asc');
  } catch (err) {
    if (/doesn't exist|no such table/i.test(String(err.message))) return;
    throw err;
  }
  for (const job of jobs) {
    await db(ITENS)
      .where({ job_id: job.id })
      .whereIn('status', ['lendo', 'transcrevendo', 'escrevendo'])
      .update({ status: 'erro', etapa: null, erro: 'Interrompido pelo reinício do servidor.', updated_at: db.fn.now() });
    enfileirar(job.id);
  }
  if (jobs.length) console.info(`[feed-sugerido] ${jobs.length} coleta(s) retomada(s) após reinício`);
}

module.exports = {
  criarJob,
  escolherItens,
  obterJob,
  listarJobs,
  cancelarJob,
  retomarAposReinicio,
};
