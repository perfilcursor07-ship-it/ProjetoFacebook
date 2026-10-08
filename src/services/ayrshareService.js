const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const { env } = require('../config/env');
const { storageAbsolutePath } = require('./downloadService');
const { limitarLegendaInstagram } = require('./editorialGuidelinesFb');

const API = 'https://api.ayrshare.com/api';
const INSTAGRAM_HASHTAG_LIMIT = 5;
const X_MAX_WEIGHTED_LENGTH = 280;
const X_SHORT_URL_LENGTH = 23;

function twitterCodePointWeight(char) {
  const cp = char.codePointAt(0);
  // Mesmas faixas leves usadas pelo X: caracteres latinos, pontuacao comum e
  // acentos contam 1. Emoji e a maior parte dos demais simbolos contam 2.
  return (
    (cp >= 0x0000 && cp <= 0x10ff) ||
    (cp >= 0x2000 && cp <= 0x200d) ||
    (cp >= 0x2010 && cp <= 0x201f) ||
    (cp >= 0x2032 && cp <= 0x2037)
  )
    ? 1
    : 2;
}

function twitterTextTokens(value) {
  const text = String(value || '');
  const tokens = [];
  const urlRegex = /https?:\/\/[^\s]+/giu;
  let cursor = 0;
  let match;

  const addText = (chunk) => {
    for (const char of chunk) {
      tokens.push({ value: char, weight: twitterCodePointWeight(char), url: false });
    }
  };

  while ((match = urlRegex.exec(text)) !== null) {
    addText(text.slice(cursor, match.index));
    tokens.push({ value: match[0], weight: X_SHORT_URL_LENGTH, url: true });
    cursor = match.index + match[0].length;
  }
  addText(text.slice(cursor));
  return tokens;
}

function twitterWeightedLength(value) {
  return twitterTextTokens(value).reduce((total, token) => total + token.weight, 0);
}

/**
 * Encurta a legenda segundo o peso real do X, sem partir URL ou caractere
 * Unicode. O sufixo usa tres pontos ASCII porque o caractere unico "…" pesa 2
 * no X e era justamente o responsavel pelo "Overage: 1".
 */
function truncateForTwitter(value, maxWeight = X_MAX_WEIGHTED_LENGTH) {
  const text = String(value || '').trim();
  const limit = Math.max(1, Number(maxWeight) || X_MAX_WEIGHTED_LENGTH);
  if (twitterWeightedLength(text) <= limit) return text;

  const suffix = '...';
  const budget = Math.max(0, limit - twitterWeightedLength(suffix));
  let output = '';
  let used = 0;
  for (const token of twitterTextTokens(text)) {
    if (used + token.weight > budget) break;
    output += token.value;
    used += token.weight;
  }

  output = output.trimEnd();
  // Evita terminar no meio de uma palavra quando existe espaco razoavelmente
  // perto do corte. Para manchetes muito longas, preserva o maximo possivel.
  const lastSpace = output.lastIndexOf(' ');
  if (lastSpace >= Math.floor(output.length * 0.72)) {
    output = output.slice(0, lastSpace).trimEnd();
  }
  return `${output}${suffix}`;
}

