/**
 * Miniatura das capas para as listas (/minhas-materias).
 *
 * A capa é salva com até 3600 px em JPEG qualidade 95 — vários MB cada. A
 * lista mostra 10 delas num quadradinho de ~50 px, e o navegador baixava o
 * arquivo inteiro de cada uma: a página ficava "carregando" por dezenas de MB.
 *
 *   /miniatura/fontes/user_1/materia_6629_….jpg  →  WebP de 240 px (~10 KB)
 *
 * Gerada uma vez e guardada em storage/tmp/miniaturas. O nome da capa tem
 * timestamp + aleatório, então a miniatura nunca fica velha: cache longo.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { env } = require('../config/env');

const LADO = 240;
const EXTENSOES = /\.(jpe?g|png|webp)$/i;

const raiz = () => path.resolve(env.storagePath);
const pastaCache = () => path.join(raiz(), 'tmp', 'miniaturas');

/** Mesma miniatura sendo pedida duas vezes ao mesmo tempo gera uma só. */
const gerando = new Map();

async function gerar(origem, destino) {
  const sharp = require('sharp');
  const temporario = `${destino}.${process.pid}.${Date.now()}.tmp`;
  await sharp(origem, { failOn: 'none', limitInputPixels: 40_000_000 })
    .rotate()
    .resize(LADO, LADO, { fit: 'cover', withoutEnlargement: true })
    .webp({ quality: 72 })
    .toFile(temporario);
  fs.renameSync(temporario, destino);
}

async function servirMiniatura(req, res, next) {
  try {
    const relativo = decodeURIComponent(String(req.path || '')).replace(/^\/+/, '');
    const origem = path.resolve(raiz(), relativo);
    // Só arquivos de imagem dentro do storage.
    if (!EXTENSOES.test(relativo) || !origem.startsWith(raiz() + path.sep)) return res.status(404).end();

    let info;
    try {
      info = fs.statSync(origem);
    } catch {
      return res.status(404).end();
    }
    if (!info.isFile()) return res.status(404).end();

    const chave = crypto
      .createHash('sha1')
      .update(`${relativo}|${info.size}|${info.mtimeMs}`)
      .digest('hex');
    const destino = path.join(pastaCache(), `${chave}.webp`);

    if (!fs.existsSync(destino)) {
      fs.mkdirSync(pastaCache(), { recursive: true });
      if (!gerando.has(destino)) {
        gerando.set(destino, gerar(origem, destino).finally(() => gerando.delete(destino)));
      }
      try {
        await gerando.get(destino);
      } catch (err) {
        // Imagem que o sharp não lê: entrega a original, como antes.
        console.warn(`[miniatura] ${relativo}: ${err.message}`);
        return res.sendFile(origem, { maxAge: '1d' });
      }
    }

    return res.sendFile(destino, {
      maxAge: '30d',
      immutable: true,
      headers: { 'Content-Type': 'image/webp' },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { servirMiniatura, LADO };
