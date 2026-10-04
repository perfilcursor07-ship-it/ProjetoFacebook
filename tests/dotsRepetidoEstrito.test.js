const test = require('node:test');
const assert = require('node:assert/strict');

/** Banco falso injetado antes de carregar o serviço. */
let publicadas = [];

function builder() {
  const b = {
    where() { return b; },
    andWhere() { return b; },
    select() { return b; },
    whereIn() { return b; },
    whereNull() { return b; },
    count() { return Promise.resolve([{ total: 0 }]); },
    limit() { return Promise.resolve(publicadas); },
    update() { return Promise.resolve(1); },
    first() { return Promise.resolve(null); },
    insert() { return Promise.resolve([1]); },
    groupBy() { return b; },
    whereNotNull() { return b; },
    max() { return Promise.resolve([]); },
    orderBy() { return b; },
    del() { return Promise.resolve(1); },
  };
  return b;
}
const dbFalso = () => builder();
dbFalso.fn = { now: () => new Date() };
dbFalso.raw = (x) => x;
dbFalso.transaction = async (fn) => fn(dbFalso);

const caminhoDb = require.resolve('../src/config/db');
require.cache[caminhoDb] = { id: caminhoDb, filename: caminhoDb, loaded: true, exports: dbFalso };

const { filtrarJaPublicados, DIAS_HISTORICO_REPETIDO } = require('../src/services/dotsService');

const DOT = { id: 1, user_id: 7 };

test('manchetes de política diferentes não são tratadas como repetidas', async () => {
  // Era exatamente isto que travava o dot "Política": 'lula', 'bolsonaro' e
  // 'governo' aparecem juntas em quase toda manchete, e a regra antiga aceitava
  // 3 palavras em comum como "mesmo assunto".
  publicadas = [
    { titulo: 'Lula critica Bolsonaro em discurso sobre o governo federal', fonte_url: 'https://a.com/1' },
  ];

  const posts = [
    { id: 1, url: 'https://b.com/10', titulo: 'Bolsonaro responde Lula e cobra do governo mais verba' },
    { id: 2, url: 'https://b.com/11', titulo: 'Governo de Lula anuncia reforma que irrita Bolsonaro' },
  ];

  const { novos, porTitulo } = await filtrarJaPublicados(DOT, posts);
  assert.equal(porTitulo, 0, 'nenhuma delas é a mesma notícia');
  assert.equal(novos.length, 2, 'as duas tinham de passar');
});

test('a mesma notícia reescrita continua sendo barrada', async () => {
  publicadas = [
    {
      titulo: 'Terremoto de magnitude 7,1 atinge o Japão e deixa moradores evacuados',
      fonte_url: 'https://a.com/japao',
    },
  ];

  const posts = [
    {
      id: 1,
      url: 'https://b.com/outro',
      titulo: 'Terremoto magnitude 7,1 atinge Japão com moradores evacuados das cidades',
    },
  ];

  const { novos, porTitulo } = await filtrarJaPublicados(DOT, posts);
  assert.equal(porTitulo, 1, 'título quase idêntico é a mesma notícia');
  assert.equal(novos.length, 0);
});

test('o mesmo link é barrado mesmo com título diferente', async () => {
  publicadas = [{ titulo: 'Qualquer coisa', fonte_url: 'https://portal.com/noticia-42' }];

  const posts = [
    { id: 1, url: 'https://portal.com/noticia-42?utm_source=fb', titulo: 'Outro título bem diferente aqui' },
    { id: 2, url: 'https://portal.com/noticia-43', titulo: 'Notícia nova de verdade' },
  ];

  const { novos, porUrl } = await filtrarJaPublicados(DOT, posts);
  assert.equal(porUrl, 1, 'query string e barra final não podem enganar');
  assert.deepEqual(novos.map((p) => p.id), [2]);
});

test('sem histórico, tudo passa', async () => {
  publicadas = [];
  const posts = [
    { id: 1, url: 'https://x.com/a', titulo: 'Primeira matéria do dia' },
    { id: 2, url: 'https://x.com/b', titulo: 'Segunda matéria, outro assunto' },
  ];
  const { novos, porUrl, porTitulo } = await filtrarJaPublicados(DOT, posts);
  assert.equal(novos.length, 2);
  assert.equal(porUrl + porTitulo, 0);
});

test('post sem título ou sem link não é descartado por engano', async () => {
  publicadas = [{ titulo: 'Alguma matéria antiga', fonte_url: 'https://a.com/1' }];
  const posts = [
    { id: 1, url: '', titulo: '' },
    { id: 2, url: 'https://novo.com/x', titulo: null },
  ];
  const { novos } = await filtrarJaPublicados(DOT, posts);
  assert.equal(novos.length, 2, 'sem dado para comparar, o post segue para a IA decidir');
});

test('a janela de comparação é curta, não o histórico inteiro', () => {
  // Comparar com 1000 matérias de todo o histórico era parte do problema.
  assert.ok(DIAS_HISTORICO_REPETIDO >= 1 && DIAS_HISTORICO_REPETIDO <= 30, 'janela em dias');
  assert.equal(DIAS_HISTORICO_REPETIDO, 7, 'padrão de uma semana');
});
