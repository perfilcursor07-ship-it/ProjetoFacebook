const axios = require('axios');
const { env } = require('../config/env');

const BROWSER_UA =
  (process.env.SOCIAL_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

/** Remove redirect de login e normaliza URL de foto/post do Facebook / Instagram. */
function normalizarUrlSocial(url) {
  let link = String(url || '').trim();
  if (!link) return link;
  try {
    const u = new URL(link);
    // Facebook manda o scraper para /login/?next=...
    if (/\/login/i.test(u.pathname) && u.searchParams.get('next')) {
      const next = u.searchParams.get('next');
      if (next) link = decodeURIComponent(next);
    }
  } catch {
    /* keep */
  }
  try {
    const u = new URL(link);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('instagram.com')) {
      u.hostname = 'www.instagram.com';
      u.hash = '';
      u.search = '';
      // /p/CODE/ ou /reel/CODE/ — canônico sem utm/igsh
      const m = u.pathname.match(/\/(p|reel|reels|tv)\/([^/?#]+)/i);
      if (m) {
        const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
        return `https://www.instagram.com/${kind}/${m[2]}/`;
      }
      return u.toString();
    }
    if (host.includes('facebook.com') || host === 'fb.com' || host === 'm.facebook.com') {
      u.hostname = 'www.facebook.com';
      u.hash = '';
      // photo/?fbid=X → forma canônica
      const fbid = u.searchParams.get('fbid');
      if (fbid && /\/photo/i.test(u.pathname)) {
        return `https://www.facebook.com/photo/?fbid=${fbid}`;
      }
      return u.toString();
    }
  } catch {
    /* keep */
  }
  return link;
}

/**
 * Links /share/ frequentemente terminam em /login/?next=<permalink>. Mesmo com
 * HTTP 400, o Axios mantém a URL final; aproveitamos o permalink sem usar a
 * página de login como fonte de conteúdo.
 */
async function resolverShareFacebook(url) {
  const original = normalizarUrlSocial(url);
  if (!/facebook\.com\/(?:share|share\.php)/i.test(original)) return original;

  for (const ua of [BROWSER_UA, CRAWLER_UA]) {
    try {
      const response = await axios.get(original, {
        timeout: 15000,
        maxRedirects: 8,
        validateStatus: () => true,
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
      });
      const finalUrl =
        response.request?.res?.responseURL ||
        response.request?.res?.responseUrl ||
        response.headers?.location ||
        original;
      const resolvido = normalizarUrlSocial(finalUrl);
      if (resolvido && resolvido !== original && isSocialPostUrl(resolvido)) {
        console.info(`[socialPost] facebook share resolvido: ${resolvido}`);
        return resolvido;
      }
    } catch (err) {
      const finalUrl =
        err.response?.request?.res?.responseURL ||
        err.response?.request?.res?.responseUrl ||
        err.response?.headers?.location ||
        '';
      const resolvido = normalizarUrlSocial(finalUrl);
      if (resolvido && resolvido !== original && isSocialPostUrl(resolvido)) {
        console.info(`[socialPost] facebook share resolvido apos erro: ${resolvido}`);
        return resolvido;
      }
      console.warn('[socialPost] facebook share:', err.message);
    }
  }
  return original;
}

function extrairShortcodeIg(url) {
  const m = String(url || '').match(
    /instagram\.com\/(?:[a-z0-9._]+\/)?(?:p|reel|reels|tv)\/([^/?#]+)/i
  );
  return m?.[1] || null;
}

/** sessionid etc. de YTDLP_IG_COOKIES_FILE (Netscape). */
async function buildInstagramCookieHeader() {
  const { buildInstagramCookieHeader: build } = require('./instagramCookies');
  return build();
}

/** c_user/xs etc. de YTDLP_FB_COOKIES_FILE (Netscape). */
function buildFacebookCookieHeader() {
  const { buildFacebookCookieHeader: build } = require('./facebookCookies');
  return build();
}

/** Cookie header da plataforma do link, quando houver sessão configurada. */
async function cookieHeaderParaUrl(url) {
  if (/instagram\.com/i.test(url)) return (await buildInstagramCookieHeader()) || null;
  if (/facebook\.com/i.test(url)) return buildFacebookCookieHeader();
  return null;
}

function textoGenericoSocial(texto) {
  const t = String(texto || '').trim();
  if (!t) return true;
  if (t.length < 60) return true;
  if (/^(facebook|instagram|log in|sign up)$/i.test(t)) return true;
  if (/faça login|entre no facebook|create an account/i.test(t)) return true;
  return false;
}

function extrairComentariosDoMedia(media, limite = 8) {
  const candidatos = [
    ...(media?.edge_media_to_parent_comment?.edges || []).map((e) => e?.node),
    ...(media?.edge_media_preview_comment?.edges || []).map((e) => e?.node),
    ...(Array.isArray(media?.preview_comments) ? media.preview_comments : []),
  ];
  const vistos = new Set();
  return candidatos
    .map((c) => ({
      autor: String(c?.owner?.username || c?.user?.username || '').trim(),
      texto: String(c?.text || '').trim(),
      curtidas: Number(c?.edge_liked_by?.count ?? c?.comment_like_count ?? c?.like_count) || 0,
    }))
    .filter((c) => c.texto.length >= 20 && !vistos.has(c.texto) && vistos.add(c.texto))
    .sort((a, b) => b.curtidas - a.curtidas)
    .slice(0, limite);
}

function detectarPlataformaSocial(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('facebook.com') || host === 'fb.com' || host === 'fb.watch' || host === 'm.facebook.com') {
      return 'facebook';
    }
    if (host.includes('instagram.com')) return 'instagram';
  } catch {
    /* ignore */
  }
  return null;
}

function isSocialPostUrl(url) {
  const plataforma = detectarPlataformaSocial(url);
  if (!plataforma) return false;
  const u = String(url || '').toLowerCase();
  if (plataforma === 'facebook') {
    return (
      /\/posts\//i.test(u) ||
      /\/permalink\.php/i.test(u) ||
      /story_fbid=/i.test(u) ||
      /\/reel\//i.test(u) ||
      /\/videos\//i.test(u) ||
      /\/share\//i.test(u) ||
      /\/photo\.php/i.test(u) ||
      /\/photo\/?\?/i.test(u) ||
      /\/photo\//i.test(u) ||
      /\/photos\//i.test(u) ||
      /[?&]fbid=/i.test(u) ||
      /pfbid/i.test(u) ||
      /fb\.watch/i.test(u)
    );
  }
  // Instagram: post, reel, tv
  return /instagram\.com\/(p|reel|reels|tv)\//i.test(u);
}

/** Reel / vídeo (não foto) — baixa, transcreve e publica como Reels. */
function isSocialVideoUrl(url) {
  if (!isSocialPostUrl(url)) return false;
  const u = String(url || '').toLowerCase();
  if (/instagram\.com\/(reel|reels|tv)\//i.test(u)) return true;
  if (/\/reel\//i.test(u) || /\/reels\//i.test(u)) return true;
  if (/\/videos\//i.test(u) || /fb\.watch/i.test(u) || /\/watch\/?\?/i.test(u)) return true;
  return false;
}

function decodificarEntidades(texto) {
  if (!texto) return '';
  let t = String(texto);
  t = t
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return _;
      }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  return t.replace(/\s+/g, ' ').trim();
}

/** Tira prefixo "X likes, Y comments - user on date:" e pega a legenda entre aspas. */
function limparLegendaInstagram(raw) {
  let t = decodificarEntidades(String(raw || '').trim());
  if (!t) return null;
  const quoted = t.match(/["“]([\s\S]+?)["”]\s*$/);
  if (quoted?.[1] && quoted[1].trim().length >= 40) {
    return quoted[1].trim();
  }
  const afterColon = t.match(
    /(?:likes?|curtidas?|comments?|coment[aá]rios?)[^.]*?:\s*["“]?([\s\S]+)/i
  );
  if (afterColon?.[1]) {
    const cleaned = afterColon[1].replace(/^["“]|["”]$/g, '').trim();
    if (cleaned.length >= 40) return cleaned;
  }
  return t;
}

function unescapeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return decodificarEntidades(
      String(raw || '')
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    );
  }
}

/**
 * Extrai legenda/imagem do HTML do Instagram (SPA / embed / OG).
 * HTML autenticado no datacenter costuma ter ~600kb sem edge_media clássico.
 */
function extrairDadosDoHtmlInstagram(html, url) {
  if (!html || html.length < 200) return null;

  const signals = {
    len: html.length,
    hasLogin: /\/accounts\/login/i.test(html.slice(0, 8000)),
    hasOgDesc: /og:description/i.test(html),
    hasOgImage: /og:image/i.test(html),
    hasCaptionText: /"caption"\s*:\s*\{[^]{0,400}?"text"\s*:/i.test(html),
    hasXdt: /xdt_shortcode_media/i.test(html),
    hasEdgeCaption: /edge_media_to_caption/i.test(html),
    hasDisplayUrl: /"display_url"\s*:/i.test(html),
    hasClassCaption: /class="Caption"/i.test(html),
  };

  const parsedOg = parseOgFromHtml(html, url);
  let texto = parsedOg.texto;
  let imagem = parsedOg.imagem;
  let veiculo = parsedOg.veiculo;
  // Na página canônica, og:description pertence ao post solicitado. O HTML da SPA
  // também contém captions de posts recomendados; escolher uma delas só por ser
  // mais longa mistura publicações diferentes.
  const textoOgConfiavel = Boolean(
    texto && texto.length >= 40 && !textoGenericoSocial(texto)
  );
  signals.usedOgText = textoOgConfiavel;

  const captionRes = [
    /"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/,
    /"caption"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/,
    /"caption"\s*:\s*\{[^]{0,500}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/,
    /"xdt_shortcode_media"[\s\S]{0,4000}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/,
  ];

  if (!textoOgConfiavel) {
    for (const re of captionRes) {
      const m = html.match(re);
      if (!m?.[1]) continue;
      let candidate = unescapeJsonString(m[1]);
      candidate = limparLegendaInstagram(candidate) || candidate;
      if (candidate && candidate.length >= 20 && candidate.length > (texto?.length || 0)) {
        texto = candidate;
        break;
      }
    }
  }

  // Embed: <div class="Caption">...</div>
  if ((!texto || texto.length < 40) && signals.hasClassCaption) {
    const cap = html.match(
      /class="Caption"[^>]*>([\s\S]*?)(?:class="CaptionComments"|class="SocialProof"|<\/blockquote>)/i
    );
    if (cap?.[1]) {
      const userMatch = cap[1].match(/CaptionUsername[^>]*>([^<]+)</i);
      if (userMatch?.[1]) veiculo = decodificarEntidades(userMatch[1]).replace(/^@/, '');
      const plain = decodificarEntidades(
        cap[1]
          .replace(/<a[^>]*CaptionUsername[\s\S]*?<\/a>/i, ' ')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
      );
      if (plain.length >= 40) texto = plain;
    }
  }

  // Scripts JSON embutidos (Instagram 2024+ data-sjs / application/json)
  if (!texto || texto.length < 40) {
    const scripts = [
      ...html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi),
      ...html.matchAll(/<script[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/gi),
    ];
    for (const sm of scripts.slice(0, 40)) {
      const body = sm[1] || '';
      if (body.length < 80 || body.length > 2_000_000) continue;
      if (!/caption|shortcode|display_url|xdt_shortcode/i.test(body)) continue;
      const m =
        body.match(/"caption"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/) ||
        body.match(/"caption"\s*:\s*\{[^]{0,800}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/) ||
        body.match(/"text"\s*:\s*"((?:\\.|[^"\\]){50,5000})"/);
      if (!m?.[1]) continue;
      let candidate = unescapeJsonString(m[1]);
      candidate = limparLegendaInstagram(candidate) || candidate;
      if (
        candidate &&
        candidate.length >= 40 &&
        !/^(Log in|Sign up|Instagram|Meta)/i.test(candidate) &&
        candidate.length > (texto?.length || 0)
      ) {
        texto = candidate;
        signals.hasCaptionText = true;
        break;
      }
    }
  }

  if (!imagem) {
    const imgRes = [
      /"display_url"\s*:\s*"(https:[^"]+)"/i,
      /"image_versions2"[\s\S]{0,400}?"url"\s*:\s*"(https:[^"]+)"/i,
    ];
    for (const re of imgRes) {
      const m = html.match(re);
      if (m?.[1] && !/rsrc\.php|static\.cdninstagram/i.test(m[1])) {
        imagem = m[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
        break;
      }
    }
    if (!imagem) imagem = parsedOg.imagem;
  }

  if (!veiculo) {
    veiculo =
      html.match(/"owner"\s*:\s*\{[^}]*"username"\s*:\s*"([a-z0-9._]+)"/i)?.[1] ||
      html.match(/"username"\s*:\s*"([a-z0-9._]+)"/i)?.[1] ||
      parsedOg.veiculo ||
      null;
  }

  // Prints/cards do carrossel podem trazer detalhes e comentários na descrição
  // de acessibilidade. Restringe ao perfil do post para ignorar recomendações.
  const conteudoVisual = [];
  const autorNormalizado = String(veiculo || '').replace(/^@/, '').toLowerCase();
  for (const match of html.matchAll(/"accessibility_caption"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    const descricao = unescapeJsonString(match[1]).replace(/\s+/g, ' ').trim();
    if (descricao.length < 40) continue;
    if (autorNormalizado && !descricao.toLowerCase().includes(autorNormalizado)) continue;
    if (!conteudoVisual.includes(descricao)) conteudoVisual.push(descricao.slice(0, 1200));
    if (conteudoVisual.length >= 5) break;
  }

  if (texto && texto.length >= 40) {
    return {
      url,
      titulo: texto.slice(0, 140),
      texto,
      imagem: imagem || null,
      veiculo,
      metodo: 'ig-html',
      conteudoVisual,
      signals,
    };
  }

  return {
    url,
    titulo: parsedOg.titulo || null,
    texto: texto || null,
    imagem: imagem || null,
    veiculo,
    metodo: 'ig-html',
    conteudoVisual,
    signals,
    empty: true,
  };
}

function pickMeta(html, prop) {
  const patterns = [
    new RegExp(`property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'),
    new RegExp(`name=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`content=["']([^"']+)["'][^>]+name=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodificarEntidades(m[1].replace(/&amp;/gi, '&'));
  }
  return null;
}

function absolutizar(base, maybe) {
  if (!maybe) return null;
  try {
    return new URL(maybe, base).href;
  } catch {
    return /^https?:\/\//i.test(maybe) ? maybe : null;
  }
}

async function fetchHtml(url, userAgent, extraHeaders = {}) {
  const res = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    beforeRedirect: extraHeaders.Cookie
      ? require('./facebookCookies').manterCookieFacebookNoRedirect(extraHeaders.Cookie)
      : undefined,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      ...extraHeaders,
    },
  });
  return {
    html: String(res.data || ''),
    finalUrl: res.request?.res?.responseURL || res.request?.res?.responseUrl || url,
  };
}

function parseOgFromHtml(html, finalUrl) {
  let titulo = pickMeta(html, 'og:title') || pickMeta(html, 'twitter:title');
  let resumo = pickMeta(html, 'og:description') || pickMeta(html, 'twitter:description');
  const imagem =
    absolutizar(finalUrl, pickMeta(html, 'og:image')) ||
    absolutizar(finalUrl, pickMeta(html, 'og:image:secure_url')) ||
    absolutizar(finalUrl, pickMeta(html, 'twitter:image'));

  let veiculo = null;
  try {
    const host = new URL(finalUrl).hostname.replace(/^www\./, '');
    // og:title em foto FB costuma ser "Nome da Página" — útil como veículo
    veiculo = titulo && !/^(facebook|instagram)$/i.test(titulo) ? titulo : host;
  } catch {
    veiculo = null;
  }

  // Instagram: limpa legenda do og:description / og:title
  if (/instagram\.com/i.test(finalUrl)) {
    const limpo = limparLegendaInstagram(resumo) || limparLegendaInstagram(titulo);
    if (limpo && limpo.length >= 40) {
      resumo = limpo;
      if (!titulo || /(?:on|no)\s+Instagram:/i.test(titulo) || /instagram photos/i.test(titulo)) {
        titulo = limpo.slice(0, 140);
      }
    }
    const authorFromTitle = String(titulo || '').match(/^(.+?)\s+on Instagram:/i);
    if (authorFromTitle?.[1]) veiculo = authorFromTitle[1].trim();
    const authorFromDesc = String(pickMeta(html, 'og:description') || '').match(
      /-\s*([a-z0-9._]+)\s+(?:on|no)\s+/i
    );
    if (authorFromDesc?.[1]) veiculo = authorFromDesc[1];
  }

  return {
    url: finalUrl,
    titulo: titulo || null,
    texto: resumo || null,
    imagem: imagem || null,
    veiculo,
    metodo: 'og',
  };
}

async function extrairViaOg(url) {
  const cookie = await cookieHeaderParaUrl(url);
  const ehFacebook = /facebook\.com/i.test(url);
  // Autenticado, o Facebook exige headers completos de navegador (Accept curto → 400).
  const headersPara = (ua) => {
    if (ehFacebook && cookie) {
      const { facebookHtmlHeaders } = require('./facebookCookies');
      return facebookHtmlHeaders(cookie, ua);
    }
    return cookie ? { Cookie: cookie } : {};
  };

  // Crawler UA primeiro (melhor OG); se falhar imagem/texto, tenta browser UA
  let best = { url, titulo: null, texto: null, imagem: null, veiculo: null, metodo: 'og' };
  for (const ua of [CRAWLER_UA, BROWSER_UA]) {
    try {
      const { html, finalUrl } = await fetchHtml(url, ua, headersPara(ua));
      const parsed = parseOgFromHtml(html, finalUrl);
      if ((!best.texto || best.texto.length < 40) && parsed.texto) best.texto = parsed.texto;
      if (!best.imagem && parsed.imagem) best.imagem = parsed.imagem;
      if (!best.titulo && parsed.titulo) best.titulo = parsed.titulo;
      if (!best.veiculo && parsed.veiculo) best.veiculo = parsed.veiculo;
      best.url = parsed.url || best.url;
      if (best.texto && best.imagem) break;
    } catch (err) {
      console.warn('[socialPost] og ua:', err.message);
    }
  }
  return best;
}

/**
 * Embed público do Instagram — muitas vezes devolve a legenda mesmo quando o post
 * principal bloqueia IPs de datacenter.
 */
async function extrairViaInstagramEmbed(url) {
  const code = extrairShortcodeIg(url);
  if (!code) return null;

  const cookie = await buildInstagramCookieHeader();
  const extra = cookie ? { Cookie: cookie } : {};
  const candidates = [
    `https://www.instagram.com/p/${code}/embed/captioned/`,
    `https://www.instagram.com/reel/${code}/embed/captioned/`,
    `https://www.instagram.com/p/${code}/embed/`,
  ];

  for (const embedUrl of candidates) {
    for (const ua of [CRAWLER_UA, BROWSER_UA]) {
      try {
        const { html } = await fetchHtml(embedUrl, ua, extra);
        if (!html || html.length < 500) continue;

        let texto = null;
        let veiculo = null;
        let imagem = null;

        const edge = html.match(
          /"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/
        );
        if (edge?.[1]) {
          try {
            texto = JSON.parse(`"${edge[1]}"`);
          } catch {
            texto = decodificarEntidades(edge[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
          }
        }

        if (!texto || texto.length < 40) {
          const capBlock = html.match(
            /class="Caption"[^>]*>([\s\S]*?)(?:class="CaptionComments"|class="SocialProof"|<\/blockquote>)/i
          );
          if (capBlock?.[1]) {
            const userMatch = capBlock[1].match(/CaptionUsername[^>]*>([^<]+)</i);
            if (userMatch?.[1]) veiculo = decodificarEntidades(userMatch[1]).replace(/^@/, '');
            texto = decodificarEntidades(
              capBlock[1]
                .replace(/<a[^>]*CaptionUsername[\s\S]*?<\/a>/i, ' ')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>/gi, '\n')
                .replace(/<[^>]+>/g, ' ')
            );
          }
        }

        if (!veiculo) {
          const user = html.match(/instagram\.com\/([a-z0-9._]+)\/?\?utm_source=ig_embed/i);
          if (user?.[1] && !/^(p|reel|reels|tv|explore)$/i.test(user[1])) veiculo = user[1];
        }

        const imgMatch =
          html.match(
            /(https:\/\/[^"'\s]+(?:cdninstagram|fbcdn)[^"'\s]+\.(?:jpg|webp)[^"'\s]*)/i
          ) || html.match(/content=["'](https:\/\/[^"']+scontent[^"']+)["']/i);
        if (imgMatch?.[1] && !/rsrc\.php|static\.cdninstagram/i.test(imgMatch[1])) {
          imagem = imgMatch[1].replace(/&amp;/g, '&');
        }

        texto = limparLegendaInstagram(texto) || texto;
        if (texto && texto.length >= 40) {
          return {
            url,
            titulo: texto.slice(0, 140),
            texto,
            imagem,
            veiculo,
            metodo: 'ig-embed',
            postId: code,
          };
        }
      } catch (err) {
        console.warn('[socialPost] ig-embed:', err.message);
      }
    }
  }
  return null;
}

/**
 * Mirrors (ddinstagram etc.) — útil quando o domínio oficial bloqueia o servidor.
 */
async function extrairViaInstagramMirror(url) {
  const code = extrairShortcodeIg(url);
  if (!code) return null;
  const tipoOriginal = String(url).match(/instagram\.com\/(p|reel|reels|tv)\//i)?.[1] || 'p';
  const tipo = /reel|reels|tv/i.test(tipoOriginal) ? 'reel' : 'p';
  const mirrors = [
    `https://boberx.com/${tipo}/${code}/`,
    `https://hhinstagram.com/${tipo}/${code}/`,
    `https://www.ddinstagram.com/${tipo}/${code}/`,
    `https://ddinstagram.com/${tipo}/${code}/`,
  ];
  for (const mirror of mirrors) {
    try {
      const { html, finalUrl } = await fetchHtml(mirror, CRAWLER_UA);
      const parsed = parseOgFromHtml(html, finalUrl || mirror);
      const canonical = pickMeta(html, 'og:url');
      const codeDeclarado = extrairShortcodeIg(canonical);
      const codeFinal = extrairShortcodeIg(finalUrl) || extrairShortcodeIg(parsed.url);
      const codeConfirmado = codeDeclarado || codeFinal;
      const postCorreto =
        Boolean(codeConfirmado) && codeConfirmado.toLowerCase() === code.toLowerCase();
      let texto = limparLegendaInstagram(parsed.texto) || String(parsed.texto || '').trim();
      if (/^[❤❤️]/u.test(texto)) {
        texto = texto.replace(/^.{0,80}💬\s*[\d.,]+\s*[KMB]?\s*/iu, '').trim();
      }
      if (/…|\.\.\.$/.test(texto)) {
        const semReticencias = texto.replace(/(?:…|\.\.\.)\s*$/, '').trim();
        const fimCompleto = Math.max(
          semReticencias.lastIndexOf('.'),
          semReticencias.lastIndexOf('!'),
          semReticencias.lastIndexOf('?')
        );
        if (fimCompleto >= 80) texto = semReticencias.slice(0, fimCompleto + 1).trim();
      }
      const respostaInvalida =
        /post not found|preview unavailable|did not provide public media|out of requests/i.test(
          `${parsed.titulo || ''} ${texto}`
        );
      if (postCorreto && !respostaInvalida && texto.length >= 40) {
        parsed.url = url;
        parsed.texto = texto;
        const autorCanonical = String(canonical || '').match(
          /instagram\.com\/([a-z0-9._]+)\/(?:p|reel|reels|tv)\//i
        )?.[1];
        if (autorCanonical) parsed.veiculo = autorCanonical;
        if (/^@[a-z0-9._]+$/i.test(String(parsed.titulo || ''))) {
          parsed.veiculo = String(parsed.titulo).replace(/^@/, '');
          parsed.titulo = texto.slice(0, 140);
        }
        parsed.metodo = 'ig-mirror';
        parsed.postId = code;
        return parsed;
      }
    } catch (err) {
      console.warn('[socialPost] ig-mirror:', err.message);
    }
  }
  return null;
}

/**
 * API web do Instagram com sessionid (melhor caminho para foto /p/ no servidor).
 * yt-dlp costuma devolver HTTP 400 em posts só com imagem.
 */
async function extrairViaInstagramApi(url) {
  const {
    buildInstagramCookieHeader,
    diagnoseInstagramCookies,
    shortcodeToMediaId,
    instagramApiHeaders,
    bootstrapInstagramSession,
  } = require('./instagramCookies');

  const code = extrairShortcodeIg(url);
  if (!code) {
    console.warn('[socialPost] ig-api: shortcode inválido');
    return null;
  }

  let cookieHeader = buildInstagramCookieHeader();
  if (!cookieHeader) {
    const diag = diagnoseInstagramCookies();
    console.warn('[socialPost] ig-api: sem sessionid —', diag.reason, diag.file || '');
    return null;
  }

  // Bootstrap www-claim (sem isso /media/*/info/ costuma 400 no datacenter)
  let wwwClaim = '0';
  try {
    const boot = await bootstrapInstagramSession(axios);
    if (boot?.cookieHeader) cookieHeader = boot.cookieHeader;
    if (boot?.claim) wwwClaim = boot.claim;
    console.warn(
      `[socialPost] ig-api: bootstrap status=${boot?.homeStatus || '?'} claim=${wwwClaim !== '0'} homeLen=${boot?.homeLen || 0}`
    );
  } catch (err) {
    console.warn('[socialPost] ig-api: bootstrap', err.message);
  }

  const mediaId = shortcodeToMediaId(code);
  const dsUserId = require('./instagramCookies').loadInstagramCookies()?.cookies?.ds_user_id;
  const mediaIdWithUser = mediaId && dsUserId ? `${mediaId}_${dsUserId}` : null;
  console.warn(`[socialPost] ig-api: tentando shortcode=${code} mediaId=${mediaId}`);

  const endpoints = [
    mediaId ? `https://www.instagram.com/api/v1/media/${mediaId}/info/` : null,
    mediaId ? `https://i.instagram.com/api/v1/media/${mediaId}/info/` : null,
    mediaIdWithUser ? `https://i.instagram.com/api/v1/media/${mediaIdWithUser}/info/` : null,
    `https://www.instagram.com/graphql/query/?doc_id=10015901848456354&variables=${encodeURIComponent(
      JSON.stringify({
        shortcode: code,
        fetch_tagged_user_count: null,
        hoisted_comment_id: null,
        hoisted_reply_id: null,
      })
    )}`,
    `https://www.instagram.com/p/${code}/?__a=1&__d=dis`,
    `https://www.instagram.com/reel/${code}/?__a=1&__d=dis`,
  ].filter(Boolean);

  // Variante do app Android só com INSTAGRAM_API_MOBILE=1: a mesma sessão em
  // navegador e celular faz o Instagram bloquear a conta.
  const headerVariants = [
    instagramApiHeaders(cookieHeader, { mobile: false, wwwClaim }),
    ...(require('./instagramCookies').instagramMobileLiberado()
      ? [instagramApiHeaders(cookieHeader, { mobile: true, wwwClaim })]
      : []),
  ];

  for (const headers of headerVariants) {
    for (const endpoint of endpoints) {
      try {
        const { data, status } = await axios.get(endpoint, {
          timeout: 25000,
          headers,
          validateStatus: (s) => s >= 200 && s < 500,
        });
        if (status >= 400 || !data) {
          console.warn(`[socialPost] ig-api: ${status} ${endpoint.slice(0, 70)}`);
          continue;
        }

        let media =
          data?.items?.[0] ||
          data?.graphql?.shortcode_media ||
          data?.data?.xdt_shortcode_media ||
          data?.data?.shortcode_media ||
          null;

        if (!media && data && typeof data === 'object') {
          for (const v of Object.values(data)) {
            if (v?.graphql?.shortcode_media) {
              media = v.graphql.shortcode_media;
              break;
            }
            if (v?.items?.[0]) {
              media = v.items[0];
              break;
            }
          }
        }
        if (!media || typeof media !== 'object') continue;

        const shortcodeRetornado = String(media.code || media.shortcode || '').trim();
        if (shortcodeRetornado && shortcodeRetornado.toLowerCase() !== code.toLowerCase()) {
          console.warn(
            `[socialPost] ig-api: descartou post divergente solicitado=${code} recebido=${shortcodeRetornado}`
          );
          continue;
        }

        const textoRaw =
          media.caption?.text ||
          media.edge_media_to_caption?.edges?.[0]?.node?.text ||
          media.accessibility_caption ||
          '';
        let texto = limparLegendaInstagram(textoRaw) || String(textoRaw || '').trim();
        const veiculo =
          media.user?.username || media.owner?.username || media.user?.full_name || null;
        const imagem =
          media.image_versions2?.candidates?.[0]?.url ||
          media.display_url ||
          media.display_resources?.slice?.(-1)?.[0]?.src ||
          media.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
          null;
        const videoUrl =
          media.video_versions?.[0]?.url ||
          media.video_url ||
          null;
        const subtitleUrl = (() => {
          const fila = [{ value: media, depth: 0, path: '' }];
          const vistos = new Set();
          while (fila.length) {
            const { value, depth, path } = fila.shift();
            if (!value || typeof value !== 'object' || vistos.has(value) || depth > 6) continue;
            vistos.add(value);
            for (const [key, child] of Object.entries(value)) {
              const keyPath = `${path}.${key}`;
              if (
                typeof child === 'string' &&
                /^https?:\/\//i.test(child) &&
                /subtitle|closed[_-]?caption/i.test(keyPath)
              ) {
                return child;
              }
              if (child && typeof child === 'object') {
                fila.push({ value: child, depth: depth + 1, path: keyPath });
              }
            }
          }
          return null;
        })();

        const result = {
          url,
          titulo: texto ? texto.slice(0, 140) : veiculo || 'Reel do Instagram',
          texto: texto || null,
          imagem: imagem || null,
          veiculo,
          metodo: 'ig-api',
          postId: shortcodeRetornado || code,
          comentarios: extrairComentariosDoMedia(media),
          videoUrl,
          subtitleUrl,
          isVideo: Boolean(videoUrl || subtitleUrl),
        };

        if (texto && texto.length >= 40) {
          console.warn(`[socialPost] ig-api: ok (${texto.length} chars) via ${endpoint.slice(0, 60)}`);
          return result;
        }
        if (imagem && texto && texto.length >= 20) {
          return result;
        }
        if (subtitleUrl || videoUrl) return result;
      } catch (err) {
        console.warn('[socialPost] ig-api:', err.response?.status || err.message);
      }
    }
  }

  // HTML: com cookies (claim) + embed público (às vezes funciona sem cookie no crawler UA)
  const htmlAttempts = [
    { ua: CRAWLER_UA, cookie: cookieHeader },
    { ua: BROWSER_UA, cookie: cookieHeader },
    { ua: CRAWLER_UA, cookie: null },
  ];
  for (const attempt of htmlAttempts) {
    try {
      const pages = [
        url,
        `https://www.instagram.com/p/${code}/embed/captioned/`,
        `https://www.instagram.com/p/${code}/embed/`,
      ];
      for (const pageUrl of pages) {
        const extra = {
          'X-IG-App-ID': '936619743392459',
          ...(attempt.cookie ? { Cookie: attempt.cookie } : {}),
          ...(wwwClaim && wwwClaim !== '0' ? { 'X-IG-WWW-Claim': wwwClaim } : {}),
        };
        const { html, finalUrl } = await fetchHtml(pageUrl, attempt.ua, extra);
        const extracted = extrairDadosDoHtmlInstagram(html, finalUrl || url);
        const sig = extracted?.signals
          ? `login=${extracted.signals.hasLogin} og=${extracted.signals.hasOgDesc} usedOg=${extracted.signals.usedOgText} captionJson=${extracted.signals.hasCaptionText} xdt=${extracted.signals.hasXdt} embedCap=${extracted.signals.hasClassCaption}`
          : '';
        console.warn(
          `[socialPost] ig-html: cookie=${Boolean(attempt.cookie)} ua=${attempt.ua.slice(0, 18)} url=${pageUrl.slice(-36)} len=${html.length} ${sig}`
        );
        const veioDoPostSolicitado = pageUrl.includes('/embed/')
          ? Boolean(extracted?.signals?.hasClassCaption || extracted?.signals?.usedOgText)
          : Boolean(extracted?.signals?.usedOgText);
        if (
          veioDoPostSolicitado &&
          extracted &&
          !extracted.empty &&
          extracted.texto &&
          extracted.texto.length >= 40
        ) {
          console.warn(`[socialPost] ig-html: ok (${extracted.texto.length} chars)`);
          return {
            url,
            titulo: extracted.titulo,
            texto: extracted.texto,
            imagem: extracted.imagem,
            veiculo: extracted.veiculo,
            metodo: 'ig-cookie-html',
            postId: code,
          };
        }
      }
    } catch (err) {
      console.warn('[socialPost] ig-cookie-html:', err.message);
    }
  }

  console.warn('[socialPost] ig-api: falhou em todos os endpoints');
  return null;
}

/**
 * Jina Reader — texto mais completo de posts públicos.
 * https://r.jina.ai/<url>
 */
async function extrairViaJina(url) {
  const res = await axios.get(`https://r.jina.ai/${url}`, {
    timeout: 60000,
    headers: {
      Accept: 'text/plain',
      'User-Agent': BROWSER_UA,
      'X-Return-Format': 'markdown',
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const raw = String(res.data || '');
  const titleMatch = raw.match(/^Title:\s*(.+)$/m);
  const titulo = titleMatch ? titleMatch[1].trim() : null;

  // Pega o bloco de markdown após "Markdown Content:"
  let body = raw;
  const mdIdx = raw.search(/Markdown Content:\s*/i);
  if (mdIdx >= 0) body = raw.slice(mdIdx).replace(/^Markdown Content:\s*/i, '');

  // Remove ruído de login / navegação
  const linhas = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !/^\[Log In\]/i.test(l) &&
        !/^#{1,3}\s/i.test(l) &&
        !/^\*+$/.test(l) &&
        !/^!\[/.test(l) &&
        !/^\[.*\]\(https?:\/\/(www\.)?facebook\.com\/(login|stories)/i.test(l)
    );

  // Junta parágrafos “reais” (frases longas)
  const paragrafos = [];
  for (const l of linhas) {
    const clean = l
      .replace(/^>\s*/, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim();
    if (clean.length >= 40 && !/^(Log In|Sign Up|Follow|Curtir|Comentar)/i.test(clean)) {
      paragrafos.push(clean);
    }
    if (paragrafos.join(' ').length > 2500) break;
  }

  const texto = paragrafos.slice(0, 6).join('\n\n');
  const imgMatch = raw.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  const imagem = imgMatch?.[1] || null;

  return {
    url,
    titulo,
    texto: texto || null,
    imagem,
    veiculo: titulo || null,
    metodo: 'jina',
  };
}

async function extrairViaYtDlp(url) {
  try {
    // Não gasta yt-dlp em URL de login
    if (/facebook\.com\/login/i.test(url)) return null;
    const importService = require('./importService');
    const meta = await importService.fetchLinkMetadata(url);
    const fs = require('fs');
    const youtubedlPkg = require('youtube-dl-exec');
    const { runYtDlp } = require('./ytDlpAuth');
    let binary = String(process.env.YTDLP_PATH || '').trim();
    if (!binary || !fs.existsSync(binary)) {
      for (const c of ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
        if (fs.existsSync(c)) {
          binary = c;
          break;
        }
      }
    }
    const exec = binary ? youtubedlPkg.create(binary) : youtubedlPkg;
    const info = await runYtDlp(exec, url, {
      dumpSingleJson: true,
      noWarnings: true,
      skipDownload: true,
      noPlaylist: true,
      socketTimeout: 45,
      retries: 1,
    });
    const texto = String(info.description || info.title || '').trim();
    const thumb =
      info.thumbnail ||
      (Array.isArray(info.thumbnails)
        ? [...info.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url
        : null);
    return {
      url,
      titulo: info.title || meta.titulo || null,
      texto: texto || null,
      imagem: thumb || meta.thumbnail || null,
      veiculo: info.uploader || info.channel || meta.autor || null,
      metodo: 'yt-dlp',
    };
  } catch (err) {
    console.warn('[socialPost] yt-dlp:', err.message);
    return null;
  }
}

/** oEmbed oficial (app token) — FB e IG; Meta costuma exigir review do oEmbed Read. */
async function extrairViaOembed(url) {
  if (!env.facebook?.appId || !env.facebook?.appSecret) return null;
  const isIg = /instagram\.com/i.test(url);
  const endpoints = isIg
    ? [
        'https://graph.facebook.com/v21.0/instagram_oembed',
        'https://graph.facebook.com/v21.0/oembed_post',
      ]
    : ['https://graph.facebook.com/v21.0/oembed_post'];

  const token = `${env.facebook.appId}|${env.facebook.appSecret}`;
  for (const endpoint of endpoints) {
    try {
      const { data } = await axios.get(endpoint, {
        params: { url, access_token: token, omitscript: true },
        timeout: 20000,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const html = String(data.html || '');
      const author = data.author_name || null;
      let texto = null;
      const bq = html.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/i);
      if (bq) {
        texto = decodificarEntidades(
          bq[1]
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        );
      }
      if (texto) texto = limparLegendaInstagram(texto) || texto;
      const img =
        absolutizar(url, pickMeta(html, 'og:image')) ||
        (html.match(/src=["'](https:\/\/[^"']+(?:fbcdn|scontent|cdninstagram)[^"']+)["']/i) ||
          [])[1] ||
        null;
      if (!texto && !img && !author) continue;
      return {
        url,
        titulo: author ? `Post — ${author}` : null,
        texto: texto && !textoGenericoSocial(texto) ? texto : null,
        imagem: img,
        veiculo: author,
        metodo: 'oembed',
      };
    } catch (err) {
      console.warn('[socialPost] oembed:', err.response?.data?.error?.message || err.message);
    }
  }
  return null;
}

/** mbasic — às vezes passa onde www exige login. */
async function extrairViaMbasic(url) {
  try {
    const u = new URL(normalizarUrlSocial(url));
    if (!u.hostname.includes('facebook.com')) return null;
    u.hostname = 'mbasic.facebook.com';
    const cookie = buildFacebookCookieHeader();
    const { html, finalUrl } = await fetchHtml(
      u.toString(),
      BROWSER_UA,
      cookie ? { Cookie: cookie } : {}
    );
    if (/\/login/i.test(finalUrl) || /log in|entre no facebook/i.test(html.slice(0, 2000))) {
      return null;
    }
    const parsed = parseOgFromHtml(html, finalUrl);
    // Legenda em mbasic costuma estar em <div class="..."> longos
    if (!parsed.texto || parsed.texto.length < 80) {
      const plain = decodificarEntidades(
        html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|span)>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
      );
      const linhas = plain
        .split(/\n+/)
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter((l) => l.length >= 50 && !/^(Log In|Sign Up|Facebook|Menu|Notific)/i.test(l));
      const candidato = linhas.slice(0, 4).join('\n\n');
      if (candidato.length >= 60) parsed.texto = candidato.slice(0, 3500);
    }
    parsed.metodo = 'mbasic';
    return parsed;
  } catch (err) {
    console.warn('[socialPost] mbasic:', err.message);
    return null;
  }
}

/**
 * HTML autenticado do Facebook (YTDLP_FB_COOKIES_FILE). É o caminho gratuito
 * para posts que exigem login — o texto vem no JSON embutido, não no Open Graph.
 */
/**
 * Escolhe, no HTML autenticado, a mensagem que pertence AO post pedido.
 *
 * A página do Facebook embute posts sugeridos e relacionados com a mesma
 * estrutura JSON. Pegar "a maior mensagem" já gerou matéria com o conteúdo de
 * outro post, então a seleção é ancorada no identificador da URL
 * (story_fbid / pfbid / fbid). Sem âncora e com mais de um candidato, devolve
 * texto nulo — melhor pedir a legenda do que publicar o post errado.
 *
 * @returns {{ texto: string|null, indice: number|null, candidatos: number, ancoras: number, criterio: string, idPost: string|null }}
 */
function escolherMensagemDoPost(html, urlAlvo) {
  const candidatos = [];
  const padroes = [
    /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    /"message_preferred_body"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
  ];
  for (const re of padroes) {
    for (const m of String(html || '').matchAll(re)) {
      const conteudo = unescapeJsonString(m[1]).trim();
      if (conteudo.length >= 40) candidatos.push({ texto: conteudo, indice: m.index ?? 0 });
    }
  }

  const alvo = String(urlAlvo || '');
  const idPost =
    alvo.match(/story_fbid=(pfbid[A-Za-z0-9]+|\d{6,})/i)?.[1] ||
    alvo.match(/\/posts\/(pfbid[A-Za-z0-9]+|\d{6,})/i)?.[1] ||
    alvo.match(/[?&]fbid=(\d{6,})/i)?.[1] ||
    alvo.match(/(pfbid[A-Za-z0-9]+)/i)?.[1] ||
    null;

  const ancoras = [];
  if (idPost) {
    let i = String(html || '').indexOf(idPost);
    while (i !== -1 && ancoras.length < 200) {
      ancoras.push(i);
      i = String(html).indexOf(idPost, i + 1);
    }
  }

  const base = { candidatos: candidatos.length, ancoras: ancoras.length, idPost };

  if (!candidatos.length) return { ...base, texto: null, indice: null, criterio: 'sem-candidatos' };
  if (candidatos.length === 1) {
    return { ...base, texto: candidatos[0].texto, indice: candidatos[0].indice, criterio: 'única' };
  }
  if (!ancoras.length) return { ...base, texto: null, indice: null, criterio: 'ambíguo' };

  let melhor = null;
  let menorDistancia = Infinity;
  for (const c of candidatos) {
    for (const a of ancoras) {
      const d = Math.abs(c.indice - a);
      if (d < menorDistancia) {
        menorDistancia = d;
        melhor = c;
      }
    }
  }
  return {
    ...base,
    texto: melhor?.texto || null,
    indice: melhor?.indice ?? null,
    criterio: `ancorado(${menorDistancia})`,
  };
}

function normalizarUrlImagemFacebook(value) {
  const url = decodificarEntidades(unescapeJsonString(String(value || '')))
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .trim();
  if (!/^https:\/\//i.test(url)) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(?:^|\.)(?:fbcdn\.net|fbsbx\.com|cdninstagram\.com)$/.test(host) ||
      host.startsWith('scontent')
      ? url
      : null;
  } catch {
    return null;
  }
}

function dimensoesPertoDaImagemFacebook(html, indice) {
  const trecho = String(html || '').slice(Math.max(0, indice - 500), indice + 900);
  const width = Number(
    trecho.match(/"(?:width|image_width)"\s*:\s*(\d{1,5})/i)?.[1] || 0
  );
  const height = Number(
    trecho.match(/"(?:height|image_height)"\s*:\s*(\d{1,5})/i)?.[1] || 0
  );
  return { width, height };
}

function pareceImagemPequenaFacebook(item) {
  if (item.width && item.height && (item.width < 240 || item.height < 240)) return true;
  return /(?:^|[?&_/.=-])(?:s|p)?(?:40|50|60|80|100|120)x(?:40|50|60|80|100|120)(?:[?&_/.=-]|$)|t\d+\.\d+-1\//i.test(
    item.url
  );
}

/**
 * O HTML autenticado contém imagem de perfil, anúncios e posts sugeridos. A
 * foto da matéria precisa estar próxima da mensagem já ancorada no permalink,
 * nunca ser apenas a primeira URL scontent encontrada na página.
 */
function escolherImagemDoPostFacebook(html, escolha) {
  const bruto = String(html || '');
  const pontoDeReferencia = Number.isFinite(Number(escolha?.indice))
    ? Number(escolha.indice)
    : null;
  const candidatos = [];
  const padroes = [
    /"(?:photo_image|full_width_image|thumbnailImage|image)"\s*:\s*\{[\s\S]{0,900}?"uri"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    /"uri"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,260}?"(?:photo_image|full_width_image|thumbnailImage)"/g,
    // Payloads atuais também usam url/src, preferred_thumbnail, preview_image
    // e blocos media sem os nomes antigos acima.
    /"(?:photo_image|full_width_image|thumbnailImage|preferred_thumbnail|preview_image|viewer_image|image|media)"\s*:\s*\{[\s\S]{0,1800}?"(?:uri|url|src)"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    /"(?:uri|url|src)"\s*:\s*"((?:\\.|[^"\\])*(?:fbcdn\.net|fbsbx\.com|cdninstagram\.com)(?:\\.|[^"\\])*)"/g,
    /<img\b[^>]*\bsrc=["'](https:[^"']+(?:fbcdn\.net|fbsbx\.com|cdninstagram\.com)[^"']*)["']/gi,
  ];
  for (const re of padroes) {
    for (const match of bruto.matchAll(re)) {
      const url = normalizarUrlImagemFacebook(match[1]);
      if (url) {
        const indice = match.index ?? 0;
        candidatos.push({ url, indice, ...dimensoesPertoDaImagemFacebook(bruto, indice) });
      }
    }
  }
  if (!candidatos.length) return null;

  const vistos = new Set();
  const unicos = candidatos.filter((item) => !vistos.has(item.url) && vistos.add(item.url));
  if (pontoDeReferencia == null) return unicos.length === 1 ? unicos[0].url : null;

  const melhor = unicos
    .map((item) => {
      const distancia = Math.abs(item.indice - pontoDeReferencia);
      // No payload do story, o bloco de anexos normalmente vem logo depois da
      // mensagem. Imagem anterior costuma ser avatar ou o post anterior.
      const penalidadeAnterior = item.indice < pontoDeReferencia ? 30_000 : 0;
      const penalidadePequena = pareceImagemPequenaFacebook(item) ? 500_000 : 0;
      return {
        ...item,
        distancia,
        score: distancia + penalidadeAnterior + penalidadePequena,
      };
    })
    .sort((a, b) => a.score - b.score)[0];
  // Acima disso a mídia pertence, na prática, a outro bloco da página.
  return melhor && melhor.distancia <= 140_000 && !pareceImagemPequenaFacebook(melhor)
    ? melhor.url
    : null;
}

function identificadorPostFacebook(url) {
  const value = String(url || '');
  return (
    value.match(/story_fbid=(pfbid[A-Za-z0-9]+|\d{6,})/i)?.[1] ||
    value.match(/\/posts\/(pfbid[A-Za-z0-9]+|\d{6,})/i)?.[1] ||
    value.match(/[?&]fbid=(pfbid[A-Za-z0-9]+|\d{6,})/i)?.[1] ||
    value.match(/(pfbid[A-Za-z0-9]+)/i)?.[1] ||
    null
  );
}

/**
 * O Page Plugin público já é usado pela Biblioteca e costuma trazer a foto
 * mesmo quando o HTML completo esconde a mídia no payload. Para permalinks com
 * o dono no caminho, localiza o MESMO pfbid na timeline e reaproveita a capa.
 */
async function extrairViaFacebookPagePlugin(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return null;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  const owner = parts[0] || '';
  const idPost = identificadorPostFacebook(url);
  if (!owner || !idPost || /^(?:permalink\.php|photo\.php|story\.php)$/i.test(owner)) {
    return null;
  }

  try {
    const { listarPostsViaPlugin } = require('./facebookPageScrape');
    const posts = await listarPostsViaPlugin(`https://www.facebook.com/${owner}`, 40);
    const post = posts.find((item) => identificadorPostFacebook(item?.url) === idPost);
    if (!post || (!post.texto && !post.thumbnail)) return null;
    console.info(
      `[socialPost] fb-page-plugin: id=${idPost.slice(0, 14)} imagem=${Boolean(post.thumbnail)} posts=${posts.length}`
    );
    return {
      url: post.url || url,
      titulo: post.titulo || (post.texto ? String(post.texto).slice(0, 140) : null),
      texto: post.texto || null,
      imagem: normalizarUrlImagemFacebook(post.thumbnail) || null,
      veiculo: post.autor || owner,
      publicadoEm: post.publicadoEm || null,
      metodo: 'fb-page-plugin',
    };
  } catch (err) {
    console.warn('[socialPost] fb-page-plugin:', err.message);
    return null;
  }
}

async function extrairViaFacebookHtml(url) {
  const {
    buildFacebookCookieHeader: build,
    facebookHtmlHeaders,
    manterCookieFacebookNoRedirect,
  } = require('./facebookCookies');
  const cookie = build();
  if (!cookie) return null;

  try {
    // O Facebook responde 400 a requests com Accept mínimo; só os headers
    // completos de navegador (Sec-Fetch-*, Upgrade-Insecure-Requests) passam.
    const res = await axios.get(normalizarUrlSocial(url), {
      timeout: 30000,
      maxRedirects: 5,
      beforeRedirect: manterCookieFacebookNoRedirect(cookie),
      headers: facebookHtmlHeaders(cookie, BROWSER_UA),
      validateStatus: () => true,
    });
    const html = String(res.data || '');
    const finalUrl =
      res.request?.res?.responseURL || res.request?.res?.responseUrl || url;
    if (res.status >= 400) {
      console.warn(`[socialPost] fb-html: HTTP ${res.status}`);
      return null;
    }
    if (/\/login|\/checkpoint/i.test(finalUrl)) {
      console.warn('[socialPost] fb-html: sessão redirecionada para login/checkpoint');
      return null;
    }

    const escolha = escolherMensagemDoPost(html, finalUrl || url);
    const texto = escolha.texto;

    console.warn(
      `[socialPost] fb-html: candidatos=${escolha.candidatos} ancoras=${escolha.ancoras} escolha=${escolha.criterio} id=${escolha.idPost ? escolha.idPost.slice(0, 14) : 'n/d'}`
    );

    // Vários posts na página e nenhum identificador para desempatar: publicar o
    // texto errado é pior do que pedir a legenda ao editor.
    if (!texto && escolha.candidatos > 1) {
      console.warn('[socialPost] fb-html: ambíguo (várias mensagens sem âncora) — descartando');
      return null;
    }

    // A página autenticada não traz og:image confiável; a foto vem no JSON do
    // mesmo story. A seleção é ancorada na mensagem escolhida acima.
    const parsed = parseOgFromHtml(html, finalUrl || url);
    let imagem = escolherImagemDoPostFacebook(html, escolha);
    // og:image é usado apenas quando o HTML não contém diversos blocos de
    // mídia. Em páginas longas, ele pode ser uma recomendação e não a foto.
    if (!imagem && escolha.candidatos <= 1) imagem = parsed.imagem;

    console.warn(
      `[socialPost] fb-html: texto=${texto?.length || 0} imagem=${Boolean(imagem)} len=${html.length}`
    );

    const autor =
      html.match(/"actors"\s*:\s*\[\s*\{[^}]*?"name"\s*:\s*"((?:\\.|[^"\\])*)"/i)?.[1] || null;
    const veiculo = autor ? unescapeJsonString(autor) : parsed.veiculo;

    if (!texto && !imagem) return null;
    return {
      url,
      titulo: texto ? texto.slice(0, 140) : parsed.titulo,
      texto,
      imagem: imagem || null,
      veiculo,
      metodo: 'fb-html',
    };
  } catch (err) {
    console.warn('[socialPost] fb-html:', err.message);
    return null;
  }
}

function mesclarExtracao(melhor, extra) {
  if (!extra) return melhor;
  const out = { ...melhor };
  const confiancaTexto = (metodo) => {
    if (metodo === 'manual') return 4;
    if (
      ['scrapecreators', 'brightdata', 'apify-ig', 'ig-api', 'ig-cookie-html', 'ig-embed', 'ig-mirror', 'fb-html'].includes(metodo)
    ) {
      return 3;
    }
    if (metodo === 'og' || metodo === 'oembed' || metodo === 'yt-dlp') return 2;
    return 1;
  };
  const confiancaAtual = confiancaTexto(out.textoMetodo);
  const confiancaNova = confiancaTexto(extra.metodo);
  if (
    extra.texto &&
    (!out.texto ||
      confiancaNova > confiancaAtual ||
      (confiancaNova === confiancaAtual && extra.texto.length > out.texto.length))
  ) {
    out.texto = extra.texto;
    out.textoMetodo = extra.metodo || null;
  }
  if (!out.imagem && extra.imagem) out.imagem = extra.imagem;
  if (!out.titulo && extra.titulo) out.titulo = extra.titulo;
  if (!out.veiculo && extra.veiculo) out.veiculo = extra.veiculo;
  if (!out.videoUrl && extra.videoUrl) out.videoUrl = extra.videoUrl;
  if (!out.subtitleUrl && extra.subtitleUrl) out.subtitleUrl = extra.subtitleUrl;
  if (out.isVideo == null && extra.isVideo != null) out.isVideo = extra.isVideo;
  if (!out.publicadoEm && extra.publicadoEm) out.publicadoEm = extra.publicadoEm;
  if (!out.autorUrl && extra.autorUrl) out.autorUrl = extra.autorUrl;
  if (!out.postId && extra.postId) out.postId = extra.postId;
  if ((!out.comentarios || !out.comentarios.length) && extra.comentarios?.length) {
    out.comentarios = extra.comentarios;
  }
  if ((!out.conteudoVisual || !out.conteudoVisual.length) && extra.conteudoVisual?.length) {
    out.conteudoVisual = extra.conteudoVisual;
  }
  if (extra.url && !/\/login/i.test(extra.url)) out.url = extra.url;
  if (extra.metodo) {
    out.metodo = out.metodo ? `${out.metodo}+${extra.metodo}` : extra.metodo;
  }
  return out;
}

/**
 * Extrai texto + imagem de post Facebook / Instagram.
 * @param {string} url
 * @param {{ textoManual?: string, imagemManual?: string }} [opts]
 */
async function extrairPostSocial(url, opts = {}) {
  let link = normalizarUrlSocial(url);
  const plataforma = detectarPlataformaSocial(link);
  if (!plataforma) {
    const err = new Error('Link não é de Facebook ou Instagram');
    err.status = 400;
    throw err;
  }

  if (plataforma === 'facebook') {
    link = await resolverShareFacebook(link);
  }

  const textoManual = String(opts.textoManual || '').trim();
  const imagemManual = String(opts.imagemManual || '').trim();

  let melhor = {
    url: link,
    titulo: null,
    texto: null,
    imagem: null,
    veiculo: null,
    metodo: null,
    plataforma,
    isVideo: null,
    videoUrl: null,
    subtitleUrl: null,
    publicadoEm: null,
    autorUrl: null,
    postId: null,
    comentarios: [],
    conteudoVisual: [],
  };

  // Quando o editor cola a legenda, ela é a fonte mais confiável e dispensa
  // provedores externos. Isso também mantém o fluxo utilizável se o Instagram
  // bloquear o servidor ou se o serviço de scraping estiver indisponível.
  if (textoManual.length >= 40) {
    const primeiraFrase = textoManual
      .split(/(?<=[.!?])\s+/)
      .map((parte) => parte.trim())
      .find((parte) => parte.length >= 20);
    return {
      ...melhor,
      titulo: String(primeiraFrase || textoManual).slice(0, 140),
      texto: textoManual,
      textoMetodo: 'manual',
      imagem: /^https?:\/\//i.test(imagemManual) ? imagemManual : null,
      veiculo: plataforma === 'instagram' ? 'Instagram' : 'Facebook',
      metodo: 'manual',
      postId: plataforma === 'instagram' ? extrairShortcodeIg(link) : null,
    };
  }

  const shortcodeSolicitado = plataforma === 'instagram' ? extrairShortcodeIg(link) : null;
  const incorporar = (extra) => {
    if (!extra) return;
    if (shortcodeSolicitado) {
      const shortcodeRetornado = extra.postId || extrairShortcodeIg(extra.url);
      if (
        shortcodeRetornado &&
        shortcodeRetornado.toLowerCase() !== shortcodeSolicitado.toLowerCase()
      ) {
        console.warn(
          `[socialPost] descartou resposta de outro post solicitado=${shortcodeSolicitado} recebido=${shortcodeRetornado} metodo=${extra.metodo || '?'}`
        );
        return;
      }
    }
    melhor = mesclarExtracao(melhor, extra);
  };

  // Para Instagram público, tenta primeiro os mirrors de Open Graph. Além de
  // não consumirem créditos, eles devolvem legenda e imagem no mesmo acesso.
  if (plataforma === 'instagram') {
    incorporar(await extrairViaInstagramMirror(link));
  }

  // Facebook com sessão configurada: o HTML autenticado traz a legenda completa
  // sem consumir créditos de provedor. Tentamos antes dos serviços pagos.
  if (plataforma === 'facebook') {
    incorporar(await extrairViaFacebookHtml(link));
    if (!melhor.texto || !melhor.imagem) {
      incorporar(await extrairViaFacebookPagePlugin(link));
    }
  }

  // Provedor com proxy residencial. A coleta por URL evita os bloqueios de
  // datacenter do Instagram e retorna legenda e imagens do post exato.
  if (plataforma === 'instagram' && (!melhor.texto || !melhor.imagem)) {
    const brightdata = require('./brightdataInstagram');
    if (brightdata.isConfigured()) {
      try {
        incorporar(await brightdata.coletarPostPorUrl(link));
      } catch (err) {
        console.warn('[socialPost] brightdata:', err.message);
      }
    }
  }

  const scrapeCreators = require('./scrapeCreatorsSocial');
  let scrapeCreatorsFalhou = false;

  // 1) ScrapeCreators — provedor principal para posts individuais IG/FB.
  if (scrapeCreators.isConfigured() && (!melhor.texto || !melhor.imagem)) {
    try {
      incorporar(await scrapeCreators.extrairPost(link, plataforma));
    } catch (err) {
      scrapeCreatorsFalhou = true;
      console.warn('[socialPost] scrapecreators:', err.message);
    }
  }


  if (plataforma === 'instagram' && (!melhor.texto || !melhor.imagem)) {
    const apifyInstagram = require('./apifyInstagramPostService');
    if (apifyInstagram.isConfigured()) {
      try {
        incorporar(await apifyInstagram.extrairPost(link));
      } catch (err) {
        console.warn('[socialPost] apify-ig:', err.message);
      }
    }
  }

  // O extrator oEmbed já suporta os dois produtos da Meta. Tenta a API oficial
  // também no Instagram antes de depender do HTML público, que varia por região.
  if (plataforma === 'instagram' && (!melhor.texto || !melhor.imagem)) {
    incorporar(await extrairViaOembed(link));
  }

  // Legendas curtas vindas da API são confiáveis; nos demais métodos, texto curto pode ser ruído.
  const precisaTexto = () =>
    !melhor.texto ||
    (textoGenericoSocial(melhor.texto) &&
      !['scrapecreators', 'brightdata', 'apify-ig', 'manual', 'ig-api', 'ig-cookie-html', 'ig-embed', 'ig-mirror', 'fb-html'].includes(
        melhor.textoMetodo
      ));
  const igEhVideo = /instagram\.com\/(reel|reels|tv)\//i.test(link);

  // 2) Open Graph e métodos legados complementam somente campos ausentes/incompletos.
  if (precisaTexto() || !melhor.imagem) {
    try {
      incorporar(await extrairViaOg(link));
    } catch (err) {
      console.warn('[socialPost] og:', err.message);
    }
  }

  if (
    plataforma === 'instagram' &&
    (precisaTexto() || !melhor.imagem || (igEhVideo && !melhor.subtitleUrl))
  ) {
    incorporar(await extrairViaInstagramApi(link));
  }
  if (plataforma === 'instagram' && precisaTexto()) {
    incorporar(await extrairViaInstagramEmbed(link));
  }

  if (plataforma === 'facebook' && (precisaTexto() || !melhor.imagem)) {
    incorporar(await extrairViaOembed(link));
  }

  // O leitor genérico pode devolver conteúdo recomendado da página do Instagram
  // sem indicar o shortcode. Em posts do Instagram isso não é uma fonte segura.
  if (plataforma !== 'instagram' && (precisaTexto() || !melhor.imagem)) {
    try {
      incorporar(await extrairViaJina(link));
    } catch (err) {
      console.warn('[socialPost] jina:', err.message);
    }
  }

  if (plataforma === 'facebook' && (precisaTexto() || !melhor.imagem)) {
    incorporar(await extrairViaMbasic(link));
  }

  // A Biblioteca já usa Apify para posts públicos do Facebook. O chat de
  // matéria manual reaproveita o mesmo provedor quando ScrapeCreators/HTML
  // falham, inclusive para links /share/p/ resolvidos para permalink.php.
  if (plataforma === 'facebook' && (precisaTexto() || !melhor.imagem)) {
    const apifyFacebook = require('./apifyFacebookService');
    if (apifyFacebook.isConfigured()) {
      try {
        incorporar(await apifyFacebook.extrairPostPublicoPorUrl(link));
      } catch (err) {
        console.warn('[socialPost] apify-fb-post:', err.message);
      }
    }
  }

  // yt-dlp — Instagram /p/ (foto) costuma HTTP 400; só tenta reel/tv.
  if ((precisaTexto() || !melhor.imagem) && (plataforma !== 'instagram' || igEhVideo)) {
    incorporar(await extrairViaYtDlp(link));
  } else if (plataforma === 'instagram' && !igEhVideo && precisaTexto()) {
    console.warn('[socialPost] yt-dlp: pulado (post foto /p/ — use API ou cookies)');
  }

  // Override final: o que o usuário colou sempre prevalece sobre qualquer provedor.
  if (textoManual.length >= 40) {
    melhor.texto = textoManual;
    melhor.textoMetodo = 'manual';
    melhor.metodo = melhor.metodo ? `${melhor.metodo}+manual` : 'manual';
  }
  if (/^https?:\/\//i.test(imagemManual)) {
    melhor.imagem = imagemManual;
    if (!String(melhor.metodo || '').includes('manual')) {
      melhor.metodo = melhor.metodo ? `${melhor.metodo}+manual` : 'manual';
    }
  }

  if (precisaTexto()) {
    const { diagnoseInstagramCookies } = require('./instagramCookies');
    const igDiag = plataforma === 'instagram' ? diagnoseInstagramCookies() : null;
    let mensagem;
    if (plataforma === 'facebook') {
      const { diagnoseFacebookCookies } = require('./facebookCookies');
      const fbDiag = diagnoseFacebookCookies();
      mensagem = fbDiag.ok
        ? 'A sessão do Facebook não conseguiu ler este post (pode estar privado, restrito ou a sessão caiu). Revalide com: node scripts/test-fb-cookies.js. Enquanto isso, cole a legenda em “Texto da postagem”.'
        : `Este post exige login e não há sessão do Facebook configurada (${fbDiag.reason}). Exporte os cookies Netscape do Facebook para YTDLP_FB_COOKIES_FILE — isso destrava a leitura sem depender de créditos. Enquanto isso, cole a legenda em “Texto da postagem”.`;
    } else if (scrapeCreators.isConfigured()) {
      mensagem =
        'Não foi possível obter a legenda deste post pelo provedor automático nem pelos métodos alternativos. O post pode estar privado, restrito ou indisponível. Cole a legenda em “Texto da postagem”.';
    } else {
      mensagem = igDiag?.ok
        ? 'O Instagram bloqueou a leitura automática (sessão expirada, checkpoint ou post restrito). Atualize os cookies em YTDLP_IG_COOKIES_FILE ou cole a legenda em “Texto da postagem”.'
        : `Cookies do Instagram inválidos (${igDiag?.reason || 'ausentes'}). Exporte de novo para /home/viralizeai/secrets/instagram-cookies.txt ou cole a legenda em “Texto da postagem”.`;
    }
    const err = new Error(mensagem);
    err.status = 422;
    err.code = 'SOCIAL_EXTRACT_BLOCKED';
    err.providerFailed = scrapeCreatorsFalhou;
    throw err;
  }

  // Preferir manchete a partir do texto (og:title costuma ser só o nome da Página).
  const firstSentence = String(melhor.texto || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .find((s) => s.length >= 28);
  if (
    firstSentence &&
    (!melhor.titulo ||
      melhor.titulo === melhor.veiculo ||
      melhor.titulo.length < 24 ||
      /^(facebook|instagram)$/i.test(melhor.titulo))
  ) {
    melhor.titulo = firstSentence.slice(0, 140);
  }
  if (!melhor.titulo || /^(facebook|instagram)$/i.test(melhor.titulo)) {
    melhor.titulo = firstSentence
      ? firstSentence.slice(0, 140)
      : String(melhor.texto).slice(0, 120);
  }

  return melhor;
}

/**
 * Converte extração social em formato apurarTopico.
 */
function socialParaTopico(extraido, linkOriginal) {
  const trecho = extraido.texto || '';
  const resumo = trecho.slice(0, 400);
  return {
    link: extraido.url || linkOriginal,
    linkOriginal,
    titulo: extraido.titulo,
    resumo,
    imagemFonte: extraido.imagem || null,
    veiculo: extraido.veiculo || extraido.plataforma || null,
    fonte: extraido.veiculo || extraido.plataforma || null,
    redeSocial: true,
    tipoFonte: 'rede_social',
    contextoApuracao: [
      `Assunto: ${extraido.titulo || ''}`,
      extraido.veiculo ? `Página/perfil: ${extraido.veiculo}` : null,
      `Plataforma: ${extraido.plataforma}`,
      `URL: ${extraido.url || linkOriginal}`,
      extraido.imagem ? `Imagem do post: ${extraido.imagem}` : null,
      trecho ? `Texto original do post (legenda):\n${trecho.slice(0, 3500)}` : null,
    ]
      .filter(Boolean)
      .join('\n\n'),
    fontesApuracao: [
      {
        veiculo: extraido.veiculo || extraido.plataforma || 'Rede social',
        url: extraido.url || linkOriginal,
        titulo: extraido.titulo,
        resumo,
        trecho,
        ehRedeSocial: true,
      },
    ],
    dataReferencia: null,
  };
}

module.exports = {
  detectarPlataformaSocial,
  isSocialPostUrl,
  isSocialVideoUrl,
  normalizarUrlSocial,
  resolverShareFacebook,
  extrairPostSocial,
  socialParaTopico,
  escolherMensagemDoPost,
  escolherImagemDoPostFacebook,
};
