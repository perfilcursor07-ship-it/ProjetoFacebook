/**
 * Banco de imagens do editor (/materia-manual e rascunho): fotos limpas,
 * sem o título nem a marca da arte, para reaproveitar como capa sem gerar
 * de novo com IA.
 *
 * Cada imagem é copiada para storage/banco-imagens/user_X — as fontes das
 * matérias (storage/fontes) são apagadas quando a capa muda, e o banco não
 * pode perder a imagem junto. Junto vai uma miniatura leve para a grade.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { env } = require('../config/env');
const BancoImagens = require('../models/BancoImagens');

const ORIGENS = new Set(['ia', 'upload', 'chatgpt', 'grok', 'sistema']);
const LIMITE_PIXELS = 40_000_000;
const PREFIXO_PUBLICO = '/media/banco-imagens/';

function erro(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function pastaDoUsuario(userId) {
  return path.resolve(env.storagePath, 'banco-imagens', `user_${Number(userId)}`);
}

function urlPublica(relativo) {
  return `/media/${String(relativo).replace(/\\/g, '/')}`;
}

/** URL pública de uma imagem do banco deste usuário (para validar o que vem do navegador). */
function ehUrlDoBanco(url, userId) {
  return new RegExp(
    `^/media/banco-imagens/user_${Number(userId)}/[a-f0-9]{16,64}\\.jpg$`,
    'i'
  ).test(String(url || '').trim());
}

function paraCliente(row) {
  if (!row) return null;
  return {
    id: row.id,
    url: urlPublica(row.arquivo),
    miniatura: urlPublica(row.miniatura),
    origem: row.origem,
    gerador: row.gerador || null,
    titulo: row.titulo || '',
    largura: row.largura || null,
    altura: row.altura || null,
    usos: Number(row.usos) || 0,
    criadaEm: row.created_at,
    credito: ['ia', 'chatgpt', 'grok'].includes(row.origem) ? 'Imagem gerada por IA' : 'Reprodução/Internet',
  };
}

/**
 * Guarda a imagem no banco. O hash é do arquivo recebido: a mesma imagem
 * registrada pela geração e depois pela importação de storage/fontes vira
 * um registro só.
 */
async function registrar({ userId, buffer, origem = 'upload', gerador = null, titulo = null, prompt = null, matterId = null }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw erro('Imagem vazia.');
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid < 1) throw erro('Usuário inválido.');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const existente = await BancoImagens.findByHash(uid, hash);
  if (existente) return { item: paraCliente(existente), nova: false };

  const nome = hash.slice(0, 24);
  const relativo = `banco-imagens/user_${uid}/${nome}.jpg`;
  const relativoMini = `banco-imagens/user_${uid}/${nome}_m.jpg`;
  const destino = path.resolve(env.storagePath, relativo);
  const destinoMini = path.resolve(env.storagePath, relativoMini);
  fs.mkdirSync(path.dirname(destino), { recursive: true });

  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'error', limitInputPixels: LIMITE_PIXELS })
      .rotate()
      .resize(3600, 3600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 93, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toFile(destino);
    await sharp(destino)
      .resize(420, 525, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toFile(destinoMini);
  } catch (err) {
    for (const f of [destino, destinoMini]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* sem arquivo */ }
    }
    if (/heif|heic|bad seek|bitstream not supported/i.test(String(err?.message || ''))) {
      throw erro('Formato HEIF/HEIC não é aceito. Envie PNG, JPG ou WebP.');
    }
    throw erro('Não foi possível ler a imagem. Envie PNG, JPG ou WebP válido.');
  }

  try {
    const id = await BancoImagens.create({
      user_id: uid,
      origem: ORIGENS.has(origem) ? origem : 'upload',
      gerador: gerador ? String(gerador).slice(0, 20) : null,
      titulo: titulo ? String(titulo).replace(/\[\[|\]\]|\*\*/g, '').trim().slice(0, 255) || null : null,
      prompt: prompt ? String(prompt).slice(0, 4000) : null,
      arquivo: relativo,
      miniatura: relativoMini,
      largura: meta?.width || null,
      altura: meta?.height || null,
      hash,
      matter_id: Number(matterId) > 0 ? Number(matterId) : null,
    });
    return { item: paraCliente(await BancoImagens.findById(id)), nova: true };
  } catch (err) {
    // Duas gravações simultâneas da mesma imagem: fica a primeira.
    const corrida = await BancoImagens.findByHash(uid, hash);
    if (corrida) return { item: paraCliente(corrida), nova: false };
    throw err;
  }
}

/**
 * Versão "não atrapalha": a geração de capa nunca falha porque o banco não
 * conseguiu guardar a cópia. Aceita o buffer ou a URL /media/fontes/… salva.
 */
