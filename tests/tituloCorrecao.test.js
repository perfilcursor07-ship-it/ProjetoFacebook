const test = require('node:test');
const assert = require('node:assert/strict');

const { proporcaoReescrita } = require('../src/services/tituloCorrecaoService');

test('acento, caixa e pontuação não contam como reescrita', () => {
  const original = 'pastor anuncia nova igreja em sao paulo e fieis comemora';
  const corrigido = 'Pastor anuncia nova igreja em São Paulo e fiéis comemoram';
  assert.ok(proporcaoReescrita(original, corrigido) <= 0.3);
});

test('erro de digitação corrigido não conta como reescrita', () => {
  assert.equal(proporcaoReescrita('Otoni de Paula encera ciclo na politca', 'Otoni de Paula encerra ciclo na política'), 0);
});

test('trocar palavras e o sentido conta como reescrita', () => {
  const original = 'Otoni de Paula encerra ciclo político após derrota';
  const reescrito = 'Após perder a eleição, deputado deixa a vida pública';
  assert.ok(proporcaoReescrita(original, reescrito) > 0.3);
});

test('título idêntico tem zero de mudança', () => {
  const t = 'Igreja anuncia campanha nacional de doação de sangue';
  assert.equal(proporcaoReescrita(t, t), 0);
});
