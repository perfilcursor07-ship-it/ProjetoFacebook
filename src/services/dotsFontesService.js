const axios = require('axios');

/**
 * Acha o endereço de uma fonte que o editor citou só pelo NOME — "o g1",
 * "a página do Poder360 no Facebook", "o Instagram do Nikolas Ferreira".
 *
 * Chutar o endereço não serve: facebook.com/metropoles é de outra pessoa e o
 * @metropoles do YouTube é outro canal. Por isso cada candidato é conferido
 * contra o título real da página, e o resultado diz se foi conferido ou não —
 * a tela mostra "confira" em vez de fingir certeza.
 *
 * Só usa caminhos sem chave de API (Brave e Serper ficam desligados no .env):
 *   - site:      o Google Notícias informa o endereço de cada veículo;
 *   - YouTube:   a busca de canais do próprio YouTube;
 *   - Facebook, Instagram, TikTok: busca no Bing + links oficiais do site do
 *     veículo, conferidos pelo título da página.
 *
 * Nunca lança: o que não achar volta com `url: null` e o motivo.
 */

const UA_NAVEGADOR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
/** Facebook e Instagram só mostram o nome da página (og:title) para robôs de prévia. */
const UA_PREVIA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const TIPOS = Object.freeze(['site', 'facebook', 'instagram', 'youtube', 'tiktok']);
const REDES = Object.freeze(['facebook', 'instagram', 'youtube', 'tiktok']);
const TEMPO_MS = 12_000;
const CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

/** Palavras que o editor usa para descrever a fonte, não para nomeá-la. */
const PALAVRAS_VAZIAS = new Set([
  'a', 'o', 'as', 'os', 'de', 'do', 'da', 'dos', 'das', 'e', 'no', 'na', 'em',
  'pagina', 'perfil', 'canal', 'site', 'portal', 'oficial', 'jornal', 'conta',
  'facebook', 'instagram', 'youtube', 'tiktok', 'noticias', 'news', 'tv', 'br',
  'com', 'www', 'the', 'official',
]);

// ----------------------------------------------------------------- texto

