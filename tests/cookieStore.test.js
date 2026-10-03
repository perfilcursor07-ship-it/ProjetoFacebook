const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/services/cookieStore');
const { env } = require('../src/config/env');

const LINHA = (dominio, nome, valor, expira = 1999999999) =>
  `${dominio}\tTRUE\t/\tTRUE\t${expira}\t${nome}\t${valor}`;

/**
 * Aponta o destino para uma pasta temporária. Sem isso os testes gravariam em
 * `secrets/` e apagariam os cookies de verdade de quem roda a suíte.
 */
function comDestinoTemporario(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookies-teste-'));
  const original = {
    youtube: env.ytDlp.cookiesFile,
    instagram: env.ytDlp.igCookiesFile,
    facebook: env.ytDlp.fbCookiesFile,
  };
  env.ytDlp.cookiesFile = path.join(dir, 'youtube.txt');
  env.ytDlp.igCookiesFile = path.join(dir, 'instagram.txt');
  env.ytDlp.fbCookiesFile = path.join(dir, 'facebook.txt');
  try {
    return fn(dir);
  } finally {
    env.ytDlp.cookiesFile = original.youtube;
    env.ytDlp.igCookiesFile = original.instagram;
    env.ytDlp.fbCookiesFile = original.facebook;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('guarda só os cookies do domínio da plataforma', () => {
  const bruto = [
    '# Netscape HTTP Cookie File',
    LINHA('.youtube.com', 'PREF', 'hl=pt-BR'),
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1999999999\t__Secure-3PSID\tsegredo',
    LINHA('.google.com', 'SAPISID', 'de-outro-site'),
    LINHA('.instagram.com', 'sessionid', 'de-outro-site'),
    '# comentário comum',
  ].join('\n');

  const yt = store.filtrarCookies('youtube', bruto);
  assert.equal(yt.total, 2, 'só as duas linhas do youtube.com');
  assert.equal(yt.autenticacao, 1, '__Secure-3PSID conta como login');
  assert.match(yt.conteudo, /#HttpOnly_\.youtube\.com.*__Secure-3PSID/);
  assert.doesNotMatch(yt.conteudo, /google\.com/);
  assert.doesNotMatch(yt.conteudo, /instagram\.com/);

  // O mesmo export colado no cartão do Instagram guarda apenas o que é dele.
  const ig = store.filtrarCookies('instagram', bruto);
  assert.equal(ig.total, 1);
  assert.equal(ig.autenticacao, 1);
  assert.doesNotMatch(ig.conteudo, /youtube\.com/);
});

test('reconhece os cookies de login de cada plataforma', () => {
  const ig = store.filtrarCookies(
    'instagram',
    [LINHA('.instagram.com', 'sessionid', 'x'), LINHA('.instagram.com', 'ds_user_id', '1')].join('\n')
  );
  assert.equal(ig.autenticacao, 2);

  const fb = store.filtrarCookies(
    'facebook',
    [LINHA('.facebook.com', 'c_user', '1'), LINHA('.facebook.com', 'xs', 'y'), LINHA('.facebook.com', 'locale', 'pt_BR')].join('\n')
  );
  assert.equal(fb.total, 3);
  assert.equal(fb.autenticacao, 2, 'locale não é cookie de login');
});

test('aceita linha com espaços quando o editor estraga as tabulações', () => {
  const comEspacos = '.facebook.com TRUE / TRUE 1999999999 c_user 12345';
  const fb = store.filtrarCookies('facebook', comEspacos);
  assert.equal(fb.total, 1);
  assert.equal(fb.autenticacao, 1);
});

test('calcula a expiração pelo cookie de login que vence primeiro', () => {
  const cedo = Math.floor(Date.now() / 1000) + 3600;
  const tarde = Math.floor(Date.now() / 1000) + 99999;
  const ig = store.filtrarCookies(
    'instagram',
    [
      LINHA('.instagram.com', 'sessionid', 'x', tarde),
      LINHA('.instagram.com', 'ds_user_id', '1', cedo),
    ].join('\n')
  );
  assert.equal(new Date(ig.expiraEm).getTime(), cedo * 1000);
});

test('recusa conteúdo vazio, sem o domínio ou sem sessão logada', () => {
  comDestinoTemporario(() => {
    assert.throws(() => store.salvarCookies('youtube', '   '), /Envie o arquivo/);
    assert.throws(
      () => store.salvarCookies('youtube', LINHA('.google.com', 'SAPISID', 'x')),
      /Nenhum cookie de youtube\.com/
    );
    // Tem cookie do domínio, mas nenhum é de login: salvar criaria um problema
    // silencioso que só apareceria na hora de publicar.
    assert.throws(
      () => store.salvarCookies('youtube', LINHA('.youtube.com', 'PREF', 'hl=pt-BR')),
      /sessão logada/
    );
  });
});

test('salva, lê o status de volta e apaga', () => {
  comDestinoTemporario(() => {
    const bruto = [
      LINHA('.youtube.com', '__Secure-3PSID', 'segredo'),
      LINHA('.youtube.com', 'PREF', 'hl=pt-BR'),
    ].join('\n');

    const resumo = store.salvarCookies('youtube', bruto);
    assert.equal(resumo.total, 2);
    assert.equal(resumo.autenticacao, 1);

    const situacao = store.situacao('youtube');
    assert.equal(situacao.existe, true);
    assert.equal(situacao.total, 2);
    assert.equal(situacao.temSessao, true);
    assert.equal(situacao.expirou, false);
    assert.equal(situacao.porEnv, true, 'destino veio da variável de ambiente');

    // O conteúdo gravado não pode carregar cookie de outro site.
    const gravado = fs.readFileSync(situacao.caminho, 'utf8');
    assert.doesNotMatch(gravado, /google\.com/);

    assert.equal(store.removerCookies('youtube'), true);
    assert.equal(store.situacao('youtube').existe, false);
  });
});

test('marca como expirado quando o cookie de login já venceu', () => {
  comDestinoTemporario(() => {
    const vencido = Math.floor(Date.now() / 1000) - 60;
    store.salvarCookies('facebook', [
      LINHA('.facebook.com', 'c_user', '1', vencido),
      LINHA('.facebook.com', 'xs', 'y', vencido),
    ].join('\n'));

    const situacao = store.situacao('facebook');
    assert.equal(situacao.existe, true);
    assert.equal(situacao.expirou, true, 'a tela precisa avisar antes de a publicação falhar');
  });
});

test('plataforma desconhecida é recusada', () => {
  assert.equal(store.ehPlataformaValida('youtube'), true);
  assert.equal(store.ehPlataformaValida('tiktok'), false);
  assert.throws(() => store.filtrarCookies('tiktok', 'x'), /Plataforma inválida/);
});

test('o caminho da tela só é oferecido quando o arquivo existe de verdade', () => {
  // Sem gravar nada em secrets/, não há caminho a oferecer para os resolvedores.
  const semArquivo = store.caminhoSalvoPelaTela('youtube');
  const existe = semArquivo ? fs.existsSync(semArquivo) : false;
  assert.equal(
    semArquivo === '' || existe,
    true,
    'ou devolve vazio, ou devolve um arquivo que existe'
  );
  assert.equal(store.caminhoSalvoPelaTela('tiktok'), '');
});
