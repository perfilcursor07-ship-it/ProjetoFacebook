const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');
const { JSDOM } = require('jsdom');
const PautaFontes = require('../models/PautaFontes');

const MARCADORES_PADRAO = [
  'mais lidas',
  'mais lidos',
  'mais populares',
  'mais acessadas',
  'mais acessados',
  'top globo',
  'top notícias',
  'top noticias',
  'em alta',
  'trending',
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function limparTexto(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function decodificarEntidades(value) {
  return String(value || '')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function semAcentos(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function enderecoPrivado(address) {
  const ip = String(address || '').replace(/^::ffff:/i, '');
  const versao = net.isIP(ip);
  if (versao === 4) {
    const p = ip.split('.').map(Number);
    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168)
    );
  }
  if (versao === 6) {
    return ip === '::' || ip === '::1' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
  }
  return false;
}

function normalizarUrlFonte(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    const err = new Error('Informe uma URL válida, começando com https://');
    err.status = 400;
    throw err;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    const err = new Error('A fonte precisa usar uma URL pública HTTP ou HTTPS.');
    err.status = 400;
    throw err;
  }
  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    enderecoPrivado(host)
  ) {
    const err = new Error('Endereços locais ou privados não podem ser rastreados.');
    err.status = 400;
    throw err;
  }
  parsed.hash = '';
  return parsed.toString().slice(0, 1000);
}

async function validarDnsPublico(url) {
  const host = new URL(url).hostname;
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((item) => enderecoPrivado(item.address))) {
    const err = new Error('A fonte resolveu para um endereço de rede não permitido.');
    err.status = 400;
    throw err;
  }
}

function baseDominio(hostname) {
  const partes = String(hostname || '').toLowerCase().replace(/^www\d*\./, '').split('.').filter(Boolean);
  if (partes.length <= 2) return partes.join('.');
  const segundoNivelBr = new Set(['com', 'org', 'net', 'gov', 'edu', 'mil']);
  if (partes.at(-1) === 'br' && segundoNivelBr.has(partes.at(-2))) return partes.slice(-3).join('.');
  return partes.slice(-2).join('.');
}

function mesmoSite(url, fonteUrl) {
  try {
    return baseDominio(new URL(url).hostname) === baseDominio(new URL(fonteUrl).hostname);
  } catch {
    return false;
  }
}

function urlCanonica(value, base) {
  try {
    const url = new URL(String(value || ''), base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'output'].forEach((p) =>
      url.searchParams.delete(p)
    );
    return url.toString().replace(/\?$/, '');
  } catch {
    return null;
  }
}

function pareceLinkEditorial(url, titulo, fonteUrl) {
  if (!url || !mesmoSite(url, fonteUrl)) return false;
  const texto = limparTexto(titulo, 300);
  if (texto.length < 22 || texto.split(/\s+/).length < 4) return false;
  const normal = semAcentos(texto);
  if (
    /^(?:mais lidas|mais populares|ultimas noticias|inicio|home|menu|assine|entrar|veja mais|carregar mais)$/.test(normal) ||
    /politica de privacidade|termos de uso|atendimento|newsletter|classificados|english edition|edicao do jornal|textos da edicao|feed rss|pagina rss|principios editoriais|manual de conduta|mapa do site|trabalhe conosco/.test(normal)
  ) return false;
  try {
    const atual = new URL(url);
    const origem = new URL(fonteUrl);
    if (atual.pathname.replace(/\/+$/, '') === origem.pathname.replace(/\/+$/, '')) return false;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|pdf|xml)(?:$|\?)/i.test(atual.pathname)) return false;
    if (/\/(?:login|assine|assinatura|newsletter|contato|privacidade|termos|autor|autores|tags?|rss|edicao|expediente|institucional)(?:\/|$)/i.test(atual.pathname)) return false;
    return atual.pathname.split('/').filter(Boolean).length >= 1;
  } catch {
    return false;
  }
}

function imagemDoElemento(anchor, base) {
  const card = anchor.closest('article, li, [class*="card"], [class*="item"], [class*="story"]') || anchor.parentElement;
  const img = card?.querySelector?.('img');
  const raw =
    img?.getAttribute('src') ||
    img?.getAttribute('data-src') ||
    img?.getAttribute('data-lazy-src') ||
    String(img?.getAttribute('srcset') || '').split(',')[0]?.trim().split(/\s+/)[0];
  return raw ? urlCanonica(raw, base) : null;
}

