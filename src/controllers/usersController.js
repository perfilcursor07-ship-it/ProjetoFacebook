const bcrypt = require('bcryptjs');
const Users = require('../models/Users');

const ACCESS_LEVELS = new Set(['usuario', 'administrador']);

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function redirectWith(res, type, message) {
  return res.redirect(`/usuarios?${type}=${encodeURIComponent(message)}`);
}

async function index(req, res, next) {
  try {
    const users = await Users.list();
    const db = require('../config/db');

    // Todas as páginas do sistema, com a conta dona, para o administrador
    // liberar sem precisar saber de quem é cada uma.
    const paginas = await db('facebook_pages as p')
      .leftJoin('facebook_accounts as c', 'c.id', 'p.facebook_account_id')
      .leftJoin('users as d', 'd.id', 'c.user_id')
      .orderBy('p.page_name', 'asc')
      .select('p.id', 'p.page_name', 'p.ayrshare_profile_key', 'd.nome as dono');

    // { userId: Set(pageId) } para marcar os checkboxes.
    const concessoes = {};
    try {
      for (const l of await db('user_facebook_pages').select('user_id', 'facebook_page_id')) {
        (concessoes[l.user_id] ||= []).push(Number(l.facebook_page_id));
      }
    } catch (err) {
      if (err?.code !== 'ER_NO_SUCH_TABLE') throw err;
    }

    return res.render('usuarios', {
      title: 'Usuários',
      users,
      paginas,
      concessoes,
      modulosCatalogo: require('../services/modulosMateriaService').MODULOS,
      modulosDe: (u) => require('../services/modulosMateriaService').permitidos(u),
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const nome = clean(req.body.nome, 150);
    const email = clean(req.body.email, 191).toLowerCase();
    const senha = String(req.body.senha || '');
    const nivelAcesso = ACCESS_LEVELS.has(req.body.nivel_acesso) ? req.body.nivel_acesso : 'usuario';

    if (nome.length < 2) return redirectWith(res, 'error', 'Informe o nome do usuário');
    if (!email) return redirectWith(res, 'error', 'Informe o usuário ou e-mail de acesso');
    if (senha.length < 8) return redirectWith(res, 'error', 'A senha deve ter pelo menos 8 caracteres');
    if (await Users.findByEmail(email)) return redirectWith(res, 'error', 'Este acesso já está cadastrado');

    await Users.create({
      nome,
      email,
      senha_hash: await bcrypt.hash(senha, 12),
      nivel_acesso: nivelAcesso,
      marca_categoria: 'ÚLTIMAS',
    });
    return redirectWith(res, 'success', 'Usuário cadastrado com sucesso');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return redirectWith(res, 'error', 'Este acesso já está cadastrado');
    return next(err);
  }
}

async function updateAccess(req, res, next) {
  try {
    const id = Number(req.params.id);
    const nivelAcesso = String(req.body.nivel_acesso || '');
    if (!Number.isInteger(id) || id < 1 || !ACCESS_LEVELS.has(nivelAcesso)) {
      return redirectWith(res, 'error', 'Dados de nível de acesso inválidos');
    }
    if (id === Number(req.user.id) && nivelAcesso !== 'administrador') {
      return redirectWith(res, 'error', 'Você não pode remover seu próprio acesso administrativo');
    }

    const target = await Users.findById(id);
    if (!target) return redirectWith(res, 'error', 'Usuário não encontrado');

    if (target.nivel_acesso === 'administrador' && nivelAcesso !== 'administrador') {
      const admins = Number((await Users.countByAccess('administrador'))?.total || 0);
      if (admins <= 1) {
        return redirectWith(res, 'error', 'É necessário manter ao menos um administrador');
      }
    }

    await Users.update(id, { nivel_acesso: nivelAcesso });
    return redirectWith(res, 'success', 'Nível de acesso atualizado');
  } catch (err) {
    return next(err);
  }
}

/**
 * Páginas liberadas para cada usuário publicar.
 *
 * A posse da página continua de quem conectou o Facebook; isto é só
 * permissão, para o administrador não precisar revincular a mesma página no
 * Ayrshare a cada usuário novo.
 */
async function updatePages(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return redirectWith(res, 'error', 'Usuário inválido');

    const alvo = await Users.findById(id);
    if (!alvo) return redirectWith(res, 'error', 'Usuário não encontrado');

    // Um checkbox só vem como string; vários vêm como array.
    const bruto = req.body.paginas;
    const pedidos = (Array.isArray(bruto) ? bruto : bruto ? [bruto] : [])
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0);

    const db = require('../config/db');
    // Só id de página que existe de verdade entra — o form pode vir adulterado.
    const validos = pedidos.length ? await db('facebook_pages').whereIn('id', pedidos).pluck('id') : [];

    await db.transaction(async (trx) => {
      await trx('user_facebook_pages').where({ user_id: id }).del();
      if (validos.length) {
        await trx('user_facebook_pages').insert(
          validos.map((pageId) => ({
            user_id: id,
            facebook_page_id: Number(pageId),
            concedido_por: Number(req.user.id),
          }))
        );
      }
    });

    // Página padrão: é a que aparece já selecionada quando este usuário publica.
    const padraoPedido = Number(req.body.pagina_padrao || 0);
    await Users.setDefaultFacebookPageId(id, padraoPedido > 0 ? padraoPedido : null);

    // Valida contra o que o usuário realmente alcança (páginas próprias + as
    // concedidas acima) e zera se não alcançar. Também cobre o caso de a página
    // padrão ter acabado de perder a permissão.
    const { defaultPageIdForUser } = require('../services/facebookPageResolver');
    const padraoFinal = await defaultPageIdForUser(id);

    const base = validos.length
      ? `${alvo.nome} agora publica em ${validos.length} página(s)`
      : `${alvo.nome} ficou sem página liberada`;

    // Escolha recusada não pode sumir calada: o admin precisa saber por quê.
    if (padraoPedido > 0 && !padraoFinal) {
      return redirectWith(
        res,
        'error',
        `${base}, mas a página marcada como padrão não ficou liberada para ${alvo.nome} — marque a caixa dela também.`
      );
    }

    return redirectWith(res, 'success', padraoFinal ? `${base}, com página padrão definida` : base);
  } catch (err) {
    return next(err);
  }
}
/**
 * Módulos da área Matérias que o usuário pode abrir.
 *
 * Grava sempre, inclusive lista vazia: "nenhum módulo" é escolha válida e
 * precisa ser distinguível de "nunca configurado" (que libera tudo).
 */
