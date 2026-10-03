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

/** Páginas da conta Facebook do próprio usuário, mais as liberadas para ele. */
async function pagesForUser(userId) {
  const account = await FacebookAccounts.findByUser(userId);
  const proprias = account ? await FacebookPages.findByAccount(account.id) : [];

  const liberados = await grantedPageIds(userId);
  if (!liberados.length) return proprias;

  const jaTem = new Set(proprias.map((p) => Number(p.id)));
  const extras = [];
  for (const id of liberados) {
    if (jaTem.has(id)) continue;
    const page = await FacebookPages.findById(id);
    // Página apagada depois da concessão: ignora em silêncio.
    if (page) extras.push({ ...page, concedida: true });
  }
  return [...proprias, ...extras];
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
  if (!page) {
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
  pagesForUser,
  resolvePageForUser,
  defaultPageIdForUser,
  defaultPageForUser,
  grantedPageIds,
};
