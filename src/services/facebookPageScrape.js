const axios = require('axios');
const {
  buildFacebookCookieHeader,
  facebookHtmlHeaders,
  manterCookieFacebookNoRedirect,
} = require('./facebookCookies');

/**
 * Lista posts públicos de uma página do Facebook. O caminho principal pagina o
 * renderer do Page Plugin oficial; a sessão de YTDLP_FB_COOKIES_FILE é apenas
 * fallback para perfis que o plugin não aceita.
 */

/** Limites do fallback que abre os posts individualmente pela sessão. */
const MAX_DETALHES = Math.min(40, Math.max(1, Number(process.env.FB_PAGE_MAX_POSTS) || 40));
const CONCORRENCIA = Math.min(6, Math.max(1, Number(process.env.FB_PAGE_CONCORRENCIA) || 3));
const FACEBOOK_PAGE_PLUGIN_APP_ID = '776730922422337';
const FACEBOOK_PAGE_PLUGIN_RENDERER = 'https://www.facebook.com/platform/plugin/tab/renderer/';

function isConfigured() {
  return Boolean(buildFacebookCookieHeader());
}

function desescapar(texto) {
  return String(texto || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&');
}

function unescapeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return String(raw || '')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

/** Coleta ocorrências de um regex global junto do índice onde apareceram. */
function coletarComIndice(html, regex, transform = (v) => v) {
  const out = [];
  for (const m of html.matchAll(regex)) {
    const valor = transform(m[1]);
    if (valor) out.push({ valor, indice: m.index ?? 0 });
  }
  return out;
}

/**
 * Formas de permalink de post. Aceita absoluto ou relativo — o HTML mistura os
 * dois. Exige um identificador real (pfbid/numérico) para não capturar páginas
 * de listagem como /<pagina>/photos.
 */
const PADROES_POST = [
  /(?:https:\/\/www\.facebook\.com)?\/[A-Za-z0-9.-]{2,}\/posts\/(?:pfbid[A-Za-z0-9]+|\d{6,})/g,
  /(?:https:\/\/www\.facebook\.com)?\/permalink\.php\?story_fbid=(?:pfbid[A-Za-z0-9]+|\d{6,})&(?:amp;)?id=\d+/g,
  /(?:https:\/\/www\.facebook\.com)?\/story\.php\?story_fbid=(?:pfbid[A-Za-z0-9]+|\d{6,})&(?:amp;)?id=\d+/g,
  /(?:https:\/\/www\.facebook\.com)?\/reel\/\d{6,}/g,
  /(?:https:\/\/www\.facebook\.com)?\/[A-Za-z0-9.-]{2,}\/videos\/(?:[A-Za-z0-9%-]+\/)?\d{6,}/g,
  /(?:https:\/\/www\.facebook\.com)?\/photo\/?\?fbid=\d{6,}/g,
];

/** Segmentos que nunca são nome de página. */
const SEGMENTOS_INVALIDOS = /^(ajax|api|graphql|privacy|policies|help|settings|login|watch|marketplace|groups|events|pages|photo|reel|story\.php|permalink\.php)$/i;

function normalizarUrlPost(bruto) {
  let url = desescapar(bruto).trim();
  if (url.startsWith('/')) url = `https://www.facebook.com${url}`;
  try {
    const u = new URL(url);
    u.hostname = 'www.facebook.com';
    u.protocol = 'https:';
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (!/^(story_fbid|id|fbid|v)$/i.test(key)) u.searchParams.delete(key);
    }
    const primeiro = u.pathname.split('/').filter(Boolean)[0] || '';
    if (/\/posts\//i.test(u.pathname) && SEGMENTOS_INVALIDOS.test(primeiro)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * A URL é um permalink de post real (e não perfil, listagem ou tela de login)?
 * Usa cópias sem /g para não mexer no lastIndex dos padrões compartilhados.
 */
function ehUrlDePostValida(url) {
  const alvo = desescapar(url).trim();
  if (!alvo) return false;
  const casa = PADROES_POST.some((re) => new RegExp(re.source, 'i').test(alvo));
  return casa && Boolean(normalizarUrlPost(alvo));
}

/**
 * Extrai os permalinks de posts do HTML da página.
 * @returns {{ urls: string[], sinais: object }}
 */
function extrairUrlsDePosts(html) {
  // O HTML mistura barras escapadas (\/) com normais; normalizar uma vez deixa
  // os padrões simples e evita duplicar cada regex.
  const normalizado = String(html || '').replace(/\\\//g, '/');
  const urls = [];
  const vistos = new Set();
  const porPadrao = {};

  for (const re of PADROES_POST) {
    let achados = 0;
    for (const m of normalizado.matchAll(re)) {
      achados++;
      const url = normalizarUrlPost(m[0]);
      if (!url) continue;
      const chave = url.toLowerCase();
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      urls.push(url);
    }
    porPadrao[re.source.slice(0, 42)] = achados;
  }

  return {
    urls,
    sinais: { tamanhoHtml: normalizado.length, unicos: urls.length, porPadrao },
  };
}

function idDoPostNaUrl(url) {
  const alvo = String(url || '');
  return (
    alvo.match(/story_fbid=(pfbid[A-Za-z0-9]+|\d{6,})/i)?.[1] ||
    alvo.match(/\/posts\/(pfbid[A-Za-z0-9]+|\d{6,})/i)?.[1] ||
    alvo.match(/[?&]fbid=(\d{6,})/i)?.[1] ||
    alvo.match(/\/(?:reel|videos)\/(\d{6,})/i)?.[1] ||
    null
  );
}

function decodificarEntidadesHtml(valor) {
  const mapa = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    nbsp: ' ',
  };
  return String(valor || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#(\d+);/g, (_, numero) => {
      try {
        return String.fromCodePoint(Number(numero));
      } catch {
        return '';
      }
    })
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, nome) => mapa[nome.toLowerCase()] || '');
}

