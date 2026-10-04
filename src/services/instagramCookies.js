const fs = require('fs');
const os = require('os');
const path = require('path');
const { env } = require('../config/env');

const IG_APP_ID = '936619743392459';
const DEFAULT_IG_COOKIES = '/home/viralizeai/secrets/instagram-cookies.txt';

function resolveIgCookiesPath() {
  const configured = String(env.ytDlp?.igCookiesFile || '').trim();
  if (configured) return configured;
  if (fs.existsSync(DEFAULT_IG_COOKIES)) return DEFAULT_IG_COOKIES;
  // Salvo pela tela /cookies: evita depender de variável no .env e de subir
  // arquivo no servidor cada vez que a sessão expira.
  return require('./cookieStore').caminhoSalvoPelaTela('instagram');
}

/**
 * Parseia linha Netscape (tabs) ou fallback com espaços (File Manager às vezes troca tab).
 */
function parseNetscapeLine(line) {
  if (!line) return null;
  // No formato Netscape, #HttpOnly_ identifica um cookie real; não é comentário.
  const normalizedLine = line.startsWith('#HttpOnly_')
    ? line.slice('#HttpOnly_'.length)
    : line;
  if (normalizedLine.startsWith('#')) return null;
  let cols;
  if (normalizedLine.includes('\t')) {
    cols = normalizedLine.split('\t');
  } else {
    // domain flag path secure expiry name value...
    const m = normalizedLine.match(
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
  if (!/instagram\.com/i.test(domain) && domain !== '.instagram.com') return null;
  return { domain, name, value, expiresAt };
}

/**
 * @returns {{ file: string, cookies: Record<string, string>, names: string[] } | null}
 */
function loadInstagramCookies() {
  const file = resolveIgCookiesPath();
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
  if (!cookies.sessionid) return null;
  const sessionExpiresAt = Number(expires.sessionid || 0);
  const sessionExpired = sessionExpiresAt > 0 && sessionExpiresAt <= Math.floor(Date.now() / 1000);
  return { file, cookies, expires, names: Object.keys(cookies), sessionExpiresAt, sessionExpired };
}

function diagnoseInstagramCookies() {
  const file = resolveIgCookiesPath();
  if (!file) {
    return { ok: false, reason: 'YTDLP_IG_COOKIES_FILE não configurado' };
  }
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `arquivo não existe: ${file}`, file };
  }
  const stat = fs.statSync(file);
  const text = fs.readFileSync(file, 'utf8');
  const hasTabs = text.includes('\t');
  const hasSession = /(?:^|\t|\s)sessionid(?:\t|\s)/m.test(text);
  const loaded = loadInstagramCookies();
  return {
    ok: Boolean(loaded?.cookies?.sessionid) && !loaded?.sessionExpired,
    file,
    size: stat.size,
    hasTabs,
    hasSessionLine: hasSession,
    parsedNames: loaded?.names || [],
    sessionExpiresAt: loaded?.sessionExpiresAt || null,
    sessionExpired: Boolean(loaded?.sessionExpired),
    reason: loaded?.sessionExpired
      ? 'sessionid expirado no arquivo'
      : loaded?.cookies?.sessionid
        ? 'formato válido (autenticação ainda não testada)'
        : hasSession
          ? 'sessionid na linha mas parse falhou (formato?)'
          : 'sessionid ausente no arquivo',
  };
}

function buildInstagramCookieHeader(cookiesMap = null) {
  const source = cookiesMap ? { cookies: cookiesMap, sessionExpired: false } : loadInstagramCookies();
  if (!source?.cookies || source.sessionExpired) return null;
  const loaded = source.cookies;
  const wanted = ['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'datr', 'rur'];
  const parts = [];
  for (const name of wanted) {
    if (loaded[name]) parts.push(`${name}=${loaded[name]}`);
  }
  for (const [name, value] of Object.entries(loaded)) {
    if (wanted.includes(name)) continue;
    if (/^(ps_l|ps_n|oo|ig_nrcb|wd)$/i.test(name)) parts.push(`${name}=${value}`);
  }
  return parts.length ? parts.join('; ') : null;
}

function resolveCleanInstagramCookiesFile() {
  const loaded = loadInstagramCookies();
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

  const out = path.join(os.tmpdir(), `viralizeai-ig-cookies-${process.pid}.txt`);
  fs.writeFileSync(out, `${lines.join('\n')}\n`, { mode: 0o600 });
  return out;
}

function shortcodeToMediaId(shortcode) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = 0n;
  for (const char of String(shortcode || '')) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) return null;
    id = id * 64n + BigInt(idx);
  }
  return id.toString();
}

/**
 * Cabeçalho do app Android com a mesma sessão do navegador faz o Instagram ver
 * a conta em dois "aparelhos" ao mesmo tempo e bloquear ("várias sessões").
 * Só liga com INSTAGRAM_API_MOBILE=1.
 */
