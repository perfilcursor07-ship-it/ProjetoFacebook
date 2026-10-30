const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SCRIPT = fs.readFileSync('scripts/install-token-free-gateway-overrides.js', 'utf8');

// Por que este arquivo existe: no servidor o gateway ficou 14 dias no ar sem
// ninguém notar. Todo `npm run gateway:restart` dizia
//
//   Gateway is not running (no PID file found)
//   Failed to start gateway. (EADDRINUSE: porta 3456 em uso)
//
// O `stop` desistia por falta do PID file, o `start` esbarrava na porta que o
// processo ANTIGO ainda segurava, e o restart virava no-op. `gateway:sync`
// atualizava os arquivos e nenhuma correção entrava em vigor, porque o código
// já estava carregado na memória daquele processo.

test('sem PID file, o restart procura quem está servindo', () => {
  assert.match(SCRIPT, /marca: 'pidDoGatewayServindo'/);
  // Pela linha de comando em /proc: sem depender de lsof/ss estarem instalados.
  assert.ok(SCRIPT.includes('readdirSync("/proc")'));
  assert.ok(SCRIPT.includes('token-free-gateway") && linha.includes("__serve'));
});

test('só desiste depois de procurar', () => {
  // Medido no arquivo INSTALADO, não no instalador: lá o texto original e o
  // substituto convivem no mesmo objeto e a ordem não diz nada.
  const alvo = '.tools/token-free-gateway/src/cli/daemon.ts';
  if (!fs.existsSync(alvo)) return; // gateway não instalado nesta máquina
  const codigo = fs.readFileSync(alvo, 'utf8');
  const i = codigo.indexOf('export async function stopDaemon()');
  const trecho = codigo.slice(i, i + 600);
  const procura = trecho.indexOf('pid = pidDoGatewayServindo()');
  const desiste = trecho.indexOf('Gateway is not running (no PID file found)');
  assert.ok(procura > 0 && desiste > 0, 'o trecho do stopDaemon sumiu');
  assert.ok(procura < desiste, 'desiste antes de procurar quem está servindo');
});

test('fora do Linux, o comportamento antigo vale', () => {
  // /proc não existe no Windows nem no macOS; ali não há o que varrer.
  assert.ok(SCRIPT.includes('process.platform !== "linux"'));
});

test('o import do readdirSync tem marca própria', () => {
  // A marca precisa ser a linha inteira: `readdirSync` sozinho já aparece no
  // patch da função, e o guard de idempotência pulava este patch aqui —
  // o arquivo ficava usando readdirSync sem importar.
  assert.ok(SCRIPT.includes(`marca: 'readFileSync, readdirSync } from "node:fs"'`));
});

test('o patch foi aplicado no gateway, uma vez só', () => {
  const alvo = '.tools/token-free-gateway/src/cli/daemon.ts';
  if (!fs.existsSync(alvo)) return; // gateway não instalado nesta máquina
  const codigo = fs.readFileSync(alvo, 'utf8');
  assert.equal(
    (codigo.match(/function pidDoGatewayServindo\(/g) || []).length,
    1,
    'patch ausente ou aplicado mais de uma vez'
  );
  assert.match(
    codigo.split('\n')[0],
    /readFileSync, readdirSync/,
    'readdirSync é usado mas não importado'
  );
});
