const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const BibliotecaFontes = require('../src/models/BibliotecaFontes');
const { encontrarFontePorUrl } = require('../src/services/bibliotecaService');

/**
 * Como o banco guarda: `normalizeUrl` tira a barra final e o hash. Era essa
 * diferença que fazia o dot nascer sem página.
 */
const FONTES = [
  { id: 31, plataforma: 'facebook', url: 'https://www.facebook.com/ofuxicogospel', handle: 'ofuxicogospel' },
  { id: 32, plataforma: 'facebook', url: 'https://www.facebook.com/LuizBacci', handle: 'LuizBacci' },
  { id: 33, plataforma: 'instagram', url: 'https://www.instagram.com/ofuxicogospel', handle: 'ofuxicogospel' },
];

/** Troca o método no mesmo objeto de modelo que o serviço usa. */
function comFontes(lista, fn) {
  const original = BibliotecaFontes.findByUser;
  BibliotecaFontes.findByUser = async () => lista;
  return Promise.resolve(fn()).finally(() => {
    BibliotecaFontes.findByUser = original;
  });
}

test('acha a fonte quando o editor cola a URL com barra no fim', async () => {
  await comFontes(FONTES, async () => {
    // Exatamente o link do pedido que falhou.
    const achada = await encontrarFontePorUrl(1, 'https://www.facebook.com/ofuxicogospel/');
    assert.ok(achada, 'a barra final não pode esconder a fonte já cadastrada');
    assert.equal(achada.id, 31);
  });
});

test('acha também sem www, em http e com query a mais', async () => {
  await comFontes(FONTES, async () => {
    for (const variante of [
      'https://facebook.com/ofuxicogospel',
      'http://www.facebook.com/ofuxicogospel/',
      'https://www.facebook.com/ofuxicogospel/?ref=bookmarks',
      'https://www.facebook.com/ofuxicogospel#sobre',
    ]) {
      const achada = await encontrarFontePorUrl(1, variante);
      assert.ok(achada, `não achou com ${variante}`);
      assert.equal(achada.id, 31, `casou a fonte errada para ${variante}`);
    }
  });
});

test('o mesmo handle em outra plataforma não é confundido', async () => {
  await comFontes(FONTES, async () => {
    const insta = await encontrarFontePorUrl(1, 'https://www.instagram.com/ofuxicogospel/');
    assert.equal(insta.id, 33, 'Instagram e Facebook têm o mesmo handle aqui');
  });
});

test('página que não está na biblioteca devolve null, para poder criar', async () => {
  await comFontes(FONTES, async () => {
    assert.equal(await encontrarFontePorUrl(1, 'https://www.facebook.com/plenonews'), null);
  });
});

test('URL inválida não estoura erro', async () => {
  await comFontes(FONTES, async () => {
    for (const ruim of ['', 'facebook.com/sem-protocolo', 'nao-e-url', null]) {
      assert.equal(await encontrarFontePorUrl(1, ruim), null, `quebrou com ${String(ruim)}`);
    }
  });
});

test('o dot usa o buscador em vez da comparação crua com LIKE', () => {
  const fonte = fs.readFileSync('src/services/dotsService.js', 'utf8');
  assert.match(fonte, /encontrarFontePorUrl/, 'a busca tem de passar pela normalização');
  assert.doesNotMatch(
    fonte,
    /andWhere\('url', 'like'/,
    'o LIKE com a URL crua era a causa do dot sem página'
  );
});

test('o motivo da falha chega no log e na tela', () => {
  const servico = fs.readFileSync('src/services/dotsService.js', 'utf8');
  // Antes só a contagem ia para o log: "1 com problema", sem dizer por quê.
  assert.match(servico, /problemas\.join\(' \| '\)/, 'o log precisa dizer qual link e por quê');
  assert.match(servico, /Nenhuma página monitorada/, 'dot sem fonte tem de se declarar quebrado');

  const tela = fs.readFileSync('public/js/dots.js', 'utf8');
  assert.match(tela, /Não entraram:/, 'a mensagem de criação precisa mostrar a causa');
});

test('"já está na biblioteca" é resolvido, não tratado como falha', () => {
  const fonte = fs.readFileSync('src/services/dotsService.js', 'utf8');
  assert.match(fonte, /err\.status === 409/, 'duplicata é a fonte que queremos, não um erro');
});
