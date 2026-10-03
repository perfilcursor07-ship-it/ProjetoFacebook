/**
 * Armazém dos cookies de sessão (YouTube, Instagram, Facebook).
 *
 * Antes, cada plataforma exigia subir um arquivo .txt para uma pasta do
 * servidor e apontar uma variável no .env. Quando a sessão expirava — o que
 * acontece toda semana — era preciso SSH ou File Manager de novo.
 *
 * Aqui o conteúdo chega pela tela (upload ou colado) e é gravado no lugar que
 * o resto do sistema já lê:
 *   1. a variável do .env, quando existe (servidor antigo continua igual);
 *   2. senão, `secrets/<plataforma>-cookies.txt` na raiz do projeto.
 *
 * A pasta `secrets/` já está no .gitignore e fica fora de public/ e storage/,
 * como o validador do yt-dlp exige. Diretório 0700, arquivos 0600.
 */
const fs = require('fs');
const path = require('path');

const RAIZ_SECRETS = path.resolve(__dirname, '../../secrets');

/**
 * `dominios`: só as linhas desses domínios são guardadas — o editor pode colar
 * o export inteiro do navegador sem vazar cookie de outro site.
 * `autenticacao`: sem pelo menos um destes, o arquivo não tem sessão logada e
 * salvar só criaria um problema silencioso mais tarde.
 */
const PLATAFORMAS = Object.freeze({
  youtube: Object.freeze({
    rotulo: 'YouTube',
    dominios: Object.freeze(['youtube.com']),
    autenticacao: Object.freeze([
      'SAPISID',
      '__Secure-3PSID',
      '__Secure-1PSID',
      'SID',
      'LOGIN_INFO',
    ]),
    variavelEnv: 'YTDLP_COOKIES_FILE',
    comoGerar: 'Faça login no youtube.com e exporte os cookies no formato Netscape.',
  }),
  instagram: Object.freeze({
    rotulo: 'Instagram',
    dominios: Object.freeze(['instagram.com']),
    autenticacao: Object.freeze(['sessionid', 'ds_user_id']),
    variavelEnv: 'YTDLP_IG_COOKIES_FILE',
    comoGerar: 'Faça login no instagram.com e exporte os cookies no formato Netscape.',
  }),
  facebook: Object.freeze({
    rotulo: 'Facebook',
    dominios: Object.freeze(['facebook.com']),
    autenticacao: Object.freeze(['c_user', 'xs']),
    variavelEnv: 'YTDLP_FB_COOKIES_FILE',
    comoGerar: 'Faça login no facebook.com e exporte os cookies no formato Netscape.',
  }),
});

function ehPlataformaValida(plataforma) {
  return Object.prototype.hasOwnProperty.call(PLATAFORMAS, String(plataforma || ''));
}

function configDaPlataforma(plataforma) {
  const config = PLATAFORMAS[String(plataforma || '')];
  if (!config) {
    const err = new Error('Plataforma inválida. Use youtube, instagram ou facebook.');
    err.status = 400;
    throw err;
  }
  return config;
}

/** Caminho do .env, quando configurado. Lido na hora para o teste poder trocar. */
function caminhoConfigurado(plataforma) {
  const { env } = require('../config/env');
  const porPlataforma = {
    youtube: env.ytDlp?.cookiesFile,
    instagram: env.ytDlp?.igCookiesFile,
    facebook: env.ytDlp?.fbCookiesFile,
  };
  return String(porPlataforma[plataforma] || '').trim();
}

/**
 * Onde o arquivo desta plataforma vive. Sempre devolve um caminho: é isso que
 * permite salvar pela tela sem nada configurado no servidor.
 */
function caminhoDoArquivo(plataforma) {
  configDaPlataforma(plataforma);
  const configurado = caminhoConfigurado(plataforma);
  if (configurado) return path.resolve(configurado);
  return path.join(RAIZ_SECRETS, `${plataforma}-cookies.txt`);
}

/** O arquivo da tela existe e pode ser usado por quem lê cookies? */
function caminhoSalvoPelaTela(plataforma) {
  if (!ehPlataformaValida(plataforma)) return '';
  const alvo = path.join(RAIZ_SECRETS, `${plataforma}-cookies.txt`);
  try {
    return fs.statSync(alvo).size > 0 ? alvo : '';
  } catch {
    return '';
  }
}

/**
 * Linha de cookie no formato Netscape. `#HttpOnly_` parece comentário mas é
 * cookie real (sessionid, xs, __Secure-3PSID vêm assim).
 */
function lerLinhaNetscape(linha) {
  const semPrefixo = linha.startsWith('#HttpOnly_')
    ? linha.slice('#HttpOnly_'.length)
    : linha;
  if (semPrefixo.trim().startsWith('#')) return null;

  const colunas = semPrefixo.includes('\t')
    ? semPrefixo.split('\t')
    : // File Manager e alguns editores trocam tab por espaço ao salvar.
      semPrefixo
        .trim()
        .match(/^(\S+)\s+(TRUE|FALSE)\s+(\S+)\s+(TRUE|FALSE)\s+(\d+)\s+(\S+)\s+(.*)$/i)
        ?.slice(1);
  if (!colunas || colunas.length < 7) return null;

  return {
    dominio: String(colunas[0] || '').toLowerCase(),
    nome: String(colunas[5] || '').trim(),
    expiraEm: Number(colunas[4]) || 0,
  };
}

