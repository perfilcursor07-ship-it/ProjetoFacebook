const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const newsResearch = require('../src/services/newsResearch');
const articleSource = require('../src/services/articleSource');
const { urlParaEscrever, palavraQueCasou } = require('../src/services/dotsService');

const FONTE = fs.readFileSync('src/services/dotsService.js', 'utf8');

test('link do Google Notícias vira o link da reportagem antes de ir para a IA', async () => {
  const original = newsResearch.decodificarLinksGoogle;
  const google = 'https://news.google.com/rss/articles/CBMiABC?oc=5';
  newsResearch.decodificarLinksGoogle = async () => new Map([[google, 'https://www.bbc.com/portuguese/articles/c123']]);
  try {
    assert.equal(await urlParaEscrever({ id: 1, url: google }), 'https://www.bbc.com/portuguese/articles/c123');
  } finally {
    newsResearch.decodificarLinksGoogle = original;
  }
});

test('link do Google sem reportagem original desiste do post (SEM_MATERIA)', async () => {
  const originais = { decode: newsResearch.decodificarLinksGoogle, resolver: articleSource.resolverUrlNoticia };
  newsResearch.decodificarLinksGoogle = async () => new Map();
  articleSource.resolverUrlNoticia = async () => null;
  try {
    await assert.rejects(urlParaEscrever({ id: 1, url: 'https://news.google.com/rss/articles/X' }), (err) => {
      assert.equal(err.code, 'SEM_MATERIA');
      return true;
    });
  } finally {
    newsResearch.decodificarLinksGoogle = originais.decode;
    articleSource.resolverUrlNoticia = originais.resolver;
  }
});

test('link comum segue como está', async () => {
  assert.equal(await urlParaEscrever({ id: 1, url: 'https://g1.globo.com/x' }), 'https://g1.globo.com/x');
});

test('post que falhou sai da fila e a escolha pula os que falharam há pouco', () => {
  // Antes o post seguia "novo" e cada volta tentava escrever o MESMO post.
  assert.match(FONTE, /tirarPostDaFila\(dot, post, err\)/);
  assert.match(FONTE, /update\(\{ status: 'ignorado' \}\)/);
  assert.match(FONTE, /whereNotIn\('p\.url', falharam\)/);
});

test('mostra qual palavra-chave o post citou', () => {
  const post = { titulo: 'Assembleia de Deus rejeita Flávio Bolsonaro', resumo: '' };
  assert.equal(palavraQueCasou(post, ['Lula', 'Flávio Bolsonaro']), 'Flávio Bolsonaro');
  assert.equal(palavraQueCasou(post, ['Moraes']), null);
});

test('post sem imagem ganha a capa de dentro da reportagem (igual ao piloto)', async () => {
  const { capaDoPost } = require('../src/services/dotsService');
  const original = articleSource.extrairMetadadosImagemArtigo;
  articleSource.extrairMetadadosImagemArtigo = async (url) => {
    assert.equal(url, 'https://www.bbc.com/portuguese/articles/c1');
    return { imagem: 'https://ichef.bbci.co.uk/news/1024/branded_portuguese/foto.jpg' };
  };
  try {
    const capa = await capaDoPost({ id: 1, url: 'https://www.bbc.com/portuguese/articles/c1', thumbnail: null });
    assert.equal(capa, 'https://ichef.bbci.co.uk/news/1024/branded_portuguese/foto.jpg');
  } finally {
    articleSource.extrairMetadadosImagemArtigo = original;
  }
});

test('logo do Google nunca vira capa do post', async () => {
  const { capaDoPost } = require('../src/services/dotsService');
  const original = articleSource.extrairMetadadosImagemArtigo;
  articleSource.extrairMetadadosImagemArtigo = async () => ({ imagem: 'https://lh3.googleusercontent.com/logo=w256' });
  try {
    assert.equal(await capaDoPost({ id: 1, url: 'https://site.com/a', thumbnail: null }), null);
  } finally {
    articleSource.extrairMetadadosImagemArtigo = original;
  }
});

test('link de site não é descartado por "pouco texto" (a IA lê a reportagem)', () => {
  const { postTemMaterial } = require('../src/services/dotsService');
  // Item do feed do g1 só com título: a IA lê a matéria inteira ao escrever.
  assert.equal(postTemMaterial({ url: 'https://g1.globo.com/politica/noticia/x.ghtml', titulo: 'Relembre a trajetória de Lula', resumo: '' }), true);
  // Post de rede social com legenda curta continua precisando de texto.
  assert.equal(postTemMaterial({ url: 'https://www.facebook.com/pagina/posts/123', titulo: 'Lula', resumo: '' }), false);
});

test('painel tem "Escrever agora" por post e situações reais', () => {
  assert.match(FONTE, /async function escreverPostAgora\(/);
  assert.match(FONTE, /situacao = 'repetido'/);
  assert.match(FONTE, /situacao = 'falhou'/);
});
