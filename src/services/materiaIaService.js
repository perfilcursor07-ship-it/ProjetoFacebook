const AiMatters = require('../models/AiMatters');
const AiMonitors = require('../models/AiMonitors');
const AiFilaJobs = require('../models/AiFilaJobs');
const Publications = require('../models/Publications');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const { pesquisarNichos } = require('./newsResearch');
const { buscarEmAltaAgora } = require('./trendingTopics');
const { apurarTopico } = require('./articleSource');
const { gerarMateriaNoticiaFacebook, assertDeepseek } = require('./deepseekService');
const { registrarAprendizado } = require('./editorialLearningService');
const pexelsService = require('./pexelsService');
const facebookService = require('./facebookService');
const { enqueue } = require('../workers/queue');
const { env } = require('../config/env');
const db = require('../config/db');
const { titulosParecidos, mesmoAssuntoNoticia, formatFacebookCaption, montarFonteCredito, estiloCreditoDaPagina } = require('./editorialGuidelinesFb');
const { applyBrandArtworkToResult } = require('./matterArtworkService');

/** Espaço mínimo entre matérias agendadas (Matérias IA e Minhas matérias). */
const INTERVALO_AGENDAMENTO_MINUTOS = 30;
const INTERVALO_AGENDAMENTO_MS = INTERVALO_AGENDAMENTO_MINUTOS * 60 * 1000;

async function resolvePage(userId, facebookPageId) {
  const { resolvePageForUser, defaultPageForUser } = require('./facebookPageResolver');
  const page = await resolvePageForUser(userId, facebookPageId);
  if (page) return page;
  // Sem página válida no pedido, usa a padrão da conta logada (definida em /paginas).
  return defaultPageForUser(userId);
}

