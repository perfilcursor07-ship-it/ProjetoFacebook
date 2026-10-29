const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// O log mostrou o Node do site parado 80–87 s a cada ~5 min durante a
// varredura das fontes; nenhuma página abria. Ela passou a rodar à parte.
const SERVER = fs.readFileSync('src/server.js', 'utf8');
const FILHO = fs.readFileSync('src/varreduraFontes.js', 'utf8');

test('a varredura das fontes não roda mais no processo do site', () => {
  assert.match(SERVER, /fontesSeparado \? \[\] : \[\['biblioteca-fontes'/);
  assert.match(SERVER, /fork\(path\.join\(__dirname, 'varreduraFontes\.js'\)/);
});

test('o processo da varredura sai junto com o site', () => {
  assert.match(FILHO, /process\.on\('disconnect', \(\) => process\.exit\(0\)\)/);
});

test('o log de travamento diz qual fonte estava sendo lida', () => {
  const b = require('../src/services/bibliotecaService');
  assert.equal(typeof b.fonteEmVarredura, 'function');
  assert.match(FILHO, /vigiaLentidao\.iniciar\(/);
});
