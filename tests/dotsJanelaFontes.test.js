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

const { resumoDoPlano } = require('../src/services/dotsService');

const PLANO_BASE = {
  acao: 'monitorar_e_escrever',
  destino: 'agendar',
  agendar_minutos: 15,
  modo_imagem: 'ia_com_texto',
};

test('resumo mostra o ritmo por hora e por dia em números concretos', () => {
  const linhas = resumoDoPlano(
    { ...PLANO_BASE, intervalo_minutos: 15, materias_por_volta: 1, limite_dia: 96 },
    VINTE_E_SEIS
  ).join(' | ');

  assert.match(linhas, /Acompanha 26 páginas/);
  assert.match(linhas, /a cada 15 min/);
  assert.match(linhas, /cerca de 4 por hora/);
  assert.match(linhas, /teto de 96 por dia/);
  // Ritmo e teto combinam: não há nada a alertar.
  assert.doesNotMatch(linhas, /Atenção/);
});

test('avisa quando o teto do dia para o ritmo antes do fim do dia', () => {
  const linhas = resumoDoPlano(
    { ...PLANO_BASE, intervalo_minutos: 15, materias_por_volta: 1, limite_dia: 10 },
    VINTE_E_SEIS
  ).join(' | ');

  // Sem isto o editor lia "teto de 10 por dia" achando que o ritmo valia 24h.
  assert.match(linhas, /Atenção/);
  assert.match(linhas, /daria 96 por dia/);
  assert.match(linhas, /teto de 10 para antes/);
  assert.match(linhas, /2,5h/);
});

test('teto generoso o bastante para o ritmo não gera alerta falso', () => {
  const linhas = resumoDoPlano(
    { ...PLANO_BASE, intervalo_minutos: 60, materias_por_volta: 1, limite_dia: 24 },
    VINTE_E_SEIS
  ).join(' | ');
  assert.doesNotMatch(linhas, /Atenção/, '1 por hora em 24h cabe exatamente no teto de 24');
});
