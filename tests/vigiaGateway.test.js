const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

// O gateway e o Chrome do servidor não são do PM2: depois do reinício do
// servidor ficaram desligados e todo pedido ao ChatGPT falhava com "Não
// consegui salvar esta resposta". O vigia religa os dois sozinho.

const admin = require('../src/services/tokenFreeAdminService');
const gateway = require('../src/services/tokenFreeGatewayService');

function cenario({ gatewayOk, chromeOk }) {
  const chamadas = { reiniciar: 0 };
  gateway.verificarSaude = async () => {
    if (!gatewayOk()) throw Object.assign(new Error('fora'), { code: 'ECONNREFUSED' });
    return { status: 'ok' };
  };
  axios.get = async (url) => {
    if (String(url).includes('9222') && chromeOk()) return { status: 200 };
    throw new Error('ECONNREFUSED');
  };
  admin._vigia.falhasSeguidas = 0;
  admin._vigia.ultimaTentativa = 0;
  admin._vigia.religando = null;
  // Nunca o "Reiniciar" de verdade num teste.
  admin._vigia.religar = async () => {
    chamadas.reiniciar += 1;
    return { ok: true, message: 'religado (teste)' };
  };
  return chamadas;
}

test('tudo no ar: não mexe em nada', async () => {
  cenario({ gatewayOk: () => true, chromeOk: () => true });
  const r = await admin.vigiarGateway();
  assert.deepEqual(r, { ok: true });
  assert.equal(admin._vigia.falhasSeguidas, 0);
});

test('uma falha só é oscilação: espera a segunda conferência', async () => {
  cenario({ gatewayOk: () => false, chromeOk: () => true });
  const r = await admin.vigiarGateway({ agora: 10_000_000 });
  assert.equal(r.motivo, 'confirmando');
  assert.equal(admin._vigia.ultimaTentativa, 0, 'ainda não tentou religar');
});

test('fora duas vezes: tenta religar, e não insiste antes de 5 min', async () => {
  const agora = 20_000_000;
  const chamadas = cenario({ gatewayOk: () => false, chromeOk: () => false });
  admin._vigia.falhasSeguidas = 1;
  const r = await admin.vigiarGateway({ agora });
  assert.deepEqual(r, { ok: true, religado: true });
  assert.equal(chamadas.reiniciar, 1);
  // Se continuar fora, não fica religando em loop.
  admin._vigia.falhasSeguidas = 5;
  const deNovo = await admin.vigiarGateway({ agora: agora + 60_000 });
  assert.equal(deNovo.motivo, 'aguardando');
  assert.equal(chamadas.reiniciar, 1);
});

test('pedido real falhou: religa sem esperar a segunda conferência', async () => {
  const chamadas = cenario({ gatewayOk: () => false, chromeOk: () => true });
  const r = await admin.vigiarGateway({ imediato: true, agora: 30_000_000 });
  assert.deepEqual(r, { ok: true, religado: true });
  assert.equal(chamadas.reiniciar, 1);
});

test('durante uma autorização no /claude o vigia não mexe', async () => {
  const fs = require('node:fs');
  const fonte = fs.readFileSync('src/services/tokenFreeAdminService.js', 'utf8');
  // A autorização derruba o Chrome de propósito; religar no meio estragaria o login.
  assert.match(fonte, /if \(autorizacaoEmAndamento\(\)\) \{\s*vigia\.falhasSeguidas = 0;/);
});
