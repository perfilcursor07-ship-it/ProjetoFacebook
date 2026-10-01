const axios = require('axios');
const path = require('path');
const { spawn } = require('child_process');
const { apurarTopico, decodificarHtml } = require('./articleSource');
const { env } = require('../config/env');

const googleNews = require('./googleNewsLimiter');

/**
 * Proxy SÓ para o Google News (GOOGLE_NEWS_PROXY no .env).
 *
 * Existe porque o Google recusa IP de datacenter: DigitalOcean, AWS e afins
 * entram na lista e o servidor leva 503 mesmo numa requisição isolada.
 *
 * Por que aqui e não uma VPN no servidor: a VPN troca a rota de TUDO que sai
 * da máquina — os outros sites do CloudPanel, as APIs do Facebook/Instagram
 * (que estranham mudança de IP), atualizações e o próprio acesso SSH. Aqui o
 * desvio vale só para estas chamadas; o resto do servidor continua intacto.
 *
 * Formatos aceitos: http://user:senha@host:porta  |  socks5://host:porta
 */
const PROXY_GOOGLE_NEWS = String(process.env.GOOGLE_NEWS_PROXY || '').trim();

function criarAgenteProxy() {
  if (!PROXY_GOOGLE_NEWS) return null;
  try {
    if (/^socks/i.test(PROXY_GOOGLE_NEWS)) {
      const mod = require('socks-proxy-agent');
      const Agente = mod.SocksProxyAgent || mod;
      return new Agente(PROXY_GOOGLE_NEWS);
    }
    const mod = require('https-proxy-agent');
    const Agente = mod.HttpsProxyAgent || mod;
    return new Agente(PROXY_GOOGLE_NEWS);
  } catch (err) {
    console.error(`[google-news] proxy inválido em GOOGLE_NEWS_PROXY: ${err.message}`);
    return null;
  }
}

const AGENTE_PROXY = criarAgenteProxy();
if (AGENTE_PROXY) {
  // Sem o host no log: a URL do proxy costuma trazer usuário e senha.
  console.info('[google-news] usando proxy dedicado para as consultas ao Google');
}

/** Acrescenta o proxy às opções do axios, quando houver. */
function comProxy(opcoes) {
  if (!AGENTE_PROXY) return opcoes;
  // `proxy: false` impede o axios de tentar o proxy dele por cima do agente.
  return { ...opcoes, httpsAgent: AGENTE_PROXY, httpAgent: AGENTE_PROXY, proxy: false };
}

const USER_AGENT = 'Mozilla/5.0 (compatible; ViralizeAI/1.0)';
const MS_DIA = 24 * 60 * 60 * 1000;
const GOOGLE_PYTHON_CACHE = new Map();

/**
 * O radar repete as mesmas consultas a cada atualização e vários coletores
 * pedem o mesmo termo. Sem cache, cada rajada ia inteira para o Google.
 */
const GOOGLE_RSS_CACHE = new Map();
const RSS_CACHE_OK_MS = 5 * 60_000;
/** Resultado vazio pode ser transitório: guarda por menos tempo. */
const RSS_CACHE_VAZIO_MS = 2 * 60_000;

function lerCacheRss(chave) {
  const registro = GOOGLE_RSS_CACHE.get(chave);
  if (registro && registro.expira > Date.now()) return registro.itens;
  if (registro) GOOGLE_RSS_CACHE.delete(chave);
  return null;
}

function guardarCacheRss(chave, itens) {
  const lista = Array.isArray(itens) ? itens : [];
  GOOGLE_RSS_CACHE.set(chave, {
    itens: lista,
    expira: Date.now() + (lista.length ? RSS_CACHE_OK_MS : RSS_CACHE_VAZIO_MS),
  });
  if (GOOGLE_RSS_CACHE.size > 500) {
    GOOGLE_RSS_CACHE.delete(GOOGLE_RSS_CACHE.keys().next().value);
  }
  return lista;
}

/**
 * Uma rajada de 48 consultas gerava 48 linhas idênticas no log. Aqui só a
 * primeira de cada minuto aparece.
 */
const ULTIMO_AVISO = new Map();

function avisarUmaVez(chave, mensagem, janelaMs = 60_000) {
  const agora = Date.now();
  if (ULTIMO_AVISO.get(chave) > agora - janelaMs) return;
  ULTIMO_AVISO.set(chave, agora);
  console.warn(mensagem);
}