function resumoDoElemento(anchor) {
  const card = anchor.closest('article, li, [class*="card"], [class*="item"], [class*="story"]') || anchor.parentElement;
  const p = [...(card?.querySelectorAll?.('p') || [])]
    .map((el) => limparTexto(el.textContent, 420))
    .find((texto) => texto.length >= 35 && texto !== limparTexto(anchor.textContent, 420));
  return p || null;
}

function candidatoDoAnchor(anchor, fonteUrl) {
  const titulo = limparTexto(
    anchor.getAttribute('data-title') ||
      anchor.getAttribute('aria-label') ||
      anchor.querySelector('h1,h2,h3,h4,h5,h6')?.textContent ||
      anchor.textContent ||
      anchor.querySelector('img')?.getAttribute('alt'),
    300
  );
  const url = urlCanonica(anchor.getAttribute('href'), fonteUrl);
  if (!pareceLinkEditorial(url, titulo, fonteUrl)) return null;
  return {
    titulo,
    url,
    resumo: resumoDoElemento(anchor),
    imagem: imagemDoElemento(anchor, fonteUrl),
  };
}

function anchorsValidos(container, fonteUrl) {
  return [...container.querySelectorAll('a[href]')]
    .map((a) => candidatoDoAnchor(a, fonteUrl))
    .filter(Boolean);
}

function encontrarContainers(document, fonte) {
  const containers = [];
  if (fonte.seletor_css) {
    try {
      containers.push(...document.querySelectorAll(fonte.seletor_css));
    } catch {
      const err = new Error('O seletor CSS avançado não é válido.');
      err.status = 400;
      throw err;
    }
  }

  const marcadores = [fonte.marcador, ...MARCADORES_PADRAO].filter(Boolean).map(semAcentos);
  const elementos = document.querySelectorAll('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="titulo"],[aria-label]');
  for (const el of elementos) {
    const texto = semAcentos(limparTexto(el.textContent || el.getAttribute('aria-label'), 160));
    if (!texto || !marcadores.some((m) => texto.includes(m))) continue;
    let atual = el.parentElement;
    for (let nivel = 0; atual && nivel < 5; nivel += 1, atual = atual.parentElement) {
      if (anchorsValidos(atual, fonte.url).length >= 3) containers.push(atual);
    }
  }

  if (!containers.length || fonte.localizacao === 'pagina') {
    const main = document.querySelector('main,[role="main"]');
    if (main) containers.push(main);
  }
  if (!containers.length) containers.push(document.body);
  return [...new Set(containers)];
}

function extrairJsonLd(document, fonteUrl) {
  const itens = [];
  const visitar = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visitar);
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value.itemListElement)) {
      value.itemListElement.forEach((entry) => {
        const item = entry?.item || entry;
        const titulo = limparTexto(item?.headline || item?.name || entry?.name, 300);
        const url = urlCanonica(item?.url || entry?.url, fonteUrl);
        if (!pareceLinkEditorial(url, titulo, fonteUrl)) return;
        const image = Array.isArray(item?.image) ? item.image[0] : item?.image?.url || item?.image;
        itens.push({ titulo, url, imagem: urlCanonica(image, fonteUrl), resumo: null });
      });
    }
    Object.values(value).forEach(visitar);
  };

  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      visitar(JSON.parse(script.textContent || 'null'));
    } catch {
      // JSON-LD inválido não derruba a página inteira.
    }
  });
  return itens;
}

function lerJsonBalanceado(texto, inicio) {
  const abertura = texto[inicio];
  const fechamento = abertura === '{' ? '}' : abertura === '[' ? ']' : null;
  if (!fechamento) return null;
  let nivel = 0;
  let emString = false;
  let escape = false;
  for (let i = inicio; i < texto.length; i += 1) {
    const c = texto[i];
    if (emString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') emString = false;
      continue;
    }
    if (c === '"') {
      emString = true;
      continue;
    }
    if (c === abertura) nivel += 1;
    else if (c === fechamento) {
      nivel -= 1;
      if (nivel === 0) return texto.slice(inicio, i + 1);
    }
  }
  return null;
}

