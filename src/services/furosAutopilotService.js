const crypto = require('crypto');
const db = require('../config/db');

/**
 * Piloto automático do Furos do dia.
 *
 * Com "Automatizar" ligado, sem o editor escolher nada:
 *   1. a cada 5 min varre as fontes (nichos + Notícias/YouTube/Instagram/Facebook);
 *   2. a IA avalia as pautas novas e só as melhores entram na fila;
 *   3. escreve a matéria pelo mesmo caminho do chat do /materia-manual e com
 *      o modelo escolhido lá (notícia ilegível cai no redator de furos);
 *   4. gera a imagem com IA (ChatGPT), no máximo 2 ao mesmo tempo no servidor;
 *   5. AGENDA a matéria pronta no agendador do sistema, uma a cada N minutos
 *      (fica "Agendado" em Matérias salvas), e ele publica na hora marcada.
 *
 * As etapas andam em paralelo: enquanto uma imagem é gerada (a parte lenta),
 * a próxima matéria já está sendo escrita. Nada é publicado sem imagem.
 */

const CONFIG = 'furos_autopilot';
const ITENS = 'furos_autopilot_itens';

const TICK_MS = 30_000;
const SCAN_MS = 5 * 60_000;
/** Limite de gerações de imagem simultâneas no servidor (conta do ChatGPT). */
const MAX_IMAGENS = 2;
/** Matérias escritas à frente da publicação (escritas + em imagem + prontas). */
const BUFFER_ALVO = 3;
const MAX_FILA = 10;
/** Com isso esperando na fila, a varredura seguinte é pulada. */
const FILA_SUFICIENTE = 4;
/** Aprovação normal: potencial da IA OU nota combinada (Furos + IA). */
const NOTA_MINIMA_IA = 30;
const NOTA_COMBINADA_MINIMA = 40;
/** Sem nada no caminho: as melhores entram se a IA não as zerou. */
const NOTA_MINIMA_FOME = 15;
const TENTATIVAS_IMAGEM = 2;
const LIMITE_ESCRITA_MS = 15 * 60_000;
const FILA_VELHA_MS = 8 * 3_600_000;
const PRONTA_VELHA_MS = 24 * 3_600_000;
const INTERVALOS = [5, 10, 15, 20, 30, 60];
const EM_ANDAMENTO = ['escrevendo', 'aguardando_imagem', 'gerando_imagem', 'pronta'];

const escaneando = new Set();
const escrevendo = new Set();
const publicando = new Set();
let imagensAtivas = 0;
let tickRodando = false;
let timer = null;

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

function comLimite(promise, ms, mensagem) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(mensagem)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/** Meia-noite de Brasília (UTC-3), para o limite diário. */
function inicioDoDia() {
  const br = new Date(Date.now() - 3 * 3_600_000);
  br.setUTCHours(0, 0, 0, 0);
  return new Date(br.getTime() + 3 * 3_600_000);
}

/** Mesma pauta vinda de novo (outra varredura, outro canal) tem a mesma chave. */
function chaveDaPauta(pauta) {
  let base = String(pauta.externalId ? `${pauta.canal}:${pauta.externalId}` : pauta.url || '').trim();
  if (!pauta.externalId) {
    try {
      const u = new URL(base);
      if (!/news\.google\.com/i.test(u.host)) u.search = '';
      u.hash = '';
      base = u.toString().replace(/\/$/, '').toLowerCase();
    } catch {
      base = base.toLowerCase();
    }
  }
  return crypto.createHash('sha1').update(base).digest('hex');
}

async function atualizarItem(id, dados) {
  await db(ITENS).where({ id }).update({ ...dados, updated_at: db.fn.now() });
  if (AVISAR_NO_CELULAR.has(dados.status)) avisarNoCelular(id);
}

/**
 * Atualiza só se o item ainda estiver no status esperado. Se o editor
 * cancelou a fila no meio da escrita/imagem, o resultado não o "ressuscita".
 */
async function atualizarSeAinda(id, statusAtual, dados) {
  const alteradas = await db(ITENS).where({ id, status: statusAtual }).update({ ...dados, updated_at: db.fn.now() });
  if (alteradas && AVISAR_NO_CELULAR.has(dados.status)) avisarNoCelular(id);
  return alteradas;
}

// ------------------------------------------------------------ aviso no ntfy

/**
 * Só o que falha ANTES de publicar (escrita, imagem, matéria apagada). Publicada
 * e falha no envio ao Facebook são avisadas para toda matéria, pelo gancho em
 * AiMatters.update (services/avisoPublicacao.js) — aqui duplicaria.
 */
const AVISAR_NO_CELULAR = new Set(['erro']);

/** Não segura o piloto: o aviso sai em segundo plano e falha em silêncio. */
function avisarNoCelular(itemId) {
  setImmediate(() => {
    enviarAviso(itemId).catch((err) => console.warn(`[furos-auto] ntfy item ${itemId}:`, err.message));
  });
}

async function nomeDaPagina(pageId) {
  if (!pageId) return null;
  const page = await db('facebook_pages').where({ id: pageId }).first('page_name').catch(() => null);
  return page?.page_name || null;
}

async function enviarAviso(itemId) {
  const item = await db(ITENS).where({ id: itemId }).first();
  if (!item || !AVISAR_NO_CELULAR.has(item.status)) return;
  if (/^Publicação:/.test(String(item.erro || ''))) return; // já avisado pela matéria
  const cfg = await db(CONFIG).where({ user_id: item.user_id }).first();
  if (!cfg?.ntfy_topico) return;
  const publicada = item.status === 'publicada';
  if (publicada ? cfg.ntfy_publicada === false || cfg.ntfy_publicada === 0 : cfg.ntfy_falha === false || cfg.ntfy_falha === 0) return;

  const matter = item.matter_id
    ? await require('../models/AiMatters').findById(item.matter_id).catch(() => null)
    : null;
  const pagina = await nomeDaPagina(matter?.facebook_page_id || cfg.facebook_page_id);
  const titulo = tituloLimpo(matter?.titulo || item.titulo) || 'Matéria sem título';
  const base = String(require('../config/env').appPublicUrl || '').replace(/\/$/, '');
  await require('./ntfyService').enviar({
    servidor: cfg.ntfy_servidor,
    topico: cfg.ntfy_topico,
    token: cfg.ntfy_token,
    titulo: `${publicada ? 'Publicada' : 'Não publicada'}${pagina ? ` · ${pagina}` : ''}`,
    mensagem: publicada ? titulo : `${titulo}\n\nMotivo: ${item.erro || 'falha sem detalhe.'}`,
    tags: publicada ? ['white_check_mark'] : ['x'],
    prioridade: publicada ? 3 : 4,
    clique: base && item.matter_id ? `${base}/materias-ia/${item.matter_id}` : null,
  });
}

/** Escolhidas pelo editor passam na frente; depois, pela nota. */
const ORDEM_FILA = "CASE WHEN origem = 'manual' THEN 0 ELSE 1 END, COALESCE(nota_ia, score) DESC, id ASC";

/**
 * Com o Automatizar desligado (pausado), só anda o que o editor escolheu no
 * Furos do dia; as escolhidas pela IA esperam ele retomar.
 */
function soQuandoPermitido(query, row) {
  return row.ativo ? query : query.where({ origem: 'manual' });
}

async function atualizarConfig(userId, dados) {
  await db(CONFIG).where({ user_id: userId }).update({ ...dados, updated_at: db.fn.now() });
}

// -------------------------------------------------------------- configuração

