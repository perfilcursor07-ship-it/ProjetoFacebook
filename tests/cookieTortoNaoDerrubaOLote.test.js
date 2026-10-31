const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const MANAGER = fs.readFileSync('gateway-overrides/token-free-gateway/src/browser/manager.ts', 'utf8');

// Por que este arquivo existe — o log do gateway:
//
//   [BrowserManager] addCookies failed: Protocol error (Storage.setCookies):
//   Invalid cookie fields
//
// `addCookies` é tudo ou nada: UM campo inválido no auth-profiles.json e
// nenhum cookie entra, de nenhum provedor. O gateway seguia sem a sessão e o
// erro aparecia só como uma linha de aviso.

test('os cookies são saneados antes de ir para o Chrome', () => {
  assert.match(MANAGER, /private static limparCookie\(/);
  assert.ok(MANAGER.includes('.map((c) => BrowserManager.limparCookie(c))'));
  assert.ok(MANAGER.includes('.filter((c): c is BrowserCookie => c !== null)'));
});

test('um cookie ruim não leva os outros junto', () => {
  // Na segunda tentativa cada um vai sozinho e só o culpado fica de fora.
  assert.ok(MANAGER.includes('await ctx.addCookies([cookie]).catch(() => recusados.push(cookie.name))'));
  assert.match(MANAGER, /cookies recusados pelo Chrome/);
});

test('o log mostra nome de cookie, nunca valor', () => {
  assert.ok(MANAGER.includes('recusados.join(", ")'));
  assert.doesNotMatch(MANAGER, /console\.(log|warn|error)\([^)]*cookie\.value/);
});

test('a regra de não sobrescrever sessão viva continua', () => {
  // O Chrome logado no VNC é a fonte de verdade; cookie salvo só entra se
  // faltar. Isso já derrubou o login do Claude uma vez.
  assert.ok(MANAGER.includes('const existentes = new Set(atuais.filter((c) => c.value).map(chave));'));
  assert.ok(MANAGER.includes('!existentes.has(chave(c))'));
});

test('a limpeza exige o mínimo e normaliza o resto', () => {
  const i = MANAGER.indexOf('private static limparCookie(');
  const trecho = MANAGER.slice(i, i + 1600);
  // Sem nome, sem domínio ou sem valor não há como aplicar.
  assert.match(trecho, /if \(!name \|\| !domain\) return null;/);
  assert.match(trecho, /if \(typeof c\.value !== "string"\) return null;/);
  // sameSite fora do padrão e expires inválido são o que o Chrome recusa.
  assert.ok(trecho.includes('limpo.sameSite = "Strict"'));
  assert.ok(trecho.includes('Number.isFinite(c.expires)'));
  assert.ok(trecho.includes('c.path.startsWith("/")'));
});

test('o override chegou ao gateway instalado', () => {
  const alvo = '.tools/token-free-gateway/src/browser/manager.ts';
  if (!fs.existsSync(alvo)) return; // gateway não instalado nesta máquina
  assert.equal(fs.readFileSync(alvo, 'utf8'), MANAGER, 'rode npm run gateway:sync');
});