/** Lista de títulos alternativos guardada em ai_matters.titulos_alternativos. */
function parseTitulosAlternativos(raw) {
  try {
    if (Array.isArray(raw)) return raw.map((t) => String(t || '').trim()).filter(Boolean);
    if (typeof raw === 'string' && raw.trim()) {
      const lista = JSON.parse(raw);
      if (Array.isArray(lista)) return lista.map((t) => String(t || '').trim()).filter(Boolean);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function textoXDeterministico({ titulo, materia }) {
  const primeiraFrase = String(materia || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n|(?<=[.!?])\s+/)
    .map((trecho) => trecho.replace(/\s+/g, ' ').trim())
    .find((trecho) => trecho.length >= 30) || '';
  return [String(titulo || '').replace(/\s+/g, ' ').trim(), primeiraFrase]
    .filter(Boolean)
    .join(' — ');
}

async function gerarTextoXDaMateria({ userId, matterId, titulo = null, materia = null }) {
  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }

  const tituloBase = String(titulo ?? matter.titulo ?? '').trim();
  const materiaBase = String(materia ?? matter.materia ?? '').trim();
  const { truncateForTwitter, twitterWeightedLength } = require('./ayrshareService');
  let textoGerado = '';
  try {
    const { gerarTextoX } = require('./deepseekService');
    textoGerado = await gerarTextoX({ titulo: tituloBase, materia: materiaBase });
  } catch (err) {
    console.warn('[x.com] Claude não gerou o resumo; usando versão local:', err.message);
  }
  const texto = truncateForTwitter(
    textoGerado || textoXDeterministico({ titulo: tituloBase, materia: materiaBase })
  );
  await AiMatters.update(matter.id, { texto_x: texto });
  return { texto, peso: twitterWeightedLength(texto), limite: 280 };
}

/**
 * Gera 3 títulos alternativos ao principal e guarda na matéria.
 * É um extra do editor: qualquer falha aqui não pode quebrar a geração, por
 * isso o erro é só registrado no log.
 * @returns {Promise<string[]>}
 */
async function gerarESalvarTitulosAlternativos({
  matterId,
  titulo,
  materia,
  fonteTitulo = null,
  marcaModeloArte = null,
  userId = null,
  evitar = [],
  orientacaoEditor = null,
  // Títulos visíveis no /materia-manual fazem parte da experiência editorial
  // do Claude, não do conjunto de tarefas mecânicas entregue ao DeepSeek.
  tarefa = 'conversa',
}) {
  try {
    const { gerarTitulosAlternativos } = require('./deepseekService');
    let modeloArte = marcaModeloArte;
    if (modeloArte == null && userId) {
      const Users = require('../models/Users');
      const user = await Users.findById(userId);
      modeloArte = user?.marca_modelo_arte || null;
    }
    const titulos = await gerarTitulosAlternativos({
      titulo,
      materia,
      fonteTitulo,
      marcaModeloArte: modeloArte,
      evitar,
      orientacaoEditor,
      tarefa,
    });
    if (!titulos.length) return [];
    if (matterId) {
      await AiMatters.update(matterId, { titulos_alternativos: JSON.stringify(titulos) });
    }
    return titulos;
  } catch (err) {
    // IA parada em /claude: o editor precisa ver a mensagem de créditos.
    if (err.iaPausada) throw err;
    console.warn('[titulos-alternativos] salvar:', err.message);
    return [];
  }
}

function parseHashtagsField(raw) {
  try {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

/** Legenda formatada para o Facebook (espaços, parágrafos, crédito, hashtags). */
function montarMensagem({ titulo, materia, hashtags, fonteCredito, incluirTitulo = true }) {
  return formatFacebookCaption({
    titulo,
    materia,
    hashtags: parseHashtagsField(hashtags),
    fonteCredito,
    incluirTitulo,
  });
}

function creditoPadraoDaMateria({ topico, gerado, tipoPublicacao, pageName }) {
  const estilo = estiloCreditoDaPagina(pageName);
  return montarFonteCredito({
    veiculo: topico?.veiculo || topico?.fonte || gerado?.imagemOrigem?.veiculo,
    fonte: topico?.fonte,
    host: topico?.link || topico?.url,
    tipoPublicacao,
    autorArtigo: topico?.autor || gerado?.autorArtigo || null,
    estilo,
    imagemOrigem:
      gerado?.imagemOrigem ||
      (tipoPublicacao === 'foto' || gerado?.imagemUrl ? { tipo: 'fonte', autor: gerado?.imagemAutor } : null),
  });
}

/**
 * Checa duplicidade com matérias/publicações recentes da mesma página/usuário.
 */
async function checarDuplicidade({ userId, facebookPageId, titulo, materia }) {
  const avisos = [];
  const recentes = await AiMatters.findByUser(userId, 80);
  for (const m of recentes) {
    const status = String(m.status || '');
    if (!['rascunho', 'pronto', 'agendado', 'publicado'].includes(status) && !m.publication_id) {
      continue;
    }
    if (
      mesmoAssuntoNoticia(titulo, m.titulo) ||
      mesmoAssuntoNoticia(titulo, m.fonte_titulo) ||
      titulosParecidos(titulo, m.titulo) ||
      titulosParecidos(materia?.slice(0, 180), m.materia?.slice(0, 180))
    ) {
      avisos.push(`Possível duplicata de matéria #${m.id} (${status}): “${m.titulo || 'sem título'}”`);
      break;
    }
  }

  if (facebookPageId) {
    try {
      const pubs = await Publications.recent(userId, 20);
      for (const p of pubs) {
        const texto = p.texto || p.legenda_sugerida || '';
        if (mesmoAssuntoNoticia(titulo, texto.slice(0, 160)) || titulosParecidos(titulo, texto.slice(0, 120))) {
          avisos.push(`Possível duplicata de publicação recente na Página (${p.page_name || 'FB'})`);
          break;
        }
      }
    } catch (err) {
      console.warn('checarDuplicidade pubs:', err.message);
    }
  }

  return avisos;
}

function pautaTemPessoaNomeada(topico, gerado) {
  const texto = [
    topico?.titulo,
    gerado?.titulo,
    ...(Array.isArray(gerado?.termos_imagem) ? gerado.termos_imagem : []),
  ].filter(Boolean).join(' · ');

  // Duas ou mais palavras iniciadas em maiúscula normalmente identificam uma pessoa
  // (ex.: Flávio Bolsonaro, Silas Malafaia). Nesses casos, foto genérica é pior que rascunho.
  return /\b[\p{Lu}][\p{L}'’-]{2,}(?:\s+(?:da|das|de|do|dos)?\s*[\p{Lu}][\p{L}'’-]{2,})+/u.test(texto);
}

/**
 * Escolhe URL da capa + metadados para crédito do autor da imagem.
 * @returns {Promise<{ url: string|null, autor?: string|null, fonte?: string|null, titulo?: string|null, origem?: string|null }>}
 */
async function escolherImagemCapa(topico, gerado) {
  if (topico?.imagemFonte && /^https?:\/\//i.test(topico.imagemFonte)) {
    return {
      url: topico.imagemFonte,
      autor: null,
      fonte: topico.fonte || topico.veiculo || null,
      titulo: topico.titulo || null,
      origem: 'fonte',
    };
  }

  const temPessoaNomeada = pautaTemPessoaNomeada(topico, gerado);

  // Sem foto na fonte, tenta primeiro a busca editorial disponível no editor
  // (SerpApi → Serper → Brave), antes de deixar a agenda "sem foto".
  try {
    const { sugerirImagensParaMateria } = require('./imageSuggestService');
    const sugestao = await sugerirImagensParaMateria({
      titulo: gerado?.titulo || topico?.titulo || '',
      materia: gerado?.materia || topico?.resumo || '',
      fonteTitulo: topico?.veiculo || topico?.fonte || null,
      limite: 6,
    });
    const primeira = (sugestao?.imagens || []).find(
      (img) => /^https?:\/\//i.test(String(img?.url || '')) && img.origem !== 'fonte'
    );
    if (primeira) {
      return {
        url: primeira.url,
        autor: primeira.autor || null,
        fonte: primeira.fonte || sugestao.fontePreferida || null,
        titulo: primeira.titulo || gerado?.titulo || topico?.titulo || null,
        origem: primeira.origem || 'busca-editorial',
      };
    }
  } catch (err) {
    console.warn('escolherImagemCapa busca editorial:', err.message);
  }

  // A Pexels não é uma fonte editorial adequada para pessoa pública.
  if (temPessoaNomeada) return { url: null };
  if (!env.pexelsApiKey) return { url: null };

  try {
    const termo =
      (Array.isArray(gerado.termos_imagem) && gerado.termos_imagem[0]) ||
      (gerado.hashtags && gerado.hashtags[0]) ||
      topico?.nicho ||
      String(gerado.titulo || topico?.titulo || 'news').split(/\s+/).slice(0, 3).join(' ');
    const photos = await pexelsService.searchPhotos(termo, { perPage: 5 });
    const first = photos?.photos?.[0];
    const url = first?.urlOriginal || first?.thumbnail || null;
    if (!url) return { url: null };
    return {
      url,
      autor: first.autor || null,
      fonte: first.autor ? `Pexels · ${first.autor}` : 'Pexels',
      titulo: first.alt || termo,
      origem: 'pexels',
    };
  } catch (err) {
    console.warn('escolherImagemCapa:', err.message);
    return { url: null };
  }
}

/**
 * Marca tópicos já usados/publicados na página (ou no usuário).
 */
async function marcarJaPublicados(userId, facebookPageId, topicos, opcoes = {}) {
  const lista = Array.isArray(topicos) ? topicos : [];
  if (!lista.length || !userId) return lista;

  const limiteHistorico = Math.min(10000, Math.max(250, Number(opcoes.limiteHistorico) || 1000));
  const todasPaginas = Boolean(opcoes.todasPaginas);
  const [matters, publications] = await Promise.all([
    AiMatters.findByUser(userId, limiteHistorico),
    Publications.historyForDedupe(userId, limiteHistorico).catch((err) => {
      console.warn('[dedupe pautas] publicações:', err.message);
      return [];
    }),
  ]);
  const urls = new Set();
  const titulos = [];
  const normalizarUrl = (value) =>
    String(value || '')
      .split(/[?#]/)[0]
      .toLowerCase()
      .replace(/\/$/, '');
  for (const m of matters) {
    if (
      !todasPaginas &&
      facebookPageId &&
      m.facebook_page_id &&
      Number(m.facebook_page_id) !== Number(facebookPageId)
    ) {
      continue;
    }
    if (m.fonte_url) urls.add(normalizarUrl(m.fonte_url));
    if (m.fonte_titulo) titulos.push(m.fonte_titulo);
    if (m.titulo) titulos.push(m.titulo);
    if (m.materia) {
      const primeiraLinha = String(m.materia).split(/\n+/).find((linha) => linha.trim());
      if (primeiraLinha) titulos.push(primeiraLinha.slice(0, 220));
    }
  }

  for (const publication of publications) {
    if (
      !todasPaginas &&
      facebookPageId &&
      publication.facebook_page_id &&
      Number(publication.facebook_page_id) !== Number(facebookPageId)
    ) {
      continue;
    }
    const texto = String(publication.texto || publication.legenda_sugerida || '').trim();
    const tituloPublicado = texto.split(/\n+/).find((linha) => linha.trim());
    if (tituloPublicado) titulos.push(tituloPublicado.slice(0, 300));
  }

  if (opcoes.incluirFeedPagina && facebookPageId) {
    try {
      const page = await resolvePage(userId, facebookPageId);
      const posts = await facebookService.listRecentPagePosts(
        page?.page_access_token,
        page?.page_id,
        { limit: Math.min(500, Math.max(100, Number(opcoes.limiteFeed) || 300)) }
      );
      for (const post of posts) {
        const tituloPublicado = String(post.message || '').split(/\n+/).find((linha) => linha.trim());
        if (tituloPublicado) titulos.push(tituloPublicado.slice(0, 300));
      }
    } catch (err) {
      console.warn('[dedupe pautas] feed da página:', err.message);
    }
  }

  return lista.map((t) => {
    const link = normalizarUrl(t.link || t.url);
    const jaPorUrl = Boolean(link && urls.has(link));
    const resumo = String(t.resumo || t.trecho || '').slice(0, 220);
    const jaPorTitulo = titulos.some((x) =>
      mesmoAssuntoNoticia(t.titulo, x) ||
      titulosParecidos(t.titulo, x) ||
      (resumo && mesmoAssuntoNoticia(resumo, x))
    );
    return { ...t, jaPublicado: jaPorUrl || jaPorTitulo };
  });
}

async function gerarPreviewDeTopico(
  topico,
  {
    userId,
    facebookPageId,
    tipoPublicacao = 'texto',
    investigativa = false,
    furoReportagem = false,
    variacaoViral = false,
    textoEvitar = null,
    factualEstrito = false,
    exigirFonteDocumentada = false,
  } = {}
) {
  assertDeepseek();
  const apurado = await apurarTopico(topico || {});

  if (exigirFonteDocumentada) {
    const fontes = Array.isArray(apurado.fontesApuracao) ? apurado.fontesApuracao : [];
    const temTrechoForte = fontes.some((f) => String(f?.trecho || f?.resumo || '').trim().length >= 180);
    const contexto = String(apurado.contextoApuracao || '').trim();
    const socialComTexto = Boolean(apurado.redeSocial || apurado.tipoFonte === 'rede_social') && contexto.length >= 120;
    const fonteMinimaBiblioteca =
      Boolean(topico?.fonteMinimaBiblioteca) &&
      contexto.length >= 80 &&
      Boolean(apurado.link || fontes.some((f) => f?.url)) &&
      Boolean(apurado.titulo || apurado.resumo);
    if (!temTrechoForte && !socialComTexto && !fonteMinimaBiblioteca) {
      const err = new Error(
        'Não consegui extrair texto suficiente da notícia/post original. Para evitar invenção, abra a fonte, cole o texto manualmente ou tente novamente depois.'
      );
      err.status = 422;
      throw err;
    }
  }

  let contextoAprendizado = null;
  if (userId) {
    try {
      const learning = require('./editorialLearningService');
      contextoAprendizado = await learning.obterContextoAprendizado(userId);
    } catch (err) {
      console.warn('[editorial-learning] carregar:', err.message);
    }
  }

  let marcaModeloArte = null;
  if (userId) {
    try {
      const Users = require('../models/Users');
      const user = await Users.findById(userId);
      marcaModeloArte = user?.marca_modelo_arte || null;
    } catch {
      /* ignore */
    }
  }

  const gerado = await gerarMateriaNoticiaFacebook({
    tituloReferencia: apurado.titulo,
    resumoReferencia: apurado.resumo,
    fonte: apurado.veiculo || apurado.fonte,
    nicho: apurado.nicho,
    contextoApuracao: apurado.contextoApuracao,
    fontesApuracao: apurado.fontesApuracao,
    dataReferencia: apurado.dataReferencia || apurado.data,
    emAlta: Boolean(apurado.emAlta || apurado.emAltaAgora),
    redeSocial: Boolean(apurado.redeSocial || apurado.tipoFonte === 'rede_social'),
    investigativa,
    furoReportagem,
    variacaoViral,
    textoEvitar,
    contextoAprendizado,
    traduzirFonte: Boolean(
      topico?.traduzirFonte ||
        topico?.idiomaObrigatorio === 'pt-BR' ||
        /\b(the|and|church|christian|should|about|after|before)\b/i.test(
          `${apurado.titulo || ''} ${apurado.resumo || ''}`
        )
    ),
    factualEstrito,
    marcaModeloArte,
  });

  const capa = await escolherImagemCapa(apurado, gerado);
  const imagemUrl = capa?.url || null;
  const imagemOrigem = imagemUrl
    ? imagemUrl === apurado.imagemFonte
      ? {
          tipo: 'fonte',
          rotulo: `Foto da notícia original${apurado.veiculo ? ` · ${apurado.veiculo}` : ''}`,
          url: apurado.link || null,
        }
      : {
          tipo: 'pexels',
          rotulo: 'Foto temática da Pexels',
          consulta: gerado.termos_imagem?.[0] || gerado.hashtags?.[0] || apurado.nicho || null,
        }
    : null;

  const { identificarAutorImagem } = require('./deepseekService');
  const {
    anexarCreditosFontes,
    estiloCreditoDaPagina,
    CREDITO_IMAGEM_FALLBACK,
    removerFechamentoOracao,
  } = require('./editorialGuidelinesFb');

  let pageName = null;
  if (facebookPageId) {
    try {
      const page = await FacebookPages.findById(facebookPageId);
      pageName = page?.page_name || null;
    } catch {
      /* ignore */
    }
  }
  const estiloCredito = estiloCreditoDaPagina(pageName);

  let imagemAutor = CREDITO_IMAGEM_FALLBACK;
  if (imagemUrl) {
    const identificado = await identificarAutorImagem({
      autor: capa.autor || null,
      fonte: capa.fonte || null,
      titulo: capa.titulo || apurado.titulo || null,
      origem: capa.origem || imagemOrigem?.tipo || null,
    });
    imagemAutor = identificado || CREDITO_IMAGEM_FALLBACK;
  }

  const avisosDuplicidade = userId
    ? await checarDuplicidade({
        userId,
        facebookPageId,
        titulo: gerado.titulo,
        materia: gerado.materia,
      })
    : [];

  const avisos = [
    gerado._avisoQualidade,
    ...(gerado._muletasIa?.length ? [`Muletas IA restantes: ${gerado._muletasIa.join(', ')}`] : []),
    ...(gerado._citacoesSuspeitas?.length
      ? [`Nomes em citações fora da apuração: ${gerado._citacoesSuspeitas.join(', ')}`]
      : []),
    ...avisosDuplicidade,
  ].filter(Boolean);

  const semImagemFoto = tipoPublicacao === 'foto' && !imagemUrl;

  const materiaComFontes = removerFechamentoOracao(
    anexarCreditosFontes(gerado.materia, {
      fonteNome: apurado.veiculo || apurado.fonte || null,
      fonteUrl: apurado.link || null,
      imagemAutor,
      autorArtigo: apurado.autor || null,
      estilo: estiloCredito,
    })
  );

  return {
    ...gerado,
    materia: materiaComFontes,
    imagemUrl,
    imagemOrigem,
    imagemAutor,
    autorArtigo: apurado.autor || null,
    estiloCredito,
    pageName,
    topico: apurado,
    avisos,
    forcarRascunho: semImagemFoto,
    avisoFoto: semImagemFoto
      ? 'Não foi encontrada uma foto editorial relacionada. A matéria foi mantida como rascunho para evitar publicar uma imagem genérica ou incorreta.'
      : null,
  };
}

async function salvarMateria({ userId, facebookPageId, gerado, topico, tipoPublicacao = 'texto', status = 'pronto' }) {
  let finalStatus = status;
  if (gerado.forcarRascunho || (tipoPublicacao === 'foto' && !(gerado.imagemUrl || topico?.imagemFonte))) {
    finalStatus = 'rascunho';
  }

  const [id] = await AiMatters.create({
    user_id: userId,
    facebook_page_id: facebookPageId || null,
    titulo: gerado.titulo || topico?.titulo || null,
    materia: gerado.materia,
    titulo_ia: gerado.titulo || topico?.titulo || null,
    materia_ia: gerado.materia || null,
    hashtags: JSON.stringify(gerado.hashtags || []),
    fonte_titulo: topico?.titulo || null,
    fonte_url: topico?.link || null,
    fonte_resumo: topico?.resumo || null,
    fonte_credito: null, // crédito fica só no corpo (materia); evita repetir no campo Fonte/crédito
    contexto_apuracao: topico?.contextoApuracao || null,
    status: finalStatus,
    tipo_publicacao: tipoPublicacao === 'foto' ? 'foto' : 'texto',
    imagem_url: gerado.imagemUrl || topico?.imagemFonte || null,
    error_message: gerado.avisoFoto || null,
  });

  // Alternativas rodam fora do caminho crítico: montar a agenda não pode ficar
  // mais lento (nem falhar) por causa de um extra do editor.
  gerarESalvarTitulosAlternativos({
    matterId: id,
    userId,
    titulo: gerado.titulo || topico?.titulo || null,
    materia: gerado.materia,
    fonteTitulo: topico?.titulo || null,
  }).catch(() => {});

  return AiMatters.findById(id);
}

async function criarMateriaManual({
  userId,
  facebookPageId = null,
  titulo,
  materia,
  hashtags = [],
  fonteCredito = null,
  tipoPublicacao = 'foto',
} = {}) {
  const tituloLimpo = String(titulo || '').replace(/\s+/g, ' ').trim();
  const materiaLimpa = String(materia || '').replace(/\r\n/g, '\n').trim();
  if (tituloLimpo.length < 3) {
    const err = new Error('Escreva um título para a matéria manual.');
    err.status = 400;
    throw err;
  }
  if (materiaLimpa.length < 40) {
    const err = new Error('Escreva o texto da matéria manual antes de criar o rascunho.');
    err.status = 400;
    throw err;
  }
  const tags = Array.isArray(hashtags)
    ? hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 6)
    : String(hashtags || '')
        .split(/[,\s#]+/)
        .map((h) => h.trim())
        .filter(Boolean)
        .slice(0, 6);
  const tipo = tipoPublicacao === 'texto' ? 'texto' : 'foto';

  const [id] = await AiMatters.create({
    user_id: userId,
    facebook_page_id: facebookPageId || null,
    titulo: tituloLimpo,
    materia: materiaLimpa,
    titulo_ia: null,
    materia_ia: null,
    hashtags: JSON.stringify(tags),
    fonte_titulo: 'Conteúdo enviado pelo editor',
    fonte_url: null,
    fonte_resumo: null,
    fonte_credito: String(fonteCredito || '').trim() || null,
    contexto_apuracao: 'Criada manualmente pelo usuário.',
    status: 'rascunho',
    tipo_publicacao: tipo,
    imagem_url: null,
    error_message: null,
  });

  // O texto que o editor escreve do zero é o exemplo mais forte do estilo
  // dele — vale mais que uma correção sobre texto da IA.
  registrarAprendizado({
    userId,
    matterId: id,
    tituloDepois: tituloLimpo,
    materiaDepois: materiaLimpa,
    origem: 'Matéria escrita à mão pelo editor (estilo dele, sem versão da IA)',
  }).catch((err) => console.warn('[materia-manual] aprender estilo:', err.message));

  // Mesmo na matéria escrita à mão, o editor recebe 3 opções de manchete.
  gerarESalvarTitulosAlternativos({
    matterId: id,
    userId,
    titulo: tituloLimpo,
    materia: materiaLimpa,
    fonteTitulo: 'Conteúdo enviado pelo editor',
  }).catch(() => {});

  return AiMatters.findById(id);
}

async function publicarMateria(userId, matterId, overrides = {}) {
  const variant = await AiMatters.findById(matterId);
  if (!variant || Number(variant.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada'); err.status = 404; throw err;
  }
  if (!variant.distribution_brand || overrides.distributionClaim) {
    return publicarMateriaIndividual(userId, matterId, overrides);
  }
  const items = () => db('page_distribution_items').where({ user_id: userId, matter_id: matterId });
  const claimed = !variant.publication_id && await items().where({ state: 'ready' })
    .update({ state: 'sending', updated_at: db.fn.now() });
  if (!claimed) {
    const err = new Error('Esta versão está em preparo, já foi enviada ou aguarda conferência do envio na matéria principal.');
    err.status = 409; throw err;
  }
  try {
    const result = await publicarMateriaIndividual(userId, matterId, {
      ...overrides, facebook_page_id: variant.facebook_page_id, sync: true,
    });
    const confirmed = Boolean(result.postId || result.fbPostUrl);
    await items().update({ state: confirmed ? 'sent' : 'uncertain', updated_at: db.fn.now(),
      error: confirmed ? null : 'Provedor não confirmou o ID. Confira o envio na página.' });
    return result;
  } catch (err) {
    await items().update({ state: require('./distributionFailure').failureState(err), updated_at: db.fn.now(), error: String(err.message).slice(0, 500) });
    throw err;
  }
}

/**
 * Já saiu na mesma página, nos últimos dias, uma matéria com a MESMA notícia
 * (mesmo link de origem ou título praticamente igual)? Ignora a própria
 * matéria. Assunto parecido não conta.
 */
/**
 * Agendar pela tela JÁ é a confirmação do editor.
 *
 * A fila recusa publicar matéria com proposta de pré-agenda ainda `pendente`
 * ("só publica depois de Confirmar") — regra certa para o que a Biblioteca
 * sugere sozinha. Mas o botão Agendar não mexia nessa linha: uma proposta
 * antiga esquecida em `pendente` derrubava o agendamento feito à mão, e a
 * matéria voltava para a lista sem sair.
 */
async function confirmarPreAgenda(matterId, quando) {
  try {
    if (!(await db.schema.hasTable('biblioteca_agenda'))) return;
    await db('biblioteca_agenda')
      .where({ matter_id: matterId })
      .whereNotIn('status', ['cancelado', 'publicado'])
      .update({
        status: 'confirmado',
        proposed_at: quando,
        updated_at: db.fn.now(),
      });
  } catch (err) {
    // Não impede o agendamento: no pior caso a guarda da fila ainda avisa.
    console.warn(`[agendar] confirmar pré-agenda #${matterId}:`, err.message);
  }
}

async function mesmaNoticiaJaNaPagina({ userId, pageId, matter, dias = 3 }) {
  if (!pageId) return null;
  const { mesmaNoticiaEstrita } = require('./editorialGuidelinesFb');
  const semQuery = (v) => String(v || '').split(/[?#]/)[0].toLowerCase().replace(/\/+$/, '');
  const inicioCorpo = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160);
  const outras = await db('ai_matters')
    .where({ user_id: userId, facebook_page_id: pageId, status: 'publicado' })
    .whereNot('id', matter.id)
    .where('updated_at', '>=', new Date(Date.now() - dias * 86_400_000))
    .select('id', 'titulo', 'fonte_titulo', 'fonte_url', 'materia')
    .orderBy('updated_at', 'desc')
    .limit(300)
    .catch(() => []);
  const url = semQuery(matter.fonte_url);
  const corpo = inicioCorpo(matter.materia);
  return outras.find((o) =>
    (url && url === semQuery(o.fonte_url)) ||
    mesmaNoticiaEstrita(matter.titulo, o.titulo) ||
    (matter.fonte_titulo && o.fonte_titulo && mesmaNoticiaEstrita(matter.fonte_titulo, o.fonte_titulo)) ||
    (corpo.length >= 120 && corpo === inicioCorpo(o.materia))
  ) || null;
}

// Matérias sendo publicadas agora neste processo: a mesma não sai duas vezes
// em paralelo (fila + fallback, ou dois cliques).
const publicandoAgora = new Set();

async function publicarMateriaIndividual(userId, matterId, overrides = {}) {
  const chave = Number(matterId);
  if (publicandoAgora.has(chave)) {
    const err = new Error('Esta matéria já está sendo publicada agora.');
    err.status = 409;
    throw err;
  }
  publicandoAgora.add(chave);
  try {
    return await publicarMateriaIndividualAgora(userId, matterId, overrides);
  } finally {
    publicandoAgora.delete(chave);
  }
}

async function publicarMateriaIndividualAgora(userId, matterId, overrides = {}) {
  let matter = await AiMatters.findById(matterId);
  if (!matter || matter.user_id !== userId) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }

  // Publicação automática (fila, piloto, Dots) nunca republica: só o editor,
  // clicando em Publicar/Republicar (forcar), pode mandar de novo.
  const automatica = !overrides.forcar;
  if (automatica && String(matter.status) === 'publicado') {
    const err = new Error('Matéria já publicada — a publicação automática não republica.');
    err.status = 409;
    throw err;
  }

  const facebookPageId = overrides.facebook_page_id || matter.facebook_page_id;
  const page = matter.distribution_brand
    ? await require('./facebookPageResolver').resolvePageForUser(userId, facebookPageId)
    : await resolvePage(userId, facebookPageId);

  // A mesma notícia não sai duas vezes na mesma página por publicação
  // automática. Antes isto só gerava um aviso no log e publicava assim mesmo.
  // Clique do editor em "Publicar agora" (manual) NÃO passa por esta trava:
  // ele era barrado aqui e a matéria voltava a rascunho sem ele pedir. O
  // editor já confirmou que quer publicar — a decisão é dele.
  let avisoRepetida = null;
  if (automatica && page?.id && overrides.manual) {
    const igual = await mesmaNoticiaJaNaPagina({ userId, pageId: page.id, matter }).catch(() => null);
    if (igual) avisoRepetida = `a página já tinha notícia parecida (matéria #${igual.id})`;
  } else if (automatica && page?.id) {
    const igual = await mesmaNoticiaJaNaPagina({ userId, pageId: page.id, matter });
    if (igual) {
      const motivo = `Não publicada: a página já tem a mesma notícia (matéria #${igual.id}).`;
      console.warn(`[publicar] BLOQUEADO #${matter.id} — ${motivo}`);
      await AiMatters.update(matter.id, { status: 'rascunho', scheduled_at: null, error_message: motivo }).catch(() => {});
      await db('ai_fila_jobs')
        .where({ matter_id: matter.id })
        .whereIn('status', ['pendente'])
        .update({ status: 'cancelado', erro: motivo })
        .catch(() => {});
      const err = new Error(motivo);
      err.status = 409;
      err.code = 'NOTICIA_REPETIDA';
      throw err;
    }
  }
  if (!page) {
    const err = new Error('Conecte/selecione uma página do Facebook');
    err.status = 400;
    throw err;
  }

  // Reel nunca pode “cair” para texto por override do body (pickTipo default = texto)
  const tipo =
    matter.tipo_publicacao === 'reel'
      ? 'reel'
      : overrides.tipo_publicacao && overrides.tipo_publicacao !== 'auto'
        ? overrides.tipo_publicacao
        : matter.tipo_publicacao || 'texto';
  const mensagem = montarMensagem({
    titulo: overrides.titulo || matter.titulo,
    materia: (() => {
      const raw = overrides.materia || matter.materia;
      if (estiloCreditoDaPagina(page.page_name) !== 'jm') return raw;
      if (!/Fontes:\s*\n\s*[•\*]/i.test(String(raw || ''))) return raw;
      const { converterCreditosParaJm } = require('./editorialGuidelinesFb');
      return converterCreditosParaJm(raw, {
        fonteUrl: matter.fonte_url,
        autorArtigo: null,
      });
    })(),
    hashtags: overrides.hashtags || matter.hashtags,
    fonteCredito: '', // crédito só no corpo da matéria
    incluirTitulo: tipo !== 'foto',
  });

  if (!mensagem.trim() || String(mensagem).startsWith('⏳')) {
    const err = new Error(
      String(mensagem).startsWith('⏳')
        ? 'Aguarde o Reel terminar de processar (vídeo + legenda) antes de publicar.'
        : 'Matéria vazia'
    );
    err.status = 400;
    throw err;
  }

  if (tipo === 'reel' && !matter.video_path && !matter.video_clip_id) {
    const err = new Error('Vídeo do Reel ainda não está pronto. Aguarde o processamento.');
    err.status = 422;
    throw err;
  }

  const imagemUrl = overrides.imagem_url || matter.imagem_url;
  if (tipo === 'foto' && !imagemUrl && !matter.imagem_path) {
    await AiMatters.update(matter.id, {
      status: 'rascunho',
      error_message: 'Foto sem imagem — salva como rascunho',
    });
    const err = new Error('Tipo foto exige imagem de capa. Matéria mantida como rascunho.');
    err.status = 422;
    throw err;
  }

  const avisosDup = await checarDuplicidade({
    userId,
    facebookPageId: page.id,
    titulo: overrides.titulo || matter.titulo,
    materia: overrides.materia || matter.materia,
  });
  if (avisosDup.length && !overrides.forcar) {
    console.warn('[duplicidade]', avisosDup.join(' | '));
  }

  const pubTipo = tipo === 'reel' ? 'reel' : tipo === 'foto' ? 'foto' : 'texto';

  // Facebook permanece selecionado para matérias e clientes antigos; a escolha
  // só vale para esta publicação, sem alterar a preferência de Instagram salva.
  const pedidoFacebook =
    overrides.publicar_facebook != null
      ? !(overrides.publicar_facebook === false || overrides.publicar_facebook === 'false' || overrides.publicar_facebook === '0')
      : true;
  // Instagram: o editor marca na matéria e a Página precisa estar ativada em
  // /paginas. O override do body vence a preferência salva na matéria.
  const pedidoInstagram =
    overrides.publicar_instagram != null
      ? Boolean(overrides.publicar_instagram)
      : Boolean(matter.publicar_instagram);
  const pedidoX =
    overrides.publicar_x != null ? Boolean(overrides.publicar_x) : Boolean(matter.publicar_x);
  if (!pedidoFacebook && !pedidoInstagram && !pedidoX) {
    const err = new Error('Selecione Facebook, Instagram, X.com ou mais de uma rede para publicar.');
    err.status = 400;
    throw err;
  }
  const { truncateForTwitter } = require('./ayrshareService');
  let textoX = String(overrides.texto_x ?? matter.texto_x ?? '').trim();
  if (pedidoX && !textoX) {
    const gerado = await gerarTextoXDaMateria({
      userId,
      matterId: matter.id,
      titulo: overrides.titulo || matter.titulo,
      materia: overrides.materia || matter.materia,
    });
    textoX = gerado.texto;
  }
  textoX = pedidoX ? truncateForTwitter(textoX) : '';
  const imagemXUrl = String(overrides.imagem_x_url ?? matter.imagem_x_url ?? '').trim() || null;
  // O filtro por instagram_ativo fica no publishDispatch: lá o editor recebe
  // o aviso do porquê o post saiu só no Facebook, em vez de silêncio.
  console.log('[publicar] instagram', {
    matterId: matter.id,
    pageId: page.id,
    page: page.page_name,
    pedido: pedidoInstagram,
    facebook: pedidoFacebook,
    x: pedidoX,
    origem: overrides.publicar_instagram != null ? 'requisicao' : 'materia',
    paginaAtiva: Boolean(page.instagram_ativo),
  });

  const [pubId] = await Publications.create({
    video_clip_id: matter.video_clip_id || null,
    imagem_id: null,
    facebook_page_id: page.id,
    tipo: pubTipo,
    status: 'pendente',
    texto: mensagem,
  });

  await AiMatters.update(matter.id, {
    facebook_page_id: page.id,
    tipo_publicacao: pubTipo === 'reel' ? 'reel' : pubTipo === 'foto' ? 'foto' : 'texto',
    publication_id: pubId,
    status: 'pronto',
    error_message: null,
    titulo: overrides.titulo || matter.titulo,
    materia: overrides.materia || matter.materia,
    publicar_instagram: pedidoInstagram,
    publicar_x: pedidoX,
    texto_x: textoX || null,
    imagem_x_url: imagemXUrl,
  });

  const executarPublicacao = async () => {
    const publishDispatch = require('./publishDispatch');
    const { storageAbsolutePath } = require('./downloadService');
    const fs = require('fs');
    const img = overrides.imagem_url || matter.imagem_url;
    const hasFoto = Boolean(img || matter.imagem_path);

    let reelFile = null;
    if (pubTipo === 'reel') {
      // Só toca na capa se o editor já tiver incluído (não cria capa na hora de publicar)
      if (matter.video_clip_id) {
        try {
          const VideoClips = require('../models/VideoClips');
          const clipCapa = await VideoClips.findById(matter.video_clip_id);
          const temCapa =
            clipCapa?.capa_status === 'pronta' ||
            (clipCapa?.caminho_arquivo && /_capa_/i.test(String(clipCapa.caminho_arquivo)));
          if (temCapa) {
            const { applyCoverToClipNow } = require('./clipPostProcessService');
            await applyCoverToClipNow({
              clipId: matter.video_clip_id,
              userId,
              titulo: overrides.titulo || matter.titulo,
              force: false,
            });
            matter = await AiMatters.findById(matter.id);
          }
        } catch (capaErr) {
          console.warn(`[publicar-reel] capa matter #${matter.id}:`, capaErr.message);
        }
      }

      // Preferir arquivo atual do clipe (com capa), não um path antigo deletado
      let rel = matter.video_path;
      if (matter.video_clip_id) {
        try {
          const VideoClips = require('../models/VideoClips');
          const clip = await VideoClips.findById(matter.video_clip_id);
          if (clip?.caminho_arquivo) rel = clip.caminho_arquivo;
        } catch {
          /* ignore */
        }
      }

      if (!rel) {
        const err = new Error('Vídeo do Reel não encontrado.');
        err.status = 422;
        throw err;
      }
      reelFile = storageAbsolutePath(rel);
      if (!fs.existsSync(reelFile)) {
        const err = new Error(
          `Arquivo do Reel ausente no servidor (${rel}). Gere novamente a partir do link.`
        );
        err.status = 422;
        throw err;
      }
      if (rel !== matter.video_path) {
        await AiMatters.update(matter.id, { video_path: rel });
        matter.video_path = rel;
      }
      console.log(
        `[publicar-reel] matter #${matter.id} file=${rel} bytes=${fs.statSync(reelFile).size}`
      );
    }

    const result = await publishDispatch.publishContent({
      userId,
      page,
      tipo:
        pubTipo === 'reel'
          ? 'reel'
          : tipo === 'foto' && hasFoto
            ? 'foto'
            : 'texto',
      filePath: reelFile,
      imagemPath: pubTipo === 'reel' ? null : matter.imagem_path || null,
      imageUrl: pubTipo === 'foto' && img ? img : null,
      texto: mensagem,
      // A legenda completa já contém o título. No PostSyncer, settings.title a substituiria.
      titulo: null,
      publicarFacebook: pedidoFacebook,
      publicarInstagram: pedidoInstagram,
      publicarX: pedidoX,
      textoX: textoX || null,
      imagemXUrl,
    });

    const postId = result.post_id || result.id;
    let fbPostUrl = pedidoFacebook
      ? result.fb_post_url || publishDispatch.buildFbPostUrl(page, postId)
      : null;
    let nativeId = result.fb_native_post_id || null;

    if (pedidoFacebook && !postId) {
      console.warn('[publicar] provedor não devolveu ID do post', {
        matterId: matter.id,
        pubId,
        provider: result.provider || null,
        chaves: Object.keys(result || {}),
      });
    }

    // Sem ID nativo (provedor externo), busca o post no feed da Página para
    // não deixar a publicação órfã — é o ID que a leitura de engajamento usa.
    if (pedidoFacebook && !nativeId) {
      const tokenPage = String(page.page_access_token || '');
      const podeGraph =
        Boolean(tokenPage) &&
        !tokenPage.startsWith('ayrshare:') &&
        !tokenPage.startsWith('postsyncer:') &&
        !tokenPage.startsWith('postpulse:');
      const doPostId = facebookService.parseFacebookPostId(postId);
      if (doPostId && /^\d+_\d+$/.test(String(doPostId))) {
        nativeId = doPostId;
      } else if (podeGraph && page.page_id) {
        try {
          const found = await facebookService.findPagePostByContent(
            tokenPage,
            page.page_id,
            { message: mensagem, publishedAt: new Date() }
          );
          if (found?.id) {
            nativeId = found.id;
            fbPostUrl = fbPostUrl || found.permalink || null;
          }
        } catch (err) {
          console.warn('[publicar] busca do post no feed falhou:', err.message);
        }
      }
    }

    const pubPatch = {
      status: 'publicado',
      fb_post_id: postId,
      fb_post_url: fbPostUrl,
      published_at: new Date(),
      erro_mensagem: null,
    };
    if (nativeId) pubPatch.fb_native_post_id = nativeId;
    if (result.instagram_post_id) pubPatch.ig_post_id = String(result.instagram_post_id);
    if (result.instagram_post_url) pubPatch.ig_post_url = String(result.instagram_post_url);
    if (result.x_post_id) pubPatch.x_post_id = String(result.x_post_id);
    if (result.x_post_url) pubPatch.x_post_url = String(result.x_post_url);
    // Instagram recusado não derruba a publicação: fica registrado como aviso.
    if (result.instagram_erro) {
      pubPatch.erro_mensagem = String(result.instagram_erro).slice(0, 500);
    }
    if (result.x_erro) {
      pubPatch.erro_mensagem = [pubPatch.erro_mensagem, String(result.x_erro).slice(0, 500)]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 500);
    }
    await Publications.update(pubId, pubPatch);
    await AiMatters.update(matter.id, {
      status: 'publicado',
      published_at: new Date(),
      error_message: null,
    });
    return {
      postId,
      fbPostUrl,
      facebookPublicado: pedidoFacebook,
      instagramPublicado: Boolean(result.instagram_publicado),
      instagramPostUrl: result.instagram_post_url || null,
      instagramErro: result.instagram_erro || null,
      xPublicado: Boolean(result.x_publicado),
      xPostUrl: result.x_post_url || null,
      xErro: result.x_erro || null,
    };
  };

  if (overrides.sync) {
    try {
      const published = await executarPublicacao();
      return {
        matterId: matter.id,
        publicationId: pubId,
        queued: false,
        postId: published.postId,
        fbPostUrl: published.fbPostUrl,
        facebookPublicado: published.facebookPublicado,
        instagramPedido: pedidoInstagram,
        instagramPublicado: published.instagramPublicado,
        instagramPostUrl: published.instagramPostUrl,
        instagramErro: published.instagramErro,
        xPedido: pedidoX,
        xPublicado: published.xPublicado,
        xPostUrl: published.xPostUrl,
        xErro: published.xErro,
        avisoRepetida,
      };
    } catch (err) {
      const publishDispatch = require('./publishDispatch');
      const msg = publishDispatch.publishErrorMessage(err);
      await Publications.update(pubId, {
        status: 'erro',
        erro_mensagem: String(msg).slice(0, 500),
      });
      await Publications.increment(pubId);
      await AiMatters.update(matter.id, {
        status: 'erro',
        error_message: String(msg).slice(0, 500),
      });
      const out = new Error(msg || err.message || 'Falha ao publicar');
      out.status = err.status || err.response?.status || 502;
      out.cause = err;
      throw out;
    }
  }

  enqueue(`ai matter publish ${matter.id}`, async () => {
    try {
      await executarPublicacao();
    } catch (err) {
      const publishDispatch = require('./publishDispatch');
      const msg = publishDispatch.publishErrorMessage(err);
      await Publications.update(pubId, {
        status: 'erro',
        erro_mensagem: String(msg).slice(0, 500),
      });
      await Publications.increment(pubId);
      await AiMatters.update(matter.id, {
        status: 'erro',
        error_message: String(msg).slice(0, 500),
      });
      const out = new Error(msg || err.message || 'Falha ao publicar');
      out.status = err.status || err.response?.status || 502;
      throw out;
    }
  });

  return { matterId: matter.id, publicationId: pubId, queued: true, avisoRepetida };
}

/**
 * Fluxo unificado: apurar → gerar → salvar → (opcional) publicar.
 */
async function gerarCompleto({
  userId,
  topico,
  facebookPageId,
  tipoPublicacao = 'texto',
  status = 'rascunho',
  investigativa = false,
  furoReportagem = false,
  variacaoViral = false,
  textoEvitar = null,
  factualEstrito = false,
  exigirFonteDocumentada = false,
}) {
  const tipo = tipoPublicacao === 'foto' ? 'foto' : 'texto';
  const gerado = await gerarPreviewDeTopico(topico, {
    userId,
    facebookPageId,
    tipoPublicacao: tipo,
    investigativa,
    furoReportagem,
    variacaoViral,
    textoEvitar,
    factualEstrito,
    exigirFonteDocumentada,
  });
  const topicoApurado = gerado.topico || topico;

  let statusSalvar = status === 'publicado' ? 'pronto' : 'rascunho';
  if (gerado.forcarRascunho) statusSalvar = 'rascunho';

  const matter = await salvarMateria({
    userId,
    facebookPageId: facebookPageId || null,
    gerado,
    topico: topicoApurado,
    tipoPublicacao: tipo,
    status: statusSalvar,
  });

  let payload = {
    matter,
    artigo: {
      titulo: gerado.titulo,
      materia: gerado.materia,
      hashtags: gerado.hashtags,
      imagemUrl: gerado.imagemUrl,
      imagemOrigem: gerado.imagemOrigem || null,
      termos_imagem: gerado.termos_imagem || [],
    },
    avisos: [...(gerado.avisos || []), gerado.avisoFoto].filter(Boolean),
    qualidade: {
      chars: gerado._chars,
      ok: gerado._qualidadeOk,
      estilo: gerado._estilo,
    },
    publication: null,
    fbPostUrl: null,
  };

  // Aplica Minha marca (arte 4:5) antes de qualquer publicação.
  if (tipo === 'foto' || gerado.imagemUrl) {
    payload = await applyBrandArtworkToResult(userId, payload);
    if (payload.matter?.forcarRascunho || (tipo === 'foto' && !payload.matter?.imagem_path && !payload.artigo?.imagemUrl)) {
      /* avisos já vêm em payload.avisos */
    }
  }

  const querPublicar = status === 'publicado' && !gerado.forcarRascunho && facebookPageId;
  if (querPublicar) {
    if (tipo === 'foto' && !payload.matter?.imagem_path) {
      payload.avisos = [
        ...(payload.avisos || []),
        'A publicação não foi enviada porque a arte final não pôde ser criada.',
      ];
      return payload;
    }
    const pub = await publicarMateria(userId, payload.matter.id, {
      facebook_page_id: facebookPageId,
      tipo_publicacao: tipo,
      imagem_url: payload.artigo.imagemUrl || payload.matter.imagem_url,
      sync: true,
    });
    payload.publication = pub;
    payload.fbPostUrl = pub.fbPostUrl || null;
    payload.matter = await AiMatters.findById(payload.matter.id);
  }

  return payload;
}

async function gerarEPublicarLote({ userId, topicos, facebookPageId, tipoPublicacao = 'texto' }) {
  const page = await resolvePage(userId, facebookPageId);
  if (!page) {
    const err = new Error('Selecione uma página do Facebook válida');
    err.status = 400;
    throw err;
  }

  const lista = Array.isArray(topicos) ? topicos.slice(0, 5) : [];
  const criados = [];
  const erros = [];

  for (const topico of lista) {
    try {
      const gerado = await gerarPreviewDeTopico(topico, {
        userId,
        facebookPageId: page.id,
        tipoPublicacao,
      });
      const matter = await salvarMateria({
        userId,
        facebookPageId: page.id,
        gerado,
        topico,
        tipoPublicacao,
        status: 'pronto',
      });

      if (gerado.forcarRascunho || matter.status === 'rascunho') {
        erros.push({
          titulo: topico?.titulo || '—',
          erro: gerado.avisoFoto || 'Salvo como rascunho (foto sem imagem)',
        });
        criados.push({ matterId: matter.id, publicationId: null, titulo: gerado.titulo, rascunho: true });
        continue;
      }

      const pub = await publicarMateria(userId, matter.id, {
        facebook_page_id: page.id,
        tipo_publicacao: tipoPublicacao,
        imagem_url: gerado.imagemUrl,
      });
      criados.push({ matterId: matter.id, publicationId: pub.publicationId, titulo: gerado.titulo });
    } catch (err) {
      erros.push({ titulo: topico?.titulo || '—', erro: err.message });
    }
  }

  return { criados, erros };
}

async function criarMonitor({
  userId,
  facebookPageId,
  palavrasChave,
  intervaloMinutos = 30,
  postsPorCiclo = 1,
  tipoPublicacao = 'texto',
  inicioEm,
  fimEm,
}) {
  const page = await resolvePage(userId, facebookPageId);
  if (!page) {
    const err = new Error('Selecione uma página do Facebook válida');
    err.status = 400;
    throw err;
  }

  const intervalo = Math.max(5, Number(intervaloMinutos) || 30);
  const qtd = Math.min(Math.max(Number(postsPorCiclo) || 1, 1), 3);
  const agora = new Date();
  const inicio = inicioEm ? new Date(inicioEm) : agora;
  const [id] = await AiMonitors.create({
    user_id: userId,
    facebook_page_id: page.id,
    palavras_chave: String(palavrasChave || '').trim(),
    intervalo_minutos: intervalo,
    posts_por_ciclo: qtd,
    tipo_publicacao: tipoPublicacao === 'foto' ? 'foto' : 'texto',
    ativo: true,
    inicio_em: inicio,
    fim_em: fimEm ? new Date(fimEm) : null,
    proxima_execucao: inicio,
  });
  return AiMonitors.findById(id);
}

async function tickMonitores() {
  const due = await AiMonitors.findDue();
  for (const monitor of due) {
    try {
      if (monitor.fim_em && new Date(monitor.fim_em) < new Date()) {
        await AiMonitors.update(monitor.id, { ativo: false, ultimo_erro: 'Período encerrado' });
        continue;
      }
      if (monitor.inicio_em && new Date(monitor.inicio_em) > new Date()) continue;

      const topicosBrutos = await pesquisarNichos(monitor.palavras_chave, monitor.posts_por_ciclo, {
        periodo: '24h',
        filtrarPeriodo: true,
      });
      const topicos = (await marcarJaPublicados(monitor.user_id, monitor.facebook_page_id, topicosBrutos)).filter(
        (t) => !t.jaPublicado
      );
      const escolhidos = topicos.slice(0, monitor.posts_por_ciclo);
      if (escolhidos.length) {
        await gerarEPublicarLote({
          userId: monitor.user_id,
          topicos: escolhidos,
          facebookPageId: monitor.facebook_page_id,
          tipoPublicacao: monitor.tipo_publicacao,
        });
      }

      const proxima = new Date(Date.now() + monitor.intervalo_minutos * 60 * 1000);
      await AiMonitors.update(monitor.id, {
        ultimo_tick: new Date(),
        proxima_execucao: proxima,
        total_publicados: Number(monitor.total_publicados || 0) + escolhidos.length,
        ultimo_erro: null,
      });
    } catch (err) {
      await AiMonitors.update(monitor.id, {
        ultimo_erro: String(err.message).slice(0, 500),
        proxima_execucao: new Date(Date.now() + monitor.intervalo_minutos * 60 * 1000),
      });
    }
  }
}

async function proximoHorarioLivreAgendamento({ userId, matterId, desiredAt }) {
  let candidate = new Date(desiredAt);
  for (let i = 0; i < 288; i += 1) {
    const ocupada = await db('ai_matters')
      .where({ user_id: userId, status: 'agendado' })
      .whereNot({ id: matterId })
      .where('scheduled_at', candidate)
      .first('id');
    if (!ocupada) return candidate;
    candidate = new Date(candidate.getTime() + INTERVALO_AGENDAMENTO_MS);
  }
  return candidate;
}

async function agendarMateria({ userId, matterId, runAt }) {
  const matter = await AiMatters.findById(matterId);
  if (!matter || matter.user_id !== userId) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }
  const when = parseScheduleDate(runAt);
  if (Number.isNaN(when.getTime()) || when <= new Date()) {
    const err = new Error('Informe uma data/hora futura (horário de Araguaína / Tocantins)');
    err.status = 400;
    throw err;
  }
  const slotLivre = await proximoHorarioLivreAgendamento({ userId, matterId: matter.id, desiredAt: when });
  await AiMatters.update(matter.id, { status: 'agendado', scheduled_at: slotLivre });
  await confirmarPreAgenda(matter.id, slotLivre);

  let pageName = '';
  try {
    if (matter.facebook_page_id) {
      const page = await FacebookPages.findById(matter.facebook_page_id);
      pageName = page?.page_name || '';
    }
  } catch {
    /* ignore */
  }
  console.log(
    `[agendar] matéria #${matter.id} → "${String(matter.titulo || '').slice(0, 70)}" | ${pageName || 'página ?'} | ${formatLabelAraguaina(slotLivre) || slotLivre.toISOString()}${
      slotLivre.getTime() !== when.getTime() ? ` (ajustado de ${formatLabelAraguaina(when) || when.toISOString()})` : ''
    }`
  );

  const existing = await db('ai_fila_jobs')
    .where({ matter_id: matter.id, status: 'pendente' })
    .orderBy('id', 'desc')
    .first();
  if (existing) {
    await AiFilaJobs.update(existing.id, { run_at: slotLivre });
    return { jobId: existing.id, matterId: matter.id, runAt: slotLivre };
  }

  const [jobId] = await AiFilaJobs.create({
    user_id: userId,
    matter_id: matter.id,
    run_at: slotLivre,
    status: 'pendente',
    payload: JSON.stringify({ action: 'publish', matterId: matter.id }),
  });
  return { jobId, matterId: matter.id, runAt: slotLivre };
}

/**
 * Põe várias matérias na fila de uma vez, na ordem em que foram escolhidas.
 *
 * - agendar: a 1ª no horário de início, as outras uma a cada N minutos;
 * - publicar: a 1ª agora, as outras espaçadas — soltar todas no mesmo
 *   minuto na mesma página parece spam para o Facebook.
 *
 * Quem publica é a fila (tickFilaJobs), igual ao agendamento de uma só.
 * Matéria já publicada, de outro usuário ou sem página fica de fora, com o
 * motivo; as demais seguem.
 */
async function filaEmLote({ userId, ids, acao, facebookPageId = null, inicio = null, intervaloMinutos = 30 }) {
  const erroLote = (mensagem) => Object.assign(new Error(mensagem), { status: 400 });
  const lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 100);
  if (!lista.length) throw erroLote('Selecione ao menos uma matéria.');
  if (!['agendar', 'publicar'].includes(acao)) throw erroLote('Ação inválida.');

  // Agendar: de 10 em 10 min para cima. Publicar agora: pode ser uma atrás da outra.
  const minimo = acao === 'publicar' ? 1 : 10;
  const intervalo = Math.min(1440, Math.max(minimo, Math.trunc(Number(intervaloMinutos)) || 30));

  const resolver = require('./facebookPageResolver');
  let paginaEscolhida = null;
  if (facebookPageId) {
    const page = await resolver.resolvePageForUser(userId, facebookPageId);
    if (!page) throw erroLote('Esta página do Facebook não está ligada à sua conta.');
    paginaEscolhida = Number(page.id);
  }
  const paginaPadrao = paginaEscolhida ? null : await resolver.defaultPageIdForUser(userId).catch(() => null);

  let base = new Date();
  if (acao === 'agendar') {
    base = parseScheduleDate(inicio);
    if (Number.isNaN(base.getTime()) || base <= new Date()) {
      throw erroLote('Escolha um horário de início no futuro (horário de Brasília).');
    }
  }

  const materias = await db('ai_matters')
    .whereIn('id', lista)
    .where({ user_id: userId })
    .select('id', 'status', 'facebook_page_id', 'titulo');
  const porId = new Map(materias.map((m) => [Number(m.id), m]));

  const resultados = [];
  let posicao = 0;
  for (const id of lista) {
    const m = porId.get(id);
    if (!m) {
      resultados.push({ id, ok: false, motivo: 'Matéria não encontrada.' });
      continue;
    }
    if (m.status === 'publicado') {
      resultados.push({ id, ok: false, motivo: 'Já foi publicada.' });
      continue;
    }
    const pagina = paginaEscolhida || Number(m.facebook_page_id) || Number(paginaPadrao) || null;
    if (!pagina) {
      resultados.push({ id, ok: false, motivo: 'Sem página do Facebook: escolha uma.' });
      continue;
    }
    try {
      if (Number(m.facebook_page_id) !== pagina) await AiMatters.update(id, { facebook_page_id: pagina });
      const quando = new Date(base.getTime() + posicao * intervalo * 60_000);
      let runAt = quando;
      if (acao === 'agendar') {
        const agendado = await agendarMateria({ userId, matterId: id, runAt: quando.toISOString() });
        runAt = agendado.runAt;
        // Marca o job como do lote: o reparo de sobrepostos respeita o espaço
        // escolhido aqui em vez de empurrar tudo para 30 em 30 min.
        await AiFilaJobs.update(agendado.jobId, {
          payload: JSON.stringify({ action: 'publish', matterId: id, origem: 'lote', intervaloMinutos: intervalo }),
        });
      } else {
        await AiMatters.update(id, { status: 'agendado', scheduled_at: quando });
        await confirmarPreAgenda(id, quando);
        const pendente = await db('ai_fila_jobs').where({ matter_id: id, status: 'pendente' }).orderBy('id', 'desc').first('id');
        if (pendente) await AiFilaJobs.update(pendente.id, { run_at: quando });
        else {
          await AiFilaJobs.create({
            user_id: userId,
            matter_id: id,
            run_at: quando,
            status: 'pendente',
            payload: JSON.stringify({ action: 'publish', matterId: id, origem: 'lote', intervaloMinutos: intervalo }),
          });
        }
      }
      resultados.push({ id, ok: true, quando: runAt });
      posicao += 1;
    } catch (err) {
      resultados.push({ id, ok: false, motivo: err.message });
    }
  }

  const feitas = resultados.filter((r) => r.ok);
  console.log(`[lote] ${acao}: ${feitas.length}/${lista.length} matéria(s) na fila, uma a cada ${intervalo} min`);
  return { acao, feitas: feitas.length, falhas: resultados.filter((r) => !r.ok), resultados, intervaloMinutos: intervalo };
}

/**
 * Tira a matéria da agenda: ela volta a rascunho e o job da fila é cancelado.
 * Só mudar o status não bastava — o job pendente publicaria na hora marcada.
 * A agenda da Biblioteca também é cancelada, senão o reparo de agendamentos
 * (que a trata como fonte da verdade) remarcaria a matéria.
 */
async function desagendarMateria({ userId, matterId }) {
  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }
  if (matter.status === 'publicado') {
    const err = new Error('Esta matéria já foi publicada.');
    err.status = 409;
    throw err;
  }
  const emAndamento = await db('ai_fila_jobs')
    .where({ matter_id: matter.id, status: 'processando' })
    .first('id');
  if (emAndamento || publicandoAgora.has(Number(matter.id))) {
    const err = new Error('Esta matéria está sendo publicada agora.');
    err.status = 409;
    throw err;
  }

  await db('ai_fila_jobs')
    .where({ matter_id: matter.id, status: 'pendente' })
    .update({ status: 'cancelado', erro: 'Desagendada pelo editor.', updated_at: new Date() });
  await db('biblioteca_agenda')
    .where({ user_id: userId, matter_id: matter.id })
    .whereNotIn('status', ['cancelado', 'publicado'])
    .update({ status: 'cancelado' })
    .catch(() => {});
  await AiMatters.update(matter.id, { status: 'rascunho', scheduled_at: null });
  console.log(`[agendar] matéria #${matter.id} desagendada pelo editor — voltou a rascunho`);
  return { matterId: matter.id, status: 'rascunho' };
}

async function repararAgendamentosSobrepostos(userId, { intervaloMinutos = INTERVALO_AGENDAMENTO_MINUTOS } = {}) {
  const agora = new Date();

  // A Agenda da Biblioteca é a fonte da verdade. A compactação pode alterar
  // proposed_at; antes de listar, replica esse horário na matéria e no job.
  const agendasConfirmadas = await db('biblioteca_agenda')
    .where({ user_id: userId, status: 'confirmado' })
    .whereNotNull('matter_id')
    .whereNotNull('proposed_at')
    .where('proposed_at', '>', agora)
    .select('matter_id', 'proposed_at');

  let sincronizados = 0;
  for (const agenda of agendasConfirmadas || []) {
    const matterId = Number(agenda.matter_id);
    const horario =
      agenda.proposed_at instanceof Date ? agenda.proposed_at : new Date(agenda.proposed_at);
    if (!matterId || Number.isNaN(horario.getTime())) continue;

    const matter = await AiMatters.findById(matterId);
    const horarioMatter = matter?.scheduled_at ? new Date(matter.scheduled_at) : null;
    if (
      !matter ||
      Number(matter.user_id) !== Number(userId) ||
      String(matter.status) !== 'agendado' ||
      (horarioMatter &&
        !Number.isNaN(horarioMatter.getTime()) &&
        Math.abs(horarioMatter.getTime() - horario.getTime()) <= 60_000)
    ) {
      continue;
    }

    await AiMatters.update(matterId, { scheduled_at: horario });
    await db('ai_fila_jobs')
      .where({ matter_id: matterId, status: 'pendente' })
      .update({ run_at: horario, updated_at: db.fn.now() });
    sincronizados += 1;
  }

  const rows = await db('ai_matters')
    .where({ user_id: userId, status: 'agendado' })
    .whereNotNull('scheduled_at')
    .where('scheduled_at', '>', agora)
    .orderBy('scheduled_at', 'asc')
    .orderBy('id', 'asc')
    .select('id', 'scheduled_at');

  // A fila do Furos do dia agenda no intervalo escolhido pelo editor (ex.: 5 min):
  // não é sobreposição, então não entra no espaçamento de 30 min.
  let daFilaDoFuros = new Set();
  try {
    daFilaDoFuros = new Set(
      (await db('furos_autopilot_itens')
        .where({ user_id: userId, status: 'agendada' })
        .whereNotNull('matter_id')
        .select('matter_id')).map((r) => Number(r.matter_id))
    );
  } catch {
    // tabela ainda não existe
  }

  // Agendadas em lote ("uma a cada 15 min") e pelos Dots têm o espaço que o
  // editor escolheu: não são sobreposição. Antes eram empurradas para 30 em
  // 30 min toda vez que a aba Agendadas abria.
  let comEspacoEscolhido = new Set();
  try {
    comEspacoEscolhido = new Set(
      (await db('ai_fila_jobs')
        .where({ user_id: userId, status: 'pendente' })
        .whereNotNull('matter_id')
        .whereRaw("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.origem')) IN ('lote', 'dots')")
        .select('matter_id')).map((r) => Number(r.matter_id))
    );
  } catch (err) {
    console.warn('[agendar] origem dos jobs:', err.message);
  }

  let cursor = null;
  let ajustados = 0;
  const intervaloMs = Math.max(5, Number(intervaloMinutos) || INTERVALO_AGENDAMENTO_MINUTOS) * 60 * 1000;

  for (const row of rows || []) {
    if (daFilaDoFuros.has(Number(row.id)) || comEspacoEscolhido.has(Number(row.id))) continue;
    const atual = row.scheduled_at instanceof Date ? row.scheduled_at : new Date(row.scheduled_at);
    if (Number.isNaN(atual.getTime())) continue;
    const novo = cursor && atual.getTime() < cursor.getTime() ? cursor : atual;
    cursor = new Date(novo.getTime() + intervaloMs);
    if (novo.getTime() === atual.getTime()) continue;

    await AiMatters.update(row.id, { scheduled_at: novo });
    await db('ai_fila_jobs')
      .where({ matter_id: row.id, status: 'pendente' })
      .update({ run_at: novo, updated_at: db.fn.now() });
    await db('biblioteca_agenda')
      .where({ user_id: userId, matter_id: row.id, status: 'confirmado' })
      .update({ proposed_at: novo, updated_at: db.fn.now() });
    ajustados += 1;
  }

  if (sincronizados > 0 || ajustados > 0) {
    console.log(
      `[agendar] user #${userId}: ${sincronizados} sincronizado(s), ${ajustados} redistribuído(s) ${intervaloMinutos}m`
    );
  }
  return { ajustados, sincronizados };
}

/** Formata Date → YYYY-MM-DDTHH:mm no fuso America/Araguaina. */
function toDatetimeLocalAraguaina(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Araguaina',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

function formatLabelAraguaina(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('pt-BR', {
    timeZone: 'America/Araguaina',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatarHorarioAgendamento(scheduledAt) {
  const at = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(at.getTime())) return null;
  return {
    at: at.toISOString(),
    local: toDatetimeLocalAraguaina(at),
    label: formatLabelAraguaina(at),
  };
}

/**
 * Último horário entre matérias AGENDADAS (Minhas matérias).
 * Não usa Agenda da Biblioteca — evita misturar filas diferentes.
 * Retorna também o próximo slot sugerido (+30 min), nunca no passado.
 */
async function obterUltimoAgendamento(userId, { excludeMatterId = null } = {}) {
  let matterQuery = db('ai_matters')
    .where({ user_id: userId, status: 'agendado' })
    .whereNotNull('scheduled_at');
  if (excludeMatterId) {
    matterQuery = matterQuery.whereNot('id', Number(excludeMatterId));
  }
  const matterRow = await matterQuery
    .orderBy('scheduled_at', 'desc')
    .select('id', 'titulo', 'scheduled_at')
    .first();

  if (!matterRow?.scheduled_at) {
    return { ultimo: null, proximoSlotLocal: null, proximoSlotLabel: null };
  }

  const at = new Date(matterRow.scheduled_at);
  let proximo = new Date(at.getTime() + INTERVALO_AGENDAMENTO_MS);
  const minFuture = new Date(Date.now() + INTERVALO_AGENDAMENTO_MS);
  if (proximo.getTime() < minFuture.getTime()) proximo = minFuture;

  return {
    ultimo: {
      at: at.toISOString(),
      local: toDatetimeLocalAraguaina(at),
      label: formatLabelAraguaina(at),
      titulo: matterRow.titulo || null,
      fonte: 'materia',
      id: matterRow.id,
    },
    proximoSlotLocal: toDatetimeLocalAraguaina(proximo),
    proximoSlotLabel: formatLabelAraguaina(proximo),
  };
}

/** Interpreta agendamento no fuso America/Araguaina (UTC−3, sem horário de verão). */
function parseScheduleDate(runAt) {
  const raw = String(runAt || '').trim();
  if (!raw) return new Date(NaN);

  // Já veio em ISO com fuso (ex.: 2026-07-16T12:15:00.000Z)
  if (/Z$|[+-]\d{2}:\d{2}$/.test(raw)) {
    return new Date(raw);
  }

  // datetime-local: 2026-07-16T09:15 → trata como Araguaína (UTC-3)
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const sec = m[6] || '00';
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${sec}-03:00`);
  }

  return new Date(raw);
}

// O tick do servidor roda a cada 60 s mesmo se o anterior ainda não acabou
// (a varredura das páginas leva minutos). Duas filas ao mesmo tempo publicavam
// a MESMA matéria: uma pelo job, outra pelo "fallback" de agendadas vencidas.
let filaRodando = false;

async function tickFilaJobs() {
  if (filaRodando) return;
  filaRodando = true;
  try {
    await tickFilaJobsAgora();
  } finally {
    filaRodando = false;
  }
}

async function tickFilaJobsAgora() {
  /** Só publica se a agenda da biblioteca estiver CONFIRMADA (ou se foi agendada direto em /materias-ia). */
  async function podePublicarAgendada(matter) {
    try {
      const hasAgendaTable = await db.schema.hasTable('biblioteca_agenda');
      if (!hasAgendaTable) return { ok: true };
      const agenda = await db('biblioteca_agenda')
        .where({ matter_id: matter.id })
        .whereNotIn('status', ['cancelado'])
        .orderBy('id', 'desc')
        .first();
      // Sem item na biblioteca → veio do botão Agendar em /materias-ia (confirmação explícita)
      if (!agenda) return { ok: true };
      const st = String(agenda.status || '');
      if (st === 'confirmado' || st === 'publicado') {
        return { ok: true, agendaStatus: st };
      }
      // pendente ou qualquer outro = NÃO publica
      return {
        ok: false,
        motivo: `agenda #${agenda.id} status="${st}" — só publica depois de Confirmar`,
      };
    } catch (err) {
      console.warn('[fila] checagem agenda:', err.message);
      // Em dúvida não publica — mas também não desmarca. Antes um erro
      // passageiro de banco cancelava o agendamento de vez: a matéria voltava
      // para a lista e só saía se o editor reagendasse na mão.
      return { ok: false, adiar: true, motivo: `falha ao checar agenda: ${err.message}` };
    }
  }

  async function logPublicacao(matter, origem) {
    let pageName = '?';
    try {
      if (matter.facebook_page_id) {
        const page = await FacebookPages.findById(matter.facebook_page_id);
        pageName = page?.page_name || String(matter.facebook_page_id);
      }
    } catch {
      /* ignore */
    }
    const quando = matter.scheduled_at
      ? formatLabelAraguaina(matter.scheduled_at) || String(matter.scheduled_at)
      : '—';
    console.log(
      `[fila] ${origem} matéria #${matter.id} → "${String(matter.titulo || '').slice(0, 80)}" | página: ${pageName} | agendado para: ${quando}`
    );
  }

  async function bloquearPreAgendada(matter, motivo) {
    console.warn(
      `[fila] BLOQUEADO matéria #${matter.id} "${String(matter.titulo || '').slice(0, 60)}" — ${motivo}`
    );
    try {
      await AiMatters.update(matter.id, { status: 'pronto', scheduled_at: null });
      await db('ai_fila_jobs')
        .where({ matter_id: matter.id })
        .whereIn('status', ['pendente', 'processando'])
        .update({
          status: 'cancelado',
          erro: String(motivo).slice(0, 500),
        });
    } catch (err) {
      console.warn(`[fila] falha ao cancelar #${matter.id}:`, err.message);
    }
  }

  const jobs = await AiFilaJobs.findDue(5);
  for (const job of jobs) {
    await AiFilaJobs.update(job.id, { status: 'processando', attempts: Number(job.attempts || 0) + 1 });
    try {
      if (job.matter_id) {
        const matter = await AiMatters.findById(job.matter_id);
        if (!matter) {
          await AiFilaJobs.update(job.id, { status: 'erro', erro: 'Matéria não encontrada' });
          continue;
        }
        const check = await podePublicarAgendada(matter);
        if (!check.ok && check.adiar) {
          // Volta para a fila: tenta de novo no próximo tick.
          await AiFilaJobs.update(job.id, { status: 'pendente', erro: check.motivo });
          continue;
        }
        if (!check.ok) {
          await bloquearPreAgendada(matter, check.motivo);
          await AiFilaJobs.update(job.id, { status: 'cancelado', erro: check.motivo });
          continue;
        }
        await logPublicacao(matter, 'job');
        await publicarMateria(job.user_id, job.matter_id, { sync: true });
      }
      await AiFilaJobs.update(job.id, { status: 'feito', erro: null });
    } catch (err) {
      await AiFilaJobs.update(job.id, { status: 'erro', erro: String(err.message).slice(0, 500) });
    }
  }

  // Fallback: matérias agendadas vencidas (sem job pendente ou job perdido).
  // Matéria com job em andamento ou já feito NÃO entra: era assim que a
  // mesma matéria saía duas vezes.
  const dueMatters = await db('ai_matters')
    .where({ status: 'agendado' })
    .andWhere('scheduled_at', '<=', new Date())
    .whereNotExists(function jobVivo() {
      this.select(db.raw('1'))
        .from('ai_fila_jobs')
        .whereRaw('ai_fila_jobs.matter_id = ai_matters.id')
        .whereIn('ai_fila_jobs.status', ['pendente', 'processando', 'feito']);
    })
    .orderBy('scheduled_at', 'asc')
    .limit(5);

  for (const matter of dueMatters) {
    try {
      const check = await podePublicarAgendada(matter);
      if (!check.ok) {
        // Falha passageira não desmarca: o próximo tick tenta de novo.
        if (!check.adiar) await bloquearPreAgendada(matter, check.motivo);
        continue;
      }
      await logPublicacao(matter, 'fallback');
      await publicarMateria(matter.user_id, matter.id, { sync: true });
    } catch (err) {
      console.error(`[agendado] matéria #${matter.id}:`, err.message);
    }
  }
}

/**
 * Remove lixo do Facebook ("7.5K reactions · 150 shares | … | Autor").
 */
function limparTextoReelSocial(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';

  const isStats = (p) =>
    /reaction/i.test(p) ||
    /\bshares?\b/i.test(p) ||
    /curtida/i.test(p) ||
    /visualiza/i.test(p) ||
    /coment[aá]rio/i.test(p) ||
    /^\d[\d.,]*\s*[KkMm]?\s*(views?|likes?)$/i.test(p);

  if (t.includes('|')) {
    const parts = t
      .split(/\s*\|\s*/)
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => !isStats(p));
    if (parts.length >= 2 && parts[parts.length - 1].length < 48 && parts[0].length > 50) {
      parts.pop(); // remove autor no final
    }
    if (parts.length) t = parts.join(' ').trim();
  }

  t = t
    .replace(
      /^[\d.,]+\s*[KkMm]?\s*(reactions?|curtidas?|likes?)\s*[·•\-–]\s*[\d.,]+\s*[KkMm]?\s*(shares?|compartilhamentos?)\s*/i,
      ''
    )
    .replace(/^[|·•\-–]\s*/, '')
    .trim();

  return t;
}

/**
 * Manchete curta para Reel (capa / campo título / VARCHAR).
 * Usa a 1ª frase do texto limpo; nunca devolve a legenda inteira.
 */
function tituloCurtoReel(raw, maxLen = 100) {
  const limpo = limparTextoReelSocial(raw);
  if (!limpo) return 'Reel';

  const sentence = limpo.match(/^(.{12,}?[.!?…])(?:\s|$)/);
  let t = (sentence ? sentence[1] : limpo).trim();

  if (t.length > maxLen) {
    t = t.slice(0, maxLen);
    const sp = t.lastIndexOf(' ');
    if (sp > Math.floor(maxLen * 0.45)) t = t.slice(0, sp);
    t = `${t.replace(/[.,;:\-–—\s]+$/g, '')}…`;
  }

  return t || 'Reel';
}

/**
 * Sincroniza AiMatter (tipo reel) após download/transcrição/capa do clipe.
 */
async function syncConteudoReelMatter({ matterId, clip, video, gerado = null }) {
  if (!matterId || !clip?.id) return;
  const AiMatters = require('../models/AiMatters');
  const matter = await AiMatters.findById(matterId);
  if (!matter) return;

  const meta =
    video?.metadata && typeof video.metadata === 'object'
      ? video.metadata
      : (() => {
          try {
            return JSON.parse(video?.metadata || '{}');
          } catch {
            return {};
          }
        })();

  const titulo = tituloCurtoReel(
    gerado?.titulo || clip.capa_titulo || meta.titulo_completo || video?.titulo || matter.titulo || 'Reel',
    100
  );

  let materia =
    gerado?.materia ||
    clip.legenda_sugerida ||
    (String(matter.materia || '').startsWith('⏳') ? '' : matter.materia) ||
    '';

  if (!materia || String(materia).startsWith('⏳')) {
    // Sem legenda da IA ainda — usa texto limpo do post (sem reactions/shares)
    const fallback = limparTextoReelSocial(meta.titulo_completo || video?.titulo || '');
    materia = fallback || '⏳ Processando Reel (legenda e capa)…';
  }

  // Campo matéria não deve ser o título gigante do FB nem métricas
  if (/reaction|shares?/i.test(String(materia))) {
    materia = limparTextoReelSocial(materia) || '⏳ Processando Reel (legenda e capa)…';
  }

  // Prefere arquivo COM capa (caminho_arquivo após addCoverToClip)
  const videoPath = clip.caminho_arquivo || matter.video_path || null;
  const capaOk = clip.capa_status === 'pronta';

  const patch = {
    titulo,
    fonte_titulo: titulo.slice(0, 500),
    materia,
    tipo_publicacao: 'reel',
    video_path: videoPath,
    video_clip_id: clip.id,
    status: 'rascunho',
    error_message: null,
  };

  if (gerado?.hashtags) {
    patch.hashtags = JSON.stringify(gerado.hashtags);
  }
  if (video?.thumbnail && !matter.imagem_url) {
    patch.imagem_url = video.thumbnail;
  }

  if (!videoPath) {
    patch.materia = '⏳ Processando Reel (vídeo)…';
  } else if (!capaOk && !gerado?.materia && !clip.legenda_sugerida) {
    patch.materia = materia.startsWith('⏳')
      ? '⏳ Processando capa e legenda do Reel…'
      : materia;
  }

  if (clip.materia_status === 'erro' && !gerado?.materia) {
    patch.error_message = String(clip.erro_mensagem || 'Falha ao gerar matéria do Reel').slice(0, 500);
  }

  await AiMatters.update(matterId, patch);
  console.log(
    `[conteudo-reel] matter #${matterId} ← clip #${clip.id} video=${patch.video_path} capa=${clip.capa_status || '?'}`
  );
}

/**
 * Reel/vídeo FB/IG → AiMatter em /materias-ia (vídeo + legenda), sem fluxo de cortes na Fila.
 */
async function gerarDeLinkReel({ userId, url, facebookPageId = null }) {
  const Videos = require('../models/Videos');
  const VideoClips = require('../models/VideoClips');
  const importService = require('./importService');
  const { detectarPlataformaSocial } = require('./socialPostExtract');
  const scrapeCreators = require('./scrapeCreatorsSocial');

  const link = String(url || '').trim();
  const plataforma = detectarPlataformaSocial(link) || 'rede';

  let socialMeta = null;
  if (scrapeCreators.isConfigured() && (plataforma === 'instagram' || plataforma === 'facebook')) {
    try {
      socialMeta = await scrapeCreators.extrairPost(link, plataforma);
    } catch (socialErr) {
      console.warn('[conteudo-reel] scrapecreators:', socialErr.message);
    }
  }

  let meta = {
    titulo: null,
    thumbnail: null,
    extractor: null,
    autor: null,
    autorUrl: null,
    duracao: null,
  };
  let metaWarning = null;
  // Quando a ScrapeCreators já entregou a mídia, evita uma chamada yt-dlp que costuma
  // falhar com HTTP 400 no Instagram. A duração será obtida pelo ffprobe após o download.
  if (!socialMeta?.videoUrl) {
    try {
      meta = await importService.fetchLinkMetadata(link);
    } catch (metaErr) {
      metaWarning = importService.humanizeYtDlpError(metaErr);
      console.warn('[conteudo-reel] metadata:', metaWarning);
    }
  }

  if (socialMeta) {
    meta = {
      ...meta,
      description: socialMeta.texto || meta.description || null,
      titulo: socialMeta.titulo || meta.titulo || null,
      thumbnail: socialMeta.imagem || meta.thumbnail || null,
      autor: socialMeta.veiculo || meta.autor || null,
      autorUrl: socialMeta.autorUrl || meta.autorUrl || null,
      extractor: [socialMeta.metodo, meta.extractor].filter(Boolean).join('+') || null,
    };
  }

  const tituloBruto = meta.description || meta.titulo || `Reel — ${plataforma}`;
  // Prefere o texto mais longo entre title e description (FB costuma meter a legenda em um dos dois)
  const candidatosTexto = [meta.description, meta.titulo]
    .filter(Boolean)
    .map((t) => limparTextoReelSocial(t))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const textoLimpo = candidatosTexto[0] || limparTextoReelSocial(tituloBruto);
  const titulo = tituloCurtoReel(textoLimpo || `Reel — ${plataforma}`, 100);

  // Reaproveita vídeo já importado deste link
  let video = await Videos.findByUrl(userId, link);
  let createdVideo = false;

  if (!video) {
    const [vid] = await Videos.create({
      user_id: userId,
      origem: 'link',
      termo_busca: `reel:${plataforma}`.slice(0, 255),
      titulo: titulo || `Reel — ${plataforma}`,
      url_original: link,
      thumbnail: meta.thumbnail || null,
      duracao: meta.duracao,
      autor: meta.autor ? String(meta.autor).slice(0, 255) : null,
      autor_url: meta.autorUrl ? String(meta.autorUrl).slice(0, 500) : null,
      status: 'pendente',
      metadata: {
        extractor: meta.extractor,
        pipeline: 'conteudo_reel',
        facebook_page_id: facebookPageId || null,
        metaWarning,
        plataforma,
        titulo_completo: textoLimpo.slice(0, 2000) || String(tituloBruto).slice(0, 2000),
      },
    });
    video = await Videos.findById(vid);
    createdVideo = true;
  } else {
    const metaBase =
      video.metadata && typeof video.metadata === 'object' ? video.metadata : {};
    const tituloSujo =
      /reaction|shares?/i.test(String(video.titulo || '')) ||
      String(video.titulo || '').length > 120;
    const patchVideo = {
      metadata: {
        ...metaBase,
        extractor: meta.extractor || metaBase.extractor || null,
        titulo_completo:
          textoLimpo.slice(0, 2000) ||
          metaBase.titulo_completo ||
          String(tituloBruto).slice(0, 2000),
      },
    };
    if (socialMeta || tituloSujo) patchVideo.titulo = titulo;
    if (socialMeta?.imagem) patchVideo.thumbnail = socialMeta.imagem;
    if (socialMeta?.veiculo) patchVideo.autor = String(socialMeta.veiculo).slice(0, 255);
    if (socialMeta?.autorUrl) patchVideo.autor_url = String(socialMeta.autorUrl).slice(0, 500);

    await Videos.update(video.id, patchVideo);
    video = await Videos.findById(video.id);
  }

  // Matter existente já vinculada a este link?
  let matter = null;
  const existingMatters = await AiMatters.findByUser(userId, 80);
  matter = existingMatters.find(
    (m) => m.tipo_publicacao === 'reel' && String(m.fonte_url || '') === link
  );
  if (!matter && video?.id) {
    const clips = await VideoClips.findByVideo(video.id);
    const clipIds = new Set(clips.map((c) => Number(c.id)));
    matter = existingMatters.find((m) => m.video_clip_id && clipIds.has(Number(m.video_clip_id)));
  }

  if (!matter) {
    const [matterId] = await AiMatters.create({
      user_id: userId,
      facebook_page_id: facebookPageId || null,
      titulo,
      materia:
        '⏳ Processando Reel: baixando o vídeo, transcrevendo a fala, gerando a legenda e aplicando a capa (Minha marca) no início…',
      hashtags: JSON.stringify([]),
      fonte_titulo: titulo,
      fonte_url: link,
      fonte_resumo: textoLimpo.slice(0, 1500) || null,
      fonte_credito: null,
      status: 'rascunho',
      tipo_publicacao: 'reel',
      imagem_url: meta.thumbnail || video.thumbnail || null,
      video_path: null,
      video_clip_id: null,
      error_message: null,
    });
    matter = await AiMatters.findById(matterId);
  } else {
    // Sempre normaliza os metadados da fonte e limpa lixo de tentativas anteriores.
    const patchLimpeza = {
      titulo,
      fonte_titulo: titulo,
      fonte_resumo: textoLimpo.slice(0, 1500) || matter.fonte_resumo || null,
      imagem_url: meta.thumbnail || matter.imagem_url || null,
    };
    if (
      /reaction|shares?/i.test(String(matter.materia || '')) ||
      String(matter.materia || '').length > 900
    ) {
      patchLimpeza.materia =
        '⏳ Processando Reel: baixando o vídeo, transcrevendo a fala e gerando a legenda…';
    }
    if (matter.error_message) {
      patchLimpeza.error_message = null;
    }
    await AiMatters.update(matter.id, patchLimpeza);
    matter = await AiMatters.findById(matter.id);
  }

  // Já tem clipe pronto → sincroniza; se faltar matéria, reenfileira (capa é opcional)
  if (video.caminho_local && (video.status === 'baixado' || video.status === 'cortado')) {
    const clips = await VideoClips.findByVideo(video.id);
    const pronto = clips.find((c) => c.status === 'pronto' && c.caminho_arquivo);
    if (pronto) {
      const precisaRefazer =
        pronto.materia_status !== 'pronta' ||
        !pronto.legenda_sugerida;

      if (precisaRefazer) {
        const metaBase =
          video.metadata && typeof video.metadata === 'object' ? video.metadata : {};
        await Videos.update(video.id, {
          metadata: {
            ...metaBase,
            pipeline: 'conteudo_reel',
            matter_id: matter.id,
            facebook_page_id: facebookPageId || metaBase.facebook_page_id || null,
            titulo_completo:
              metaBase.titulo_completo ||
              textoLimpo.slice(0, 2000) ||
              String(tituloBruto).slice(0, 2000),
          },
        });
        const { queueClipMateriaAndCover } = require('./clipPostProcessService');
        queueClipMateriaAndCover(pronto, await Videos.findById(video.id), {
          userId,
          force: true,
        });
        await AiMatters.update(matter.id, {
          error_message: null,
          materia: String(matter.materia || '').startsWith('⏳')
            ? matter.materia
            : '⏳ Gerando legenda e capa do Reel…',
          video_clip_id: pronto.id,
          video_path: pronto.caminho_arquivo || null,
        });
        return {
          modo: 'reel',
          queued: true,
          created: createdVideo,
          video,
          clip: pronto,
          matter: await AiMatters.findById(matter.id),
          redirect: `/materias-ia/${matter.id}`,
          aviso: 'Reel encontrado — gerando legenda e capa (Minha marca) no início do vídeo.',
        };
      }

      await syncConteudoReelMatter({
        matterId: matter.id,
        clip: pronto,
        video,
        gerado: pronto.legenda_sugerida
          ? { titulo: pronto.capa_titulo, materia: pronto.legenda_sugerida }
          : null,
      });
      matter = await AiMatters.findById(matter.id);
      return {
        modo: 'reel',
        queued: false,
        created: createdVideo,
        video,
        clip: pronto,
        matter,
        redirect: `/materias-ia/${matter.id}`,
        aviso: 'Reel pronto — revise a legenda e publique como Reels.',
      };
    }
  }

  // Guarda matter_id no vídeo para o pós-processo sincronizar
  const metaBase =
    video.metadata && typeof video.metadata === 'object'
      ? video.metadata
      : {};
  await Videos.update(video.id, {
    metadata: {
      ...metaBase,
      pipeline: 'conteudo_reel',
      matter_id: matter.id,
      facebook_page_id: facebookPageId || metaBase.facebook_page_id || null,
      plataforma,
      scrapecreators_video_url:
        socialMeta?.videoUrl || metaBase.scrapecreators_video_url || null,
      titulo_completo: metaBase.titulo_completo || String(tituloBruto).slice(0, 2000),
    },
  });
  video = await Videos.findById(video.id);

  importService.queueLinkImportAsReel(video, {
    facebookPageId,
    matterId: matter.id,
  });

  return {
    modo: 'reel',
    queued: true,
    created: createdVideo,
    video,
    matter,
    redirect: `/materias-ia/${matter.id}`,
    aviso:
      'Reel enfileirado. A página da matéria atualiza sozinha quando o vídeo, a legenda e a capa ficarem prontos.',
  };
}

/**
 * Usuário cola um link → apura a notícia OU post FB/IG → reescreve com furo (sem plagiar).
 * Reels/vídeos FB/IG → AiMatter em /materias-ia (vídeo + legenda + capa).
 */
async function gerarDeLink({
  userId,
  url,
  facebookPageId = null,
  tipoPublicacao = 'foto',
  status = 'rascunho',
  textoManual = '',
  imagemManual = '',
}) {
  const link = String(url || '').trim();
  if (!/^https?:\/\//i.test(link)) {
    const err = new Error('Informe um link válido (http ou https)');
    err.status = 400;
    throw err;
  }

  const {
    isSocialPostUrl,
    isSocialVideoUrl,
    extrairPostSocial,
    socialParaTopico,
  } = require('./socialPostExtract');

  // Reel / vídeo social → Fila (não vira AiMatter foto)
  if (isSocialVideoUrl(link) || tipoPublicacao === 'reel') {
    if (!isSocialVideoUrl(link) && tipoPublicacao === 'reel') {
      const err = new Error(
        'Para publicar como Reel, use um link de vídeo/Reel do Facebook ou Instagram.'
      );
      err.status = 422;
      throw err;
    }
    return gerarDeLinkReel({ userId, url: link, facebookPageId });
  }

  assertDeepseek();

  const tipoFinal = tipoPublicacao === 'auto' || tipoPublicacao === 'reel' ? 'foto' : tipoPublicacao;

  let apurado;
  if (isSocialPostUrl(link)) {
    const social = await extrairPostSocial(link, { textoManual, imagemManual });
    apurado = socialParaTopico(social, link);
    console.log('[materias-ia] post social', {
      plataforma: social.plataforma,
      metodo: social.metodo,
      textoLen: (social.texto || '').length,
      hasImage: Boolean(social.imagem),
    });

    // Nunca gerar matéria social sem legenda suficiente (evita alucinação).
    // O extrator manual já exige 40 caracteres; mantenha o mesmo limite aqui.
    if (String(social.texto || '').trim().length < 40) {
      const err = new Error(
        'A legenda deste post está vazia ou é muito curta para gerar uma matéria sem inventar informações. Cole o texto completo da postagem no campo auxiliar e tente de novo.'
      );
      err.status = 422;
      throw err;
    }
  } else {
    const topicoBase = {
      link,
      titulo: null,
      resumo: null,
      fonte: null,
    };
    apurado = await apurarTopico(topicoBase);
  }

  const temConteudo =
    Boolean(apurado.titulo) ||
    Boolean(apurado.resumo) ||
    Boolean(apurado.imagemFonte) ||
    Boolean(apurado.fontesApuracao?.length) ||
    Boolean(apurado.contextoApuracao && apurado.contextoApuracao.length > 80);

  if (!temConteudo) {
    const err = new Error(
      'Não foi possível ler este link. Use notícia, post público do Facebook ou Instagram (foto) — ou Reel/vídeo para publicar como Reels.'
    );
    err.status = 422;
    throw err;
  }

  if (!apurado.titulo) {
    apurado.titulo = apurado.veiculo
      ? `Notícia — ${apurado.veiculo}`
      : 'Notícia a partir do link';
  }

  return gerarCompleto({
    userId,
    topico: apurado,
    facebookPageId,
    tipoPublicacao: tipoFinal,
    status,
    furoReportagem: true,
  });
}

/**
 * Nova matéria no mesmo tema (anti-plágio + curiosidade), complementando com Brave/Serper.
 * Ex.: original fala do fato → variação pergunta "por que a pastora afirmou isso".
 */
async function gerarVariacaoDeMateria({
  userId,
  matterId,
  facebookPageId = null,
  tipoPublicacao = null,
}) {
  assertDeepseek();
  const matter = await AiMatters.findById(matterId);
  if (!matter) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }
  if (Number(matter.user_id) !== Number(userId)) {
    const ok = await AiMatters.matterAcessivelPelaConta(userId, matter);
    if (!ok) {
      const err = new Error('Matéria não encontrada');
      err.status = 404;
      throw err;
    }
  }

  const pageId = facebookPageId || matter.facebook_page_id || null;
  const tipo =
    tipoPublicacao === 'foto' || tipoPublicacao === 'texto'
      ? tipoPublicacao
      : matter.tipo_publicacao === 'foto'
        ? 'foto'
        : 'texto';

  const tituloOrig = String(matter.titulo || matter.fonte_titulo || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!tituloOrig) {
    const err = new Error('A matéria precisa de um título para gerar variação');
    err.status = 400;
    throw err;
  }

  const corpoOrig = String(matter.materia || '')
    .replace(/\n*Fontes:[\s\S]*$/i, '')
    .replace(/\n*Por\s+.+\s*[—\-–]\s*Site\s*:.+$/im, '')
    .replace(/#[\wÀ-ÿ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Extrai pessoa + aspas para buscas melhores
  const aspas = [...corpoOrig.matchAll(/[“"]([^”"]{12,160})[”"]/g)].map((m) => m[1].trim());
  const pessoaMatch = tituloOrig.match(
    /(?:pastora|pastor|cantor|atriz|ator|bispo|mission[aá]ri[oa])\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.-]+){0,3})/i
  ) || corpoOrig.match(
    /(?:pastora|pastor|cantor|atriz|ator|bispo)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.-]+){0,3})/i
  );
  const pessoa = pessoaMatch?.[1]?.trim() || null;
  const falaChave = aspas[0] || null;

  const { coletarFontesComplementares, apurarTopico } = require('./articleSource');
  let fontesExtras = [];
  const queries = [
    pessoa && falaChave ? `${pessoa} ${falaChave.slice(0, 60)}` : null,
    pessoa ? `${pessoa} declaração igreja política` : null,
    `${tituloOrig}`.slice(0, 100),
  ].filter(Boolean);

  for (const q of queries.slice(0, 2)) {
    try {
      const mais = await coletarFontesComplementares({
        titulo: q,
        resumo: corpoOrig.slice(0, 180),
        linkExcluir: matter.fonte_url,
        max: 3,
      });
      fontesExtras = [...fontesExtras, ...mais];
    } catch (err) {
      console.warn('gerarVariacaoDeMateria Brave:', err.message);
    }
  }
  // Dedup por URL
  const vistos = new Set();
  fontesExtras = fontesExtras.filter((f) => {
    const k = String(f.url || f.titulo || '').toLowerCase();
    if (!k || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  }).slice(0, 5);

  const blocoExtras = fontesExtras
    .map(
      (f, i) =>
        `Fonte nova ${i + 1} (${f.veiculo || 'Web'}): ${f.titulo || ''}\n${String(f.trecho || f.resumo || '').slice(0, 1400)}`
    )
    .join('\n\n');

  const angulos = [
    pessoa
      ? `Por que ${pessoa} afirmou isso? Explique o motivo e o contexto da declaração.`
      : 'Por que essa declaração gerou repercussão? Foque no motivo e no contexto.',
    pessoa
      ? `O detalhe da fala de ${pessoa} que mais chamou atenção — e o que isso muda para o fiel.`
      : 'O detalhe da declaração que mais gerou debate nas redes.',
    'Qual o impacto espiritual e político dessa fala em ano eleitoral — sem partidarizar a fé.',
  ];
  const anguloEscolhido = angulos[Math.floor(Math.random() * angulos.length)];

  const topicoBase = {
    // Título-seed só para apuração; a IA deve inventar manchete curiosa
    titulo: pessoa
      ? `${pessoa} declaração polêmica igreja`
      : tituloOrig.slice(0, 80),
    link: matter.fonte_url || null,
    resumo: [
      `Fato central: ${tituloOrig}`,
      falaChave ? `Fala documentada: "${falaChave}"` : null,
      `Ângulo pedido para ESTA variação: ${anguloEscolhido}`,
    ]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 500),
    fonte: matter.fonte_titulo || null,
    veiculo: null,
    imagemFonte:
      matter.imagem_fonte_url ||
      (matter.imagem_url && /^https?:\/\//i.test(matter.imagem_url) ? matter.imagem_url : null),
    nicho: 'variação viral curiosidade',
    contextoApuracao: [
      `MODO: segunda matéria no mesmo tema (post viral). NÃO copie a primeira.`,
      `ÂNGULO OBRIGATÓRIO DESTA VERSÃO: ${anguloEscolhido}`,
      `Título da matéria anterior (NÃO repetir): ${tituloOrig}`,
      falaChave ? `Aspas reais a preservar (curtas): "${falaChave}"` : null,
      `Fatos da matéria anterior (só referência, reescreva tudo):\n${corpoOrig.slice(0, 900)}`,
      blocoExtras
        ? `NOVAS INFORMAÇÕES DA INTERNET (priorizar no lead se forem relevantes):\n${blocoExtras}`
        : 'Sem fontes novas na busca — mude o ÂNGULO (curiosidade/motivo/impacto), sem inventar fatos.',
      'Título final deve causar curiosidade (por que / o que / o detalhe / afirmação que…).',
      'Corpo: outra ordem de ideias; lead de curiosidade; desenvolvimento; fechamento de fé.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    fontesApuracao: fontesExtras,
    furoReportagem: true,
    traduzirFonte: true,
    idiomaObrigatorio: 'pt-BR',
  };

  let apurado = topicoBase;
  try {
    apurado = await apurarTopico(topicoBase);
    apurado.contextoApuracao = [
      topicoBase.contextoApuracao,
      apurado.contextoApuracao && apurado.contextoApuracao !== topicoBase.contextoApuracao
        ? apurado.contextoApuracao
        : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    // Não deixar a apuração substituir o ângulo pelo título antigo
    apurado.titulo = topicoBase.titulo;
    apurado.resumo = topicoBase.resumo;
  } catch (err) {
    console.warn('gerarVariacaoDeMateria apurar:', err.message);
  }

  const result = await gerarCompleto({
    userId,
    topico: apurado,
    facebookPageId: pageId,
    tipoPublicacao: tipo,
    status: 'rascunho',
    furoReportagem: true,
    variacaoViral: true,
    textoEvitar: `${tituloOrig}\n\n${corpoOrig}`.slice(0, 2500),
  });

  return {
    ...result,
    origemMatterId: matter.id,
    fontesNovas: fontesExtras.length,
    angulo: anguloEscolhido,
  };
}

/**
 * Matéria manual: usuário informa fatos (+ imagem opcional) → IA gera título/legenda + capa Minha marca.
 */
async function gerarMateriaManual({
  userId,
  informacoes,
  angulo = null,
  tom = 'natural',
  facebookPageId = null,
  imagemBuffer = null,
  imagemUrl = null,
  creditoImagem = null,
  pesquisarWeb = false,
  palavrasChave = null,
  periodo = '30d',
  fonteBase = null,
}) {
  assertDeepseek();
  const fatos = String(informacoes || '').trim();
  if (fatos.length < 20) {
    const err = new Error('Descreva as informações da matéria (mín. ~20 caracteres)');
    err.status = 400;
    throw err;
  }

  const pageId = facebookPageId || null;
  if (pageId) {
    const page = await resolvePage(userId, pageId);
    if (!page) {
      const err = new Error('Página do Facebook inválida');
      err.status = 400;
      throw err;
    }
  }

  const deepseekService = require('./deepseekService');
  const {
    montarRodapeMateriaComFontes,
    removerFechamentoOracao,
  } = require('./editorialGuidelinesFb');

  const avisos = [];
  let userBrand = null;
  try {
    const Users = require('../models/Users');
    userBrand = await Users.findById(userId);
  } catch {
    /* ignore */
  }
  let fontesPesquisa = [];
  let consultasUsadas = [];
  const fonteSelecionada =
    fonteBase && typeof fonteBase === 'object' && (fonteBase.url || fonteBase.titulo || fonteBase.resumo)
      ? {
          veiculo: String(fonteBase.veiculo || 'Web').trim().slice(0, 120),
          titulo: String(fonteBase.titulo || '').trim().slice(0, 500),
          url: /^https?:\/\//i.test(String(fonteBase.url || '').trim())
            ? String(fonteBase.url).trim().slice(0, 1000)
            : null,
          resumo: String(fonteBase.resumo || '').trim().slice(0, 2500),
          trecho: String(fonteBase.resumo || '').trim().slice(0, 5000),
          data: String(fonteBase.data || '').trim().slice(0, 80) || null,
          dataTimestamp: Number(fonteBase.dataTimestamp) || null,
          fonteSelecionada: true,
        }
      : null;

  // O pedido pode desligar a busca no próprio texto ("não pesquise na internet")
  const pediuSemPesquisa =
    /\b(n[ãa]o\s+(pesquis|busqu|procur)|sem\s+(pesquis|busca|buscar|internet)|apenas\s+com\s+(essas|estas)\s+informa)/i.test(
      fatos
    );
  let usarPesquisa = Boolean(pesquisarWeb);
  if (usarPesquisa && pediuSemPesquisa) {
    usarPesquisa = false;
    avisos.push('Você pediu para não pesquisar na internet — usei só as suas informações.');
  }

  if (usarPesquisa) {
    const manual = String(palavrasChave || '').trim();
    let sugeridas = [];
    try {
      const sug = await deepseekService.sugerirConsultasPesquisa({
        pedido: fatos,
        angulo,
        palavrasChave: manual || null,
      });
      sugeridas = sug.consultas || [];
    } catch (err) {
      console.warn('[materia-manual] consultas IA:', err.message);
    }
    consultasUsadas = [manual, ...sugeridas, consultaDeTexto(fatos), fatos.slice(0, 120)]
      .map((q) => String(q || '').replace(/\s+/g, ' ').trim())
      .filter((q, i, arr) => q.length >= 8 && arr.indexOf(q) === i)
      .slice(0, 4);

    fontesPesquisa = await coletarFatosNaWeb({
      consultas: consultasUsadas,
      periodo: periodo || '30d',
      resumoContexto: fatos.replace(/\s+/g, ' ').trim().slice(0, 160),
      max: 6,
      logPrefix: '[materia-manual]',
    });

    if (fonteSelecionada) {
      const urlBase = String(fonteSelecionada.url || '').replace(/\/$/, '').toLowerCase();
      fontesPesquisa = [
        fonteSelecionada,
        ...fontesPesquisa.filter((fonte) => {
          const url = String(fonte?.url || '').replace(/\/$/, '').toLowerCase();
          return !urlBase || !url || url !== urlBase;
        }),
      ];
      fontesPesquisa = priorizarFontesIndependentes(fontesPesquisa, 6);
    }

    if (!fontesPesquisa.length) {
      const err = new Error(
        'A pesquisa na web não achou reportagens sobre isso. Ajuste as palavras-chave, aumente o período ou desmarque "Pesquisar na internet" para gerar só com as suas informações.'
      );
      err.status = 422;
      throw err;
    }
  } else if (fonteSelecionada) {
    fontesPesquisa = [fonteSelecionada];
  }

  const gerado = usarPesquisa
    ? await deepseekService.gerarMateriaComPesquisa({
        pedido: fatos,
        fatosFontes: fontesPesquisa.length ? montarBlocoFatos(fontesPesquisa) : null,
        angulo,
        tom,
        autor: creditoImagem || null,
        marcaModeloArte: userBrand?.marca_modelo_arte || null,
      })
    : await deepseekService.gerarMateriaImagem({
        informacoes: fatos,
        promptUsuario: angulo || 'notícia gospel a partir das informações do usuário',
        descricaoImagem: null,
        autor: creditoImagem || null,
        tom,
        marcaModeloArte: userBrand?.marca_modelo_arte || null,
      });

  if (gerado.aviso) avisos.push(gerado.aviso);

  let pageName = null;
  if (pageId) {
    try {
      const page = await FacebookPages.findById(pageId);
      pageName = page?.page_name || null;
    } catch {
      /* ignore */
    }
  }
  const fontePrincipal = fontesPesquisa[0] || null;
  const fontesRodape = fontesPesquisa.length
    ? fontesPesquisa
    : pageName
      ? [{ veiculo: pageName, url: null }]
      : [];

  const rodape = montarRodapeMateriaComFontes({
    materia: gerado.materia,
    fontes: fontesRodape,
    creditoImagem: creditoImagem || 'Reprodução',
    hashtags: gerado.hashtags || [],
  });
  let materiaComFontes = removerFechamentoOracao(rodape.materia);

  const [matterId] = await AiMatters.create({
    user_id: userId,
    facebook_page_id: pageId || null,
    titulo: gerado.titulo || 'Matéria manual',
    materia: materiaComFontes,
    titulo_ia: gerado.titulo || null,
    materia_ia: materiaComFontes,
    hashtags: JSON.stringify(gerado.hashtags || []),
    fonte_titulo:
      fonteSelecionada?.titulo ||
      fontePrincipal?.titulo ||
      fonteSelecionada?.veiculo ||
      (usarPesquisa ? 'Pesquisa na web' : 'Conteúdo enviado pelo editor'),
    fonte_url: fontePrincipal?.url || null,
    fonte_resumo: (fonteSelecionada?.resumo || fatos).slice(0, 1500),
    contexto_apuracao: fontesPesquisa.length
      ? montarBlocoFatos(fontesPesquisa).slice(0, 8000)
      : null,
    fonte_credito: rodape.fonteCredito || null,
    status: 'rascunho',
    tipo_publicacao: 'foto',
    imagem_url: imagemUrl && /^https?:\/\//i.test(imagemUrl) ? imagemUrl : null,
    error_message: null,
  });

  let matter = await AiMatters.findById(matterId);
  const { storeMatterSourceImage, composeMatterArtwork } = require('./matterArtworkService');

  if (imagemBuffer && Buffer.isBuffer(imagemBuffer) && imagemBuffer.length) {
    const stored = await storeMatterSourceImage({
      userId,
      matterId,
      buffer: imagemBuffer,
    });
    const artwork = await composeMatterArtwork({
      userId,
      matterId,
      sourceUrl: stored.publicUrl,
      title: matter.titulo,
      force: true,
    });
    matter = artwork.matter;
  } else if (imagemUrl && /^https?:\/\//i.test(imagemUrl)) {
    try {
      const artwork = await composeMatterArtwork({
        userId,
        matterId,
        sourceUrl: imagemUrl,
        title: matter.titulo,
        force: true,
      });
      matter = artwork.matter;
    } catch (err) {
      console.warn('gerarMateriaManual arte URL:', err.message);
      await AiMatters.update(matterId, {
        imagem_url: imagemUrl,
        imagem_fonte_url: imagemUrl,
        error_message: `Arte: ${String(err.message).slice(0, 200)}`,
      });
      matter = await AiMatters.findById(matterId);
    }
  }

  if (!matter.imagem_path && !matter.imagem_url) {
    avisos.push('Matéria gerada sem capa. Envie uma imagem na edição para criar a arte.');
  }

  return {
    matter,
    artigo: {
      titulo: matter.titulo,
      materia: matter.materia,
      hashtags: gerado.hashtags || [],
      imagemUrl: matter.imagem_url,
    },
    pesquisa: {
      ativa: usarPesquisa,
      consultas: consultasUsadas,
      fontes: fontesPesquisa.map((f) => ({
        veiculo: f.veiculo,
        titulo: f.titulo,
        url: f.url,
      })),
      fatosUsados: gerado.fatosUsados || [],
    },
    avisos,
  };
}

/**
 * Atualiza engajamento do post Facebook ligado à matéria (views + curtidas + comentários).
 * 1) Graph OAuth (Insights + reactions/comments) quando a Página tem token.
 * 2) Fallback ScrapeCreators no permalink público (sem OAuth).
 */
async function atualizarViewsDaMateria(userId, matterId, { force = false } = {}) {
  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }
  if (!matter.publication_id) {
    return { views: null, likes: null, comments: null, message: 'Matéria ainda sem publicação no Facebook' };
  }

  const pub = await Publications.findById(matter.publication_id);
  if (!pub) {
    return { views: null, likes: null, comments: null, message: 'Publicação não encontrada' };
  }

  const STALE_MS = 30 * 60 * 1000;
  const STALE_ZERO_MS = 5 * 60 * 1000;
  // Só considera "tem engajamento" se pelo menos um valor foi gravado (inclui 0 real).
  // Antes Number(null) na UI fingia 0 e o cache de zeros impedia nova leitura.
  const hasEng =
    pub.fb_likes != null || pub.fb_comments != null || pub.fb_views != null;
  const allZero =
    (pub.fb_likes == null || Number(pub.fb_likes) === 0) &&
    (pub.fb_comments == null || Number(pub.fb_comments) === 0) &&
    (pub.fb_views == null || Number(pub.fb_views) === 0);
  const staleLimit = allZero ? STALE_ZERO_MS : STALE_MS;
  if (
    !force &&
    hasEng &&
    pub.fb_views_at &&
    Date.now() - new Date(pub.fb_views_at).getTime() < staleLimit
  ) {
    return {
      views: pub.fb_views != null ? Number(pub.fb_views) : null,
      likes: pub.fb_likes != null ? Number(pub.fb_likes) : null,
      comments: pub.fb_comments != null ? Number(pub.fb_comments) : null,
      shares: pub.fb_shares != null ? Number(pub.fb_shares) : null,
      cached: true,
      viewsAt: pub.fb_views_at,
      postId: pub.fb_native_post_id || pub.fb_post_id,
      viral: classificarViral(pub),
    };
  }

  const page = await resolvePage(userId, pub.facebook_page_id || matter.facebook_page_id);
  const token = String(page?.page_access_token || '');
  const hasGraphToken =
    Boolean(token) &&
    !token.startsWith('postsyncer:') &&
    !token.startsWith('postpulse:') &&
    !token.startsWith('ayrshare:');

  const ayrshareService = require('./ayrshareService');
  const profileKey = String(page?.ayrshare_profile_key || '').trim() || null;

  let nativeId =
    pub.fb_native_post_id ||
    facebookService.parseFacebookPostId(pub.fb_post_url) ||
    facebookService.parseFacebookPostId(pub.fb_post_id);

  const fbPostId = String(pub.fb_post_id || '');
  if (!nativeId && /^postsyncer:/i.test(fbPostId)) {
    try {
      const postsyncerService = require('./postsyncerService');
      const psPost = await postsyncerService.getPost(fbPostId);
      const summary = postsyncerService.platformStatusSummary(psPost);
      nativeId =
        facebookService.parseFacebookPostId(summary.postedOn) ||
        facebookService.parseFacebookPostId(psPost?.permalink) ||
        facebookService.parseFacebookPostId(psPost?.url) ||
        null;
      if (nativeId) {
        await Publications.update(pub.id, { fb_native_post_id: nativeId });
      }
    } catch (err) {
      console.warn('atualizarEngajamento PostSyncer:', err.message);
    }
  }

  // UUID Ayrshare não é ID do Graph — limpa nativeId falso
  if (nativeId && ayrshareService.looksLikeAyrshareId(nativeId)) {
    nativeId = null;
  }

  let views = pub.fb_views != null ? Number(pub.fb_views) : null;
  let likes = pub.fb_likes != null ? Number(pub.fb_likes) : null;
  let comments = pub.fb_comments != null ? Number(pub.fb_comments) : null;
  let shares = pub.fb_shares != null ? Number(pub.fb_shares) : null;
  let fonte = null;
  const avisos = [];

  // Publicação por provedor externo pode não ter gravado ID nenhum.
  // Com token da Página, acha o post no feed pelo texto/horário e grava o ID nativo.
  if (!nativeId && hasGraphToken && page?.page_id) {
    try {
      const found = await facebookService.findPagePostByContent(
        page.page_access_token,
        page.page_id,
        {
          message: pub.texto || matter.materia || matter.titulo || '',
          publishedAt: pub.published_at || matter.published_at || null,
        }
      );
      if (found?.id) {
        nativeId = found.id;
        const patchFound = { fb_native_post_id: found.id };
        if (!pub.fb_post_url) {
          patchFound.fb_post_url =
            found.permalink ||
            `https://www.facebook.com/${String(found.id).replace('_', '/posts/')}`;
          pub.fb_post_url = patchFound.fb_post_url;
        }
        await Publications.update(pub.id, patchFound);
        pub.fb_native_post_id = found.id;
        fonte = 'feed';
      } else {
        avisos.push('Post não localizado no feed da Página pelo texto/horário.');
      }
    } catch (err) {
      avisos.push(`Busca do post no feed: ${err.message}`);
    }
  }

  // 1) Graph API
  if (
    hasGraphToken &&
    nativeId &&
    !/^postsyncer:/i.test(String(nativeId)) &&
    !/^postpulse:/i.test(String(nativeId)) &&
    !/^ayrshare:/i.test(String(nativeId))
  ) {
    let insightId = nativeId;
    if (/^\d+$/.test(nativeId) && page.page_id) {
      insightId = `${page.page_id}_${nativeId}`;
    }

    try {
      let eng = await facebookService.fetchPostEngagement(page.page_access_token, insightId);
      if (eng.likes == null && eng.comments == null && insightId !== nativeId) {
        eng = await facebookService.fetchPostEngagement(page.page_access_token, nativeId);
      }
      if (eng.likes != null) likes = eng.likes;
      if (eng.comments != null) comments = eng.comments;
      if (eng.shares != null) shares = eng.shares;
      if (eng.postId) nativeId = eng.postId;
      fonte = 'graph';
    } catch (err) {
      avisos.push(`Graph engajamento: ${err.message}`);
    }

    try {
      let result = await facebookService.fetchPostViews(page.page_access_token, insightId);
      if (result.views == null && insightId !== nativeId) {
        result = await facebookService.fetchPostViews(page.page_access_token, nativeId);
      }
      if (result.views != null) views = result.views;
      if (result.postId) nativeId = result.postId;
      fonte = fonte || 'graph';
    } catch (err) {
      avisos.push(`Graph views: ${err.message}`);
    }
  } else if (!hasGraphToken) {
    avisos.push(
      'Sem token OAuth da Página — tentando Ayrshare/ScrapeCreators.'
    );
  }

  // 2) Ayrshare analytics (posts publicados via Ayrshare ou quando Graph falhou)
  const allZerado =
    (likes == null || Number(likes) === 0) &&
    (comments == null || Number(comments) === 0) &&
    (views == null || Number(views) === 0);
  const precisaEngAyr =
    force ||
    likes == null ||
    comments == null ||
    views == null ||
    (fonte === 'graph' && allZerado) ||
    (fonte !== 'graph' && allZerado);
  if (precisaEngAyr && ayrshareService.isConfigured()) {
    const candidates = [];
    const pushCand = (id, searchPlatformId, candidateProfileKey = profileKey) => {
      const s = String(id || '').trim();
      if (!s) return;
      const key = String(candidateProfileKey || '').trim() || null;
      if (
        candidates.some(
          (c) =>
            c.id === s &&
            c.searchPlatformId === Boolean(searchPlatformId) &&
            c.profileKey === key
        )
      ) {
        return;
      }
      candidates.push({ id: s, searchPlatformId: Boolean(searchPlatformId), profileKey: key });
    };

    // Preferir ID Ayrshare (UUID) — analytics mais estável
    const hasProviderPostId = ayrshareService.looksLikeAyrshareId(fbPostId);
    if (hasProviderPostId) {
      pushCand(fbPostId, false);
      if (profileKey) pushCand(fbPostId, false, null);
    }
    if (!hasProviderPostId && ayrshareService.looksLikeAyrshareId(pub.fb_native_post_id)) {
      pushCand(pub.fb_native_post_id, false);
      if (profileKey) pushCand(pub.fb_native_post_id, false, null);
    }
    // ID nativo Facebook (pageId_postId)
    const nativeForAy = nativeId || pub.fb_native_post_id || null;
    if (!hasProviderPostId && nativeForAy && /^\d+_\d+$/.test(String(nativeForAy))) {
      pushCand(nativeForAy, true);
    } else if (!hasProviderPostId && nativeForAy && /^\d+$/.test(String(nativeForAy)) && page?.page_id) {
      pushCand(`${page.page_id}_${nativeForAy}`, true);
    }
    if (!hasProviderPostId && /^\d+_\d+$/.test(fbPostId)) {
      pushCand(fbPostId, true);
    }
    const parsedUrl = facebookService.parseFacebookPostId(pub.fb_post_url);
    if (!hasProviderPostId && parsedUrl && /^\d+_\d+$/.test(parsedUrl)) {
      pushCand(parsedUrl, true);
    } else if (!hasProviderPostId && parsedUrl && page?.page_id && /^\d+$/.test(parsedUrl)) {
      pushCand(`${page.page_id}_${parsedUrl}`, true);
    }

    if (!candidates.length) {
      avisos.push(
        'Sem ID Ayrshare/Facebook para analytics. Republish ou confira o Profile Key em /paginas.'
      );
    }

    // Perfil atual, Primary Profile legado e ID nativo. Limita para evitar timeout.
    const toTry = candidates.slice(0, 3);

    const applyAy = (ay) => {
      // Sobrescreve nulls e zeros (Graph sem permissão costuma devolver 0)
      if (ay.likes != null && (likes == null || force || Number(likes) === 0)) likes = ay.likes;
      if (ay.comments != null && (comments == null || force || Number(comments) === 0)) {
        comments = ay.comments;
      }
      if (ay.shares != null && (shares == null || force || Number(shares) === 0)) shares = ay.shares;
      if (ay.views != null && (views == null || force || Number(views) === 0)) views = ay.views;
    };

    async function aplicarHistoricoDaPagina() {
      // O histórico sem Profile Key pode pertencer a outra Página da conta.
      // Quando a Página tem chave própria, consultar apenas esse histórico evita
      // atribuir o engajamento de um post a matérias diferentes.
      const historyKeys = profileKey ? [profileKey] : [null];
      let historyError = null;
      for (const historyProfileKey of historyKeys) {
        try {
          const history = await ayrshareService.fetchFacebookHistory({
            profileKey: historyProfileKey,
            limit: 100,
            force,
          });
          const found = ayrshareService.findFacebookPostInHistory(history, {
            postId: fbPostId,
            nativePostId: nativeId || pub.fb_native_post_id,
            postUrl: pub.fb_post_url,
            text: pub.texto || matter.materia || matter.titulo,
            publishedAt: pub.published_at || matter.published_at,
          });
          if (!found) continue;

          applyAy(found);
          const foundNative =
            found.postId || facebookService.parseFacebookPostId(found.postUrl) || null;
          if (foundNative && !ayrshareService.looksLikeAyrshareId(foundNative)) {
            nativeId = foundNative;
          }
          const historyPatch = {};
          if (nativeId) historyPatch.fb_native_post_id = nativeId;
          if (found.postUrl) {
            historyPatch.fb_post_url = found.postUrl;
            pub.fb_post_url = found.postUrl;
          }
          if (Object.keys(historyPatch).length) {
            await Publications.update(pub.id, historyPatch);
          }
          fonte = fonte ? `${fonte}+ayrshare-history` : 'ayrshare-history';
          return true;
        } catch (err) {
          historyError = err;
        }
      }
      if (historyError) avisos.push(`Histórico Ayrshare: ${historyError.message}`);
      return false;
    }

    // Uma chamada por página retorna até 100 posts e fica em cache. Para listas,
    // isso evita consultar o endpoint individual dezenas de vezes.
    const encontrouNoHistorico = await aplicarHistoricoDaPagina();

    if (!encontrouNoHistorico) {
      for (const cand of toTry) {
        try {
          const ay = await ayrshareService.fetchFacebookPostAnalytics({
            postId: cand.id,
            profileKey: cand.profileKey,
            searchPlatformId: cand.searchPlatformId,
          });
          if (ay.error) {
            avisos.push(`Ayrshare analytics: ${ay.error}`);
          }
          applyAy(ay);
          if (ay.postId && !ayrshareService.looksLikeAyrshareId(ay.postId)) {
            nativeId = ay.postId;
          }
          if (ay.postUrl && !pub.fb_post_url) {
            await Publications.update(pub.id, { fb_post_url: ay.postUrl });
            pub.fb_post_url = ay.postUrl;
          }
          if (ay.likes != null || ay.comments != null || ay.views != null) {
            fonte = fonte && fonte !== 'graph' ? `${fonte}+ayrshare` : 'ayrshare';
            break;
          }
        } catch (err) {
          avisos.push(`Ayrshare analytics: ${err.message}`);
        }
      }
    }

    // Sem Profile Key em User Profile → analytics não acha o post
    if (
      !profileKey &&
      (likes == null || comments == null) &&
      candidates.length
    ) {
      avisos.push(
        'Página sem Profile Key Ayrshare — cole em /paginas o Profile Key desta Página para ler curtidas.'
      );
    }

  }

  // 3) ScrapeCreators fallback (curtidas/comentários no permalink)
  const precisaEng = likes == null || comments == null || force;
  const permalink =
    pub.fb_post_url ||
    (nativeId && String(nativeId).includes('_')
      ? `https://www.facebook.com/${String(nativeId).replace('_', '/posts/')}`
      : nativeId && page?.page_id
        ? `https://www.facebook.com/${page.page_id}/posts/${nativeId}`
        : null);

  if (precisaEng && permalink) {
    try {
      const scrapeCreators = require('./scrapeCreatorsSocial');
      if (scrapeCreators.isConfigured()) {
        const sc = await scrapeCreators.extrairPost(permalink, 'facebook');
        if (sc?.likes != null && (likes == null || force)) likes = Number(sc.likes) || 0;
        if (sc?.comments != null && (comments == null || force)) comments = Number(sc.comments) || 0;
        if (sc?.shares != null && (shares == null || force)) shares = Number(sc.shares) || 0;
        fonte = fonte ? `${fonte}+scrapecreators` : 'scrapecreators';
      } else {
        avisos.push('SCRAPECREATORS_API_KEY não configurada para fallback de engajamento.');
      }
    } catch (err) {
      avisos.push(`ScrapeCreators: ${err.message}`);
    }
  }

  const patch = {
    fb_views_at: db.fn.now(),
  };
  if (views != null) patch.fb_views = views;
  if (likes != null) patch.fb_likes = likes;
  if (comments != null) patch.fb_comments = comments;
  if (shares != null) patch.fb_shares = shares;
  if (
    nativeId &&
    !/^postsyncer:/i.test(String(nativeId)) &&
    !/^ayrshare:/i.test(String(nativeId)) &&
    !ayrshareService.looksLikeAyrshareId(nativeId)
  ) {
    patch.fb_native_post_id = nativeId;
  }

  // Registra também tentativas sem dado para o lote avançar aos posts antigos.
  await Publications.update(pub.id, patch);

  const updated = await Publications.findById(pub.id);
  const payload = {
    views: updated.fb_views != null ? Number(updated.fb_views) : null,
    likes: updated.fb_likes != null ? Number(updated.fb_likes) : null,
    comments: updated.fb_comments != null ? Number(updated.fb_comments) : null,
    shares: updated.fb_shares != null ? Number(updated.fb_shares) : null,
    viewsAt: updated.fb_views_at,
    postId: updated.fb_native_post_id || nativeId,
    fonte,
    viral: classificarViral(updated),
    avisos,
  };

  if (payload.likes == null && payload.comments == null && payload.views == null) {
    payload.message =
      avisos[0] ||
      'Não foi possível ler o engajamento. Confira o Profile Key Ayrshare em /paginas ou o link do post.';
    payload.needsOauth = !hasGraphToken;
    console.warn(
      `[engajamento] matéria #${matter.id} publicação #${pub.id}: sem métricas (${avisos.join(' | ') || 'nenhum provedor retornou dados'})`
    );
  } else {
    console.info(
      `[engajamento] matéria #${matter.id}: ${payload.likes ?? '-'} curtidas, ${payload.comments ?? '-'} comentários, ${payload.views ?? '-'} views via ${fonte || 'cache'}`
    );
  }

  return payload;
}

/**
 * Diagnóstico do engajamento: mostra IDs gravados, tentativas na Ayrshare e
 * resposta bruta de cada provedor. Não grava nada no banco.
 */
async function diagnosticarEngajamento(userId, matterId) {
  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }
  if (!matter.publication_id) {
    return { erro: 'Matéria sem publicação ligada' };
  }

  const pub = await Publications.findById(matter.publication_id);
  if (!pub) return { erro: 'Publicação não encontrada' };

  const page = await resolvePage(userId, pub.facebook_page_id || matter.facebook_page_id);
  const token = String(page?.page_access_token || '');
  const profileKey = String(page?.ayrshare_profile_key || '').trim() || null;
  const ayrshareService = require('./ayrshareService');

  const out = {
    matterId,
    publicationId: pub.id,
    banco: {
      fb_post_id: pub.fb_post_id || null,
      fb_native_post_id: pub.fb_native_post_id || null,
      fb_post_url: pub.fb_post_url || null,
      fb_likes: pub.fb_likes,
      fb_comments: pub.fb_comments,
      fb_views: pub.fb_views,
      fb_views_at: pub.fb_views_at,
      status: pub.status,
      tipo: pub.tipo,
      tentativas: pub.tentativas,
      erro_mensagem: pub.erro_mensagem || null,
      created_at: pub.created_at,
      published_at: pub.published_at,
    },
    materia: {
      status: matter.status,
      tipo_publicacao: matter.tipo_publicacao,
      publication_id: matter.publication_id,
      published_at: matter.published_at,
      error_message: matter.error_message || null,
    },
    pagina: {
      id: page?.id || null,
      nome: page?.page_name || null,
      page_id: page?.page_id || null,
      tem_token_graph:
        Boolean(token) &&
        !token.startsWith('ayrshare:') &&
        !token.startsWith('postsyncer:') &&
        !token.startsWith('postpulse:'),
      tem_profile_key: Boolean(profileKey),
      profile_key_tamanho: profileKey ? profileKey.length : 0,
    },
    buscaNoFeed: null,
    ayrshare: { configurado: ayrshareService.isConfigured(), tentativas: [] },
    scrapecreators: null,
  };

  if (out.pagina.tem_token_graph && page?.page_id) {
    try {
      const found = await facebookService.findPagePostByContent(
        page.page_access_token,
        page.page_id,
        {
          message: pub.texto || matter.materia || matter.titulo || '',
          publishedAt: pub.published_at || matter.published_at || null,
        }
      );
      out.buscaNoFeed = found || { encontrado: false };
      if (found?.id) {
        try {
          const eng = await facebookService.fetchPostEngagement(page.page_access_token, found.id);
          out.buscaNoFeed.engajamento = eng;
        } catch (err) {
          out.buscaNoFeed.engajamentoErro = err.message;
        }
      }
    } catch (err) {
      out.buscaNoFeed = { erro: err.message };
    }
  }

  if (ayrshareService.isConfigured()) {
    const tentativas = [];
    const add = (id, searchPlatformId, comProfileKey) => {
      const s = String(id || '').trim();
      if (!s) return;
      if (tentativas.some((t) => t.id === s && t.searchPlatformId === searchPlatformId && t.comProfileKey === comProfileKey)) {
        return;
      }
      tentativas.push({ id: s, searchPlatformId, comProfileKey });
    };

    const uuid = ayrshareService.looksLikeAyrshareId(pub.fb_post_id)
      ? pub.fb_post_id
      : ayrshareService.looksLikeAyrshareId(pub.fb_native_post_id)
        ? pub.fb_native_post_id
        : null;
    if (uuid) {
      add(uuid, false, Boolean(profileKey));
      if (profileKey) add(uuid, false, false);
    }

    const nativo =
      (pub.fb_native_post_id && /^\d+_\d+$/.test(String(pub.fb_native_post_id))
        ? pub.fb_native_post_id
        : null) ||
      facebookService.parseFacebookPostId(pub.fb_post_url) ||
      null;
    if (nativo) {
      const full = /^\d+_\d+$/.test(String(nativo))
        ? nativo
        : page?.page_id
          ? `${page.page_id}_${nativo}`
          : nativo;
      add(full, true, Boolean(profileKey));
      if (profileKey) add(full, true, false);
    }

    for (const t of tentativas) {
      try {
        const ay = await ayrshareService.fetchFacebookPostAnalytics({
          postId: t.id,
          profileKey: t.comProfileKey ? profileKey : null,
          searchPlatformId: t.searchPlatformId,
        });
        out.ayrshare.tentativas.push({
          ...t,
          likes: ay.likes,
          comments: ay.comments,
          views: ay.views,
          error: ay.error || null,
          raw: ay.raw ? JSON.stringify(ay.raw).slice(0, 1200) : null,
        });
      } catch (err) {
        out.ayrshare.tentativas.push({ ...t, excecao: err.message });
      }
    }
    if (!tentativas.length) {
      out.ayrshare.aviso = 'Nenhum ID utilizável gravado (nem UUID Ayrshare nem ID nativo do Facebook).';
    }
  }

  const permalink = pub.fb_post_url || null;
  try {
    const scrapeCreators = require('./scrapeCreatorsSocial');
    if (!scrapeCreators.isConfigured()) {
      out.scrapecreators = { erro: 'SCRAPECREATORS_API_KEY não configurada' };
    } else if (!permalink) {
      out.scrapecreators = { erro: 'Sem fb_post_url para raspar' };
    } else {
      const sc = await scrapeCreators.extrairPost(permalink, 'facebook');
      out.scrapecreators = {
        url: permalink,
        likes: sc?.likes ?? null,
        comments: sc?.comments ?? null,
        shares: sc?.shares ?? null,
      };
    }
  } catch (err) {
    out.scrapecreators = { url: permalink, erro: err.message };
  }

  // Últimas publicações da mesma Página: mostra se algum ID está sendo gravado
  try {
    out.ultimasPublicacoesDaPagina = await db('publications')
      .where({ facebook_page_id: pub.facebook_page_id })
      .orderBy('id', 'desc')
      .limit(8)
      .select(
        'id',
        'status',
        'tipo',
        'fb_post_id',
        'fb_native_post_id',
        'fb_post_url',
        'published_at'
      );
  } catch (err) {
    out.ultimasPublicacoesDaPagina = { erro: err.message };
  }

  return out;
}