function limparResumo(texto, max = 400, titulo = '') {
  let t = decodificarHtml(texto || '')
    .replace(/news\.google\.com[^\s]*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Google News costuma repetir o título no resumo — corta ruído típico.
  const tituloLimpo = decodificarHtml(titulo || '').replace(/\s+/g, ' ').trim();
  if (tituloLimpo && t.toLocaleLowerCase('pt-BR').startsWith(tituloLimpo.toLocaleLowerCase('pt-BR'))) {
    t = t.slice(tituloLimpo.length).replace(/^[\s:—–\-]+/, '').trim();
  }
  t = t.replace(/^Exibir\s+/i, '').trim();
  // Alguns feeds deixam o nome do portal no final como se fosse conteúdo.
  t = t.replace(/\s+(?:Exibir|Veja|Leia)\s+[\p{L}\d][\p{L}\d .'-]{1,80}$/iu, '').trim();
  return t.slice(0, max);
}

function limparTitulo(titulo) {
  return decodificarHtml(titulo || '')
    .replace(/\s*[-–—|]\s*[^-|–—]{2,60}$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairVeiculoDoResumoRss(descricaoHtml) {
  const raw = String(descricaoHtml || '');
  const font = raw.match(/<font[^>]*>([\s\S]*?)<\/font>/i)?.[1]
    || raw.match(/&lt;font[^&]*&gt;([\s\S]*?)&lt;\/font&gt;/i)?.[1];
  return font ? decodificarHtml(font).slice(0, 80) : null;
}

function parsearDataPub(dataStr) {
  if (!dataStr) return 0;
  const t = Date.parse(dataStr);
  return Number.isNaN(t) ? 0 : t;
}

const MESES_PT = {
  janeiro: 0, fevereiro: 1, marco: 2, março: 2, abril: 3, maio: 4, junho: 5,
  julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11,
};

/**
 * Extrai data de textos de busca/post ("Jul 28, 2025", "28 de julho de 2025",
 * "há 3 horas", "2 days ago"). O Date.parse sozinho falha nesses formatos e é
 * por isso que posts antigos passavam pelo filtro de período.
 */
function extrairDataDeTexto(texto) {
  const s = String(texto || '');
  if (!s) return 0;

  // "Jul 28, 2025" / "May 18, 2017"
  const en = s.match(/\b([A-Z][a-z]{2,8})\s+(\d{1,2}),\s*(\d{4})\b/);
  if (en) {
    const t = Date.parse(`${en[1]} ${en[2]}, ${en[3]}`);
    if (!Number.isNaN(t)) return t;
  }

  // "28 de julho de 2025"
  const pt = s.match(/\b(\d{1,2})\s+de\s+([a-zçã]+)\s+de\s+(\d{4})\b/i);
  if (pt) {
    const mes = MESES_PT[pt[2].toLowerCase()];
    if (mes != null) return new Date(Number(pt[3]), mes, Number(pt[1])).getTime();
  }

  // "28/07/2025"
  const br = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (br) return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1])).getTime();

  // Relativos: "há 3 horas", "3 hours ago", "2 dias atrás", "1 week ago"
  const rel = s.match(/(?:h[áa]\s+)?(\d{1,3})\s*(minuto|minutes?|min|hora|hours?|dia|days?|semana|weeks?|m[êe]s|months?|ano|years?)s?\b\s*(?:atr[áa]s|ago)?/i);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2].toLowerCase();
    const MIN = 60000;
    if (/^min/.test(u)) return Date.now() - n * MIN;
    if (/^hora|^hour/.test(u)) return Date.now() - n * 60 * MIN;
    if (/^dia|^day/.test(u)) return Date.now() - n * 24 * 60 * MIN;
    if (/^semana|^week/.test(u)) return Date.now() - n * 7 * 24 * 60 * MIN;
    if (/^m[êe]s|^month/.test(u)) return Date.now() - n * 30 * 24 * 60 * MIN;
    if (/^ano|^year/.test(u)) return Date.now() - n * 365 * 24 * 60 * MIN;
  }

  return 0;
}

/** Só URLs de post/vídeo servem de fonte — perfil e login não têm conteúdo. */
function ehPostSocial(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return false;
  return (
    /instagram\.com\/(p|reel|reels|tv)\//i.test(u) ||
    /facebook\.com\/.+\/(posts|videos|photos)\//i.test(u) ||
    /facebook\.com\/(permalink\.php|story\.php|photo|watch|reel)/i.test(u) ||
    /(x|twitter)\.com\/[^/]+\/status\/\d+/i.test(u) ||
    /tiktok\.com\/@[^/]+\/video\/\d+/i.test(u) ||
    /threads\.(net|com)\/@[^/]+\/post\//i.test(u) ||
    /youtube\.com\/(watch\?|shorts\/)/i.test(u) ||
    /youtu\.be\//i.test(u) ||
    /reddit\.com\/r\/[^/]+\/comments\//i.test(u) ||
    /linkedin\.com\/posts\//i.test(u)
  );
}