function textoDeHtml(valor) {
  return decodificarEntidadesHtml(
    String(valor || '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<span\b[^>]*class="[^"]*text_exposed_hide[^"]*"[^>]*>[\s\S]*?<\/span>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(?:Ver mais|See more)\s*$/i, '')
    .trim();
}

function indicesDaAncora(html, idPost) {
  if (!idPost) return [];
  const out = [];
  let indice = String(html || '').indexOf(idPost);
  while (indice !== -1 && out.length < 250) {
    out.push(indice);
    indice = String(html).indexOf(idPost, indice + 1);
  }
  return out;
}

function candidatoMaisPerto(candidatos, ancoras, distanciaMaxima = Infinity) {
  if (!candidatos.length) return null;
  if (!ancoras.length) return candidatos.length === 1 ? candidatos[0] : null;
  let melhor = null;
  let distancia = Infinity;
  for (const candidato of candidatos) {
    for (const ancora of ancoras) {
      const atual = Math.abs(candidato.indice - ancora);
      if (atual < distancia) {
        distancia = atual;
        melhor = candidato;
      }
    }
  }
  return distancia <= distanciaMaxima ? melhor : null;
}

/**
 * A imagem é de perfil, capa ou avatar — e não do post?
 *
 * No CDN do Facebook, foto de perfil vem em `t39.30808-1` e foto de post em
 * `t39.30808-6`. Miniatura de avatar também é pequena (s40x40, p50x50): nenhum
 * post usa foto desse tamanho.
 */
function pareceFotoDePerfil(url) {
  const texto = String(url || '');
  if (/t39\.30808-1\//i.test(texto)) return true;

  // Miniatura de avatar vem dimensionada (s40x40, p50x50). Nenhuma foto de
  // post é publicada nesse tamanho.
  const medida = texto.match(/\/[sp](\d{2,4})x(\d{2,4})\//i);
  if (medida) {
    const lado = Math.max(Number(medida[1]) || 0, Number(medida[2]) || 0);
    if (lado && lado <= 200) return true;
  }
  return false;
}

/**
 * Imagem do post, por ordem de confiança.
 *
 * Antes os três padrões caíam no mesmo balde e só a proximidade decidia. O
 * terceiro (`"uri": ...scontent...`) casa com QUALQUER imagem do CDN — inclusive
 * a foto de perfil da página, que fica no começo do HTML. Com janela de 50 KB
 * ela vencia a foto real do post, e a matéria saía com o avatar da página.
 *
 * Agora o genérico só entra se os específicos não acharem nada, e com janela
 * bem menor.
 */
function escolherImagemDoPost(html, ancoras) {
  const texto = String(html || '');

  const juntar = (re) => {
    const achados = [];
    for (const m of texto.matchAll(re)) {
      const url = desescapar(m[1]);
      if (/rsrc\.php|static\.xx\.fbcdn/i.test(url)) continue;
      if (pareceFotoDePerfil(url)) continue;
      achados.push({ valor: url, indice: m.index ?? 0 });
    }
    return achados;
  };

  // 1) Campos que só existem na foto do próprio post.
  const especificos = [
    ...juntar(/"photo_image"\s*:\s*\{[^}]*?"uri"\s*:\s*"(https:[^"]+)"/gi),
    ...juntar(/"full_width_image"\s*:\s*\{[^}]*?"uri"\s*:\s*"(https:[^"]+)"/gi),
  ];
  const doPost = candidatoMaisPerto(especificos, ancoras, 50_000)?.valor;
  if (doPost) return doPost;

  // 2) Último recurso: qualquer imagem do CDN, mas só se estiver colada no post.
  const genericos = juntar(/"uri"\s*:\s*"(https:[^"]*scontent[^"]+)"/gi);
  return candidatoMaisPerto(genericos, ancoras, 8_000)?.valor || null;
}

/** Texto, imagem e data ancorados no identificador do post aberto. */
function extrairDetalhesDoPost(html, urlAlvo = null) {
  const mensagensComIndice = coletarComIndice(
    html,
    /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    (v) => {
      const t = unescapeJsonString(v).trim();
      return t.length >= 20 ? t : null;
    }
  );
  const mensagens = mensagensComIndice.map((m) => m.valor);
  mensagens.sort((a, b) => b.length - a.length);

  let texto = mensagens[0] || null;
  const idPost = idDoPostNaUrl(urlAlvo);
  const ancoras = indicesDaAncora(html, idPost);
  if (urlAlvo) {
    // Sem uma mensagem perto do ID exato, descarta. Usar a maior mensagem ou
    // a mais próxima sem limite trouxe uma notícia de outro perfil/recomendado.
    texto = candidatoMaisPerto(mensagensComIndice, ancoras, 8_000)?.valor || null;
    // Em /NomeDaPagina/posts/... o dono está provado pela própria URL. Nesse
    // formato podemos usar o seletor ancorado mais tolerante; para photo/reel
    // genérico continuamos no filtro estrito acima.
    if (!texto && /^https?:\/\/[^/]*facebook\.com\/[A-Za-z0-9.-]+\/(?:posts|videos)\//i.test(urlAlvo)) {
      const { escolherMensagemDoPost } = require('./socialPostExtract');
      texto = escolherMensagemDoPost(html, urlAlvo).texto || null;
    }
  }

  const imagem = escolherImagemDoPost(html, ancoras);

  const tempos = coletarComIndice(
    html,
    /"creation_time"\s*:\s*(\d{9,13})/g,
    (valor) => Number(valor) || null
  );
  const ts = Number(candidatoMaisPerto(tempos, ancoras, 50_000)?.valor) || 0;
  const publicadoEm = ts ? new Date(ts > 10_000_000_000 ? ts : ts * 1000) : null;

  const atores = coletarComIndice(
    html,
    /"actors"\s*:\s*\[\s*\{[\s\S]{0,1200}?"name"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    (valor) => unescapeJsonString(valor).trim() || null
  );
  const autor = candidatoMaisPerto(atores, ancoras, 20_000)?.valor || null;

  return {
    texto,
    imagem,
    autor,
    publicadoEm: publicadoEm && !Number.isNaN(publicadoEm.getTime()) ? publicadoEm : null,
  };
}

function tituloDoTexto(texto, fallback) {
  const primeiraLinha = String(texto || '')
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .find(Boolean);
  return String(primeiraLinha || fallback || 'Post do Facebook').slice(0, 120);
}

function paginaCanonicaParaPlugin(pageUrl) {
  const u = new URL(String(pageUrl || '').trim());
  u.protocol = 'https:';
  u.hostname = 'www.facebook.com';
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (!(/^\/profile\.php$/i.test(u.pathname) && key === 'id')) u.searchParams.delete(key);
  }
  u.pathname = u.pathname.replace(/\/(?:posts|photos|videos|reels)\/?$/i, '').replace(/\/+$/, '') || '/';
  return u.toString();
}

/** Converte a marcação do Page Plugin em posts sem abrir cada link. */
function extrairPostsDoMarkupPlugin(markup, pagina) {
  const html = String(markup || '');
  const inicios = [...html.matchAll(/<div class="_4-u2\s+mbm\b/gi)].map((match) => match.index || 0);
  const itens = [];

  for (let indice = 0; indice < inicios.length; indice += 1) {
    const bloco = html.slice(inicios[indice], inicios[indice + 1] || html.length);
    const urls = extrairUrlsDePosts(bloco).urls;
    const url =
      urls.find((item) => /\/(?:posts|videos)\/|\/(?:permalink|story)\.php/i.test(item)) ||
      urls[0];
    if (!url) continue;

    const mensagemHtml =
      bloco.match(/data-testid="post_message"[^>]*>([\s\S]*?)(?=<div class="_2162\b)/i)?.[1] ||
      '';
    const texto = textoDeHtml(mensagemHtml);
    if (texto.length < 20) continue;

    const imagens = [...bloco.matchAll(/<img\b[^>]*\bsrc="(https:\/\/[^"\s]+)"/gi)]
      .map((match) => decodificarEntidadesHtml(match[1]))
      .filter((src) => /scontent|fbcdn/i.test(src))
      .filter((src) => !/s50x50|t39\.30808-1\//i.test(src));
    const timestamp = Number(bloco.match(/\bdata-utime="(\d{9,13})"/i)?.[1]) || 0;
    const autorHtml = bloco.match(/<div class="_2_79[^"<>]*">([\s\S]*?)<\/div>/i)?.[1] || '';
    const autor = textoDeHtml(autorHtml) || pagina || null;
    const publicadoEm = timestamp
      ? new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000)
      : null;

    itens.push({
      externalId: url,
      mediaType: /video_redirect|<video\b|\/(?:reel|videos)\//i.test(bloco) ? 'video' : 'image',
      titulo: tituloDoTexto(texto, 'Post do Facebook'),
      url,
      texto,
      resumo: texto.slice(0, 400),
      thumbnail: imagens[0] || null,
      autor,
      publicadoEm:
        publicadoEm && !Number.isNaN(publicadoEm.getTime()) ? publicadoEm : null,
    });
  }

  return itens;
}

function proximoCursorDoPlugin(raw) {
  return (
    String(raw || '').match(
      /\["PluginTabLoadMore","setCursor",\[\],\["([^"]+)"\]\]/
    )?.[1] || ''
  );
}

/**
 * Pagina o feed público pelo renderer usado pelo Page Plugin oficial da Meta.
 * São cinco posts por página e até oito páginas, sem consumir API paga.
 */
async function listarPostsViaPlugin(pageUrl, limite = 20) {
  const max = Math.min(40, Math.max(1, Number(limite) || 20));
  const pagina = paginaCanonicaParaPlugin(pageUrl);
  const config = {
    app_id: FACEBOOK_PAGE_PLUGIN_APP_ID,
    href: pagina,
    width: 500,
    height: 800,
    has_cta: false,
    has_small_header: true,
    has_adapt_container_width: true,
    has_cover: false,
    has_posts: false,
    tabs: 'timeline',
    can_personalize: false,
    is_xfbml: false,
    referer_uri: '',
  };
  const referer = `https://www.facebook.com/plugins/page.php?href=${encodeURIComponent(pagina)}&tabs=timeline&width=500&height=800&small_header=true&adapt_container_width=true&hide_cover=true&show_facepile=false`;
  const itens = [];
  const urlsVistas = new Set();
  const cursoresVistos = new Set();
  let cursor = '';
  let paginas = 0;
  const maxPaginas = Math.min(8, Math.max(1, Math.ceil(max / 5)));
  const maxRequisicoes = Math.min(10, maxPaginas + 2);
  let repeticoesCursor = 0;

  while (itens.length < max && paginas < maxRequisicoes) {
    const resposta = await axios.get(FACEBOOK_PAGE_PLUGIN_RENDERER, {
      params: {
        key: 'timeline',
        config_json: JSON.stringify(config),
        ...(cursor ? { cursor } : {}),
      },
      timeout: 30000,
      maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json,text/javascript,*/*;q=0.01',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: referer,
      },
      validateStatus: () => true,
    });
    if (resposta.status >= 400) {
      // O renderer às vezes mantém um cursor na última página, mas responde
      // 400 quando ele é usado. Os lotes já recebidos continuam válidos.
      if (itens.length) break;
      const detalhe = String(resposta.data || '').replace(/\s+/g, ' ').slice(0, 180);
      throw new Error(
        `Feed público do Facebook respondeu HTTP ${resposta.status}${detalhe ? `: ${detalhe}` : '.'}`
      );
    }

    const raw = String(resposta.data || '');
    let json;
    try {
      json = JSON.parse(raw.replace(/^for\s*\(;;\);\s*/, ''));
    } catch {
      throw new Error('O Facebook devolveu uma resposta inválida ao listar o feed público.');
    }
    const markup = String(json?.payload?.content?.markup?.__html || '');
    const lote = extrairPostsDoMarkupPlugin(markup, pagina);
    for (const item of lote) {
      const chave = String(item.url || '').toLowerCase();
      if (!chave || urlsVistas.has(chave)) continue;
      urlsVistas.add(chave);
      itens.push(item);
      if (itens.length >= max) break;
    }

    paginas += 1;
    const proximo = proximoCursorDoPlugin(raw);
    // O Facebook ocasionalmente omite ou repete o cursor em uma resposta e o
    // devolve normalmente ao repetir a mesma página. Faz uma única repetição
    // antes de considerar que o feed terminou.
    if (!proximo || cursoresVistos.has(proximo)) {
      if (repeticoesCursor < 1 && itens.length < max) {
        repeticoesCursor += 1;
        continue;
      }
      break;
    }
    repeticoesCursor = 0;
    cursoresVistos.add(proximo);
    cursor = proximo;
  }

  console.log(`[fb-plugin] ${pagina}: ${itens.length} post(s) em ${paginas} página(s)`);
  return itens.slice(0, max);
}

/**
 * Variantes da mesma página que costumam renderizar conjuntos diferentes de
 * permalinks. Unir as três aumenta bastante a colheita por scan.
 */
function variantesDaPagina(pageUrl) {
  const out = [];
  try {
    const u = new URL(pageUrl);
    if (/profile\.php/i.test(u.pathname)) {
      const id = u.searchParams.get('id');
      if (id) {
        out.push(`https://www.facebook.com/profile.php?id=${id}&sk=timeline`);
        out.push(`https://www.facebook.com/profile.php?id=${id}&sk=photos`);
        out.push(`https://www.facebook.com/profile.php?id=${id}&sk=videos`);
        out.push(`https://m.facebook.com/profile.php?id=${id}&sk=timeline`);
        out.push(`https://m.facebook.com/profile.php?id=${id}&sk=posts`);
      }
    } else {
      const base = `https://www.facebook.com${u.pathname.replace(/\/+$/, '')}`;
      const mobile = `https://m.facebook.com${u.pathname.replace(/\/+$/, '')}`;
      out.push(`${base}/posts`);
      out.push(`${base}/?sk=timeline`);
      out.push(`${base}/photos`);
      out.push(`${base}/reels`);
      out.push(`${base}/videos`);
      out.push(`${mobile}/posts`);
      out.push(`${mobile}/?sk=timeline`);
      out.push(`${mobile}/?sk=posts`);
    }
  } catch {
    /* a URL original ainda será tentada */
  }
  out.push(String(pageUrl).trim());
  return [...new Set(out)];
}

/** GET autenticado; erros de sessão viram exceção com status. */
async function baixarHtmlPagina(pageUrl) {
  const cookie = buildFacebookCookieHeader();
  if (!cookie) {
    const err = new Error('Sessão do Facebook não configurada (YTDLP_FB_COOKIES_FILE).');
    err.status = 503;
    throw err;
  }

  const res = await axios.get(String(pageUrl || '').trim(), {
    timeout: 45000,
    maxRedirects: 5,
    beforeRedirect: manterCookieFacebookNoRedirect(cookie),
    headers: facebookHtmlHeaders(cookie),
    validateStatus: () => true,
  });

  const finalUrl = String(
    res.request?.res?.responseURL || res.request?.res?.responseUrl || pageUrl
  );
  if (/\/login|\/checkpoint/i.test(finalUrl)) {
    const err = new Error(
      'A sessão do Facebook caiu (redirecionou para login/checkpoint). Reexporte YTDLP_FB_COOKIES_FILE.'
    );
    err.status = 401;
    throw err;
  }
  if (res.status >= 400) {
    const err = new Error(`Facebook respondeu HTTP ${res.status} para a página.`);
    err.status = 502;
    throw err;
  }
  return { html: String(res.data || ''), finalUrl, status: res.status };
}

/** Executa tarefas com concorrência limitada, preservando a ordem da entrada. */
async function mapearComLimite(itens, limite, tarefa) {
  const resultados = new Array(itens.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (cursor < itens.length) {
      const indice = cursor++;
      resultados[indice] = await tarefa(itens[indice], indice);
    }
  });
  await Promise.all(workers);
  return resultados;
}

/**
 * Lista posts da página no mesmo formato de scrapeCreatorsFacebook.listarPostsPerfil.
 */
async function listarPostsPerfil(pageUrl, limite = 20) {
  const max = Math.min(40, Math.max(1, Number(limite) || 20));
  let handleEsperado = '';
  try {
    const u = new URL(pageUrl);
    if (!/profile\.php/i.test(u.pathname)) handleEsperado = u.pathname.split('/').filter(Boolean)[0] || '';
  } catch {
    handleEsperado = '';
  }
  const slugEsperado = handleEsperado.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Caminho principal: o renderer do Page Plugin já entrega páginas de cinco
  // posts com texto, imagem e data. É público, rápido e não consome créditos.
  try {
    const postsPlugin = await listarPostsViaPlugin(pageUrl, max);
    if (postsPlugin.length) return postsPlugin;
  } catch (err) {
    console.warn(`[fb-plugin] ${pageUrl}: ${err.message}`);
  }

  // Perfis que não são aceitos pelo Page Plugin ainda usam a sessão como
  // fallback. Sem cookies, encerra sem repetir nove requisições que falhariam.
  if (!isConfigured()) return [];

  const urlComDonoEsperado = (url) => {
    if (!slugEsperado) return false;
    try {
      const u = new URL(url);
      const partes = u.pathname.split('/').filter(Boolean);
      const slugUrl = String(partes[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return slugUrl === slugEsperado && /\/(?:posts|videos)\//i.test(u.pathname);
    } catch {
      return false;
    }
  };

  // Etapa 1: colher permalinks de todas as variantes da página.
  const variantes = variantesDaPagina(pageUrl);
  const urls = [];
  const vistos = new Set();
  let htmlTotal = 0;
  const porVariante = {};

  const paginas = await mapearComLimite(variantes, 2, async (variante) => {
    try {
      const { html } = await baixarHtmlPagina(variante);
      const encontrados = extrairUrlsDePosts(html).urls;
      return { variante, encontrados, htmlLen: html.length };
    } catch (err) {
      // Variante indisponível não invalida o scan; a principal já basta.
      console.warn(`[fb-page] variante ${variante.slice(-40)}: ${err.message}`);
      return { variante, encontrados: [], htmlLen: 0 };
    }
  });

  // Junta na ordem de prioridade definida acima. Antes, duas requisições
  // concorrentes disputavam quem inseria primeiro e fotos de cabeçalho podiam
  // ocupar o limite antes dos posts reais.
  for (const pagina of paginas) {
    htmlTotal += pagina.htmlLen;
    porVariante[pagina.variante.replace('https://www.facebook.com', '')] = pagina.encontrados.length;
    for (const url of pagina.encontrados) {
      // /OutraPagina/posts/... é recomendação lateral, não publicação
      // da página solicitada. Links genéricos de foto/reel são validados
      // novamente pelo autor ancorado ao abrir o detalhe.
      if (slugEsperado) {
        try {
          const primeiro = new URL(url).pathname.split('/').filter(Boolean)[0] || '';
          const slugUrl = primeiro.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (/\/(?:posts|videos)\//i.test(new URL(url).pathname) && slugUrl !== slugEsperado) continue;
        } catch {
          continue;
        }
      }
      const chave = url.toLowerCase();
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      urls.push(url);
    }
  }

  if (!urls.length) {
    console.log(`[fb-page] ${pageUrl}: nenhum permalink — variantes=${JSON.stringify(porVariante)}`);
    return [];
  }

  const alvos = urls.slice(0, Math.min(max, MAX_DETALHES));
  const detalhes = await mapearComLimite(alvos, CONCORRENCIA, async (url) => {
    try {
      const res = await baixarHtmlPagina(url);
      const urlFinal = ehUrlDePostValida(res.finalUrl) ? res.finalUrl : url;
      return { url: urlFinal, ...extrairDetalhesDoPost(res.html, urlFinal) };
    } catch (err) {
      console.warn(`[fb-page] detalhe ${url.slice(0, 70)}: ${err.message}`);
      return { url, texto: null, imagem: null, publicadoEm: null };
    }
  });

  // Para criar matéria, foto de perfil/capa sem legenda não é pauta.
  const itensOrdenados = detalhes
    .filter((d) => {
      if (!d.texto || d.texto.trim().length < 20) return false;
      if (urlComDonoEsperado(d.url)) return true;
      if (!slugEsperado || !d.autor) return true;
      const slugAutor = d.autor.toLowerCase().replace(/[^a-z0-9]/g, '');
      return slugAutor.includes(slugEsperado) || slugEsperado.includes(slugAutor);
    })
    .map((d) => ({
      externalId: d.url,
      mediaType: /\/(reel|videos)\//i.test(d.url) ? 'video' : 'image',
      titulo: tituloDoTexto(d.texto, 'Post do Facebook'),
      url: d.url,
      texto: d.texto || null,
      resumo: d.texto ? d.texto.slice(0, 400) : null,
      thumbnail: d.imagem || null,
      autor: d.autor || null,
      publicadoEm: d.publicadoEm,
    }))
    .sort((a, b) => {
      const da = a.publicadoEm instanceof Date ? a.publicadoEm.getTime() : 0;
      const db = b.publicadoEm instanceof Date ? b.publicadoEm.getTime() : 0;
      return db - da;
    })
    .filter((item, indice, lista) => {
      const chave = String(item.texto || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .slice(0, 600);
      if (!chave) return false;
      return lista.findIndex((outro) => {
        const outraChave = String(outro.texto || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/https?:\/\/\S+/g, ' ')
          .replace(/[^a-z0-9]+/g, ' ')
          .trim()
          .slice(0, 600);
        return outraChave === chave;
      }) === indice;
    });

  const limiteRecente = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const itensRecentes = itensOrdenados.filter(
    (item) => item.publicadoEm instanceof Date && item.publicadoEm.getTime() >= limiteRecente
  );
  // Se pelo menos uma data confiável veio do Facebook, elimina cabeçalho,
  // capa e posts antigos. Sem data alguma, mantém o fallback para não zerar.
  const itens = itensRecentes.length ? itensRecentes : itensOrdenados;

  console.log(
    `[fb-page] ${pageUrl}: ${itens.length} post(s) de ${urls.length} link(s) — abertos=${alvos.length} variantes=${JSON.stringify(porVariante)} htmlLen=${htmlTotal}`
  );
  return itens;
}

module.exports = {
  isConfigured,
  listarPostsPerfil,
  listarPostsViaPlugin,
  baixarHtmlPagina,
  extrairUrlsDePosts,
  extrairDetalhesDoPost,
  extrairPostsDoMarkupPlugin,
  ehUrlDePostValida,
  variantesDaPagina,
  escolherImagemDoPost,
  pareceFotoDePerfil,
};
