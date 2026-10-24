const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// /minhas-materias ficava carregando: a aba Viralizou esperava o sync de
// engajamento (35 posts na Ayrshare) terminar antes de responder.

const CONTROLLER = fs.readFileSync('src/controllers/materiasIaController.js', 'utf8').replace(/\r\n/g, '\n');

test('a listagem não espera o sync de engajamento', () => {
  const i = CONTROLLER.indexOf('async function listMinhasMaterias(');
  const fn = CONTROLLER.slice(i, CONTROLLER.indexOf('\n}\n', i));
  assert.doesNotMatch(fn, /await materiaIaService\.sincronizarEngajamentoRecentes/);
  assert.match(fn, /sincronizarEngajamentoPorFora\(req\.session\.userId\)/);
});

test('o sync por fora roda no máximo a cada 10 min por conta', () => {
  assert.match(CONTROLLER, /const SYNC_ENGAJAMENTO_INTERVALO_MS = 10 \* 60 \* 1000;/);
});

test('vigia de lentidão anota página lenta', async () => {
  const { medirRequisicao } = require('../src/services/vigiaLentidao');
  const avisos = [];
  const original = console.warn;
  console.warn = (msg) => avisos.push(msg);
  try {
    const ouvintes = {};
    const res = { statusCode: 200, on: (ev, fn) => { ouvintes[ev] = fn; } };
    medirRequisicao({ method: 'GET', originalUrl: '/minhas-materias?status=all' }, res, () => {});
    await new Promise((r) => setTimeout(r, 1600));
    ouvintes.finish();
  } finally {
    console.warn = original;
  }
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /^\[lento\] GET \/minhas-materias \d+ms \(status 200\)$/);
});

test('a lista usa miniatura, não a capa inteira', () => {
  const view = fs.readFileSync('public/views/minhas-materias.ejs', 'utf8');
  assert.match(view, /return '\/miniatura\/' \+ String\(item\.imagem_path\)/);
  const app = fs.readFileSync('src/app.js', 'utf8');
  assert.match(app, /app\.use\('\/miniatura', require\('\.\/services\/miniaturaService'\)\.servirMiniatura\)/);
});

test('o navegador não dispara mais o lote de sync a cada abertura', () => {
  const js = fs.readFileSync('public/js/minhas-materias.js', 'utf8');
  assert.doesNotMatch(js, /sincronizar-engajamento/);
});
