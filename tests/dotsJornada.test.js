const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  dentroDaJanela,
  normalizarJornada,
  horaEDiaLocais,
  lerDias,
  resumoDoPlano,
} = require('../src/services/dotsService');

/** 2026-10-05 é segunda. Araguaína é UTC−3, então 17:00Z = 14h local. */
const SEG_14H = new Date('2026-10-05T17:00:00Z');
const SEG_23H = new Date('2026-10-06T02:00:00Z');
const SAB_10H = new Date('2026-10-10T13:00:00Z');
const DOM_03H = new Date('2026-10-11T06:00:00Z');

test('a hora é lida no fuso do editor, não no do servidor', () => {
  // Com getHours() do servidor, "das 8h às 18h" viraria outra faixa sempre que
  // o servidor não estivesse no mesmo fuso.
  assert.deepEqual(horaEDiaLocais(SEG_14H), { hora: 14, dia: 1 });
  assert.deepEqual(horaEDiaLocais(SEG_23H), { hora: 23, dia: 1 });
  assert.deepEqual(horaEDiaLocais(SAB_10H), { hora: 10, dia: 6 });
  assert.deepEqual(horaEDiaLocais(DOM_03H), { hora: 3, dia: 7 });
});

test('jornada de dias úteis das 8h às 18h', () => {
  const dot = { dias_semana: '1,2,3,4,5', hora_inicio: 8, hora_fim: 18 };

  assert.equal(dentroDaJanela(dot, SEG_14H).ok, true, 'segunda 14h está dentro');

  const noite = dentroDaJanela(dot, SEG_23H);
  assert.equal(noite.ok, false);
  assert.match(noite.motivo, /horário/, 'o motivo tem de dizer que é hora');

  const sabado = dentroDaJanela(dot, SAB_10H);
  assert.equal(sabado.ok, false);
  assert.match(sabado.motivo, /dias de trabalho/, 'o motivo tem de dizer que é dia');
});

test('faixa que atravessa a meia-noite vale (22h às 6h)', () => {
  const dot = { hora_inicio: 22, hora_fim: 6 };
  assert.equal(dentroDaJanela(dot, SEG_23H).ok, true, '23h está dentro de 22h–6h');
  assert.equal(dentroDaJanela(dot, DOM_03H).ok, true, '3h também');
  assert.equal(dentroDaJanela(dot, SEG_14H).ok, false, '14h está fora');
});

test('dot sem jornada configurada trabalha sempre', () => {
  // É o caso de quem já tinha dot antes desta tela existir.
  for (const quando of [SEG_14H, SEG_23H, SAB_10H, DOM_03H]) {
    assert.equal(dentroDaJanela({}, quando).ok, true);
    assert.equal(dentroDaJanela({ dias_semana: null, hora_inicio: null, hora_fim: null }, quando).ok, true);
  }
});

test('faixa com as duas pontas iguais não restringe nada', () => {
  // 8h às 8h seria uma janela de zero hora: o dot nunca trabalharia.
  assert.equal(dentroDaJanela({ hora_inicio: 8, hora_fim: 8 }, SEG_23H).ok, true);
});

test('lerDias aceita texto e lista, e descarta lixo', () => {
  assert.deepEqual(lerDias('1,2,3'), [1, 2, 3]);
  assert.deepEqual(lerDias([5, 1, 1]), [1, 5], 'ordena e remove repetido');
  assert.deepEqual(lerDias('0,8,abc,3'), [3], 'só 1 a 7 é dia da semana');
  assert.deepEqual(lerDias(''), []);
  assert.deepEqual(lerDias(null), []);
});

test('os sete dias marcados valem como "todos os dias"', () => {
  // Guardar "1,2,3,4,5,6,7" obrigaria a comparar lista toda volta sem ganho.
  assert.equal(normalizarJornada({ dias_semana: [1, 2, 3, 4, 5, 6, 7] }).dias_semana, null);
  assert.equal(normalizarJornada({ dias_semana: [1, 5] }).dias_semana, '1,5');
});

test('rascunho não tem ritmo de saída', () => {
  const cfg = normalizarJornada({
    destino: 'rascunho',
    saida_quantidade: 7,
    saida_minutos: 300,
  });
  assert.equal(cfg.saida_quantidade, 1, 'nada sai sozinho, então não há lote');
  assert.equal(cfg.saida_minutos, 15);
});

