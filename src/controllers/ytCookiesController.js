/**
 * Compatibilidade da API antiga `/api/youtube-cookies`.
 *
 * A lógica de verdade mora em services/cookieStore.js e em
 * controllers/cookiesController.js, que atendem as três plataformas. Aqui só
 * traduzimos nomes para não quebrar quem ainda chama o endpoint antigo.
 */
const store = require('../services/cookieStore');
const cookies = require('./cookiesController');

/** @deprecated use cookieStore.filtrarCookies('youtube', texto) */
function filterYoutubeCookies(rawText) {
  const resultado = store.filtrarCookies('youtube', rawText);
  return {
    content: resultado.conteudo,
    cookieCount: resultado.total,
    authCount: resultado.autenticacao,
  };
}

function comPlataformaYoutube(req) {
  req.params = { ...(req.params || {}), plataforma: 'youtube' };
  return req;
}

async function getStatus(_req, res) {
  const situacao = store.situacao('youtube');
  // Nomes antigos que a tela legada esperava.
  return res.json({
    configured: true,
    path: situacao.caminho,
    exists: situacao.existe,
    sizeBytes: situacao.bytes,
    updatedAt: situacao.atualizadoEm,
    cookieCount: situacao.total,
    hasAuthCookies: Boolean(situacao.temSessao),
  });
}

async function upload(req, res, next) {
  return cookies.salvar(comPlataformaYoutube(req), res, next);
}

async function test(req, res, next) {
  return cookies.testar(comPlataformaYoutube(req), res, next);
}

module.exports = { getStatus, upload, test, filterYoutubeCookies };
