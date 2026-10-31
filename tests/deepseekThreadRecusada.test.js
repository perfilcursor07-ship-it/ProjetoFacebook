const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const CLIENTE = fs.readFileSync(
  'gateway-overrides/token-free-gateway/src/providers/deepseek/client.ts',
  'utf8'
);

// Por que este arquivo existe — o que o diagnóstico do stream revelou:
//
//   [viralizeai-deepseek] stream sem texto (pensamento: 0 chars).
//   Primeiras linhas: {"code":0,"msg":"","data":{"biz_code":26,
//   "biz_msg":"invalid message id","biz_data":null}}
//
// HTTP 200, `code: 0` — sucesso no envelope de fora. O erro está no
// `biz_code`, e o stream termina sem uma linha de texto. Na tela virava
// "abriu a resposta e não escreveu nada", que parece recusa do provedor ao
// ASSUNTO — conclusão que eu cheguei a afirmar duas vezes, e que era falsa.
// Sempre foi a segunda mensagem da conversa que quebrava.

test('o erro de thread é reconhecido pelo biz_code', () => {
  assert.match(CLIENTE, /private static threadRecusada\(/);
  // `code: 0` no envelope de fora: olhar só o HTTP ou o code nunca pegaria.
  assert.ok(CLIENTE.includes('"biz_code"'));
  assert.ok(CLIENTE.includes(String.raw`invalid\s+message\s+id`));
});

test('a conversa é reaberta e a mensagem reenviada, uma vez', () => {
  assert.ok(CLIENTE.includes('this.chatSessionId = "";'));
  assert.ok(CLIENTE.includes('this.parentMessageId = null;'));
  assert.match(CLIENTE, /for \(let tentativa = 0; tentativa < 2; tentativa\+\+\)/);
  assert.ok(CLIENTE.includes('tentativa === 0 && DeepSeekWebClient.threadRecusada(inicio)'));
  // Duas falhas seguidas param: insistir num laço não conserta nada.
  assert.ok(CLIENTE.includes('recusou a conversa duas vezes seguidas'));
});

test('o stream espiado é devolvido inteiro a quem consome', () => {
  // O erro chega na primeira linha; depois que o parser começa é tarde, o
  // stream não volta atrás. Espiar sem consumir é o que permite reenviar.
  assert.match(CLIENTE, /private static async espiarInicio\(/);
  const i = CLIENTE.indexOf('private static async espiarInicio(');
  const trecho = CLIENTE.slice(i, i + 1600);
  assert.match(trecho, /let pendente: Uint8Array \| undefined/);
  assert.match(trecho, /controller\.enqueue\(repetir\);/, 'o pedaço espiado precisa voltar para a fila');
  assert.match(trecho, /reader\.cancel\(motivo\)/, 'cancelar o consumo precisa cancelar a origem');
});

test('o stream descartado na retentativa é cancelado', () => {
  // Sem cancelar, a resposta abandonada fica ocupando a conexão do gateway.
  assert.ok(CLIENTE.includes('await stream.cancel().catch(() => {});'));
});

test('a reabertura aparece no log', () => {
  // Para distinguir, nos próximos casos, "reabriu e funcionou" de "quebrou".
  assert.match(CLIENTE, /thread recusada \(invalid message id\); abrindo conversa nova/);
});

test('o override chegou ao gateway instalado', () => {
  const alvo = '.tools/token-free-gateway/src/providers/deepseek/client.ts';
  if (!fs.existsSync(alvo)) return; // gateway não instalado nesta máquina
  assert.equal(fs.readFileSync(alvo, 'utf8'), CLIENTE, 'rode npm run gateway:sync');
});
