const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { esperaAposFalha } = require('../src/services/bibliotecaService');

const BIBLIO = fs.readFileSync('src/services/bibliotecaService.js', 'utf8');
const FB = fs.readFileSync('src/services/facebookPageScrape.js', 'utf8');
const MIG = fs.readFileSync('src/migrations/20261016090000_fontes_falhas_seguidas.js', 'utf8');

test('a espera dobra a cada falha, até o teto de 12 h', () => {
  // Fonte quebrada relida de 15 em 15 min era o que deixava o site lento.
  assert.equal(esperaAposFalha(1, 15), 30);
  assert.equal(esperaAposFalha(2, 15), 60);
  assert.equal(esperaAposFalha(3, 15), 120);
  assert.equal(esperaAposFalha(4, 15), 240);
  assert.equal(esperaAposFalha(5, 15), 480);
  assert.equal(esperaAposFalha(6, 15), 720);
  // O teto não é ultrapassado nem com centenas de falhas.
  assert.equal(esperaAposFalha(50, 15), 720);
  assert.equal(esperaAposFalha(999, 1440), 720);
});

test('a espera respeita o intervalo configurado na fonte', () => {
  assert.equal(esperaAposFalha(1, 60), 120);
  assert.equal(esperaAposFalha(2, 60), 240);
});

test('entrada inválida não vira espera zero nem NaN', () => {
  // Zero faria a fonte quebrada ser relida em laço fechado.
  for (const [falhas, intervalo] of [[0, null], [-5, 0], [NaN, NaN], [null, undefined]]) {
    const min = esperaAposFalha(falhas, intervalo);
    assert.ok(Number.isFinite(min) && min >= 30, `espera inválida: ${min}`);
  }
});

test('o teto é ajustável e nunca fica abaixo de 1 h', () => {
  assert.match(BIBLIO, /Math\.max\(60, Number\(process\.env\.FONTE_RECUO_MAX_MIN\) \|\| 12 \* 60\)/);
});

test('a varredura conta falha seguida e zera no sucesso', () => {
  const trecho = BIBLIO.slice(BIBLIO.indexOf('async function tickFontes'));
  // Sucesso: volta ao ritmo normal.
  assert.match(trecho.slice(0, 2600), /if \(Number\(fonte\.falhas_seguidas\) > 0\) \{/);
  assert.match(trecho.slice(0, 2600), /falhas_seguidas: 0/);
  // Falha: incrementa e reagenda pelo recuo.
  assert.match(trecho.slice(0, 2600), /const falhas = \(Number\(fonte\.falhas_seguidas\) \|\| 0\) \+ 1;/);
  assert.match(trecho.slice(0, 2600), /const minutos = esperaAposFalha\(falhas, fonte\.intervalo_minutos\);/);
  assert.match(trecho.slice(0, 2600), /proxima_execucao: new Date\(Date\.now\(\) \+ minutos \* 60_000\)/);
  // E o log diz quando volta, para não parecer que a fonte foi abandonada.
  assert.match(trecho.slice(0, 2600), /falha \$\{falhas\}; próxima em \$\{minutos\} min/);
});

test('banco sem a coluna ainda grava o resto', () => {
  // Deploy em que a migração não rodou não pode parar a varredura.
  const trecho = BIBLIO.slice(BIBLIO.indexOf('async function tickFontes'));
  assert.match(trecho.slice(0, 3000), /\}\)\.catch\(async \(\) => \{/);
  assert.match(trecho.slice(0, 3000), /Banco sem a coluna ainda/);
});

test('a migração é idempotente', () => {
  assert.match(MIG, /if \(await knex\.schema\.hasColumn\('biblioteca_fontes', 'falhas_seguidas'\)\) return;/);
  assert.match(MIG, /\.defaultTo\(0\)/);
});

// ── Facebook: sessão caída encerra as variantes ───────────────────────────

test('a 1ª variante com 401 cancela as outras 7', () => {
  // Cada variante baixa ~10 MB. Insistir nas 8 com a sessão caída era ~80 MB
  // de muro de login por página, e ~20 páginas assim por volta.
  // A trava é declarada ANTES do laço das variantes, senão cada tarefa teria
  // a sua e nenhuma veria a falha da outra.
  const declaracao = FB.indexOf('let sessaoCaiu = null;');
  const laco = FB.indexOf('const paginas = await mapearComLimite(variantes');
  assert.ok(declaracao > 0, 'a trava precisa existir');
  assert.ok(declaracao < laco, 'declarada fora do laço, para ser compartilhada');

  assert.match(FB, /if \(sessaoCaiu\) return \{ variante, encontrados: \[\], htmlLen: 0, pulada: true \};/);
  assert.match(FB, /if \(Number\(err\?\.status\) === 401\) sessaoCaiu = err;/);
});

test('sessão caída vira erro de sessão, não "nenhum post"', () => {
  // Precisa chegar como erro para o recuo da Biblioteca espaçar as tentativas;
  // "0 post" seria tratado como página vazia e relido no ritmo normal.
  assert.match(
    FB,
    /if \(sessaoCaiu && !paginas\.some\(\(p\) => p\.encontrados\.length\)\) throw sessaoCaiu;/
  );
});

test('variante que falha por outro motivo não cancela as demais', () => {
  // 404 numa aba (ex.: /reels que não existe) é normal e não é sessão caída.
  const corpo = FB.slice(FB.indexOf('const paginas = await mapearComLimite(variantes'), FB.indexOf('// Junta na ordem'));
  assert.match(corpo, /if \(Number\(err\?\.status\) === 401\) sessaoCaiu = err;/);
  assert.doesNotMatch(corpo, /sessaoCaiu = err;\s*\n\s*\}\s*\n\s*return/, 'só o 401 encerra');
});

