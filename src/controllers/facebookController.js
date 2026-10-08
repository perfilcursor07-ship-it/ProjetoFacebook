const crypto = require('crypto');
const facebookService = require('../services/facebookService');
const postpulseService = require('../services/postpulseService');
const PostpulseConnections = require('../models/PostpulseConnections');
const FacebookAccounts = require('../models/FacebookAccounts');
const FacebookPages = require('../models/FacebookPages');
const Users = require('../models/Users');
const db = require('../config/db');

/** Redireciona para o diálogo de login do Facebook. */
function facebookLogin(req, res, next) {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.fbState = state;
    // Garante que o state foi gravado ANTES do redirect (proxy HTTPS)
    req.session.save((err) => {
      if (err) return next(err);
      res.redirect(facebookService.loginUrl(state));
    });
  } catch (err) {
    next(err);
  }
}

/** Callback do OAuth: troca code por token, salva conta e páginas. */
async function facebookCallback(req, res, next) {
  try {
    const { code, state, error_description: errorDescription } = req.query;

    if (errorDescription) {
      return res.redirect('/paginas?erro=' + encodeURIComponent(errorDescription));
    }
    if (!code || !state || state !== req.session.fbState) {
      return res.redirect('/paginas?erro=' + encodeURIComponent('Estado OAuth inválido, tente novamente'));
    }
    delete req.session.fbState;

    const short = await facebookService.exchangeCodeForToken(code);
    let accessToken = short.access_token;
    let expiresIn = short.expires_in || 3600;

    try {
      const long = await facebookService.getLongLivedToken(accessToken);
      accessToken = long.access_token;
      expiresIn = long.expires_in || 60 * 24 * 60 * 60;
    } catch {
      // segue com o token curto se a troca falhar
    }

    const me = await facebookService.getMe(accessToken);
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // Se já existe conta stub (só PostSyncer), promove para OAuth real
    // em vez de criar segunda linha (findByUser retorna .first()).
    const existing = await FacebookAccounts.findByUser(req.session.userId);
    if (existing) {
      await db('facebook_accounts').where({ id: existing.id }).update({
        fb_user_id: me.id,
        access_token: accessToken,
        expires_at: expiresAt,
        updated_at: db.fn.now(),
      });
    } else {
      await FacebookAccounts.upsert({
        user_id: req.session.userId,
        fb_user_id: me.id,
        access_token: accessToken,
        expires_at: expiresAt,
      });
    }

    const account = await FacebookAccounts.findByUser(req.session.userId);

    const pages = await facebookService.getPages(accessToken);
    if (pages.length) {
      await FacebookPages.upsertMany(
        pages.map((p) => ({
          facebook_account_id: account.id,
          page_id: p.id,
          page_name: p.name,
          page_access_token: p.access_token,
        }))
      );
    }

    res.redirect('/paginas?conectado=1');
  } catch (err) {
    console.error('Facebook callback:', facebookService.graphErrorMessage(err));
    res.redirect('/paginas?erro=' + encodeURIComponent(facebookService.graphErrorMessage(err)));
  }
}

