const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const DOTS = fs.readFileSync('src/services/dotsService.js', 'utf8');

/** Mesmo cálculo do serviço, para medir o que mudou. */
const FUSO = 'America/Araguaina';
const diaLocal = (d) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
const diaUtc = (d) => d.toISOString().slice(0, 10);

test('o dia do teto vira à meia-noite de Araguaína, não de Londres', () => {
  // Era o buraco: das 21h à meia-noite o contador já estava no dia seguinte,
  // então um dot de 20 por dia escrevia até 40 no mesmo dia de calendário.
  const vinteEUmaHoraLocal = new Date('2026-10-13T01:00:00Z'); // 22h em Araguaína
  assert.equal(diaLocal(vinteEUmaHoraLocal), '2026-10-12');
  assert.equal(diaUtc(vinteEUmaHoraLocal), '2026-10-13', 'é esta diferença que causava o problema');

  const umaDaManhaLocal = new Date('2026-10-13T04:00:00Z');
  assert.equal(diaLocal(umaDaManhaLocal), '2026-10-13', 'depois da meia-noite local, vira');
});

test('o serviço usa o fuso do editor para contar o dia', () => {
  const trecho = DOTS.slice(DOTS.indexOf('function hoje()'), DOTS.indexOf('function erro('));
  assert.match(trecho, /timeZone: FUSO/);
  assert.match(trecho, /'en-CA'/, 'en-CA entrega AAAA-MM-DD, o formato já gravado em dia_contagem');
  assert.doesNotMatch(trecho, /toISOString/, 'era o que virava o dia às 21h');
});

test('o formato gravado não muda — dia_contagem antigo continua comparável', () => {
  assert.match(diaLocal(new Date('2026-01-05T15:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(diaLocal(new Date('2026-01-05T15:00:00Z')), '2026-01-05');
});

test('o teto segue barrando a volta e o pedido manual', () => {
  // A contagem zera sozinha na virada; o saldo nunca fica negativo.
  assert.match(DOTS, /const feitasHoje = dot\.dia_contagem === dia \? Number\(dot\.feitas_hoje\) \|\| 0 : 0;/);
  assert.match(DOTS, /const saldo = Math\.max\(0, Number\(dot\.limite_dia\) - feitasHoje\);/);
  // Na volta automática.
  assert.match(DOTS, /candidatos\.slice\(0, Math\.min\(porVolta, saldo\)\)/);
  assert.match(DOTS, /Limite de \$\{dot\.limite_dia\} por dia atingido\./);
  // E no "Escrever agora" do painel.
  assert.match(DOTS, /if \(feitasHoje >= Number\(dot\.limite_dia\)\) \{/);
  assert.match(DOTS, /Limite de \$\{dot\.limite_dia\} matérias por dia atingido\./);
});

test('o limite é contido entre 1 e 200', () => {
  // 0 pararia o dot para sempre sem dizer por quê.
  assert.match(DOTS, /limite_dia: inteiro\(entrada\.limite_dia \?\? entrada\.limiteDia, 1, 200, 20\)/);
});

test('o resumo avisa quando o ritmo pedido não cabe no teto', () => {
  const { normalizarJornada, resumoDoPlano } = require('../src/services/dotsService');
  const cfg = normalizarJornada({
    destino: 'publicar',
    saida_quantidade: 2,
    saida_minutos: 15,
    limite_dia: 40,
  });
  const texto = resumoDoPlano({ acao: 'monitorar_e_escrever' }, ['a'], cfg).join(' | ');
  assert.match(texto, /até 40 por dia/);
  // 2 a cada 15 min daria 192/dia: o teto corta muito antes, e isso aparece
  // antes de o editor salvar.
  assert.match(texto, /daria 192 por dia, mas o teto de 40 para antes/);
});