test('valores fora da faixa são contidos em vez de quebrar', () => {
  const cfg = normalizarJornada({
    destino: 'publicar',
    saida_quantidade: 999,
    saida_minutos: 1,
    limite_dia: 9999,
    scan_minutos: 7,
    hora_inicio: 99,
    hora_fim: -5,
  });
  assert.equal(cfg.saida_quantidade, 10, 'teto de 10 por lote');
  assert.equal(cfg.saida_minutos, 5, 'piso de 5 min');
  assert.equal(cfg.limite_dia, 200);
  assert.equal(cfg.scan_minutos, 60, 'intervalo inválido cai no padrão');
  assert.equal(cfg.hora_inicio, null, 'hora inválida não restringe');
  assert.equal(cfg.hora_fim, null);
});

test('a caixa da imagem é o que decide limpar o texto', () => {
  assert.equal(normalizarJornada({}).modo_imagem, 'original', 'desmarcada usa a foto do post');
  assert.equal(
    normalizarJornada({ gerar_imagem_com_texto: true }).modo_imagem,
    'ia_com_texto'
  );
});

test('destino inválido cai em rascunho, o mais seguro', () => {
  assert.equal(normalizarJornada({ destino: 'qualquer' }).destino, 'rascunho');
  assert.equal(normalizarJornada({ destino: 'publicar' }).destino, 'publicar');
});

test('o resumo descreve a escolha da tela, não um palpite', () => {
  const cfg = normalizarJornada({
    dias_semana: [1, 2, 3, 4, 5],
    hora_inicio: 8,
    hora_fim: 18,
    scan_minutos: 60,
    destino: 'agendar',
    saida_quantidade: 2,
    saida_minutos: 15,
    limite_dia: 40,
    gerar_imagem_com_texto: true,
  });
  const texto = resumoDoPlano(
    { acao: 'monitorar_e_escrever', criterio: 'Fato novo.' },
    ['a', 'b'],
    cfg
  ).join(' | ');

  assert.match(texto, /relê cada uma a cada 1 hora/);
  assert.match(texto, /seg, ter, qua, qui, sex, das 08h às 18h/);
  assert.match(texto, /2 matérias a cada 15 min/);
  assert.match(texto, /agenda até 40 por dia/);
  assert.match(texto, /limpar o texto mantendo a foto/);
  // O teto corta o ritmo: isso tem de aparecer antes de criar.
  assert.match(texto, /daria 192 por dia/);
});

test('o rascunho é descrito sem ritmo de saída', () => {
  const cfg = normalizarJornada({ destino: 'rascunho', limite_dia: 10 });
  const texto = resumoDoPlano({ acao: 'monitorar_e_escrever' }, ['a'], cfg).join(' | ');
  assert.match(texto, /salva como rascunho/);
  assert.match(texto, /Nada sai sozinho/);
  assert.doesNotMatch(texto, /a cada 15 min/, 'rascunho não tem lote de saída');
});

test('a IA deixou de deduzir ritmo, destino e quantidade', () => {
  const fonte = fs.readFileSync('src/services/dotsService.js', 'utf8');
  const prompt = fonte.slice(fonte.indexOf('const SISTEMA_PLANO'), fonte.indexOf('ROTULO_IMAGEM'));
  // Era a dedução disso que errava a cada pedido.
  for (const campo of ['intervalo_minutos', 'materias_por_volta', 'limite_dia', 'agendar_minutos']) {
    assert.doesNotMatch(prompt, new RegExp(campo), `${campo} não pode mais vir da IA`);
  }
  assert.match(prompt, /só estes quatro/, 'o prompt tem de deixar isso explícito');
});

test('o ChatGPT recebe ordem de limpar o texto, não de criar outra cena', () => {
  const { promptSemTexto } = require('../src/services/materiaPorChat');
  const p = promptSemTexto('Pastor fala sobre eleições');
  assert.match(p, /REMOVENDO todo o texto/);
  assert.match(p, /Mantenha TUDO o resto idêntico/);
  assert.doesNotMatch(p, /NOVA imagem/i, 'recriar a cena trocava pessoas e cenário');

  const dots = fs.readFileSync('src/services/dotsService.js', 'utf8');
  assert.match(dots, /modo: modo === 'ia_com_texto' \? 'limpar_texto'/);
});
