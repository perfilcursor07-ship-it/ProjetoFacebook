const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { env } = require('../config/env');

function isConfigured() {
  return Boolean(String(env.postiz?.apiKey || '').trim());
}

function authHeaders(extra = {}) {
  return {
    Authorization: String(env.postiz.apiKey || '').trim(),
    ...extra,
  };
}

function apiErrorMessage(err) {
  const data = err?.response?.data;
  if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 400);
  if (data && typeof data === 'object') {
    const msg = data.message || data.error || data.detail;
    if (Array.isArray(msg)) return msg.map(String).join('; ').slice(0, 400);
    if (msg) return String(msg).slice(0, 400);
  }
  return err?.message || 'Falha na API do Postiz';
}

async function listIntegrations() {
  const { data } = await axios.get(`${env.postiz.apiBase}/integrations`, {
    headers: authHeaders(),
    timeout: 30_000,
  });
  return Array.isArray(data) ? data : [];
}

function normalizarNome(valor) {
  return String(valor || '')
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Escolhe o canal Postiz da rede pedida. Com várias Páginas, casa pelo nome.
 */
function escolherIntegracao(integracoes, { identifier, pageName }) {
  const ativas = (integracoes || []).filter(
    (item) => String(item?.identifier || '') === identifier && !item.disabled
  );
  if (!ativas.length) return null;
  if (ativas.length === 1) return ativas[0];
  const alvo = normalizarNome(pageName);
  if (!alvo) return ativas[0];
  const exata = ativas.find((item) => normalizarNome(item.name) === alvo);
  if (exata) return exata;
  const parcial = ativas.find((item) => {
    const nome = normalizarNome(item.name);
    return nome && (nome.includes(alvo) || alvo.includes(nome));
  });
  return parcial || null;
}

async function uploadArquivo(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
  });
  const { data } = await axios.post(`${env.postiz.apiBase}/upload`, form, {
    headers: authHeaders(form.getHeaders()),
    timeout: 180_000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  if (!data?.id || !data?.path) {
    const err = new Error('O Postiz não devolveu o arquivo enviado');
    err.status = 502;
    throw err;
  }
  return { id: String(data.id), path: String(data.path) };
}

async function uploadDeUrl(url) {
  const { data } = await axios.post(
    `${env.postiz.apiBase}/upload-from-url`,
    { url },
    {
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      timeout: 120_000,
    }
  );
  if (!data?.id || !data?.path) {
    const err = new Error('O Postiz não conseguiu baixar a mídia pela URL');
    err.status = 502;
    throw err;
  }
  return { id: String(data.id), path: String(data.path) };
}

function settingsDaRede(identifier, { isReel, link }) {
  if (identifier === 'facebook') {
    const settings = { __type: 'facebook' };
    if (link && /^https?:\/\//i.test(link)) settings.url = link;
    return settings;
  }
  if (identifier === 'instagram' || identifier === 'instagram-standalone') {
    return {
      __type: identifier,
      post_type: 'post',
      ...(isReel ? { is_trial_reel: false } : {}),
    };
  }
  if (identifier === 'x') {
    return { __type: 'x', who_can_reply_post: 'everyone' };
  }
  return { __type: identifier };
}

async function criarPost({ integrationId, identifier, content, media, isReel, link }) {
  const body = {
    type: 'now',
    date: new Date().toISOString(),
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: integrationId },
        value: [
          {
            content: String(content || ''),
            image: media ? [media] : [],
          },
        ],
        settings: settingsDaRede(identifier, { isReel, link }),
      },
    ],
  };
  const { data } = await axios.post(`${env.postiz.apiBase}/posts`, body, {
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    timeout: 120_000,
  });
  const lista = Array.isArray(data) ? data : data ? [data] : [];
  const item = lista.find((row) => row?.postId) || lista[0] || null;
  if (!item?.postId) {
    const err = new Error('O Postiz não confirmou a criação do post');
    err.status = 502;
    throw err;
  }
  return { postId: String(item.postId), integration: item.integration ? String(item.integration) : integrationId };
}

/**
 * Publica agora nas redes conectadas no Postiz.
 * Devolve o mesmo formato que o restante do app espera do Ayrshare.
 */
