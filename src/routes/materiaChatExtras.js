/**
 * Extras do chat de matérias (/materia-manual):
 *  - "Em alta": radar dos assuntos do momento para o usuário escolher.
 *  - Anexo PDF: devolve o texto extraído para virar base da matéria.
 *
 * Fica separado do router principal de propósito: o chat existente não muda.
 */
const express = require('express');
const { uploadChatDoc } = require('../middleware/uploadChatDoc');
const { uploadMatterImage } = require('../middleware/uploadMatterImage');
const { loadCurrentUser, requireAdmin } = require('../middleware/accessControl');

const router = express.Router();

/** Quantos assuntos o radar devolve por vez. */
const LIMITE_TOPICOS = 30;

/**
 * Temas que abrem por padrão ao clicar em "Em alta".
 * Cada tema tem consultas próprias: buscar só "política" traz notícia genérica
 * (amamentação, futebol) que não serve para a Página. As variações amarram o
 * assunto ao universo evangélico/gospel, que é o nicho do produto.
 */
const TEMAS_PADRAO = Object.freeze([
  Object.freeze({
    rotulo: 'Política e fé',
    consultas: Object.freeze(['política evangélicos', 'bancada evangélica']),
    nichos: Object.freeze(['politica-fe', 'politica']),
  }),
  Object.freeze({
    rotulo: 'Denominações',
    consultas: Object.freeze(['Assembleia de Deus decisão', 'denominação evangélica pastor']),
    nichos: Object.freeze(['igreja']),
  }),
  Object.freeze({
    rotulo: 'Pastores e líderes',
    consultas: Object.freeze(['pastor declaração polêmica', 'líder evangélico notícia']),
    nichos: Object.freeze(['pastores']),
  }),
  Object.freeze({
    rotulo: 'Música gospel',
    consultas: Object.freeze(['cantor gospel notícia', 'música gospel polêmica']),
    nichos: Object.freeze(['gospel']),
  }),
  Object.freeze({
    rotulo: 'Escatologia e profecia',
    consultas: Object.freeze(['escatologia profecia pastor', 'arrebatamento Israel evangélicos']),
    nichos: Object.freeze(['igreja', 'israel']),
  }),
  Object.freeze({
    rotulo: 'Testemunhos e conversão',
    consultas: Object.freeze(['testemunho cristão superação', 'cura conversão evangélico']),
    nichos: Object.freeze(['igreja']),
  }),
  Object.freeze({
    rotulo: 'Família e comportamento',
    consultas: Object.freeze(['família cristã pastor', 'comportamento igreja evangélica']),
    nichos: Object.freeze(['igreja']),
  }),
  Object.freeze({
    rotulo: 'Missões e perseguição',
    consultas: Object.freeze(['cristãos perseguidos missão', 'missionário evangélico notícia']),
    nichos: Object.freeze(['israel']),
  }),
  Object.freeze({
    rotulo: 'Fé, ciência e saúde',
    consultas: Object.freeze(['fé ciência estudo oração', 'saúde mental igreja evangélica']),
    nichos: Object.freeze(['igreja']),
  }),
  Object.freeze({
    rotulo: 'Israel e mundo cristão',
    consultas: Object.freeze(['Israel evangélicos profecia', 'cristãos mundo religião']),
    nichos: Object.freeze(['israel']),
  }),
  Object.freeze({
    rotulo: 'Polêmicas nas redes',
    consultas: Object.freeze(['pastor viralizou redes sociais', 'polêmica gospel internet']),
    nichos: Object.freeze(['pastores', 'gospel']),
  }),
]);

/** Notícia em alta pesa mais que post de rede, que pesa mais que matéria comum. */
function pesoTipoFonte(item) {
  if (item.emAlta) return 4;
  if (item.tipoFonte === 'rede_social' || item.redeSocial) return 3;
  return 2;
}

/**
 * Junta o mesmo assunto publicado por vários veículos num único cartão.
 * Quanto mais veículos e sinais, maior o "calor".
 */
