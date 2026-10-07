const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/requireAuth');
const { uploadMatterImage } = require('../middleware/uploadMatterImage');
const AiMatters = require('../models/AiMatters');
const materiaIaService = require('../services/materiaIaService');
const {
  composeMatterArtwork,
  applyBrandArtworkToResult,
  storeMatterSourceImage,
  cropMatterSourceImage,
  removeMatterSourceImage,
} = require('../services/matterArtworkService');
const { publishEditorialPhoto } = require('../services/editorialPublishService');

const router = express.Router();
router.use(requireAuth);

const chatgptImageJobs = new Map();
const CHATGPT_JOB_TTL_MS = 30 * 60 * 1000;

function cleanupChatgptImageJobs() {
  const limite = Date.now() - CHATGPT_JOB_TTL_MS;
  for (const [id, job] of chatgptImageJobs) {
    if (job.updatedAt < limite) chatgptImageJobs.delete(id);
  }
}

/**
 * Cópia da imagem limpa (sem título/marca) no banco de imagens, para o editor
 * reaproveitar depois sem gerar de novo. Nunca atrapalha a geração.
 */
function guardarNoBanco(publicUrl, { origem = 'ia', ...dados }) {
  require('../services/bancoImagensService').registrarEmSegundoPlano({ publicUrl, origem, ...dados });
}