/**
 * Mantém só os cookies da plataforma pedida e conta o que importa para avisar
 * o editor antes de salvar algo inútil.
 */
function filtrarCookies(plataforma, textoBruto) {
  const config = configDaPlataforma(plataforma);
  const linhas = String(textoBruto || '').replace(/\r\n?/g, '\n').split('\n');

  const mantidas = [
    '# Netscape HTTP Cookie File',
    `# Gerado pelo ViralizeAI — apenas cookies do ${config.rotulo}`,
    '',
  ];
  const nomes = [];
  let total = 0;
  let autenticacao = 0;
  let expiraMaisCedo = 0;

  for (const linha of linhas) {
    if (!linha.trim()) continue;
    const cookie = lerLinhaNetscape(linha);
    if (!cookie) continue;
    if (!config.dominios.some((dominio) => cookie.dominio.includes(dominio))) continue;

    mantidas.push(linha);
    total += 1;
    nomes.push(cookie.nome);

    if (config.autenticacao.includes(cookie.nome)) {
      autenticacao += 1;
      // A sessão morre junto com o cookie de login que expira primeiro.
      if (cookie.expiraEm > 0 && (!expiraMaisCedo || cookie.expiraEm < expiraMaisCedo)) {
        expiraMaisCedo = cookie.expiraEm;
      }
    }
  }

  return {
    conteudo: `${mantidas.join('\n')}\n`,
    total,
    autenticacao,
    nomes,
    expiraEm: expiraMaisCedo ? new Date(expiraMaisCedo * 1000).toISOString() : null,
  };
}

/**
 * Grava os cookies da plataforma. Devolve o resumo, nunca o conteúdo — ele não
 * volta para a tela nem para o log.
 */
function salvarCookies(plataforma, textoBruto) {
  const config = configDaPlataforma(plataforma);
  if (!String(textoBruto || '').trim()) {
    const err = new Error('Envie o arquivo .txt ou cole o conteúdo dos cookies.');
    err.status = 400;
    throw err;
  }

  const filtrado = filtrarCookies(plataforma, textoBruto);
  if (filtrado.total === 0) {
    const err = new Error(
      `Nenhum cookie de ${config.dominios[0]} encontrado. ${config.comoGerar}`
    );
    err.status = 400;
    throw err;
  }
  if (filtrado.autenticacao === 0) {
    const err = new Error(
      `Os cookies não têm sessão logada (faltam ${config.autenticacao
        .slice(0, 2)
        .join('/')}). Faça login antes de exportar.`
    );
    err.status = 400;
    throw err;
  }

  const alvo = caminhoDoArquivo(plataforma);
  fs.mkdirSync(path.dirname(alvo), { recursive: true, mode: 0o700 });
  fs.writeFileSync(alvo, filtrado.conteudo, { mode: 0o600 });

  return {
    total: filtrado.total,
    autenticacao: filtrado.autenticacao,
    expiraEm: filtrado.expiraEm,
    caminho: alvo,
  };
}

/** Situação do arquivo, sem tocar na rede. */
function situacao(plataforma) {
  const config = configDaPlataforma(plataforma);
  const alvo = caminhoDoArquivo(plataforma);
  const base = {
    plataforma,
    rotulo: config.rotulo,
    caminho: alvo,
    porEnv: Boolean(caminhoConfigurado(plataforma)),
    variavelEnv: config.variavelEnv,
    existe: false,
  };

  let stat;
  try {
    stat = fs.statSync(alvo);
  } catch {
    return base;
  }

  try {
    const filtrado = filtrarCookies(plataforma, fs.readFileSync(alvo, 'utf8'));
    const expirou = Boolean(
      filtrado.expiraEm && new Date(filtrado.expiraEm).getTime() <= Date.now()
    );
    return {
      ...base,
      existe: true,
      bytes: stat.size,
      atualizadoEm: stat.mtime.toISOString(),
      total: filtrado.total,
      temSessao: filtrado.autenticacao > 0,
      expiraEm: filtrado.expiraEm,
      expirou,
    };
  } catch {
    return { ...base, existe: true, bytes: stat.size, atualizadoEm: stat.mtime.toISOString() };
  }
}

/** Apaga o arquivo da plataforma (sessão queimada que não deve mais ser usada). */
function removerCookies(plataforma) {
  const alvo = caminhoDoArquivo(plataforma);
  try {
    fs.unlinkSync(alvo);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  PLATAFORMAS,
  RAIZ_SECRETS,
  ehPlataformaValida,
  caminhoDoArquivo,
  caminhoSalvoPelaTela,
  filtrarCookies,
  salvarCookies,
  situacao,
  removerCookies,
};
