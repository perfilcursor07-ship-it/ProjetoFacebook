const express = require('express');

const router = express.Router();
const dotsService = require('../services/dotsService');

/** Evita repetir try/catch em toda rota. */
function responder(res, next, promessa) {
  promessa.then((dados) => res.json(dados)).catch(next);
}

/** Jornada, ritmo, destino e imagem: escolhas da tela, iguais na prévia e na criação. */
function configuracaoDoCorpo(body = {}) {
  return {
    dias_semana: body.dias_semana,
    hora_inicio: body.hora_inicio,
    hora_fim: body.hora_fim,
    scan_minutos: body.scan_minutos,
    destino: body.destino,
    saida_quantidade: body.saida_quantidade,
    saida_minutos: body.saida_minutos,
    limite_dia: body.limite_dia,
    modo_imagem: body.modo_imagem,
    gerar_imagem_com_texto: body.gerar_imagem_com_texto === true,
  };
}

/** Prévia: o que a IA entendeu do pedido, antes de salvar. */
router.post('/previa', (req, res, next) =>
  responder(
    res,
    next,
    // A prévia precisa da mesma configuração da tela, senão mostraria um
    // resumo diferente do que o dot vai realmente fazer.
    dotsService.previa(req.body?.objetivo, configuracaoDoCorpo(req.body))
  ));

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
      // O plano que a prévia mostrou (com o que o editor tirou). Sem ele, o
      // pedido é interpretado de novo no servidor.
      plano: req.body?.plano || null,
      // Jornada e ritmo vêm da tela; o serviço normaliza e descarta o inválido.
      ...configuracaoDoCorpo(req.body),
    })
  ));

router.patch('/:id', (req, res, next) =>
  responder(res, next, dotsService.atualizar(req.session.userId, Number(req.params.id), {
    ...(req.body?.nome !== undefined ? { nome: req.body.nome } : {}),
    ...(req.body?.provedor !== undefined ? { provedor: req.body.provedor } : {}),
    ...(req.body?.objetivo !== undefined ? { objetivo: req.body.objetivo } : {}),
  })));

router.get('/:id', (req, res, next) =>
  responder(res, next, dotsService.detalhe(req.session.userId, Number(req.params.id))));

router.post('/:id/pausar', (req, res, next) =>
  responder(res, next, dotsService.alterarEstado(req.session.userId, Number(req.params.id), 'pausado')));

router.post('/:id/retomar', (req, res, next) =>
  responder(res, next, dotsService.alterarEstado(req.session.userId, Number(req.params.id), 'ativo')));

router.post('/:id/rodar', (req, res, next) =>
  responder(res, next, dotsService.rodarAgora(req.session.userId, Number(req.params.id))));

/** Escreve na hora um post específico do painel. */
router.post('/:id/posts/:postId/escrever', (req, res, next) =>
  responder(res, next, dotsService.escreverPostAgora(req.session.userId, Number(req.params.id), Number(req.params.postId))));

/** Acrescenta uma fonte: assunto para pesquisar, link ou nome de página. */
router.post('/:id/fontes', (req, res, next) =>
  responder(res, next, dotsService.adicionarFonte(req.session.userId, Number(req.params.id), {
    tipo: req.body?.tipo,
    texto: req.body?.texto,
  })));

/** Tira uma fonte do dot (a Biblioteca continua com ela). */
router.delete('/:id/fontes/:fonteId', (req, res, next) =>
  responder(res, next, dotsService.removerFonte(req.session.userId, Number(req.params.id), Number(req.params.fonteId))));

/** Gera com IA a imagem de uma matéria do dot (em segundo plano). */
router.post('/:id/materias/:matterId/imagem', (req, res, next) =>
  responder(res, next, dotsService.gerarImagemDaMateria(
    req.session.userId,
    Number(req.params.id),
    Number(req.params.matterId),
    { modo: req.body?.modo }
  )));

router.delete('/:id', (req, res, next) =>
  responder(res, next, dotsService.excluir(req.session.userId, Number(req.params.id))));

module.exports = router;
