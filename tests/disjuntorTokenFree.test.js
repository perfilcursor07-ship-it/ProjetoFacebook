const test = require('node:test');
const assert = require('node:assert/strict');

const { _disjuntor } = require('../src/services/tokenFreeGatewayService');
const { assertDisjuntor, registrarFalha, registrarSucesso, disjuntores, DISJUNTOR_FALHAS } = _disjuntor;

// Por que este arquivo existe — o log de 30/10:
//
//   19:13:14 [biblioteca] traduzir post: ... PoW challenge missing in response
//   19:13:15 [biblioteca] traduzir post: ... PoW challenge missing in response
//   (vinte por minuto, ininterruptas)
//
// A DeepSeek web mudou o desafio anti-robô. Cada tentativa acorda o Chrome do
// gateway; repetir não conserta nada e queima CPU do servidor.

const DEEPSEEK = 'deepseek-v4-flash';
const CHATGPT = 'gpt-5.6';
const pow = () => new Error('Token-Free Gateway falhou (HTTP 502): PoW challenge missing in response');

test.beforeEach(() => disjuntores.clear());

test('falha isolada não corta o provedor', () => {
  // Instabilidade de um pedido só não pode derrubar o resto.
  registrarFalha(pow(), DEEPSEEK);
  assert.doesNotThrow(() => assertDisjuntor(DEEPSEEK));
});

test('falhas seguidas abrem o disjuntor e a chamada falha na hora', () => {
  for (let i = 0; i < DISJUNTOR_FALHAS; i++) registrarFalha(pow(), DEEPSEEK);
  let err = null;
  try {
    assertDisjuntor(DEEPSEEK);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'o disjuntor tinha de ter aberto');
  assert.equal(err.status, 503);
  assert.equal(err.disjuntorAberto, true);
  // A mensagem precisa dizer o que houve e quando volta — ela aparece no log
  // da Biblioteca no lugar das vinte linhas repetidas.
  assert.match(err.message, /fora do ar/i);
  assert.match(err.message, /PoW challenge/);
  assert.match(err.message, /Nova tentativa em \d+s/);
});

test('um provedor fora do ar não derruba o outro', () => {
  // DeepSeek quebrada não pode impedir o editor de escrever no ChatGPT.
  for (let i = 0; i < DISJUNTOR_FALHAS; i++) registrarFalha(pow(), DEEPSEEK);
  assert.throws(() => assertDisjuntor(DEEPSEEK));
  assert.doesNotThrow(() => assertDisjuntor(CHATGPT));
});

test('sucesso fecha o disjuntor', () => {
  for (let i = 0; i < DISJUNTOR_FALHAS; i++) registrarFalha(pow(), DEEPSEEK);
  assert.throws(() => assertDisjuntor(DEEPSEEK));
  registrarSucesso(DEEPSEEK);
  assert.doesNotThrow(() => assertDisjuntor(DEEPSEEK));
});

test('passado o tempo, UMA chamada passa para testar o provedor', () => {
  for (let i = 0; i < DISJUNTOR_FALHAS; i++) registrarFalha(pow(), DEEPSEEK);
  assert.throws(() => assertDisjuntor(DEEPSEEK));
  // Simula o fim da pausa sem esperar os 5 minutos de verdade.
  disjuntores.get(DEEPSEEK).abertoAte = Date.now() - 1;
  assert.doesNotThrow(() => assertDisjuntor(DEEPSEEK), 'a chamada de teste tem de passar');
  // Se ela falhar de novo, volta a abrir na mesma hora — sem recomeçar do zero.
  registrarFalha(pow(), DEEPSEEK);
  assert.throws(() => assertDisjuntor(DEEPSEEK));
});

test('erro passageiro não conta para abrir', () => {
  // Timeout de rede ou queda do gateway se resolvem sozinhos; só desafio
  // anti-robô e sessão expirada é que não adianta insistir.
  const passageiro = new Error('timeout of 30000ms exceeded');
  for (let i = 0; i < DISJUNTOR_FALHAS * 2; i++) registrarFalha(passageiro, DEEPSEEK);
  assert.doesNotThrow(() => assertDisjuntor(DEEPSEEK));
});

test('sessão expirada também abre', () => {
  const sessao = new Error('Sessao do Token-Free Gateway expirada ou sem autorizacao.');
  for (let i = 0; i < DISJUNTOR_FALHAS; i++) registrarFalha(sessao, CHATGPT);
  assert.throws(() => assertDisjuntor(CHATGPT));
});

test('o disjuntor não pode bloquear o desvio para a API oficial', () => {
  // Ele é verificado DENTRO do try, senão a chamada nunca chega ao catch —
  // que é onde mora o desvio para a API paga da DeepSeek. Lançando antes do
  // try, ligar DEEPSEEK_USAR_API=true não adiantaria nada.
  const fonte = require('node:fs').readFileSync('src/services/tokenFreeGatewayService.js', 'utf8');
  for (const [nome, inicio] of [
    ['chatCompletion', 'async function chatCompletion('],
    ['chatCompletionStream', 'async function chatCompletionStream('],
  ]) {
    const corpo = fonte.slice(fonte.indexOf(inicio), fonte.indexOf(inicio) + 2500);
    const tryEm = corpo.indexOf('\n  try {');
    const checagem = corpo.indexOf('assertDisjuntor();');
    assert.ok(tryEm > 0 && checagem > 0, `${nome}: trecho não encontrado`);
    assert.ok(checagem > tryEm, `${nome}: assertDisjuntor está fora do try`);
  }
  // E a marca precisa sobreviver ao normalizarErro, senão o desvio não a vê.
  assert.match(fonte, /if \(err\?\.disjuntorAberto\) normalizado\.disjuntorAberto = true;/);
  assert.match(fonte, /if \(err\?\.disjuntorAberto\) return true;/);
});