test('se alguma variante trouxe post, o 401 das outras é ignorado', () => {
  // Página que respondeu em parte continua valendo.
  assert.match(FB, /!paginas\.some\(\(p\) => p\.encontrados\.length\)/);
});

// ── yt-dlp não é chamado onde ele nunca funciona ──────────────────────────

test('yt-dlp é pulado em URL de página do Facebook', () => {
  const { ytDlpAbreNoFacebook } = require('../src/services/bibliotecaService');
  // "ERROR: Unsupported URL" é resposta DEFINITIVA do yt-dlp para página ou
  // perfil. Perguntar assim mesmo custava um processo Python por fonte, a
  // cada volta — era o yt-dlp em 55% de CPU no ps do servidor.
  for (const u of [
    'https://www.facebook.com/Poder360',
    'https://www.facebook.com/plenonews',
    'https://www.facebook.com/profile.php?id=61552089960643',
    'https://www.facebook.com/share/1EddausVEq',
  ]) {
    assert.equal(ytDlpAbreNoFacebook(u), false, u);
  }
});

test('mídia individual continua passando pelo yt-dlp', () => {
  const { ytDlpAbreNoFacebook } = require('../src/services/bibliotecaService');
  for (const u of [
    'https://www.facebook.com/watch/?v=123',
    'https://www.facebook.com/pagina/videos/123',
    'https://www.facebook.com/reel/123',
    'https://www.facebook.com/permalink.php?story_fbid=1&id=2',
    'https://www.facebook.com/pagina/posts/123',
    'https://fb.watch/abc123/',
  ]) {
    assert.equal(ytDlpAbreNoFacebook(u), true, u);
  }
});

test('entrada inválida não vira chamada', () => {
  const { ytDlpAbreNoFacebook } = require('../src/services/bibliotecaService');
  assert.equal(ytDlpAbreNoFacebook(''), false);
  assert.equal(ytDlpAbreNoFacebook(null), false);
  assert.equal(ytDlpAbreNoFacebook(undefined), false);
});

test('a guarda está no caminho da coleta do Facebook', () => {
  assert.match(BIBLIO, /if \(collected\.length < 3 && ytDlpAbreNoFacebook\(url\)\) \{/);
});

test('o Instagram continua usando yt-dlp normalmente', () => {
  // Lá o yt-dlp LISTA o perfil; a guarda é só do Facebook.
  assert.match(BIBLIO, /coletarViaYtDlp\(url, 'instagram'\)/);
  const ig = BIBLIO.indexOf("coletarViaYtDlp(url, 'instagram')");
  const trecho = BIBLIO.slice(Math.max(0, ig - 300), ig);
  assert.doesNotMatch(trecho, /ytDlpAbreNoFacebook/);
});