function agruparPorAssunto(itens, titulosSimilares) {
  const grupos = [];
  for (const item of itens) {
    const grupo = grupos.find((g) => titulosSimilares(g.principal.titulo, item.titulo));
    if (!grupo) {
      grupos.push({ principal: item, itens: [item] });
      continue;
    }
    grupo.itens.push(item);
    // Prefere notícia com resumo maior como cartão principal do grupo.
    const trocaPrincipal =
      item.tipoFonte !== 'rede_social' &&
      (grupo.principal.tipoFonte === 'rede_social' ||
        String(item.resumo || '').length > String(grupo.principal.resumo || '').length);
    if (trocaPrincipal) grupo.principal = item;
  }

  return grupos.map((g) => {
    const veiculos = new Set(
      g.itens.map((i) => String(i.veiculo || i.fonte || '').trim()).filter(Boolean)
    );
    const temRede = g.itens.some((i) => i.tipoFonte === 'rede_social' || i.redeSocial);
    const temTrend = g.itens.some((i) => i.emAlta);
    const calor =
      g.itens.reduce((soma, i) => soma + pesoTipoFonte(i), 0) +
      veiculos.size * 3 +
      (temTrend ? 5 : 0) +
      (temRede ? 2 : 0);

    return {
      ...g.principal,
      calor,
      contagemFontes: g.itens.length,
      veiculos: [...veiculos].slice(0, 5),
    };
  });
}

/**
 * Reparte as vagas entre os temas, em rodadas.
 * Sem isso o tema que devolve mais resultado ocupa a lista inteira.
 */
function distribuirPorTema(agrupados, rotulos, limite) {
  const filas = new Map(rotulos.map((r) => [r, []]));
  const sobra = [];
  for (const item of agrupados) {
    if (filas.has(item.tema)) filas.get(item.tema).push(item);
    else sobra.push(item);
  }

  const escolhidos = [];
  let rodou = true;
  while (escolhidos.length < limite && rodou) {
    rodou = false;
    for (const rotulo of rotulos) {
      if (escolhidos.length >= limite) break;
      const fila = filas.get(rotulo);
      if (!fila?.length) continue;
      escolhidos.push(fila.shift());
      rodou = true;
    }
  }
  // Faltou fechar a lista? Completa com o que sobrou, do mais quente para o menos.
  for (const item of sobra) {
    if (escolhidos.length >= limite) break;
    escolhidos.push(item);
  }
  return escolhidos;
}

