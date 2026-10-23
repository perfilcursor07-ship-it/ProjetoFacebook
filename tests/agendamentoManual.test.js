const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Remarcar a matéria #6629 para 22:10 voltava para 22:30: o reparo de
// sobreposição (roda ao abrir a aba Agendadas) empurrava para a grade de
// 30 em 30 min todo horário que não fosse de lote ou dos Dots.

const SERVICO = fs.readFileSync('src/services/materiaIaService.js', 'utf8');
const VIEW = fs.readFileSync('public/views/materia-ia-editar.ejs', 'utf8');
const JS = fs.readFileSync('public/js/materia-ia-editar.js', 'utf8');

test('Agendar/Remarcar grava o horário como escolha do editor ("manual")', () => {
  const i = SERVICO.indexOf('async function agendarMateria(');
  const fn = SERVICO.slice(i, SERVICO.indexOf('\n}\n', i));
  assert.match(fn, /origem: 'manual'/);
  // Vale também ao remarcar (job já existente), não só no primeiro agendamento.
  assert.match(fn, /AiFilaJobs\.update\(existing\.id, \{ run_at: slotLivre, payload: payloadManual \}\)/);
});

test('o reparo de sobreposição não mexe no horário manual', () => {
  assert.match(SERVICO, /IN \('lote', 'dots', 'manual'\)/);
});

test('editor oferece +10, +15 e +30 min após o último agendamento', () => {
  assert.match(SERVICO, /const INTERVALOS_SUGERIDOS_MINUTOS = \[10, 15, 30\];/);
  assert.match(VIEW, /class="btn-agendar-mais /);
  assert.match(VIEW, /data-minutos="<%= slot\.minutos %>"/);
  assert.match(JS, /document\.querySelectorAll\('\.btn-agendar-mais'\)/);
});

test('a tela compila', () => {
  const ejs = require('ejs');
  assert.doesNotThrow(() => ejs.compile(VIEW, { filename: 'public/views/materia-ia-editar.ejs' }));
});
