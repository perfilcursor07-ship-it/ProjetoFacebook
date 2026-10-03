const store = require('../services/cookieStore');

/** "Me at the zoo" — vídeo público estável, bom para testar sessão. */
const VIDEO_TESTE = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

function plataformaDaRota(req) {
  const plataforma = String(req.params?.plataforma || '').toLowerCase();
  if (!store.ehPlataformaValida(plataforma)) {
    const err = new Error('Plataforma inválida. Use youtube, instagram ou facebook.');
    err.status = 400;
    throw err;
  }
  return plataforma;
}

/** Situação das três plataformas de uma vez: é o que a tela carrega ao abrir. */
async function listarStatus(_req, res, next) {
  try {
    const plataformas = Object.keys(store.PLATAFORMAS).map((p) => store.situacao(p));
    return res.json({ ok: true, plataformas });
  } catch (err) {
    return next(err);
  }
}

async function obterStatus(req, res, next) {
  try {
    return res.json({ ok: true, ...store.situacao(plataformaDaRota(req)) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function salvar(req, res, next) {
  try {
    const plataforma = plataformaDaRota(req);

    // Upload e texto colado chegam por caminhos diferentes; o resto é igual.
    const texto = req.file?.buffer
      ? req.file.buffer.toString('utf8')
      : String(req.body?.conteudo || '');

    const resumo = store.salvarCookies(plataforma, texto);
    const rotulo = store.PLATAFORMAS[plataforma].rotulo;

    // O conteúdo nunca entra no log: só a contagem.
    console.info(
      `[cookies] ${plataforma}: ${resumo.total} cookie(s) salvos, sessão=${resumo.autenticacao}`
    );

    return res.json({
      ok: true,
      ...resumo,
      message: `${resumo.total} cookie(s) do ${rotulo} salvos. Rode o teste para confirmar.`,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function remover(req, res, next) {
  try {
    const plataforma = plataformaDaRota(req);
    const removido = store.removerCookies(plataforma);
    return res.json({
      ok: true,
      removido,
      message: removido ? 'Cookies apagados.' : 'Não havia arquivo salvo.',
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function testarYoutube() {
  const { fetchLinkMetadata, humanizeYtDlpError } = require('../services/importService');
  const axios = require('axios');

  let info;
  try {
    info = await fetchLinkMetadata(VIDEO_TESTE);
  } catch (err) {
    return { ok: false, error: humanizeYtDlpError(err) };
  }

  // O vídeo de teste passa mesmo com o IP limitado. A página do vídeo é o que
  // as legendas usam: se ela devolve 429, as matérias falham apesar dos
  // cookies bons — e trocar os cookies não resolveria.
  const statusPagina = await axios
    .get(VIDEO_TESTE, {
      timeout: 15_000,
      responseType: 'text',
      validateStatus: () => true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
      },
    })
    .then((r) => r.status)
    .catch(() => 0);

  if (statusPagina === 429 || statusPagina === 403) {
    return {
      ok: false,
      error: `Os cookies estão válidos, mas o YouTube está limitando o IP deste servidor (HTTP ${statusPagina}). Legendas e vídeos recentes vão falhar até o bloqueio passar; trocar os cookies não resolve.`,
    };
  }
  return { ok: true, detalhe: info.titulo, message: 'Sessão do YouTube respondeu normalmente.' };
}

async function testarInstagram() {
  const {
    diagnoseInstagramCookies,
    validateInstagramSession,
  } = require('../services/instagramCookies');

  const formato = diagnoseInstagramCookies();
  if (!formato.ok) return { ok: false, error: `Formato: ${formato.reason}` };

  const sessao = await validateInstagramSession(require('axios'));
  if (!sessao.ok) {
    return {
      ok: false,
      error:
        `O Instagram rejeitou a sessão: ${sessao.reason}` +
        (sessao.status ? ` (HTTP ${sessao.status})` : '') +
        '. Reexporte os cookies de uma sessão ativa.',
    };
  }
  // validateInstagramSession devolve { ok, status, reason } — sem nome de usuário.
  return { ok: true, detalhe: sessao.reason || null, message: 'Sessão do Instagram autenticada.' };
}

async function testarFacebook() {
  const {
    diagnoseFacebookCookies,
    validateFacebookSession,
  } = require('../services/facebookCookies');

  const formato = diagnoseFacebookCookies();
  if (!formato.ok) return { ok: false, error: `Formato: ${formato.reason}` };

  const sessao = await validateFacebookSession(require('axios'));
  if (!sessao.ok) {
    return {
      ok: false,
      error:
        `O Facebook rejeitou a sessão: ${sessao.reason}` +
        (sessao.status ? ` (HTTP ${sessao.status})` : '') +
        '. Reexporte os cookies de uma sessão ativa.',
    };
  }
  return { ok: true, detalhe: sessao.reason || null, message: 'Sessão do Facebook autenticada.' };
}

const TESTES = {
  youtube: testarYoutube,
  instagram: testarInstagram,
  facebook: testarFacebook,
};

async function testar(req, res, next) {
  try {
    const plataforma = plataformaDaRota(req);
    const situacao = store.situacao(plataforma);
    if (!situacao.existe) {
      return res
        .status(400)
        .json({ ok: false, error: 'Nenhum cookie salvo ainda para esta plataforma.' });
    }

    const resultado = await TESTES[plataforma]();
    return res.status(resultado.ok ? 200 : 502).json(resultado);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    return next(err);
  }
}

module.exports = { listarStatus, obterStatus, salvar, testar, remover };