function instagramMobileLiberado() {
  return ['1', 'true', 'sim', 'on'].includes(String(process.env.INSTAGRAM_API_MOBILE || '').toLowerCase());
}

function instagramApiHeaders(cookieHeader, { mobile = false, wwwClaim = '0' } = {}) {
  if (mobile && !instagramMobileLiberado()) mobile = false;
  const csrf = loadInstagramCookies()?.cookies?.csrftoken || '';
  const ua = mobile
    ? 'Instagram 192.168.2.4.117 Android (33/13; 420dpi; 1080x2400; Xiaomi; M2101K6G; sweet; qcom; pt_BR; 458229257)'
    : (process.env.SOCIAL_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  return {
    'User-Agent': ua,
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'X-IG-App-ID': IG_APP_ID,
    'X-ASBD-ID': '129477',
    'X-IG-WWW-Claim': wwwClaim || '0',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://www.instagram.com/',
    Origin: 'https://www.instagram.com',
    Cookie: cookieHeader,
    ...(csrf ? { 'X-CSRFToken': csrf } : {}),
  };
}

/**
 * Visita a home com cookies e captura x-ig-set-www-claim
 * (sem o claim, a API media info costuma responder 400).
 * @returns {Promise<{ claim: string, cookieHeader: string }|null>}
 */
async function bootstrapInstagramSession(axiosClient) {
  const cookieHeader = buildInstagramCookieHeader();
  if (!cookieHeader || !axiosClient) return null;
  try {
    const res = await axiosClient.get('https://www.instagram.com/', {
      timeout: 20000,
      maxRedirects: 5,
      headers: {
        'User-Agent':
          (process.env.SOCIAL_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        Cookie: cookieHeader,
      },
      validateStatus: (s) => s >= 200 && s < 500,
    });
    const h = res.headers || {};
    const claim =
      h['x-ig-set-www-claim'] ||
      h['ig-set-www-claim'] ||
      h['X-IG-Set-WWW-Claim'] ||
      null;
    // Set-Cookie extras do response
    let merged = cookieHeader;
    const setCookie = h['set-cookie'];
    if (Array.isArray(setCookie) && setCookie.length) {
      const extras = [];
      for (const raw of setCookie) {
        const pair = String(raw).split(';')[0];
        if (pair && pair.includes('=')) extras.push(pair);
      }
      if (extras.length) merged = `${cookieHeader}; ${extras.join('; ')}`;
    }
    return {
      claim: claim && claim !== '0' ? String(claim) : '0',
      cookieHeader: merged,
      homeStatus: res.status,
      homeLen: String(res.data || '').length,
    };
  } catch (err) {
    return { claim: '0', cookieHeader, error: err.message };
  }
}

/**
 * Por que a sessão não serviu, em uma frase que diga o que fazer.
 *
 * A checagem antiga procurava a palavra solta 'challenge' em ate 200 KB do
 * corpo da resposta. Qualquer ocorrencia casava — nome de bundle, flag de
 * feature, legenda de post em ingles — e uma sessao boa era reportada como
 * 'checkpoint exigido'. Aqui so marcadores inequivocos contam.
 */
function instagramFailureReason(data, status) {
  const message = String(
    data?.message || data?.error_title || data?.error_type || data?.status || ''
  )
    .replace(/\s+/g, ' ')
    .slice(0, 160);

  let raw = '';
  try {
    raw = typeof data === 'string' ? data : JSON.stringify(data || '');
  } catch {
    raw = '';
  }
  const normalized = `${message} ${raw.slice(0, 200000)}`.toLowerCase();

  // Marcadores que o Instagram usa de verdade para pedir verificacao.
  const pedeVerificacao =
    normalized.includes('challenge_required') ||
    normalized.includes('checkpoint_required') ||
    normalized.includes('"challenge_url"') ||
    normalized.includes('/challenge/') ||
    Boolean(data?.challenge);
  if (pedeVerificacao) {
    return 'a conta precisa passar pela verificacao de seguranca do Instagram';
  }

  if (
    normalized.includes('login_required') ||
    normalized.includes('/accounts/login') ||
    normalized.includes('not logged in')
  ) {
    return 'login_required';
  }

  if (status === 429) return 'limite de requisicoes (HTTP 429)';
  if (message) return `${message} (HTTP ${status})`;

  // Pagina HTML no lugar do JSON: quase sempre e a tela de login.
  if (status >= 200 && status < 300 && typeof data === 'string') {
    return 'o Instagram devolveu HTML em vez de dados da sessao (provavel tela de login)';
  }

  // 2xx com JSON valido e sem o perfil procurado: a sessao respondeu, mas a
  // busca nao trouxe o resultado esperado. Mostrar a forma da resposta ajuda a
  // distinguir bloqueio de mudanca de formato da API, sem expor valor nenhum.
  if (status >= 200 && status < 300) {
    const campos = data && typeof data === 'object' ? Object.keys(data).slice(0, 8) : [];
    return campos.length
      ? `o Instagram respondeu sem o perfil procurado (HTTP ${status}; campos: ${campos.join(', ')})`
      : `o Instagram respondeu vazio (HTTP ${status})`;
  }

  return `HTTP ${status}`;
}

/** Testa a sessão remotamente sem retornar usuário, IDs ou valores de cookies. */
async function validateInstagramSession(axiosClient, bootstrap = null) {
  const loaded = loadInstagramCookies();
  if (!loaded?.cookies?.sessionid) {
    return { ok: false, status: null, reason: 'sessionid ausente' };
  }
  if (loaded.sessionExpired) {
    return { ok: false, status: null, reason: 'sessionid expirado no arquivo' };
  }
  if (!axiosClient) return { ok: false, status: null, reason: 'cliente HTTP ausente' };

  const boot = bootstrap || (await bootstrapInstagramSession(axiosClient));
  const cookieHeader = boot?.cookieHeader || buildInstagramCookieHeader();
  const webHeaders = instagramApiHeaders(cookieHeader, {
    mobile: false,
    wwwClaim: boot?.claim || '0',
  });
  const mobileHeaders = instagramApiHeaders(cookieHeader, {
    mobile: true,
    wwwClaim: boot?.claim || '0',
  });

  try {
    let userId = null;
    const search = await axiosClient.get('https://www.instagram.com/web/search/topsearch/', {
      params: { query: 'instagram' },
      headers: webHeaders,
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (search.status >= 200 && search.status < 300) {
      const users = (Array.isArray(search.data?.users) ? search.data.users : []).map(
        (entry) => entry?.user || entry
      );
      const account = users.find(
        (item) => String(item?.username || '').toLowerCase() === 'instagram'
      );
      userId = account?.pk || account?.id || null;
    }
    let lastSearch = search;
    if (!userId && instagramMobileLiberado()) {
      const mobileSearch = await axiosClient.get(
        'https://i.instagram.com/api/v1/users/search/',
        {
          params: { q: 'instagram', count: 5 },
          headers: mobileHeaders,
          timeout: 20000,
          maxRedirects: 5,
          validateStatus: () => true,
        }
      );
      lastSearch = mobileSearch;
      if (mobileSearch.status >= 200 && mobileSearch.status < 300) {
        const users = Array.isArray(mobileSearch.data?.users) ? mobileSearch.data.users : [];
        const account = users.find(
          (item) => String(item?.username || '').toLowerCase() === 'instagram'
        );
        userId = account?.pk || account?.id || null;
      }
    }
    if (!userId) {
      return {
        ok: false,
        status: lastSearch.status,
        reason: instagramFailureReason(lastSearch.data, lastSearch.status),
        homeStatus: boot?.homeStatus || null,
        hasClaim: Boolean(boot?.claim && boot.claim !== '0'),
      };
    }

    // Sem o modo app, o feed é lido pelo mesmo host web do navegador.
    const hostFeed = instagramMobileLiberado() ? 'i.instagram.com' : 'www.instagram.com';
    const feed = await axiosClient.get(
      `https://${hostFeed}/api/v1/feed/user/${encodeURIComponent(String(userId))}/`,
      {
        params: { count: 1 },
        headers: instagramMobileLiberado() ? mobileHeaders : webHeaders,
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true,
      }
    );
    const ok =
      feed.status >= 200 &&
      feed.status < 300 &&
      Array.isArray(feed.data?.items) &&
      feed.data.items.length > 0;
    return {
      ok,
      status: feed.status,
      reason: ok ? 'sessão utilizável para feeds' : instagramFailureReason(feed.data, feed.status),
      homeStatus: boot?.homeStatus || null,
      hasClaim: Boolean(boot?.claim && boot.claim !== '0'),
    };
  } catch (err) {
    return {
      ok: false,
      status: err.response?.status || null,
      reason: err.response
        ? instagramFailureReason(err.response.data, err.response.status || 0)
        : String(err.message || 'falha de rede').slice(0, 160),
      homeStatus: boot?.homeStatus || null,
      hasClaim: Boolean(boot?.claim && boot.claim !== '0'),
    };
  }
}

module.exports = {
  IG_APP_ID,
  DEFAULT_IG_COOKIES,
  resolveIgCookiesPath,
  loadInstagramCookies,
  diagnoseInstagramCookies,
  buildInstagramCookieHeader,
  resolveCleanInstagramCookiesFile,
  shortcodeToMediaId,
  instagramApiHeaders,
  instagramMobileLiberado,
  bootstrapInstagramSession,
  instagramFailureReason,
  validateInstagramSession,
  parseNetscapeLine,
};