function normalizarTexto(valor) {
  return String(valor || '')
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Palavra do nicho como prefixo: "pastor" também pega "pastores" e "pastora".
 * Sem regex montada na hora — as palavras vêm de configuração e não precisam
 * virar padrão.
 */
function citaPalavra(textoNormalizado, palavra) {
  let desde = 0;
  for (;;) {
    const achou = textoNormalizado.indexOf(palavra, desde);
    if (achou < 0) return false;
    if (achou === 0 || textoNormalizado[achou - 1] === ' ') return true;
    desde = achou + 1;
  }
}

/** Palavras curtas e genéricas demais para indicar tema. */
const PALAVRAS_VAZIAS = new Set([
  'noticia', 'noticias', 'polemica', 'sobre', 'contra', 'para', 'como',
  'decisao', 'declaracao', 'mundo', 'nova', 'novo',
]);

/**
 * Termos que identificam cada tema, tirados das próprias consultas dele.
 *
 * O peso é 1/(nº de temas que usam o termo): "evangelico" aparece em quase
 * todos e quase não informa; "escatologia" aparece num só e decide sozinho.
 * Sem isso, 86% das pautas caíam em "Política e fé" só porque o nicho dela é
 * o mais abrangente.
 */
function termosPorTema(temas) {
  const porTema = temas.map((tema) => ({
    tema,
    termos: new Set(
      tema.consultas
        .flatMap((consulta) => normalizarTexto(consulta).split(/\s+/))
        .filter((palavra) => palavra.length >= 4 && !PALAVRAS_VAZIAS.has(palavra))
    ),
  }));

  const emQuantosTemas = new Map();
  for (const { termos } of porTema) {
    for (const termo of termos) {
      emQuantosTemas.set(termo, (emQuantosTemas.get(termo) || 0) + 1);
    }
  }

  return porTema.map(({ tema, termos }) => ({
    tema,
    termos: [...termos].map((termo) => ({ termo, peso: 1 / emQuantosTemas.get(termo) })),
  }));
}

/**
 * Pautas lidas direto no RSS dos portais — sem passar pelo Google.
 *
 * É o que mantém o radar de pé quando o Google News bloqueia o IP do servidor:
 * antes disso, um bloqueio zerava a tela porque Google News era a única fonte
 * viva (Brave e Serper ficam desligadas por padrão).
 */
async function pautasDosPortais(temas, horas) {
  const portais = require('../services/portaisNichoService');

  const temasComNicho = temas.filter((t) => (t.nichos || []).length);
  const nichosPedidos = [...new Set(temasComNicho.flatMap((t) => t.nichos))];
  if (!nichosPedidos.length) return [];

  const { itens } = await portais.buscarNosPortais({ nichos: nichosPedidos, horas });
  const perfis = termosPorTema(temasComNicho);

  const pautas = [];
  for (const item of itens) {
    // Portal geral (CNN, g1, Metrópoles) publica de tudo: o assunto precisa
    // estar no título. Portal do nicho pode casar pelo resumo também.
    const texto = normalizarTexto(
      item.especializado ? `${item.titulo} ${item.resumo}` : item.titulo
    );

    let melhor = null;
    for (const { tema, termos } of perfis) {
      let nota = 0;
      for (const { termo, peso } of termos) {
        if (citaPalavra(texto, termo)) nota += peso;
      }
      if (nota > 0 && (!melhor || nota > melhor.nota)) melhor = { tema, nota };
    }
    // Nenhum termo do tema no texto: é notícia geral do portal, não pauta daqui.
    if (!melhor) continue;

    pautas.push({
      titulo: item.titulo,
      link: item.link,
      resumo: item.resumo,
      data: item.data || null,
      dataTimestamp: Number(item.dataTimestamp) || 0,
      veiculo: item.veiculo,
      imagem: item.imagem || null,
      fonte: 'Portal do nicho',
      tipoFonte: 'noticia',
      recente: true,
      emAlta: false,
      tema: melhor.tema.rotulo,
    });
  }
  return pautas;
}

/**
 * Radar por tema, reaproveitando os coletores já existentes no projeto.
 * Cada coletor é tolerante a falha: chave de API vencida não derruba o radar.
 */
async function radarPorTemas(
  temas,
  { horas = 24, limite = LIMITE_TOPICOS, userId = null, consultasPorTema = 2, apurar = true } = {}
) {
  const nr = require('../services/newsResearch');
  const alvo = temas.slice(0, 12);
  const periodoPesquisa = { horas };
  const when = nr.whenParaGoogle(periodoPesquisa);

  // Cada busca carrega o tema de origem para a cota funcionar depois.
  const tarefas = [];
  const marcar = (tema, promessa) => tarefas.push({ tema, promessa });
  alvo.forEach((tema, indice) => {
    tema.consultas.slice(0, Math.min(Math.max(Number(consultasPorTema) || 2, 1), 8)).forEach((consulta) => {
      marcar(tema.rotulo, nr.buscarGoogleNewsEmAlta(consulta));
      marcar(tema.rotulo, nr.buscarGoogleNewsRss(consulta, { when }));
      marcar(tema.rotulo, nr.buscarBraveNews(consulta, periodoPesquisa));
      // Redes sociais só na primeira consulta de cada tema: é a busca mais cara.
      if (indice < 6 && consulta === tema.consultas[0]) {
        marcar(tema.rotulo, nr.buscarSerperRedes(consulta));
      }
    });
  });

  // Os portais entram sempre, não só quando o Google falha: são links diretos,
  // com foto e veículo, e já têm cache próprio de 10 min.
  const promessaPortais = pautasDosPortais(alvo, horas).catch((err) => {
    console.warn('[radar] portais:', err.message);
    return [];
  });

  const [resultados, itensDePortais] = await Promise.all([
    Promise.allSettled(tarefas.map((t) => t.promessa)),
    promessaPortais,
  ]);

  const bruto = [];
  resultados.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
    for (const item of r.value) bruto.push({ ...item, tema: tarefas[i].tema });
  });
  for (const item of itensDePortais) bruto.push(item);

  const filtrados = nr.deduplicarTopicos(
    bruto.filter((i) => nr.itemEhRecente(i, { horas }) || i.emAlta)
  );

  const agrupados = agruparPorAssunto(filtrados, nr.titulosSimilares).sort(
    (a, b) => b.calor - a.calor
  );

  // Mantém uma reserva para substituir resultados que já viraram matéria.
  // O corte final só acontece depois da comparação com o histórico da conta.
  const candidatos = distribuirPorTema(
    agrupados,
    alvo.map((t) => t.rotulo),
    Math.max(limite * 3, 60)
  );

  let escolhidos = candidatos;
  let totalOcultado = 0;
  if (userId && candidatos.length) {
    const viralizarService = require('../services/viralizarService');
    const sincronizado = await viralizarService.sincronizarPautasUsadas({
      userId,
      facebookPageId: null,
      topicos: candidatos,
      excluidos: [],
    });
    escolhidos = sincronizado.topicos || [];
    totalOcultado = Number(sincronizado.novosExcluidos) || 0;
  }
  escolhidos = escolhidos.slice(0, limite);
  // Quem chama pode completar só os itens que vão aparecer (ex.: Furos do dia).
  if (!apurar) return { topicos: escolhidos, totalAnalisado: filtrados.length, totalOcultado, horas };

  // Apuração extra é bônus e roda em paralelo: se falhar, o item cru já serve.
  const { apurarTopico } = require('../services/articleSource');
  const apurados = await Promise.allSettled(escolhidos.map((t) => apurarTopico(t)));
  const topicos = apurados.map((r, i) =>
    r.status === 'fulfilled' && r.value ? { ...r.value, tema: escolhidos[i].tema } : escolhidos[i]
  );

  return { topicos, totalAnalisado: filtrados.length, totalOcultado, horas };
}

