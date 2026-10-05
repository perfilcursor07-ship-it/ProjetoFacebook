const chatService = require('../services/materiaChatService');
const materiaModelos = require('../services/materiaModelosService');
const { env } = require('../config/env');

const { nomeModeloHumano } = materiaModelos;

function nivelModelo(modelo, provider) {
  const valor = String(modelo || '').toLowerCase();
  if (provider === 'claude') return 'Médio';
  if (valor.includes('flash')) return 'Flash';
  if (valor.includes('pro')) return 'Pro';
  return '';
}

function montarModeloChat(tipo) {
  const deepseek = require('../services/deepseekService');
  // Os dois modos do /materia-manual usam a tarefa `conversa` no serviço de
  // streaming. O modo Matéria muda o prompt e as ferramentas editoriais, não
  // o provedor. Manter a mesma tarefa aqui evita mostrar DeepSeek enquanto a
  // resposta está sendo gerada pelo gateway do Claude.
  const tarefa = 'conversa';
  if (deepseek.usarTokenFree(tarefa)) {
    const modelo = env.tokenFreeGateway?.model || 'claude-sonnet-5';
    return {
      provider: 'claude',
      modelo,
      nome: nomeModeloHumano(modelo),
      nivel: nivelModelo(modelo, 'claude'),
      origem: 'token-free-gateway',
    };
  }
  if (deepseek.usarClaude(tarefa)) {
    const modelo = env.claudeWriterModel || 'claude-sonnet-5';
    return {
      provider: 'claude',
      modelo,
      nome: nomeModeloHumano(modelo),
      nivel: nivelModelo(modelo, 'claude'),
      origem: 'anthropic',
    };
  }
  const modelo = env.deepseekWriterModel || env.deepseekModel || 'deepseek-v4-flash';
  return {
    provider: 'deepseek',
    modelo,
    nome: nomeModeloHumano(modelo),
    nivel: nivelModelo(modelo, 'deepseek'),
    origem: 'deepseek',
  };
}

/** O seletor só faz sentido quando a conversa passa pelo Token-Free Gateway. */
function gatewayEscreveAsMaterias() {
  return require('../services/deepseekService').usarTokenFree('conversa');
}

async function modelo(req, res, next) {
  try {
    const opcoes = gatewayEscreveAsMaterias() ? await materiaModelos.listarHabilitados() : [];
    return res.json({
      ok: true,
      modelos: {
        materia: montarModeloChat('materia'),
        livre: montarModeloChat('livre'),
      },
      opcoes,
    });
  } catch (err) {
    return next(err);
  }
}

async function listar(req, res, next) {
  try {
    const conversas = await chatService.listarConversas(req.session.userId);
    return res.json({ conversas });
  } catch (err) {
    return next(err);
  }
}

async function criar(req, res, next) {
  try {
    const chat = await chatService.criarConversa({
      userId: req.session.userId,
      titulo: req.body?.titulo || null,
      modo: req.body?.modo === 'livre' ? 'livre' : 'materia',
      tom: req.body?.tom || 'natural',
    });
    return res.status(201).json({ ok: true, chat });
  } catch (err) {
    return next(err);
  }
}

