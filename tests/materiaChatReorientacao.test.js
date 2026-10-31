const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  pedidoReorientaMateriaAnterior,
} = require('../src/services/materiaChatService');

test('reconhece quando o editor corrige o foco da matéria anterior', () => {
  for (const pedido of [
    'FAÇA UMA MATERIA ALGO ASSIM, PASTORA E EXPULSA DA IGREJA APOS AFIRMAR QUE VOTOU NO LULA',
    'Refaça a matéria com o foco na pastora expulsa da igreja',
    'Escreva uma reportagem — o foco correto é a expulsão da pastora',
    'Na verdade, faça uma matéria: pastora diz que foi expulsa após votar em Lula',
  ]) {
    assert.equal(pedidoReorientaMateriaAnterior(pedido, true), true, pedido);
  }
});

test('não confunde ajuste de estilo ou pauta nova com correção de foco', () => {
  for (const pedido of [
    'deixe essa matéria mais curta',
    'faça o título mais forte',
    'faça uma matéria sobre Silas Malafaia',
    'faça uma matéria algo assim: teste https://exemplo.com/nova-fonte',
  ]) {
    assert.equal(pedidoReorientaMateriaAnterior(pedido, true), false, pedido);
  }
  assert.equal(
    pedidoReorientaMateriaAnterior('faça uma matéria algo assim: novo foco', false),
    false
  );
});

test('correção de foco descarta a redação e o histórico anteriores', () => {
  const codigo = fs.readFileSync('src/services/materiaChatService.js', 'utf8');
  assert.match(codigo, /pedidoReorientaMateria\s*\?\s*\[\]/);
  assert.match(codigo, /IGNORE COMPLETAMENTE a matéria anterior/);
  assert.match(codigo, /FONTE ORIGINAL DA MATÉRIA/);
  assert.match(codigo, /pedidoReorientaMateria && fontes\.length > 0/);
});
