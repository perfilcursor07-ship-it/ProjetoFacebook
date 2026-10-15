const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const BancoImagens = require('../src/models/BancoImagens');
const { primeiroLinkDeFonte } = require('../src/services/materiaChatService');

const SERVICO = fs.readFileSync('src/services/bancoImagensService.js', 'utf8');
const TELA = fs.readFileSync('public/js/banco-imagens.js', 'utf8');
const ROTA = fs.readFileSync('src/routes/bancoImagens.js', 'utf8');
const CHAT = fs.readFileSync('src/services/materiaChatService.js', 'utf8');
const MIG = fs.readFileSync('src/migrations/20261013090000_banco_imagens_indice_data.js', 'utf8');

// ── Item 2: o endereço da fonte precisa ser GRAVADO, não só lido ───────────

test('o link sai de linha de crédito, nunca do meio da notícia', () => {
  assert.equal(primeiroLinkDeFonte('Fonte: https://g1.globo.com/a'), 'https://g1.globo.com/a');
  assert.equal(
    primeiroLinkDeFonte('Texto.\n\nPor Redação — Site: https://fuxicogospel.com.br/x'),
    'https://fuxicogospel.com.br/x'
  );
  assert.equal(primeiroLinkDeFonte('Fontes:\n• UOL — https://uol.com.br/y'), 'https://uol.com.br/y');
  // Endereço citado no texto é conteúdo da notícia, não a procedência dela.
  assert.equal(primeiroLinkDeFonte('O pastor citou https://exemplo.com no culto.'), null);
});

test('buscador e rede social não valem como fonte da reportagem', () => {
  assert.equal(primeiroLinkDeFonte('Fonte: https://www.google.com/search?q=x'), null);
  assert.equal(primeiroLinkDeFonte('Fonte: https://facebook.com/post/1'), null);
  assert.equal(primeiroLinkDeFonte('Fonte: https://x.com/alguem/status/1'), null);
  // Mas a reportagem de verdade logo abaixo entra.
  assert.equal(
    primeiroLinkDeFonte('Fonte: https://google.com/s\nFonte: https://portal.com/real'),
    'https://portal.com/real'
  );
});

test('entrada ruim não quebra nem inventa link', () => {
  assert.equal(primeiroLinkDeFonte('sem nada'), null);
  assert.equal(primeiroLinkDeFonte(''), null);
  assert.equal(primeiroLinkDeFonte(null), null);
  assert.equal(primeiroLinkDeFonte('Fonte: não-é-url'), null);
});

test('o rascunho do chat grava esse link quando não há fonte registrada', () => {
  // "Chat de matérias + pesquisa na web" nascia com fonte_url nulo e a caixa
  // "Link da fonte" ficava só com o texto.
  assert.match(CHAT, /const urlDaResposta = \/\^https\?:/);
  assert.match(CHAT, /fonte_url: fontePrincipal\?\.url \|\| urlDaResposta \|\| null,/);
  assert.match(CHAT, /sem fonte registrada; link tirado do texto/, 'precisa deixar rastro no log');
});

// ── Item 3: banco de imagens ───────────────────────────────────────────────

test('a listagem não arrasta o prompt (TEXT) de cada linha', () => {
  assert.ok(Array.isArray(BancoImagens.COLUNAS));
  assert.ok(!BancoImagens.COLUNAS.includes('prompt'), 'a grade não mostra prompt');
  assert.ok(!BancoImagens.COLUNAS.includes('hash'));
  for (const precisa of ['id', 'arquivo', 'miniatura', 'origem', 'titulo', 'usos']) {
    assert.ok(BancoImagens.COLUNAS.includes(precisa), `falta ${precisa}`);
  }
});

test('há três ordens e a inválida cai na padrão', () => {
  assert.deepEqual(Object.keys(BancoImagens.ORDENS).sort(), ['antigas', 'recentes', 'usadas']);
  // "Mais usadas" já era prometida pelo código (o uso era contado) e a grade
  // sempre ordenou por data.
  assert.deepEqual(BancoImagens.ORDENS.usadas[0], ['usos', 'desc']);
  assert.deepEqual(BancoImagens.ORDENS.recentes[0], ['created_at', 'desc']);

  const knex = require('knex')({ client: 'mysql2' });
  const sql = knex('banco_imagens')
    .where({ user_id: 7 })
    .select(BancoImagens.COLUNAS)
    .orderBy(...BancoImagens.ORDENS.usadas[0])
    .toString();
  assert.match(sql, /order by `usos` desc/);
  assert.doesNotMatch(sql, /`prompt`/);
});

