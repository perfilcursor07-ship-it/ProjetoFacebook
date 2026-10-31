const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const STREAM = fs.readFileSync(
  'gateway-overrides/token-free-gateway/src/providers/deepseek/stream.ts',
  'utf8'
);

// Por que este arquivo existe: "abriu a resposta e não escreveu nada" tem
// DUAS causas que se parecem na tela — o provedor recusou o assunto, ou o
// formato do stream mudou e o parser não entendeu. Este cliente já teve três
// casos do segundo tipo (desafio anti-robô, id da conversa, caminho do
// token). Sem ver as linhas cruas, dizer qual é das duas é chute — e eu
// cheguei a afirmar "é recusa" sem ter essa prova.

test('texto vazio deixa rastro do que chegou', () => {
  assert.ok(STREAM.includes('[viralizeai-deepseek] stream sem texto'));
  assert.ok(STREAM.includes('if (!text.trim()) {'));
  assert.ok(STREAM.includes('amostra.join(" | ")'));
});

test('o tamanho do pensamento separa recusa de erro de parser', () => {
  // Pensamento cheio + texto vazio = o modelo escreveu e o parser perdeu.
  // Os dois vazios = o provedor não respondeu nada.
  assert.match(STREAM, /pensamento: \$\{thinkingText\.trim\(\)\.length\} chars/);
});

test('a amostra é limitada e censurada', () => {
  // Diagnóstico não pode virar despejo de log nem vazamento: cadeia longa
  // pode ser credencial ou id de sessão.
  assert.ok(STREAM.includes('amostra.length >= 12'));
  assert.ok(STREAM.includes('.replace(/[A-Za-z0-9._-]{30,}/g, "<...>")'));
  assert.ok(STREAM.includes('.slice(0, 200)'));
  assert.ok(STREAM.includes('.slice(0, 1200)'));
});

test('a amostra é colhida de toda linha, antes de qualquer interpretação', () => {
  // Se fosse colhida depois do parse, o caso que importa (parser não
  // entendeu) seria justamente o que não deixaria rastro.
  const i = STREAM.indexOf('const processLine = (line: string) => {');
  assert.ok(i > 0);
  assert.match(STREAM.slice(i, i + 120), /guardarAmostra\(line\);/);
});

test('nada muda quando há texto', () => {
  // O aviso só existe no caminho vazio; resposta normal segue igual.
  const i = STREAM.indexOf('if (!text.trim()) {');
  const j = STREAM.indexOf('return { text: text.trim()', i);
  assert.ok(j > i, 'o retorno continua logo depois, sem alterar o resultado');
});
