const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { extractMatterSourceLinks } = require('../src/services/matterSourceLinks');

const urls = (matter) => extractMatterSourceLinks(matter).map((f) => f.url);
const rotulos = (matter) => extractMatterSourceLinks(matter).map((f) => f.label);

test('os três campos de sempre continuam valendo', () => {
  assert.deepEqual(urls({ fonte_url: 'https://portal.com/a' }), ['https://portal.com/a']);
  assert.deepEqual(
    urls({ fonte_credito: 'Fonte:\n• O Fuxico Gospel — https://fuxicogospel.com.br/x\n(Foto: Reprodução)' }),
    ['https://fuxicogospel.com.br/x']
  );
  assert.deepEqual(
    urls({ contexto_apuracao: 'G1 — https://g1.globo.com/z' }),
    ['https://g1.globo.com/z']
  );
});

test('o corpo da matéria é o último lugar onde o link é procurado', () => {
  // A caixa "Link da fonte" ficava só com o texto ("Chat de matérias +
  // pesquisa na web") quando fonte_url e fonte_credito vinham sem endereço.
  assert.deepEqual(
    urls({ materia: 'Texto.\n\nPor Redação — Site: https://fuxicogospel.com.br/politica/y\n(Foto: Reprodução)' }),
    ['https://fuxicogospel.com.br/politica/y'],
    'rodapé do JM'
  );
  assert.deepEqual(
    urls({ materia: 'Corpo.\n\nFontes:\n• G1 — https://g1.globo.com/z' }),
    ['https://g1.globo.com/z'],
    'lista de fontes'
  );
  assert.deepEqual(
    urls({ materia: 'Corpo.\n\nFonte: https://uol.com.br/w' }),
    ['https://uol.com.br/w']
  );
});

test('endereço citado no meio da notícia não vira fonte', () => {
  // É conteúdo da matéria, não a procedência dela.
  assert.deepEqual(urls({ materia: 'O pastor citou https://exemplo.com durante o culto.' }), []);
  assert.deepEqual(
    urls({ materia: 'Inscrições em https://igreja.org/evento até sexta.' }),
    []
  );
});

test('o corpo só é lido quando não há link em lugar melhor', () => {
  // Evita duplicar a mesma fonte e evita que o corpo mande no lugar do campo.
  assert.deepEqual(
    urls({ fonte_url: 'https://a.com/1', materia: 'Fonte: https://b.com/2' }),
    ['https://a.com/1']
  );
});

test('o rótulo sai limpo — os marcadores eram mantidos por engano', () => {
  // Os caracteres • – — tinham virado "?" numa gravação em codificação
  // errada, então o regex não removia nada: saía "• O Fuxico Gospel —".
  assert.deepEqual(
    rotulos({ fonte_credito: '• O Fuxico Gospel — https://fuxicogospel.com.br/x' }),
    ['O Fuxico Gospel']
  );
  assert.deepEqual(
    rotulos({ contexto_apuracao: 'Fonte: G1 — https://g1.globo.com/z' }),
    ['G1']
  );
  // Sem nome antes do endereço, o host serve de rótulo.
  assert.deepEqual(rotulos({ fonte_url: 'https://www.portal.com.br/a' }), ['portal.com.br']);
});

test('o regex de limpeza não tem mais "?" no lugar dos marcadores', () => {
  const fonte = fs.readFileSync('src/services/matterSourceLinks.js', 'utf8');
  assert.doesNotMatch(fonte, /\[\?\*\\-\?\?\]/, 'resto da codificação quebrada');
  assert.doesNotMatch(fonte, /\[\\-\?\?:\]/);
  // Os caracteres de verdade, agora que o arquivo está em UTF-8 íntegro.
  assert.ok(fonte.includes('[•*–—-]'), 'bullet e travessões no regex do início');
  assert.ok(fonte.includes('[:–—-]'), 'e na limpeza do fim do rótulo');
});

test('matéria sem endereço nenhum devolve lista vazia, sem quebrar', () => {
  assert.deepEqual(urls({ fonte_titulo: 'Chat de matérias + pesquisa na web' }), []);
  assert.deepEqual(urls({}), []);
  assert.deepEqual(urls(), []);
});

test('o mesmo endereço não aparece duas vezes', () => {
  assert.deepEqual(
    urls({
      fonte_url: 'https://portal.com/a',
      fonte_credito: '• Portal — https://portal.com/a/',
      contexto_apuracao: 'Portal — https://portal.com/a',
    }),
    // Vence a primeira achada (fonte_credito vem antes de fonte_url); a
    // barra final não cria uma segunda entrada.
    ['https://portal.com/a/']
  );
});

test('a tela mostra todos os links achados', () => {
  const ejs = fs.readFileSync('public/views/materia-ia-editar.ejs', 'utf8');
  assert.match(ejs, /fontesLinks\.forEach\(\(fonte, index\) => \{/);
  assert.match(ejs, /href="<%= fonte\.url %>"/);
  const ctrl = fs.readFileSync('src/controllers/materiasIaController.js', 'utf8');
  assert.match(ctrl, /matter\.fontes_links = extractMatterSourceLinks\(matter\);/);
});