function classificarViral(pub) {
  const likes = Number(pub?.fb_likes) || 0;
  const comments = Number(pub?.fb_comments) || 0;
  const shares = Number(pub?.fb_shares) || 0;
  const views = Number(pub?.fb_views) || 0;
  const score = likes + comments * 3 + shares * 5 + Math.min(views, 5000) / 50;
  // Ajustado p/ páginas gospel/mid-size (antes: 400 / 200 / 50 — quase ninguém entrava)
  if (score >= 180 || likes >= 80 || comments >= 25) {
    return { nivel: 'alto', label: 'Viralizou', score: Math.round(score) };
  }
  if (score >= 80 || likes >= 40 || comments >= 10) {
    return { nivel: 'medio', label: 'Bom engajamento', score: Math.round(score) };
  }
  if (likes > 0 || comments > 0 || views > 0) {
    return { nivel: 'baixo', label: 'Baixo', score: Math.round(score) };
  }
  return { nivel: 'desconhecido', label: 'Sem dado', score: 0 };
}

/** True se entra na aba Viralizou (Bom + Viralizou). */
function isDestaqueEngajamento(pubOrViral) {
  if (pubOrViral?.nivel) {
    return pubOrViral.nivel === 'alto' || pubOrViral.nivel === 'medio';
  }
  const v = classificarViral(pubOrViral);
  return v.nivel === 'alto' || v.nivel === 'medio';
}

