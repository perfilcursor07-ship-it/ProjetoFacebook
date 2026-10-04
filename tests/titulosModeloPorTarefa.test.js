const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const deepseekService = require('../src/services/deepseekService');
const tokenFree = require('../src/services/tokenFreeGatewayService');
const iaModeloTarefa = require('../src/services/iaModeloTarefaService');
const { env } = require('../src/config/env');

async function comSimulacao(modeloFixo, fn) {
  const originais = {
    modeloDaTarefa: iaModeloTarefa.modeloDaTarefa,
    post: axios.post,
    tokenChat: tokenFree.chatCompletion,
    cobreTarefa: tokenFree.cobreTarefa,
    chave: env.deepseekApiKey,
  };
  const chamadas = { api: null, gateway: null };
  iaModeloTarefa.modeloDaTarefa = async (tarefa) => (tarefa === 'titulos' ? modeloFixo : null);
  axios.post = async (_url, body) => {
    chamadas.api = body;
    return { data: { choices: [{ message: { content: '{"titulos":["Título da API"]}' } }], usage: {} } };
  };
  tokenFree.cobreTarefa = () => true;
  tokenFree.chatCompletion = async (_messages, options) => {
    chamadas.gateway = { ...options, modelo: tokenFree.modeloAtual() };
    return '{"titulos":["Título do gateway"]}';
  };
  env.deepseekApiKey = 'sk-teste';
  try {
    await fn(chamadas);
  } finally {
    iaModeloTarefa.modeloDaTarefa = originais.modeloDaTarefa;
    axios.post = originais.post;
    tokenFree.chatCompletion = originais.tokenChat;
    tokenFree.cobreTarefa = originais.cobreTarefa;
    env.deepseekApiKey = originais.chave;
  }
}

test('títulos com DeepSeek fixado em /claude vão pela API oficial, não pelo DeepSeek web do gateway', async () => {
  await comSimulacao('deepseek-v4', async (chamadas) => {
    const raw = await deepseekService.completarComModeloDeTitulos(
      [{ role: 'user', content: 'Gere títulos' }],
      { json: true, tarefa: 'conversa' },
      { somenteClaude: true }
    );
    assert.match(raw, /Título da API/);
    assert.ok(chamadas.api, 'chamou a API do DeepSeek');
    assert.equal(chamadas.gateway, null, 'não passou pelo gateway');
  });
});

test('títulos com ChatGPT fixado seguem pelo gateway, com o modelo fixado', async () => {
  await comSimulacao('gpt-5.6', async (chamadas) => {
    const raw = await deepseekService.completarComModeloDeTitulos(
      [{ role: 'user', content: 'Gere títulos' }],
      { json: true, tarefa: 'conversa' },
      { somenteClaude: true }
    );
    assert.match(raw, /Título do gateway/);
    assert.equal(chamadas.api, null);
    assert.equal(chamadas.gateway.modelo, 'gpt-5.6');
  });
});
