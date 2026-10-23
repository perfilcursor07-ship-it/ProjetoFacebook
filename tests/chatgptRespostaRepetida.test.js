const test = require('node:test');
const assert = require('node:assert/strict');
const { removerRespostaRepetida, limparMarcacaoChatgpt } = require('../src/services/chatgptMarkup');

// Caso Tyler Perry: a matéria veio inteira e, logo em seguida, inteira de novo
// (a segunda em markdown simples).
const PRIMEIRA = [
  'Filme de Tyler Perry reúne estrelas da música gospel e apresenta pastor que precisa reencontrar a fé',
  'Uma igreja em dificuldades, uma família pressionada e um pastor enfrentando dúvidas.',
  'O cineasta divulgou o trailer de The Gospel of Christmas. <Cite refs={["turn1search0"]}/>',
  'Fonte: People — https://people.com/tyler-perry',
  '#MúsicaGospel #Netflix',
].join('\n\n');
const SEGUNDA = [
  '**Filme de Tyler Perry reúne estrelas da música gospel e apresenta pastor que precisa reencontrar a fé**',
  'Uma igreja em dificuldades, uma família pressionada e um pastor enfrentando dúvidas.',
  'O cineasta divulgou o trailer de *The Gospel of Christmas*.',
  'Fonte: People — https://people.com/tyler-perry',
  '#MúsicaGospel #Netflix',
].join('\n\n');

test('matéria repetida inteira em seguida: fica só a primeira', () => {
  const limpo = limparMarcacaoChatgpt(`${PRIMEIRA}\n\n${SEGUNDA}`);
  const final = removerRespostaRepetida(limpo);
  assert.equal(final, limparMarcacaoChatgpt(PRIMEIRA));
  assert.equal(final.match(/Filme de Tyler Perry/g).length, 1);
});

test('título citado de novo no fim (sem repetir a matéria) continua', () => {
  const texto = `${PRIMEIRA}\n\nFilme de Tyler Perry reúne estrelas da música gospel e apresenta pastor que precisa reencontrar a fé\n\nE você, assistiria?`;
  assert.equal(removerRespostaRepetida(texto), texto);
});

test('texto normal não é mexido', () => {
  assert.equal(removerRespostaRepetida(PRIMEIRA), PRIMEIRA);
  assert.equal(removerRespostaRepetida('curto'), 'curto');
});
