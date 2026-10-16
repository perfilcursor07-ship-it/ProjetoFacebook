const http = require('node:http');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

// O ChatGPT não manda a foto da galeria: manda a BUSCA numa marca invisível
// (image_group). O log do gateway mostrou isso — a "assinatura" da resposta
// saiu "imagegroup layout carousel aspectratio 4 5 query fellowship". A busca
// é aproveitada para o ViralizeAI achar as mesmas fotos reais.

const E200 = String.fromCharCode(0xe200);
const E201 = String.fromCharCode(0xe201);
const E202 = String.fromCharCode(0xe202);
const MARCA = `${E200}image_group${E202}{"layout":"carousel","aspect_ratio":"4:5","query":["Fellowship Church Ed Young","Ed Young pastor"]}${E201}`;

let server;
let gateway;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      // A marca chega partida entre dois pedaços, como no stream real.
      ev({ choices: [{ delta: { content: MARCA.slice(0, 30) } }] });
      ev({ choices: [{ delta: { content: `${MARCA.slice(30)}\nPastor Ed Young surpreende igreja\n\nCorpo.` } }] });
      ev({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.AI_PROVIDER = 'token-free';
  process.env.TOKEN_FREE_GATEWAY_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.TOKEN_FREE_GATEWAY_TAREFAS = 'conversa';
  process.env.TOKEN_FREE_GATEWAY_MODEL = 'claude-sonnet-5';
  for (const m of ['../src/config/env', '../src/services/tokenFreeGatewayService']) {
    delete require.cache[require.resolve(m)];
  }
  gateway = require('../src/services/tokenFreeGatewayService');
  require('../src/services/iaPausaService').garantirLiberada = async () => {};
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

test('lê as consultas da marca image_group', () => {
  assert.deepEqual(gateway.buscasDeImagemNoTexto(`${MARCA}\nTítulo`), ['Fellowship Church Ed Young', 'Ed Young pastor']);
  assert.deepEqual(gateway.buscasDeImagemNoTexto('texto sem galeria'), []);
});

test('no stream: a busca chega ao ViralizeAI e a marca não entra no texto da matéria', async () => {
  let buscas = null;
  const deltas = [];
  const texto = await gateway.chatCompletionStream([{ role: 'user', content: 'outra' }], {
    tarefa: 'conversa',
    onDelta: (d) => deltas.push(d),
    aoReceberBuscasDeImagem: (b) => { buscas = b; },
  });
  assert.deepEqual(buscas, ['Fellowship Church Ed Young', 'Ed Young pastor']);
  assert.ok(texto.startsWith('Pastor Ed Young surpreende igreja'), texto);
  assert.doesNotMatch(texto + deltas.join(''), /image_group|carousel/);
});

test('sem foto pelos dados, a busca do ChatGPT vai ao buscador de imagens do ViralizeAI', () => {
  const CHAT = fs.readFileSync('src/services/materiaChatService.js', 'utf8');
  const i = CHAT.indexOf("if (chat.modo === 'chatgpt' && buscasDeImagem.length && (!imagensDaConversa.length || fotosDaTela === 0))");
  assert.ok(i > 0);
  assert.match(CHAT.slice(i, i + 900), /buscarImagensPorPalavra\(consulta/);
  // Antes de virar capa (e antes da foto do site citado).
  assert.ok(i < CHAT.indexOf('capaDaConversa = await capaGeradaNaConversa('));
});
