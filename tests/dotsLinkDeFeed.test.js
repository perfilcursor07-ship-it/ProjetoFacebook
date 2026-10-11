const test = require('node:test');
const assert = require('node:assert/strict');

const { extrairUrls } = require('../src/services/dotsService');
const { pareceFeed, descobrirFeedsRss } = require('../src/services/bibliotecaService');
const BIBLIO = require('node:fs').readFileSync('src/services/bibliotecaService.js', 'utf8');

/** O pedido real que não agendava nada: busca do Google Notícias com parênteses. */
const PEDIDO = `Pesquise nos links a seguir e faça materias sobre essas pautas:
https://news.google.com/rss/search?q=%22usos+e+costumes%22+(igreja+OR+%22Assembleia+de+Deus%22+OR+pentecostal)+when:7d&hl=pt-BR&gl=BR&ceid=BR:pt-419
https://news.google.com/rss/search?q=(profecia+OR+profetizou+OR+profeta)+(pastor+OR+igreja+OR+evang%C3%A9lico)+when:3d&hl=pt-BR&gl=BR&ceid=BR:pt-419`;

test('link com parênteses não é cortado no meio', () => {
  // Era o bloqueio nº 1: a varredura parava no primeiro ')'. O dot nascia
  // monitorando "…OR+pentecostal" — endereço quebrado, zero item, zero
  // matéria, zero agendada.
  const urls = extrairUrls(PEDIDO);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].endsWith('&ceid=BR:pt-419'), `cortou: ${urls[0]}`);
  assert.ok(urls[0].includes('pentecostal)+when:7d'), 'o parêntese de fechar faz parte da busca');
  assert.ok(urls[1].includes('(profecia+OR+profetizou+OR+profeta)'));
});

test('parêntese que fecha a frase continua saindo do link', () => {
  assert.deepEqual(extrairUrls('Veja (https://portal.com/noticia) e mais nada.'), [
    'https://portal.com/noticia',
  ]);
  assert.deepEqual(extrairUrls('Olha isso: https://portal.com/x.'), ['https://portal.com/x']);
  assert.deepEqual(extrairUrls('Fim https://portal.com/y!'), ['https://portal.com/y']);
  // Parêntese balanceado DENTRO da URL fica; o desbalanceado do fim sai.
  assert.deepEqual(extrairUrls('(veja https://p.com/a_(b)_c)'), ['https://p.com/a_(b)_c']);
});

test('texto sem link nenhum devolve lista vazia', () => {
  assert.deepEqual(extrairUrls('Faça matéria sobre política gospel'), []);
  assert.deepEqual(extrairUrls(''), []);
  assert.deepEqual(extrairUrls(null), []);
});

test('endereço que já é feed é reconhecido como feed', () => {
  // Era o bloqueio nº 2: `descobrirFeedsRss` tratava tudo como home de site e
  // só adivinhava /feed, /rss… — o próprio endereço nunca era lido.
  assert.equal(pareceFeed('https://news.google.com/rss/search?q=(a+OR+b)+when:3d'), true);
  assert.equal(pareceFeed('https://portal.com/feed'), true);
  assert.equal(pareceFeed('https://portal.com/noticias/feed/'), true);
  assert.equal(pareceFeed('https://portal.com/rss.xml'), true);
  assert.equal(pareceFeed('https://portal.com/?format=rss'), true);

  // Nada de confundir palavra que só começa igual.
  assert.equal(pareceFeed('https://portal.com/'), false);
  assert.equal(pareceFeed('https://portal.com/feedback'), false);
  assert.equal(pareceFeed('https://portal.com/atom-industrial'), false);
  assert.equal(pareceFeed('https://www.fuxicogospel.com.br/politica/x/'), false);
  assert.equal(pareceFeed('nao-e-url'), false);
  assert.equal(pareceFeed(''), false);
});

test('o feed é lido direto, sem adivinhar /feed e /rss', async () => {
  const alvo = 'https://news.google.com/rss/search?q=teste&hl=pt-BR';
  assert.deepEqual(await descobrirFeedsRss(alvo), [alvo]);
});

test('fonte que é feed não cai nos resgates de busca por site', () => {
  // "site:news.google.com" não devolve a busca pedida e encheria a fonte de
  // resultado alheio.
  assert.match(BIBLIO, /if \(pareceFeed\(fonte\.url\)\) \{/);
  assert.match(BIBLIO, /O feed não devolveu notícias\./);
  const site = BIBLIO.slice(BIBLIO.indexOf('async function coletarViaSite'));
  const corte = site.indexOf('coletarSiteGoogleNews');
  const guarda = site.indexOf('if (pareceFeed(fonte.url))');
  assert.ok(guarda > 0 && guarda < corte, 'a guarda tem de vir antes dos resgates');
});

test('feed do Google passa pelo limitador', () => {
  // Cinco fontes do dot batendo direto no Google era rajada: HTTP 503.
  assert.match(BIBLIO, /async function baixarFeed\(feed\)/);
  assert.match(BIBLIO, /news\\\.google\\\.com\$\/i\.test\(hostDeUrl\(feed\)\)/);
  assert.match(BIBLIO, /googleNews\.executar\(/);
  assert.match(BIBLIO, /if \(googleNews\.emPausa\?\.\(\)\) throw googleNews\.erroDePausa\(\)/);
  // Feed que não é do Google continua indo direto, sem gastar o limitador.
  assert.match(BIBLIO, /if \(!\/\(\?:\^\|\\\.\)news/);
});

test('salvar o dot sem mudar o texto reconfere os links guardados', () => {
  // O atalho "texto igual → não faz nada" deixava o dot preso com os links
  // cortados: só mudar o pedido arrumava. Agora o conjunto de links do texto
  // é comparado com o guardado e, diferindo, as fontes são recadastradas —
  // sem chamar a IA de novo.
  const DOTS = require('node:fs').readFileSync('src/services/dotsService.js', 'utf8');
  const trecho = DOTS.slice(DOTS.indexOf('async function atualizar('));
  assert.match(trecho, /const doTexto = extrairUrls\(texto\)\.filter/);
  assert.match(trecho, /\.filter\(\(f\) => f && f\.via === 'link' && f\.url\)/);
  assert.match(trecho, /if \(!iguais\) \{/);
  assert.match(trecho, /await cadastrarFontes\(dot, plano\)/);
  // O que o editor acrescentou pelo painel não pode ser varrido junto.
  assert.match(trecho, /anterior\.manuais\?\.fontes \|\| \[\]/);
  // E o que ele removeu continua fora.
  assert.match(trecho, /removidas\.has\(`url\|\$\{chaveUrl\(f\.url\)\}`\)/);
});
