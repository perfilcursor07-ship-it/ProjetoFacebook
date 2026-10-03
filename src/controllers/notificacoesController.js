function responderErro(res, next, err) {
  if (err?.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  return next(err);
}

async function paginaAdmin(_req, res) {
  return res.render('config-notificacoes', {
    title: 'Notificações',
  });
}

async function statusNtfy(req, res, next) {
  try {
    const status = await require('../services/furosAutopilotService').statusPainel(req.session.userId);
    return res.json({ ok: true, ntfy: status.config?.ntfy || {} });
  } catch (err) {
    return responderErro(res, next, err);
  }
}

async function salvarNtfy(req, res, next) {
  try {
    const status = await require('../services/furosAutopilotService').salvarNtfy(
      req.session.userId,
      req.body || {}
    );
    return res.json({ ok: true, ntfy: status.config?.ntfy || {} });
  } catch (err) {
    return responderErro(res, next, err);
  }
}

async function testarNtfy(req, res, next) {
  try {
    await require('../services/furosAutopilotService').testarNtfy(req.session.userId);
    return res.json({ ok: true });
  } catch (err) {
    return responderErro(res, next, err);
  }
}

module.exports = { paginaAdmin, statusNtfy, salvarNtfy, testarNtfy };
