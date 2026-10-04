const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escolherImagemDoPost,
  pareceFotoDePerfil,
} = require('../src/services/facebookPageScrape');

const PERFIL = 'https://scontent.xx.fbcdn.net/v/t39.30808-1/perfil_da_pagina.jpg';
const FOTO_POST = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/foto_real_do_post.jpg';

test('a foto do post vence a foto de perfil, mesmo estando mais longe', () => {
  // Era este o bug: os três padrões caíam no mesmo balde e só a proximidade
  // decidia. A foto de perfil fica no começo do HTML e ganhava.
  const html =
    `{"uri":"${PERFIL}"}` +
    ' '.repeat(200) +
    'ANCORA_DO_POST' +
    ' '.repeat(3000) +
    `{"photo_image":{"uri":"${FOTO_POST}"}}`;

  const ancora = html.indexOf('ANCORA_DO_POST');
  assert.equal(escolherImagemDoPost(html, [ancora]), FOTO_POST);
});

test('full_width_image também conta como foto do post', () => {
  const html =
    `{"uri":"${PERFIL}"}ANCORA{"full_width_image":{"uri":"${FOTO_POST}"}}`;
  assert.equal(escolherImagemDoPost(html, [html.indexOf('ANCORA')]), FOTO_POST);
});

test('sem foto específica, o genérico só vale se estiver colado no post', () => {
  const outra = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/alguma.jpg';

  const perto = `ANCORA${' '.repeat(500)}{"uri":"${outra}"}`;
  assert.equal(
    escolherImagemDoPost(perto, [perto.indexOf('ANCORA')]),
    outra,
    'colado no post, serve'
  );

  // A janela antiga era de 50 KB: uma imagem a 20 KB de distância entrava.
  const longe = `ANCORA${' '.repeat(20_000)}{"uri":"${outra}"}`;
  assert.equal(
    escolherImagemDoPost(longe, [longe.indexOf('ANCORA')]),
    null,
    'longe demais para ser do post'
  );
});

test('foto de perfil nunca é escolhida, nem sem alternativa', () => {
  const html = `ANCORA{"uri":"${PERFIL}"}`;
  assert.equal(
    escolherImagemDoPost(html, [html.indexOf('ANCORA')]),
    null,
    'melhor sem imagem do que com o avatar da página'
  );
});

test('reconhece avatar por caminho e por tamanho', () => {
  assert.equal(pareceFotoDePerfil(PERFIL), true, 't39.30808-1 é perfil');
  assert.equal(pareceFotoDePerfil('https://scontent.xx.fbcdn.net/v/s40x40/a.jpg'), true);
  assert.equal(pareceFotoDePerfil('https://scontent.xx.fbcdn.net/v/p50x50/a.jpg'), true);

  assert.equal(pareceFotoDePerfil(FOTO_POST), false, 't39.30808-6 é foto comum');
  assert.equal(
    pareceFotoDePerfil('https://scontent.xx.fbcdn.net/v/t39.30808-6/p960x960/a.jpg'),
    false,
    'foto grande não é avatar'
  );
});

test('ícone do próprio Facebook continua fora', () => {
  const html = 'ANCORA{"uri":"https://static.xx.fbcdn.net/rsrc.php/icone.png"}';
  assert.equal(escolherImagemDoPost(html, [html.indexOf('ANCORA')]), null);
});

test('html vazio não quebra', () => {
  assert.equal(escolherImagemDoPost('', [0]), null);
  assert.equal(escolherImagemDoPost(null, []), null);
});

test('sem âncora, uma única foto de post é aceita', () => {
  // `candidatoMaisPerto` já tratava isso: sem âncora para comparar, um
  // candidato só é inequívoco. Com dois, prefere não arriscar.
  assert.equal(
    escolherImagemDoPost(`{"photo_image":{"uri":"${FOTO_POST}"}}`, []),
    FOTO_POST
  );
  const duas = `{"photo_image":{"uri":"${FOTO_POST}"}}{"photo_image":{"uri":"https://scontent.xx.fbcdn.net/v/t39.30808-6/outra.jpg"}}`;
  assert.equal(escolherImagemDoPost(duas, []), null, 'ambíguo: melhor nenhuma');
});