test('a ordem inválida não vira SQL', () => {
  const sujeira = ['recentes', 'usadas', 'antigas'];
  assert.match(SERVICO, /const ORDENS = Object\.keys\(BancoImagens\.ORDENS\);/);
  assert.match(SERVICO, /ORDENS\.includes\(filtros\.ordem\) \? filtros\.ordem : 'recentes'/);
  for (const o of sujeira) assert.ok(Object.keys(BancoImagens.ORDENS).includes(o));
});

test('existe índice para o filtro + a ordem da grade', () => {
  // Só havia (user_id, origem), que não cobre o ORDER BY created_at: o MySQL
  // ordenava em memória a cada abertura da tela.
  assert.match(MIG, /\['user_id', 'created_at', 'id'\], 'banco_imagens_user_data_idx'/);
  assert.match(MIG, /SHOW INDEX FROM banco_imagens/, 'rodar duas vezes não pode quebrar');
});

test('a contagem por origem só é calculada na 1ª página', () => {
  assert.match(SERVICO, /const primeiraPagina = Math\.max\(1, Number\(filtros\.pagina\) \|\| 1\) === 1;/);
  assert.match(SERVICO, /primeiraPagina \? BancoImagens\.contarPorOrigem/);
  // E a tela tem de aguentar a ausência, senão o contador zera ao rolar.
  assert.match(TELA, /data\.contagem \? atualizarContagem\(data\.contagem\) : null/);
  assert.match(
    TELA,
    /if \(total === 0 && !importouSistema/,
    'com null, a importação automática não pode disparar ao rolar'
  );
});

test('a tela manda a ordem escolhida', () => {
  assert.match(ROTA, /ordem: req\.query\.ordem,/);
  assert.match(TELA, /qs\.set\('ordem', ordem\)/);
  assert.match(TELA, /\['usadas', 'Mais usadas'\]/);
});

// ── Diagnóstico de publicação: não pode acusar o inocente ─────────────────

test('página do PostSyncer não é cobrada por Profile Key do Ayrshare', () => {
  // A primeira versão marcou FALTA numa página com 3.397 matérias no ar.
  // Ela publica por PostSyncer e não usa Ayrshare para nada.
  const script = require('node:fs').readFileSync('scripts/diagnostico-publicacao.js', 'utf8');
  assert.match(script, /function provedorDaPagina\(p\)/);
  assert.match(script, /token\.startsWith\('postsyncer:'\) \|\| String\(p\.page_id \|\| ''\)\.startsWith\('ps:'\)/);
  assert.match(script, /if \(via !== 'ayrshare'\)/, 'só cobra chave de quem publica por Ayrshare');
});

test('a página padrão não é cobrada por chave própria', () => {
  // Ela usa o Primary Profile — é o que a própria mensagem de erro diz.
  const script = require('node:fs').readFileSync('scripts/diagnostico-publicacao.js', 'utf8');
  assert.match(script, /const padroes = new Set\(\);/);
  assert.match(script, /default_facebook_page_id/);
  assert.match(script, /é a página padrão — usa o Primary Profile/);
});

test('páginas repetidas são apontadas, com qual delas está em uso', () => {
  const script = require('node:fs').readFileSync('scripts/diagnostico-publicacao.js', 'utf8');
  assert.match(script, /PÁGINAS REPETIDAS/);
  assert.match(script, /usos\.sort\(\(a, b\) => b\.publicadas - a\.publicadas\)/);
  assert.match(script, /a que o sistema vem usando/);
});

test('o diagnóstico não publica nem altera nada', () => {
  const script = require('node:fs').readFileSync('scripts/diagnostico-publicacao.js', 'utf8');
  for (const perigoso of ['.update(', '.insert(', '.del(', '.delete(']) {
    assert.ok(!script.includes(perigoso), `diagnóstico não pode ${perigoso}`);
  }
  assert.match(script, /Nada foi publicado nem alterado por este script/);
});
