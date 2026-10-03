const express = require('express');

const router = express.Router();
const dotsService = require('../services/dotsService');

/** Evita repetir try/catch em toda rota. */
function responder(res, next, promessa) {
  promessa.then((dados) => res.json(dados)).catch(next);
}

/** Prévia: o que a IA entendeu do pedido, antes de salvar. */
router.post('/previa', (req, res, next) =>
  responder(res, next, dotsService.previa(req.body?.objetivo)));

/** Antes de /:id, senão o Express casaria "provedores" como id. */
router.get('/provedores', (_req, res) => res.json({ provedores: dotsService.provedores() }));

router.get('/', (req, res, next) =>
  responder(res, next, dotsService.listar(req.session.userId)));

router.post('/', (req, res, next) =>
  responder(
    res,
    next,
    dotsService.criar(req.session.userId, {
      objetivo: req.body?.objetivo,
      nome: req.body?.nome || null,
      provedor: req.body?.provedor || 'auto',
      facebookPageId: req.body?.facebook_page_id || null,
    })
  ));

router.patch('/:id', (req, res, next) =>
  responder(res, next, dotsService.atualizar(req.session.userId, Number(req.params.id), {
    ...(req.body?.nome !== undefined ? { nome: req.body.nome } : {}),
    ...(req.body?.provedor !== undefined ? { provedor: req.body.provedor } : {}),
  })));

router.get('/:id', (req, res, next) =>
  responder(res, next, dotsService.detalhe(req.session.userId, Number(req.params.id))));

router.post('/:id/pausar', (req, res, next) =>
  responder(res, next, dotsService.alterarEstado(req.session.userId, Number(req.params.id), 'pausado')));

router.post('/:id/retomar', (req, res, next) =>
  responder(res, next, dotsService.alterarEstado(req.session.userId, Number(req.params.id), 'ativo')));

router.post('/:id/rodar', (req, res, next) =>
  responder(res, next, dotsService.rodarAgora(req.session.userId, Number(req.params.id))));

router.delete('/:id', (req, res, next) =>
  responder(res, next, dotsService.excluir(req.session.userId, Number(req.params.id))));

module.exports = router;
