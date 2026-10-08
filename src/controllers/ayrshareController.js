const FacebookPages = require('../models/FacebookPages');
const ayrshareService = require('../services/ayrshareService');
const { resolvePageForUser, pagesForUser } = require('../services/facebookPageResolver');

async function setProfileKey(req, res, next) {
  try {
    ayrshareService.assertConfigured();
    const pageId = Number(req.body?.facebook_page_id || req.body?.facebookPageId || 0);
    const profileKey = String(
      req.body?.ayrshare_profile_key ?? req.body?.profile_key ?? ''
    ).trim();
    if (!pageId) {
      const err = new Error('Informe facebook_page_id');
      err.status = 400;
      throw err;
    }

    const page = await resolvePageForUser(req.session.userId, pageId);
    if (!page) {
      const err = new Error('Página não encontrada na sua conta');
      err.status = 404;
      throw err;
    }

    // Remoção explícita da chave: permitida, mas avisa quando há várias páginas.
    if (!profileKey) {
      await FacebookPages.setAyrshareProfileKey(page.id, null);
      const paginas = await pagesForUser(req.session.userId);
      return res.json({
        ok: true,
        page: {
          id: page.id,
          page_name: page.page_name,
          ayrshare_profile_key: null,
          has_profile_key: false,
        },
        aviso:
          paginas.length > 1
            ? 'Profile Key removido. Com mais de uma Página, esta não poderá publicar até receber o Profile Key.'
            : 'Profile Key removido — usará o Primary Profile.',
      });
    }

    // O painel "Manage Profiles" mostra o RefId, que não funciona como Profile Key.
    if (ayrshareService.looksLikeRefId(profileKey)) {
      const err = new Error(
        'Esse valor é o RefId do profile, não o Profile Key. O RefId aparece em Manage Profiles, ' +
          'mas o Profile Key é entregue quando o User Profile é criado (ou pode ser gerado de novo na Ayrshare). ' +
          'Cole o Profile Key para o post ir na Página certa.'
      );
      err.status = 400;
      err.code = 'AYRSHARE_REFID_INSTEAD_OF_KEY';
      throw err;
    }

    if (ayrshareService.isAyrshareApiKey(profileKey)) {
      const err = new Error(
        'Você colou a API Key geral da Ayrshare no campo Profile Key. ' +
          'Ela fica somente no .env (AYRSHARE_API_KEY). Para esta Página, crie ou reative um User Profile na Ayrshare e cole o Profile Key dele — não o RefId nem a API Key.'
      );
      err.status = 400;
      err.code = 'AYRSHARE_API_KEY_INSTEAD_OF_PROFILE_KEY';
      throw err;
    }

    // Duas páginas com a mesma chave publicariam sempre no mesmo lugar.
    const paginas = await pagesForUser(req.session.userId);
    const conflito = paginas.find(
      (p) =>
        Number(p.id) !== Number(page.id) &&
        String(p.ayrshare_profile_key || '').trim() === profileKey
    );
    if (conflito) {
      const err = new Error(
        `Este Profile Key já está na Página “${conflito.page_name}”. ` +
          'Cada Página precisa do Profile Key do seu próprio User Profile.'
      );
      err.status = 409;
      err.code = 'AYRSHARE_PROFILE_KEY_DUPLICATED';
      throw err;
    }

    // Valida a chave na Ayrshare antes de salvar e informa qual Página está conectada.
    let detalhes = null;
    try {
      detalhes = await ayrshareService.fetchProfileByKey(profileKey);
    } catch (validationErr) {
      const err = new Error(
        `A Ayrshare recusou este Profile Key: ${ayrshareService.apiErrorMessage(validationErr)}`
      );
      err.status = 400;
      err.code = 'AYRSHARE_PROFILE_KEY_REJECTED';
      throw err;
    }

    await FacebookPages.setAyrshareProfileKey(page.id, profileKey);
    const updated = await FacebookPages.findById(page.id);

    const avisos = [];
    if (!detalhes.facebookConnected) {
      avisos.push(
        'Este profile ainda não tem Página do Facebook conectada. Vincule em Social Accounts na Ayrshare.'
      );
    }
    if (detalhes.facebookPageName) {
      avisos.push(`Profile conectado à Página do Facebook: ${detalhes.facebookPageName}.`);
    }

    res.json({
      ok: true,
      page: {
        id: updated.id,
        page_name: updated.page_name,
        ayrshare_profile_key: updated.ayrshare_profile_key || null,
        has_profile_key: Boolean(updated.ayrshare_profile_key),
      },
      profile: {
        title: detalhes.title,
        ref_id: detalhes.refId,
        facebook_connected: detalhes.facebookConnected,
        facebook_page_name: detalhes.facebookPageName,
        active_social_accounts: detalhes.activeSocialAccounts,
      },
      aviso: avisos.join(' ') || null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Liga/desliga a publicação no Instagram de uma Página.
 *
 * A conta do Instagram já vem conectada no User Profile da Ayrshare: aqui só
 * confirmamos que ela existe (activeSocialAccounts) e guardamos a escolha, para
 * a tela da matéria poder oferecer o botão "publicar também no Instagram".
 */
async function setInstagram(req, res, next) {
  try {
    ayrshareService.assertConfigured();
    const pageId = Number(req.body?.facebook_page_id || req.body?.facebookPageId || 0);
    if (!pageId) {
      const err = new Error('Informe facebook_page_id');
      err.status = 400;
      throw err;
    }

    const page = await resolvePageForUser(req.session.userId, pageId);
    if (!page) {
      const err = new Error('Página não encontrada na sua conta');
      err.status = 404;
      throw err;
    }

    const bruto = req.body?.ativo ?? req.body?.instagram_ativo ?? true;
    const ativo = bruto === true || bruto === 1 || bruto === '1' || bruto === 'true';

    if (!ativo) {
      await FacebookPages.setInstagram(page.id, { ativo: false });
      return res.json({
        ok: true,
        page: { id: page.id, page_name: page.page_name, instagram_ativo: false },
        aviso: 'Instagram desligado para esta Página.',
      });
    }

    // Sem Profile Key, a Ayrshare usa o Primary Profile — o Instagram ativado
    // aqui poderia ser o de outra Página.
    const profileKey = String(page.ayrshare_profile_key || '').trim();
    let detalhes = null;
    try {
      detalhes = await ayrshareService.fetchProfileByKey(profileKey || null, {
        permitirPrimary: true,
      });
    } catch (validationErr) {
      const err = new Error(
        profileKey
          ? `A Ayrshare recusou o Profile Key desta Página: ${ayrshareService.apiErrorMessage(validationErr)}`
          : 'Cole primeiro o Profile Key desta Página para verificar o Instagram conectado.'
      );
      err.status = 400;
      throw err;
    }

    if (!detalhes.instagramConnected) {
      const err = new Error(
        'Este profile da Ayrshare não tem Instagram conectado. ' +
          'Vincule a conta em app.ayrshare.com → Social Accounts e tente de novo.'
      );
      err.status = 422;
      err.code = 'AYRSHARE_INSTAGRAM_NOT_CONNECTED';
      throw err;
    }

    await FacebookPages.setInstagram(page.id, {
      ativo: true,
      username: detalhes.instagramUsername,
    });

    return res.json({
      ok: true,
      page: {
        id: page.id,
        page_name: page.page_name,
        instagram_ativo: true,
        instagram_username: detalhes.instagramUsername || null,
      },
      profile: {
        instagram_connected: true,
        instagram_username: detalhes.instagramUsername || null,
        active_social_accounts: detalhes.activeSocialAccounts,
      },
      aviso: detalhes.instagramUsername
        ? `Instagram @${detalhes.instagramUsername} ligado a esta Página.`
        : 'Instagram ligado a esta Página.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Liga/desliga a publicação no X.com de uma Página.
 * A conexão acontece na Ayrshare; aqui vinculamos a escolha ao User Profile
 * correto, como já é feito com Instagram.
 */
async function setX(req, res, next) {
  try {
    ayrshareService.assertConfigured();
    const pageId = Number(req.body?.facebook_page_id || req.body?.facebookPageId || 0);
    if (!pageId) {
      const err = new Error('Informe facebook_page_id');
      err.status = 400;
      throw err;
    }

    const page = await resolvePageForUser(req.session.userId, pageId);
    if (!page) {
      const err = new Error('Página não encontrada na sua conta');
      err.status = 404;
      throw err;
    }

    const bruto = req.body?.ativo ?? req.body?.x_ativo ?? true;
    const ativo = bruto === true || bruto === 1 || bruto === '1' || bruto === 'true';
    if (!ativo) {
      await FacebookPages.setX(page.id, { ativo: false });
      return res.json({
        ok: true,
        page: { id: page.id, page_name: page.page_name, x_ativo: false },
        aviso: 'X.com desligado para esta Página.',
      });
    }

    if (!ayrshareService.isTwitterByoConfigured()) {
      const err = new Error(
        'Para ativar o X.com, configure AYRSHARE_X_API_KEY e AYRSHARE_X_API_SECRET no .env e reinicie o app.'
      );
      err.status = 422;
      throw err;
    }

    const profileKey = String(page.ayrshare_profile_key || '').trim();
    let detalhes = null;
    try {
      detalhes = await ayrshareService.fetchProfileByKey(profileKey || null, {
        permitirPrimary: true,
      });
    } catch (validationErr) {
      const err = new Error(
        profileKey
          ? `A Ayrshare recusou o Profile Key desta Página: ${ayrshareService.apiErrorMessage(validationErr)}`
          : 'Cole primeiro o Profile Key desta Página para verificar o X.com conectado.'
      );
      err.status = 400;
      throw err;
    }

    if (!detalhes.xConnected) {
      const err = new Error(
        'Este profile da Ayrshare não tem uma conta X.com conectada. ' +
          'Vincule a conta em app.ayrshare.com → Social Accounts e tente de novo.'
      );
      err.status = 422;
      err.code = 'AYRSHARE_X_NOT_CONNECTED';
      throw err;
    }

    await FacebookPages.setX(page.id, { ativo: true, username: detalhes.xUsername });
    return res.json({
      ok: true,
      page: {
        id: page.id,
        page_name: page.page_name,
        x_ativo: true,
        x_username: detalhes.xUsername || null,
      },
      profile: {
        x_connected: true,
        x_username: detalhes.xUsername || null,
        active_social_accounts: detalhes.activeSocialAccounts,
      },
      aviso: detalhes.xUsername
        ? `X.com @${String(detalhes.xUsername).replace(/^@/, '')} ligado a esta Página.`
        : 'X.com ligado a esta Página.',
    });
  } catch (err) {
    next(err);
  }
}

const MSG_CHAVE_DO_SERVIDOR =
  'A API Key configurada no servidor não é aceita pela Ayrshare. Se você trocou de conta, ' +
  'troque AYRSHARE_API_KEY no .env do servidor pela API Key da conta nova (API Dashboard da Ayrshare) e reinicie o app (pm2 restart).';

/** Primary Profile da conta: é a página da conta quando não há User Profiles. */
function resumoDoPrimary(primary) {
  if (!primary) return null;
  return {
    title: primary.title || 'Primary Profile',
    facebook_connected: Boolean(primary.facebookConnected),
    facebook_page_name: primary.facebookPageName || null,
  };
}

async function listProfiles(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');
    const cursor = String(req.query.cursor || '').slice(0, 2000) || null;
    const conta = cursor ? null : await ayrshareService.diagnosticarConta();
    if (conta && !conta.ok) {
      throw Object.assign(new Error(conta.status === 401 || conta.status === 403 ? MSG_CHAVE_DO_SERVIDOR : `A Ayrshare não respondeu: ${conta.motivo}`), { status: 502 });
    }
    let lista = { profiles: [], next_cursor: null };
    let aviso = null;
    try {
      lista = await ayrshareService.listProfiles({ cursor });
    } catch {
      // Plano sem User Profiles: só existe o Primary Profile — e ele basta.
      aviso = 'Esta conta não tem User Profiles (ou o plano não permite listá-los). Use a página do Primary Profile.';
    }
    res.json({
      ...lista,
      primary: resumoDoPrimary(conta?.primary),
      api_key_final: ayrshareService.finalDaApiKey(),
      aviso,
    });
  } catch (err) {
    next(err.status ? err : Object.assign(new Error('Não foi possível buscar os perfis na Ayrshare.'), { status: 502 }));
  }
}

/**
 * Por que o Profile Key não validou? Separa os três casos comuns: API Key do
 * servidor velha (troca de conta), API Key colada no lugar do Profile Key e
 * chave errada de verdade.
 */
async function explicarFalhaDoProfileKey(valor) {
  const conta = await ayrshareService.diagnosticarConta();
  if (!conta.ok && (conta.status === 401 || conta.status === 403)) return MSG_CHAVE_DO_SERVIDOR;
  if (await ayrshareService.valeComoApiKey(valor)) {
    return 'Isso é a API Key de uma conta Ayrshare, não um Profile Key. Se for a conta nova, ela vai em AYRSHARE_API_KEY no .env do servidor. ' +
      'Conta só com o Primary Profile não tem Profile Key: use “Adicionar a página do Primary Profile”.';
  }
  return 'A Ayrshare não validou o Profile Key. Confira a chave (tela Profile Key do User Profile) e tente novamente. ' +
    'Se a conta só tem o Primary Profile, não existe Profile Key: use “Adicionar a página do Primary Profile”.';
}

/**
 * Página do Primary Profile (conta sem User Profiles): fica sem Profile Key e
 * vira a página padrão — o envio sem Profile Key só é liberado para a padrão.
 */
async function adicionarPaginaDoPrimary(req, res) {
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  const conta = await ayrshareService.diagnosticarConta();
  if (!conta.ok) fail(conta.status === 401 || conta.status === 403 ? MSG_CHAVE_DO_SERVIDOR : `A Ayrshare não respondeu: ${conta.motivo}`, 422);
  const primary = conta.primary;
  if (!primary.facebookConnected) fail('O Primary Profile da Ayrshare ainda não tem Página do Facebook conectada. Conecte em Social Accounts na Ayrshare e tente de novo.', 422);
  const pageName = primary.facebookPageName || primary.title || 'Página do Primary Profile';
  const pageId = String(primary.facebookPageId || `ayrshare:primary:${primary.refId || 'conta'}`).slice(0, 64);
  const db = require('../config/db');
  const result = await db.transaction(async (trx) => {
    await trx('users').where({ id: req.session.userId }).forUpdate().first();
    let account = await trx('facebook_accounts').where({ user_id: req.session.userId }).first();
    if (!account) {
      await trx('facebook_accounts').insert({ user_id: req.session.userId, fb_user_id: `ayrshare:${req.session.userId}`, access_token: 'ayrshare:stub' });
      account = await trx('facebook_accounts').where({ user_id: req.session.userId }).first();
    }
    const pages = await trx('facebook_pages').where({ facebook_account_id: account.id });
    const existing = pages.find((p) => p.page_id === pageId);
    if (existing) {
      // Era de User Profile da conta antiga: passa a usar o Primary Profile.
      await trx('facebook_pages').where({ id: existing.id }).update({ ayrshare_profile_key: null, page_name: String(pageName).slice(0, 255), updated_at: trx.fn.now() });
      return { id: existing.id, page_name: pageName, existing: true };
    }
    const [id] = await trx('facebook_pages').insert({ facebook_account_id: account.id, page_id: pageId, page_name: String(pageName).slice(0, 255), page_access_token: 'ayrshare:stub', ayrshare_profile_key: null });
    return { id, page_name: pageName, existing: false };
  });
  const Users = require('../models/Users');
  await Users.setDefaultFacebookPageId(req.session.userId, result.id);
  // Confere já as páginas de TODOS os usuários: as da conta antiga que são
  // esta mesma Página passam a publicar pelo Primary; as outras somem das listas.
  const contaAyrshare = require('../services/ayrshareContaService');
  contaAyrshare.limparCache();
  setImmediate(() => {
    db('facebook_pages')
      .select()
      .then((todas) => contaAyrshare.sincronizarPaginas(todas, { forcar: true }))
      .then((r) => console.info(`[ayrshare-conta] após Primary: ${r.verificadas} conferida(s), ${r.curadas.length} corrigida(s), ${r.fora.length} fora da conta`))
      .catch((err) => console.warn('[ayrshare-conta] conferência geral:', err.message));
  });
  res.json({
    ok: true,
    page: result,
    aviso: 'Página do Primary Profile adicionada e marcada como padrão. Ela publica sem Profile Key. ' +
      'Páginas com Profile Key da conta antiga não funcionam com a API Key nova: remova-as abaixo.',
  });
}

async function addPage(req, res, next) {
  try {
    if (req.body?.primary === true) return await adicionarPaginaDoPrimary(req, res);
    const key = String(req.body?.profile_key || '').trim();
    const refId = String(req.body?.ref_id || '').trim();
    const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
    if (!key || key.length > 128) fail('Cole o Profile Key do perfil que deseja adicionar.');
    if (ayrshareService.looksLikeRefId(key)) {
      fail('Esse valor é o RefId (aparece em User Profiles), não o Profile Key. Se a conta só tem o Primary Profile, ela não tem Profile Key: use “Adicionar a página do Primary Profile”.');
    }
    if (ayrshareService.isAyrshareApiKey(key)) {
      fail('Essa é a API Key da conta (já configurada no servidor), não um Profile Key. Se a conta só tem o Primary Profile, use “Adicionar a página do Primary Profile”.');
    }
    let profile;
    try { profile = await ayrshareService.fetchProfileByKey(key); }
    catch { fail(await explicarFalhaDoProfileKey(key), 422); }
    if (refId && profile.refId !== refId) fail('O Profile Key pertence a outro perfil. Copie a chave do perfil selecionado.', 422);
    if (profile.isPrimary || !profile.refId) fail('Essa chave aponta para o Primary Profile. Use “Adicionar a página do Primary Profile”.', 422);
    if (!profile.facebookConnected) fail('Este perfil ainda não tem Facebook conectado. Conecte a Página em Social Accounts na Ayrshare e tente novamente.', 422);
    const pageId = String(profile.facebookPageId || `ayrshare:${profile.refId}`);
    const pageName = profile.facebookPageName || profile.title;
    if (!pageName || pageId.length > 64) fail('A Ayrshare não retornou a identificação da página. Confira a conexão em Social Accounts.', 422);
    const db = require('../config/db');
    const result = await db.transaction(async (trx) => {
      // Serializa cadastros da mesma conta e preserva a página padrão.
      await trx('users').where({ id: req.session.userId }).forUpdate().first();
      let account = await trx('facebook_accounts').where({ user_id: req.session.userId }).first();
      if (!account) {
        await trx('facebook_accounts').insert({ user_id: req.session.userId, fb_user_id: `ayrshare:${req.session.userId}`, access_token: 'ayrshare:stub' });
        account = await trx('facebook_accounts').where({ user_id: req.session.userId }).first();
      }
      const pages = await trx('facebook_pages').where({ facebook_account_id: account.id });
      const existing = pages.find((p) => p.ayrshare_profile_key === key || p.page_id === pageId || p.page_id === `ayrshare:${profile.refId}`);
      if (existing) {
        if (existing.ayrshare_profile_key && existing.ayrshare_profile_key !== key) fail('Esta página já possui outro Profile Key. Atualize o vínculo no cartão existente.', 409);
        await trx('facebook_pages').where({ id: existing.id }).update({ ayrshare_profile_key: key, page_name: String(pageName).slice(0, 255), updated_at: trx.fn.now() });
        return { id: existing.id, page_name: pageName, existing: true };
      }
      const [id] = await trx('facebook_pages').insert({ facebook_account_id: account.id, page_id: pageId, page_name: String(pageName).slice(0, 255), page_access_token: 'ayrshare:stub', ayrshare_profile_key: key });
      return { id, page_name: pageName, existing: false };
    });
    res.json({ ok: true, page: result, aviso: result.existing ? 'Página já cadastrada; vínculo confirmado.' : 'Página adicionada. Você já pode usá-la como padrão.' });
  } catch (err) { next(err); }
}

module.exports = { setProfileKey, setInstagram, setX, listProfiles, addPage };
