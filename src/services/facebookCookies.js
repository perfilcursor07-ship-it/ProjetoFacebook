const fs = require('fs');
const os = require('os');
const path = require('path');
const { env } = require('../config/env');

const DEFAULT_FB_COOKIES = '/home/viralizeai/secrets/facebook-cookies.txt';

/** Cookies que identificam uma sessão logada do Facebook. */
const REQUIRED_COOKIES = ['c_user', 'xs'];

function resolveFbCookiesPath() {
  const configured = String(env.ytDlp?.fbCookiesFile || '').trim();
  if (configured) return configured;
  if (fs.existsSync(DEFAULT_FB_COOKIES)) return DEFAULT_FB_COOKIES;
  // Salvo pela tela /cookies (ver instagramCookies para o mesmo motivo).
  return require('./cookieStore').caminhoSalvoPelaTela('facebook');
}

/**
 * Parseia linha Netscape (tabs) ou fallback com espaços (File Manager às vezes troca tab).
 */
function parseNetscapeLine(line) {
  if (!line || line.startsWith('#')) return null;
  let cols;
  if (line.includes('\t')) {
    cols = line.split('\t');
  } else {
    // domain flag path secure expiry name value...
    const m = line.match(
      /^(\S+)\s+(TRUE|FALSE)\s+(\S+)\s+(TRUE|FALSE)\s+(\d+)\s+(\S+)\s+(.+)$/i
    );
    if (!m) return null;
    cols = [m[1], m[2], m[3], m[4], m[5], m[6], m[7]];
  }
  if (cols.length < 7) return null;
  const domain = cols[0];
  const expiresAt = Number(cols[4]) || 0;
  const name = cols[5];
  let value = cols.slice(6).join('\t').trim();
  value = value.replace(/^"|"$/g, '').replace(/\\054/g, ',');
  if (!name || !value) return null;
  if (!/facebook\.com$/i.test(String(domain).replace(/^\./, ''))) return null;
  return { domain, name, value, expiresAt };
}

/**
 * @returns {{ file: string, cookies: Record<string, string>, names: string[] } | null}
 */
function loadFacebookCookies() {
  const file = resolveFbCookiesPath();
  if (!file) return null;
  if (!fs.existsSync(file)) return null;

  const text = fs.readFileSync(file, 'utf8');
  const cookies = {};
  const expires = {};
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseNetscapeLine(line);
    if (!parsed) continue;
    cookies[parsed.name] = parsed.value;
    expires[parsed.name] = parsed.expiresAt;
  }
  if (!REQUIRED_COOKIES.every((name) => cookies[name])) return null;
  const sessionExpiresAt = Number(expires.xs || 0);
  const sessionExpired = sessionExpiresAt > 0 && sessionExpiresAt <= Math.floor(Date.now() / 1000);
  return { file, cookies, expires, names: Object.keys(cookies), sessionExpiresAt, sessionExpired };
}

function diagnoseFacebookCookies() {
  const file = resolveFbCookiesPath();
  if (!file) {
    return { ok: false, reason: 'YTDLP_FB_COOKIES_FILE não configurado' };
  }
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `arquivo não existe: ${file}`, file };
  }
  const stat = fs.statSync(file);
  const text = fs.readFileSync(file, 'utf8');
  const hasTabs = text.includes('\t');
  const hasSessionLine = /(?:^|\t|\s)xs(?:\t|\s)/m.test(text);
  const loaded = loadFacebookCookies();
  const faltando = REQUIRED_COOKIES.filter((name) => !loaded?.cookies?.[name]);
  return {
    ok: Boolean(loaded) && !loaded.sessionExpired,
    file,
    size: stat.size,
    hasTabs,
    hasSessionLine,
    parsedNames: loaded?.names || [],
    sessionExpiresAt: loaded?.sessionExpiresAt || null,
    sessionExpired: Boolean(loaded?.sessionExpired),
    reason: loaded?.sessionExpired
      ? 'cookie xs expirado no arquivo'
      : loaded
        ? 'formato válido (autenticação ainda não testada)'
        : hasSessionLine
          ? 'xs na linha mas parse falhou (formato?)'
          : `cookies ausentes: ${faltando.join(', ') || 'c_user, xs'}`,
  };
}