function extrairImagemObjeto(value, fonteUrl) {
  const raw =
    value?.promo_items?.basic?.url ||
    value?.promo_items?.basic?.additional_properties?.fullSizeResizeUrl ||
    value?.image?.url ||
    (Array.isArray(value?.image) ? value.image[0] : value?.image) ||
    value?.thumbnail?.url ||
    value?.thumbnail;
  return urlCanonica(raw, fonteUrl);
}

function coletarArtigosDeObjeto(value, fonteUrl, saida, estado = { visitados: 0 }) {
  if (!value || estado.visitados > 20_000) return;
  estado.visitados += 1;
  if (Array.isArray(value)) {
    value.forEach((item) => coletarArtigosDeObjeto(item, fonteUrl, saida, estado));
    return;
  }
  if (typeof value !== 'object') return;

  const titulo = limparTexto(
    value?.headlines?.basic || value?.headline || value?.title || value?.titulo || value?.name,
    300
  );
  const url = urlCanonica(
    value?.canonical_url || value?.canonicalUrl || value?.website_url || value?.link || value?.url,
    fonteUrl
  );
  if (pareceLinkEditorial(url, titulo, fonteUrl)) {
    saida.push({
      titulo,
      url,
      resumo: limparTexto(
        value?.subheadlines?.basic || value?.description?.basic || value?.description || value?.summary,
        420
      ) || null,
      imagem: extrairImagemObjeto(value, fonteUrl),
    });
  }
  Object.values(value).forEach((item) => coletarArtigosDeObjeto(item, fonteUrl, saida, estado));
}

function extrairEstadoDeScripts(document, fonte) {
  const saida = [];
  const marcadores = [fonte.marcador, ...MARCADORES_PADRAO]
    .filter(Boolean)
    .map((item) => semAcentos(item).replace(/[^a-z0-9]+/g, ' ').trim());

  function explorarRankings(value, profundidade = 0) {
    if (!value || typeof value !== 'object' || profundidade > 12) return;
    if (Array.isArray(value)) {
      value.forEach((item) => explorarRankings(item, profundidade + 1));
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const chave = semAcentos(key).replace(/[^a-z0-9]+/g, ' ').trim();
      if (marcadores.some((marcador) => chave.includes(marcador))) {
        coletarArtigosDeObjeto(item, fonte.url, saida);
      } else {
        explorarRankings(item, profundidade + 1);
      }
    }
  }

  document.querySelectorAll('script').forEach((script) => {
    const texto = String(script.textContent || '').trim();
    if (!texto || texto.length > 3_000_000) return;
    const objetos = [];
    if (/^(?:application\/json|application\/ld\+json)$/i.test(script.type || '')) {
      try {
        objetos.push(JSON.parse(texto));
      } catch {
        // Alguns portais incluem comentários no script JSON.
      }
    }

    const atribuicoes = ['contentCache=', '__INITIAL_STATE__=', '__PRELOADED_STATE__=', '__NEXT_DATA__='];
    for (const token of atribuicoes) {
      let cursor = 0;
      while ((cursor = texto.indexOf(token, cursor)) >= 0) {
        const inicio = texto.indexOf('{', cursor + token.length);
        if (inicio < 0) break;
        const json = lerJsonBalanceado(texto, inicio);
        if (!json) break;
        try {
          objetos.push(JSON.parse(json));
        } catch {
          // Estado não era JSON estrito; segue para outro fallback.
        }
        cursor = inicio + json.length;
      }
    }
    objetos.forEach((objeto) => explorarRankings(objeto));
  });
  return saida;
}

