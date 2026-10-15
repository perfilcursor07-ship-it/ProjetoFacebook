const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Caso real (#5646): a Ayrshare recusou o post do Facebook com `postIds: []`
 * e o erro só no array `errors`. O sistema não olhava ali e marcava a matéria
 * como "Publicada" — e ela nunca aparecia na Página.
 */

process.env.AYRSHARE_API_KEY = process.env.AYRSHARE_API_KEY || 'teste';

const axios = require('axios');
const respostas = { post: null, get: null };
axios.post = async () => ({ data: respostas.post });
axios.get = async () => ({ data: respostas.get || {} });

const { publishToFacebook } = require('../src/services/ayrshareService');

const PEDIDO = {
  post: 'Texto da matéria',
  imageUrl: 'https://exemplo.com/foto.jpg',
  publicarFacebook: true,
};

test('erro do Facebook só no array `errors` não vira "publicada"', async () => {
  respostas.post = {
    status: 'error',
    id: 'aTLc6KNTfq3a2gpH5Mpt',
    postIds: [],
    errors: [
      {
        code: 274,
        status: 'error',
        platform: 'facebook',
        message: 'Our system detected a high posting frequency, which the social networks might consider to be spam.',
      },
    ],
  };
  respostas.get = respostas.post;
  await assert.rejects(publishToFacebook(PEDIDO), (err) => err.status === 502);
});

test('status geral "error" sem resultado do Facebook também falha', async () => {
  respostas.post = { status: 'error', id: 'x1', postIds: [] };
  respostas.get = respostas.post;
  await assert.rejects(publishToFacebook(PEDIDO));
});

test('sucesso do Facebook continua sendo sucesso', async () => {
  respostas.post = {
    status: 'success',
    id: 'ok1',
    postIds: [{ platform: 'facebook', status: 'success', id: '123_456', postUrl: 'https://facebook.com/123_456' }],
  };
  const r = await publishToFacebook(PEDIDO);
  assert.equal(r.post_id, 'ayrshare:ok1');
  assert.equal(r.fb_native_post_id, '123_456');
});

test('resposta só com o ID (processando) e sem erro não é tratada como falha', async () => {
  respostas.post = { status: 'success', id: 'proc1' };
  respostas.get = { status: 'success', id: 'proc1' };
  const r = await publishToFacebook(PEDIDO);
  assert.equal(r.post_id, 'ayrshare:proc1');
});
