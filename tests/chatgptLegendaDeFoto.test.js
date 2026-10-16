const test = require('node:test');
const assert = require('node:assert/strict');
const { limparMarcacaoChatgpt, criarLimpadorDeStream } = require('../src/services/chatgptMarkup');

// O ChatGPT desenha a legenda da foto com <text color="secondary" size="sm">…
// e ela chegava como texto no meio da matéria (caso Sued Silva).
const LEGENDA = '<text color="secondary" size="sm">Foto: Sued Silva durante apresentação musical. Reprodução: Fuxico Gospel.</text>';

test('a legenda de foto do ChatGPT sai da matéria', () => {
  const texto = `Primeiro parágrafo.\n${LEGENDA}\n“Uma nova estação” na música gospel`;
  assert.equal(limparMarcacaoChatgpt(texto), 'Primeiro parágrafo.\n“Uma nova estação” na música gospel');
});

test('no streaming a legenda não aparece nem pela metade', () => {
  const limpador = criarLimpadorDeStream();
  const pedacos = ['Primeiro parágrafo.\n<text color="secondary"', ' size="sm">Foto: Sued', ' Silva.</text>\nDepois.'];
  const visto = [];
  for (const p of pedacos) {
    visto.push(limpador.empurrar(p));
    assert.doesNotMatch(visto.join(''), /<text|Foto: Sued/);
  }
  assert.equal(visto.join(''), 'Primeiro parágrafo.\nDepois.');
});

test('texto sem legenda continua igual', () => {
  assert.equal(limparMarcacaoChatgpt('Matéria com <b>negrito</b> e texto normal.'), 'Matéria com <b>negrito</b> e texto normal.');
});