function publicChatgptImageJob(job) {
  return {
    ok: job.status !== 'error',
    jobId: job.id,
    status: job.status,
    ...(job.result || {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
  };
}

router.get('/matters/:id/arte/marca-overlay', async (req, res, next) => {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID da matéria inválido' });
    }

    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }

    const Users = require('../models/Users');
    const user = await Users.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const title = String(req.query.titulo || req.query.title || matter.titulo || '').trim();
    if (!title) return res.status(400).json({ error: 'Informe o título para a marca' });

    const { buildBrandOverlayPng } = require('../services/editorialCardService');
    const png = await buildBrandOverlayPng({ title, user });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=20');
    return res.send(png);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.post('/matters/:id/arte', (req, res, next) => {
  uploadMatterImage(req, res, async (uploadError) => {
    if (uploadError) {
      return res.status(uploadError.status || 400).json({ error: uploadError.message });
    }

    let storedSource = null;
    try {
      const matterId = Number(req.params.id);
      if (!Number.isInteger(matterId) || matterId < 1) {
        return res.status(400).json({ error: 'ID da matéria inválido' });
      }

      const matter = await AiMatters.findById(matterId);
      if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
        return res.status(404).json({ error: 'Matéria não encontrada' });
      }
      if (matter.status === 'publicado') {
        return res.status(400).json({ error: 'A imagem de uma matéria publicada não pode ser alterada' });
      }
      if (!req.file) return res.status(400).json({ error: 'Selecione uma imagem para continuar' });

      storedSource = await storeMatterSourceImage({
        userId: req.session.userId,
        matterId,
        buffer: req.file.buffer,
      });
      guardarNoBanco(storedSource.publicUrl, {
        userId: req.session.userId,
        origem: 'upload',
        titulo: matter.titulo,
        matterId,
      });
      const artwork = await composeMatterArtwork({
        userId: req.session.userId,
        matterId,
        sourceUrl: storedSource.publicUrl,
        title: String(req.body.titulo || matter.titulo || '').trim(),
        force: true,
      });

      const {
        atualizarCreditoImagemNaMateria,
        atualizarFonteCreditoDaImagem,
        CREDITO_IMAGEM_FALLBACK,
      } = require('../services/editorialGuidelinesFb');
      const materiaAtual = artwork.matter?.materia || matter.materia;
      const fonteCreditoAtual = artwork.matter?.fonte_credito ?? matter.fonte_credito;
      await AiMatters.update(matterId, {
        materia: atualizarCreditoImagemNaMateria(
          materiaAtual,
          CREDITO_IMAGEM_FALLBACK
        ),
        fonte_credito: atualizarFonteCreditoDaImagem(
          fonteCreditoAtual,
          CREDITO_IMAGEM_FALLBACK
        ),
      });
      artwork.matter = await AiMatters.findById(matterId);

      return res.json({
        ok: true,
        matter: artwork.matter,
        imagemUrl: artwork.publicUrl,
        hasLogo: artwork.hasLogo,
      });
    } catch (err) {
      if (storedSource) removeMatterSourceImage(storedSource.publicUrl);
      if (err.status) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  });
});

router.post('/matters/:id/arte/regenerar', async (req, res, next) => {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID da matéria inválido' });
    }

    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'A arte de uma matéria publicada não pode ser alterada' });
    }

    const sourceUrl =
      matter.imagem_fonte_url ||
      (!matter.imagem_path && /^https?:\/\//i.test(String(matter.imagem_url || ''))
        ? matter.imagem_url
        : null);

    if (!sourceUrl) {
      return res.status(400).json({
        error: 'A foto original não está disponível. Escolha outra imagem para gerar a arte novamente.',
      });
    }

    const artwork = await composeMatterArtwork({
      userId: req.session.userId,
      matterId,
      sourceUrl,
      title: matter.titulo,
      force: true,
      model: req.body?.modelo || req.body?.model || req.body?.arte_modelo || null,
      zoom: req.body?.zoom,
      offsetX: req.body?.offsetX ?? req.body?.offset_x,
      offsetY: req.body?.offsetY ?? req.body?.offset_y,
    });

    return res.json({
      ok: true,
      matter: artwork.matter,
      imagemUrl: artwork.publicUrl,
      arteModelo: artwork.modelId,
      hasLogo: artwork.hasLogo,
      titulo: artwork.matter?.titulo || matter.titulo,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.post('/matters/:id/arte/enquadrar', async (req, res, next) => {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID da matéria inválido' });
    }

    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'A arte de uma matéria publicada não pode ser alterada' });
    }

    // Sempre a FOTO de origem — nunca a arte já composta com Minha marca (/media/artes/).
    let sourceUrl = String(matter.imagem_fonte_url || '').trim();
    if (/\/media\/artes\//i.test(sourceUrl)) {
      sourceUrl = '';
    }
    if (
      !sourceUrl &&
      !matter.imagem_path &&
      /^https?:\/\//i.test(String(matter.imagem_url || '')) &&
      !/\/media\/artes\//i.test(String(matter.imagem_url || ''))
    ) {
      sourceUrl = String(matter.imagem_url).trim();
    }

    if (!sourceUrl) {
      return res.status(400).json({
        error:
          'A foto original não está disponível para enquadrar. Escolha outra imagem (o zoom não pode usar a arte com marca).',
      });
    }

    const zoom = req.body?.zoom != null ? Number(req.body.zoom) : 100;
    const offsetX = req.body?.offsetX != null
      ? Number(req.body.offsetX)
      : req.body?.offset_x != null
        ? Number(req.body.offset_x)
        : 50;
    const offsetY = req.body?.offsetY != null
      ? Number(req.body.offsetY)
      : req.body?.offset_y != null
        ? Number(req.body.offset_y)
        : 50;

    // Zoom/pan só na foto; Minha marca é desenhada por cima depois (sem zoom).
    const artwork = await composeMatterArtwork({
      userId: req.session.userId,
      matterId,
      sourceUrl,
      title: String(req.body?.titulo || matter.titulo || '').trim(),
      force: true,
      zoom,
      offsetX,
      offsetY,
    });

    return res.json({
      ok: true,
      matter: artwork.matter,
      imagemUrl: artwork.publicUrl,
      imagemFonteUrl: artwork.matter?.imagem_fonte_url || sourceUrl,
      arteModelo: artwork.modelId,
      hasLogo: artwork.hasLogo,
      zoom,
      offsetX,
      offsetY,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.post('/matters/:id/arte/recortar', async (req, res, next) => {
  let storedSource = null;
  let generatedSourceToRemove = null;
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID da matéria inválido' });
    }

    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'A imagem de uma matéria publicada não pode ser alterada' });
    }

    const generatedSource = String(req.body?.sourceUrl || '').trim();
    // Versões geradas para esta matéria, ou no chat do /materia-manual antes de
    // o rascunho existir (chat_ID_*), sempre dentro da pasta do próprio usuário.
    const generatedPattern = new RegExp(
      `^/media/fontes/user_${Number(req.session.userId)}/(?:materia_${matterId}|chat_[0-9]+)_[0-9]+_[a-f0-9]+\\.jpg$`,
      'i'
    );
    if (generatedSource && !generatedPattern.test(generatedSource)) {
      return res.status(400).json({ error: 'A imagem temporária informada não pertence a esta matéria' });
    }
    generatedSourceToRemove = generatedSource || null;
    let sourceUrl = generatedSource || String(matter.imagem_fonte_url || '').trim();
    if (/\/media\/artes\//i.test(sourceUrl)) sourceUrl = '';
    if (
      !sourceUrl &&
      !matter.imagem_path &&
      (/^https?:\/\//i.test(String(matter.imagem_url || '')) ||
        String(matter.imagem_url || '').startsWith('/media/fontes/')) &&
      !/\/media\/artes\//i.test(String(matter.imagem_url || ''))
    ) {
      sourceUrl = String(matter.imagem_url).trim();
    }
    if (!sourceUrl) {
      return res.status(400).json({
        error: 'A foto original não está disponível para recortar. Escolha outra imagem primeiro.',
      });
    }

    storedSource = await cropMatterSourceImage({
      userId: req.session.userId,
      matterId,
      sourceUrl,
      left: req.body?.left,
      top: req.body?.top,
      width: req.body?.width,
      height: req.body?.height,
    });

    const artwork = await composeMatterArtwork({
      userId: req.session.userId,
      matterId,
      sourceUrl: storedSource.publicUrl,
      title: String(req.body?.titulo || matter.titulo || '').trim(),
      force: true,
      zoom: 100,
      offsetX: 50,
      offsetY: 50,
      fitMode: 'contain',
    });
    if (generatedSourceToRemove && generatedSourceToRemove !== storedSource.publicUrl) {
      removeMatterSourceImage(generatedSourceToRemove);
      generatedSourceToRemove = null;
    }

    return res.json({
      ok: true,
      matter: artwork.matter,
      imagemUrl: artwork.publicUrl,
      imagemFonteUrl: storedSource.publicUrl,
      hasLogo: artwork.hasLogo,
    });
  } catch (err) {
    if (storedSource) removeMatterSourceImage(storedSource.publicUrl);
    if (generatedSourceToRemove) removeMatterSourceImage(generatedSourceToRemove);
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.post('/matters/:id/arte/gerar-chatgpt', async (req, res, next) => {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID da matéria inválido' });
    }
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'A imagem de uma matéria publicada não pode ser alterada' });
    }

    let sourceUrl = String(matter.imagem_fonte_url || '').trim();
    if (/\/media\/artes\//i.test(sourceUrl)) sourceUrl = '';
    if (!sourceUrl && !matter.imagem_path && !/\/media\/artes\//i.test(String(matter.imagem_url || ''))) {
      sourceUrl = String(matter.imagem_url || '').trim();
    }
    // A ilustração simbólica não envia foto ao ChatGPT: só a versão com
    // referência precisa de uma foto de origem.
    if (!sourceUrl && req.body?.modo !== 'simbolica') {
      return res.status(400).json({ error: 'Escolha uma foto de origem antes de gerar uma versão com o ChatGPT.' });
    }

    cleanupChatgptImageJobs();
    const jobId = crypto.randomUUID();
    const userId = Number(req.session.userId);
    const requestedPrompt = req.body?.prompt;
    const requestedMode = req.body?.modo === 'simbolica' ? 'simbolica' : 'referencia';
    const requestedTitle = String(req.body?.titulo || matter.titulo || '').trim();
    const job = {
      id: jobId,
      userId,
      matterId,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: null,
      error: '',
    };
    chatgptImageJobs.set(jobId, job);

    // Responde imediatamente. Cada trabalho abre sua própria página e sua
    // própria conversa no Chrome isolado, sem manter o clique preso ao anterior.
    setImmediate(async () => {
      let storedSource = null;
      try {
        const chatgptImageService = require('../services/imagemIaService');
        const generated = await chatgptImageService.gerarImagem({
          sourceUrl,
          prompt: requestedPrompt,
          titulo: requestedTitle,
          materia: matter.materia || '',
          recoveryKey: `${userId}:${matterId}`,
          modo: requestedMode,
        });
        storedSource = await storeMatterSourceImage({
          userId,
          matterId,
          buffer: generated.buffer,
        });
        job.status = 'ready';
        job.result = {
          imagemFonteUrl: storedSource.publicUrl,
          prompt: generated.prompt,
          model: generated.model,
          gerador: generated.gerador,
        };
        guardarNoBanco(storedSource.publicUrl, {
          userId,
          gerador: generated.gerador,
          titulo: requestedTitle,
          prompt: generated.prompt,
          matterId,
        });
      } catch (err) {
        if (storedSource) removeMatterSourceImage(storedSource.publicUrl);
        job.status = 'error';
        job.error = err.message || 'O ChatGPT não conseguiu gerar a imagem.';
        job.errorCode = err.code || '';
        console.error(`[chatgpt-imagem:${jobId}]`, job.error);
      } finally {
        job.updatedAt = Date.now();
      }
    });

    return res.status(202).json(publicChatgptImageJob(job));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[chatgpt-imagem]', err.message);
    return next(err);
  }
});

