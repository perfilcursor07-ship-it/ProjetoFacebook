const Users = require('../models/Users');

function isApiRequest(req) {
  return req.originalUrl.startsWith('/api/') || req.xhr || req.headers.accept?.includes('application/json');
}

/**
 * Atualiza o usuário da requisição a partir do banco. Assim, mudanças de nível
 * de acesso entram em vigor imediatamente, sem exigir um novo login.
 */
async function loadCurrentUser(req, res, next) {
  try {
    if (!req.session?.userId) return next();

    const user = await Users.findById(req.session.userId);
    if (!user) {
      req.session.userId = null;
      req.session.userName = null;
      req.user = null;
      res.locals.user = null;
      return next();
    }

    req.user = user;
    res.locals.user = {
      id: user.id,
      nome: user.nome,
      email: user.email,
      nivel_acesso: user.nivel_acesso || 'usuario',
      // O menu usa isto para esconder módulo sem permissão.
      modulos_materia: user.modulos_materia ?? null,
    };
    // O menu de toda página lê daqui para esconder módulo sem permissão.
    res.locals.modulosPermitidos = require('../services/modulosMateriaService').permitidos(user);
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.nivel_acesso === 'administrador') return next();

  if (isApiRequest(req)) {
    return res.status(403).json({ error: 'Acesso exclusivo para administradores' });
  }
  return res.redirect('/dashboard?erro=acesso-negado');
}

module.exports = { loadCurrentUser, requireAdmin };