function registrarEmSegundoPlano({ publicUrl = null, ...dados }) {
  Promise.resolve()
    .then(async () => {
      let buffer = dados.buffer;
      if (!buffer && publicUrl) {
        const absoluto = resolveMatterSourcePathPublico(publicUrl);
        if (!absoluto) return;
        buffer = fs.readFileSync(absoluto);
      }
      if (buffer) await registrar({ ...dados, buffer });
    })
    .catch((err) => console.warn('[banco-imagens] não guardou a cópia:', err.message));
}

function resolveMatterSourcePathPublico(publicUrl) {
  const normalizado = String(publicUrl || '').replace(/\\/g, '/');
  if (!normalizado.startsWith('/media/fontes/')) return null;
  const raiz = path.resolve(env.storagePath, 'fontes');
  const absoluto = path.resolve(env.storagePath, normalizado.slice('/media/'.length));
  if (!absoluto.startsWith(raiz + path.sep) || !fs.existsSync(absoluto)) return null;
  return absoluto;
}

async function listar(userId, filtros = {}) {
  const limite = Math.min(120, Math.max(1, Number(filtros.limite) || 60));
  const linhas = await BancoImagens.listar(Number(userId), { ...filtros, limite });
  const temMais = linhas.length > limite;
  return {
    itens: linhas.slice(0, limite).map(paraCliente),
    temMais,
    contagem: await BancoImagens.contarPorOrigem(Number(userId)),
  };
}

async function remover(userId, id) {
  const row = await BancoImagens.findById(Number(id));
  if (!row || Number(row.user_id) !== Number(userId)) throw erro('Imagem não encontrada.', 404);
  await BancoImagens.delete(row.id);
  const raiz = path.resolve(env.storagePath, 'banco-imagens');
  for (const rel of [row.arquivo, row.miniatura]) {
    const absoluto = path.resolve(env.storagePath, rel);
    if (!absoluto.startsWith(raiz + path.sep)) continue;
    try { if (fs.existsSync(absoluto)) fs.unlinkSync(absoluto); } catch { /* já removido */ }
  }
}

async function renomear(userId, id, titulo) {
  const row = await BancoImagens.findById(Number(id));
  if (!row || Number(row.user_id) !== Number(userId)) throw erro('Imagem não encontrada.', 404);
  await BancoImagens.update(row.id, { titulo: String(titulo || '').trim().slice(0, 255) || null });
  return paraCliente(await BancoImagens.findById(row.id));
}

/** Conta o uso quando a imagem vira capa (a grade mostra as mais usadas). */
async function marcarUsoPorUrl(userId, url) {
  if (!ehUrlDoBanco(url, userId)) return;
  const row = await BancoImagens.findByArquivo(Number(userId), String(url).trim().slice('/media/'.length));
  if (row) await BancoImagens.marcarUso(row.id);
}

/**
 * Traz para o banco as fotos limpas que o sistema já tinha em
 * storage/fontes/user_X. Arquivos `chat_*` só nascem da geração com IA no
 * /materia-manual; os `materia_*` são fotos (geradas, enviadas ou
 * recortadas) que já viraram capa.
 */
