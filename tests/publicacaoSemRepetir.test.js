const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { mesmaNoticiaEstrita } = require('../src/services/editorialGuidelinesFb');
const FONTE = fs.readFileSync('src/services/materiaIaService.js', 'utf8');

test('mesma manchete reescrita é a mesma notícia; assunto parecido não', () => {
  assert.equal(
    mesmaNoticiaEstrita(
      'Lula vence em mais países e soma mais votos que Flávio Bolsonaro no exterior',
      'Lula vence em mais países e soma mais votos que Flávio no exterior'
    ),
    true
  );
  assert.equal(
    mesmaNoticiaEstrita(
      'Lula vence em 17 países e Flávio em oito; veja como brasileiros votam no exterior',
      'Lula vence em mais países e soma mais votos que Flávio Bolsonaro no exterior'
    ),
    false
  );
});

test('a fila não roda duas vezes ao mesmo tempo', () => {
  // Ticks de 60 s sobrepostos publicavam a mesma matéria pelo job e pelo fallback.
  assert.match(FONTE, /if \(filaRodando\) return;/);
  assert.match(FONTE, /whereIn\('ai_fila_jobs\.status', \['pendente', 'processando', 'feito'\]\)/);
});

test('publicação automática não republica nem repete notícia na página', () => {
  assert.match(FONTE, /publicandoAgora\.has\(chave\)/);
  assert.match(FONTE, /a publicação automática não republica/);
  assert.match(FONTE, /mesmaNoticiaJaNaPagina\(\{ userId, pageId: page\.id, matter \}\)/);
});