/** Gerador escolhido em /claude, para o modal de recorte mostrar o nome certo. */
router.get('/arte/gerador-imagem', async (_req, res, next) => {
  try {
    return res.json({ ok: true, ...(await require('../services/imagemIaService').geradorAtual()) });
  } catch (err) {
    return next(err);
  }
});

router.get('/matters/:id/arte/gerar-chatgpt/:jobId', async (req, res, next) => {
  try {
    const matterId = Number(req.params.id);
    const job = chatgptImageJobs.get(String(req.params.jobId || ''));
    if (!job || job.matterId !== matterId || job.userId !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Geração de imagem não encontrada ou expirada.' });
    }
    return res.status(job.status === 'running' ? 202 : 200).json(publicChatgptImageJob(job));
  } catch (err) {
    return next(err);
  }
});

router.post('/matters/:id/arte/recuperar-chatgpt', async (req, res, next) => {
  let storedSource = null;
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID da matéria inválido' });
    }
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'A imagem de uma matéria publicada não pode ser alterada' });
    }

    const chatgptImageService = require('../services/imagemIaService');
    const generated = await chatgptImageService.recuperarImagem({
      recoveryKey: `${req.session.userId}:${matterId}`,
    });
    storedSource = await storeMatterSourceImage({
      userId: req.session.userId,
      matterId,
      buffer: generated.buffer,
    });
    guardarNoBanco(storedSource.publicUrl, {
      userId: req.session.userId,
      gerador: generated.gerador,
      titulo: matter.titulo,
      matterId,
    });
    return res.json({
      ok: true,
      imagemFonteUrl: storedSource.publicUrl,
      model: generated.model,
    });
  } catch (err) {
    if (storedSource) removeMatterSourceImage(storedSource.publicUrl);
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[chatgpt-imagem:recuperar]', err.message);
    return next(err);
  }
});

