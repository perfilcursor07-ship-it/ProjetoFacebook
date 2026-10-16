const http = require('node:http');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

// O "ChatGPT livre" do começo ao fim, com um gateway falso no lugar do real:
// o que chega ao ChatGPT, em qual conversa, e o que volta (texto, imagem e o
// ponteiro da conversa).

let server;
let corpos = [];
let deepseek;
let gateway;
const IMAGEM = `data:image/png;base64,${Buffer.alloc(2048, 7).toString('base64')}`;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      corpos.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      ev({ choices: [{ delta: { content: 'Título da matéria\n\n' } }] });
      ev({ choices: [{ delta: { content: 'Corpo.' } }] });
      ev({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      ev({ imagens: [IMAGEM] });
      ev({ conversa: 'chatgpt:6ad19384-0000-4000-8000-000000000001:aaaa0000-0000-4000-8000-000000000002', conversa_url: 'https://chatgpt.com/c/6ad19384-0000-4000-8000-000000000001' });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.AI_PROVIDER = 'token-free';
  process.env.TOKEN_FREE_GATEWAY_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.TOKEN_FREE_GATEWAY_TAREFAS = 'conversa';
  process.env.TOKEN_FREE_GATEWAY_MODEL = 'claude-sonnet-5';
  for (const m of ['../src/config/env', '../src/services/tokenFreeGatewayService', '../src/services/deepseekService']) {
    delete require.cache[require.resolve(m)];
  }
  gateway = require('../src/services/tokenFreeGatewayService');
  deepseek = require('../src/services/deepseekService');
  // "Parar IA" consulta o banco; aqui não há banco.
  require('../src/services/iaPausaService').garantirLiberada = async () => {};
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

async function conversar(extra) {
  const recebido = { deltas: [], imagens: [], conversa: null };
  const texto = await gateway.comModelo('gpt-5.6', () => deepseek.conversarLivre({
    pedido: 'uma notícia gospel recente com imagem',
    historico: [],
    memoriaEditorial: 'PAUTA DA CASA: público evangélico.',
    pesquisarWeb: true,
    conversationId: 'viralizeai:chatgpt:user:1:chat:2',
    onDelta: (d) => recebido.deltas.push(d),
    aoReceberImagens: (urls) => recebido.imagens.push(...urls),
    aoReceberConversa: (c) => { recebido.conversa = c; },
    ...extra,
  }));
  return { texto, recebido, corpo: corpos[corpos.length - 1] };
}

test('primeira mensagem: o pedido como foi escrito + orientação uma vez, sem bastidor', async () => {
  const { texto, recebido, corpo } = await conversar({ chatgptDireto: { primeira: true } });
  assert.equal(corpo.model, 'gpt-5.6');
  assert.equal(corpo.messages.length, 1, 'uma mensagem só, como alguém digitando');
  const enviado = corpo.messages[0].content;
  assert.ok(enviado.startsWith('uma notícia gospel recente com imagem'), 'o pedido abre a mensagem');
  assert.match(enviado, /Como responder nesta conversa:/);
  assert.match(enviado, /PAUTA DA CASA/);
  assert.doesNotMatch(enviado, /Modo livre|Nunca revele|Human:|System:/);
  assert.match(corpo.conversation_id, /^viralizeai:chatgpt:user:1:chat:2/);

  assert.equal(texto, 'Título da matéria\n\nCorpo.');
  assert.deepEqual(recebido.imagens, [IMAGEM], 'a imagem chega já baixada');
  assert.equal(recebido.conversa.url, 'https://chatgpt.com/c/6ad19384-0000-4000-8000-000000000001');
});

test('mensagens seguintes: só o que o editor escreveu, na mesma conversa', async () => {
  const ponteiro = 'chatgpt:6ad19384-0000-4000-8000-000000000001:aaaa0000-0000-4000-8000-000000000002';
  const { corpo } = await conversar({
    pedido: 'deixe mais curta',
    chatgptDireto: { primeira: false },
    conversationId: ponteiro,
  });
  assert.deepEqual(corpo.messages, [{ role: 'user', content: 'deixe mais curta' }]);
  assert.ok(corpo.conversation_id.startsWith(ponteiro));
});

test('Claude livre continua com as regras de sempre', async () => {
  const { corpo } = await conversar({ chatgptDireto: null });
  assert.match(corpo.messages[0].content, /Modo livre/);
});