async function obter(req, res, next) {
  try {
    const chat = await chatService.obterConversa({
      userId: req.session.userId,
      chatId: Number(req.params.id),
    });
    return res.json({ chat });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function duplicar(req, res, next) {
  try {
    const chat = await chatService.duplicarConversa({
      userId: req.session.userId,
      chatId: Number(req.params.id),
    });
    return res.status(201).json({ ok: true, chat });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function renomear(req, res, next) {
  try {
    const chat = await chatService.renomearConversa({
      userId: req.session.userId,
      chatId: Number(req.params.id),
      titulo: req.body?.titulo,
    });
    return res.json({ ok: true, chat });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function fixar(req, res, next) {
  try {
    const chat = await chatService.fixarConversa({
      userId: req.session.userId,
      chatId: Number(req.params.id),
      fixada: req.body?.fixada,
    });
    return res.json({ ok: true, chat });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function excluir(req, res, next) {
  try {
    await chatService.excluirConversa({
      userId: req.session.userId,
      chatId: Number(req.params.id),
    });
    return res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Exclui de uma vez as conversas marcadas na sidebar. */
async function excluirVarias(req, res, next) {
  try {
    const resultado = await chatService.excluirConversas({
      userId: req.session.userId,
      chatIds: req.body?.ids,
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Editar um pedido: apaga a mensagem e tudo que veio depois dela. */
async function apagarDaMensagem(req, res, next) {
  try {
    const resultado = await chatService.apagarMensagemEmDiante({
      userId: req.session.userId,
      chatId: Number(req.params.id),
      messageId: Number(req.params.messageId),
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * Resposta em NDJSON: cada linha é um evento (passo da pesquisa, pedaço do
 * texto, fim). O front lê com fetch + ReadableStream.
 */
async function enviar(req, res, next) {
  const body = req.body || {};
  const chatIdParam = req.params.id && req.params.id !== 'nova' ? Number(req.params.id) : null;

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let encerrado = false;
  // `close` no IncomingMessage tambem acontece quando o corpo do POST foi
  // recebido normalmente. Marcar o stream como encerrado nesse evento corta
  // todos os passos/deltas de geracoes mais longas. `aborted` representa o
  // cancelamento prematuro da requisicao; no response, `close` so e falha se
  // ainda nao houve `end`.
  req.on('aborted', () => {
    encerrado = true;
  });
  res.on('close', () => {
    if (!res.writableEnded) encerrado = true;
  });

  const enviarEvento = (evento) => {
    if (encerrado || res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify(evento)}\n`);
  };

  // Transcrição local pode levar alguns minutos. Mantém o stream vivo sem
  // adicionar etapas visíveis enquanto yt-dlp/Whisper processam o áudio.
  const heartbeat = setInterval(() => enviarEvento({ tipo: 'ping' }), 15_000);

  try {
    // Só aceita modelos liberados pelo administrador em /claude.
    const modeloEscolhido = gatewayEscreveAsMaterias()
      ? await materiaModelos.resolverModelo(body.modelo)
      : null;
    const { comModelo } = require('../services/tokenFreeGatewayService');
    await comModelo(modeloEscolhido, () => chatService.responder({
      userId: req.session.userId,
      chatId: chatIdParam,
      texto: body.texto || body.mensagem || '',
      pesquisarWeb: ['1', 'true', 'on', 'sim'].includes(
        String(body.pesquisarWeb ?? body.pesquisar_web ?? '').toLowerCase()
      ),
      tom: body.tom || 'natural',
      periodo: body.periodo || undefined,
      palavrasChave: body.palavrasChave || null,
      modo: body.modo === 'pautas' ? 'pautas' : 'escrever',
      tipoConversa: body.tipoConversa === 'livre' || body.tipo_conversa === 'livre'
        ? 'livre'
        : 'materia',
      transcreverVideo:
        body.transcreverVideo == null
          ? true
          : ['1', 'true', 'on', 'sim'].includes(String(body.transcreverVideo).toLowerCase()),
      onEvent: enviarEvento,
    }));
    clearInterval(heartbeat);
    return res.end();
  } catch (err) {
    clearInterval(heartbeat);
    // Erro de banco/driver traz SQL e dados na mensagem: fica no log, não na tela.
    const ehErroInterno = Boolean(err.sql || err.sqlMessage || err.code);
    // A conversa foi excluída (na lista ou em outra aba) durante a pesquisa:
    // a chave estrangeira recusa a resposta. Não é falha do sistema.
    const conversaExcluida = err.code === 'ER_NO_REFERENCED_ROW_2';
    if (conversaExcluida) {
      console.warn('[materia-chat] conversa excluída durante a geração; resposta descartada');
    } else if (ehErroInterno) {
      console.error('[materia-chat] erro interno:', err.code || '', err.sqlMessage || err.message);
    }
    const paraUsuario = conversaExcluida
      ? 'Esta conversa foi excluída enquanto a resposta era gerada, então a resposta não foi salva. Abra uma nova conversa e envie o pedido de novo.'
      : ehErroInterno
        ? 'Não consegui salvar esta resposta agora. Tente enviar de novo.'
        : err.message || 'Falha ao gerar a resposta';

    if (!res.headersSent) {
      if (ehErroInterno) return res.status(500).json({ error: paraUsuario });
      return next(err);
    }
    enviarEvento({ tipo: 'erro', erro: paraUsuario });
    return res.end();
  }
}

async function salvarMateria(req, res, next) {
  try {
    const resultado = await chatService.salvarMateriaDoChat({
      userId: req.session.userId,
      messageId: Number(req.params.messageId),
      facebookPageId: req.body?.facebookPageId || req.body?.facebook_page_id || null,
      imagemUrl: req.body?.imagemUrl || req.body?.imagem_url || null,
      creditoImagem: req.body?.creditoImagem || req.body?.credito_imagem || null,
      indice: req.body?.indice ?? req.body?.index ?? null,
      // Título alternativo escolhido pelo editor no chat (opcional).
      titulo: req.body?.titulo || req.body?.tituloEscolhido || null,
      // Título que o editor escreveu (não é uma das sugestões da IA).
      tituloProprio: req.body?.tituloProprio === true,
    });
    return res.status(201).json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** "Corrigir texto": só ortografia/pontuação do título que o editor escreveu. */
async function corrigirTitulo(req, res, next) {
  try {
    const { corrigirTitulo: corrigir } = require('../services/tituloCorrecaoService');
    return res.json({ ok: true, ...(await corrigir(req.body?.titulo)) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Gera 3 títulos para a resposta atual antes de ela virar rascunho. */
async function gerarTitulosAlternativos(req, res, next) {
  try {
    const resultado = await chatService.gerarTitulosAlternativosDaMensagem({
      userId: req.session.userId,
      messageId: Number(req.params.messageId),
      tituloAtual: req.body?.tituloAtual || req.body?.titulo || null,
      tom: req.body?.tom || null,
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Texto da resposta editado pelo editor no chat, antes de salvar. */
async function editarConteudo(req, res, next) {
  try {
    const resultado = await chatService.editarConteudoDaMensagem({
      userId: req.session.userId,
      messageId: Number(req.params.messageId),
      conteudo: req.body?.conteudo ?? req.body?.content ?? '',
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Capa que vem do próprio link da resposta (vídeo, post ou reportagem). */
async function imagemDaFonte(req, res, next) {
  try {
    const resultado = await chatService.imagemDaFonteDaMensagem({
      userId: req.session.userId,
      messageId: Number(req.params.messageId),
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Fotos sugeridas (Google Images etc.) para a resposta antes de salvar. */
async function sugerirImagens(req, res, next) {
  try {
    const resultado = await chatService.sugerirImagensDaMensagem({
      userId: req.session.userId,
      messageId: Number(req.params.messageId),
      consulta: req.body?.q || req.body?.consulta || null,
      limite: req.body?.limite || 12,
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Salva todas as matérias de uma resposta que trouxe várias. */
async function salvarTodasAsMaterias(req, res, next) {
  try {
    const resultado = await chatService.salvarTodasAsMateriasDoChat({
      userId: req.session.userId,
      messageId: Number(req.params.messageId),
      facebookPageId: req.body?.facebookPageId || req.body?.facebook_page_id || null,
      creditoImagem: req.body?.creditoImagem || req.body?.credito_imagem || null,
      indices: req.body?.indices ?? null,
    });
    return res.status(201).json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Gera e salva rascunhos diretamente a partir das pautas selecionadas. */
async function salvarPautasComoRascunhos(req, res, next) {
  try {
    const resultado = await chatService.salvarPautasComoRascunhos({
      userId: req.session.userId,
      pautas: req.body?.pautas,
      facebookPageId: req.body?.facebookPageId || req.body?.facebook_page_id || null,
      pesquisarWeb: req.body?.pesquisarWeb !== false && req.body?.pesquisar_web !== false,
      periodo: req.body?.periodo || '30d',
    });
    return res.status(201).json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * "Ensinar a IA" no chat: memória editorial do editor.
 * O editor escreve as regras uma vez e elas valem para as próximas matérias.
 */
async function obterOrientacoes(req, res, next) {
  try {
    const learning = require('../services/editorialLearningService');
    const dados = await learning.obterOrientacoes(req.session.userId);
    return res.json({ ok: true, ...dados });
  } catch (err) {
    return next(err);
  }
}

async function salvarOrientacoes(req, res, next) {
  try {
    const learning = require('../services/editorialLearningService');
    const texto = String(req.body?.orientacoes ?? req.body?.texto ?? '');
    if (texto.length > 8000) {
      return res.status(400).json({ error: 'Orientações muito longas. Resuma em regras curtas.' });
    }
    const acrescentar = req.body?.acrescentar === true || req.body?.modo === 'acrescentar';
    const salvo = acrescentar
      ? await learning.acrescentarOrientacao(req.session.userId, texto)
      : await learning.salvarOrientacoes(req.session.userId, texto);
    return res.json({ ok: true, ...salvo });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  corrigirTitulo,
  modelo,
  listar,
  criar,
  obter,
  duplicar,
  renomear,
  fixar,
  excluir,
  excluirVarias,
  apagarDaMensagem,
  enviar,
  salvarMateria,
  gerarTitulosAlternativos,
  sugerirImagens,
  imagemDaFonte,
  editarConteudo,
  salvarTodasAsMaterias,
  salvarPautasComoRascunhos,
  obterOrientacoes,
  salvarOrientacoes,
};
