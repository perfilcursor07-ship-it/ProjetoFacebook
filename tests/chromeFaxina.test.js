// Registro de abas isolado: os testes nunca tocam o arquivo real do servidor.
process.env.CHROME_ABAS_REGISTRO = require('path').join(require('os').tmpdir(), `abas-faxina-${process.pid}.json`);

const test = require('node:test');
const assert = require('node:assert/strict');

const faxina = require('../src/services/chromeFaxina');

function chromeFalso(alvos) {
  const fechadas = [];
  return {
    fechadas,
    http: {
      async get(url) {
        if (url.endsWith('/json/list')) return { data: alvos.filter((a) => !fechadas.includes(a.id)) };
        const id = decodeURIComponent(url.split('/json/close/')[1]);
        fechadas.push(id);
        return { data: 'Target is closing' };
      },
    },
  };
}

test('só considera temporárias as buscas do Google, about:blank e páginas de notícia', () => {
  const pagina = (url) => ({ type: 'page', url });
  assert.equal(faxina.abaTemporaria(pagina('https://www.google.com/search?q=%22Fux%22&udm=2')), true);
  assert.equal(faxina.abaTemporaria(pagina('about:blank')), true);
  assert.equal(faxina.abaTemporaria(pagina('https://podemos.org.br/noticia/abc')), true);
  assert.equal(faxina.abaTemporaria(pagina('https://chatgpt.com/c/123')), false);
  assert.equal(faxina.abaTemporaria(pagina('https://chat.deepseek.com/a/chat/s/1')), false);
  assert.equal(faxina.abaTemporaria(pagina('https://claude.ai/new')), false);
  assert.equal(faxina.abaTemporaria(pagina('https://www.instagram.com/reels/')), false);
  assert.equal(faxina.abaTemporaria(pagina('chrome://omnibox-popup.top-chrome/')), false);
  assert.equal(faxina.abaTemporaria({ type: 'iframe', url: 'https://accounts.google.com/RotateCookiesPage' }), false);
  assert.equal(faxina.abaTemporaria({ type: 'browser_ui', url: 'https://www.google.com/search?q=x' }), false);
});

test('fecha só a aba temporária que continua aberta depois do prazo', async () => {
  const chrome = chromeFalso([
    { id: 'gpt', type: 'page', url: 'https://chatgpt.com/' },
    { id: 'g1', type: 'page', url: 'https://www.google.com/search?q=a&udm=2' },
    { id: 'g2', type: 'page', url: 'https://www.google.com/search?q=b&udm=2' },
    { id: 'if', type: 'iframe', url: 'https://accounts.google.com/RotateCookiesPage' },
  ]);
  const t0 = Date.now();
  // Primeira vez vistas: só anota (podem estar em uso agora).
  assert.equal(await faxina.faxinar({ agora: t0, http: chrome.http }), 0);
  // Antes do prazo: continua sem fechar.
  assert.equal(await faxina.faxinar({ agora: t0 + faxina.IDADE_MAXIMA_MS - 1, http: chrome.http }), 0);
  // Depois do prazo: fecha as duas buscas esquecidas, nunca o ChatGPT.
  assert.equal(await faxina.faxinar({ agora: t0 + faxina.IDADE_MAXIMA_MS, http: chrome.http }), 2);
  assert.deepEqual(chrome.fechadas.sort(), ['g1', 'g2']);
});

test('nunca fecha a última aba do Chrome', async () => {
  const chrome = chromeFalso([{ id: 'so', type: 'page', url: 'about:blank' }]);
  const t0 = Date.now();
  await faxina.faxinar({ agora: t0, http: chrome.http });
  assert.equal(await faxina.faxinar({ agora: t0 + faxina.IDADE_MAXIMA_MS * 2, http: chrome.http }), 0);
  assert.deepEqual(chrome.fechadas, []);
});

test('Chrome desligado não quebra a faxina', async () => {
  const http = { async get() { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } };
  assert.equal(await faxina.faxinar({ http }), 0);
});
