const test = require('node:test');
const assert = require('node:assert/strict');
const { comAbaDeLeitura, ehLinkGoogleNews } = require('../src/services/articleSource');

// Uma pesquisa com 20 links abria 20 abas de uma vez no Chrome do gateway
// (100–300 MB cada) e empurrava o servidor para o swap.
test('no máximo 3 abas de leitura abertas ao mesmo tempo', async () => {
  let abertas = 0;
  let maximo = 0;
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const resultados = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      comAbaDeLeitura(async () => {
        abertas += 1;
        maximo = Math.max(maximo, abertas);
        await espera(10);
        abertas -= 1;
        return i;
      })
    )
  );
  assert.equal(maximo, 3);
  assert.deepEqual(resultados, Array.from({ length: 12 }, (_, i) => i), 'todas as leituras terminam');
});

test('erro numa leitura libera a vaga para a próxima', async () => {
  await assert.rejects(comAbaDeLeitura(async () => { throw new Error('falhou'); }));
  const feitas = await Promise.all([1, 2, 3, 4].map((n) => comAbaDeLeitura(async () => n)));
  assert.deepEqual(feitas, [1, 2, 3, 4]);
});

test('reconhece o link do Google Notícias (que não é a notícia)', () => {
  assert.equal(ehLinkGoogleNews('https://news.google.com/rss/articles/CBMi...'), true);
  assert.equal(ehLinkGoogleNews('https://g1.globo.com/noticia'), false);
  assert.equal(ehLinkGoogleNews('https://www.google.com/search?q=news.google.com'), false);
});
