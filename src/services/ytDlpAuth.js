const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const ALLOWED_BROWSERS = new Set(['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi']);

function isInside(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function configError(message) {
  const error = new Error(message);
  error.status = 503;
  return error;
}

function resolveNodeBinary() {
  const configured = String(env.ytDlp.jsRuntimePath || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  // process.execPath = node que está rodando o app (NVM do usuário do site).
  return process.execPath || 'node';
}

function validateCookiesFile(configuredFile, label = 'YouTube') {
  if (!configuredFile) return null;
  if (!path.isAbsolute(configuredFile)) {
    throw configError(`${label}: o caminho do arquivo de cookies deve ser absoluto.`);
  }
  let realPath;
  try {
    realPath = fs.realpathSync(configuredFile);
  } catch {
    throw configError(`Arquivo de autenticação do ${label} não encontrado.`);
  }
  const stat = fs.statSync(realPath);
  const publicRoot = path.resolve(__dirname, '../../public');
  const storageRoot = path.resolve(env.storagePath);
  if (
    !stat.isFile() ||
    stat.size < 1 ||
    stat.size > 5 * 1024 * 1024 ||
    path.extname(realPath).toLowerCase() !== '.txt'
  ) {
    throw configError(`Arquivo de autenticação do ${label} inválido.`);
  }
  if (isInside(publicRoot, realPath) || isInside(storageRoot, realPath)) {
    throw configError(`O arquivo de cookies do ${label} deve ficar fora das pastas public e storage.`);
  }
  return realPath;
}

/**
 * @param {{ platform?: string, noCookies?: boolean, cookiesFile?: string }} [opts]
 */
function getYtDlpAuthFlags(opts = {}) {
  if (opts.noCookies) return {};

  const platform = String(opts.platform || 'youtube').toLowerCase();

  const rotulos = { instagram: 'Instagram', facebook: 'Facebook' };

  // Cookies explícitos na chamada
  if (opts.cookiesFile) {
    const real = validateCookiesFile(opts.cookiesFile, rotulos[platform] || 'YouTube');
    return real ? { cookies: real } : {};
  }

  // Facebook: arquivo próprio; sem ele o yt-dlp cai em "only available for
  // registered users" nos posts que exigem login.
  if (platform === 'facebook') {
    const { resolveFbCookiesPath, resolveCleanFacebookCookiesFile } = require('./facebookCookies');
    const fbFile = resolveFbCookiesPath();
    if (!fbFile) return {};
    validateCookiesFile(fbFile, 'Facebook');
    const cleaned = resolveCleanFacebookCookiesFile();
    return cleaned ? { cookies: cleaned } : {};
  }

  // Instagram: usa arquivo próprio (não misturar com cookies do YouTube)
  if (platform === 'instagram') {
    const { resolveIgCookiesPath, resolveCleanInstagramCookiesFile } = require('./instagramCookies');
    const igFile = resolveIgCookiesPath();
    if (!igFile) return {};
    // Valida caminho configurado (segurança); depois sanitiza aspas/\054 p/ yt-dlp
    validateCookiesFile(igFile, 'Instagram');
    const cleaned = resolveCleanInstagramCookiesFile();
    return cleaned ? { cookies: cleaned } : {};
  }

  const configuredFile = String(env.ytDlp.cookiesFile || '').trim();
  if (configuredFile) {
    const real = validateCookiesFile(configuredFile, 'YouTube');
    return real ? { cookies: real } : {};
  }

  // Salvo pela tela /cookies: o editor renova a sessão sem SSH no servidor.
  const daTela = require('./cookieStore').caminhoSalvoPelaTela('youtube');
  if (daTela) {
    const real = validateCookiesFile(daTela, 'YouTube');
    return real ? { cookies: real } : {};
  }

  const browser = String(env.ytDlp.cookiesFromBrowser || '').trim().toLowerCase();
  if (!browser) return {};
  if (env.nodeEnv === 'production') {
    throw configError('Cookies do navegador não são permitidos em produção; configure YTDLP_COOKIES_FILE.');
  }
  if (!ALLOWED_BROWSERS.has(browser)) {
    throw configError('Navegador inválido em YTDLP_COOKIES_FROM_BROWSER.');
  }
  return { cookiesFromBrowser: browser };
}

/**
 * Flags comuns para YouTube em 2026.
 * Deno é o default do yt-dlp; em produção costuma faltar — habilitamos Node.
 * @see https://github.com/yt-dlp/yt-dlp/wiki/EJS
 */
function getYtDlpBaseFlags() {
  const nodePath = resolveNodeBinary();
  const jsRuntime = String(env.ytDlp.jsRuntime || `node:${nodePath}`).trim();

  return {
    noJsRuntimes: true,
    jsRuntimes: jsRuntime,
    retries: 3,
    socketTimeout: 30,
  };
}

function detectPlatformFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook';
  return 'youtube';
}

/**
 * @param {Function} executable
 * @param {string} url
 * @param {object} [flags]
 * @param {{ platform?: string, noCookies?: boolean, cookiesFile?: string, timeoutMs?: number }} [authOpts]
 */
function runYtDlp(executable, url, flags = {}, authOpts = {}) {
  const platform = authOpts.platform || detectPlatformFromUrl(url);
  const auth = getYtDlpAuthFlags({ ...authOpts, platform });
  const base = getYtDlpBaseFlags();
  const merged = { ...base, ...auth, ...flags };
  // Sem limite de tempo, um yt-dlp preso (rede, desafio JS, CDN lento) segura a
  // requisição do chat indefinidamente. SIGKILL porque SIGTERM às vezes não pega.
  const timeoutMs = Number(authOpts.timeoutMs) || 0;
  const spawnOpts = timeoutMs > 0 ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {};

  // Chamada pediu cookies: false / null → remove
  if (flags.cookies === false || flags.cookies === null) {
    delete merged.cookies;
    delete merged.cookiesFromBrowser;
  }

  if (flags.jsRuntimes && !Object.prototype.hasOwnProperty.call(flags, 'noJsRuntimes')) {
    delete merged.noJsRuntimes;
  }

  // YouTube: uma chamada por vez, com intervalo, e nada enquanto durar a
  // pausa por bloqueio (ver youtubeLimiter).
  // `platform` cai em "youtube" para qualquer link desconhecido; vale o endereço.
  const youtube = /youtube\.com|youtu\.be|^ytsearch/i.test(String(url || '')) ? require('./youtubeLimiter') : null;
  const executar = youtube
    ? youtube.esperarVez().then(() => executable(url, merged, spawnOpts)).then((resultado) => {
        youtube.registrarSucesso();
        return resultado;
      })
    : executable(url, merged, spawnOpts);

  return executar.catch((error) => {
    if (error?.code === 'YOUTUBE_EM_PAUSA') throw error;
    if (youtube) youtube.registrarFalha(error);
    const raw = String(error?.stderr || error?.message || '').toLowerCase();
    const temCookies = Object.keys(auth).length > 0;

    // Morto pelo timeout do spawn: a mensagem crua do tinyspawn não diz isso.
    if (timeoutMs > 0 && (error?.signalCode === 'SIGKILL' || error?.killed === true)) {
      const message = `yt-dlp passou de ${Math.round(timeoutMs / 1000)}s e foi encerrado.`;
      error.message = message;
      error.stderr = message;
      error.timedOut = true;
      throw error;
    }
    const mensagensAuth = {
      instagram: {
        expirada: 'A sessão do Instagram expirou. Atualize YTDLP_IG_COOKIES_FILE e tente novamente.',
        ausente:
          'O Instagram pediu autenticação. Configure YTDLP_IG_COOKIES_FILE (cookies Netscape do Instagram).',
      },
      facebook: {
        expirada: 'A sessão do Facebook expirou. Atualize YTDLP_FB_COOKIES_FILE e tente novamente.',
        ausente:
          'O Facebook pediu autenticação. Configure YTDLP_FB_COOKIES_FILE (cookies Netscape do Facebook).',
      },
      youtube: {
        // "Confirm you're not a bot" com cookies: sessão vencida OU IP do
        // servidor marcado pelo YouTube. Só a mensagem não distingue os dois.
        expirada:
          'O YouTube recusou a leitura mesmo com os cookies (verificação anti-bot): a sessão venceu ou o IP do servidor está bloqueado. Teste em /cookies.',
        ausente:
          'O YouTube solicitou autenticação. Configure YTDLP_COOKIES_FROM_BROWSER no ambiente local ou YTDLP_COOKIES_FILE no servidor.',
      },
    };
    // "registered users" é a forma que o Facebook usa para exigir login.
    if (
      raw.includes('sign in') ||
      raw.includes('not a bot') ||
      raw.includes('confirm you') ||
      raw.includes('login required') ||
      raw.includes('registered users')
    ) {
      const textos = mensagensAuth[platform] || mensagensAuth.youtube;
      const message = temCookies ? textos.expirada : textos.ausente;
      error.message = message;
      error.stderr = message;
    } else if (raw.includes('n challenge') || raw.includes('javascript runtime') || raw.includes('js runtime')) {
      const message =
        'YouTube bloqueou o download (desafio JS). Confirme yt-dlp do sistema e --js-runtimes node.';
      error.message = message;
      error.stderr = message;
    }
    throw error;
  });
}

module.exports = {
  getYtDlpAuthFlags,
  getYtDlpBaseFlags,
  resolveNodeBinary,
  runYtDlp,
  detectPlatformFromUrl,
};
