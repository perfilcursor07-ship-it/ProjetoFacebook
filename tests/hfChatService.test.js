const http = require('node:http');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

let servidor;
let hf;
let ultimoBody = null;

before(async () => {
  servidor = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'sem-barra' }] }));
    }

    let bruto = '';
    req.on('data', (pedaco) => { bruto += pedaco.toString('utf8'); });
    req.on('end', () => {
      const body = JSON.parse(bruto || '{}');
      ultimoBody = body;

      if (body.model === 'owner/sem-credito') {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'No credits remaining' } }));
      }

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Olá ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'mundo' } }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }

      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }));
    });
  });

  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  process.env.HF_TOKEN = 'hf_token_de_teste';
  process.env.HF_CHAT_BASE_URL = `http://127.0.0.1:${servidor.address().port}/v1`;
  delete process.env.HF_CHAT_MODELS;

  delete require.cache[require.resolve('../src/services/hfChatService')];
  hf = require('../src/services/hfChatService');
  require('../src/services/iaPausaService').garantirLiberada = async () => {};
});

after(async () => {
  delete process.env.HF_TOKEN;
  delete process.env.HF_CHAT_BASE_URL;
  await new Promise((resolve) => servidor.close(resolve));
});

test('lista somente IDs no formato dono/modelo', async () => {
  assert.deepEqual(await hf.listarModelos(), ['openai/gpt-oss-120b']);
});

test('completa pelo router OpenAI-compatible e limpa cercas de JSON', async () => {
  const resposta = await hf.chatCompletion([{ role: 'user', content: 'responda' }], {
    modelo: 'openai/gpt-oss-120b',
    json: true,
  });
  assert.equal(resposta, '{"ok":true}');
  assert.equal(ultimoBody.model, 'openai/gpt-oss-120b');
  assert.equal(ultimoBody.stream, false);
  assert.match(ultimoBody.messages.at(-1).content, /APENAS com o JSON/);
});

test('stream entrega deltas e devolve o texto completo', async () => {
  const partes = [];
  const resposta = await hf.chatCompletionStream([{ role: 'user', content: 'olá' }], {
    modelo: 'openai/gpt-oss-120b',
    onDelta: (parte) => partes.push(parte),
  });
  assert.equal(resposta, 'Olá mundo');
  assert.deepEqual(partes, ['Olá ', 'mundo']);
});

test('erro de crédito é traduzido e pode ser exibido ao editor', async () => {
  await assert.rejects(
    hf.chatCompletion([{ role: 'user', content: 'oi' }], { modelo: 'owner/sem-credito', json: false }),
    (err) => err.status === 429 && err.code === 'HF_SEM_CREDITO' && err.paraUsuario === true
  );
});

test('modelo HF escolhido tem prioridade sobre o free tier e dispensa DeepSeek', async () => {
  const gateway = require('../src/services/tokenFreeGatewayService');
  const freeTier = require('../src/services/freeTierGateway');
  const deepseek = require('../src/services/deepseekService');
  const cobreOriginal = freeTier.cobreTarefa;
  const completarOriginal = freeTier.chatCompletion;
  let chamadasGratis = 0;
  freeTier.cobreTarefa = () => true;
  freeTier.chatCompletion = async () => { chamadasGratis += 1; return 'gratis'; };

  try {
    await gateway.comModelo('openai/gpt-oss-120b', async () => {
      assert.doesNotThrow(() => deepseek.assertDeepseek('conversa'));
      const resposta = await deepseek.chatCompletion([{ role: 'user', content: 'oi' }], {
        tarefa: 'conversa',
        json: true,
      });
      assert.equal(resposta, '{"ok":true}');
    });
    assert.equal(chamadasGratis, 0);
  } finally {
    freeTier.cobreTarefa = cobreOriginal;
    freeTier.chatCompletion = completarOriginal;
  }
});
