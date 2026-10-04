const test = require('node:test');
const assert = require('node:assert/strict');

const { janelaDeFontes } = require('../src/services/dotsService');

/** As 26 páginas do pedido real que expôs o problema. */
const VINTE_E_SEIS = Array.from({ length: 26 }, (_, i) => i + 1);

test('lista menor que a janela é varrida inteira', () => {
  const { aVarrer, proximoCursor } = janelaDeFontes([1, 2, 3], 0, 10);
  assert.deepEqual(aVarrer, [1, 2, 3]);
  assert.equal(proximoCursor, 0, 'sem resto, o cursor não precisa andar');
});

test('lista vazia não quebra', () => {
  assert.deepEqual(janelaDeFontes([], 0, 10), { aVarrer: [], proximoCursor: 0 });
  assert.deepEqual(janelaDeFontes(null, 5, 10), { aVarrer: [], proximoCursor: 0 });
});

test('a janela anda a cada volta em vez de repetir as 10 primeiras', () => {
  const primeira = janelaDeFontes(VINTE_E_SEIS, 0, 10);
  assert.deepEqual(primeira.aVarrer, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(primeira.proximoCursor, 10);

  const segunda = janelaDeFontes(VINTE_E_SEIS, primeira.proximoCursor, 10);
  assert.deepEqual(segunda.aVarrer, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(segunda.proximoCursor, 20);

  // A terceira passa do fim e volta ao começo, sem buraco e sem repetir fora de hora.
  const terceira = janelaDeFontes(VINTE_E_SEIS, segunda.proximoCursor, 10);
  assert.deepEqual(terceira.aVarrer, [21, 22, 23, 24, 25, 26, 1, 2, 3, 4]);
  assert.equal(terceira.proximoCursor, 4);
});

test('três voltas cobrem as 26 páginas — era o que não acontecia', () => {
  const vistas = new Set();
  let cursor = 0;
  for (let volta = 0; volta < 3; volta += 1) {
    const { aVarrer, proximoCursor } = janelaDeFontes(VINTE_E_SEIS, cursor, 10);
    aVarrer.forEach((id) => vistas.add(id));
    cursor = proximoCursor;
  }
  assert.equal(vistas.size, 26, `faltaram páginas: ${26 - vistas.size}`);
});

test('cursor inválido não deixa a varredura presa', () => {
  // Valor fora da faixa (lista encurtou, dado corrompido) ainda devolve janela útil.
  for (const cursor of [999, -3, NaN, null, undefined]) {
    const { aVarrer } = janelaDeFontes(VINTE_E_SEIS, cursor, 10);
    assert.equal(aVarrer.length, 10, `cursor ${String(cursor)} devolveu ${aVarrer.length}`);
    assert.equal(new Set(aVarrer).size, 10, 'sem página repetida dentro da mesma volta');
  }
});

// Os testes de `resumoDoPlano` que ficavam aqui foram removidos: a função
// passou a receber a configuração escolhida na tela como terceiro argumento, e
// eles afirmavam o formato antigo. A cobertura do contrato novo está em
// tests/dotsJornada.test.js.

const { rodiziarPorFonte } = require('../src/services/dotsService');

/** Posts já na ordem que o banco devolve: viral_score DESC. */
const POSTS = [
  { id: 1, fonte_id: 10, viral_score: 99 }, // pagina popular
  { id: 2, fonte_id: 10, viral_score: 90 },
  { id: 3, fonte_id: 20, viral_score: 50 },
  { id: 4, fonte_id: 30, viral_score: 10 },
];

test('dá a vez à página que está há mais tempo sem render matéria', () => {
  // A 10 publicou agora; a 20 há muito tempo; a 30 nunca.
  const ultima = new Map([
    [10, Date.now()],
    [20, Date.now() - 60 * 60_000],
  ]);

  const ordem = rodiziarPorFonte(POSTS, ultima).map((p) => p.fonte_id);
  assert.equal(ordem[0], 30, 'quem nunca produziu vai na frente');
  assert.equal(ordem[1], 20);
  assert.equal(ordem[2], 10, 'a mais popular, que acabou de produzir, vai por último');
});

test('a página popular não ganha todas as voltas — era o bug', () => {
  // Sem rodizio, a ordem do banco poria a fonte 10 sempre em primeiro.
  assert.equal(POSTS[0].fonte_id, 10, 'ordem crua do banco');

  let ultima = new Map();
  const escolhidas = [];
  for (let volta = 0; volta < 3; volta += 1) {
    const escolhida = rodiziarPorFonte(POSTS, ultima)[0];
    escolhidas.push(escolhida.fonte_id);
    // Escrever marca a fonte como usada agora.
    ultima = new Map(ultima).set(Number(escolhida.fonte_id), Date.now() + volta);
  }

  assert.equal(new Set(escolhidas).size, 3, `repetiu página: ${escolhidas.join(',')}`);
});

test('dentro da mesma página, o melhor post continua na frente', () => {
  const ordem = rodiziarPorFonte(POSTS, new Map());
  const daFonte10 = ordem.filter((p) => p.fonte_id === 10);
  assert.equal(daFonte10[0].id, 1, 'o de maior viral_score da fonte 10');
});

test('todos os candidatos continuam na lista, só a ordem muda', () => {
  const ordem = rodiziarPorFonte(POSTS, new Map());
  assert.equal(ordem.length, POSTS.length, 'nenhum candidato pode ser descartado');
  assert.deepEqual(
    [...ordem.map((p) => p.id)].sort(),
    [...POSTS.map((p) => p.id)].sort()
  );
  assert.equal(new Set(ordem.map((p) => p.id)).size, POSTS.length, 'sem duplicar');
});

test('lista vazia e empate não quebram', () => {
  assert.deepEqual(rodiziarPorFonte([], new Map()), []);
  const empate = [
    { id: 1, fonte_id: 10, viral_score: 5 },
    { id: 2, fonte_id: 20, viral_score: 5 },
  ];
  assert.equal(rodiziarPorFonte(empate, new Map()).length, 2);
});
