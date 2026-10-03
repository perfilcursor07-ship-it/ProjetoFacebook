const express = require('express');
const multer = require('multer');
const cookiesController = require('../controllers/cookiesController');

const router = express.Router();

const uploadTxt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // mesmo teto aceito pelo ytDlpAuth
  fileFilter(_req, file, cb) {
    if (!file.originalname.toLowerCase().endsWith('.txt')) {
      return cb(new Error('Envie um arquivo .txt (formato Netscape cookies.txt).'));
    }
    cb(null, true);
  },
}).single('arquivo');

/** Upload é opcional: quando o conteúdo vem colado, o corpo é JSON. */
function talvezUpload(req, res, next) {
  if (!String(req.headers['content-type'] || '').includes('multipart/form-data')) {
    return next();
  }
  return uploadTxt(req, res, (err) => {
    if (err) {
      err.status = err.status || 400;
      return next(err);
    }
    next();
  });
}

router.get('/status', cookiesController.listarStatus);
router.get('/:plataforma/status', cookiesController.obterStatus);
router.post('/:plataforma/test', cookiesController.testar);
router.post('/:plataforma', talvezUpload, cookiesController.salvar);
router.delete('/:plataforma', cookiesController.remover);

module.exports = router;