/**
 * Sincroniza curtidas/comentários/views das publicações recentes (cache 30 min).
 * Necessário para a aba Viralizou enxergar posts que ainda não tinham dado no banco.
 */
async function sincronizarEngajamentoRecentes(
  userId,
  { limit = 30, concurrency = 3, force = false } = {}
) {
  let matters = [];
  try {
    matters = await AiMatters.findRecentPublishedDaContaForSync(userId, limit);
  } catch (err) {
    console.warn('[sync engajamento] da conta:', err.message);
    matters = await AiMatters.findRecentPublishedForSync(userId, limit);
  }
  if (!matters.length) {
    return { checked: 0, updated: 0, destaques: 0, items: [] };
  }

  const items = [];
  let cursor = 0;

  async function worker() {
    while (cursor < matters.length) {
      const idx = cursor++;
      const m = matters[idx];
      try {
        const ownerId = Number(m.user_id) || Number(userId);
        const r = await atualizarViewsDaMateria(ownerId, m.id, { force: Boolean(force) });
        const destaque = isDestaqueEngajamento(r.viral || r);
        items[idx] = {
          matterId: m.id,
          likes: r.likes,
          comments: r.comments,
          views: r.views,
          viral: r.viral || null,
          cached: Boolean(r.cached),
          destaque,
        };
      } catch (err) {
        items[idx] = { matterId: m.id, error: err.message, destaque: false };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, matters.length) }, () => worker());
  await Promise.all(workers);

  const ok = items.filter((i) => i && !i.error);
  return {
    checked: matters.length,
    updated: ok.filter((i) => !i.cached).length,
    destaques: ok.filter((i) => i.destaque).length,
    items: ok,
  };
}