function deduplicar(itens, limite) {
  const vistosUrl = new Set();
  const vistosTitulo = new Set();
  const saida = [];
  for (const item of itens) {
    const keyUrl = String(item.url || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase();
    const keyTitulo = semAcentos(item.titulo).replace(/[^a-z0-9]+/g, ' ').trim();
    if (!keyUrl || vistosUrl.has(keyUrl) || vistosTitulo.has(keyTitulo)) continue;
    vistosUrl.add(keyUrl);
    vistosTitulo.add(keyTitulo);
    saida.push({ ...item, posicao: Number(item.posicao) || saida.length + 1 });
    if (saida.length >= limite) break;
  }
  return saida;
}

/** Extrator puro, coberto por testes e também usado após Chrome/Jina. */
function extrairMaisLidasDoHtml(html, fonte) {
  // CSS enorme/inválido de alguns portais gera milhares de erros no jsdom e
  // não é necessário para extrair links.
  const semEstilos = String(html || '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const dom = new JSDOM(semEstilos, { url: fonte.url });
  const { document } = dom.window;
  const containers = encontrarContainers(document, fonte);
  const ranqueados = containers
    .map((container) => ({ container, itens: anchorsValidos(container, fonte.url) }))
    // O ancestral mais próximo do título "Mais lidas" contém a lista certa;
    // body/main normalmente carregam centenas de links de navegação.
    .filter((grupo) => grupo.itens.length >= 3)
    .sort((a, b) => a.itens.length - b.itens.length);
  const itensDom = ranqueados[0]?.itens || [];
  const itensJson = extrairJsonLd(document, fonte.url);
  const itensEstado = extrairEstadoDeScripts(document, fonte);
  return deduplicar([...itensDom, ...itensJson, ...itensEstado], fonte.limite || 10);
}

function extrairMaisLidasDoMarkdown(markdown, fonte) {
  const itens = [];
  const regex = /\[([^\]]{20,300})\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = regex.exec(String(markdown || '')))) {
    const titulo = limparTexto(match[1], 300);
    const url = urlCanonica(match[2], fonte.url);
    if (pareceLinkEditorial(url, titulo, fonte.url)) itens.push({ titulo, url, resumo: null, imagem: null });
  }
  return deduplicar(itens, fonte.limite || 10);
}

async function baixarHtml(url) {
  let atual = normalizarUrlFonte(url);
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    await validarDnsPublico(atual);
    const response = await axios.get(atual, {
      timeout: 15_000,
      maxRedirects: 0,
      maxContentLength: 4 * 1024 * 1024,
      responseType: 'text',
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.7',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
      },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      atual = normalizarUrlFonte(new URL(response.headers.location, atual).toString());
      continue;
    }
    return { html: String(response.data || ''), finalUrl: atual, leitor: 'direto' };
  }
  const err = new Error('A fonte excedeu o limite de redirecionamentos.');
  err.status = 422;
  throw err;
}