/** Descarta textos de placeholder que os buscadores devolvem sem conteúdo. */
function textoDeBuscaInutil(texto) {
  const s = String(texto || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (s.length < 40) return true;
  return (
    s.includes('we cannot provide a description') ||
    s.includes('log in to facebook') ||
    s.includes('explore the things you love') ||
    s.includes('entrar no facebook') ||
    s.includes('sign up now to get your own personalized timeline') ||
    s.includes('this page isn') ||
    s.includes('página não disponível')
  );
}

function slugId(titulo, link) {
  const base = `${titulo || ''}|${link || ''}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
  let hash = 0;
  for (let i = 0; i < base.length; i += 1) hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
  return `t_${hash.toString(16)}`;
}

function extrairItensRss(xml) {
  const itens = [];
  const blocos = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const bloco of blocos) {
    const titulo = bloco.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim();
    const link = bloco.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim();
    const descricao = bloco.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1]?.trim();
    const data = bloco.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim();
    const veiculoRss = extrairVeiculoDoResumoRss(descricao);
    if (titulo && link) {
      itens.push({
        titulo: limparTitulo(titulo),
        link: link.trim(),
        resumo: limparResumo(descricao, 400, titulo),
        data,
        dataTimestamp: parsearDataPub(data),
        veiculo: veiculoRss || undefined,
      });
    }
  }
  return itens;
}

const PERIODO_MAX_DIAS = 365;

function normalizarPeriodo(valor) {
  // Aceita já-normalizado ({ dias } / { horas }) para poder repassar entre serviços
  if (valor && typeof valor === 'object') {
    const horas = Number(valor.horas) || 0;
    const dias = Number(valor.dias) || 0;
    if (horas > 0) {
      return {
        horas: Math.min(horas, 24 * PERIODO_MAX_DIAS),
        dias: dias || Math.ceil(horas / 24),
      };
    }
    if (dias > 0) return { dias: Math.min(dias, PERIODO_MAX_DIAS) };
    return { dias: 1 };
  }
  const str = String(valor ?? '24h').toLowerCase().trim();
  if (str === 'hoje' || str === '24h' || str === '24' || str === '1d') return { horas: 24, dias: 1 };
  if (str === '48h') return { horas: 48, dias: 2 };
  if (str === '3d' || str === '3') return { dias: 3 };
  if (str === '7d' || str === '7' || str === '1s') return { dias: 7 };
  if (str === '15d' || str === '15') return { dias: 15 };
  if (str === '30d' || str === '1m' || str === '30') return { dias: 30 };
  if (str === '60d' || str === '2m' || str === '60') return { dias: 60 };
  if (str === '90d' || str === '3m' || str === '90') return { dias: 90 };
  if (str === '180d' || str === '6m' || str === '180') return { dias: 180 };
  if (str === '365d' || str === '1a' || str === '1y' || str === '12m') return { dias: 365 };
  const m = str.match(/^(\d+)\s*(d|h|m)?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (m[2] === 'h') {
      return { horas: Math.min(Math.max(n, 1), 24 * PERIODO_MAX_DIAS), dias: Math.ceil(n / 24) };
    }
    if (m[2] === 'm') return { dias: Math.min(Math.max(n * 30, 1), PERIODO_MAX_DIAS) };
    return { dias: Math.min(Math.max(n || 1, 1), PERIODO_MAX_DIAS) };
  }
  return { dias: 1 };
}

/** Dias equivalentes do período (usa horas quando for janela curta). */
function diasDoPeriodo(periodo) {
  const cfg = typeof periodo === 'object' ? periodo : normalizarPeriodo(periodo);
  return cfg.horas ? Math.max(1, Math.ceil(cfg.horas / 24)) : cfg.dias || 1;
}

/** Momento mais antigo aceito para uma notícia dentro do período. */
function limiteDoPeriodo(periodo) {
  const cfg = typeof periodo === 'object' ? periodo : normalizarPeriodo(periodo);
  return cfg.horas
    ? Date.now() - cfg.horas * 3600000
    : Date.now() - (cfg.dias || 1) * MS_DIA;
}

/** Texto do período para status/prompt (ex.: "últimas 24h", "últimos 60 dias"). */
function rotuloPeriodo(periodo) {
  const cfg = typeof periodo === 'object' ? periodo : normalizarPeriodo(periodo);
  if (cfg.horas && cfg.horas <= 24) return 'últimas 24h';
  if (cfg.horas && cfg.horas < 48) return `últimas ${cfg.horas}h`;
  const dias = diasDoPeriodo(cfg);
  if (dias === 1) return 'últimas 24h';
  if (dias === 7) return 'últimos 7 dias';
  return `últimos ${dias} dias`;
}

/** Operador when: do Google News conforme o período. */
function whenParaGoogle(periodo) {
  const dias = diasDoPeriodo(periodo);
  if (dias <= 1) return '1d';
  if (dias <= 3) return '3d';
  if (dias <= 7) return '7d';
  if (dias <= 16) return '15d';
  if (dias <= 31) return '1m';
  if (dias <= 62) return '2m';
  if (dias <= 93) return '3m';
  if (dias <= 186) return '6m';
  return '1y';
}

function dataIso(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Freshness da Brave News API. Acima de 1 mês usa intervalo de datas
 * (pd/pw/pm/py são grosseiros e "py" traria notícia de 1 ano).
 */
function freshnessBrave(periodo) {
  const dias = diasDoPeriodo(periodo);
  if (dias <= 1) return 'pd';
  if (dias <= 7) return 'pw';
  if (dias <= 31) return 'pm';
  if (dias >= 360) return 'py';
  return `${dataIso(Date.now() - dias * MS_DIA)}to${dataIso(Date.now())}`;
}

function itemEhRecente(item, periodo) {
  const limite = limiteDoPeriodo(periodo);
  const ts = item.dataTimestamp || parsearDataPub(item.data);
  if (!ts) return Boolean(item.recente || item.emAlta);
  return ts >= limite;
}

/**
 * Filtro tolerante: só descarta quando a data é conhecida e está fora da janela.
 * Item sem data continua valendo (muitos portais não expõem pubDate).
 */
function itemDentroDoPeriodo(item, periodo) {
  const ts = item?.dataTimestamp || parsearDataPub(item?.data);
  if (!ts) return true;
  return ts >= limiteDoPeriodo(periodo);
}

function titulosSimilares(a, b) {
  const na = String(a || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const nb = String(b || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (!na.length || !nb.length) return false;
  const setB = new Set(nb);
  const inter = na.filter((w) => setB.has(w)).length;
  return inter >= Math.min(3, Math.ceil(Math.min(na.length, nb.length) * 0.45));
}

function deduplicarTopicos(lista) {
  const out = [];
  for (const item of lista) {
    if (out.some((x) => titulosSimilares(x.titulo, item.titulo) || (x.link && x.link === item.link))) continue;
    out.push(item);
  }
  return out;
}

function diasDoWhenGoogle(when) {
  const match = String(when || '').trim().match(/^(\d+)([dmy])$/i);
  if (!match) return 30;
  const quantidade = Math.max(1, Number(match[1]) || 1);
  if (match[2].toLowerCase() === 'y') return Math.min(365, quantidade * 365);
  if (match[2].toLowerCase() === 'm') return Math.min(365, quantidade * 30);
  return Math.min(365, quantidade);
}

function executarGooglePython(binario, payload) {
  return new Promise((resolve, reject) => {
    const script = path.resolve(__dirname, '../../scripts/google_news_search.py');
    const child = spawn(binario, [script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // urllib lê estas variáveis sozinho, então o fallback sai pelo mesmo
      // proxy das chamadas em Node em vez de denunciar o IP do servidor.
      env: PROXY_GOOGLE_NEWS
        ? { ...process.env, HTTPS_PROXY: PROXY_GOOGLE_NEWS, HTTP_PROXY: PROXY_GOOGLE_NEWS }
        : process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('tempo limite excedido'));
    }, 35000);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout || '{}');
        if (code !== 0 || parsed.ok !== true) {
          reject(new Error(parsed.error || stderr.trim() || `Python encerrou com código ${code}`));
          return;
        }
        resolve(Array.isArray(parsed.items) ? parsed.items : []);
      } catch (err) {
        reject(new Error(stderr.trim() || err.message));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

const CACHE_DECODE_MS = 6 * 60 * 60 * 1000;
const cacheDecode = new Map();

/**
 * Links do Google News → endereço real da matéria, num único processo Python
 * para o lote inteiro. Devolve Map(link → url real); o que não resolver fica
 * de fora. O link do Google não muda, então o resultado fica 6h em cache.
 */
async function decodificarLinksGoogle(urls) {
  const resolvidos = new Map();
  const pendentes = [];
  for (const url of [...new Set((urls || []).map(String))]) {
    if (!/news\.google\.com/i.test(url)) continue;
    const guardado = cacheDecode.get(url);
    if (guardado && guardado.expiraEm > Date.now()) {
      if (guardado.final) resolvidos.set(url, guardado.final);
    } else {
      pendentes.push(url);
    }
  }
  if (!pendentes.length) return resolvidos;

  const candidatos = [
    String(env.pythonPath || '').trim(),
    process.platform === 'win32' ? 'python' : 'python3',
    process.platform === 'win32' ? 'py' : 'python',
  ].filter((item, index, lista) => item && lista.indexOf(item) === index);
  for (const binario of candidatos) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const itens = await executarGooglePython(binario, { decode: pendentes.slice(0, 12) });
      for (const item of itens) {
        const final = /^https?:\/\//i.test(String(item?.final || '')) ? String(item.final) : '';
        cacheDecode.set(item.link, { final, expiraEm: Date.now() + (final ? CACHE_DECODE_MS : 10 * 60 * 1000) });
        if (final) resolvidos.set(item.link, final);
      }
      if (cacheDecode.size > 3000) cacheDecode.delete(cacheDecode.keys().next().value);
      return resolvidos;
    } catch (err) {
      if (/ENOENT|não é reconhecido|not found/i.test(err.message)) continue;
      console.warn('[google-decode]', err.message);
      return resolvidos;
    }
  }
  return resolvidos;
}

/** Fallback sem chave: Google News RSS + Google Notícias HTML via Python. */
async function buscarGoogleNewsPython(
  termo,
  { when = '1m', limit = 20, incluirWebGeral = false } = {}
) {
  const dias = diasDoWhenGoogle(when);
  const chave = `${String(termo || '').trim().toLowerCase()}|${dias}|${limit}|web:${incluirWebGeral ? 1 : 0}`;
  const cached = GOOGLE_PYTHON_CACHE.get(chave);
  if (cached && cached.expira > Date.now()) return cached.itens;

  // O script abre news.google.com e www.google.com. Durante a pausa, nem vale
  // abrir o processo: só renovaria o bloqueio.
  if (googleNews.emPausa()) {
    avisarUmaVez('python-pausa', `Google Python: ${googleNews.erroDePausa().message}`);
    return [];
  }

  const candidatos = [
    String(env.pythonPath || '').trim(),
    process.platform === 'win32' ? 'python' : 'python3',
    process.platform === 'win32' ? 'py' : 'python',
  ].filter((item, index, lista) => item && lista.indexOf(item) === index);

  let ultimoErro = null;
  for (const binario of candidatos) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const encontrados = await googleNews.executar(() =>
        executarGooglePython(binario, {
          query: String(termo || '').trim(),
          days: dias,
          limit: Math.min(40, Math.max(1, Number(limit) || 20)),
          includeWeb: Boolean(incluirWebGeral),
        })
      );
      const itens = encontrados.map((item) => ({
        id: slugId(item.titulo, item.link),
        titulo: limparTitulo(item.titulo),
        link: item.link,
        resumo: limparResumo(item.resumo),
        data: item.data || null,
        dataTimestamp: Number(item.dataTimestamp) || 0,
        veiculo: item.veiculo || 'Google News',
        fonte: 'Google via Python',
        tipoFonte: 'noticia',
        recente: true,
        emAlta: false,
      }));
      GOOGLE_PYTHON_CACHE.set(chave, { itens, expira: Date.now() + 10 * 60_000 });
      if (itens.length) console.info(`[google-python] "${termo}": ${itens.length} resultado(s)`);
      return itens;
    } catch (err) {
      ultimoErro = err;
      if (!/ENOENT|not found|não foi possível encontrar/i.test(String(err.message || ''))) break;
    }
  }
  avisarUmaVez(
    `python-${ultimoErro?.message || 'indisponivel'}`,
    `Google Python: ${ultimoErro?.message || 'Python indisponível'}`
  );
  GOOGLE_PYTHON_CACHE.set(chave, { itens: [], expira: Date.now() + 2 * 60_000 });
  return [];
}

async function buscarGoogleNewsRss(
  termo,
  {
    when = '1d',
    hl = 'pt-BR',
    gl = 'BR',
    ceid = 'BR:pt-419',
    resolverDiretas = false,
    incluirWebGeral = false,
  } = {}
) {
  const chaveCache = `rss|${String(termo || '').trim().toLowerCase()}|${when}|${hl}|${gl}|${ceid}|${
    resolverDiretas ? 1 : 0
  }|${incluirWebGeral ? 1 : 0}`;
  const emCache = lerCacheRss(chaveCache);
  if (emCache) return emCache;

  const q = encodeURIComponent(`${termo}${when ? ` when:${when}` : ''}`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  try {
    const { data } = await googleNews.executar(() =>
      axios.get(
        url,
        comProxy({
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, text/xml' },
          timeout: 15000,
        })
      )
    );
    const itens = extrairItensRss(String(data || '')).map((item) => ({
      ...item,
      id: slugId(item.titulo, item.link),
      nicho: termo,
      fonte: when === '1d' ? 'Google News — 24h' : 'Google News',
      veiculo: item.veiculo || 'Google News',
      tipoFonte: 'noticia',
      recente: when === '1d',
      emAlta: false,
    }));
    if (itens.length) {
      if (!resolverDiretas) return guardarCacheRss(chaveCache, itens);
      const diretos = await buscarGoogleNewsPython(termo, {
        when,
        limit: 20,
        incluirWebGeral,
      });
      return guardarCacheRss(chaveCache, diretos.length ? diretos : itens);
    }
    return guardarCacheRss(
      chaveCache,
      await buscarGoogleNewsPython(termo, { when, incluirWebGeral })
    );
  } catch (err) {
    // Bloqueio por limite: o fallback em Python abre outro processo e bate no
    // mesmo news.google.com. Era essa cascata que alimentava os 503.
    if (googleNews.ehBloqueio(err)) {
      avisarUmaVez('rss-bloqueio', `Google News RSS: ${err.message}`);
      // Sem cachear: a recusa é do circuito, não deste termo. Gravar vazio aqui
      // deixaria o radar cego por 2 min depois de o Google já ter voltado.
      return [];
    }
    avisarUmaVez(`rss-${err.message}`, `Google News RSS: ${err.message}`);
    return guardarCacheRss(
      chaveCache,
      await buscarGoogleNewsPython(termo, { when, incluirWebGeral })
    );
  }
}

async function buscarGoogleNewsEmAlta(termo) {
  const chaveCache = `alta|${String(termo || '').trim().toLowerCase()}`;
  const emCache = lerCacheRss(chaveCache);
  if (emCache) return emCache;

  const q = encodeURIComponent(`${termo} when:1d`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
  try {
    const { data } = await googleNews.executar(() =>
      axios.get(
        url,
        comProxy({
          headers: { 'User-Agent': USER_AGENT },
          timeout: 15000,
        })
      )
    );
    const itens = extrairItensRss(String(data || ''))
      .slice(0, 8)
      .map((item) => ({
        ...item,
        id: slugId(item.titulo, item.link),
        nicho: termo,
        fonte: 'Google News — em alta',
        veiculo: item.veiculo || 'Google News',
        tipoFonte: 'noticia',
        recente: true,
        emAlta: true,
      }));
    return guardarCacheRss(chaveCache, itens);
  } catch (err) {
    const doCircuito = googleNews.ehBloqueio(err);
    avisarUmaVez(
      doCircuito ? 'alta-bloqueio' : `alta-${err.message}`,
      `Google News em alta: ${err.message}`
    );
    // Idem: recusa do circuito não vira cache negativo deste termo.
    return doCircuito ? [] : guardarCacheRss(chaveCache, []);
  }
}

async function buscarBraveNews(termo, periodo = 1) {
  if (!env.braveSearchApiKey) return [];
  try {
    const freshness = freshnessBrave(periodo);
    const { data } = await axios.get('https://api.search.brave.com/res/v1/news/search', {
      params: { q: termo, count: 20, freshness, country: 'BR', search_lang: 'pt-br' },
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': env.braveSearchApiKey,
      },
      timeout: 15000,
    });
    return (data?.results || []).map((r) => ({
      id: slugId(r.title, r.url),
      titulo: limparTitulo(r.title),
      link: r.url,
      resumo: limparResumo(r.description),
      data: r.page_age || r.age || null,
      dataTimestamp: parsearDataPub(r.page_age),
      nicho: termo,
      fonte: 'Brave News',
      veiculo: r.meta_url?.hostname || 'Brave',
      tipoFonte: 'noticia',
      recente: true,
      emAlta: false,
    }));
  } catch (err) {
    // Plano free / params inválidos → tenta sem freshness
    if (err.response?.status === 422) {
      try {
        const { data } = await axios.get('https://api.search.brave.com/res/v1/news/search', {
          params: { q: termo, count: 10, country: 'BR', search_lang: 'pt-br' },
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': env.braveSearchApiKey,
          },
          timeout: 15000,
        });
        return (data?.results || []).map((r) => ({
          id: slugId(r.title, r.url),
          titulo: limparTitulo(r.title),
          link: r.url,
          resumo: limparResumo(r.description),
          data: r.page_age || r.age || null,
          dataTimestamp: parsearDataPub(r.page_age),
          nicho: termo,
          fonte: 'Brave News',
          veiculo: r.meta_url?.hostname || 'Brave',
          tipoFonte: 'noticia',
          recente: true,
          emAlta: false,
        }));
      } catch (err2) {
        console.warn('Brave News:', err2.response?.data?.message || err2.message);
        return [];
      }
    }
    console.warn('Brave News:', err.response?.data?.message || err.message);
    return [];
  }
}

/** Redes cobertas na apuração social. Ampliar aqui reflete em toda a app. */
const REDES_SOCIAIS_PADRAO = Object.freeze([
  'site:instagram.com',
  'site:facebook.com',
  'site:youtube.com',
]);

/** Cobertura ampliada, usada quando se quer varrer o máximo de redes. */
const REDES_SOCIAIS_AMPLAS = Object.freeze([
  'site:instagram.com',
  'site:facebook.com',
  'site:youtube.com',
  'site:x.com OR site:twitter.com',
  'site:tiktok.com',
  'site:threads.net',
  'site:linkedin.com/posts',
  'site:reddit.com',
]);

async function buscarSerperRedes(termo, { redes = REDES_SOCIAIS_PADRAO, porRede = 5 } = {}) {
  const providerHealth = require('./providerHealth');
  if (!env.serperApiKey || providerHealth.estaFora('serper')) return [];
  const num = Math.max(1, Math.min(10, Number(porRede) || 5));

  // Plano free rejeita queries com vários OR site: — uma chamada por rede.
  // Em paralelo para não somar o tempo de cada busca.
  const resultados = await Promise.all(
    redes.map(async (site) => {
      try {
        const { data } = await axios.post(
          'https://google.serper.dev/search',
          { q: `${termo} ${site}`.slice(0, 200), num, gl: 'br', hl: 'pt-br' },
          {
            headers: { 'X-API-KEY': env.serperApiKey, 'Content-Type': 'application/json' },
            timeout: 15000,
          }
        );
        return (data?.organic || []).map((r) => ({
          id: slugId(r.title, r.link),
          titulo: limparTitulo(r.title),
          link: r.link,
          resumo: limparResumo(r.snippet),
          data: r.date || null,
          // Data do post costuma vir só no texto do resultado (ex.: "Jul 28, 2025")
          dataTimestamp:
            parsearDataPub(r.date) || extrairDataDeTexto(`${r.snippet || ''} ${r.title || ''}`),
          nicho: termo,
          fonte: 'Serper redes',
          veiculo: (() => {
            try {
              return new URL(r.link).hostname.replace(/^www\./, '');
            } catch {
              return 'Rede social';
            }
          })(),
          tipoFonte: 'rede_social',
          recente: true,
          redeSocial: true,
        }));
      } catch (err) {
        const motivo = err.response?.data?.message || err.message;
        providerHealth.registrarFalha('serper', motivo);
        console.warn('Serper redes:', motivo);
        return [];
      }
    })
  );

  return resultados.flat();
}

/**
 * Posts de redes sociais pelo endpoint WEB do Brave (o de notícias não indexa
 * redes). Plano free do Brave limita ~1 req/s, então aqui vai em série.
 */
async function buscarBraveWebRedes(termo, { redes = REDES_SOCIAIS_PADRAO, porRede = 5 } = {}) {
  if (!env.braveSearchApiKey) return [];
  const count = Math.max(1, Math.min(20, Number(porRede) || 5));
  const out = [];

  for (const site of redes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        params: { q: `${termo} ${site}`.slice(0, 200), count, country: 'BR', search_lang: 'pt-br' },
        headers: { Accept: 'application/json', 'X-Subscription-Token': env.braveSearchApiKey },
        timeout: 15000,
      });
      for (const r of data?.web?.results || []) {
        out.push({
          id: slugId(r.title, r.url),
          titulo: limparTitulo(r.title),
          link: r.url,
          resumo: limparResumo(r.description),
          data: r.page_age || r.age || null,
          dataTimestamp:
            parsearDataPub(r.page_age || r.age) ||
            extrairDataDeTexto(`${r.description || ''} ${r.title || ''}`),
          nicho: termo,
          fonte: 'Brave redes',
          veiculo: r.meta_url?.hostname || 'Rede social',
          tipoFonte: 'rede_social',
          recente: true,
          redeSocial: true,
        });
      }
    } catch (err) {
      console.warn('Brave redes:', err.response?.status || '', err.response?.data?.message || err.message);
    }
    // Respeita o limite de 1 req/s do plano free
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1100));
  }

  return out;
}

/**
 * Busca posts em redes sociais com fallback entre provedores e motivo quando
 * não há resultado — para a apuração explicar o vazio em vez de sumir.
 * @returns {Promise<{ itens: any[], avisos: string[] }>}
 */
async function buscarPostsRedesSociais(termo, { redes = REDES_SOCIAIS_PADRAO, porRede = 5 } = {}) {
  const avisos = [];
  let itens = [];

  if (env.serperApiKey) {
    itens = await buscarSerperRedes(termo, { redes, porRede });
    if (!itens.length) avisos.push('o Serper não devolveu posts (cota diária do plano free ou nada indexado)');
  } else {
    avisos.push('SERPER_API_KEY não está configurada no servidor');
  }

  if (!itens.length) {
    if (env.braveSearchApiKey) {
      itens = await buscarBraveWebRedes(termo, { redes: redes.slice(0, 4), porRede });
      if (!itens.length) avisos.push('o Brave também não devolveu posts para este tema');
    } else {
      avisos.push('BRAVE_SEARCH_API_KEY não está configurada no servidor');
    }
  }

  return { itens, avisos };
}

/**
 * Pesquisa assuntos por palavras-chave.
 */
async function pesquisarNichos(palavrasChave, quantidadePorNicho = 8, opcoes = {}) {
  const termos = String(palavrasChave || '')
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 10);

  if (!termos.length) return [];

  const qtd = Math.min(Math.max(Number(quantidadePorNicho) || 8, 1), 20);
  const periodo = normalizarPeriodo(opcoes.periodo || (opcoes.diasRecentes ? `${opcoes.diasRecentes}d` : '24h'));
  const filtrarPeriodo = opcoes.somenteRecentes !== false && opcoes.filtrarPeriodo !== false;
  const incluirRedes = Boolean(opcoes.incluirRedesSociais);
  const somenteRedes = Boolean(opcoes.somenteRedesSociais);
  // A listagem de pautas precisa ser rápida. A leitura completa de cada link é
  // útil somente quando a pauta for escolhida para virar matéria.
  const apurar = opcoes.apurar !== false;
  const when = whenParaGoogle(periodo);

  const lotes = [];
  for (const termo of termos) {
    if (somenteRedes) {
      lotes.push(buscarSerperRedes(termo));
      continue;
    }
    lotes.push(buscarGoogleNewsRss(termo, { when }));
    lotes.push(buscarGoogleNewsEmAlta(termo));
    lotes.push(buscarBraveNews(termo, periodo));
    if (incluirRedes) lotes.push(buscarSerperRedes(termo));
  }

  const resultados = (await Promise.all(lotes)).flat();
  let lista = deduplicarTopicos(resultados);

  if (filtrarPeriodo) {
    lista = lista.filter((i) => itemEhRecente(i, periodo) || i.emAlta);
  }

  lista.sort((a, b) => (b.dataTimestamp || 0) - (a.dataTimestamp || 0) || (b.emAlta ? 1 : 0) - (a.emAlta ? 1 : 0));

  const limite = Math.min(termos.length * qtd, 80);
  const selecionados = lista.slice(0, limite);

  if (!apurar) return selecionados;

  const apurados = [];
  for (const item of selecionados.slice(0, Math.min(limite, 40))) {
    try {
      apurados.push(await apurarTopico(item));
    } catch {
      apurados.push(item);
    }
  }

  if (!apurados.length && !somenteRedes) {
    return termos.map((termo) => ({
      id: slugId(`pauta-${termo}`, termo),
      titulo: `Apuração: o que está em alta sobre ${termo}`,
      resumo: `Pauta editorial sugerida a partir do nicho “${termo}”. Gere a matéria com contexto geral e tom de Página.`,
      link: null,
      nicho: termo,
      fonte: 'Pauta editorial',
      veiculo: 'Editorial',
      tipoFonte: 'editorial',
      recente: true,
      dataTimestamp: Date.now(),
      contextoApuracao: `Nicho: ${termo}. Não há link de notícia recente; escreva uma matéria informativa/autêntica de Página sem inventar fatos específicos.`,
      fontesApuracao: [],
    }));
  }

  return apurados;
}

module.exports = {
  pesquisarNichos,
  buscarGoogleNewsRss,
  buscarGoogleNewsPython,
  decodificarLinksGoogle,
  buscarGoogleNewsEmAlta,
  buscarBraveNews,
  buscarSerperRedes,
  buscarBraveWebRedes,
  buscarPostsRedesSociais,
  extrairDataDeTexto,
  ehPostSocial,
  textoDeBuscaInutil,
  REDES_SOCIAIS_PADRAO,
  REDES_SOCIAIS_AMPLAS,
  itemEhRecente,
  itemDentroDoPeriodo,
  titulosSimilares,
  deduplicarTopicos,
  normalizarPeriodo,
  diasDoPeriodo,
  limiteDoPeriodo,
  rotuloPeriodo,
  whenParaGoogle,
  freshnessBrave,
};