/**
 * Enriquece matéria buscando reportagens com o MESMO pipeline de /conteudo
 * (Google News + Brave News via pesquisarNichos) e incorpora só fatos sem plágio.
 */
const STOPWORDS_CONSULTA = new Set([
  'para', 'com', 'sobre', 'apos', 'após', 'durante', 'sendo', 'filmada', 'filmado',
  'confusao', 'confusão', 'entre', 'pela', 'pelo', 'pelos', 'pelas', 'uma', 'uns',
  'umas', 'este', 'esta', 'esse', 'essa', 'aquele', 'aquela', 'como', 'mais', 'menos',
  'muito', 'muita', 'quando', 'onde', 'quais', 'qual', 'quem', 'porque', 'porquê',
  'ainda', 'tambem', 'também', 'depois', 'antes', 'agora', 'hoje', 'ontem',
  'materia', 'matéria', 'faca', 'faça', 'quero', 'preciso', 'favor',
]);

/** Consulta de busca a partir de texto livre (título da matéria ou pedido do usuário). */
function consultaDeTexto(texto, maxPalavras = 7) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 3 && !STOPWORDS_CONSULTA.has(w.toLowerCase()))
    .slice(0, maxPalavras)
    .join(' ');
}

function normalizarUrlFonte(url) {
  try {
    const u = new URL(String(url || '').trim());
    u.hash = '';
    return u.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url || '')
      .split(/[?#]/)[0]
      .replace(/\/$/, '')
      .toLowerCase();
  }
}

function dominioDaFonte(url) {
  try {
    return new URL(String(url || '').trim()).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Mantém a fonte principal primeiro e prioriza veículos independentes antes de repetir um domínio. */
function priorizarFontesIndependentes(fontes, max = 6) {
  const independentes = [];
  const repetidas = [];
  const dominios = new Set();
  for (const fonte of Array.isArray(fontes) ? fontes : []) {
    if (!fonte) continue;
    const dominio = dominioDaFonte(fonte.url);
    if (!dominio || !dominios.has(dominio)) {
      independentes.push(fonte);
      if (dominio) dominios.add(dominio);
    } else {
      repetidas.push(fonte);
    }
  }
  return [...independentes, ...repetidas].slice(0, Math.max(1, Number(max) || 6));
}

/**
 * Pesquisa na web (Google News + Brave + leitura das páginas) e devolve fatos reais
 * com veículo, URL e trecho. Base do enriquecimento e da matéria manual pesquisada.
 */
async function coletarFatosNaWeb({
  consultas = [],
  periodo = '180d',
  excluirUrl = null,
  max = 5,
  resumoContexto = null,
  logPrefix = '[pesquisa-web]',
  onProgress = null,
  incluirRedes = false,
  redesAmplas = false,
  incluirWebGeral = false,
  maxConsultasNoticias = 4,
} = {}) {
  // Usado pelo chat de matérias para mostrar "buscando / encontrados / lendo".
  const emitir = (evento) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress(evento);
    } catch {
      /* nunca quebrar a pesquisa por causa do log */
    }
  };
  const { coletarFontesComplementares, extrairMetadadosArtigo } = require('./articleSource');
  const {
    pesquisarNichos,
    titulosSimilares,
    buscarBraveNews,
    buscarGoogleNewsRss,
    whenParaGoogle,
    normalizarPeriodo,
    itemDentroDoPeriodo,
    rotuloPeriodo,
    buscarPostsRedesSociais,
    ehPostSocial,
    textoDeBuscaInutil,
    REDES_SOCIAIS_PADRAO,
    REDES_SOCIAIS_AMPLAS,
  } = require('./newsResearch');

  const cfgPeriodo = normalizarPeriodo(periodo || '180d');
  const rotulo = rotuloPeriodo(cfgPeriodo);
  let foraDoPeriodo = 0;

  let queries = (Array.isArray(consultas) ? consultas : [consultas])
    .map((q) => String(q || '').replace(/\s+/g, ' ').trim())
    .filter((q, i, arr) => q.length >= 8 && arr.indexOf(q) === i);
  if (!queries.length) return [];

  const intencaoNormalizada = queries
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (
    /polem|controvers|escandal/.test(intencaoNormalizada) &&
    /gospel|evangel|pastor|igreja/.test(intencaoNormalizada)
  ) {
    const expansoes = [
      'pastor den\u00fancia OR processo OR golpe',
      'igreja evang\u00e9lica den\u00fancia OR investiga\u00e7\u00e3o OR esc\u00e2ndalo',
    ];
    queries = [queries[0], ...expansoes, ...queries.slice(1)].filter(
      (q, i, arr) => arr.findIndex((item) => item.toLowerCase() === q.toLowerCase()) === i
    );
  }

  const limite = Math.max(1, Math.min(24, Number(max) || 5));
  const urlExcluida = excluirUrl ? normalizarUrlFonte(excluirUrl) : '';
  const fontes = [];
  const vistosUrl = new Set(urlExcluida ? [urlExcluida] : []);
  const vistosTitulo = [];
  let foraDoTema = 0;

  // —— Relevância: evita que buscas de fallback tragam assunto alheio ——
  const semAcento = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

  const IRRELEVANTES = new Set([
    'sobre', 'para', 'como', 'mais', 'menos', 'pelo', 'pela', 'entre', 'apos',
    'contra', 'ainda', 'onde', 'quando', 'porque', 'disse', 'falou', 'afirmou',
    'noticia', 'noticias', 'ultimas', 'hoje', 'agora', 'video', 'foto',
  ]);

  const termosChave = [
    ...new Set(
      queries
        .flatMap((q) => semAcento(q).split(/[^a-z0-9]+/))
        .filter((t) => t.length >= 4 && !IRRELEVANTES.has(t))
    ),
  ];
  const TERMOS_AMPLOS = new Set([
    'brasil', 'brasileiro', 'brasileira', 'politica', 'eleicao', 'eleicoes',
    'gospel', 'evangelico', 'evangelica', 'igreja', 'igrejas', 'cristao', 'cristaos',
    'repercussao', 'posicionamento', 'impacto', 'historico', 'noticias',
    'polemica', 'controversia', 'escandalo', 'denuncia', 'investigacao', 'processo', 'golpe',
  ]);
  const tokensPorConsulta = queries.map((q) => [
    ...new Set(
      semAcento(q)
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4 && !IRRELEVANTES.has(t))
    ),
  ]);
  const frequenciaTermos = new Map();
  for (const tokens of tokensPorConsulta) {
    for (const token of tokens) {
      frequenciaTermos.set(token, Number(frequenciaTermos.get(token) || 0) + 1);
    }
  }
  const minimoFrequenciaAncora = Math.max(2, Math.ceil(queries.length * 0.5));
  const termosAncora = [...frequenciaTermos.entries()]
    .filter(
      ([termo, frequencia]) =>
        frequencia >= minimoFrequenciaAncora &&
        termo.length >= 5 &&
        !TERMOS_AMPLOS.has(termo) &&
        !/^\d+$/.test(termo)
    )
    .map(([termo]) => termo);
  // 1 termo → exige ele; 2+ termos → exige ao menos 2 (nome próprio + contexto)
  const minimoTermos = termosChave.length <= 1 ? termosChave.length : 2;

  function combinaComOTema(titulo = '', resumo = '', trecho = '') {
    if (!termosChave.length) return true;
    const alvoPrimario = semAcento([titulo, resumo].filter(Boolean).join(' '));
    const alvo = semAcento([titulo, resumo, trecho].filter(Boolean).join(' '));
    // Se todas/maioria das consultas repetem uma entidade específica (CGADB,
    // nome de pessoa etc.), ela precisa aparecer no título/resumo. Não aceite
    // outro personagem só porque surgiu em menu, rodapé ou recomendação.
    if (
      termosAncora.length &&
      !termosAncora.some((termo) => alvoPrimario.includes(termo))
    ) {
      return false;
    }
    let achados = 0;
    for (const t of termosChave) {
      if (alvo.includes(t)) achados += 1;
      if (achados >= minimoTermos) return true;
    }
    return false;
  }

  function adicionarFonte(f) {
    if (!f) return;
    // Sem link não dá para checar o fato — evita "fonte" genérica virar dado na matéria
    const urlBruta = String(f.url || f.link || '');
    if (!/^https?:\/\//i.test(urlBruta)) return;
    // Redirect do Google News que não abriu: fica sem veículo nem texto real
    if (/news\.google\.com\/rss\//i.test(urlBruta)) return;
    const urlKey = normalizarUrlFonte(f.url || f.link);
    if (urlKey && vistosUrl.has(urlKey)) return;
    const tit = String(f.titulo || '').trim();
    if (tit && vistosTitulo.some((x) => titulosSimilares(x, tit))) return;
    const trecho = String(f.trecho || f.contextoApuracao || f.resumo || f.snippet || '').trim();
    if (trecho.length < 40) return;
    // Fora do assunto pesquisado: não entra na apuração
    if (!combinaComOTema(tit, f.resumo, trecho)) {
      foraDoTema += 1;
      return;
    }
    if (urlKey) vistosUrl.add(urlKey);
    if (tit) vistosTitulo.push(tit);
    fontes.push({
      veiculo: f.veiculo || f.fonte || 'Web',
      url: f.url || f.link || null,
      titulo: tit || queries[0],
      resumo: String(f.resumo || '').slice(0, 500),
      trecho: trecho.slice(0, 2500),
      dataPublicacao: f.dataPublicacao || f.data || null,
      dataTimestamp: Number(f.dataTimestamp) || 0,
      ...(f.ehRedeSocial || f.redeSocial ? { ehRedeSocial: true } : {}),
    });
  }

  function totalDominiosIndependentes() {
    return new Set(fontes.map((fonte) => dominioDaFonte(fonte.url)).filter(Boolean)).size;
  }

  // Reserva parte da cota para redes sociais: sem isso, as notícias enchem o
  // limite primeiro e nenhuma rede entra na apuração.
  const reservaRedes = incluirRedes ? Math.min(6, Math.max(2, Math.ceil(limite * 0.35))) : 0;
  const cotaNoticias = Math.max(2, limite - reservaRedes);

  // 1) Mesmas fontes de /conteudo (Google News + Brave), sem apurar tudo (mais rápido).
  // Leitura em lotes paralelos: mais fontes sem multiplicar o tempo de espera.
  // Leitura em paralelo: 8 links por vez em vez de 4 (o gargalo é rede, não CPU).
  const LOTE_LEITURA = 8;
  const consultasNoticiasProcessadas = new Set();
  const limiteConsultasNoticias = Math.max(1, Math.min(6, Number(maxConsultasNoticias) || 4));
  async function coletarNoticias(teto) {
    for (const q of queries.slice(0, limiteConsultasNoticias)) {
      if (fontes.length >= teto) break;
      const chaveConsulta = semAcento(q).replace(/\s+/g, ' ').trim();
      // A segunda passagem serve para consultar ângulos que ainda não rodaram,
      // não para repetir Google/Brave e reler as mesmas páginas.
      if (consultasNoticiasProcessadas.has(chaveConsulta)) continue;
      consultasNoticiasProcessadas.add(chaveConsulta);
      try {
        const when = whenParaGoogle(cfgPeriodo);
        emitir({ tipo: 'buscando', consulta: q, periodo: rotulo });
        // eslint-disable-next-line no-await-in-loop
        const [gnews, brave] = await Promise.all([
          buscarGoogleNewsRss(q, {
            when,
            resolverDiretas: true,
            incluirWebGeral,
          }).catch(() => []),
          buscarBraveNews(q, cfgPeriodo).catch(() => []),
        ]);
        const brutos = [...gnews, ...brave];
        const encontrados = brutos.filter((t) => {
          if (itemDentroDoPeriodo(t, cfgPeriodo)) return true;
          foraDoPeriodo += 1;
          return false;
        });
        const tokensConsultaAtual = [
          ...new Set(
            semAcento(q)
              .split(/[^a-z0-9]+/)
              .filter((termo) => termo.length >= 4 && !IRRELEVANTES.has(termo))
          ),
        ];
        const encontradosOrdenados = encontrados
          .map((item, indice) => {
            const titulo = semAcento(item.titulo || '');
            const resumo = semAcento(item.resumo || '');
            let relevancia = 0;
            for (const ancora of termosAncora) {
              if (titulo.includes(ancora)) relevancia += 20;
              else if (resumo.includes(ancora)) relevancia += 10;
            }
            for (const termo of tokensConsultaAtual) {
              if (titulo.includes(termo)) relevancia += TERMOS_AMPLOS.has(termo) ? 1 : 4;
              else if (resumo.includes(termo)) relevancia += TERMOS_AMPLOS.has(termo) ? 0.5 : 2;
            }
            return { item, indice, relevancia };
          })
          .sort((a, b) => b.relevancia - a.relevancia || a.indice - b.indice)
          .map(({ item }) => item);
        emitir({
          tipo: 'encontrados',
          consulta: q,
          total: encontrados.length,
          descartados: brutos.length - encontrados.length,
          periodo: rotulo,
        });

        const candidatos = [];
        const urlsCandidatas = new Set();
        const titulosCandidatos = [];
        for (const item of encontradosOrdenados.slice(0, 20)) {
          if (!item.link || normalizarUrlFonte(item.link) === urlExcluida) continue;
          const urlItem = normalizarUrlFonte(item.link);
          const tituloItem = String(item.titulo || '').trim();
          if (urlItem && (vistosUrl.has(urlItem) || urlsCandidatas.has(urlItem))) continue;
          if (
            tituloItem &&
            [...vistosTitulo, ...titulosCandidatos].some((titulo) =>
              titulosSimilares(titulo, tituloItem)
            )
          ) {
            continue;
          }
          if (urlItem) urlsCandidatas.add(urlItem);
          if (tituloItem) titulosCandidatos.push(tituloItem);
          candidatos.push(item);
        }

        for (let i = 0; i < candidatos.length && fontes.length < teto; i += LOTE_LEITURA) {
          const lote = candidatos.slice(i, i + LOTE_LEITURA);
          // eslint-disable-next-line no-await-in-loop
          const lidos = await Promise.all(
            lote.map(async (t) => {
              emitir({
                tipo: 'lendo',
                url: t.link,
                veiculo: t.veiculo || t.fonte || null,
                titulo: t.titulo || null,
              });
              try {
                return { t, meta: await extrairMetadadosArtigo(t.link) };
              } catch {
                return { t, meta: null };
              }
            })
          );
          for (const { t, meta } of lidos) {
            if (fontes.length >= teto) break;
            const dataConfirmada = Number(meta?.dataTimestamp) || Number(t.dataTimestamp) || 0;
            if (dataConfirmada && !itemDentroDoPeriodo({ dataTimestamp: dataConfirmada }, cfgPeriodo)) {
              foraDoPeriodo += 1;
              continue;
            }
            adicionarFonte({
              titulo: meta?.titulo || t.titulo,
              url: meta?.url || t.link,
              veiculo: meta?.veiculo || t.veiculo || t.fonte,
              resumo: meta?.resumo || t.resumo,
              trecho: meta?.trecho || t.resumo,
              dataPublicacao: meta?.dataPublicacao || t.data || null,
              dataTimestamp: dataConfirmada,
            });
          }
        }
      } catch (err) {
        console.warn(`${logPrefix} busca noticias:`, err.message);
      }
    }
  }

  await coletarNoticias(cotaNoticias);

  // 1c) Redes sociais (Instagram, Facebook, YouTube, X, TikTok, Threads…)
  if (incluirRedes && fontes.length < limite) {
    const redes = redesAmplas ? REDES_SOCIAIS_AMPLAS : REDES_SOCIAIS_PADRAO;
    let redesIndisponiveis = false;
    for (const q of queries.slice(0, 1)) {
      if (fontes.length >= limite || redesIndisponiveis) break;
      try {
        emitir({ tipo: 'buscando', consulta: q, redes: true, periodo: rotulo });
        // eslint-disable-next-line no-await-in-loop
        const { itens: posts, avisos } = await buscarPostsRedesSociais(q, { redes, porRede: 5 });
        const dentro = posts.filter((t) => {
          if (itemDentroDoPeriodo(t, cfgPeriodo)) return true;
          foraDoPeriodo += 1;
          return false;
        });
        emitir({
          tipo: 'encontrados',
          consulta: q,
          total: dentro.length,
          descartados: posts.length - dentro.length,
          periodo: rotulo,
          redes: true,
        });
        // Sem posts: diz o porquê, em vez de mostrar só "0 resultados"
        if (!dentro.length && avisos.length) {
          emitir({ tipo: 'redes-indisponivel', motivo: avisos.join(' · '), consulta: q });
          // Provedor fora do ar/sem chave: não repete a espera na próxima consulta
          if (!posts.length) redesIndisponiveis = true;
        }
        // Redes exigem: post de verdade (não perfil/login), texto aproveitável
        // e data conhecida dentro da janela — senão entra post antigo.
        let semData = 0;
        let semConteudo = 0;
        for (const p of dentro) {
          if (fontes.length >= limite) break;
          if (!ehPostSocial(p.link)) {
            semConteudo += 1;
            continue;
          }
          if (textoDeBuscaInutil(p.resumo)) {
            semConteudo += 1;
            continue;
          }
          if (!p.dataTimestamp) {
            semData += 1;
            continue;
          }
          adicionarFonte({
            titulo: p.titulo,
            url: p.link,
            veiculo: p.veiculo || 'Rede social',
            resumo: p.resumo,
            trecho: p.resumo,
            ehRedeSocial: true,
          });
        }
        if (semData || semConteudo) {
          emitir({
            tipo: 'redes-descartadas',
            consulta: q,
            semData,
            semConteudo,
            periodo: rotulo,
          });
        }
      } catch (err) {
        console.warn(`${logPrefix} redes sociais:`, err.message);
      }
    }
  }

  // Só quando houve cota reservada: se as redes renderam pouco (ou faltou a
  // chave do Serper), a sobra volta para as notícias em vez de se perder.
  if (incluirRedes && fontes.length < limite) await coletarNoticias(limite);

  // 1b) Se ainda vazio, pipeline completo (com apuração) como em Pautas com IA
  if (!fontes.length && queries[0]) {
    try {
      emitir({ tipo: 'buscando', consulta: queries[0], profunda: true, periodo: rotulo });
      const topicos = await pesquisarNichos(queries[0], 6, {
        periodo: cfgPeriodo,
        incluirRedesSociais: false,
        filtrarPeriodo: true,
      });
      for (const t of topicos || []) {
        if (fontes.length >= limite) break;
        const fontesAp = Array.isArray(t.fontesApuracao) ? t.fontesApuracao : [];
        if (fontesAp.length) {
          for (const fa of fontesAp) adicionarFonte(fa);
        } else {
          adicionarFonte({
            titulo: t.titulo,
            link: t.link,
            veiculo: t.veiculo || t.fonte,
            resumo: t.resumo,
            trecho: t.contextoApuracao || t.resumo,
          });
        }
      }
    } catch (err) {
      console.warn(`${logPrefix} pesquisarNichos:`, err.message);
    }
  }

  // 2) Fallback: busca complementar (Brave/Serper + scrape)
  if (totalDominiosIndependentes() < 2) {
    for (const q of queries.slice(0, 2)) {
      try {
        emitir({ tipo: 'buscando', consulta: q, complementar: true, periodo: rotulo });
        const mais = await coletarFontesComplementares({
          titulo: q,
          resumo: String(resumoContexto || q).slice(0, 160),
          linkExcluir: excluirUrl || null,
          max: 4,
        });
        const exigeDataConfirmada = Boolean(cfgPeriodo.horas) || Number(cfgPeriodo.dias) <= 3;
        for (const f of mais) {
          const dataConfirmada = Number(f.dataTimestamp) || 0;
          if (
            (exigeDataConfirmada && !dataConfirmada) ||
            (dataConfirmada && !itemDentroDoPeriodo({ dataTimestamp: dataConfirmada }, cfgPeriodo))
          ) {
            foraDoPeriodo += 1;
            continue;
          }
          adicionarFonte(f);
        }
      } catch (err) {
        console.warn(`${logPrefix} complementares:`, err.message);
      }
    }
  }

  // 3) Snippets brutos se ainda faltar volume
  if (totalDominiosIndependentes() < 2 && queries[0]) {
    try {
      const when = whenParaGoogle(cfgPeriodo);
      const brutos = [
        ...(await buscarBraveNews(queries[0], cfgPeriodo)),
        ...(await buscarGoogleNewsRss(queries[0], {
          when,
          resolverDiretas: true,
          incluirWebGeral,
        })),
      ].filter((r) => {
        if (itemDentroDoPeriodo(r, cfgPeriodo)) return true;
        foraDoPeriodo += 1;
        return false;
      });
      for (const r of brutos.slice(0, 10)) {
        if (fontes.length >= limite) break;
        const url = r.link;
        if (!url || normalizarUrlFonte(url) === urlExcluida) continue;
        let meta = null;
        try {
          meta = await extrairMetadadosArtigo(url);
        } catch {
          /* ignore */
        }
        const dataConfirmada = Number(meta?.dataTimestamp) || Number(r.dataTimestamp) || 0;
        if (
          dataConfirmada &&
          !itemDentroDoPeriodo({ dataTimestamp: dataConfirmada }, cfgPeriodo)
        ) {
          foraDoPeriodo += 1;
          continue;
        }
        adicionarFonte({
          titulo: meta?.titulo || r.titulo,
          url: meta?.url || url,
          veiculo: meta?.veiculo || r.veiculo || r.fonte,
          resumo: meta?.resumo || r.resumo,
          trecho: meta?.trecho || r.resumo,
          dataPublicacao: meta?.dataPublicacao || r.data || null,
          dataTimestamp: dataConfirmada,
        });
      }
    } catch (err) {
      console.warn(`${logPrefix} fallback bruto:`, err.message);
    }
  }

  const resultado = priorizarFontesIndependentes(fontes, limite);
  if (foraDoTema) emitir({ tipo: 'fora-do-tema', total: foraDoTema });
  emitir({
    tipo: 'fontes',
    total: resultado.length,
    periodo: rotulo,
    foraDoPeriodo,
    foraDoTema,
    fontes: resultado.map((f) => ({ veiculo: f.veiculo, url: f.url, titulo: f.titulo })),
  });
  return resultado;
}

/** Bloco de fatos que vai no prompt do DeepSeek. */
function montarBlocoFatos(fontes) {
  return (fontes || [])
    .map((f, i) => {
      // Link que o próprio editor colou (post, vídeo ou matéria) é a base factual:
      // entra inteiro. Fonte vinda de busca entra resumida, só como contexto.
      const limiteTrecho =
        f?.plataforma === 'youtube' ||
        f?.ehRedeSocial ||
        f?.tipoFonte === 'rede_social' ||
        f?.fonteColada
          ? 9000
          : 1800;
      const timestamp = Number(f?.dataTimestamp) || Date.parse(String(f?.dataPublicacao || '')) || 0;
      const dataFonte = timestamp
        ? new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Araguaina',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          }).format(new Date(timestamp))
        : null;
      return `Fonte ${i + 1} — ${f.veiculo || 'Web'}${f.url ? ` (${f.url})` : ''}\nTítulo: ${f.titulo || ''}${dataFonte ? `\nData de publicação da fonte: ${dataFonte}` : '\nData de publicação da fonte: não confirmada'}\nTrecho factual:\n${String(f.trecho || f.resumo || '').slice(0, limiteTrecho)}`;
    })
    .join('\n\n---\n\n');
}

async function enriquecerMateriaComWeb({
  userId,
  matterId,
  tituloAtual = null,
  materiaAtual = null,
  palavrasChave = null,
  periodo = '180d',
} = {}) {
  const deepseekService = require('./deepseekService');
  deepseekService.assertDeepseek();

  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }
  if (matter.status === 'publicado') {
    const err = new Error('Matéria já publicada. Gere uma nova se precisar enriquecer o texto.');
    err.status = 400;
    throw err;
  }

  const titulo = String(tituloAtual || matter.titulo || '').trim();
  const materia = String(materiaAtual || matter.materia || '').trim();
  if (!materia) {
    const err = new Error('Não há texto na matéria para enriquecer.');
    err.status = 400;
    throw err;
  }

  const queryManual = String(palavrasChave || '').trim();
  const queryTitulo = consultaDeTexto(titulo) || titulo.slice(0, 100);
  const fontesFinais = await coletarFatosNaWeb({
    consultas: [queryManual, queryTitulo, titulo.slice(0, 120)],
    periodo,
    excluirUrl: matter.fonte_url,
    resumoContexto: materia.replace(/\s+/g, ' ').trim().slice(0, 160),
    max: 5,
    logPrefix: '[enriquecer]',
  });

  if (!fontesFinais.length) {
    const err = new Error(
      'Não encontramos outras reportagens úteis. Ajuste as palavras-chave (como em Pautas com IA) ou cole infos manuais abaixo.'
    );
    err.status = 422;
    throw err;
  }

  const blocoFatos = montarBlocoFatos(fontesFinais);

  let hashtags = [];
  try {
    hashtags = Array.isArray(matter.hashtags)
      ? matter.hashtags
      : JSON.parse(matter.hashtags || '[]');
  } catch {
    hashtags = [];
  }

  const reescrito = await deepseekService.enriquecerMateriaComFatos({
    titulo,
    materia,
    fatosFontes: blocoFatos,
    hashtags,
    fonteTitulo: matter.fonte_titulo,
  });

  const patch = {
    titulo: reescrito.titulo,
    materia: reescrito.materia,
    titulo_ia: reescrito.titulo,
    materia_ia: reescrito.materia,
    hashtags: JSON.stringify(reescrito.hashtags || []),
    error_message: null,
  };
  if (matter.status !== 'agendado') patch.status = 'rascunho';
  await AiMatters.update(matterId, patch);

  let updated = await AiMatters.findById(matterId);
  let imagemUrl = updated.imagem_url || null;
  let videoUrl = null;
  let aviso = `Texto enriquecido com fatos de ${fontesFinais.length} fonte(s) — mesma busca de Pautas com IA ✓`;

  const titleChanged =
    String(reescrito.titulo || '').trim() !== String(matter.titulo || '').trim();

  if (titleChanged && updated.tipo_publicacao === 'reel' && updated.video_clip_id) {
    try {
      const VideoClips = require('../models/VideoClips');
      const clipCapa = await VideoClips.findById(updated.video_clip_id);
      const temCapa =
        clipCapa?.capa_status === 'pronta' ||
        (clipCapa?.caminho_arquivo && /_capa_/i.test(String(clipCapa.caminho_arquivo)));
      if (temCapa) {
        const { applyCoverToClipNow } = require('./clipPostProcessService');
        await applyCoverToClipNow({
          clipId: updated.video_clip_id,
          userId,
          titulo: reescrito.titulo,
          force: true,
        });
        updated = await AiMatters.findById(matterId);
        if (updated.video_path) {
          videoUrl = `/media/${String(updated.video_path).replace(/\\/g, '/')}`;
        }
        aviso += ' Capa do Reel atualizada.';
      }
    } catch (err) {
      console.warn('[enriquecer] capa reel:', err.message);
    }
  } else if (titleChanged) {
    const sourceUrl =
      updated.imagem_fonte_url ||
      (!updated.imagem_path && /^https?:\/\//i.test(String(updated.imagem_url || ''))
        ? updated.imagem_url
        : null);
    if (sourceUrl) {
      try {
        const { composeMatterArtwork } = require('./matterArtworkService');
        const artwork = await composeMatterArtwork({
          userId,
          matterId: updated.id,
          sourceUrl,
          title: reescrito.titulo,
          force: true,
        });
        updated = artwork.matter || (await AiMatters.findById(matterId));
        if (artwork.publicUrl) imagemUrl = artwork.publicUrl;
        aviso += ' Arte regenerada.';
      } catch (err) {
        console.warn('[enriquecer] arte:', err.message);
      }
    }
  }

  return {
    matter: updated,
    titulo: reescrito.titulo,
    materia: reescrito.materia,
    hashtags: reescrito.hashtags,
    fatosUsados: reescrito.fatosUsados || [],
    fontes: fontesFinais.map((f) => ({
      veiculo: f.veiculo,
      titulo: f.titulo,
      url: f.url,
    })),
    queryUsada: queries[0] || queryTitulo,
    imagemUrl,
    videoUrl,
    aviso,
  };
}

module.exports = {
  priorizarFontesIndependentes,
  pesquisarNichos,
  buscarEmAltaAgora,
  marcarJaPublicados,
  gerarPreviewDeTopico,
  gerarCompleto,
  gerarESalvarTitulosAlternativos,
  parseTitulosAlternativos,
  gerarTextoXDaMateria,
  gerarDeLink,
  gerarVariacaoDeMateria,
  gerarMateriaManual,
  atualizarViewsDaMateria,
  diagnosticarEngajamento,
  sincronizarEngajamentoRecentes,
  classificarViral,
  syncConteudoReelMatter,
  limparTextoReelSocial,
  tituloCurtoReel,
  salvarMateria,
  criarMateriaManual,
  publicarMateria,
  gerarEPublicarLote,
  criarMonitor,
  tickMonitores,
  agendarMateria,
  desagendarMateria,
  filaEmLote,
  repararAgendamentosSobrepostos,
  obterUltimoAgendamento,
  formatarHorarioAgendamento,
  toDatetimeLocalAraguaina,
  tickFilaJobs,
  resolvePage,
  enriquecerMateriaComWeb,
  coletarFatosNaWeb,
  montarBlocoFatos,
};