function formatarConfig(row) {
  return {
    existe: Boolean(row),
    ativo: Boolean(row?.ativo),
    pausado_at: row?.pausado_at || null,
    nichos: parseJson(row?.nichos, ['auto']),
    palavras: parseJson(row?.palavras, []),
    agenda: require('./pilotoAgenda').lerAgenda(row?.agenda),
    canais: parseJson(row?.canais, ['noticias', 'youtube', 'instagram', 'facebook']),
    horas: Number(row?.horas) || 24,
    intervalo_minutos: Number(row?.intervalo_minutos) || 10,
    limite_dia: Number(row?.limite_dia) || 40,
    facebook_page_id: row?.facebook_page_id || null,
    modelo: row?.modelo || null,
    foto_original_se_falhar: row ? Boolean(row.foto_original_se_falhar) : true,
    modo_imagem: row?.modo_imagem === 'original' ? 'original' : 'ia',
    ultimo_scan_at: row?.ultimo_scan_at || null,
    proxima_postagem_at: row?.proxima_postagem_at || null,
    ultimo_erro: row?.ultimo_erro || null,
    ultimo_scan_resumo: row?.ultimo_scan_resumo || null,
    ntfy: {
      topico: row?.ntfy_topico || null,
      servidor: row?.ntfy_servidor || null,
      token_definido: Boolean(row?.ntfy_token),
      publicada: row ? row.ntfy_publicada !== false && row.ntfy_publicada !== 0 : true,
      falha: row ? row.ntfy_falha !== false && row.ntfy_falha !== 0 : true,
    },
  };
}

/**
 * Notificações no app ntfy. Tópico vazio desliga. O token só é trocado
 * quando vem preenchido (ou removido com `remover_token`).
 */
async function salvarNtfy(userId, entrada = {}) {
  const ntfy = require('./ntfyService');
  const topico = ntfy.normalizarTopico(entrada.topico);
  const servidorDigitado = String(entrada.servidor || '').trim();
  const servidor = servidorDigitado ? ntfy.normalizarServidor(servidorDigitado) : null;
  const dados = {
    ntfy_topico: topico,
    ntfy_servidor: servidor && servidor !== ntfy.SERVIDOR_PADRAO ? servidor : null,
    ntfy_publicada: entrada.publicada !== false,
    ntfy_falha: entrada.falha !== false,
  };
  const token = String(entrada.token || '').trim();
  if (token) dados.ntfy_token = corta(token, 255);
  else if (entrada.remover_token || !topico) dados.ntfy_token = null;

  const atual = await db(CONFIG).where({ user_id: userId }).first('id');
  if (atual) await atualizarConfig(userId, dados);
  else {
    await db(CONFIG).insert({
      user_id: userId,
      ativo: false,
      nichos: JSON.stringify(['auto']),
      canais: JSON.stringify(require('./furosService').CANAIS),
      ...dados,
    });
  }
  return statusPainel(userId);
}

/** Manda uma notificação de teste para o tópico salvo. */
async function testarNtfy(userId) {
  const cfg = await db(CONFIG).where({ user_id: userId }).first();
  if (!cfg?.ntfy_topico) throw erro(400, 'Salve um tópico do ntfy antes de testar.');
  await require('./ntfyService').enviar({
    servidor: cfg.ntfy_servidor,
    topico: cfg.ntfy_topico,
    token: cfg.ntfy_token,
    titulo: 'ViralizeAI · teste',
    mensagem: 'Notificações do piloto automático funcionando. Você vai receber aqui as matérias publicadas e as que não forem publicadas.',
    tags: ['bell'],
  });
  return statusPainel(userId);
}

async function registrarResumo(userId, texto) {
  await atualizarConfig(userId, { ultimo_scan_resumo: corta(texto, 500) }).catch(() => {});
}

async function salvarConfig(userId, entrada = {}) {
  const furosService = require('./furosService');
  const idsNichos = new Set(['auto', ...furosService.NICHOS.map((n) => n.id)]);
  const nichos = [...new Set((Array.isArray(entrada.nichos) ? entrada.nichos : []).map(String))]
    .filter((n) => idsNichos.has(n))
    .slice(0, 4);
  const canais = [...new Set((Array.isArray(entrada.canais) ? entrada.canais : []).map(String))]
    .filter((c) => furosService.CANAIS.includes(c));
  const palavras = furosService.palavrasValidas(entrada.palavras);
  // Sem o campo (tela antiga em cache), a agenda salva continua valendo.
  const agenda = entrada.agenda === undefined ? undefined : require('./pilotoAgenda').normalizarAgenda(entrada.agenda);
  const intervalo = Number(entrada.intervalo_minutos);
  if (!INTERVALOS.includes(intervalo)) throw erro(400, `Escolha um intervalo de ${INTERVALOS.join(', ')} minutos.`);
  const limiteDia = Math.round(Number(entrada.limite_dia) || 40);
  if (limiteDia < 1 || limiteDia > 200) throw erro(400, 'O limite por dia deve ficar entre 1 e 200 publicações.');
  const horas = furosService.JANELAS_HORAS.includes(Number(entrada.horas)) ? Number(entrada.horas) : 24;

  const { resolvePageForUser, defaultPageForUser } = require('./facebookPageResolver');
  const page = entrada.facebook_page_id
    ? await resolvePageForUser(userId, entrada.facebook_page_id)
    : await defaultPageForUser(userId);
  const ativo = Boolean(entrada.ativo);
  if (ativo && !page) throw erro(400, 'Escolha a página do Facebook onde o piloto vai publicar (ou defina uma padrão em /paginas).');

  const atual = await db(CONFIG).where({ user_id: userId }).first();
  const dados = {
    ativo,
    nichos: JSON.stringify(nichos.length ? nichos : ['auto']),
    palavras: JSON.stringify(palavras),
    ...(agenda ? { agenda: JSON.stringify(agenda) } : {}),
    canais: JSON.stringify(canais.length ? canais : furosService.CANAIS),
    horas,
    intervalo_minutos: intervalo,
    limite_dia: limiteDia,
    facebook_page_id: page?.id || null,
    // O seletor de modelo vive no chat; a página do Furos não o tem. Sem o
    // campo, manter o que já está salvo em vez de apagar.
    ...(entrada.modelo === undefined || entrada.modelo === null
      ? {}
      : { modelo: corta(entrada.modelo, 120) }),
    foto_original_se_falhar: entrada.foto_original_se_falhar !== false,
    modo_imagem: entrada.modo_imagem === 'original' ? 'original' : 'ia',
    ultimo_erro: null,
  };
  // Ao ligar: varre já e publica a primeira assim que ficar pronta.
  if (ativo && !atual?.ativo) {
    dados.ultimo_scan_at = null;
    dados.proxima_postagem_at = new Date();
    dados.pausado_at = null;
  }
  if (!ativo && atual?.ativo) dados.pausado_at = new Date();
  if (atual) await atualizarConfig(userId, dados);
  else await db(CONFIG).insert({ user_id: userId, ...dados });
  if (ativo) setImmediate(() => void tick());
  return statusPainel(userId);
}

/** Painel: só olha os últimos dias (a tabela cresce a cada varredura). */
const JANELA_PAINEL_MS = 3 * 24 * 3_600_000;