/**
 * Mesma geração com ChatGPT do editor, mas para a resposta do /materia-manual
 * que ainda não virou rascunho. A imagem fica em /media/fontes/user_X/chat_ID_*
 * e o chat a usa como foto da capa ao salvar.
 */
async function mensagemDoChatDoUsuario(req) {
  const messageId = Number(req.params.messageId);
  if (!Number.isInteger(messageId) || messageId < 1) {
    const err = new Error('Mensagem inválida');
    err.status = 400;
    throw err;
  }
  const AiChatMessages = require('../models/AiChatMessages');
  const row = await AiChatMessages.findByIdWithChat(messageId);
  if (!row || Number(row.chat_user_id) !== Number(req.session.userId) || row.role !== 'assistant') {
    const err = new Error('Mensagem não encontrada');
    err.status = 404;
    throw err;
  }
  return row;
}

function fonteValidaDoChat(url, userId) {
  const valor = String(url || '').trim();
  if (/^https?:\/\//i.test(valor)) return valor.slice(0, 1500);
  const propria = new RegExp(`^/media/fontes/user_${Number(userId)}/[a-z]+_[0-9]+_[0-9]+_[a-f0-9]+\\.jpg$`, 'i');
  // Foto escolhida no banco de imagens do editor.
  if (require('../services/bancoImagensService').ehUrlDoBanco(valor, userId)) return valor;
  return propria.test(valor) ? valor : '';
}

router.post('/chat/mensagens/:messageId/arte/gerar-chatgpt', async (req, res, next) => {
  try {
    const row = await mensagemDoChatDoUsuario(req);
    const userId = Number(req.session.userId);
    const modo = req.body?.modo === 'simbolica' ? 'simbolica' : 'referencia';
    const sourceUrl = fonteValidaDoChat(req.body?.sourceUrl, userId);
    if (modo === 'referencia' && !sourceUrl) {
      return res.status(400).json({ error: 'Escolha uma foto de origem antes de gerar uma versão com o ChatGPT.' });
    }

    cleanupChatgptImageJobs();
    const job = {
      id: crypto.randomUUID(),
      userId,
      messageId: row.id,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: null,
      error: '',
    };
    chatgptImageJobs.set(job.id, job);

    setImmediate(async () => {
      let storedSource = null;
      try {
        const chatgptImageService = require('../services/imagemIaService');
        const generated = await chatgptImageService.gerarImagem({
          sourceUrl,
          prompt: req.body?.prompt,
          titulo: String(req.body?.titulo || row.titulo || '').trim(),
          materia: String(row.content || '').slice(0, 4000),
          recoveryKey: `${userId}:chat${row.id}`,
          modo,
        });
        storedSource = await storeMatterSourceImage({
          userId,
          matterId: 0,
          prefixo: `chat_${row.id}`,
          buffer: generated.buffer,
        });
        job.status = 'ready';
        job.result = {
          imagemFonteUrl: storedSource.publicUrl,
          prompt: generated.prompt,
          model: generated.model,
          gerador: generated.gerador,
        };
        guardarNoBanco(storedSource.publicUrl, {
          userId,
          gerador: generated.gerador,
          titulo: String(req.body?.titulo || row.titulo || '').trim(),
          prompt: generated.prompt,
        });
      } catch (err) {
        if (storedSource) removeMatterSourceImage(storedSource.publicUrl);
        job.status = 'error';
        job.error = err.message || 'O ChatGPT não conseguiu gerar a imagem.';
        job.errorCode = err.code || '';
        console.error(`[chatgpt-imagem:chat:${job.id}]`, job.error);
      } finally {
        job.updatedAt = Date.now();
      }
    });

    return res.status(202).json(publicChatgptImageJob(job));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.get('/chat/mensagens/:messageId/arte/gerar-chatgpt/:jobId', async (req, res, next) => {
  try {
    const job = chatgptImageJobs.get(String(req.params.jobId || ''));
    if (
      !job ||
      job.messageId !== Number(req.params.messageId) ||
      job.userId !== Number(req.session.userId)
    ) {
      return res.status(404).json({ error: 'Geração de imagem não encontrada ou expirada.' });
    }
    return res.status(job.status === 'running' ? 202 : 200).json(publicChatgptImageJob(job));
  } catch (err) {
    return next(err);
  }
});

router.post('/chat/mensagens/:messageId/arte/recuperar-chatgpt', async (req, res, next) => {
  let storedSource = null;
  try {
    const row = await mensagemDoChatDoUsuario(req);
    const chatgptImageService = require('../services/imagemIaService');
    const generated = await chatgptImageService.recuperarImagem({
      recoveryKey: `${req.session.userId}:chat${row.id}`,
    });
    storedSource = await storeMatterSourceImage({
      userId: req.session.userId,
      matterId: 0,
      prefixo: `chat_${row.id}`,
      buffer: generated.buffer,
    });
    guardarNoBanco(storedSource.publicUrl, {
      userId: req.session.userId,
      gerador: generated.gerador,
      titulo: row.titulo,
    });
    return res.json({ ok: true, imagemFonteUrl: storedSource.publicUrl, model: generated.model });
  } catch (err) {
    if (storedSource) removeMatterSourceImage(storedSource.publicUrl);
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[chatgpt-imagem:chat:recuperar]', err.message);
    return next(err);
  }
});

function pageId(body = {}) {
  const raw = body.facebookPageId ?? body.facebook_page_id;
  return raw != null && raw !== '' ? Number(raw) : null;
}

function publicationType(body = {}) {
  return (body.tipoPublicacao ?? body.tipo_publicacao) === 'foto' ? 'foto' : 'texto';
}

async function addArtwork(userId, result) {
  return applyBrandArtworkToResult(userId, result);
}

async function publishGenerated(userId, result, facebookPageId, type) {
  if (type === 'foto') {
    if (!result.matter?.imagem_path) {
      result.avisos = [...(result.avisos || []), 'A publicação não foi enviada porque a arte final não pôde ser criada.'];
      return result;
    }
    const published = await publishEditorialPhoto({
      userId,
      matterId: result.matter.id,
      facebookPageId,
      title: result.artigo.titulo,
      body: result.artigo.materia,
    });
    return {
      ...result,
      publication: published,
      fbPostUrl: published.fbPostUrl,
      matter: await AiMatters.findById(result.matter.id),
    };
  }

  const published = await materiaIaService.publicarMateria(userId, result.matter.id, {
    facebook_page_id: facebookPageId,
    tipo_publicacao: 'texto',
    titulo: result.artigo.titulo,
    materia: result.artigo.materia,
    sync: true,
  });
  return {
    ...result,
    publication: published,
    fbPostUrl: published.fbPostUrl,
    matter: await AiMatters.findById(result.matter.id),
  };
}

router.post('/gerar', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.topico?.titulo) return res.status(400).json({ error: 'Envie um tópico válido' });
    const facebookPageId = pageId(body);
    const type = publicationType(body);
    const wantsPublish = String(body.status || '').toLowerCase() === 'publicado';
    if (wantsPublish && !facebookPageId) {
      return res.status(400).json({ error: 'Selecione a página do Facebook para publicar' });
    }

    let result = await materiaIaService.gerarCompleto({
      userId: req.session.userId,
      topico: body.topico,
      facebookPageId,
      tipoPublicacao: type,
      status: 'rascunho',
      investigativa: Boolean(body.investigativa),
    });
    result = await addArtwork(req.session.userId, result);
    if (wantsPublish) result = await publishGenerated(req.session.userId, result, facebookPageId, type);

    return res.json({
      ok: true,
      ...result,
      preview: result.artigo,
      link: result.fbPostUrl || null,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/gerar-preview', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.topico?.titulo) return res.status(400).json({ error: 'Envie um tópico válido' });
    const type = publicationType(body);
    const facebookPageId = pageId(body);
    const generated = await materiaIaService.gerarCompleto({
      userId: req.session.userId,
      topico: body.topico,
      facebookPageId,
      tipoPublicacao: type,
      status: 'rascunho',
      investigativa: Boolean(body.investigativa),
    });
    const result = await addArtwork(req.session.userId, generated);
    return res.json({ ok: true, ...result, preview: result.artigo });
  } catch (err) {
    return next(err);
  }
});

router.post('/matters/:id/publicar', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const matter = await AiMatters.findById(Number(req.params.id));
    if (!matter || Number(matter.user_id) !== Number(userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    const type = publicationType(req.body);
    const facebookPageId = pageId(req.body);
    // null = editor nao mandou opiniao; vale a preferencia salva na materia.
    const pedidoInstagram =
      req.body.publicarInstagram ?? req.body.publicar_instagram ?? req.body.instagram ?? null;
    const pedidoX = req.body.publicarX ?? req.body.publicar_x ?? req.body.x ?? null;
    // null preserva o comportamento anterior: Facebook marcado por padrão.
    const pedidoFacebook =
      req.body.publicarFacebook ?? req.body.publicar_facebook ?? req.body.facebook ?? null;

    if (type === 'foto') {
      const title = String(req.body.titulo || matter.titulo || '').trim();
      const sourceUrl = matter.imagem_fonte_url ||
        (!matter.imagem_path && /^https?:\/\//i.test(String(matter.imagem_url || '')) ? matter.imagem_url : null);
      let imagemUrl = matter.imagem_url;
      if (sourceUrl) {
        const artwork = await composeMatterArtwork({
          userId,
          matterId: matter.id,
          sourceUrl,
          title,
          // A arte salva em imagem_path já contém o zoom e o deslocamento
          // escolhidos no editor. Reutilize esse arquivo final quando ele
          // continua válido; forçar a composição aqui apagava o enquadramento
          // e publicava a foto centralizada no Facebook/Instagram.
          force: false,
        });
        imagemUrl = artwork.publicUrl;
      } else if (!matter.imagem_path && !matter.imagem_url) {
        return res.status(422).json({ error: 'Gere a arte com título e logomarca antes de publicar' });
      }
      const published = await publishEditorialPhoto({
        userId,
        matterId: matter.id,
        facebookPageId,
        title,
        body: req.body.materia || matter.materia,
        publicarFacebook: pedidoFacebook,
        publicarInstagram: pedidoInstagram,
        publicarX: pedidoX,
        textoX: req.body.textoX ?? req.body.texto_x ?? null,
        imagemXUrl: req.body.imagemXUrl ?? req.body.imagem_x_url ?? null,
      });
      return res.json({
        ok: true,
        ...published,
        link: published.fbPostUrl || published.instagramPostUrl || published.xPostUrl || null,
        imagemUrl,
      });
    }

    const published = await materiaIaService.publicarMateria(userId, matter.id, {
      facebook_page_id: facebookPageId,
      tipo_publicacao: 'texto',
      titulo: req.body.titulo,
      materia: req.body.materia,
      sync: Boolean(req.body.sync),
      forcar: Boolean(req.body.forcar || req.body.republicar),
      publicar_facebook: pedidoFacebook,
      publicar_instagram: pedidoInstagram,
      publicar_x: pedidoX,
      texto_x: req.body.textoX ?? req.body.texto_x ?? null,
      imagem_x_url: req.body.imagemXUrl ?? req.body.imagem_x_url ?? null,
    });
    return res.status(published.queued ? 202 : 200).json({
      ok: true,
      ...published,
      link: published.fbPostUrl || published.instagramPostUrl || published.xPostUrl || null,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/gerar-lote', async (req, res, next) => {
  try {
    const topics = Array.isArray(req.body?.topicos) ? req.body.topicos.slice(0, 5) : [];
    const facebookPageId = pageId(req.body);
    const type = publicationType(req.body);
    if (!topics.length) return res.status(400).json({ error: 'Selecione ao menos um tópico' });
    if (!facebookPageId) return res.status(400).json({ error: 'Selecione a página do Facebook' });

    const criados = [];
    const erros = [];
    for (const topic of topics) {
      try {
        let result = await materiaIaService.gerarCompleto({
          userId: req.session.userId,
          topico: topic,
          facebookPageId,
          tipoPublicacao: type,
          status: 'rascunho',
        });
        result = await addArtwork(req.session.userId, result);
        if (type === 'foto' && !result.matter?.imagem_path) {
          erros.push({ titulo: topic.titulo || '—', erro: result.avisos?.at(-1) || 'Arte não gerada' });
          criados.push({ matterId: result.matter?.id, titulo: result.artigo?.titulo, rascunho: true });
          continue;
        }
        result = await publishGenerated(req.session.userId, result, facebookPageId, type);
        criados.push({
          matterId: result.matter.id,
          publicationId: result.publication?.publicationId,
          titulo: result.artigo.titulo,
        });
      } catch (err) {
        erros.push({ titulo: topic?.titulo || '—', erro: err.message });
      }
    }
    return res.json({ ok: true, criados, erros });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