async function publishContent({
  pageName,
  content,
  filePath = null,
  imageUrl = null,
  isReel = false,
  link = null,
  publicarFacebook = true,
  publicarInstagram = false,
  publicarX = false,
  textoX = null,
}) {
  if (!isConfigured()) {
    const err = new Error('POSTIZ_API_KEY não está configurada no .env');
    err.status = 400;
    throw err;
  }

  let media = null;
  try {
    if (filePath && fs.existsSync(filePath)) media = await uploadArquivo(filePath);
    else if (imageUrl && /^https?:\/\//i.test(String(imageUrl))) media = await uploadDeUrl(String(imageUrl));
  } catch (err) {
    const wrap = new Error(`Falha ao enviar a mídia para o Postiz: ${apiErrorMessage(err)}`);
    wrap.status = err.status || err.response?.status || 502;
    throw wrap;
  }

  let integracoes;
  try {
    integracoes = await listIntegrations();
  } catch (err) {
    const wrap = new Error(`Não consegui listar os canais do Postiz: ${apiErrorMessage(err)}`);
    wrap.status = err.response?.status || 502;
    throw wrap;
  }

  const pedidos = [];
  if (publicarFacebook) pedidos.push({ identifier: 'facebook', content });
  if (publicarInstagram) {
    const ig =
      integracoes.find((item) => item.identifier === 'instagram' && !item.disabled) ||
      integracoes.find((item) => item.identifier === 'instagram-standalone' && !item.disabled);
    pedidos.push({ identifier: ig?.identifier || 'instagram', content });
  }
  if (publicarX) pedidos.push({ identifier: 'x', content: textoX || content });

  const resultados = {};
  for (const pedido of pedidos) {
    const canal = escolherIntegracao(integracoes, {
      identifier: pedido.identifier,
      pageName,
    });
    if (!canal) {
      resultados[pedido.identifier] = {
        erro:
          pedido.identifier === 'facebook'
            ? 'Nenhuma Página do Facebook conectada no Postiz. Abra https://platform.postiz.com e conecte o canal.'
            : `Canal ${pedido.identifier} não está conectado no Postiz.`,
      };
      continue;
    }
    try {
      const criado = await criarPost({
        integrationId: canal.id,
        identifier: canal.identifier,
        content: pedido.content,
        media,
        isReel,
        link: pedido.identifier === 'facebook' ? link : null,
      });
      resultados[pedido.identifier] = { ...criado, nome: canal.name || null };
    } catch (err) {
      resultados[pedido.identifier] = { erro: apiErrorMessage(err) };
    }
  }

  const fb = resultados.facebook || null;
  const ig = resultados.instagram || resultados['instagram-standalone'] || null;
  const x = resultados.x || null;
  if (publicarFacebook && (!fb || fb.erro)) {
    const err = new Error(fb?.erro || 'O Postiz não publicou no Facebook');
    err.status = 502;
    throw err;
  }
  if (!publicarFacebook && (!ig || ig.erro) && (!x || x.erro)) {
    const err = new Error(ig?.erro || x?.erro || 'O Postiz não publicou nas redes pedidas');
    err.status = 502;
    throw err;
  }

  const postId = fb?.postId ? `postiz:${fb.postId}` : null;
  return {
    id: postId,
    post_id: postId,
    postiz_id: fb?.postId || ig?.postId || x?.postId || null,
    fb_native_post_id: null,
    postUrl: null,
    provider: 'postiz',
    instagram_pedido: Boolean(publicarInstagram),
    instagram_publicado: Boolean(publicarInstagram && ig && !ig.erro),
    instagram_pendente: false,
    instagram_post_id: ig?.postId || null,
    instagram_post_url: null,
    instagram_erro: publicarInstagram ? ig?.erro || null : null,
    x_pedido: Boolean(publicarX),
    x_publicado: Boolean(publicarX && x && !x.erro),
    x_pendente: false,
    x_post_id: x?.postId || null,
    x_post_url: null,
    x_erro: publicarX ? x?.erro || null : null,
  };
}

module.exports = {
  isConfigured,
  listIntegrations,
  publishContent,
  apiErrorMessage,
};