/** APIs públicas usadas pela própria página quando o ranking não vem no HTML. */
async function rastrearApiPublicaConhecida(config) {
  const parsed = new URL(config.url);
  let endpoint = null;
  if (
    /(?:^|\.)folha\.uol\.com\.br$/i.test(parsed.hostname) &&
    /\/maispopulares(?:\/|$)/i.test(parsed.pathname)
  ) {
    endpoint = 'https://www1.folha.uol.com.br/virtual/spiffy/mais-lidas/home-1.0.0.json';
  }
  if (!endpoint) return [];

  await validarDnsPublico(endpoint);
  const response = await axios.get(endpoint, {
    timeout: 15_000,
    maxContentLength: 2 * 1024 * 1024,
    responseType: 'json',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  const data = Array.isArray(response.data) ? response.data : response.data?.data;
  if (!Array.isArray(data)) return [];
  return deduplicar(
    data
      .map((item) => ({
        titulo: limparTexto(decodificarEntidades(item.title || item.titulo || item.headline), 300),
        url: urlCanonica(item.url || item.link, config.url),
        resumo: limparTexto(decodificarEntidades(item.subtitle || item.resumo), 420) || null,
        imagem: urlCanonica(item.image || item.imagem || item.thumbnail, config.url),
      }))
      .filter((item) => pareceLinkEditorial(item.url, item.titulo, config.url)),
    config.limite || 10
  );
}

async function rastrearFonte(fonte) {
  const config = normalizarEntrada(fonte);
  let melhor = [];
  let leitor = 'direto';
  let erroDireto = null;

  try {
    const direto = await baixarHtml(config.url);
    config.url = direto.finalUrl;
    melhor = extrairMaisLidasDoHtml(direto.html, config);
  } catch (err) {
    erroDireto = err;
  }

  if (melhor.length < 3) {
    try {
      const apiPublica = await rastrearApiPublicaConhecida(config);
      if (apiPublica.length > melhor.length) {
        melhor = apiPublica;
        leitor = 'api-publica';
      }
    } catch {
      // Continua para os leitores genéricos.
    }
  }

  if (melhor.length < 3) {
    try {
      const { carregarHtmlViaChrome } = require('./articleSource');
      const chrome = await carregarHtmlViaChrome(config.url, { marcador: config.marcador });
      if (chrome?.html) {
        const extraidos = extrairMaisLidasDoHtml(chrome.html, { ...config, url: chrome.finalUrl || config.url });
        if (extraidos.length > melhor.length) {
          melhor = extraidos;
          leitor = 'chrome';
        }
      }
    } catch {
      // Chrome é fallback opcional.
    }
  }

  if (melhor.length < 3) {
    try {
      const response = await axios.get(`https://r.jina.ai/${config.url}`, {
        timeout: 18_000,
        maxContentLength: 3 * 1024 * 1024,
        responseType: 'text',
        headers: { Accept: 'text/plain', 'User-Agent': USER_AGENT },
      });
      const extraidos = extrairMaisLidasDoMarkdown(response.data, config);
      if (extraidos.length > melhor.length) {
        melhor = extraidos;
        leitor = 'jina';
      }
    } catch {
      // Mantém o melhor resultado anterior.
    }
  }

  if (!melhor.length) {
    const err = new Error(
      erroDireto?.message ||
        'Não encontrei links de matérias nessa página. Informe o marcador “Mais lidas” ou o seletor avançado.'
    );
    err.status = erroDireto?.status || 422;
    throw err;
  }

  return {
    fonte: config,
    leitor,
    itens: melhor.map((item) => ({
      ...item,
      veiculo: config.nome,
      fonteId: Number(fonte.id) || null,
      fonteNome: config.nome,
    })),
  };
}

function normalizarEntrada(entrada = {}) {
  const url = normalizarUrlFonte(entrada.url);
  let nome = limparTexto(entrada.nome, 160);
  if (!nome) nome = new URL(url).hostname.replace(/^www\d*\./i, '');
  const localizacao = String(entrada.localizacao || '').toLowerCase() === 'home' ? 'home' : 'pagina';
  const limite = Math.min(30, Math.max(3, Math.round(Number(entrada.limite) || 10)));
  const seletor = limparTexto(entrada.seletor_css ?? entrada.seletorCss, 300) || null;
  if (seletor && /[{};]/.test(seletor)) {
    const err = new Error('Informe apenas um seletor CSS, sem regras ou chaves.');
    err.status = 400;
    throw err;
  }
  return {
    nome,
    url,
    localizacao,
    marcador: limparTexto(entrada.marcador, 120) || null,
    seletor_css: seletor,
    limite,
    ativa: ![false, 0, '0', 'false', 'off'].includes(entrada.ativa),
  };
}

async function criarFonte(userId, entrada) {
  const data = normalizarEntrada(entrada);
  try {
    const ids = await PautaFontes.create({ user_id: Number(userId), ...data });
    return PautaFontes.findByIdForUser(Array.isArray(ids) ? ids[0] : ids, userId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const duplicate = new Error('Esse site já está cadastrado em Descobrir pautas.');
      duplicate.status = 409;
      throw duplicate;
    }
    throw err;
  }
}

async function atualizarFonte(userId, id, entrada) {
  const atual = await PautaFontes.findByIdForUser(id, userId);
  if (!atual) {
    const err = new Error('Fonte não encontrada.');
    err.status = 404;
    throw err;
  }
  const data = normalizarEntrada({ ...atual, ...entrada });
  try {
    await PautaFontes.updateForUser(id, userId, data);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const duplicate = new Error('Esse site já está cadastrado em Descobrir pautas.');
      duplicate.status = 409;
      throw duplicate;
    }
    throw err;
  }
  return PautaFontes.findByIdForUser(id, userId);
}

async function rastrearFonteSalva(userId, id) {
  const fonte = await PautaFontes.findByIdForUser(id, userId);
  if (!fonte) {
    const err = new Error('Fonte não encontrada.');
    err.status = 404;
    throw err;
  }
  try {
    const result = await rastrearFonte(fonte);
    await PautaFontes.updateForUser(id, userId, {
      ultimo_scan: new Date(),
      ultimo_total: result.itens.length,
      ultimo_erro: null,
    });
    return result;
  } catch (err) {
    await PautaFontes.updateForUser(id, userId, {
      ultimo_scan: new Date(),
      ultimo_total: 0,
      ultimo_erro: limparTexto(err.message, 2000),
    });
    throw err;
  }
}

module.exports = {
  MARCADORES_PADRAO,
  normalizarEntrada,
  extrairMaisLidasDoHtml,
  extrairMaisLidasDoMarkdown,
  rastrearFonte,
  rastrearFonteSalva,
  criarFonte,
  atualizarFonte,
};
