const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Registro isolado: nunca o arquivo real do Chrome do servidor.
const ARQUIVO = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'abas-')), 'abas.json');
process.env.CHROME_ABAS_REGISTRO = ARQUIVO;
const MORTO = 999_999_9; // pid que não existe
fs.writeFileSync(ARQUIVO, JSON.stringify({ orfa: { aberta: Date.now(), pid: MORTO } }));

const abas = require('../src/services/abaEmSegundoPlano');
const faxina = require('../src/services/chromeFaxina');

function chromeFalso(alvos) {
  const fechadas = [];
  return {
    fechadas,
    http: {
      async get(url) {
        if (url.endsWith('/json/list')) return { data: alvos.filter((a) => !fechadas.includes(a.id)) };
        fechadas.push(decodeURIComponent(url.split('/json/close/')[1]));
        return { data: 'Target is closing' };
      },
    },
  };
}

test('aba do sistema esquecida no reinício fecha mesmo em chatgpt.com; a do gateway fica', async () => {
  const chrome = chromeFalso([
    { id: 'gateway', type: 'page', url: 'https://chatgpt.com/' },
    { id: 'orfa', type: 'page', url: 'https://chatgpt.com/c/abc' },
  ]);
  assert.equal(await faxina.faxinar({ http: chrome.http }), 1);
  assert.deepEqual(chrome.fechadas, ['orfa']);
  assert.equal(abas.abasRegistradas().some((a) => a.id === 'orfa'), false);
});

test('aba do sistema em uso fica; passou de 12 min, fecha', async () => {
  const fechadaPeloCdp = [];
  const pagina = {
    close: async () => {},
    context: () => ({ browser: () => ({ newBrowserCDPSession: async () => ({ send: async (_m, p) => fechadaPeloCdp.push(p.targetId), detach: async () => {} }) }) }),
  };
  const contexto = {
    pages: () => [pagina],
    newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: 'gerando' } }), detach: async () => {} }),
    newPage: async () => pagina,
  };
  // Força o caminho do newPage (sem Target.createTarget) e registra a aba.
  await abas.novaAbaEmSegundoPlano({ newBrowserCDPSession: async () => { throw new Error('sem cdp'); } }, contexto);
  assert.equal(abas.abasRegistradas().some((a) => a.id === 'gerando'), true);

  const chrome = chromeFalso([
    { id: 'gateway', type: 'page', url: 'https://chatgpt.com/' },
    { id: 'gerando', type: 'page', url: 'https://grok.com/c/1' },
  ]);
  assert.equal(await faxina.faxinar({ http: chrome.http }), 0);
  assert.equal(await faxina.faxinar({ http: chrome.http, agora: Date.now() + 13 * 60_000 }), 1);
  assert.deepEqual(chrome.fechadas, ['gerando']);
  assert.equal(fechadaPeloCdp.length, 0);
});

test('fecharAba: page.close travado cai para o fechamento direto pelo Chrome', async () => {
  const fechadaPeloCdp = [];
  const pagina = {
    close: () => new Promise(() => {}), // nunca termina
    context: () => ({ browser: () => ({ newBrowserCDPSession: async () => ({ send: async (_m, p) => fechadaPeloCdp.push(p.targetId), detach: async () => {} }) }) }),
  };
  const contexto = {
    pages: () => [pagina],
    newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: 'travada' } }), detach: async () => {} }),
    newPage: async () => pagina,
  };
  const aba = await abas.novaAbaEmSegundoPlano({ newBrowserCDPSession: async () => { throw new Error('x'); } }, contexto);
  await abas.fecharAba(aba);
  assert.deepEqual(fechadaPeloCdp, ['travada']);
  assert.equal(abas.abasRegistradas().some((a) => a.id === 'travada'), false);
});
