const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const { env } = require('../src/config/env');
const tokenFree = require('../src/services/tokenFreeGatewayService');
const deepseek = require('../src/services/deepseekService');

/** O gateway responde como em produção: DeepSeek web sem o desafio anti-robô. */
function erroPow() {
  return Object.assign(new Error('Request failed with status code 502'), {
    response: { status: 502, data: { error: { message: 'PoW challenge missing in response' } } },
  });
}

async function cenario({ chave = 'chave-teste' } = {}, fn) {
  const originais = { post: axios.post, completar: deepseek.chatCompletion, chave: env.deepseekApiKey };
  const chamadas = [];
  axios.post = async () => {
    throw erroPow();
  };
  deepseek.chatCompletion = async (messages, opcoes) => {
    chamadas.push(opcoes);
    return 'texto da API oficial';
  };
  env.deepseekApiKey = chave;
  try {
    return await fn(chamadas);
  } finally {
    axios.post = originais.post;
    deepseek.chatCompletion = originais.completar;
    env.deepseekApiKey = originais.chave;
  }
}

const MSGS = [{ role: 'user', content: 'oi' }];

test('DeepSeek web sem PoW: a mesma chamada segue pela API oficial da DeepSeek', async () => {
  await cenario({}, async (chamadas) => {
    const texto = await tokenFree.comModelo('deepseek-v4-flash', () =>
      tokenFree.chatCompletion(MSGS, { json: false, tarefa: 'conversa' }));
    assert.equal(texto, 'texto da API oficial');
    assert.equal(chamadas.length, 1);
  });
});

test('outro modelo (Claude) não é desviado: o erro aparece como antes', async () => {
  await cenario({}, async (chamadas) => {
    await assert.rejects(
      tokenFree.comModelo('claude-sonnet-5', () => tokenFree.chatCompletion(MSGS, { json: false, tarefa: 'conversa' })),
      /Token-Free Gateway falhou/
    );
    assert.equal(chamadas.length, 0);
  });
});

test('sem DEEPSEEK_API_KEY não há para onde desviar: mantém o erro do gateway', async () => {
  await cenario({ chave: '' }, async (chamadas) => {
    await assert.rejects(
      tokenFree.comModelo('deepseek-v4-flash', () => tokenFree.chatCompletion(MSGS, { json: false, tarefa: 'conversa' })),
      /PoW challenge missing/
    );
    assert.equal(chamadas.length, 0);
  });
});
