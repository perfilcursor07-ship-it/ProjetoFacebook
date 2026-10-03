const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { semAssuntoRepetidoNaLista } = require('../src/services/dotsService');

const FONTE = 'src/services/dotsService.js';

test('a mesma notícia vinda de dois veículos rende uma matéria só', () => {
  // Caso real: pesquisa eleitoral publicada por UOL e Folha na mesma volta.
  const posts = [
    { id: 1, fonte_id: 10, titulo: 'Em segunda rodada Lula teria 47% dos votos contra 46% de Flávio Bolsonaro' },
    { id: 2, fonte_id: 20, titulo: 'Lula tem 47% e Flávio Bolsonaro 46% dos votos em segunda rodada, diz pesquisa' },
    { id: 3, fonte_id: 30, titulo: 'Igreja Católica em Bangu fecha as portas após chegada de Flávio Bolsonaro' },
  ];

  const escolhidos = semAssuntoRepetidoNaLista(posts);
  const ids = escolhidos.map((p) => p.id);
  assert.equal(escolhidos.length, 2, `esperava 2, veio ${ids.join(',')}`);
  assert.ok(ids.includes(1), 'a primeira versão da notícia fica');
  assert.ok(!ids.includes(2), 'a repetida sai');
  assert.ok(ids.includes(3), 'notícia diferente continua');
});

test('assuntos distintos passam todos', () => {
  const posts = [
    { id: 1, titulo: 'Pastor é preso por desviar dízimo em Goiás' },
    { id: 2, titulo: 'Cantora gospel lança álbum gravado em Jerusalém' },
    { id: 3, titulo: 'Câmara aprova projeto sobre liberdade religiosa' },
  ];
  assert.equal(semAssuntoRepetidoNaLista(posts).length, 3);
});

test('post sem título não é descartado por engano', () => {
  // Sem título não há como comparar; descartar perderia matéria boa.
  const posts = [
    { id: 1, titulo: '' },
    { id: 2, titulo: null },
    { id: 3, titulo: 'Notícia com título' },
  ];
  assert.equal(semAssuntoRepetidoNaLista(posts).length, 3);
});

test('lista vazia e entrada inválida não quebram', () => {
  assert.deepEqual(semAssuntoRepetidoNaLista([]), []);
  assert.deepEqual(semAssuntoRepetidoNaLista(null), []);
  assert.deepEqual(semAssuntoRepetidoNaLista(undefined), []);
});

test('a ordem de entrada é preservada (o rodízio decide quem vem antes)', () => {
  const posts = [
    { id: 7, titulo: 'Primeira notícia sobre o assunto alfa beta gama' },
    { id: 8, titulo: 'Segunda notícia sobre tema completamente diferente aqui' },
  ];
  assert.deepEqual(semAssuntoRepetidoNaLista(posts).map((p) => p.id), [7, 8]);
});

test('o dot checa o histórico da conta antes de escrever', () => {
  // O dot não tinha checagem nenhuma, ao contrário do Furos e do Piloto.
  const fonte = fs.readFileSync(FONTE, 'utf8');
  assert.match(fonte, /marcarJaPublicados/, 'precisa comparar com o que já foi publicado');
  assert.match(fonte, /semRepetirAssunto/, 'a checagem precisa estar no caminho dos candidatos');
});

test('destino "publicar" enfileira de verdade, não só escreve no log', () => {
  // O bug: `if (dot.destino === 'agendar')` era a única ação, e 'publicar'
  // apenas imprimia "na fila" enquanto a matéria ficava parada como rascunho.
  const fonte = fs.readFileSync(FONTE, 'utf8');
  assert.match(
    fonte,
    /destino === 'publicar'\s*\)\s*\{\s*publicada = Boolean\(await agendarSaida/,
    "destino 'publicar' precisa chamar agendarSaida"
  );
  assert.match(fonte, /imediato: true/, 'publicar sai agora, sem espalhar no tempo');
  // E o log não pode mais afirmar "na fila" quando não entrou.
  assert.match(fonte, /não entrou na fila/, 'a falha de enfileiramento tem de aparecer');
});

test('falha do OCR aparece na atividade em vez de só no console', () => {
  const fonte = fs.readFileSync(FONTE, 'utf8');
  assert.match(
    fonte,
    /não consegui checar texto na foto/,
    'OCR quebrado fazia gerar tudo em silêncio, com custo'
  );
});