async function statusPainel(userId) {
  const inicio = Date.now();
  const recente = new Date(Date.now() - JANELA_PAINEL_MS);
  const tabelaAusente = (err) => {
    if (/doesn't exist|no such table/i.test(String(err.message))) return null;
    throw err;
  };

  // Tudo em paralelo: antes eram 6 consultas uma depois da outra.
  const [row, linhas, hoje, itens, foraDaFila, manual] = await Promise.all([
    db(CONFIG).where({ user_id: userId }).first(),
    db(ITENS)
      .where({ user_id: userId })
      .whereIn('status', ['na_fila', ...EM_ANDAMENTO, 'agendada', 'publicando'])
      .groupBy('status')
      .select('status')
      .count({ n: '*' })
      .catch(tabelaAusente),
    db(ITENS)
      .where({ user_id: userId, status: 'publicada' })
      .where('publicado_at', '>=', inicioDoDia())
      .count({ n: '*' })
      .first()
      .catch(tabelaAusente),
    db(`${ITENS} as i`)
      .leftJoin('ai_matters as m', 'm.id', 'i.matter_id')
      .where('i.user_id', userId)
      .whereIn('i.status', ['na_fila', ...EM_ANDAMENTO, 'agendada', 'publicando', 'publicada', 'erro'])
      .where('i.updated_at', '>=', recente)
      .orderBy('i.updated_at', 'desc')
      .limit(30)
      .select(
        'i.id', 'i.origem', 'i.canal', 'i.titulo', 'i.url', 'i.status', 'i.nota_ia', 'i.score', 'i.motivo',
        'i.erro', 'i.matter_id', 'i.imagem_ia', 'i.publicado_at', 'i.agendado_para', 'i.updated_at',
        'm.titulo as materia_titulo'
      )
      .catch(tabelaAusente),
    // O que a IA deixou de fora nas últimas 24h, com a nota e o motivo.
    db(ITENS)
      .where({ user_id: userId, status: 'descartada' })
      .where('updated_at', '>=', new Date(Date.now() - 24 * 3_600_000))
      .orderBy('updated_at', 'desc')
      .limit(15)
      .select('id', 'canal', 'titulo', 'url', 'nota_ia', 'motivo', 'erro', 'updated_at')
      .catch(tabelaAusente),
    // Escolhidas pelo editor ainda a caminho (andam mesmo com o piloto pausado).
    db(ITENS)
      .where({ user_id: userId, origem: 'manual' })
      .whereIn('status', ['na_fila', ...EM_ANDAMENTO, 'agendada', 'publicando'])
      .count({ n: '*' })
      .first()
      .catch(tabelaAusente),
  ]);

  const config = formatarConfig(row);
  let modeloNome = 'redator padrão do sistema';
  try {
    const modeloEfetivo = await modeloDoPiloto(row || {});
    if (modeloEfetivo) modeloNome = require('./materiaModelosService').nomeModeloHumano(modeloEfetivo);
  } catch {
    // mantém o rótulo padrão
  }
  const ms = Date.now() - inicio;
  if (ms > 1000) console.warn(`[furos-auto] painel do user ${userId} levou ${ms} ms`);

  const proximoScan = config.ultimo_scan_at ? new Date(new Date(config.ultimo_scan_at).getTime() + SCAN_MS) : null;
  const pilotoAgenda = require('./pilotoAgenda');
  const situacaoAgenda = pilotoAgenda.situacao(config.agenda);
  return {
    config,
    agenda: { ...situacaoAgenda, frase: pilotoAgenda.frase(situacaoAgenda) },
    contagens: Object.fromEntries((linhas || []).map((l) => [l.status, Number(l.n)])),
    publicadasHoje: Number(hoje?.n) || 0,
    proximoScan,
    escaneandoAgora: escaneando.has(Number(userId)),
    maxImagens: MAX_IMAGENS,
    filaManual: Number(manual?.n) || 0,
    modeloNome,
    itens: itens || [],
    foraDaFila: foraDaFila || [],
  };
}

/**
 * Pausa sem apagar nada: configuração e fila ficam. O que já estava sendo
 * escrito ou gerando imagem termina, mas nada é publicado até retomar.
 */
async function pausar(userId) {
  const row = await db(CONFIG).where({ user_id: userId }).first();
  if (!row) throw erro(400, 'O piloto automático ainda não foi configurado.');
  if (row.ativo) await atualizarConfig(userId, { ativo: false, pausado_at: new Date() });
  const agendadas = await db(ITENS).where({ user_id: userId, status: 'agendada', origem: 'auto' });
  for (const item of agendadas) {
    if (await desagendar(item, 'Piloto pausado pelo editor.')) {
      await atualizarItem(item.id, { status: 'pronta', agendado_para: null });
    }
  }
  if (agendadas.length) await atualizarConfig(userId, { proxima_postagem_at: null });
  return statusPainel(userId);
}

/** Retoma com a configuração salva: varre na hora e publica a próxima pronta. */
async function retomar(userId) {
  const row = await db(CONFIG).where({ user_id: userId }).first();
  if (!row) throw erro(400, 'Configure o piloto automático no Furos do dia antes de ligar.');
  const { resolvePageForUser, defaultPageForUser } = require('./facebookPageResolver');
  const page = row.facebook_page_id
    ? await resolvePageForUser(userId, row.facebook_page_id)
    : await defaultPageForUser(userId);
  if (!page) throw erro(400, 'A página do piloto não está mais disponível. Escolha outra no Furos do dia.');
  if (!row.ativo) {
    const proxima = row.proxima_postagem_at ? new Date(row.proxima_postagem_at) : null;
    await atualizarConfig(userId, {
      ativo: true,
      pausado_at: null,
      facebook_page_id: page.id,
      ultimo_scan_at: null,
      ultimo_erro: null,
      proxima_postagem_at: proxima && proxima > new Date() ? proxima : new Date(),
    });
    setImmediate(() => void tick());
  }
  return statusPainel(userId);
}

/** O editor trocou o modelo no chat do /materia-manual: o piloto acompanha. */
async function salvarModelo(userId, modelo) {
  const row = await db(CONFIG).where({ user_id: userId }).first();
  if (!row) throw erro(400, 'O piloto automático ainda não foi configurado.');
  let final = corta(modelo, 120);
  if (final && require('./deepseekService').usarTokenFree('conversa')) {
    final = await require('./materiaModelosService').resolverModelo(final, { estrito: true });
  }
  await atualizarConfig(userId, { modelo: final });
  return statusPainel(userId);
}

const MAX_ESCOLHIDAS = 20;

/**
 * Pautas marcadas no Furos do dia: entram na fila para escrever, gerar a
 * imagem com IA e publicar uma a cada `intervalo_minutos`, mesmo com o
 * Automatizar desligado.
 */
async function enfileirarEscolhidas(userId, entrada = {}) {
  const pautas = (Array.isArray(entrada.pautas) ? entrada.pautas : [])
    .filter((p) => p && /^https?:\/\//i.test(String(p.url || '')) && p.titulo)
    .slice(0, MAX_ESCOLHIDAS);
  if (!pautas.length) throw erro(400, 'Marque pelo menos uma pauta.');
  const intervalo = Number(entrada.intervalo_minutos);
  if (!INTERVALOS.includes(intervalo)) throw erro(400, `Escolha um intervalo de ${INTERVALOS.join(', ')} minutos.`);

  const { resolvePageForUser, defaultPageForUser } = require('./facebookPageResolver');
  const page = entrada.facebook_page_id
    ? await resolvePageForUser(userId, entrada.facebook_page_id)
    : await defaultPageForUser(userId);
  if (!page) throw erro(400, 'Escolha a página do Facebook onde as matérias vão ser publicadas (ou defina uma padrão em /paginas).');

  let modelo = corta(entrada.modelo, 120);
  if (modelo && require('./deepseekService').usarTokenFree('conversa')) {
    modelo = await require('./materiaModelosService').resolverModelo(modelo, { estrito: true });
  }

  const atual = await db(CONFIG).where({ user_id: userId }).first();
  const proxima = atual?.proxima_postagem_at ? new Date(atual.proxima_postagem_at) : null;
  const dados = {
    intervalo_minutos: intervalo,
    facebook_page_id: page.id,
    ...(modelo ? { modelo } : {}),
    foto_original_se_falhar: entrada.foto_original_se_falhar !== false,
    ...(entrada.modo_imagem ? { modo_imagem: entrada.modo_imagem === 'original' ? 'original' : 'ia' } : {}),
    // A primeira sai assim que ficar pronta (sem esperar um intervalo inteiro).
    proxima_postagem_at: proxima && proxima > new Date() ? proxima : new Date(),
  };
  if (atual) await atualizarConfig(userId, dados);
  else await db(CONFIG).insert({ user_id: userId, ativo: false, ...dados });

  const adicionadas = [];
  const ignoradas = [];
  for (const pauta of pautas) {
    const chave = chaveDaPauta(pauta);
    const existente = await db(ITENS).where({ user_id: userId, chave }).first();
    if (existente?.status === 'publicada') {
      ignoradas.push({ titulo: pauta.titulo, motivo: 'já foi publicada pelo piloto' });
      continue;
    }
    if (existente && ['na_fila', ...EM_ANDAMENTO, 'agendada', 'publicando'].includes(existente.status)) {
      await atualizarItem(existente.id, { origem: 'manual' });
      adicionadas.push({ id: existente.id, url: pauta.url, titulo: pauta.titulo });
      continue;
    }
    if (existente) {
      // Recusada pela IA ou que falhou antes: volta, agora escolhida pelo editor.
      await atualizarItem(existente.id, {
        origem: 'manual',
        status: existente.matter_id && existente.status === 'erro' ? 'aguardando_imagem' : 'na_fila',
        erro: null,
        tentativas: 0,
        motivo: 'Escolhida por você no Furos do dia',
      });
      adicionadas.push({ id: existente.id, url: pauta.url, titulo: pauta.titulo });
      continue;
    }
    await db(ITENS).insert({
      user_id: userId,
      chave,
      origem: 'manual',
      canal: String(pauta.canal || 'noticias').slice(0, 16),
      titulo: corta(pauta.titulo, 500),
      url: String(pauta.url).slice(0, 1000),
      pauta: JSON.stringify(pauta),
      score: Math.max(0, Math.round(Number(pauta.score) || 0)),
      nota_ia: null,
      motivo: 'Escolhida por você no Furos do dia',
      status: 'na_fila',
    });
    const novo = await db(ITENS).where({ user_id: userId, chave }).first('id');
    adicionadas.push({ id: novo?.id || null, url: pauta.url, titulo: pauta.titulo });
  }
  setImmediate(() => void tick());
  return { adicionadas, ignoradas, status: await statusPainel(userId) };
}

/** Tira da fila tudo o que o editor escolheu e ainda não saiu. */
async function cancelarFilaManual(userId) {
  const agendadas = await db(ITENS).where({ user_id: userId, status: 'agendada', origem: 'manual' });
  for (const item of agendadas) {
    if (await desagendar(item, 'Fila cancelada pelo editor.')) {
      await atualizarItem(item.id, { status: 'descartada', agendado_para: null, erro: 'Fila cancelada pelo editor.' });
    }
  }
  await db(ITENS)
    .where({ user_id: userId, origem: 'manual' })
    .whereIn('status', ['na_fila', ...EM_ANDAMENTO])
    .update({ status: 'descartada', erro: 'Fila cancelada pelo editor.', updated_at: db.fn.now() });
  return statusPainel(userId);
}

async function escanearAgora(userId) {
  const row = await db(CONFIG).where({ user_id: userId }).first();
  if (!row) throw erro(400, 'Salve a configuração do piloto automático antes.');
  void escanear(row, { forcar: true });
  return statusPainel(userId);
}

async function descartarItem(userId, itemId) {
  const item = await db(ITENS).where({ id: itemId, user_id: userId }).first();
  if (!item) throw erro(404, 'Pauta não encontrada.');
  if (!['na_fila', 'aguardando_imagem', 'pronta', 'agendada', 'erro'].includes(item.status)) {
    throw erro(409, 'Esta pauta já está sendo processada ou foi publicada.');
  }
  if (item.status === 'agendada' && !(await desagendar(item, 'Retirada da fila pelo editor.'))) {
    throw erro(409, 'Esta matéria já foi publicada.');
  }
  await atualizarItem(item.id, { status: 'descartada', agendado_para: null, erro: 'Retirada da fila pelo editor.' });
  return statusPainel(userId);
}

/**
 * Tenta de novo um item que falhou (ou que a IA deixou de fora): volta para a
 * etapa em que parou — sem matéria, reescreve; com matéria, refaz a imagem.
 */
async function refazerItem(userId, itemId) {
  const item = await db(ITENS).where({ id: itemId, user_id: userId }).first();
  if (!item) throw erro(404, 'Pauta não encontrada.');
  if (!['erro', 'descartada'].includes(item.status)) throw erro(409, 'Esta pauta não falhou.');
  await atualizarItem(item.id, {
    status: item.matter_id ? 'aguardando_imagem' : 'na_fila',
    erro: null,
    tentativas: 0,
  });
  setImmediate(() => void tick());
  return statusPainel(userId);
}

// ------------------------------------------------------------------ varredura

/** Matérias da página que engajaram (ou, sem histórico, as últimas publicadas). */
async function basesDoPublico(userId, facebookPageId) {
  const AiMatters = require('../models/AiMatters');
  let bases = [];
  try {
    let virais = await AiMatters.findViralizadasDaConta(userId, { limit: 40 });
    if (facebookPageId) virais = virais.filter((m) => Number(m.facebook_page_id) === Number(facebookPageId));
    bases = virais
      .map((m) => ({
        titulo: m.titulo,
        likes: Number(m.pub_fb_likes) || 0,
        comments: Number(m.pub_fb_comments) || 0,
        shares: Number(m.pub_fb_shares) || 0,
      }))
      .sort((a, b) => b.likes + b.comments * 3 + b.shares * 5 - (a.likes + a.comments * 3 + a.shares * 5))
      .slice(0, 20);
  } catch (err) {
    console.warn('[furos-auto] bases virais:', err.message);
  }
  if (bases.length) return bases;
  const recentes = await db('ai_matters')
    .where({ user_id: userId, status: 'publicado' })
    .orderBy('updated_at', 'desc')
    .limit(20)
    .select('titulo');
  return recentes.filter((r) => r.titulo).map((r) => ({ titulo: r.titulo }));
}

/**
 * A IA dá potencial (chance de engajar) e afinidade (com o que já funciona
 * na página). Sem IA disponível, vale só a nota do Furos.
 */
async function avaliarComIa(userId, facebookPageId, candidatos) {
  try {
    const bases = await basesDoPublico(userId, facebookPageId);
    if (!bases.length) return null;
    const avaliacoes = await require('./deepseekService').ranquearPautasParaPublico({
      bases,
      pautas: candidatos.map((c) => ({ titulo: c.titulo, resumo: c.resumo, veiculo: c.veiculo })),
    });
    if (!avaliacoes.length) return null;
    const porId = new Map(avaliacoes.map((a) => [a.id, a]));
    return candidatos.map((_, i) => porId.get(`p${i + 1}`) || null);
  } catch (err) {
    console.warn('[furos-auto] avaliação da IA:', err.message);
    return null;
  }
}

async function escanear(row, { forcar = false } = {}) {
  const userId = Number(row.user_id);
  if (escaneando.has(userId)) return;
  escaneando.add(userId);
  try {
    await atualizarConfig(userId, { ultimo_scan_at: new Date() });
    const naFila = await db(ITENS).where({ user_id: userId, status: 'na_fila' }).count({ n: '*' }).first();
    const esperando = Number(naFila?.n) || 0;
    const vagas = MAX_FILA - esperando;
    // Com pautas suficientes esperando, não gasta o servidor varrendo de novo.
    if (!forcar && esperando >= FILA_SUFICIENTE) {
      await registrarResumo(userId, `${esperando} pautas já esperando na fila; varredura adiada.`);
      return;
    }

    const config = formatarConfig(row);
    const resultado = await require('./furosService').buscarFuros({
      userId,
      nichos: config.nichos,
      palavras: config.palavras,
      horas: config.horas,
      limite: 40,
      canais: config.canais,
      completar: false, // link real e foto só na pauta que for escrita
    });

    // Só o que nunca foi avaliado.
    const comChave = (resultado.furos || []).map((f) => ({ ...f, chave: chaveDaPauta(f) }));
    const conhecidas = new Set(
      comChave.length
        ? (await db(ITENS).where({ user_id: userId }).whereIn('chave', comChave.map((f) => f.chave)).select('chave')).map((r) => r.chave)
        : []
    );
    let novos = comChave.filter((f) => !conhecidas.has(f.chave));

    // Assunto já publicado pela conta (mesmo que por outro veículo) fica de fora.
    // (A comparação corta o link no "?": "watch?v=ID" viraria o mesmo link para
    // todo vídeo, então o YouTube vai pelo endereço curto.)
    const materiaIaService = require('./materiaIaService');
    const paraComparar = novos.map((f) => ({
      titulo: f.titulo,
      resumo: f.resumo,
      url: f.canal === 'youtube' && f.externalId ? `https://youtu.be/${f.externalId}` : f.url,
    }));
    const marcados = await materiaIaService
      .marcarJaPublicados(userId, config.facebook_page_id, paraComparar)
      .catch(() => paraComparar);
    novos = novos.filter((_, i) => !marcados[i]?.jaPublicado);

    // Mesmo fato de outro veículo que já está no caminho (últimas 48h).
    const { titulosSimilares } = require('./newsResearch');
    const recentes = (await db(ITENS)
      .where({ user_id: userId })
      .whereNot('status', 'descartada')
      .where('created_at', '>=', new Date(Date.now() - 48 * 3_600_000))
      .select('titulo')).map((r) => r.titulo).filter(Boolean);
    const aceitosAgora = [];
    novos = novos.filter((f) => {
      const repetido = [...recentes, ...aceitosAgora].some((t) => titulosSimilares(t, f.titulo));
      if (!repetido) aceitosAgora.push(f.titulo);
      return !repetido;
    });
    const encontradas = (resultado.furos || []).length;
    if (!novos.length) {
      await registrarResumo(userId, `${encontradas} pautas encontradas; nenhuma nova (já avaliadas antes ou assunto já publicado).`);
      return;
    }

    const avaliacoes = await avaliarComIa(userId, config.facebook_page_id, novos);
    const avaliados = novos.map((f, i) => {
      const a = avaliacoes?.[i];
      const nota = a
        ? Math.round(0.35 * f.score + 0.45 * a.potencial + 0.2 * a.afinidade)
        : f.score;
      const aprovado = a ? a.potencial >= NOTA_MINIMA_IA || nota >= NOTA_COMBINADA_MINIMA : f.score >= 15;
      return { furo: f, nota, potencial: a ? a.potencial : null, aprovado, motivo: a?.motivo || (f.motivos || []).join(', ') };
    });
    avaliados.sort((a, b) => b.nota - a.nota);

    // Nada no caminho e nenhuma aprovada: a IA escolhe as melhores desta
    // varredura (em vez de deixar a página parada), menos as que ela julgou
    // sem valor editorial.
    const noCaminho = await db(ITENS)
      .where({ user_id: userId })
      .whereIn('status', ['na_fila', ...EM_ANDAMENTO])
      .count({ n: '*' })
      .first();
    if (!(Number(noCaminho?.n) || 0) && !avaliados.some((a) => a.aprovado)) {
      avaliados
        .filter((a) => a.potencial == null || a.potencial >= NOTA_MINIMA_FOME)
        .slice(0, 3)
        .forEach((a) => {
          a.aprovado = true;
          a.motivo = `Melhor desta varredura. ${a.motivo || ''}`.trim();
        });
    }

    let entram = 0;
    for (const { furo, nota, aprovado, motivo } of avaliados) {
      const entra = aprovado && entram < Math.max(vagas, forcar ? 3 : 0);
      if (aprovado && !entra) continue; // boa, mas a fila está cheia: reavalia depois
      if (entra) entram += 1;
      await db(ITENS)
        .insert({
          user_id: userId,
          chave: furo.chave,
          canal: String(furo.canal || 'noticias').slice(0, 16),
          titulo: corta(furo.titulo, 500),
          url: String(furo.url).slice(0, 1000),
          pauta: JSON.stringify({ ...furo, chave: undefined }),
          score: Math.max(0, Math.round(Number(furo.score) || 0)),
          nota_ia: Math.max(0, Math.min(100, nota)),
          motivo: corta(motivo, 255),
          status: entra ? 'na_fila' : 'descartada',
          erro: entra ? null : 'A IA não recomendou esta pauta.',
        })
        .onConflict(['user_id', 'chave'])
        .ignore();
    }
    const notas = avaliados.slice(0, 6).map((a) => a.nota).join(', ');
    await registrarResumo(
      userId,
      `${encontradas} pautas encontradas, ${novos.length} novas, ${entram} aprovadas pela IA` +
        (notas ? ` (melhores notas: ${notas})` : '') + '.'
    );
    console.info(`[furos-auto] user ${userId}: ${novos.length} pautas novas, ${entram} na fila`);
  } catch (err) {
    console.warn(`[furos-auto] varredura user ${userId}:`, err.message);
    await atualizarConfig(userId, { ultimo_erro: corta(`Varredura: ${err.message}`, 500) }).catch(() => {});
  } finally {
    escaneando.delete(userId);
  }
}

// ------------------------------------------------------------------- escrita

/**
 * Modelo que escreve: o mesmo escolhido no chat do /materia-manual (salvo
 * no piloto). Sem o gateway, o redator padrão do sistema (null).
 */
async function modeloDoPiloto(row) {
  if (!require('./deepseekService').usarTokenFree('conversa')) return null;
  // Modelo fixado pelo administrador em /claude vale para todo piloto,
  // independente do que o editor escolheu por último no chat.
  const fixo = await require('./iaModeloTarefaService').modeloDaTarefa('piloto');
  if (fixo) return fixo;
  return require('./materiaModelosService').resolverModelo(row.modelo);
}

/** Mesmo caminho do "Criar matéria" do chat: ler o link, apurar e escrever. */
async function escreverPeloChatDoPiloto({ userId, url, pageId, imagemUrl, modelo }) {
  const { escreverPeloChat } = require('./materiaPorChat');
  const { matterId } = await comLimite(
    escreverPeloChat(
      { chatService: require('./materiaChatService'), comModelo: require('./tokenFreeGatewayService').comModelo },
      { userId, url, facebookPageId: pageId, imagemUrl, modelo, origem: 'furos' }
    ),
    LIMITE_ESCRITA_MS,
    'a escrita passou de 15 min'
  );
  return matterId;
}

async function escreverMateria(item, row) {
  const pauta = parseJson(item.pauta, {});
  const userId = Number(item.user_id);
  const pageId = row.facebook_page_id || null;
  const redeSocial = ['youtube', 'instagram', 'facebook'].includes(item.canal);
  const modelo = await modeloDoPiloto(row);

  if (!redeSocial) {
    const furosService = require('./furosService');
    const { comModelo } = require('./tokenFreeGatewayService');
    // O link do Google News não deixa ler a matéria: troca pelo do veículo.
    let pautaFinal = pauta;
    if (/news\.google\.com/i.test(String(pauta.url || item.url))) {
      const direto = await furosService.linkDiretoPeloTitulo({ ...pauta, url: pauta.url || item.url }, []).catch(() => null);
      if (direto?.url) pautaFinal = { ...pauta, url: direto.url, veiculo: direto.veiculo || pauta.veiculo };
    }

    // 1) Como o "Criar de um link" do chat, com o modelo escolhido lá.
    if (modelo && pautaFinal.url && !/news\.google\.com/i.test(pautaFinal.url)) {
      try {
        const matterId = await escreverPeloChatDoPiloto({ userId, url: pautaFinal.url, pageId, imagemUrl: pautaFinal.imagem, modelo });
        if (matterId) return matterId;
      } catch (err) {
        console.info(`[furos-auto] item ${item.id}: chat não escreveu (${err.message}); tentando o redator de furos`);
      }
    }

    // 2) Redator de furos; 3) sem texto legível, apura pelo título.
    return comModelo(modelo, async () => {
      try {
        const r = await comLimite(
          furosService.gerarFuro({ userId, pauta: pautaFinal, facebookPageId: pageId }),
          LIMITE_ESCRITA_MS,
          'a escrita passou de 15 min'
        );
        return r.matterId;
      } catch (err) {
        if (!/texto suficiente|ler este link|extrair/i.test(String(err.message))) throw err;
        console.info(`[furos-auto] item ${item.id}: fonte ilegível, apurando pelo título`);
        return escreverPorApuracao(userId, pautaFinal, pageId);
      }
    });
  }

  const matterId = await escreverPeloChatDoPiloto({ userId, url: item.url, pageId, imagemUrl: pauta.imagem, modelo });
  if (pauta.bibliotecaPostId && matterId) {
    await require('../models/BibliotecaPosts')
      .update(Number(pauta.bibliotecaPostId), { status: 'rascunho', matter_id: matterId })
      .catch(() => {});
  }
  return matterId;
}

/**
 * Plano B da notícia: pesquisa o fato pelo título (Google News e demais
 * fontes) e escreve só com o que as fontes confirmarem. Sem fonte, falha.
 */
async function escreverPorApuracao(userId, pauta, pageId) {
  const linkLegivel = pauta.url && !/news\.google\.com/i.test(pauta.url);
  const r = await comLimite(
    require('./materiaIaService').gerarMateriaManual({
      userId,
      informacoes: [
        `Pauta: ${pauta.titulo}`,
        pauta.resumo ? `Resumo: ${pauta.resumo}` : null,
        pauta.veiculo ? `Noticiado por: ${pauta.veiculo}` : null,
      ].filter(Boolean).join('\n'),
      angulo: 'Matéria jornalística sobre este fato, usando só o que as fontes encontradas confirmam. Não invente nomes, números nem falas.',
      facebookPageId: pageId,
      imagemUrl: /^https?:\/\//i.test(String(pauta.imagem || '')) ? pauta.imagem : null,
      pesquisarWeb: true,
      palavrasChave: pauta.titulo,
      periodo: '7d',
      fonteBase: linkLegivel
        ? { veiculo: pauta.veiculo, titulo: pauta.titulo, url: pauta.url, resumo: pauta.resumo }
        : null,
    }),
    LIMITE_ESCRITA_MS,
    'a apuração passou de 15 min'
  );
  return r?.matter?.id || null;
}

/** Escreve a próxima da fila enquanto houver espaço à frente da publicação. */
async function avancarEscrita(row) {
  const userId = Number(row.user_id);
  if (escrevendo.has(userId)) return;
  const noCaminho = await soQuandoPermitido(db(ITENS).where({ user_id: userId }), row)
    .whereIn('status', EM_ANDAMENTO)
    .count({ n: '*' })
    .first();
  const agendadasDaIa = row.ativo
    ? await db(ITENS).where({ user_id: userId, status: 'agendada', origem: 'auto' }).count({ n: '*' }).first()
    : null;
  if ((Number(noCaminho?.n) || 0) + (Number(agendadasDaIa?.n) || 0) >= BUFFER_ALVO) return;

  // YouTube limitando o servidor: os vídeos esperam na fila (em vez de
  // falharem um a um) e o piloto segue com as outras pautas.
  const youtubeEmPausa = require('./youtubeLimiter').emPausa();
  let naFila = soQuandoPermitido(db(ITENS).where({ user_id: userId, status: 'na_fila' }), row);
  if (youtubeEmPausa) naFila = naFila.whereNot('canal', 'youtube');
  const item = await naFila.orderByRaw(ORDEM_FILA).first();
  if (!item) return;

  escrevendo.add(userId);
  try {
    const reservado = await atualizarSeAinda(item.id, 'na_fila', { status: 'escrevendo', erro: null });
    if (!reservado) return;
    const matterId = await escreverMateria(item, row);
    if (!matterId) throw new Error('a matéria não foi salva');
    // Publicação automática é sempre foto (imagem obrigatória) na página do piloto.
    await require('../models/AiMatters').update(matterId, {
      tipo_publicacao: 'foto',
      ...(row.facebook_page_id ? { facebook_page_id: row.facebook_page_id } : {}),
    });
    await atualizarSeAinda(item.id, 'escrevendo', { status: 'aguardando_imagem', matter_id: matterId });
    setImmediate(() => void preencherImagens());
  } catch (err) {
    console.warn(`[furos-auto] escrever item ${item.id}:`, err.message);
    await atualizarSeAinda(item.id, 'escrevendo', { status: 'erro', erro: corta(`Escrita: ${err.message}`, 500) });
  } finally {
    escrevendo.delete(userId);
  }
}

// -------------------------------------------------------------------- imagem

async function gerarImagem(item, row) {
  const pauta = parseJson(item.pauta, {});
  const tentativa = (Number(item.tentativas) || 0) + 1;

  // Modo "foto original": publica com a arte da matéria de origem e não
  // chama a IA. É a escolha para a pauta em que imagem gerada não cabe.
  if (row?.modo_imagem === 'original') {
    const matter = await require('../models/AiMatters').findById(item.matter_id);
    if (matter?.imagem_path || matter?.imagem_url) {
      await atualizarSeAinda(item.id, 'gerando_imagem', {
        status: 'pronta', imagem_ia: false, tentativas: tentativa, erro: null,
      });
    } else {
      await atualizarSeAinda(item.id, 'gerando_imagem', {
        status: 'erro',
        tentativas: tentativa,
        erro: 'Sem foto na matéria original e o modo escolhido não gera imagem com IA. Não publicada.',
      });
    }
    return;
  }

  try {
    await require('./materiaPorChat').aplicarCapaChatgpt({
      userId: Number(item.user_id),
      matterId: item.matter_id,
      thumbnail: pauta.imagem,
      permitirSimbolica: true,
    });
    await atualizarSeAinda(item.id, 'gerando_imagem', { status: 'pronta', imagem_ia: true, tentativas: tentativa, erro: null });
  } catch (err) {
    console.warn(`[furos-auto] imagem item ${item.id} (tentativa ${tentativa}):`, err.message);
    if (tentativa < TENTATIVAS_IMAGEM) {
      await atualizarSeAinda(item.id, 'gerando_imagem', { status: 'aguardando_imagem', tentativas: tentativa, erro: corta(`Imagem: ${err.message}`, 500) });
      return;
    }
    const matter = await require('../models/AiMatters').findById(item.matter_id);
    const temArte = Boolean(matter?.imagem_path || matter?.imagem_url);
    if (row?.foto_original_se_falhar && temArte) {
      await atualizarSeAinda(item.id, 'gerando_imagem', {
        status: 'pronta',
        imagem_ia: false,
        tentativas: tentativa,
        erro: corta(`Imagem da IA falhou (${err.message}); vai com a foto original.`, 500),
      });
    } else {
      await atualizarSeAinda(item.id, 'gerando_imagem', {
        status: 'erro',
        tentativas: tentativa,
        erro: corta(`Sem imagem: ${err.message}. Não publicada.`, 500),
      });
    }
  }
}

let preenchendo = false;
let pedirDeNovo = false;

/**
 * Ocupa as vagas de geração de imagem (no máximo MAX_IMAGENS no servidor).
 * Uma chamada por vez: duas em paralelo poderiam passar do limite.
 */
async function preencherImagens() {
  if (preenchendo) {
    pedirDeNovo = true;
    return;
  }
  preenchendo = true;
  try {
    await ocuparVagasDeImagem();
  } finally {
    preenchendo = false;
    if (pedirDeNovo) {
      pedirDeNovo = false;
      setImmediate(() => void preencherImagens());
    }
  }
}

/** Usuários com o Automatizar ligado (atualizado a cada volta do tick). */
let usuariosAtivos = new Set();

async function ocuparVagasDeImagem() {
  while (imagensAtivas < MAX_IMAGENS) {
    // Escolhidas pelo editor sempre andam; as da IA só com o Automatizar ligado.
    const candidatos = await db(ITENS)
      .where('status', 'aguardando_imagem')
      .orderByRaw(ORDEM_FILA)
      .limit(20);
    const item = candidatos.find((i) => i.origem === 'manual' || usuariosAtivos.has(Number(i.user_id)));
    if (!item) return;
    const cfg = await db(CONFIG).where({ user_id: item.user_id }).first();
    item.foto_original_se_falhar = cfg ? cfg.foto_original_se_falhar : true;
    item.modo_imagem = cfg?.modo_imagem === 'original' ? 'original' : 'ia';
    // Reserva atômica: outra volta do tick pode ter pego o mesmo item.
    const reservado = await db(ITENS)
      .where({ id: item.id, status: 'aguardando_imagem' })
      .update({ status: 'gerando_imagem', updated_at: db.fn.now() });
    if (!reservado) continue;
    imagensAtivas += 1;
    gerarImagem(item, { foto_original_se_falhar: item.foto_original_se_falhar, modo_imagem: item.modo_imagem })
      .catch((err) => console.warn('[furos-auto] imagem:', err.message))
      .finally(() => {
        imagensAtivas -= 1;
        setImmediate(() => void preencherImagens());
      });
  }
}

// ---------------------------------------------------------------- publicação

const JANELA_DUPLICATA_MS = 72 * 3_600_000;

function tituloLimpo(texto) {
  return String(texto || '').replace(/\[\[|\]\]|\*\*/g, '').replace(/\s+/g, ' ').trim();
}

function linkComparavel(url) {
  const texto = String(url || '').trim().toLowerCase().split('#')[0].replace(/\/$/, '');
  // No YouTube o vídeo está no "?v="; nos demais a query é só rastreio.
  return /youtube\.com\/watch/.test(texto) ? texto : texto.split('?')[0];
}

/**
 * Última barreira antes de postar: devolve o motivo para NÃO publicar
 * (mesma matéria ou mesmo assunto já publicado nas últimas 72h — pelo
 * piloto, à mão, pela Biblioteca ou pelo Feed) ou null.
 * A checagem da publicação do sistema só avisa no log; aqui ela bloqueia.
 */
async function motivoDeDuplicata(userId, item, matter) {
  if (String(matter.status) === 'publicado' || matter.publication_id) {
    return `a matéria #${matter.id} já foi publicada`;
  }
  const mesmaMateria = await db(ITENS)
    .where({ user_id: userId, matter_id: item.matter_id, status: 'publicada' })
    .whereNot('id', item.id)
    .first('id');
  if (mesmaMateria) return `a matéria #${matter.id} já foi publicada pelo piloto`;

  const { titulosParecidos, mesmoAssuntoNoticia } = require('./editorialGuidelinesFb');
  const titulo = tituloLimpo(matter.titulo);
  const parecido = (outro) => {
    const t = tituloLimpo(outro);
    return Boolean(titulo && t && (mesmoAssuntoNoticia(titulo, t) || titulosParecidos(titulo, t)));
  };
  const desde = new Date(Date.now() - JANELA_DUPLICATA_MS);

  const doPiloto = await db(`${ITENS} as i`)
    .leftJoin('ai_matters as m', 'm.id', 'i.matter_id')
    .where('i.user_id', userId)
    .where('i.status', 'publicada')
    .where('i.publicado_at', '>=', desde)
    .select('i.titulo', 'm.titulo as materia_titulo');
  const agendadasDaFila = await db(ITENS)
    .where({ user_id: userId, status: 'agendada' })
    .whereNot('id', item.id)
    .select('titulo');
  const repetidaAgendada = agendadasDaFila.find((p) => parecido(p.titulo));
  if (repetidaAgendada) return `mesmo assunto de “${tituloLimpo(repetidaAgendada.titulo)}”, já agendado na fila`;
  const repetidoPiloto = doPiloto.find((p) => parecido(p.materia_titulo) || parecido(p.titulo));
  if (repetidoPiloto) return `mesmo assunto de “${tituloLimpo(repetidoPiloto.materia_titulo || repetidoPiloto.titulo)}”, já publicado pelo piloto`;

  const publicadas = await db('ai_matters')
    .where({ user_id: userId, status: 'publicado' })
    .whereNot('id', matter.id)
    .where('updated_at', '>=', desde)
    .select('id', 'titulo', 'fonte_url');
  const link = linkComparavel(matter.fonte_url);
  const repetida = publicadas.find((m) => (link && linkComparavel(m.fonte_url) === link) || parecido(m.titulo));
  if (repetida) return `mesmo assunto da matéria #${repetida.id} (“${tituloLimpo(repetida.titulo)}”), já publicada`;

  const posts = await require('../models/Publications').historyForDedupe(userId, 300).catch(() => []);
  const repetidoNaPagina = posts
    .filter((p) => new Date(p.created_at).getTime() >= desde.getTime())
    .map((p) => String(p.texto || p.legenda_sugerida || '').split(/\n+/).find((l) => l.trim()) || '')
    .find((primeiraLinha) => parecido(primeiraLinha.slice(0, 300)));
  if (repetidoNaPagina) return `a página já tem um post sobre isso: “${tituloLimpo(repetidoNaPagina).slice(0, 120)}”`;
  return null;
}

/**
 * Tira o agendamento de uma matéria que ainda não saiu (pausa, cancelamento,
 * retirada da fila). Devolve false se ela já foi publicada.
 */
async function desagendar(item, motivo) {
  if (!item.matter_id) return true;
  const AiMatters = require('../models/AiMatters');
  const matter = await AiMatters.findById(item.matter_id);
  if (!matter) return true;
  if (String(matter.status) === 'publicado' || matter.publication_id) return false;
  if (String(matter.status) === 'agendado') {
    await AiMatters.update(item.matter_id, { status: 'rascunho', scheduled_at: null });
  }
  await db('ai_fila_jobs')
    .where({ matter_id: item.matter_id, status: 'pendente' })
    .update({ status: 'cancelado', erro: corta(motivo, 500), updated_at: db.fn.now() });
  return true;
}

/** Quantas já saíram hoje + quantas estão agendadas para hoje (limite diário). */
async function ocupadasNoDia(userId) {
  const inicio = inicioDoDia();
  const fimDoDia = new Date(inicio.getTime() + 24 * 3_600_000);
  const [publicadas, agendadas] = await Promise.all([
    db(ITENS).where({ user_id: userId, status: 'publicada' }).where('publicado_at', '>=', inicio).count({ n: '*' }).first(),
    db(ITENS).where({ user_id: userId, status: 'agendada' }).where('agendado_para', '<', fimDoDia).count({ n: '*' }).first(),
  ]);
  return (Number(publicadas?.n) || 0) + (Number(agendadas?.n) || 0);
}

/**
 * Matéria pronta (texto + imagem) é AGENDADA no agendador do sistema: fica
 * "Agendado" em Matérias salvas com dia e hora, uma a cada `intervalo_minutos`,
 * e quem publica é o agendador (tickFilaJobs), na hora marcada.
 */
async function agendarProntas(row) {
  const userId = Number(row.user_id);
  if (publicando.has(userId)) return;
  publicando.add(userId);
  try {
    const prontas = await soQuandoPermitido(db(ITENS).where({ user_id: userId, status: 'pronta' }), row)
      .orderByRaw(ORDEM_FILA)
      .limit(10);
    const AiMatters = require('../models/AiMatters');
    const AiFilaJobs = require('../models/AiFilaJobs');
    const intervaloMs = (Number(row.intervalo_minutos) || 10) * 60_000;
    for (const item of prontas) {
      if ((await ocupadasNoDia(userId)) >= Number(row.limite_dia || 40)) return;
      const matter = await AiMatters.findById(item.matter_id);
      if (!matter) {
        await atualizarItem(item.id, { status: 'erro', erro: 'A matéria foi apagada.' });
        continue;
      }
      if (!matter.imagem_path && !matter.imagem_url) {
        await atualizarItem(item.id, { status: 'erro', erro: 'A matéria está sem imagem. Não agendada.' });
        continue;
      }
      const duplicata = await motivoDeDuplicata(userId, item, matter);
      if (duplicata) {
        console.info(`[furos-auto] user ${userId}: item ${item.id} não agendado (duplicata): ${duplicata}`);
        await atualizarItem(item.id, { status: 'descartada', erro: corta(`Não agendada para não duplicar: ${duplicata}.`, 500) });
        continue;
      }

      // Próximo horário livre da fila: agora ou o intervalo depois da anterior.
      const cfg = await db(CONFIG).where({ user_id: userId }).first();
      const proxima = cfg?.proxima_postagem_at ? new Date(cfg.proxima_postagem_at).getTime() : 0;
      const horario = new Date(Math.max(Date.now(), proxima));
      // Escolhidas pela IA não saem depois que o horário da agenda fecha:
      // ficam prontas e saem quando a próxima janela abrir.
      if (item.origem !== 'manual' && row.fimDaJanela && horario >= row.fimDaJanela) break;

      await AiMatters.update(item.matter_id, {
        status: 'agendado',
        scheduled_at: horario,
        ...(row.facebook_page_id ? { facebook_page_id: row.facebook_page_id } : {}),
      });
      const job = await db('ai_fila_jobs').where({ matter_id: item.matter_id, status: 'pendente' }).first('id');
      if (job) await AiFilaJobs.update(job.id, { run_at: horario });
      else {
        await AiFilaJobs.create({
          user_id: userId,
          matter_id: item.matter_id,
          run_at: horario,
          status: 'pendente',
          payload: JSON.stringify({ action: 'publish', matterId: item.matter_id, origem: 'furos' }),
        });
      }
      await atualizarItem(item.id, { status: 'agendada', agendado_para: horario, erro: null });
      await atualizarConfig(userId, { proxima_postagem_at: new Date(horario.getTime() + intervaloMs), ultimo_erro: null });
      console.info(`[furos-auto] user ${userId}: matéria ${item.matter_id} agendada para ${horario.toISOString()}`);
    }
  } catch (err) {
    console.warn(`[furos-auto] agendar user ${userId}:`, err.message);
    await atualizarConfig(userId, { ultimo_erro: corta(`Agendamento: ${err.message}`, 500) }).catch(() => {});
  } finally {
    publicando.delete(userId);
  }
}

/**
 * O agendador do sistema publica; aqui o piloto só acompanha: publicada,
 * falhou no envio ou teve o agendamento desfeito na própria matéria.
 */
async function acompanharAgendadas(userId) {
  const agendadas = await db(ITENS).where({ user_id: userId, status: 'agendada' }).limit(50);
  if (!agendadas.length) return;
  const AiMatters = require('../models/AiMatters');
  for (const item of agendadas) {
    const matter = item.matter_id ? await AiMatters.findById(item.matter_id) : null;
    if (!matter) {
      await atualizarItem(item.id, { status: 'erro', erro: 'A matéria agendada foi apagada.' });
      continue;
    }
    if (String(matter.status) === 'publicado' || matter.publication_id) {
      await atualizarItem(item.id, { status: 'publicada', publicado_at: new Date(), erro: null });
      continue;
    }
    if (String(matter.status) === 'agendado') {
      const job = await db('ai_fila_jobs').where({ matter_id: item.matter_id }).orderBy('id', 'desc').first('status', 'erro');
      if (job?.status === 'erro') {
        await atualizarItem(item.id, { status: 'erro', erro: corta(`Publicação: ${job.erro || 'falhou no envio'}`, 500) });
      }
      continue;
    }
    // O editor tirou o agendamento direto na matéria.
    await atualizarItem(item.id, { status: 'descartada', erro: 'O agendamento foi desfeito na matéria.' });
  }
}

// ---------------------------------------------------------------------- loop

const DESCARTADA_ANTIGA_MS = 14 * 24 * 3_600_000;
const ultimaLimpezaPesada = new Map();

async function limparVelhas(userId) {
  const agora = Date.now();
  // Recusadas antigas só serviam para não reavaliar o link; depois de 14 dias
  // ele não volta mais na busca (12–48h). Apaga de hora em hora.
  if (agora - (ultimaLimpezaPesada.get(userId) || 0) > 3_600_000) {
    ultimaLimpezaPesada.set(userId, agora);
    await db(ITENS)
      .where({ user_id: userId, status: 'descartada' })
      .where('updated_at', '<', new Date(agora - DESCARTADA_ANTIGA_MS))
      .delete()
      .catch((err) => console.warn('[furos-auto] limpeza:', err.message));
  }
  // Só as da IA "envelhecem" na fila; as escolhidas pelo editor esperam a vez.
  await db(ITENS)
    .where({ user_id: userId, status: 'na_fila', origem: 'auto' })
    .where('created_at', '<', new Date(agora - FILA_VELHA_MS))
    .update({ status: 'descartada', erro: 'A pauta envelheceu na fila.', updated_at: db.fn.now() });
  await db(ITENS)
    .where({ user_id: userId, status: 'pronta' })
    .where('updated_at', '<', new Date(agora - PRONTA_VELHA_MS))
    .update({ status: 'descartada', erro: 'Pronta há mais de 24h: ficou velha para publicar.', updated_at: db.fn.now() });
}

/**
 * Fora do horário da agenda o piloto age como pausado (só a fila escolhida
 * pelo editor anda), sem mexer no "Automatizar". Período encerrado desliga.
 */
async function aplicarAgenda(row, agora, pilotoAgenda) {
  if (!row.ativo) return row;
  const sit = pilotoAgenda.situacao(row.agenda, agora);
  if (sit.encerrada) {
    await atualizarConfig(row.user_id, {
      ativo: false,
      pausado_at: agora,
      ultimo_scan_resumo: corta(`Período da agenda terminou (${sit.regra}); piloto desligado.`, 500),
    });
    console.info(`[furos-auto] user ${row.user_id}: período da agenda terminou, piloto desligado`);
    return { ...row, ativo: false };
  }
  if (!sit.dentro) return { ...row, ativo: false, foraDoHorario: true };
  return { ...row, fimDaJanela: sit.fim };
}

async function tick() {
  if (tickRodando) return;
  tickRodando = true;
  try {
    let configs = [];
    try {
      const ativos = await db(CONFIG).where({ ativo: true });
      usuariosAtivos = new Set(ativos.map((r) => Number(r.user_id)));
      // Quem tem pautas escolhidas no Furos do dia também anda, mesmo pausado.
      const comFila = [...new Set((await db(ITENS)
        .where({ origem: 'manual' })
        .whereIn('status', ['na_fila', ...EM_ANDAMENTO, 'agendada'])
        .select('user_id')).map((r) => Number(r.user_id)))]
        .filter((id) => !usuariosAtivos.has(id));
      const pausados = comFila.length ? await db(CONFIG).whereIn('user_id', comFila) : [];
      configs = [...ativos, ...pausados];
    } catch (err) {
      if (/doesn't exist|no such table/i.test(String(err.message))) return;
      throw err;
    }
    const agora = new Date();
    const pilotoAgenda = require('./pilotoAgenda');
    // "Parar IA" em /claude: a fila espera em vez de virar erro de créditos.
    // O que já foi escrito e agendado continua publicando (não usa IA).
    const pausa = await require('./iaPausaService').estado();
    const modeloImagem = String(process.env.CHATGPT_IMAGE_MODEL || 'gpt-5.6').trim();
    for (const bruto of configs) {
      try {
        const row = await aplicarAgenda(bruto, agora, pilotoAgenda);
        if (bruto.ativo && !row.ativo) usuariosAtivos.delete(Number(bruto.user_id));
        await limparVelhas(row.user_id);
        const modeloEfetivo = await modeloDoPiloto(row).catch(() => row.modelo);
        const iaParada = pausa.geral || Boolean(modeloEfetivo && pausa.modelos.includes(String(modeloEfetivo)));
        const ultimo = row.ultimo_scan_at ? new Date(row.ultimo_scan_at).getTime() : 0;
        // Varredura só com o Automatizar ligado.
        if (!iaParada && row.ativo && Date.now() - ultimo >= SCAN_MS) void escanear(row);
        if (!iaParada) void avancarEscrita(row).catch((err) => console.warn('[furos-auto] escrita:', err.message));
        await agendarProntas(row);
        await acompanharAgendadas(row.user_id);
      } catch (err) {
        console.warn(`[furos-auto] user ${bruto.user_id}:`, err.message);
      }
    }
    if (!pausa.geral && !pausa.modelos.includes(modeloImagem)) await preencherImagens();
  } catch (err) {
    console.error('[furos-auto] tick:', err.message);
  } finally {
    tickRodando = false;
  }
}

/**
 * No boot: o que estava no meio volta para a etapa anterior. Publicação
 * interrompida vira erro (repetir poderia postar duas vezes).
 */
async function recuperar() {
  try {
    await db(ITENS).where({ status: 'escrevendo' })
      .update({ status: 'erro', erro: 'Interrompida pelo reinício do servidor durante a escrita.', updated_at: db.fn.now() });
    await db(ITENS).where({ status: 'gerando_imagem' })
      .update({ status: 'aguardando_imagem', updated_at: db.fn.now() });
    await db(ITENS).where({ status: 'publicando' })
      .update({ status: 'erro', erro: 'Reinício durante a publicação: confira na página se saiu.', updated_at: db.fn.now() });
  } catch (err) {
    if (!/doesn't exist|no such table/i.test(String(err.message))) throw err;
  }
}

function iniciar() {
  if (timer) return;
  recuperar()
    .catch((err) => console.error('[furos-auto] recuperar:', err.message))
    .finally(() => {
      timer = setInterval(() => void tick(), TICK_MS);
      setTimeout(() => void tick(), 20_000);
    });
}

module.exports = {
  INTERVALOS,
  MAX_IMAGENS,
  salvarConfig,
  salvarNtfy,
  testarNtfy,
  statusPainel,
  pausar,
  retomar,
  salvarModelo,
  escanearAgora,
  enfileirarEscolhidas,
  cancelarFilaManual,
  descartarItem,
  refazerItem,
  iniciar,
  tick,
  // exportados para testes
  chaveDaPauta,
  preencherImagens,
};
