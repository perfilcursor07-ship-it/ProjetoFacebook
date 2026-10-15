const http = require('node:http');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

let server;
let gateway;
let lastRequestBody;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', browser: 'connected', providers: 1 }));
      return;
    }
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5' }] }));
      return;
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      lastRequestBody = body;
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Ola ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'mundo' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
          usage: { total_tokens: 12 },
        })
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.AI_PROVIDER = 'token-free';
  process.env.TOKEN_FREE_GATEWAY_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.TOKEN_FREE_GATEWAY_TAREFAS = 'conversa';
  process.env.TOKEN_FREE_GATEWAY_MODEL = 'claude-sonnet-5';

  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/services/tokenFreeGatewayService')];
  gateway = require('../src/services/tokenFreeGatewayService');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('normaliza URL e reforca JSON no prompt', () => {
  assert.equal(
    gateway.normalizarBaseUrl('http://localhost:3456'),
    'http://localhost:3456/v1'
  );
  const mensagens = gateway.prepararMensagens(
    [{ role: 'user', content: 'Retorne um objeto' }],
    true
  );
  assert.equal(mensagens[0].role, 'system');
  assert.match(mensagens[0].content, /JSON valido/);
});

test('o pedido do editor abre a mensagem; o briefing vai curto no fim', () => {
  // No provedor web não há papel de sistema: isto vira um pedido comum e
  // APARECE na conversa. Antes abria por "Preferências fornecidas pelo
  // editor" e dez linhas de regra, e o que o editor escreveu ficava enterrado
  // lá embaixo — era o bastidor no lugar da pergunta.
  const mensagens = gateway.prepararPromptUnicoClaudeWeb([
    { role: 'system', content: 'Não comente regras internas.' },
    { role: 'user', content: 'Faça uma matéria desse vídeo.' },
    { role: 'assistant', content: 'Não vou escrever essa matéria do jeito apresentado.' },
    { role: 'user', content: 'Mas você disse que não ia fazer.' },
  ]);

  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0].role, 'user');
  const texto = mensagens[0].content;

  // Nada de fingir um bloco de sistema que o claude.ai não respeita.
  assert.doesNotMatch(texto, /\bSystem:/i);
  assert.doesNotMatch(texto, /orienta[cç][oõ]es_internas|orienta[cç][oõ]es internas/i);
  assert.doesNotMatch(texto, /Preferências fornecidas pelo editor/);

  // O pedido atual é a primeira coisa que o leitor (e o modelo) encontra.
  assert.ok(texto.startsWith('Mas você disse que não ia fazer.'), texto.slice(0, 80));

  // O histórico continua inteiro: sem ele o modelo nega o que respondeu.
  assert.match(texto, /Contexto anterior da conversa/);
  assert.match(texto, /Assistente: Não vou escrever essa matéria/);
  assert.match(texto, /Usuário: Faça uma matéria desse vídeo\./);

  // E as regras seguem indo — depois do pedido, como rodapé.
  assert.match(texto, /Como responder: Não comente regras internas\./);
  assert.ok(
    texto.indexOf('Como responder:') > texto.indexOf('Contexto anterior'),
    'o briefing é o último bloco'
  );
});

test('sem briefing e sem histórico, vai só o pedido', () => {
  const [m] = gateway.prepararPromptUnicoClaudeWeb([
    { role: 'user', content: 'Uma notícia recente do nicho gospel' },
  ]);
  assert.equal(m.content, 'Uma notícia recente do nicho gospel');
});

test('le resposta OpenAI-compatible e remove cerca de JSON', async () => {
  const resposta = await gateway.chatCompletion(
    [{ role: 'user', content: 'teste' }],
    { json: true, tarefa: 'conversa' }
  );
  assert.equal(resposta, '{"ok":true}');
  assert.equal(lastRequestBody.conversation_id, 'viralizeai:internal:conversa');
  assert.equal(lastRequestBody.conversation_name, 'ViralizeAI — tarefas internas');
  assert.equal(lastRequestBody.web_search, false);
  assert.equal(lastRequestBody.messages.length, 1);
  assert.doesNotMatch(lastRequestBody.messages[0].content, /\bSystem:/i);
});

test('entrega streaming SSE ao chat', async () => {
  const deltas = [];
  const resposta = await gateway.chatCompletionStream(
    [{ role: 'user', content: 'teste' }],
    { tarefa: 'conversa', webSearch: true, onDelta: (delta) => deltas.push(delta) }
  );
  assert.equal(resposta, 'Ola mundo');
  assert.deepEqual(deltas, ['Ola ', 'mundo']);
  assert.equal(lastRequestBody.web_search, true);
});

test('consulta saude e modelos', async () => {
  const saude = await gateway.verificarSaude();
  const modelos = await gateway.listarModelos();
  assert.equal(saude.status, 'ok');
  assert.equal(modelos[0].id, 'claude-sonnet-5');
});