function buildFacebookCookieHeader(cookiesMap = null) {
  const source = cookiesMap ? { cookies: cookiesMap, sessionExpired: false } : loadFacebookCookies();
  if (!source?.cookies || source.sessionExpired) return null;
  const loaded = source.cookies;
  const wanted = ['c_user', 'xs', 'datr', 'sb', 'fr', 'locale', 'wd', 'dpr', 'presence'];
  const parts = [];
  for (const name of wanted) {
    if (loaded[name]) parts.push(`${name}=${loaded[name]}`);
  }
  return parts.length ? parts.join('; ') : null;
}

function resolveCleanFacebookCookiesFile() {
  const loaded = loadFacebookCookies();
  if (!loaded || loaded.sessionExpired) return null;

  const raw = fs.readFileSync(loaded.file, 'utf8');
  const needsClean = /"[^\t\n]*"|\\054/.test(raw) || !raw.includes('\t');

  const lines = ['# Netscape HTTP Cookie File', '# sanitized for yt-dlp (ViralizeAI)'];
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseNetscapeLine(line);
    if (!parsed) continue;
    // Netscape: domain, includeSubdomains, path, secure, expiry, name, value
    lines.push(
      [parsed.domain, 'TRUE', '/', 'TRUE', '0', parsed.name, parsed.value].join('\t')
    );
  }
  if (lines.length < 3) return null;

  if (!needsClean && raw.includes('\t')) return loaded.file;

  const out = path.join(os.tmpdir(), `viralizeai-fb-cookies-${process.pid}.txt`);
  fs.writeFileSync(out, `${lines.join('\n')}\n`, { mode: 0o600 });
  return out;
}

/** Headers de navegador logado para HTML do Facebook. */
function facebookHtmlHeaders(cookieHeader, userAgent) {
  return {
    'User-Agent':
      userAgent ||
      (process.env.SOCIAL_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
}

/**
 * Testa a sessão remotamente sem retornar usuário, IDs ou valores de cookies.
 * O Facebook redireciona sessões inválidas para /login/.
 */
async function validateFacebookSession(axiosClient) {
  const loaded = loadFacebookCookies();
  if (!loaded) {
    return { ok: false, status: null, reason: 'c_user/xs ausentes' };
  }
  if (loaded.sessionExpired) {
    return { ok: false, status: null, reason: 'cookie xs expirado no arquivo' };
  }
  if (!axiosClient) return { ok: false, status: null, reason: 'cliente HTTP ausente' };

  const cookieHeader = buildFacebookCookieHeader();
  try {
    const res = await axiosClient.get('https://www.facebook.com/me', {
      headers: facebookHtmlHeaders(cookieHeader),
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const finalUrl = String(
      res.request?.res?.responseURL || res.request?.res?.responseUrl || ''
    );
    const html = String(res.data || '');
    if (/\/login|\/checkpoint/i.test(finalUrl)) {
      return {
        ok: false,
        status: res.status,
        reason: /checkpoint/i.test(finalUrl) ? 'checkpoint exigido' : 'login_required',
      };
    }
    if (res.status >= 400) {
      return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    }
    // Página autenticada traz o id do usuário logado no bootstrap do JS.
    const autenticado =
      html.includes(`"USER_ID":"${loaded.cookies.c_user}"`) ||
      html.includes(`"actorID":"${loaded.cookies.c_user}"`);
    return {
      ok: autenticado,
      status: res.status,
      reason: autenticado ? 'sessão utilizável' : 'resposta sem sessão logada (possível challenge)',
    };
  } catch (err) {
    return {
      ok: false,
      status: err.response?.status || null,
      reason: String(err.message || 'falha de rede').slice(0, 160),
    };
  }
}

module.exports = {
  DEFAULT_FB_COOKIES,
  resolveFbCookiesPath,
  loadFacebookCookies,
  diagnoseFacebookCookies,
  buildFacebookCookieHeader,
  resolveCleanFacebookCookiesFile,
  facebookHtmlHeaders,
  validateFacebookSession,
};
