const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const servicePath = require.resolve('../src/services/materiaChatService');
const controllerPath = require.resolve('../src/controllers/materiaChatController');

// Por que este arquivo existe: com a DeepSeek recusando as conexões do
// servidor, a tela do editor só dizia
//
//   "Não consegui salvar esta resposta agora. Tente enviar de novo."
//
// Nada tinha deixado de ser salvo. O provedor é que havia recusado, e a
// mensagem escondia justamente o que resolveria — então o editor reenviava
// sem fim. A causa: o controller tratava QUALQUER erro com `err.code` como
// erro de banco, e o axios põe `code` em tudo (`ERR_BAD_RESPONSE`).

const modelosPath = require.resolve('../src/services/materiaModelosService');

function stub(caminho, exports) {
  require.cache[caminho] = { id: caminho, filename: caminho, loaded: true, exports };
}

function carregarController(responder) {
  delete require.cache[controllerPath];
  stub(servicePath, { responder });
  // Sem isto o controller vai ao banco resolver o modelo e morre antes de
  // chegar ao erro que este arquivo testa.
  stub(modelosPath, {
    resolverModelo: async () => null,
    resolverModeloChatgpt: async () => null,
    nomeModeloHumano: (m) => String(m || ''),
    listarHabilitados: async () => [],
  });
  return require(controllerPath);
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.statusCode = 200;
    this.writableEnded = false;
    this.destroyed = false;
    this.headersSent = false;
    this.output = '';
  }
  status(code) {
    this.statusCode = code;
    return this;
  }
  setHeader(name, value) {
    this.headers[name] = value;
  }
  flushHeaders() {
    this.headersSent = true;
  }
  write(chunk) {
    this.output += String(chunk);
    this.headersSent = true;
    return true;
  }
  end(chunk = '') {
    this.output += String(chunk);
    this.writableEnded = true;
    return this;
  }
  json(data) {
    this.end(JSON.stringify(data));
    return this;
  }
}

function fakeRequest() {
  const req = new EventEmitter();
  req.body = { texto: 'ola', tipoConversa: 'livre' };
  req.params = { id: 'nova' };
  req.session = { userId: 2 };
  return req;
}

/** O erro como o tokenFreeGatewayService o entrega. */
function erroDoProvedor(mensagem) {
  const err = new Error(mensagem);
  err.status = 502;
  err.code = 'ERR_BAD_RESPONSE'; // o axios põe isto; não é erro de banco
  err.paraUsuario = true;
  return err;
}

test('recusa do provedor chega à tela, não vira "não consegui salvar"', async () => {
  const recado = 'deepseek-v4-flash está recusando as conexões do servidor. Escolha outro modelo.';
  const res = new FakeResponse();
  const controller = carregarController(async ({ onEvent }) => {
    onEvent({ tipo: 'inicio-resposta' }); // stream já aberto, como na vida real
    throw erroDoProvedor(recado);
  });

  await controller.enviar(fakeRequest(), res, () => {});

  assert.match(res.output, /recusando as conexões do servidor/);
  assert.doesNotMatch(res.output, /Não consegui salvar esta resposta/);
  assert.equal(res.writableEnded, true);
});

test('erro de banco continua escondido atrás da mensagem genérica', async () => {
  // SQL e dados do banco não podem aparecer na tela do editor.
  const res = new FakeResponse();
  const controller = carregarController(async ({ onEvent }) => {
    onEvent({ tipo: 'inicio-resposta' });
    const err = new Error("ER_DUP_ENTRY: Duplicate entry '42' for key 'PRIMARY'");
    err.code = 'ER_DUP_ENTRY';
    err.sqlMessage = "Duplicate entry '42' for key 'PRIMARY'";
    throw err;
  });

  await controller.enviar(fakeRequest(), res, () => {});

  assert.match(res.output, /Não consegui salvar esta resposta/);
  assert.doesNotMatch(res.output, /Duplicate entry/);
  assert.doesNotMatch(res.output, /PRIMARY/);
});

test('o gateway marca as próprias mensagens como legíveis', () => {
  // A decisão fica em quem escreve a mensagem, não em quem a exibe: adivinhar
  // pelo `err.code` foi o que causou o problema.
  const fonte = require('node:fs').readFileSync('src/services/tokenFreeGatewayService.js', 'utf8');
  assert.match(fonte, /normalizado\.paraUsuario = true;/);
  assert.match(fonte, /err\.paraUsuario = true;/, 'o erro do disjuntor também precisa ser legível');
  const controller = require('node:fs').readFileSync('src/controllers/materiaChatController.js', 'utf8');
  assert.match(controller, /!err\.paraUsuario && Boolean\(err\.sql \|\| err\.sqlMessage \|\| err\.code\)/);
});

test('a recusa da DeepSeek vira texto que diz o que fazer', () => {
  // "PoW challenge missing in response" não significa nada para quem está no
  // chat — e era isso que chegava lá.
  const fonte = require('node:fs').readFileSync('src/services/tokenFreeGatewayService.js', 'utf8');
  const i = fonte.indexOf('PoW challenge|create_pow_challenge|Failed to create PoW');
  assert.ok(i > 0, 'o tratamento da recusa da DeepSeek sumiu');
  const trecho = fonte.slice(i, i + 900);
  assert.match(trecho, /verifica(ção|cao) anti-robô/i);
  assert.match(trecho, /Reenviar não resolve/i, 'precisa dizer que insistir não adianta');
  assert.match(trecho, /escolha outro modelo/i, 'precisa dizer o que fazer');
});

test('resposta vazia diz que pode ser recusa, e vale para todo provedor', () => {
  // "Token-Free Gateway falhou: resposta vazia" nao diz nada a quem esta no
  // chat. O caso mais comum e o provedor ter recusado o pedido e encerrado
  // sem escrever nada: a recusa nao vem como erro, vem como silencio.
  const fonte = require('node:fs').readFileSync('src/services/tokenFreeGatewayService.js', 'utf8');
  const i = fonte.indexOf("if (/stream vazio/i.test(String(err?.message");
  assert.ok(i > 0, 'o tratamento do stream vazio sumiu');
  const trecho = fonte.slice(i, i + 900);
  assert.match(trecho, /recusa do provedor/i);
  assert.match(trecho, /reenviar o mesmo texto da no mesmo|reenviar o mesmo texto dá no mesmo/i);
  assert.match(trecho, /erro\.paraUsuario = true;/, 'a mensagem precisa chegar a tela');
  // Antes so o ChatGPT tinha mensagem propria; DeepSeek caia no generico.
  assert.doesNotMatch(trecho, /\^\(gpt\|o\d\|chatgpt\)/);
});
