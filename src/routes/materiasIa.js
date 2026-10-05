const express = require('express');
const controller = require('../controllers/materiasIaController');
const chatController = require('../controllers/materiaChatController');
const { uploadMatterImage } = require('../middleware/uploadMatterImage');

const router = express.Router();

// Chat de matérias (/conteudo → Matéria manual)
router.get('/chat/modelo', chatController.modelo);
router.get('/chat/conversas', chatController.listar);
router.post('/chat/conversas', chatController.criar);
router.post('/chat/conversas/excluir', chatController.excluirVarias);
router.get('/chat/conversas/:id', chatController.obter);
router.post('/chat/conversas/:id/duplicar', chatController.duplicar);
router.patch('/chat/conversas/:id', chatController.renomear);
router.patch('/chat/conversas/:id/fixar', chatController.fixar);
router.delete('/chat/conversas/:id', chatController.excluir);
router.post('/chat/conversas/:id/mensagens', chatController.enviar);
router.delete('/chat/conversas/:id/mensagens/:messageId', chatController.apagarDaMensagem);
router.post('/chat/mensagens/:messageId/materia', chatController.salvarMateria);
router.post('/chat/mensagens/:messageId/titulos-alternativos', chatController.gerarTitulosAlternativos);
router.post('/chat/titulo/corrigir', chatController.corrigirTitulo);
router.post('/chat/mensagens/:messageId/sugerir-imagens', chatController.sugerirImagens);
router.get('/chat/mensagens/:messageId/imagem-fonte', chatController.imagemDaFonte);
router.patch('/chat/mensagens/:messageId/conteudo', chatController.editarConteudo);
router.post('/chat/mensagens/:messageId/materias', chatController.salvarTodasAsMaterias);
router.post('/chat/pautas/rascunhos', chatController.salvarPautasComoRascunhos);
// Memória editorial compartilhada (ensinamentos do editor).
router.get('/chat/orientacoes', chatController.obterOrientacoes);
router.put('/chat/orientacoes', chatController.salvarOrientacoes);
router.post('/chat/orientacoes', chatController.salvarOrientacoes);

router.post('/pesquisar', controller.pesquisar);
router.post('/em-alta', controller.emAlta);
router.post('/radar-face', controller.radarFace);
router.post('/reescrever-link', controller.reescreverLink);
router.post('/gerar', controller.gerar);
router.post('/gerar-preview', controller.gerarPreview);
router.post('/manual', controller.criarManual);
router.post('/gerar-lote', controller.gerarLote);
router.post('/gerar-manual', (req, res, next) => {
  uploadMatterImage(req, res, (uploadError) => {
    if (uploadError) {
      return res.status(uploadError.status || 400).json({ error: uploadError.message });
    }
    return controller.gerarManual(req, res, next);
  });
});
// Ensinar IA a partir da matéria aberta (regra vale para as próximas).
router.get('/ensinamentos', controller.listarEnsinamentos);
router.post('/ensinar', controller.ensinarIaLivre);
router.post('/matters/:id/ensinar', controller.ensinarIa);

router.get('/matters', controller.listarMaterias);
router.post('/matters/excluir-lote', controller.removerMateriasLote);
router.post('/matters/sincronizar-engajamento', controller.sincronizarEngajamento);
router.get('/agenda/proximo-slot', controller.proximoSlotAgenda);
router.get('/matters/:id', controller.obterMateria);
router.put('/matters/:id', controller.atualizarMateria);
router.patch('/matters/:id', controller.atualizarMateria);
router.delete('/matters/:id', controller.removerMateria);
router.post('/matters/:id/publicar', controller.publicar);
router.post('/matters/:id/texto-x', controller.gerarTextoX);
router.post('/matters/:id/agendar', controller.agendar);
router.post('/matters/:id/desagendar', controller.desagendar);
router.post('/matters/:id/variacao', controller.gerarVariacao);
router.post('/matters/:id/gerar-reel', controller.gerarReel);
router.post('/matters/:id/views', controller.atualizarViews);
router.get('/matters/:id/views', controller.atualizarViews);
router.get('/matters/:id/engajamento-debug', controller.engajamentoDebug);
router.post('/matters/:id/sugerir-titulo', controller.sugerirTitulo);
router.get('/matters/:id/titulos-alternativos', controller.titulosAlternativos);
router.post('/matters/:id/titulos-alternativos', controller.titulosAlternativos);
router.post('/matters/:id/revisar-texto', controller.revisarTextoManual);
router.post('/matters/:id/reescrever-com-info', controller.reescreverComInfo);
router.post('/matters/:id/enriquecer-fontes', controller.enriquecerFontes);
router.post('/matters/:id/buscar-imagem-fonte', controller.buscarImagemFonte);
router.post('/matters/:id/sugerir-imagens', controller.sugerirImagens);
router.post('/matters/:id/aplicar-imagem-url', controller.aplicarImagemUrl);
router.post('/matters/:id/arte/colagem', controller.aplicarColagemDuasImagens);
router.post('/monitor', controller.monitorCriar);
router.get('/monitor', controller.monitorLista);
router.post('/monitor/:id/pausar', controller.monitorPausar);
router.post('/monitor/:id/retomar', controller.monitorRetomar);
router.get('/links', controller.linksLista);
router.post('/links', controller.linksSalvar);
router.delete('/links/:id', controller.linksRemover);

module.exports = router;