/** Lista páginas conectadas (do banco); ?refresh=1 rebusca na Graph API. */
async function listPages(req, res, next) {
  try {
    const account = await FacebookAccounts.findByUser(req.session.userId);
    if (!account) {
      return res.json({ conectado: false, pages: [] });
    }

    if (req.query.refresh === '1') {
      const { isPostsyncerStubAccount } = require('../services/postsyncerSync');
      if (!isPostsyncerStubAccount(account)) {
        const pages = await facebookService.getPages(account.access_token);
        if (pages.length) {
          await FacebookPages.upsertMany(
            pages.map((p) => ({
              facebook_account_id: account.id,
              page_id: p.id,
              page_name: p.name,
              page_access_token: p.access_token,
            }))
          );
        }
        try {
          const { syncPostpulseAccounts } = require('../services/postpulseSync');
          await syncPostpulseAccounts(req.session.userId);
        } catch (syncErr) {
          console.warn('PostPulse sync após refresh:', postpulseService.apiErrorMessage(syncErr));
        }
      }
    }

    // Confere as páginas com a conta Ayrshare atual (troca de conta deixa
    // páginas com Profile Key que não existe mais). ?sincronizar=1 espera o
    // resultado (tela /paginas); nas outras telas roda em segundo plano.
    const contaAyrshare = require('../services/ayrshareContaService');
    const { pagesForUser, foraDaConta } = require('../services/facebookPageResolver');
    if (contaAyrshare.provedorAyrshare()) {
      const sincronizar = contaAyrshare.sincronizarPaginas(
        await pagesForUser(req.session.userId, { incluirForaDaConta: true }),
        { forcar: req.query.sincronizar === '1' && req.query.forcar === '1' }
      ).catch((err) => console.warn('[ayrshare-conta] sincronizar:', err.message));
      if (req.query.sincronizar === '1') {
        await Promise.race([sincronizar, new Promise((r) => setTimeout(r, 15_000))]);
      }
    }

    const todasDaConta = await FacebookPages.findByAccount(account.id);
    const pages = todasDaConta.filter((p) => !foraDaConta(p));
    const paginasForaDaConta = todasDaConta
      .filter((p) => foraDaConta(p))
      .map((p) => ({ id: p.id, page_name: p.page_name, motivo: p.ayrshare_motivo || null }));
    const ppConn = postpulseService.isConfigured()
      ? await PostpulseConnections.findByUser(req.session.userId)
      : null;
    const postsyncerService = require('../services/postsyncerService');
    const { isPostsyncerStubAccount } = require('../services/postsyncerSync');
    const psConfigured = postsyncerService.isConfigured();
    const oauthConnected = !isPostsyncerStubAccount(account);
    let defaultPageId = await Users.getDefaultFacebookPageId(req.session.userId);

    // Se a padrão sumiu, limpa; se só há 1 página e não tem padrão, define automático
    if (defaultPageId && !pages.some((p) => Number(p.id) === Number(defaultPageId))) {
      await Users.setDefaultFacebookPageId(req.session.userId, null);
      defaultPageId = null;
    }
    if (!defaultPageId && pages.length === 1) {
      await Users.setDefaultFacebookPageId(req.session.userId, pages[0].id);
      defaultPageId = pages[0].id;
    }

    res.json({
      conectado: true,
      paginas_fora_da_conta: paginasForaDaConta,
      oauth: oauthConnected,
      fb_user_id: account.fb_user_id,
      expira_em: account.expires_at,
      default_facebook_page_id: defaultPageId,
      postpulse: {
        configured: postpulseService.isConfigured(),
        connected: Boolean(ppConn?.access_token),
        expires_at: ppConn?.expires_at || null,
      },
      postsyncer: {
        configured: psConfigured,
      },
      pages: pages.map((p) => {
        let publica_via = 'facebook';
        const { env } = require('../config/env');
        const pubMode = (env.postpulse.publishProvider || 'auto').toLowerCase();
        const ayrshareOn =
          require('../services/ayrshareService').isConfigured() &&
          (pubMode === 'ayrshare' || pubMode === 'auto');
        if (ayrshareOn) {
          publica_via = 'ayrshare';
        } else if (psConfigured && p.postsyncer_account_id) {
          publica_via = 'postsyncer';
        } else if (p.postpulse_account_id && p.postpulse_chat_id && ppConn?.access_token) {
          publica_via = 'postpulse';
        } else if (p.postpulse_account_id && ppConn?.access_token) {
          publica_via = 'postpulse_sem_pagina';
        }
        return {
          id: p.id,
          page_id: p.page_id,
          page_name: p.page_name,
          postpulse_account_id: p.postpulse_account_id || null,
          postpulse_chat_id: p.postpulse_chat_id || null,
          postsyncer_account_id: p.postsyncer_account_id || null,
          ayrshare_profile_key: p.ayrshare_profile_key || null,
          has_ayrshare_profile_key: Boolean(p.ayrshare_profile_key),
          instagram_ativo: Boolean(p.instagram_ativo),
          instagram_username: p.instagram_username || null,
          x_ativo: Boolean(p.x_ativo),
          x_username: p.x_username || null,
          publica_via,
          is_default: Number(p.id) === Number(defaultPageId),
        };
      }),
    });
  } catch (err) {
    err.message = facebookService.graphErrorMessage(err);
    next(err);
  }
}

/** Define a Página padrão usada nos seletores de publicação. */
async function setDefaultPage(req, res, next) {
  try {
    const pageId = Number(req.body?.facebook_page_id ?? req.body?.facebookPageId ?? 0);
    if (!pageId) {
      await Users.setDefaultFacebookPageId(req.session.userId, null);
      return res.json({ ok: true, default_facebook_page_id: null });
    }

    const account = await FacebookAccounts.findByUser(req.session.userId);
    if (!account) {
      return res.status(400).json({ error: 'Conecte uma conta Facebook primeiro' });
    }
    const page = await FacebookPages.findById(pageId);
    if (!page || Number(page.facebook_account_id) !== Number(account.id)) {
      return res.status(404).json({ error: 'Página não encontrada' });
    }

    await Users.setDefaultFacebookPageId(req.session.userId, page.id);
    res.json({
      ok: true,
      default_facebook_page_id: page.id,
      page: { id: page.id, page_name: page.page_name },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { facebookLogin, facebookCallback, listPages, setDefaultPage };