async function updateModules(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return redirectWith(res, 'error', 'Usuário inválido');

    const alvo = await Users.findById(id);
    if (!alvo) return redirectWith(res, 'error', 'Usuário não encontrado');

    const modulos = require('../services/modulosMateriaService');
    const json = modulos.sanear(req.body.modulos);
    await Users.update(id, { modulos_materia: json });

    const n = JSON.parse(json).length;
    return redirectWith(
      res,
      'success',
      n
        ? `${alvo.nome} agora acessa ${n} módulo(s)`
        : `${alvo.nome} ficou sem nenhum módulo de Matérias`
    );
  } catch (err) {
    return next(err);
  }
}
async function remove(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return redirectWith(res, 'error', 'Usuário inválido');
    }
    if (id === Number(req.user.id)) {
      return redirectWith(res, 'error', 'Você não pode remover a própria conta');
    }

    const target = await Users.findById(id);
    if (!target) return redirectWith(res, 'error', 'Usuário não encontrado');

    if (target.nivel_acesso === 'administrador') {
      const admins = Number((await Users.countByAccess('administrador'))?.total || 0);
      if (admins <= 1) {
        return redirectWith(res, 'error', 'É necessário manter ao menos um administrador');
      }
    }

    await Users.remove(id);
    return redirectWith(res, 'success', 'Usuário removido com sucesso');
  } catch (err) {
    return next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const id = Number(req.params.id);
    const senha = String(req.body.senha || '');
    if (!Number.isInteger(id) || id < 1) {
      return redirectWith(res, 'error', 'Usuário inválido');
    }
    if (senha.length < 8) {
      return redirectWith(res, 'error', 'A nova senha deve ter pelo menos 8 caracteres');
    }
    if (!(await Users.findById(id))) {
      return redirectWith(res, 'error', 'Usuário não encontrado');
    }

    await Users.update(id, { senha_hash: await bcrypt.hash(senha, 12) });
    return redirectWith(res, 'success', 'Senha redefinida com sucesso');
  } catch (err) {
    return next(err);
  }
}

module.exports = { index, create, updateAccess, updatePages, updateModules, remove, resetPassword };
