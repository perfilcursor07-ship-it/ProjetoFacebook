const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SERVER = fs.readFileSync('src/server.js', 'utf8');
const BIBLIO = fs.readFileSync('src/services/bibliotecaService.js', 'utf8');
const DOTS = fs.readFileSync('src/services/dotsService.js', 'utf8');

test('etapa que ainda está rodando não é começada de novo', () => {
  // O tick é de 60s e a varredura das fontes passa de 8 min quando as sessões
  // do Facebook e do Instagram caem. Sem trava, os ticks se empilhavam: o log
  // mostrava a MESMA página raspada duas vezes em 4 min e a MESMA linha de
  // engajamento três vezes no mesmo segundo.
  assert.match(SERVER, /const rodando = new Set\(\);/);
  assert.match(SERVER, /if \(rodando\.has\(nome\)\) \{/);
  assert.match(SERVER, /ainda rodando desde o tick anterior — pulei esta volta/);
  assert.match(SERVER, /rodando\.add\(nome\);/);
  assert.match(SERVER, /rodando\.delete\(nome\);/, 'sem o finally a etapa travaria para sempre');
});

test('publicar e escrever não esperam a varredura', () => {
  // Rápidas e lentas em paralelo: a fila das agendadas e a volta do Dots não
  // podem ficar atrás de scraping que leva minutos.
  const rapidas = SERVER.slice(SERVER.indexOf('const rapidas = ['), SERVER.indexOf('const lentas = ['));
  const lentas = SERVER.slice(SERVER.indexOf('const lentas = ['), SERVER.indexOf('const emSequencia'));

  for (const nome of ['fila-agendadas', 'dots', 'agenda-auto']) {
    assert.ok(rapidas.includes(`'${nome}'`), `${nome} tem de estar nas rápidas`);
  }
  for (const nome of ['biblioteca-fontes', 'monitores', 'biblioteca-autopilot']) {
    assert.ok(lentas.includes(`'${nome}'`), `${nome} tem de estar nas lentas`);
    assert.ok(!rapidas.includes(`'${nome}'`), `${nome} não pode atrasar as rápidas`);
  }

  // As duas listas disparam juntas, sem await entre elas.
  assert.match(
    SERVER,
    /const tick = \(\) => \{\s*\n\s*void emSequencia\(rapidas\);\s*\n\s*void emSequencia\(lentas\);/,
    'esperar uma lista pela outra traz o problema de volta'
  );
  assert.match(SERVER, /for \(const \[nome, executar\] of etapas\) await correr\(nome, executar\)/);
});

test('cada etapa continua com o seu próprio catch', () => {
  // Etapa que estoura não pode levar embora as seguintes.
  assert.match(SERVER, /\} catch \(err\) \{\s*\n\s*console\.error\(`\[tick \$\{nome\}\]`, err\.message\);/);
});

test('a fonte é reservada antes de ser lida', () => {
  // `findDue()` só olha `proxima_execucao`, e o horário era gravado no FIM da
  // leitura: o tick seguinte pegava a mesma fonte e raspava de novo.
  const trecho = BIBLIO.slice(BIBLIO.indexOf('async function tickFontes'));
  const reserva = trecho.indexOf('const reservada = await db');
  const leitura = trecho.indexOf('await escanearFonte(fonte');
  assert.ok(reserva > 0, 'a reserva precisa existir');
  assert.ok(reserva < leitura, 'reservar DEPOIS de ler não resolve nada');

  // UPDATE condicional: quem não afetar linha desiste da fonte.
  assert.match(trecho.slice(0, 1800), /\.update\(\{ proxima_execucao: nextRun\(fonte\.intervalo_minutos\) \}\)/);
  assert.match(trecho.slice(0, 1800), /if \(!reservada\) continue;/);
  assert.match(
    trecho.slice(0, 1800),
    /whereNull\('proxima_execucao'\)\.orWhere\('proxima_execucao', '<=', db\.fn\.now\(\)\)/,
    'a condição tem de repetir a do findDue, senão a corrida continua'
  );
  // Falha ao reservar não pode virar varredura: `.catch(() => 0)` cai no continue.
  assert.match(trecho.slice(0, 1800), /\.catch\(\(\) => 0\);/);
});

test('o Dots já reservava a volta — a trava do tick não atropela isso', () => {
  // `tick()` do dot empurra `proxima_execucao_at` antes de trabalhar e tem o
  // seu próprio `rodando`. As duas travas somadas não podem se anular.
  const trecho = DOTS.slice(DOTS.indexOf('async function tick()'));
  assert.match(trecho.slice(0, 1400), /if \(rodando\) return;/);
  assert.match(trecho.slice(0, 1400), /\.update\(\{ proxima_execucao_at: new Date\(Date\.now\(\)/);
  assert.match(trecho.slice(0, 1400), /rodando = false;/);
});