function limitHashtags(text, max = INSTAGRAM_HASHTAG_LIMIT) {
  let count = 0;
  const limit = Math.max(0, Number(max) || 0);

  return String(text || '')
    .replace(/(?<![\p{L}\p{N}_/])#[\p{L}\p{N}_]+/gu, (hashtag) => {
      count += 1;
      return count <= limit ? hashtag : '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function isConfigured() {
  return Boolean(env.ayrshare?.apiKey);
}

function assertConfigured() {
  if (!isConfigured()) {
    const err = new Error(
      'Ayrshare não configurado: preencha AYRSHARE_API_KEY no .env'
    );
    err.status = 500;
    throw err;
  }
}

function authHeaders(extra = {}, profileKey = null) {
  assertConfigured();
  const headers = {
    Authorization: `Bearer ${env.ayrshare.apiKey}`,
    ...extra,
  };
  const key = profileKey != null ? String(profileKey).trim() : '';
  if (key) headers['Profile-Key'] = key;
  return headers;
}

function isTwitterByoConfigured() {
  return Boolean(env.ayrshare?.twitterApiKey && env.ayrshare?.twitterApiSecret);
}

function twitterByoHeaders() {
  if (!isTwitterByoConfigured()) return {};
  return {
    'X-Twitter-OAuth1-Api-Key': env.ayrshare.twitterApiKey,
    'X-Twitter-OAuth1-Api-Secret': env.ayrshare.twitterApiSecret,
  };
}

function collectAyrshareErrorParts(body) {
  const parts = [];
  const push = (item) => {
    if (!item) return;
    if (typeof item === 'string' && item.trim()) parts.push(item.trim());
    else if (item.message) parts.push(String(item.message).trim());
    else if (item.error) parts.push(String(item.error).trim());
    if (item.code != null) parts.push(`code:${item.code}`);
  };

  if (!body || typeof body !== 'object') return parts;
  push({ message: body.message || body.error, code: body.code ?? body.statusCode });
  if (Array.isArray(body.errors)) body.errors.forEach(push);
  if (Array.isArray(body.posts)) {
    for (const p of body.posts) {
      push(p);
      if (Array.isArray(p?.errors)) p.errors.forEach(push);
    }
  }
  return parts.filter(Boolean);
}

function apiErrorMessage(err) {
  const body = err.response?.data;
  if (!body) return err.message || 'Erro desconhecido na API Ayrshare';

  const parts = collectAyrshareErrorParts(body);
  const msg = parts.filter((p) => !/^code:/i.test(p)).join(' | ');
  const lower = msg.toLowerCase();
  const codeMatch = parts.find((p) => /^code:/i.test(p));
  const code = Number(
    (codeMatch && codeMatch.replace(/^code:/i, '')) || body.code || body.statusCode || NaN
  );

  if (
    code === 151 ||
    lower.includes('too many hashtags') ||
    (lower.includes('hashtag') && lower.includes('maximum'))
  ) {
    return (
      'Instagram: a legenda excedeu o limite de hashtags. ' +
      `Use no máximo ${INSTAGRAM_HASHTAG_LIMIT} hashtags e publique de novo.`
    );
  }

  if (
    code === 159 ||
    lower.includes('@mention') ||
    lower.includes('same @mention') ||
    (lower.includes('mention') && lower.includes('once per day'))
  ) {
    return (
      'Facebook: a mesma @menção só pode ser usada 1× por dia. ' +
      'Troque @usuario por #usuario na legenda (ex.: #trechosgospelof) e publique de novo.'
    );
  }

  if (
    code === 156 ||
    lower.includes('not linked') ||
    lower.includes('not connected') ||
    lower.includes('no social') ||
    (lower.includes('facebook') && lower.includes('link'))
  ) {
    return (
      'Ayrshare: Página do Facebook não está conectada. ' +
      'No painel app.ayrshare.com → Social Accounts, vincule a Página e tente de novo.'
    );
  }

  if (code === 417 || (lower.includes('oauth1') && lower.includes('permission'))) {
    return (
      'X.com: o aplicativo está sem permissão de escrita. No X Developer, altere para Read and write ' +
      'e depois reconecte a conta X no Social Accounts da Ayrshare.'
    );
  }

  if (code === 419 || lower.includes('x_credentials_required')) {
    return (
      'X.com: as credenciais BYO OAuth 1.0a estão ausentes ou inválidas. Confira ' +
      'AYRSHARE_X_API_KEY e AYRSHARE_X_API_SECRET e reconecte a conta na Ayrshare.'
    );
  }

  if (
    lower.includes('api credits') ||
    lower.includes('purchase credits') ||
    (lower.includes('credit') && lower.includes('x developer'))
  ) {
    return 'X.com: a conta do X Developer está sem créditos de API. Adicione créditos no console.x.com.';
  }

  if (
    code === 429
    || lower.includes('quota')
    || lower.includes('rate limit')
    || (lower.includes('too many') && !lower.includes('mention'))
  ) {
    return (
      'Ayrshare: limite/quota atingido. Aguarde o reset do plano ou verifique o uso no dashboard.'
    );
  }

  if (
    lower.includes('duplicate or similar content') ||
    lower.includes('duplicate content') ||
    lower.includes('similar content posted') ||
    lower.includes('same two day') ||
    lower.includes('two day period') ||
    lower.includes('dealing_with_duplicate')
  ) {
    return (
      'Facebook/Ayrshare: já existe post igual ou muito parecido nas últimas 48 horas. ' +
      'Não publique de novo — edite o texto/imagem ou espere 2 dias. ' +
      'Confira em Matérias salvas se essa pauta já foi publicada.'
    );
  }

  if (
    lower.includes('upload error') ||
    (lower.includes('media file size') && lower.includes('content-type')) ||
    (lower.includes('media') && lower.includes('dimensions') && lower.includes('content'))
  ) {
    return (
      'X.com/Ayrshare recusou o upload da imagem mesmo ela estando dentro dos limites. ' +
      'Confira no X Developer se o aplicativo tem permissão Read and write, se a conta foi ' +
      'reconectada após alterar a permissão e se há créditos de API.'
    );
  }

  if (
    lower.includes('media') &&
    (lower.includes('could not') ||
      lower.includes('unable') ||
      lower.includes('download') ||
      lower.includes('access') ||
      lower.includes('invalid'))
  ) {
    return (
      'Ayrshare não conseguiu baixar a mídia. Confirme APP_PUBLIC_URL (HTTPS público) ' +
      'e que a imagem/vídeo está acessível em /media/…'
    );
  }

  if (typeof body === 'string') return body;
  if (msg) return msg.slice(0, 400);
  try {
    return JSON.stringify(body).slice(0, 400);
  } catch {
    return err.message || 'Erro desconhecido na API Ayrshare';
  }
}

/**
 * Converte arquivo em storage (ou path /media) em URL HTTPS pública.
 */
function publicMediaUrlFromLocal(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const abs = path.resolve(filePath);
  const storageRoot = path.resolve(env.storagePath);
  const rel = path.relative(storageRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const mediaPath = `/media/${rel.replace(/\\/g, '/')}`;
  const base = env.appPublicUrl;
  if (!base) return null;
  return `${base}${mediaPath}`;
}

/**
 * Upload local → Ayrshare media gallery. Retorna URL hospedada.
 */
async function uploadMediaFile(filePath, { profileKey = null, contentType = null } = {}) {
  assertConfigured();
  if (!filePath || !fs.existsSync(filePath)) {
    const err = new Error('Arquivo de mídia não encontrado para upload Ayrshare.');
    err.status = 422;
    throw err;
  }

  const form = new FormData();
  const fileName = path.basename(filePath);
  const extension = path.extname(fileName).toLowerCase();
  const detectedContentType =
    contentType ||
    ({
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
    }[extension] || 'application/octet-stream');
  form.append('file', fs.createReadStream(filePath), {
    filename: fileName,
    contentType: detectedContentType,
    knownLength: fs.statSync(filePath).size,
  });
  form.append('fileName', fileName);
  form.append('description', 'viralizeai');

  const { data } = await axios.post(`${API}/media/upload`, form, {
    headers: {
      ...authHeaders({}, profileKey),
      ...form.getHeaders(),
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120000,
  });

  const url = data?.url || data?.mediaUrl || data?.data?.url;
  if (!url) {
    const err = new Error(
      'Ayrshare não retornou URL após upload de mídia. ' +
        JSON.stringify(data || {}).slice(0, 300)
    );
    err.status = 502;
    throw err;
  }
  return String(url);
}

/**
 * Resolve URL pública para o post: remote URL, APP_PUBLIC_URL+/media, ou upload Ayrshare.
 */
async function resolveMediaUrl({
  filePath,
  imageUrl,
  forceAyrshareUpload = false,
  profileKey = null,
  contentType = null,
}) {
  const remote = String(imageUrl || '').trim();
  if (
    !forceAyrshareUpload &&
    remote &&
    /^https?:\/\//i.test(remote) &&
    !remote.includes('/media/')
  ) {
    return remote;
  }

  if (
    !forceAyrshareUpload &&
    remote &&
    /^https?:\/\//i.test(remote) &&
    remote.includes('/media/')
  ) {
    try {
      const parsed = new URL(remote);
      if (parsed.protocol === 'https:' || env.appPublicUrl) {
        if (parsed.hostname && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
          return remote;
        }
      }
    } catch {
      /* fall through */
    }
  }

  let local = filePath || null;
  if (!local && remote) {
    if (remote.startsWith('/media/')) {
      const relative = remote.slice('/media/'.length).replace(/\//g, path.sep);
      const absolute = storageAbsolutePath(relative);
      if (fs.existsSync(absolute)) local = absolute;
    } else {
      try {
        const parsed = new URL(remote);
        if (parsed.pathname.startsWith('/media/')) {
          const relative = parsed.pathname.slice('/media/'.length).replace(/\//g, path.sep);
          const absolute = storageAbsolutePath(relative);
          if (fs.existsSync(absolute)) local = absolute;
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (local) {
    const publicUrl = publicMediaUrlFromLocal(local);
    if (!forceAyrshareUpload && publicUrl && !/localhost|127\.0\.0\.1/i.test(publicUrl)) {
      return publicUrl;
    }
    // Localhost / sem APP_PUBLIC_URL: sobe para a Ayrshare
    return uploadMediaFile(local, { profileKey, contentType });
  }

  if (remote && /^https?:\/\//i.test(remote)) {
    return remote;
  }

  return null;
}

/**
 * X aceita imagens de no máximo 5 MB. As artes editoriais podem ser JPGs grandes
 * (qualidade 95), então criamos uma cópia 1200 px JPEG para a Ayrshare enviar
 * com content-type confiável. A arte original no storage não é modificada.
 */
async function prepareTwitterImage(filePath, { imageUrl = null } = {}) {
  const localValido = filePath && fs.existsSync(filePath) ? filePath : null;
  const remote = String(imageUrl || '').trim();
  if (!localValido && !/^https?:\/\//i.test(remote)) return null;

  const output = path.join(
    os.tmpdir(),
    `viralizeai-x-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`
  );
  const remove = () => {
    try {
      if (fs.existsSync(output)) fs.unlinkSync(output);
    } catch {
      /* arquivo temporário é descartável */
    }
  };

  try {
    let input = localValido;
    if (!input && remote) {
      const { fetchImage } = require('./editorialCardService');
      input = await fetchImage(remote);
    }
    // A 1200 px e qualidade 82 fica bem abaixo do limite de 5 MB do X, mesmo
    // em fotos detalhadas, e preserva boa nitidez para um post de notícia.
    await sharp(input, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .toColourspace('srgb')
      .flatten({ background: '#ffffff' })
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      // JPEG baseline sRGB é a variante mais conservadora para o endpoint de
      // mídia do X. `mozjpeg: true` gerava JPEG progressivo.
      .jpeg({ quality: 82, chromaSubsampling: '4:2:0', progressive: false })
      .toFile(output);

    const bytes = fs.statSync(output).size;
    if (bytes > 5 * 1024 * 1024) {
      remove();
      const err = new Error(
        'A imagem preparada para o X.com ainda ultrapassa 5 MB. Escolha outra imagem ou reduza a arte antes de publicar.'
      );
      err.status = 422;
      throw err;
    }
    return { filePath: output, bytes, remove };
  } catch (err) {
    remove();
    if (err.status) throw err;
    if (remote && !localValido) {
      const out = new Error(
        `Não consegui preparar a imagem exclusiva do X.com: ${err.message || 'arquivo inválido'}`
      );
      out.status = 422;
      throw out;
    }
    // Vídeo/Reel continua no fluxo normal da Ayrshare.
    return null;
  }
}

function isTwitterMediaUploadError(err) {
  let raw = '';
  try {
    raw = JSON.stringify(err?.response?.data || '');
  } catch {
    raw = '';
  }
  const text = `${err?.message || ''} ${raw}`.toLowerCase();
  return (
    text.includes('upload error') ||
    (text.includes('media') &&
      (text.includes('file size') ||
        text.includes('dimension') ||
        text.includes('content-type') ||
        text.includes('content type') ||
        text.includes('media upload')))
  );
}

/**
 * RefId e Profile Key são coisas diferentes na Ayrshare: o painel “Manage Profiles”
 * mostra o RefId (hex de ~40 chars), mas o header Profile-Key exige a chave do profile.
 * Colar o RefId faz o post cair no Primary Profile / falhar.
 */
function looksLikeRefId(value) {
  return /^[0-9a-f]{32,64}$/i.test(String(value || '').trim());
}

/** A API Key geral autentica o ViralizeAI; nunca pode ser Profile-Key de página. */
function isAyrshareApiKey(value) {
  const informado = String(value || '').trim();
  const configurado = String(env.ayrshare?.apiKey || '').trim();
  return Boolean(informado && configurado && informado === configurado);
}

/**
 * Detalhes do profile referente à Profile Key informada (GET /user).
 * Serve para validar a chave e saber se a Página do Facebook está conectada.
 */
async function listProfiles({ cursor = null } = {}) {
  const { data } = await axios.get(`${API}/profiles`, {
    headers: authHeaders(),
    params: { limit: 100, ...(cursor ? { cursor } : {}) },
    timeout: 30000,
  });
  if (!Array.isArray(data?.profiles)) throw new Error('Não foi possível listar os perfis na Ayrshare. Verifique se seu plano permite consultar User Profiles.');
  return {
    profiles: data.profiles.map((p) => ({
      ref_id: p.refId,
      title: p.displayTitle || p.title || p.refId,
      status: p.status,
      facebook_connected: (p.activeSocialAccounts || []).includes('facebook'),
    })),
    next_cursor: data.pagination?.hasMore ? data.pagination.nextCursor : null,
  };
}

/**
 * A API Key configurada no servidor ainda vale? (troca de conta na Ayrshare
 * deixa o .env com a chave antiga e TODA validação passa a falhar.)
 * Devolve { ok, status, primary } — primary = dados do Primary Profile.
 */
async function diagnosticarConta() {
  if (!isConfigured()) return { ok: false, status: null, motivo: 'sem-chave' };
  try {
    const primary = await fetchProfileByKey(null, { permitirPrimary: true });
    return { ok: true, status: 200, primary };
  } catch (err) {
    return { ok: false, status: err.response?.status || null, motivo: apiErrorMessage(err) };
  }
}

/**
 * O valor colado é a API Key de alguma conta Ayrshare? (o editor costuma
 * colar a API Key ou o RefId no lugar do Profile Key). Só conversa com a
 * própria Ayrshare, que é a dona da chave.
 */
async function valeComoApiKey(valor) {
  const chave = String(valor || '').trim();
  if (!chave) return false;
  try {
    await axios.get(`${API}/user`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chave}` },
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Últimos 4 caracteres da API Key do servidor: o editor confere qual conta está ligada. */
function finalDaApiKey() {
  const chave = String(env.ayrshare?.apiKey || '').trim();
  return chave.length >= 8 ? chave.slice(-4) : null;
}

async function fetchProfileByKey(profileKey, { permitirPrimary = false } = {}) {
  assertConfigured();
  const key = String(profileKey || '').trim();
  // Sem chave a Ayrshare responde pelo Primary Profile. Isso só é aceitável
  // quando quem chama sabe disso (conta com uma Página só).
  if (!key && !permitirPrimary) {
    const err = new Error('Profile Key vazia');
    err.status = 400;
    throw err;
  }

  const { data } = await axios.get(`${API}/user`, {
    headers: authHeaders({}, key),
    timeout: 30000,
  });

  const active = Array.isArray(data?.activeSocialAccounts) ? data.activeSocialAccounts : [];
  const displayNames = Array.isArray(data?.displayNames) ? data.displayNames : [];
  const facebook = displayNames.find(
    (d) => String(d?.platform || '').toLowerCase() === 'facebook'
  );
  const instagram = displayNames.find(
    (d) => String(d?.platform || '').toLowerCase() === 'instagram'
  );
  const x = displayNames.find((d) => ['twitter', 'x'].includes(String(d?.platform || '').toLowerCase()));

  return {
    refId: data?.refId || null,
    title: data?.title || data?.displayTitle || null,
    isPrimary: Boolean(data?.primaryProfile ?? data?.isPrimary ?? false),
    activeSocialAccounts: active,
    facebookConnected: active.some((p) => String(p).toLowerCase() === 'facebook'),
    facebookPageName: facebook?.displayName || facebook?.pageName || facebook?.username || null,
    facebookPageId: facebook?.id || facebook?.pageId || null,
    instagramConnected: active.some((p) => String(p).toLowerCase() === 'instagram'),
    instagramUsername:
      instagram?.username || instagram?.displayName || instagram?.pageName || null,
    xConnected: active.some((p) => ['twitter', 'x'].includes(String(p).toLowerCase())),
    xUsername: x?.username || x?.displayName || x?.pageName || null,
    raw: data,
  };
}

/**
 * Publica na Página Facebook ligada ao perfil Ayrshare (Primary ou User Profile).
 * Com vários profiles (Business): passe profileKey da página.
 */
async function publishToFacebook({
  post,
  filePath = null,
  imageUrl = null,
  isReel = false,
  title = null,
  profileKey = null,
  publicarFacebook = true,
  // Mesma chamada publica no Instagram do mesmo User Profile da Ayrshare.
  publicarInstagram = false,
  // A API chama a plataforma de "twitter", mas a interface usa a marca X.com.
  publicarX = false,
}) {
  assertConfigured();

  // FB: mesma @menção só 1×/dia — troca @handle por #handle antes do envio.
  const originalContent = String(post || '');
  let content = originalContent.replace(
    /(^|[^A-Za-z0-9._])@([A-Za-z0-9._]{2,50})\b/g,
    '$1#$2'
  );
  const vaiNoX = Boolean(publicarX);

  // Para foto + X, use uma cópia menor hospedada pela própria Ayrshare. Assim
  // o X recebe JPEG <5 MB, com extensão e Content-Type corretos, em vez de
  // baixar diretamente a arte grande servida por /media.
  const xImage = vaiNoX && !isReel
    ? await prepareTwitterImage(filePath, { imageUrl })
    : null;
  let mediaUrl = null;
  try {
    mediaUrl = await resolveMediaUrl({
      filePath: xImage?.filePath || filePath,
      imageUrl,
      forceAyrshareUpload: Boolean(xImage),
      profileKey,
      contentType: xImage ? 'image/jpeg' : null,
    });
  } finally {
    xImage?.remove();
  }

  if ((isReel || filePath || imageUrl) && !mediaUrl && isReel) {
    const err = new Error(
      'Vídeo do Reel não encontrado. Aguarde o processamento ou importe o link de novo.'
    );
    err.status = 422;
    throw err;
  }

  const plataformas = [];
  if (publicarFacebook) plataformas.push('facebook');
  // Instagram exige mídia: post só de texto é recusado pela API.
  const vaiNoInstagram = Boolean(publicarInstagram) && Boolean(mediaUrl);
  if (vaiNoInstagram) plataformas.push('instagram');
  if (vaiNoX) plataformas.push('twitter');
  if (!plataformas.length) {
    const err = new Error('Selecione Facebook, Instagram, X.com ou mais de uma rede para publicar.');
    err.status = 400;
    throw err;
  }

  const instagramContent = vaiNoInstagram
    ? limitarLegendaInstagram(limitHashtags(content, INSTAGRAM_HASHTAG_LIMIT))
    : content;
  // O limite do X é 280 caracteres. Mantemos o começo da legenda, que contém
  // a manchete, em vez de deixar a Ayrshare recusar toda a publicação.
  // Não reutilize a versão do Facebook (que troca @menções por hashtags): no X,
  // as menções são válidas e devem ser preservadas.
  const xContent = truncateForTwitter(originalContent);
  const postsPorPlataforma = {};
  if (publicarFacebook) postsPorPlataforma.facebook = content;
  if (vaiNoInstagram) postsPorPlataforma.instagram = instagramContent;
  if (vaiNoX) postsPorPlataforma.twitter = xContent;
  const body = {
    // Ayrshare aceita conteúdo específico por plataforma. Facebook conserva a
    // legenda completa; Instagram e X recebem seus respectivos limites.
    post: plataformas.length > 1 ? postsPorPlataforma : postsPorPlataforma[plataformas[0]],
    platforms: plataformas,
  };

  if (mediaUrl) {
    body.mediaUrls = [mediaUrl];
  }

  if (vaiNoInstagram && isReel) {
    body.instagramOptions = { reels: true };
  }

  if (isReel && publicarFacebook) {
    body.faceBookOptions = {
      reels: true,
    };
    if (title) body.faceBookOptions.title = String(title).slice(0, 255);
  }

  const pk = profileKey != null ? String(profileKey).trim() : '';

  console.log('[ayrshare] post', {
    plataformas,
    hasMedia: Boolean(mediaUrl),
    isReel,
    hashtagsInstagram:
      vaiNoInstagram && (instagramContent.match(/(?<![\p{L}\p{N}_/])#[\p{L}\p{N}_]+/gu) || []).length,
    caracteresFacebook: publicarFacebook ? content.length : 0,
    caracteresInstagram: vaiNoInstagram ? instagramContent.length : 0,
    caracteresX: vaiNoX ? xContent.length : 0,
    pesoX: vaiNoX ? twitterWeightedLength(xContent) : 0,
    xMediaOtimizadaBytes: xImage?.bytes || null,
    hasProfileKey: Boolean(pk),
    mediaHost: mediaUrl ? (() => {
      try {
        return new URL(mediaUrl).hostname;
      } catch {
        return '?';
      }
    })() : null,
  });

  try {
    let { data } = await axios.post(`${API}/post`, body, {
      headers: authHeaders(
        { 'Content-Type': 'application/json', ...(vaiNoX ? twitterByoHeaders() : {}) },
        pk || null
      ),
      timeout: 120000,
    });
    // O POST pode devolver somente o ID da submissão enquanto as plataformas
    // ainda estão processando. Preserve-o mesmo que a consulta seguinte venha
    // com outro formato de resposta.
    const submissionId = data?.id ? String(data.id) : null;

    const platformOutcome = (payload, platform) =>
      (Array.isArray(payload?.postIds) &&
        payload.postIds.find((item) => String(item?.platform || '').toLowerCase() === platform)) ||
      (Array.isArray(payload?.posts) &&
        payload.posts.find((item) => String(item?.platform || '').toLowerCase() === platform)) ||
      null;
    const platformFailure = (payload, platform) =>
      (Array.isArray(payload?.errors) &&
        payload.errors.find((item) => {
          const itemPlatform = String(item?.platform || '').toLowerCase();
          return itemPlatform === platform || (!itemPlatform && plataformas.length === 1);
        })) ||
      null;

    // Às vezes o POST retorna o ID superior antes de preencher postIds. O GET
    // oficial pelo ID reconcilia o resultado sem disparar uma publicação nova.
    if (
      (vaiNoInstagram || vaiNoX) &&
      data?.id &&
      ((vaiNoInstagram && !platformOutcome(data, 'instagram') && !platformFailure(data, 'instagram')) ||
        (vaiNoX && !platformOutcome(data, 'twitter') && !platformFailure(data, 'twitter')))
    ) {
      console.warn('[ayrshare] instagram sem resultado imediato; consultando post', {
        id: String(data.id),
        status: data.status || null,
        postIds: Array.isArray(data.postIds) ? data.postIds.length : null,
      });
      try {
        const checked = await axios.get(`${API}/post/${encodeURIComponent(String(data.id))}`, {
          headers: authHeaders(vaiNoX ? twitterByoHeaders() : {}, pk || null),
          timeout: 30000,
        });
        if (checked?.data && typeof checked.data === 'object') {
          data = {
            ...data,
            ...checked.data,
            id: checked.data.id || data.id || submissionId,
          };
        }
      } catch (checkErr) {
        console.warn(
          '[ayrshare] consulta do post ainda indisponível:',
          checkErr.response?.status || checkErr.message
        );
      }
    }

    const fb =
      (Array.isArray(data?.postIds) &&
        data.postIds.find((p) => String(p.platform).toLowerCase() === 'facebook')) ||
      (Array.isArray(data?.posts) &&
        data.posts.find((p) => String(p.platform).toLowerCase() === 'facebook')) ||
      null;

    const status = String(fb?.status || data?.status || '').toLowerCase();
    if (publicarFacebook && fb && (status === 'error' || status === 'failed')) {
      const wrap = { response: { data, config: { url: `${API}/post` } } };
      const err = new Error(apiErrorMessage(wrap) || fb.message || fb.error || 'Falha ao publicar no Facebook via Ayrshare');
      err.status = 502;
      err.response = wrap.response;
      throw err;
    }

    const ig =
      (Array.isArray(data?.postIds) &&
        data.postIds.find((p) => String(p.platform).toLowerCase() === 'instagram')) ||
      (Array.isArray(data?.posts) &&
        data.posts.find((p) => String(p.platform).toLowerCase() === 'instagram')) ||
      null;

    // Em falhas de validação a Ayrshare pode devolver postIds: [] e colocar o
    // erro somente no array superior `errors` (por exemplo, código 151).
    const igTopLevelError = platformFailure(data, 'instagram');
    const x = platformOutcome(data, 'twitter');
    const xTopLevelError = platformFailure(data, 'twitter');

    // Falha só no Instagram não invalida o post do Facebook: o editor é avisado.
    const igStatus = String(ig?.status || '').toLowerCase();
    let igErro =
      ig && (igStatus === 'error' || igStatus === 'failed')
        ? String(ig.message || ig.error || 'Instagram recusou a publicação')
        : null;
    if (!igErro && igTopLevelError) {
      igErro = apiErrorMessage({ response: { data: { errors: [igTopLevelError] } } });
    }
    if (!igErro && !ig && String(data?.status || '').toLowerCase() === 'error') {
      igErro = apiErrorMessage({ response: { data } });
    }
    const xStatus = String(x?.status || '').toLowerCase();
    let xErro =
      x && (xStatus === 'error' || xStatus === 'failed')
        ? String(x.message || x.error || 'X.com recusou a publicação')
        : null;
    if (!xErro && xTopLevelError) {
      xErro = apiErrorMessage({ response: { data: { errors: [xTopLevelError] } } });
    }
    if (!xErro && !x && vaiNoX && String(data?.status || '').toLowerCase() === 'error') {
      xErro = apiErrorMessage({ response: { data } });
    }
    const ayrshareId = data?.id ? String(data.id) : submissionId;
    const overallStatus = String(data?.status || '').toLowerCase();
    const igAcceptedWithoutDetails =
      !igErro &&
      !ig &&
      vaiNoInstagram &&
      Boolean(ayrshareId) &&
      !['error', 'failed'].includes(overallStatus);
    const xAcceptedWithoutDetails =
      !xErro &&
      !x &&
      vaiNoX &&
      Boolean(ayrshareId) &&
      !['error', 'failed'].includes(overallStatus);
    if (igErro) console.warn('[ayrshare] instagram falhou:', igErro);
    if (xErro) console.warn('[ayrshare] x.com falhou:', xErro);
    if (igAcceptedWithoutDetails) {
      console.warn('[ayrshare] instagram aceito sem detalhes da plataforma', {
        id: ayrshareId,
        status: overallStatus,
      });
    }
    if (
      !publicarFacebook &&
      ((!ig && !igAcceptedWithoutDetails) || igErro) &&
      ((!x && !xAcceptedWithoutDetails) || xErro)
    ) {
      const err = new Error(
        xErro || igErro || 'A Ayrshare não confirmou a publicação. Verifique as contas em Social Accounts.'
      );
      err.status = 502;
      throw err;
    }
    const socialId = fb?.id ? String(fb.id) : null;
    const postUrl = fb?.postUrl || null;
    // Guardar sempre o ID Ayrshare (analytics confiável). O ID nativo FB fica em fb_native_post_id.
    const postId = ayrshareId
      ? `ayrshare:${ayrshareId}`
      : publicarFacebook ? socialId || null : null;

    return {
      id: postId,
      post_id: postId,
      ayrshare_id: ayrshareId,
      fb_native_post_id: socialId || null,
      postUrl,
      provider: 'ayrshare',
      instagram_pedido: Boolean(publicarInstagram),
      // A publicação nas redes é assíncrona; o ID nativo pode chegar depois.
      instagram_publicado: Boolean(
        vaiNoInstagram && !igErro && (ig || igAcceptedWithoutDetails || overallStatus === 'success')
      ),
      instagram_pendente: Boolean(igAcceptedWithoutDetails && overallStatus !== 'success'),
      instagram_post_id: ig && !igErro && ig.id ? String(ig.id) : null,
      instagram_post_url: (ig && !igErro && ig.postUrl) || null,
      instagram_erro:
        igErro ||
        (publicarInstagram && !vaiNoInstagram
          ? 'Instagram exige imagem ou vídeo — a publicação saiu só no Facebook.'
          : publicarInstagram && !ig && !igAcceptedWithoutDetails
            ? 'A Ayrshare não confirmou o post no Instagram. Verifique a conta em Social Accounts.'
            : null),
      x_pedido: Boolean(publicarX),
      x_publicado: Boolean(
        vaiNoX && !xErro && (x || xAcceptedWithoutDetails || overallStatus === 'success')
      ),
      x_pendente: Boolean(xAcceptedWithoutDetails && overallStatus !== 'success'),
      x_post_id: x && !xErro && x.id ? String(x.id) : null,
      x_post_url: (x && !xErro && x.postUrl) || null,
      x_erro:
        xErro ||
        (publicarX && !x && !xAcceptedWithoutDetails
          ? 'A Ayrshare não confirmou o post no X.com. Verifique a conta em Social Accounts.'
          : null),
      raw: data,
    };
  } catch (err) {
    if (!err.status && err.response) err.status = err.response.status || 502;
    const friendly = apiErrorMessage(err);
    if (friendly && friendly !== 'Erro desconhecido na API Ayrshare') {
      err.message = friendly;
    } else if (!err.message || err.message === 'Request failed with status code 400') {
      err.message = friendly || err.message;
    }
    // O corpo não contém os headers de autenticação. Registrá-lo permite
    // diferenciar mídia, permissão, créditos e conta X desconectada.
    if (err.response?.data) {
      try {
        console.error(
          '[ayrshare] publish response:',
          JSON.stringify(err.response.data).slice(0, 2000)
        );
      } catch {
        /* resposta não serializável */
      }
    }
    // Evita dump enorme do axios no pm2
    console.error('[ayrshare] publish failed:', err.message, err.response?.data?.status || err.status);
    throw err;
  }
}

function looksLikeAyrshareId(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/^ayrshare:/i.test(s)) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function stripAyrsharePrefix(raw) {
  return String(raw || '')
    .trim()
    .replace(/^ayrshare:/i, '');
}

function metricNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function normalizeFacebookAnalytics(raw) {
  const item = Array.isArray(raw) ? raw[0] : raw;
  if (!item || typeof item !== 'object') return null;

  const analytics =
    item.analytics && typeof item.analytics === 'object' ? item.analytics : item;
  const reactions =
    analytics.reactions && typeof analytics.reactions === 'object'
      ? analytics.reactions
      : null;
  const reactionSum = reactions
    ? ['like', 'love', 'care', 'haha', 'wow', 'sad', 'anger', 'sorry'].reduce(
        (sum, key) => sum + (Number(reactions[key]) || 0),
        0
      )
    : null;

  return {
    likes: metricNumber(
      analytics.likeCount,
      analytics.likes,
      analytics.reactionCount,
      reactions?.total,
      reactionSum
    ),
    comments: metricNumber(
      analytics.commentsCount,
      analytics.commentCount,
      analytics.comments
    ),
    shares: metricNumber(
      analytics.shareCount,
      analytics.sharesCount,
      analytics.shares,
      analytics.postVideoSocialActions?.share
    ),
    views: metricNumber(
      analytics.mediaView,
      analytics.videoViews,
      analytics.blueReelsPlayCount,
      analytics.impressions,
      analytics.views,
      analytics.postImpressions
    ),
    postId: item.id != null ? String(item.id) : null,
    postUrl: item.postUrl || item.permalink || null,
    post: item.post || item.message || item.description || null,
    created: item.created || item.publishedAt || item.date || null,
    raw: item,
  };
}

const facebookHistoryCache = new Map();

/**
 * Historico da pagina com metricas. Alem de ser mais barato que consultar cada
 * post, recupera o ID nativo de publicacoes antigas salvas apenas com o ID Ayrshare.
 */
async function fetchFacebookHistory({ profileKey = null, limit = 100, force = false } = {}) {
  assertConfigured();
  const key = String(profileKey || '').trim();
  const safeLimit = Math.min(100, Math.max(10, Number(limit) || 100));
  const cacheKey = `${key || 'primary'}:${safeLimit}`;
  const cached = facebookHistoryCache.get(cacheKey);
  // Mesmo numa atualização forçada, compartilha a chamada em andamento e o
  // resultado recém-obtido. Um lote de 40 matérias não deve consultar o mesmo
  // histórico 40 vezes em paralelo.
  if (cached?.promise) return cached.promise;
  if (cached && Date.now() - cached.at < 60_000) return cached.posts;

  const promise = (async () => {
    const response = await axios.get(`${API}/history/facebook`, {
      headers: authHeaders({}, key || null),
      params: {
        limit: safeLimit,
        pagePublished: true,
        dataType: 'posts',
      },
      timeout: 30_000,
      validateStatus: () => true,
    });
    const data = response.data;
    if (response.status >= 400 || data?.status === 'error') {
      const wrap = { response: { data, config: { url: `${API}/history/facebook` } } };
      throw new Error(apiErrorMessage(wrap) || `Historico Ayrshare HTTP ${response.status}`);
    }

    const posts = (Array.isArray(data?.posts) ? data.posts : [])
      .map(normalizeFacebookAnalytics)
      .filter(Boolean);
    facebookHistoryCache.set(cacheKey, { at: Date.now(), posts });
    return posts;
  })();

  facebookHistoryCache.set(cacheKey, { at: Date.now(), posts: [], promise });
  try {
    return await promise;
  } catch (err) {
    facebookHistoryCache.delete(cacheKey);
    throw err;
  }
}

function facebookIdParts(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const clean = raw.split(/[?#]/)[0].replace(/\/+$/, '');
  const parts = new Set([clean]);
  const providerId = clean.replace(/^ayrshare:/i, '');
  if (providerId !== clean) parts.add(providerId);
  const match = clean.match(/(?:posts|videos|photos|reel)\/(\d+)/i);
  if (match?.[1]) parts.add(match[1]);
  const pair = clean.match(/(\d+)_(\d+)/);
  if (pair) {
    parts.add(`${pair[1]}_${pair[2]}`);
    parts.add(pair[2]);
  }
  const tail = clean.match(/(?:^|\/)(\d+)$/)?.[1];
  if (tail) parts.add(tail);
  return [...parts].map((item) => item.toLowerCase());
}

function normalizePostText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HISTORY_TEXT_STOPWORDS = new Set([
  'a', 'as', 'ao', 'aos', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e', 'em',
  'facebook', 'fonte', 'foto', 'mais', 'na', 'nas', 'no', 'nos', 'o', 'os', 'para',
  'por', 'que', 'se', 'sem', 'sobre', 'um', 'uma', 'via', 'video', 'viral',
]);

function significantPostWords(value) {
  return normalizePostText(value)
    .split(' ')
    .filter((word) => word.length >= 4 && !HISTORY_TEXT_STOPWORDS.has(word));
}

function textMatchScore(wanted, candidate) {
  const wantedText = normalizePostText(wanted);
  const candidateText = normalizePostText(candidate);
  if (wantedText.length < 35 || candidateText.length < 35) return null;

  const wantedWords = new Set(significantPostWords(wantedText));
  const candidateWords = new Set(significantPostWords(candidateText));
  if (wantedWords.size < 5 || candidateWords.size < 5) return null;

  const common = [...wantedWords].filter((word) => candidateWords.has(word)).length;
  const overlap = common / Math.min(wantedWords.size, candidateWords.size);
  const prefix = wantedText.slice(0, 100);
  const candidatePrefix = candidateText.slice(0, 100);
  const strongPrefix =
    candidateText.includes(prefix) ||
    wantedText.includes(candidatePrefix);

  if (!strongPrefix && (common < 6 || overlap < 0.55)) return null;
  return { common, overlap, strongPrefix };
}

function findFacebookPostInHistory(
  posts,
  { postId, nativePostId, postUrl, text, publishedAt } = {}
) {
  const list = Array.isArray(posts) ? posts : [];

  // O ID devolvido pelo provedor no momento da publicação é a referência mais
  // confiável. Ele precisa vencer um ID nativo que possa ter sido recuperado
  // anteriormente por uma associação textual incorreta.
  const providerIds = new Set(facebookIdParts(postId));
  const exactProvider = providerIds.size
    ? list.find((post) => {
        const ids = facebookIdParts(post?.postId);
        return ids.some((id) => providerIds.has(id));
      })
    : null;
  if (exactProvider) return exactProvider;

  const secondaryIds = new Set([
    ...facebookIdParts(nativePostId),
    ...facebookIdParts(postUrl),
  ]);
  const exactSecondary = list.find((post) => {
    const ids = [...facebookIdParts(post?.postId), ...facebookIdParts(post?.postUrl)];
    return ids.some((id) => secondaryIds.has(id));
  });
  if (exactSecondary && textMatchScore(text, exactSecondary?.post)) return exactSecondary;

  const publishedMs = publishedAt ? new Date(publishedAt).getTime() : NaN;

  let best = null;
  let bestScore = 0;
  for (const post of list) {
    const match = textMatchScore(text, post?.post);
    if (!match) continue;
    let score = match.strongPrefix ? 100 : Math.round(match.overlap * 70) + match.common;

    const candidateMs = post?.created ? new Date(post.created).getTime() : NaN;
    if (Number.isFinite(publishedMs) && Number.isFinite(candidateMs)) {
      const hours = Math.abs(publishedMs - candidateMs) / 3_600_000;
      if (hours <= 0.5) score += 25;
      else if (hours <= 2) score += 10;
      else if (hours > 6) continue;
    } else if (!match.strongPrefix) {
      continue;
    }
    if (score > bestScore) {
      best = post;
      bestScore = score;
    }
  }
  return bestScore >= 55 ? best : null;
}

/**
 * Analytics do post via Ayrshare (curtidas / comentários / views).
 * Aceita Ayrshare Post ID ou Social Post ID do Facebook (searchPlatformId).
 */
async function fetchFacebookPostAnalytics({ postId, profileKey = null, searchPlatformId = false } = {}) {
  assertConfigured();
  const id = stripAyrsharePrefix(postId);
  if (!id) {
    return {
      likes: null,
      comments: null,
      shares: null,
      views: null,
      postId: null,
      postUrl: null,
      error: 'ID vazio',
    };
  }

  const body = {
    id,
    platforms: ['facebook'],
  };
  if (searchPlatformId) body.searchPlatformId = true;

  const pk = profileKey != null ? String(profileKey).trim() : '';
  let data;
  try {
    const res = await axios.post(`${API}/analytics/post`, body, {
      headers: authHeaders({ 'Content-Type': 'application/json' }, pk || null),
      timeout: 12000,
      validateStatus: () => true,
    });
    data = res.data;
    if (res.status >= 500) {
      return {
        likes: null,
        comments: null,
        shares: null,
        views: null,
        postId: null,
        postUrl: null,
        error: `Ayrshare indisponível (HTTP ${res.status})`,
      };
    }
  } catch (err) {
    return {
      likes: null,
      comments: null,
      shares: null,
      views: null,
      postId: null,
      postUrl: null,
      error: err.code === 'ECONNABORTED' ? 'Timeout Ayrshare' : err.message || 'Falha Ayrshare',
    };
  }

  if (!data || typeof data !== 'object') {
    return {
      likes: null,
      comments: null,
      shares: null,
      views: null,
      postId: null,
      postUrl: null,
      error: 'Resposta inválida da Ayrshare',
    };
  }

  if (data.status === 'error' || data.code >= 400 || (data.errors && !data.facebook)) {
    const wrap = { response: { data, config: { url: `${API}/analytics/post` } } };
    return {
      likes: null,
      comments: null,
      shares: null,
      views: null,
      postId: null,
      postUrl: null,
      error: apiErrorMessage(wrap) || data.message || 'Falha no analytics Ayrshare',
    };
  }

  const fb = data.facebook || data.Facebook || null;
  if (!fb) {
    return {
      likes: null,
      comments: null,
      shares: null,
      views: null,
      postId: null,
      postUrl: null,
      error: pk
        ? 'Post não encontrado no Profile Key desta Página'
        : 'Post não encontrado — confira o Profile Key em /paginas',
      raw: data,
    };
  }

  const normalized = normalizeFacebookAnalytics(fb);

  return {
    likes: normalized?.likes ?? null,
    comments: normalized?.comments ?? null,
    shares: normalized?.shares ?? null,
    views: normalized?.views ?? null,
    postId: normalized?.postId || null,
    postUrl: normalized?.postUrl || null,
    raw: data,
  };
}

module.exports = {
  isConfigured,
  assertConfigured,
  apiErrorMessage,
  isTwitterMediaUploadError,
  limitHashtags,
  publishToFacebook,
  resolveMediaUrl,
  uploadMediaFile,
  prepareTwitterImage,
  truncateForTwitter,
  twitterWeightedLength,
  publicMediaUrlFromLocal,
  looksLikeRefId,
  isAyrshareApiKey,
  diagnosticarConta,
  valeComoApiKey,
  finalDaApiKey,
  isTwitterByoConfigured,
  looksLikeAyrshareId,
  fetchProfileByKey,
  listProfiles,
  fetchFacebookPostAnalytics,
  fetchFacebookHistory,
  findFacebookPostInHistory,
  normalizeFacebookAnalytics,
};