function limpar(valor, max) {
  return String(valor || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * O resumo do Google News é o próprio título seguido de "&nbsp;&nbsp;Veículo".
 * Nesse caso não acrescenta nada ao cartão e vira texto vazio.
 */
function resumoUtil(t) {
  const semEntidade = String(t.resumo || t.trecho || '').replace(/&nbsp;| /gi, ' ');
  const resumo = limpar(semEntidade, 320);
  const titulo = limpar(t.titulo, 300);
  const veiculo = limpar(t.veiculo || t.fonte, 120);
  let resto = resumo;
  if (titulo && resto.toLowerCase().startsWith(titulo.toLowerCase())) resto = resto.slice(titulo.length).trim();
  if (!resto || (veiculo && resto.toLowerCase() === veiculo.toLowerCase())) return '';
  return resumo;
}

async function comPrazo(promessa, ms, fallback) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promessa).catch(() => fallback),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Rankings configurados em Configurações → Descobrir pautas. */
router.post('/mais-lidas', async (req, res, next) => {
  try {
    const service = require('../services/pautaFontesService');
    const resultado = await service.descobrirMaisLidas(req.session.userId);
    return res.json({
      ok: true,
      origem: 'mais-lidas',
      fontes: resultado.fontes,
      totalEncontrado: resultado.totalEncontrado,
      totalOcultado: resultado.totalOcultado,
      erros: resultado.erros,
      topicos: (resultado.topicos || []).map((item) => ({
        titulo: limpar(item.titulo, 300),
        url: String(item.url || '').trim().slice(0, 1000),
        veiculo: limpar(item.veiculo || item.fonteNome || 'Web', 120),
        resumo: limpar(item.resumo, 420) || null,
        imagem: String(item.imagem || '').trim().slice(0, 1000) || null,
        posicao: Number(item.posicao) || null,
        fonteId: Number(item.fonteId) || null,
      })),
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, codigo: err.codigo || null });
    }
    return next(err);
  }
});

/**
 * Radar de assuntos em alta agora.
 * Sem busca → abre nos temas padrão. Com busca → foca no que o usuário pediu.
 */
