const http = require('node:http');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

let servidor;
let hf;
let ultimoBody = null;
let proximoEvento = 0;
const eventos = new Map();
let falhaContextoUsada = false;
const tamanhosZeroGpu = [];

before(async () => {
  servidor = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'sem-barra' }] }));
    }

    if (req.method === 'GET' && req.url.startsWith('/gradio_api/call/generate/')) {
      const id = req.url.split('/').pop();
      const saida = eventos.get(id) || 'Olá mundo';
      if (saida === '__CONTEXTO_LONGO__') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: error\n');
        res.write('data: {"error":"Conversation too long (4209 tokens). Click the clear button."}\n\n');
        return res.end();
      }
      const parcial = saida.startsWith('Olá') ? 'Olá ' : saida;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: generating\ndata: ${JSON.stringify([parcial])}\n\n`);
      res.write(`event: complete\ndata: ${JSON.stringify([saida])}\n\n`);
      return res.end();
    }

    let bruto = '';
    req.on('data', (pedaco) => { bruto += pedaco.toString('utf8'); });
    req.on('end', () => {
      const body = JSON.parse(bruto || '{}');
      ultimoBody = body;

      if (req.url === '/gradio_api/call/v2/generate') {
        const eventId = `evt-${++proximoEvento}`;
        tamanhosZeroGpu.push(String(body.message || '').length);
        eventos.set(
          eventId,
          /FORCAR_CONTEXTO/.test(String(body.message || '')) && !falhaContextoUsada
            ? (falhaContextoUsada = true, '__CONTEXTO_LONGO__')
            : /REGRA DE SAÍDA/.test(String(body.message || ''))
              ? '```json\n{"ok":true}\n```'
              : 'Olá mundo'
        );
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ event_id: eventId }));
      }

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
  process.env.HF_CHAT_ZEROGPU_SPACE = `http://127.0.0.1:${servidor.address().port}`;
  process.env.HF_CHAT_ZEROGPU_FAST_SPACE = `http://127.0.0.1:${servidor.address().port}`;
  delete process.env.HF_CHAT_MODELS;

  delete require.cache[require.resolve('../src/services/hfZeroGpuChatService')];
  delete require.cache[require.resolve('../src/services/hfChatService')];
  hf = require('../src/services/hfChatService');
  require('../src/services/iaPausaService').garantirLiberada = async () => {};
});

after(async () => {
  delete process.env.HF_TOKEN;
  delete process.env.HF_CHAT_BASE_URL;
  delete process.env.HF_CHAT_ZEROGPU_SPACE;
  delete process.env.HF_CHAT_ZEROGPU_FAST_SPACE;
  await new Promise((resolve) => servidor.close(resolve));
});

test('lista somente IDs no formato dono/modelo', async () => {
  assert.deepEqual(await hf.listarModelos(), [
    'zerogpu/Qwen3-4B-Rapido',
    'zerogpu/Qwen3.8-27B',
    'openai/gpt-oss-120b',
  ]);
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

test('crédito por token esgotado cai automaticamente para a cota PRO ZeroGPU', async () => {
  const resposta = await hf.chatCompletion(
    [{ role: 'user', content: 'oi' }],
    { modelo: 'owner/sem-credito', json: false }
  );
  assert.equal(resposta, 'Olá mundo');
});

test('modelo ZeroGPU pode ser escolhido diretamente e mantém streaming', async () => {
  const partes = [];
  const resposta = await hf.chatCompletionStream([{ role: 'user', content: 'olá' }], {
    modelo: 'zerogpu/Qwen3.8-27B',
    onDelta: (parte) => partes.push(parte),
  });
  assert.equal(resposta, 'Olá mundo');
  assert.deepEqual(partes, ['Olá ', 'mundo']);
});

test('perfil rápido limita respostas simples e não envia campos do Space 27B', async () => {
  await hf.chatCompletionStream([{ role: 'user', content: 'olá' }], {
    modelo: 'zerogpu/Qwen3-4B-Rapido',
  });
  assert.equal(ultimoBody.max_new_tokens, 384);
  assert.equal(Object.hasOwn(ultimoBody, 'thinking'), false);
});

test('contexto acima do limite é compactado e repetido automaticamente', async () => {
  falhaContextoUsada = false;
  tamanhosZeroGpu.length = 0;
  const resposta = await hf.chatCompletionStream([
    { role: 'system', content: `FORCAR_CONTEXTO ${'instruções '.repeat(1500)}` },
    { role: 'user', content: 'OLA' },
  ], { modelo: 'zerogpu/Qwen3-4B-Rapido' });
  assert.equal(resposta, 'Olá mundo');
  assert.equal(tamanhosZeroGpu.length, 2);
  assert.ok(tamanhosZeroGpu[1] < tamanhosZeroGpu[0]);
  assert.ok(tamanhosZeroGpu[0] <= 8_600);
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
