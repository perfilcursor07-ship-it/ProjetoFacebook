/**
 * Banco de imagens do editor — fotos limpas (sem título nem marca) para
 * escolher como capa no /materia-manual e no rascunho sem gerar de novo.
 */
const express = require('express');
const path = require('path');
const multer = require('multer');
const { requireAuth } = require('../middleware/requireAuth');
const banco = require('../services/bancoImagensService');

const router = express.Router();
router.use(requireAuth);

const TIPOS = new Set(['image/png', 'image/jpeg', 'image/webp']);
const EXTENSOES = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 30 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    // Imagem colada (Ctrl+V) chega como "image.png"; o tipo basta.
    if (!TIPOS.has(file.mimetype) || (ext && !EXTENSOES.has(ext))) {
      const e = new Error('Envie imagens PNG, JPG ou WebP de até 15 MB.');
      e.status = 400;
      return cb(e);
    }
    return cb(null, true);
  },
}).array('imagens', 30);

function responderErro(res, next, err) {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? 'Cada imagem pode ter até 15 MB.' : 'Envie no máximo 30 imagens por vez.',
    });
  }
  return next(err);
}

router.get('/', async (req, res, next) => {
  try {
    const origem = ['ia', 'upload', 'chatgpt', 'grok', 'sistema'].includes(req.query.origem)
      ? req.query.origem
      : null;
    const data = await banco.listar(req.session.userId, {
      origem,
      q: String(req.query.q || '').slice(0, 80),
      limite: req.query.limite,
      pagina: req.query.pagina,
    });
    return res.json({ ok: true, ...data });
  } catch (err) {
    return responderErro(res, next, err);
  }
});

router.post('/upload', (req, res, next) => {
  upload(req, res, async (falha) => {
    if (falha) return responderErro(res, next, falha);
    try {
      const arquivos = Array.isArray(req.files) ? req.files : [];
      if (!arquivos.length) return res.status(400).json({ error: 'Escolha pelo menos uma imagem.' });
      const itens = [];
      const erros = [];
      for (const arquivo of arquivos) {
        try {
          const nome = path.parse(arquivo.originalname || '').name.replace(/[_-]+/g, ' ').trim();
          const { item } = await banco.registrar({
            userId: req.session.userId,
            buffer: arquivo.buffer,
            origem: 'upload',
            titulo: nome && nome.toLowerCase() !== 'image' ? nome : null,
          });
          itens.push(item);
        } catch (err) {
          erros.push(`${arquivo.originalname || 'imagem'}: ${err.message}`);
        }
      }
      if (!itens.length) return res.status(400).json({ error: erros[0] || 'Nenhuma imagem foi aceita.' });
      return res.json({ ok: true, itens, erros });
    } catch (err) {
      return responderErro(res, next, err);
    }
  });
});

router.post('/importar-sistema', async (req, res, next) => {
  try {
    return res.json({ ok: true, ...(await banco.importarDoSistema(req.session.userId)) });
  } catch (err) {
    return responderErro(res, next, err);
  }
});

router.post('/importar/:gerador', async (req, res, next) => {
  try {
    const resultado = await banco.importarDoGerador(req.session.userId, req.params.gerador, {
      limite: req.body?.limite,
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (!err.status) console.error('[banco-imagens:importar]', err.message);
    return responderErro(res, next, err.status ? err : Object.assign(err, { status: 502 }));
  }
});

router.post('/usar', async (req, res, next) => {
  try {
    await banco.marcarUsoPorUrl(req.session.userId, req.body?.url);
    return res.json({ ok: true });
  } catch (err) {
    return responderErro(res, next, err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const item = await banco.renomear(req.session.userId, req.params.id, req.body?.titulo);
    return res.json({ ok: true, item });
  } catch (err) {
    return responderErro(res, next, err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await banco.remover(req.session.userId, req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return responderErro(res, next, err);
  }
});

module.exports = router;