router.post('/em-alta', async (req, res, next) => {
  try {
    const body = req.body || {};
    const busca = limpar(body.busca || body.palavrasExtras || body.palavras_extras, 200);
    const horasSolicitadas = Number(body.horas);
    const horas = [24, 48, 72, 168].includes(horasSolicitadas) ? horasSolicitadas : 48;

    const temasDaBusca = busca
      .split(/[,;]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
      .slice(0, 5)
      .map((t) => ({ rotulo: t, consultas: [t] }));

    const usandoPadrao = temasDaBusca.length === 0;
    const temas = usandoPadrao ? TEMAS_PADRAO : temasDaBusca;

    const tendenciasPromise = usandoPadrao
      ? comPrazo(
          require('../services/googleTrendsService').buscarTrendsBrasil({
            limit: 12,
            onlyGospel: false,
          }),
          8000,
          []
        )
      : Promise.resolve([]);

    const [resultado, tendenciasGoogle] = await Promise.all([
      radarPorTemas(temas, {
        horas,
        limite: LIMITE_TOPICOS,
        userId: req.session.userId,
      }),
      tendenciasPromise,
    ]);

    const topicos = (resultado.topicos || [])
      .filter((t) => t && t.titulo && (t.link || t.url))
      .map((t) => ({
        titulo: limpar(t.titulo, 300),
        url: String(t.link || t.url).trim().slice(0, 500),
        veiculo: limpar(t.veiculo || t.fonte || 'Web', 80),
        resumo: resumoUtil(t),
        imagem: /^https?:\/\//i.test(String(t.imagemFonte || t.imagem || '')) ? String(t.imagemFonte || t.imagem) : null,
        dataTimestamp: Number(t.dataTimestamp) || null,
        tema: limpar(t.tema, 60) || null,
        contagemFontes: Number(t.contagemFontes) || 1,
        calor: Number(t.calor) || 0,
        sinalRedes: Boolean(t.sinalRedes || t.redeSocial || t.tipoFonte === 'rede_social'),
        sinalGoogleNews: Boolean(t.sinalTrends || t.emAlta),
      }));

    // Zero pauta por bloqueio do Google é diferente de "nada em alta hoje".
    // Sem este aviso a tela dizia "tente de novo em alguns minutos" enquanto o
    // servidor seguia em pausa por meia hora.
    const pausaGoogle = require('../services/googleNewsLimiter').estado();
    const avisos = [];
    if (pausaGoogle.pausado) {
      avisos.push(
        `O Google News limitou este servidor (${pausaGoogle.motivo}) e as consultas estão em pausa até ${new Intl.DateTimeFormat(
          'pt-BR',
          { timeZone: 'America/Araguaina', hour: '2-digit', minute: '2-digit' }
        ).format(new Date(pausaGoogle.ate))}. Os resultados abaixo podem estar incompletos.`
      );
    }

    return res.json({
      ok: true,
      origem: 'em-alta',
      horas,
      temas: temas.map((t) => t.rotulo),
      padrao: usandoPadrao,
      limite: LIMITE_TOPICOS,
      avisos,
      googleEmPausa: pausaGoogle.pausado,
      totalAnalisado: Number(resultado.totalAnalisado) || 0,
      totalOcultado: Number(resultado.totalOcultado) || 0,
      tendenciasGoogle: (Array.isArray(tendenciasGoogle) ? tendenciasGoogle : []).map((item) => ({
        termo: limpar(item.termo, 120),
        crescimento: Number(item.crescimento) || 0,
      })).filter((item) => item.termo),
      topicos,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * Sugere noticias novas usando como sinais os assuntos das materias que tiveram
 * melhor engajamento na pagina padrao do usuario.
 */
router.post('/para-meu-publico', async (req, res, next) => {
  try {
    const { defaultPageIdForUser } = require('../services/facebookPageResolver');
    const viralizarService = require('../services/viralizarService');
    const facebookPageId = await defaultPageIdForUser(req.session.userId);
    if (!facebookPageId) {
      return res.status(400).json({
        error: 'Defina a página padrão em Páginas antes de buscar pautas para o seu público.',
      });
    }

    const resultado = await viralizarService.curarPautasDoPublico({
      userId: req.session.userId,
      facebookPageId,
      limit: req.body?.limit || 30,
    });

    const topicos = (resultado.topicos || []).map((topico) => ({
      titulo: limpar(topico.titulo, 300),
      url: String(topico.link || topico.url || '').trim().slice(0, 500) || null,
      veiculo: limpar(topico.veiculo || topico.fonte || 'Web', 80),
      resumo: limpar(topico.resumo || topico.trecho, 420),
      tema: limpar(topico.temaLabel || topico.nicho || '', 80) || null,
      potencial: topico.potencial || null,
      scoreViral: Number(topico.scoreViral) || 0,
      afinidadePublico: Number(topico.afinidadePublico) || 0,
      potencialPublico: Number(topico.potencialPublico) || 0,
      motivoAfinidade: limpar(topico.motivoAfinidade || '', 180) || null,
      data: limpar(topico.data || topico.dataReferencia || '', 80) || null,
      dataTimestamp: Number(topico.dataTimestamp) || null,
    }));

    return res.json({
      ok: true,
      origem: 'viralizadas',
      facebookPageId,
      ...resultado,
      topicos,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, avisos: err.avisos || [] });
    }
    return next(err);
  }
});

/** Lista posts de uma página do Facebook para o editor escolher no chat. */
router.post('/pagina-facebook/posts', async (req, res, next) => {
  try {
    const service = require('../services/facebookPageMatterService');
    const resultado = await service.listarPostsDaPagina(req.body?.url, {
      limit: req.body?.limit || 40,
    });
    return res.json({
      ok: true,
      origem: 'pagina-facebook',
      ...resultado,
      topicos: resultado.posts,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, avisos: err.avisos || [] });
    }
    return next(err);
  }
});

/**
 * Anexo PDF. O arquivo não é guardado: o texto volta para o navegador,
 * que o envia junto da mensagem do chat.
 */
router.post('/anexos', (req, res, next) => {
  uploadChatDoc(req, res, async (uploadError) => {
    if (uploadError) {
      const mensagem =
        uploadError.code === 'LIMIT_FILE_SIZE'
          ? 'PDF muito grande. O limite é 15 MB.'
          : uploadError.message || 'Falha ao receber o arquivo';
      return res.status(uploadError.status || 400).json({ error: mensagem });
    }

    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'Escolha um arquivo PDF para enviar.' });
      }
      const { extrairTextoDePdf } = require('../services/documentText');
      const doc = await extrairTextoDePdf(req.file.buffer);
      const nome = limpar(req.file.originalname || 'documento.pdf', 200) || 'documento.pdf';
      return res.json({ ok: true, anexo: { nome, ...doc } });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  });
});

/**
 * Imagem como fonte: roda OCR local, informa se existe texto legível e devolve
 * o conteúdo para o navegador anexar ao pedido da matéria.
 */
router.post('/anexos-imagem', (req, res, next) => {
  uploadMatterImage(req, res, async (uploadError) => {
    if (uploadError) {
      const mensagem =
        uploadError.code === 'LIMIT_FILE_SIZE'
          ? 'Imagem muito grande. O limite é 12 MB.'
          : uploadError.message || 'Falha ao receber a imagem';
      return res.status(uploadError.status || 400).json({ error: mensagem });
    }

    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'Escolha uma imagem para enviar.' });
      }
      const { analisarTextoDaImagem } = require('../services/imageOcrService');
      const analise = await analisarTextoDaImagem(req.file.buffer);
      const nome = limpar(req.file.originalname || 'imagem', 200) || 'imagem';

      if (!analise.temTexto) {
        return res.status(422).json({
          error:
            'Não encontrei texto legível suficiente nessa imagem. Envie um print mais nítido, sem corte e com letras maiores.',
          analise: {
            nome,
            confianca: analise.confianca,
            palavras: analise.palavras,
            largura: analise.largura,
            altura: analise.altura,
          },
        });
      }

      return res.json({
        ok: true,
        anexo: {
          nome,
          tipo: 'imagem',
          texto: analise.texto,
          confianca: analise.confianca,
          palavras: analise.palavras,
          largura: analise.largura,
          altura: analise.altura,
          truncado: analise.truncado,
        },
      });
    } catch (err) {
      console.error('[chat-imagem] OCR:', err.message);
      if (err.status) return res.status(err.status).json({ error: err.message });
      return res.status(502).json({
        error: 'Não consegui ler essa imagem agora. Tente novamente com um arquivo PNG ou JPG mais nítido.',
      });
    }
  });
});

