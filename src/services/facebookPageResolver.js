const db = require('../config/db');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const Users = require('../models/Users');

/**
 * Resolve páginas do Facebook SEMPRE no escopo do usuário logado.
 * Publicar na página de outra conta continua sendo erro, não fallback.
 *
 * O escopo tem duas origens, e só estas duas:
 *   1. páginas da conta do Facebook que o próprio usuário conectou;
 *   2. páginas que um administrador liberou para ele em /usuarios
 *      (tabela user_facebook_pages).
 *
 * A segunda existe porque a posse é em cadeia (página -> conta -> usuário): sem
 * ela, cada pessoa teria de reconectar o Facebook e revincular a mesma página
 * no Ayrshare só para poder publicar. A concessão separa posse de permissão.
 */

const CONCESSOES = 'user_facebook_pages';

/** Ids de página liberados pelo administrador para este usuário. */
async function grantedPageIds(userId) {
  try {
    const linhas = await db(CONCESSOES).where({ user_id: userId }).select('facebook_page_id');
    return linhas.map((l) => Number(l.facebook_page_id));
  } catch (err) {
    // Tabela ausente (migration ainda não rodou) não pode derrubar publicação.
    if (err?.code !== 'ER_NO_SUCH_TABLE') console.warn('[paginas] concessões:', err.message);
    return [];
  }
}

/** Página que não existe mais na conta Ayrshare atual (ver ayrshareContaService). */
function foraDaConta(page) {
  return Boolean(page?.ayrshare_fora_da_conta) && page.ayrshare_fora_da_conta !== '0';
}

/**
 * Páginas da conta Facebook do próprio usuário, mais as liberadas para ele.
 * Esconde as que não estão na conta Ayrshare atual e não repete a mesma
 * Página do Facebook (liberada + própria) duas vezes.
 */
async function pagesForUser(userId, { incluirForaDaConta = false } = {}) {
  const account = await FacebookAccounts.findByUser(userId);
  const proprias = account ? await FacebookPages.findByAccount(account.id) : [];

  const liberados = await grantedPageIds(userId);
  const jaTem = new Set(proprias.map((p) => Number(p.id)));
  const extras = [];
  for (const id of liberados) {
    if (jaTem.has(id)) continue;
    const page = await FacebookPages.findById(id);
    // Página apagada depois da concessão: ignora em silêncio.
    if (page) extras.push({ ...page, concedida: true });
  }
  const todas = [...proprias, ...extras];
  if (incluirForaDaConta) return todas;

  const visiveis = todas.filter((p) => !foraDaConta(p));
  const vistas = new Set();
  return visiveis.filter((p) => {
    const chave = String(p.page_id || '').trim() || `id:${p.id}`;
    if (vistas.has(chave)) return false;
    vistas.add(chave);
    return true;
  });
}

/** Página por id, apenas se for do usuário ou liberada para ele. */
async function resolvePageForUser(userId, facebookPageId) {
  const id = Number(facebookPageId || 0);
  if (!id) return null;
  const page = await FacebookPages.findById(id);
  if (!page) return null;

  const account = await FacebookAccounts.findByUser(userId);
  if (account && Number(page.facebook_account_id) === Number(account.id)) return page;

  const liberados = await grantedPageIds(userId);
  if (liberados.includes(id)) return { ...page, concedida: true };

  return null;
}

/**
 * Página padrão do usuário logado, validada contra as páginas dele.
 * Se a padrão apontar para página inexistente//de outra conta, o vínculo é limpo
 * em vez de ser usado — nunca cai para “a primeira página encontrada”.
 */
async function defaultPageIdForUser(userId) {
  const stored = await Users.getDefaultFacebookPageId(userId);
  if (!stored) return null;
  const page = await resolvePageForUser(userId, stored);
  if (!page || foraDaConta(page)) {
    await Users.setDefaultFacebookPageId(userId, null);
    return null;
  }
  return Number(page.id);
}

/** Página padrão do usuário (registro completo) ou null. */
async function defaultPageForUser(userId) {
  const id = await defaultPageIdForUser(userId);
  if (!id) return null;
  return resolvePageForUser(userId, id);
}

module.exports = {
  foraDaConta,
  pagesForUser,
  resolvePageForUser,
  defaultPageIdForUser,
  defaultPageForUser,
  grantedPageIds,
};