function semAcento(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function decodificarHtml(texto) {
  return String(texto || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** "Folha de S.Paulo" -> "folhadespaulo" (para comparar nomes e handles). */
function compacto(texto) {
  return semAcento(decodificarHtml(texto)).replace(/[^a-z0-9]+/g, '');
}

function tokensDoNome(texto) {
  return semAcento(decodificarHtml(texto))
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !PALAVRAS_VAZIAS.has(t));
}

/**
 * O texto encontrado (título da página, nome do veículo, handle) é da fonte
 * pedida? Aceita o nome inteiro dentro do título ("Jovem Pan" em "Jovem Pan
 * News") ou a maioria das palavras do nome presentes.
 */
function nomeConfere(nomePedido, encontrado) {
  const a = compacto(nomePedido);
  const b = compacto(encontrado);
  if (!a || !b) return false;
  if (b.includes(a)) return true;
  if (a.length >= 6 && b.length >= 5 && a.includes(b)) return true;

  const pedidos = tokensDoNome(nomePedido);
  if (!pedidos.length) return false;
  const achados = new Set(tokensDoNome(encontrado));
  const juntos = compacto(encontrado);
  const batem = pedidos.filter((t) => achados.has(t) || (t.length >= 4 && juntos.includes(t)));
  return batem.length / pedidos.length >= 0.6;
}

// ------------------------------------------------------------------- urls

function hostDe(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Plataforma de um link, no mesmo critério da Biblioteca. */
function tipoDoLink(url) {
  const host = hostDe(url);
  if (!host) return null;
  if (host.endsWith('facebook.com') || host === 'fb.com') return 'facebook';
  if (host.endsWith('instagram.com')) return 'instagram';
  if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
  if (host.endsWith('tiktok.com')) return 'tiktok';
  return 'site';
}

const CAMINHOS_QUE_NAO_SAO_PERFIL = {
  facebook: /^\/(?:sharer|share|dialog|plugins|tr|login|watch|groups\/?$|events|photo|photos|story\.php|permalink\.php|hashtag|help|policies|privacy|business|marketplace|gaming|search)\b/i,
  instagram: /^\/(?:p|reel|reels|tv|explore|stories|accounts|direct|about|developer|legal)\b/i,
  youtube: /^\/(?:watch|playlist|embed|shorts|results|feed|hashtag|live|redirect|t\/|about$)/i,
  tiktok: /^\/(?:tag|music|discover|search|login|embed|video)\b/i,
};

/**
 * Link de PERFIL (página, conta, canal) da rede — não de um post, de um
 * compartilhamento ou de uma busca. Devolve o endereço limpo ou null.
 */
function perfilDaRede(url, tipo) {
  let u;
  try {
    u = new URL(decodificarHtml(String(url || '').trim()));
  } catch {
    return null;
  }
  if (tipoDoLink(u.href) !== tipo) return null;
  const caminho = u.pathname.replace(/\/+$/, '');
  if (!caminho || caminho === '/') return null;
  if (CAMINHOS_QUE_NAO_SAO_PERFIL[tipo]?.test(caminho)) return null;

  const partes = caminho.split('/').filter(Boolean);
  if (tipo === 'facebook') {
    if (partes[0] === 'profile.php') {
      const id = u.searchParams.get('id');
      return id ? `https://www.facebook.com/profile.php?id=${id}` : null;
    }
    // facebook.com/pages/Nome/123 e facebook.com/people/Nome/123 são perfis.
    if (['pages', 'people'].includes(partes[0])) {
      return partes.length >= 3 ? `https://www.facebook.com/${partes.slice(0, 3).join('/')}` : null;
    }
    // /Pagina/posts/123: o perfil é o primeiro trecho.
    return `https://www.facebook.com/${partes[0]}`;
  }
  if (tipo === 'instagram') return `https://www.instagram.com/${partes[0]}/`;
  if (tipo === 'tiktok') return partes[0].startsWith('@') ? `https://www.tiktok.com/${partes[0]}` : null;
  if (tipo === 'youtube') {
    if (partes[0].startsWith('@')) return `https://www.youtube.com/${partes[0]}`;
    if (['c', 'channel', 'user'].includes(partes[0]) && partes[1]) return `https://www.youtube.com/${partes[0]}/${partes[1]}`;
    return null;
  }
  return null;
}

/** "@poder360", "poder360" — o identificador do perfil, para comparar com o nome. */
function handleDoPerfil(url) {
  try {
    const u = new URL(url);
    const partes = u.pathname.split('/').filter(Boolean);
    if (partes[0] === 'profile.php') return '';
    if (['c', 'channel', 'user', 'pages', 'people'].includes(partes[0])) return decodeURIComponent(partes[1] || '');
    return decodeURIComponent(partes[0] || '').replace(/^@/, '');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------- rede

async function baixar(url, { ua = UA_NAVEGADOR, params, timeout = TEMPO_MS } = {}) {
  const resposta = await axios.get(url, {
    params,
    timeout,
    maxRedirects: 5,
    responseType: 'text',
    headers: { 'User-Agent': ua, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    validateStatus: () => true,
  });
  return {
    status: resposta.status,
    html: String(resposta.data || ''),
    final: resposta.request?.res?.responseUrl || url,
  };
}

function metaDaPagina(html) {
  const meta = (prop) => {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
    return decodificarHtml((html.match(re1) || html.match(re2) || [])[1] || '').trim();
  };
  const titulo = decodificarHtml((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '').trim();
  return { ogTitulo: meta('og:title'), ogSite: meta('og:site_name'), titulo };
}

/**
 * Confere uma página pelo título. YouTube responde 404 para canal que não
 * existe; Facebook e Instagram respondem 200 sempre, mas sem og:title quando a
 * conta não existe — e com o nome do dono quando existe.
 */
async function conferirPagina(url, nome, tipo) {
  try {
    const ua = tipo === 'facebook' || tipo === 'instagram' ? UA_PREVIA : UA_NAVEGADOR;
    const { status, html, final } = await baixar(url, { ua });
    if (status >= 400) return { ok: false, existe: false, titulo: null };
    const { ogTitulo, ogSite, titulo } = metaDaPagina(html);
    const textos = [ogTitulo, ogSite, titulo].filter(Boolean);
    // Login do Facebook/Instagram no lugar da página = conta inexistente/privada.
    const generico = textos.every((t) => /^(facebook|instagram|youtube|tiktok)\b/i.test(t) && t.length < 40);
    const confere = textos.some((t) => nomeConfere(nome, t)) || nomeConfere(nome, handleDoPerfil(final));
    return {
      ok: confere && !generico,
      existe: !generico,
      titulo: ogTitulo || ogSite || titulo || null,
      final,
    };
  } catch (err) {
    return { ok: false, existe: null, titulo: null, erro: err.message };
  }
}

/**
 * Resultados orgânicos do Bing: [{ url, titulo }]. O link real vem dentro do
 * parâmetro `u` (base64 com prefixo "a1") do redirecionador do Bing.
 */
function lerResultadosBing(html) {
  const resultados = [];
  for (const bloco of String(html || '').split('<li class="b_algo"').slice(1)) {
    const ancora = bloco.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || bloco.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!ancora) continue;
    const url = urlDoRedirecionadorBing(decodificarHtml(ancora[1]));
    const titulo = decodificarHtml(ancora[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (url && /^https?:\/\//i.test(url)) resultados.push({ url, titulo });
  }
  return resultados;
}

function urlDoRedirecionadorBing(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    if (!/bing\.com$/i.test(u.hostname) || !u.pathname.startsWith('/ck/')) return u.href;
    const cifrado = String(u.searchParams.get('u') || '').replace(/^a1/, '');
    if (!cifrado) return null;
    const base64 = cifrado.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64 + '='.repeat((4 - (base64.length % 4)) % 4), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

async function buscarNoBing(consulta) {
  const chave = `bing|${consulta}`;
  const guardado = lerCache(chave);
  if (guardado) return guardado;
  try {
    const { status, html } = await baixar('https://www.bing.com/search', {
      params: { q: consulta, setlang: 'pt-BR', cc: 'BR' },
    });
    if (status >= 400) return [];
    return guardarCache(chave, lerResultadosBing(html));
  } catch {
    return [];
  }
}

// --------------------------------------------------------------- caminhos

/**
 * Site de um veículo pelo nome: o Google Notícias marca cada notícia com
 * <source url="https://www.metropoles.com">Metrópoles</source>. O endereço
 * mais frequente com o nome que confere é o do veículo.
 */
async function siteDoVeiculo(nome) {
  const chave = `site|${compacto(nome)}`;
  const guardado = lerCache(chave);
  if (guardado !== undefined) return guardado;
  try {
    const googleNews = require('./googleNewsLimiter');
    if (googleNews.emPausa?.()) return null;
    const { html } = await googleNews.executar(async () => {
      const resposta = await baixar('https://news.google.com/rss/search', {
        params: { q: nome, hl: 'pt-BR', gl: 'BR', ceid: 'BR:pt-419' },
      });
      // O limitador só reconhece bloqueio (429/503) quando a tarefa falha.
      if (resposta.status >= 400) {
        throw Object.assign(new Error(`Google Notícias respondeu ${resposta.status}`), {
          response: { status: resposta.status },
        });
      }
      return resposta;
    });
    const contagem = new Map();
    for (const m of html.matchAll(/<source url="([^"]+)">([^<]+)<\/source>/g)) {
      const [, url, rotulo] = m;
      if (!nomeConfere(nome, rotulo) && !nomeConfere(nome, hostDe(url))) continue;
      const atual = contagem.get(url) || { url, rotulo: decodificarHtml(rotulo), vezes: 0 };
      atual.vezes += 1;
      contagem.set(url, atual);
    }
    const melhor = [...contagem.values()].sort((a, b) => b.vezes - a.vezes)[0] || null;
    return guardarCache(chave, melhor ? { url: melhor.url, titulo: melhor.rotulo } : null);
  } catch {
    return null;
  }
}

/** Canal do YouTube pelo nome, pela busca de canais do próprio YouTube. */
async function canalDoYoutube(nome) {
  const chave = `yt|${compacto(nome)}`;
  const guardado = lerCache(chave);
  if (guardado !== undefined) return guardado;
  try {
    // sp=EgIQAg== filtra a busca para "Canais".
    const { html } = await baixar('https://www.youtube.com/results', {
      params: { search_query: nome, sp: 'EgIQAg==' },
    });
    const re = /"channelRenderer":\{"channelId":"([^"]+)","title":\{"simpleText":"([^"]+)"[\s\S]*?"canonicalBaseUrl":"([^"]+)"/g;
    let m;
    let vistos = 0;
    while ((m = re.exec(html)) && vistos < 6) {
      vistos += 1;
      const titulo = decodificarHtml(m[2]);
      if (!nomeConfere(nome, titulo)) continue;
      const caminho = decodeURIComponent(m[3]);
      return guardarCache(chave, { url: `https://www.youtube.com${caminho}`, titulo });
    }
    return guardarCache(chave, null);
  } catch {
    return null;
  }
}

/** Links de redes sociais publicados no site (rodapé, cabeçalho). */
async function redesDoSite(urlSite) {
  const chave = `redes|${hostDe(urlSite)}`;
  const guardado = lerCache(chave);
  if (guardado) return guardado;
  const achados = {};
  try {
    const { status, html } = await baixar(urlSite);
    if (status < 400) {
      for (const m of html.matchAll(/href=["'](https?:\/\/[^"'\s]+)["']/gi)) {
        const tipo = tipoDoLink(m[1]);
        if (!REDES.includes(tipo) || achados[tipo]) continue;
        const perfil = perfilDaRede(m[1], tipo);
        if (perfil) achados[tipo] = perfil;
      }
    }
  } catch {
    // site fora do ar: segue sem redes
  }
  return guardarCache(chave, achados);
}

// --------------------------------------------------------------- resolver

function resultado(pedido, dados) {
  return {
    tipo: pedido.tipo,
    nome: pedido.nome,
    url: null,
    verificado: false,
    titulo: null,
    via: null,
    motivo: null,
    ...dados,
  };
}

const NOME_REDE = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok', site: 'site' };

async function resolverSite(pedido) {
  const veiculo = await siteDoVeiculo(pedido.nome);
  if (veiculo) return resultado(pedido, { url: veiculo.url, verificado: true, titulo: veiculo.titulo, via: 'google_noticias' });

  const candidatos = [];
  if (pedido.url && tipoDoLink(pedido.url) === 'site') candidatos.push(pedido.url);
  for (const r of (await buscarNoBing(`${pedido.nome} site oficial`)).slice(0, 5)) {
    if (tipoDoLink(r.url) === 'site' && !/wikipedia\.org|bing\.com|google\./i.test(r.url)) {
      try {
        candidatos.push(new URL(r.url).origin);
      } catch {
        // ignora resultado sem URL válida
      }
    }
  }
  for (const url of [...new Set(candidatos)].slice(0, 3)) {
    const conferida = await conferirPagina(url, pedido.nome, 'site');
    if (conferida.ok) return resultado(pedido, { url, verificado: true, titulo: conferida.titulo, via: 'busca' });
  }
  return resultado(pedido, {
    motivo: `Não achei o site de "${pedido.nome}". Cole o link do site.`,
  });
}

async function resolverRede(pedido) {
  const { tipo, nome } = pedido;

  // 1) YouTube tem busca de canais própria e confiável.
  if (tipo === 'youtube') {
    const canal = await canalDoYoutube(nome);
    if (canal) return resultado(pedido, { url: canal.url, verificado: true, titulo: canal.titulo, via: 'youtube' });
  }

  // 2) Busca no Bing: o título do resultado já costuma trazer "Nome (@handle)".
  const candidatos = [];
  if (pedido.url) {
    const doPedido = perfilDaRede(pedido.url, tipo);
    if (doPedido) candidatos.push({ url: doPedido, titulo: '' });
  }
  for (const r of await buscarNoBing(`${nome} ${NOME_REDE[tipo]}`)) {
    const perfil = perfilDaRede(r.url, tipo);
    if (perfil && !candidatos.some((c) => c.url.toLowerCase() === perfil.toLowerCase())) {
      candidatos.push({ url: perfil, titulo: r.titulo });
    }
  }

  // 3) Link oficial publicado no site do veículo.
  const veiculo = await siteDoVeiculo(nome);
  if (veiculo) {
    const doSite = (await redesDoSite(veiculo.url))[tipo];
    if (doSite && !candidatos.some((c) => c.url.toLowerCase() === doSite.toLowerCase())) {
      candidatos.unshift({ url: doSite, titulo: '', oficial: true });
    }
  }

  let primeiroQueExiste = null;
  for (const c of candidatos.slice(0, 4)) {
    // Link que o próprio site do veículo publica é oficial por definição.
    if (c.oficial) return resultado(pedido, { url: c.url, verificado: true, titulo: veiculo?.titulo || null, via: 'site_oficial' });
    const peloTitulo = nomeConfere(nome, c.titulo) || nomeConfere(nome, handleDoPerfil(c.url));
    // TikTok não mostra o nome sem JavaScript: vale o título do buscador.
    if (tipo === 'tiktok' && peloTitulo) return resultado(pedido, { url: c.url, verificado: true, titulo: c.titulo || null, via: 'busca' });
    const conferida = await conferirPagina(c.url, nome, tipo);
    if (conferida.ok) return resultado(pedido, { url: c.url, verificado: true, titulo: conferida.titulo || c.titulo || null, via: 'busca' });
    if (conferida.existe !== false && peloTitulo && !primeiroQueExiste) primeiroQueExiste = { ...c, titulo: conferida.titulo || c.titulo };
  }

  if (primeiroQueExiste) {
    return resultado(pedido, {
      url: primeiroQueExiste.url,
      titulo: primeiroQueExiste.titulo || null,
      via: 'busca',
      motivo: `Achei este ${NOME_REDE[tipo]} para "${nome}", mas não consegui confirmar. Confira o link.`,
    });
  }
  return resultado(pedido, {
    motivo: `Não achei "${nome}" no ${NOME_REDE[tipo]}. Cole o link da página.`,
  });
}

/**
 * @param {{ tipo: string, nome: string, url?: string }} pedido
 * @returns {Promise<{tipo, nome, url, verificado, titulo, via, motivo}>}
 */
async function resolverFonte(pedido) {
  const tipo = TIPOS.includes(pedido?.tipo) ? pedido.tipo : 'site';
  const nome = String(pedido?.nome || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const limpo = { tipo, nome, url: pedido?.url || null };
  if (!nome) return resultado(limpo, { motivo: 'Fonte sem nome.' });

  const chave = `fonte|${tipo}|${compacto(nome)}`;
  const guardado = lerCache(chave);
  if (guardado) return guardado;

  try {
    const achado = await comPrazo(tipo === 'site' ? resolverSite(limpo) : resolverRede(limpo), 45_000);
    const final = achado || resultado(limpo, { motivo: `Demorei demais procurando "${nome}". Cole o link.` });
    // Só guarda o que deu certo: o que falhou pode dar certo na próxima tentativa.
    return final.url ? guardarCache(chave, final) : final;
  } catch (err) {
    return resultado(limpo, { motivo: `Não consegui procurar "${nome}" (${err.message}).` });
  }
}

/** Resolve várias fontes, 3 por vez (cada uma faz até 4 acessos à rede). */
async function resolverFontes(pedidos = []) {
  const lista = (Array.isArray(pedidos) ? pedidos : []).slice(0, 12);
  const saida = new Array(lista.length);
  let proxima = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, lista.length) }, async () => {
      while (proxima < lista.length) {
        const i = proxima;
        proxima += 1;
        saida[i] = await resolverFonte(lista[i]);
      }
    })
  );
  return saida;
}

// ------------------------------------------------------------------ cache

function lerCache(chave) {
  const item = cache.get(chave);
  if (!item) return undefined;
  if (item.expira < Date.now()) {
    cache.delete(chave);
    return undefined;
  }
  return item.valor;
}

function guardarCache(chave, valor) {
  cache.set(chave, { valor, expira: Date.now() + CACHE_MS });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return valor;
}

function comPrazo(promessa, ms) {
  let timer;
  return Promise.race([
    promessa,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = {
  resolverFonte,
  resolverFontes,
  // Expostos para teste
  nomeConfere,
  perfilDaRede,
  tipoDoLink,
  lerResultadosBing,
  urlDoRedirecionadorBing,
  handleDoPerfil,
  metaDaPagina,
  TIPOS,
  _cache: cache,
};