/* —— Imagens das pautas do radar —— */

const CACHE_IMAGEM_MS = 60 * 60 * 1000;
const cacheImagens = new Map();

/**
 * O radar chega com link do Google News e sem foto. Em ordem de custo:
 *   1. a mesma notícia nos portais (já em cache, custo zero);
 *   2. o link do Google decodificado para o endereço real (um Python só
 *      para o lote inteiro) e a og:image dessa página;
 *   3. só para o que sobrar, a busca da matéria pelo título.
 * Devolve também o link direto, que o rascunho e o agendamento passam a usar.
 */
async function imagensDasPautas(pautas, itensPortais) {
  const nr = require('../services/newsResearch');
  const { extrairMetadadosImagemArtigo } = require('../services/articleSource');
  const { completarLinkEImagem } = require('../services/furosService');
  const resultado = new Map();
  const pendentes = [];

  for (const pauta of pautas) {
    const guardada = cacheImagens.get(pauta.url);
    if (guardada && guardada.expiraEm > Date.now()) {
      resultado.set(pauta.url, guardada.valor);
      continue;
    }
    const doPortal = itensPortais.find((item) => item.imagem && nr.titulosSimilares(item.titulo, pauta.titulo));
    if (doPortal) resultado.set(pauta.url, { url: doPortal.link, veiculo: doPortal.veiculo, imagem: doPortal.imagem });
    else pendentes.push(pauta);
  }

  const decodificados = await comPrazo(
    nr.decodificarLinksGoogle(pendentes.map((p) => p.url)),
    25_000,
    new Map()
  );

  // No máximo 3 páginas lidas ao mesmo tempo, para não pesar no servidor.
  let proxima = 0;
  await Promise.all(Array.from({ length: Math.min(3, pendentes.length) }, async () => {
    while (proxima < pendentes.length) {
      const pauta = pendentes[proxima];
      proxima += 1;
      const urlReal = decodificados.get(pauta.url) || (/news\.google\.com/i.test(pauta.url) ? null : pauta.url);
      let valor = null;
      if (urlReal) {
        const meta = await comPrazo(extrairMetadadosImagemArtigo(urlReal), 9_000, null);
        const imagem = /^https?:\/\//i.test(String(meta?.imagem || '')) ? String(meta.imagem) : null;
        valor = { url: urlReal, veiculo: pauta.veiculo, imagem };
      }
      if (!valor?.imagem) {
        const completo = await comPrazo(completarLinkEImagem({ ...pauta, imagem: null }, []), 20_000, null);
        if (completo?.imagem) valor = { url: completo.url, veiculo: completo.veiculo, imagem: completo.imagem };
      }
      resultado.set(pauta.url, valor || { url: urlReal || pauta.url, veiculo: pauta.veiculo, imagem: null });
    }
  }));

  for (const pauta of pendentes) {
    cacheImagens.set(pauta.url, { valor: resultado.get(pauta.url), expiraEm: Date.now() + CACHE_IMAGEM_MS });
  }
  while (cacheImagens.size > 2000) cacheImagens.delete(cacheImagens.keys().next().value);
  return resultado;
}