async function importarDoSistema(userId, { limite = 400 } = {}) {
  const uid = Number(userId);
  const pasta = path.resolve(env.storagePath, 'fontes', `user_${uid}`);
  if (!fs.existsSync(pasta)) return { importadas: 0, repetidas: 0, falhas: 0 };
  const arquivos = fs
    .readdirSync(pasta)
    .filter((n) => /\.(jpe?g|png|webp)$/i.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(pasta, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, Math.max(1, Math.min(1000, Number(limite) || 400)));

  const AiMatters = require('../models/AiMatters');
  const AiChatMessages = require('../models/AiChatMessages');
  const titulos = new Map();
  const tituloDe = async (nome) => {
    const m = nome.match(/^(materia|chat)_(\d+)_/);
    if (!m) return null;
    const chave = `${m[1]}:${m[2]}`;
    if (!titulos.has(chave)) {
      const row = m[1] === 'materia'
        ? await AiMatters.findById(Number(m[2])).catch(() => null)
        : await AiChatMessages.findById(Number(m[2])).catch(() => null);
      titulos.set(chave, { titulo: row?.titulo || null, matterId: m[1] === 'materia' ? Number(m[2]) : row?.matter_id || null });
    }
    return titulos.get(chave);
  };

  let importadas = 0;
  let repetidas = 0;
  let falhas = 0;
  for (const { n } of arquivos) {
    try {
      const info = await tituloDe(n);
      const { nova } = await registrar({
        userId: uid,
        buffer: fs.readFileSync(path.join(pasta, n)),
        origem: n.startsWith('chat_') ? 'ia' : 'sistema',
        titulo: info?.titulo || null,
        matterId: info?.matterId || null,
      });
      if (nova) importadas += 1;
      else repetidas += 1;
    } catch {
      falhas += 1;
    }
  }
  return { importadas, repetidas, falhas };
}

/**
 * Importa as imagens que já estão na conta do ChatGPT (página "Biblioteca")
 * ou do Grok, usando o Chrome do servidor já logado (o mesmo da geração).
 * É raspagem de tela: se o site mudar, a importação devolve uma mensagem
 * clara e o editor ainda pode baixar e enviar as imagens manualmente.
 */
const PAGINAS_GERADORES = Object.freeze({
  chatgpt: {
    nome: 'ChatGPT',
    url: process.env.BANCO_IMAGENS_CHATGPT_URL || 'https://chatgpt.com/library',
    login: /auth\/login|log-in|\/login(?:[/?#]|$)/i,
  },
  grok: {
    nome: 'Grok',
    url: process.env.BANCO_IMAGENS_GROK_URL || 'https://grok.com/imagine/favorites',
    login: /accounts\.x\.ai|x\.com\/i\/flow\/login|grok\.com\/sign-in/i,
  },
});
const importacoesAtivas = new Set();

async function importarDoGerador(userId, gerador, { limite = 24 } = {}) {
  const config = PAGINAS_GERADORES[gerador];
  if (!config) throw erro('Gerador desconhecido. Use ChatGPT ou Grok.');
  const chave = `${userId}:${gerador}`;
  if (importacoesAtivas.has(chave)) throw erro(`Já existe uma importação do ${config.nome} em andamento.`, 409);
  importacoesAtivas.add(chave);
  const max = Math.min(60, Math.max(1, Number(limite) || 24));
  let page = null;
  try {
    const web = require('./imagemWebService');
    page = await web.abrirAba(config.url);
    if (gerador === 'chatgpt') {
      const chatgpt = require('./chatgptImageService');
      await chatgpt.garantirSessaoChatgpt(page, page.context(), await chatgpt.credenciaisChatgpt());
      if (!/\/library/i.test(page.url())) {
        await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      }
    }
    if (config.login.test(page.url())) {
      throw erro(`O ${config.nome} não está logado no Chrome do servidor. Entre em /claude e tente de novo.`, 401);
    }

    // A galeria carrega aos poucos: rola até juntar imagens suficientes.
    const vistas = new Set();
    const limiteTempo = Date.now() + 45_000;
    let paradas = 0;
    while (Date.now() < limiteTempo && vistas.size < max && paradas < 4) {
      await page.waitForTimeout(1800);
      const srcs = await page.evaluate(() =>
        [...document.querySelectorAll('main img, img')]
          .filter((img) => {
            const r = img.getBoundingClientRect();
            const alt = (img.getAttribute('alt') || '').toLowerCase();
            return (img.naturalWidth || 0) >= 256 && (img.naturalHeight || 0) >= 256 &&
              r.width >= 80 && r.height >= 80 && !/avatar|profile|perfil|logo/.test(alt);
          })
          .map((img) => img.currentSrc || img.src)
          .filter((src) => src && !src.startsWith('data:image/svg'))
      ).catch(() => []);
      const antes = vistas.size;
      srcs.forEach((s) => vistas.add(s));
      paradas = vistas.size === antes ? paradas + 1 : 0;
      await page.mouse.wheel(0, 2200).catch(() => {});
    }
    if (!vistas.size) {
      throw erro(
        `Não encontrei imagens na página do ${config.nome} (${config.url}). Baixe as imagens pelo site e use “Enviar imagens”.`,
        404
      );
    }

    const baixar = gerador === 'chatgpt'
      ? (src) => require('./chatgptImageService').baixarImagemDaPagina(page, src)
      : (src) => web.baixarImagem(page, src, { nome: config.nome });
    let importadas = 0;
    let repetidas = 0;
    let falhas = 0;
    for (const src of [...vistas].slice(0, max)) {
      try {
        const { buffer } = await baixar(src);
        const { nova } = await registrar({ userId, buffer, origem: gerador, gerador, titulo: `Importada do ${config.nome}` });
        if (nova) importadas += 1;
        else repetidas += 1;
      } catch {
        falhas += 1;
      }
    }
    return { importadas, repetidas, falhas, encontradas: vistas.size };
  } finally {
    importacoesAtivas.delete(chave);
    if (page) await require('./abaEmSegundoPlano').fecharAba(page).catch(() => {});
  }
}

module.exports = {
  PREFIXO_PUBLICO,
  ehUrlDoBanco,
  registrar,
  registrarEmSegundoPlano,
  resolveMatterSourcePathPublico,
  listar,
  remover,
  renomear,
  marcarUsoPorUrl,
  importarDoSistema,
  importarDoGerador,
};
