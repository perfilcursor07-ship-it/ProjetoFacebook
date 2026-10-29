const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Com o token-free ligado, "DeepSeek" tem que sair pelo DeepSeek web do
// gateway — nunca pela API paga (DEEPSEEK_API_KEY), nem quando o web falha.

const pedidos = [];
let falharGateway = false;
const gateway = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => (corpo += c));
  req.on('end', () => {
    const body = JSON.parse(corpo || '{}');
    pedidos.push(body);
    if (falharGateway) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'PoW challenge missing in response' } }));
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'olá ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'mundo' } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
});

let apiPagaChamada = 0;
test.before(async () => {
  await new Promise((r) => gateway.listen(0, r));
  process.env.AI_PROVIDER = 'token-free';
  process.env.TOKEN_FREE_GATEWAY_BASE_URL = `http://127.0.0.1:${gateway.address().port}/v1`;
  process.env.TOKEN_FREE_GATEWAY_MODEL = 'claude-sonnet-5';
  process.env.TOKEN_FREE_GATEWAY_TAREFAS = 'conversa';
  process.env.DEEPSEEK_API_KEY = 'sk-teste';
  delete process.env.DEEPSEEK_USAR_API;
  // Qualquer ida à API oficial é falha do teste.
  const axios = require('axios');
  const post = axios.post.bind(axios);
  axios.post = (url, ...resto) => {
    if (/api\.deepseek\.com/.test(String(url))) {
      apiPagaChamada += 1;
      return Promise.reject(new Error('chamou a API paga'));
    }
    return post(url, ...resto);
  };
  require('../src/services/iaPausaService').garantirLiberada = async () => {};
});
test.after(() => gateway.close());

test('chamada "DeepSeek direto" vai pelo DeepSeek web do gateway', async () => {
  const ds = require('../src/services/deepseekService');
  pedidos.length = 0;
  const r = await ds.chatCompletionDeepseekDireto([{ role: 'user', content: 'oi' }], { json: true });
  assert.equal(r, '{"ok":true}');
  assert.equal(pedidos.length, 1);
  assert.match(pedidos[0].model, /^deepseek-v4-(flash|pro)$/);
  assert.equal(apiPagaChamada, 0);
});

test('Dot com provedor "deepseek" e tarefa fora da lista do gateway também', async () => {
  const ds = require('../src/services/deepseekService');
  pedidos.length = 0;
  await ds.comProvedor('deepseek', () =>
    ds.chatCompletion([{ role: 'user', content: 'oi' }], { tarefa: 'redacao' })
  );
  assert.equal(pedidos.length, 1);
  assert.match(pedidos[0].model, /^deepseek-v4/);
  assert.equal(apiPagaChamada, 0);
});

test('streaming forçado em DeepSeek vai pelo gateway', async () => {
  const ds = require('../src/services/deepseekService');
  pedidos.length = 0;
  const pedacos = [];
  const texto = await ds.chatCompletionStream([{ role: 'user', content: 'oi' }], {
    forceDeepseek: true,
    onDelta: (d) => pedacos.push(d),
  });
  assert.equal(texto, 'olá mundo');
  assert.match(pedidos[0].model, /^deepseek-v4/);
  assert.equal(apiPagaChamada, 0);
});

test('DeepSeek web falhando não desvia para a API paga', async () => {
  const tf = require('../src/services/tokenFreeGatewayService');
  falharGateway = true;
  try {
    await assert.rejects(
      tf.comModelo('deepseek-v4-flash', () => tf.chatCompletion([{ role: 'user', content: 'oi' }], { tarefa: 'conversa' }))
    );
  } finally {
    falharGateway = false;
  }
  assert.equal(apiPagaChamada, 0);
});

test('DEEPSEEK_USAR_API=true volta a usar a API oficial', () => {
  const tf = require('../src/services/tokenFreeGatewayService');
  process.env.DEEPSEEK_USAR_API = 'true';
  try {
    assert.equal(tf.deepseekPeloGateway(), false);
  } finally {
    delete process.env.DEEPSEEK_USAR_API;
  }
  assert.equal(tf.deepseekPeloGateway(), true);
});