router.post('/radar/imagens', async (req, res, next) => {
  try {
    const pautas = (Array.isArray(req.body?.pautas) ? req.body.pautas : [])
      .map((p) => ({
        url: String(p?.url || '').trim().slice(0, 1000),
        titulo: limpar(p?.titulo, 300),
        veiculo: limpar(p?.veiculo, 120),
      }))
      .filter((p) => /^https?:\/\//i.test(p.url) && p.titulo)
      .slice(0, 12);
    if (!pautas.length) return res.json({ ok: true, imagens: [] });

    const { buscarNosPortais } = require('../services/portaisNichoService');
    const { NICHOS } = require('../services/furosService');
    const portais = await buscarNosPortais({ nichos: NICHOS.map((n) => n.id), horas: 168 }).catch(() => ({ itens: [] }));

    const achados = await imagensDasPautas(pautas, portais.itens || []);
    const imagens = pautas.map((pauta) => ({
      original: pauta.url,
      ...(achados.get(pauta.url) || { url: pauta.url, imagem: null }),
    }));
    return res.json({ ok: true, imagens });
  } catch (err) {
    return next(err);
  }
});

/* —— Furos do dia: notícias quentes por nicho → matérias em lote —— */

router.get('/furos/nichos', async (req, res, next) => {
  try {
    const furos = require('../services/furosService');
    return res.json({
      ok: true,
      nichos: furos.listarNichos(),
      sugeridos: await furos.escolherNichosAutomaticos(req.session.userId),
    });
  } catch (err) {
    return next(err);
  }
});

/** Situação dos portais lidos direto (feed/WordPress). Usa o mesmo cache. */
router.get('/furos/portais', async (_req, res, next) => {
  try {
    const { statusDosPortais } = require('../services/portaisNichoService');
    return res.json({ ok: true, portais: await statusDosPortais() });
  } catch (err) {
    return next(err);
  }
});

router.post('/furos/buscar', async (req, res, next) => {
  try {
    const body = req.body || {};
    const resultado = await require('../services/furosService').buscarFuros({
      userId: req.session.userId,
      nichos: Array.isArray(body.nichos) ? body.nichos.slice(0, 8) : [],
      palavras: Array.isArray(body.palavras) ? body.palavras.slice(0, 40) : String(body.palavras || ''),
      horas: Number(body.horas) || 24,
      limite: Math.min(Math.max(Number(body.limite) || 12, 3), 40),
      canais: Array.isArray(body.canais) ? body.canais.slice(0, 4) : [],
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

/** Uma pauta por chamada: o front mostra o progresso de cada matéria. */
router.post('/furos/gerar', async (req, res, next) => {
  try {
    const furos = require('../services/furosService');
    // Vídeo/post das redes: transcreve e escreve pelo chat, em segundo plano.
    if (furos.ehPautaDeRede(req.body?.pauta)) {
      const inicio = await furos.iniciarGeracaoDeRede({
        userId: req.session.userId,
        pauta: req.body.pauta,
        facebookPageId: req.body?.facebookPageId || null,
        modelo: req.body?.modelo || null,
      });
      return res.status(202).json({ ok: true, ...inicio });
    }
    const resultado = await furos.gerarFuro({
      userId: req.session.userId,
      pauta: req.body?.pauta || {},
      facebookPageId: req.body?.facebookPageId || null,
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

/* —— Furos do dia no piloto automático —— */

function responderAuto(res, next, promessa) {
  return promessa
    .then((status) => res.json({ ok: true, ...status }))
    .catch((err) => (err.status ? res.status(err.status).json({ error: err.message }) : next(err)));
}

router.get('/furos/auto', (req, res, next) =>
  responderAuto(res, next, require('../services/furosAutopilotService').statusPainel(req.session.userId)));

router.put('/furos/auto', (req, res, next) =>
  responderAuto(res, next, require('../services/furosAutopilotService').salvarConfig(req.session.userId, req.body || {})));

/** Notificações no app ntfy (publicada / não publicada). */
router.put('/furos/auto/ntfy', loadCurrentUser, requireAdmin, (req, res, next) =>
  responderAuto(res, next, require('../services/furosAutopilotService').salvarNtfy(req.session.userId, req.body || {})));

router.post('/furos/auto/ntfy/teste', loadCurrentUser, requireAdmin, (req, res, next) =>
  responderAuto(res, next, require('../services/furosAutopilotService').testarNtfy(req.session.userId)));

router.put('/furos/auto/modelo', (req, res, next) =>
  responderAuto(res, next, require('../services/furosAutopilotService').salvarModelo(req.session.userId, req.body?.modelo)));

router.post('/furos/auto/pausar', (req, res, next) =>
  responderAuto(res, next, require('../services/furosAutopilotService').pausar(req.session.userId)));

router.post('/furos/auto/retomar', (req, res, next) =>
  responderAuto(res, next, require('../services/furosAutopilotService').retomar(req.session.userId)));

/** Pautas marcadas no Furos: escrever, gerar imagem e publicar no intervalo. */
router.post('/furos/auto/fila', async (req, res, next) => {
  try {
    const r = await require('../services/furosAutopilotService').enfileirarEscolhidas(req.session.userId, req.body || {});
    return res.json({ ok: true, adicionadas: r.adicionadas, ignoradas: r.ignoradas, ...r.status });
  } catch (err) {
    return err.status ? res.status(err.status).json({ error: err.message }) : next(err);
  }
});

router.post('/furos/auto/fila/cancelar', (req, res, next) =>
  responderAuto(res, next, require('../services/furosAutopilotService').cancelarFilaManual(req.session.userId)));

router.post('/furos/auto/escanear', (req, res, next) =>
  responderAuto(res, next, require('../services/furosAutopilotService').escanearAgora(req.session.userId)));

router.post('/furos/auto/itens/:id/refazer', (req, res, next) =>
  responderAuto(res, next, require('../services/furosAutopilotService').refazerItem(req.session.userId, Number(req.params.id))));

router.post('/furos/auto/itens/:id/descartar', (req, res, next) =>
  responderAuto(res, next, require('../services/furosAutopilotService').descartarItem(req.session.userId, Number(req.params.id))));

router.get('/furos/gerar/:jobId', (req, res) => {
  try {
    const status = require('../services/furosService').statusGeracao(req.session.userId, req.params.jobId);
    return res.status(status.estado === 'gerando' ? 202 : 200).json({ ok: true, ...status });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.TEMAS_PADRAO = TEMAS_PADRAO;
module.exports.radarPorTemas = radarPorTemas;
module.exports.pautasDosPortais = pautasDosPortais;
module.exports.LIMITE_TOPICOS = LIMITE_TOPICOS;
