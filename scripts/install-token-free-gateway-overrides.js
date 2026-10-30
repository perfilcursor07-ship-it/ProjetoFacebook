const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'gateway-overrides', 'token-free-gateway');
const targetRoot = path.join(projectRoot, '.tools', 'token-free-gateway');
const required = process.argv.includes('--required');
const strict = process.argv.includes('--strict');

// Versão do token-free-gateway sobre a qual os overrides foram escritos.
// Os arquivos abaixo substituem os originais inteiros: em outra versão eles
// podem desfazer correções do gateway ou quebrar imports. Ao atualizar o
// gateway, compare os originais com os overrides e atualize este número.
const UPSTREAM_VERSION = '0.5.2';

const files = [
  // Inteiro: além do original, registra as abas dos provedores para serem
  // recarregadas de tempos em tempos (inclui o antigo patch de cookies).
  'src/browser/manager.ts',
  'src/viralizeai/abas.ts',
  'src/openai/chat-completions.ts',
  'src/openai/types.ts',
  'src/providers/claude/chunk-stream.ts',
  'src/providers/claude/client.ts',
  'src/providers/claude/errors.ts',
  'src/providers/claude/index.ts',
  'src/providers/claude/stream.ts',
  // Inteiro (não patch): streaming de verdade e uma conversa do chatgpt.com
  // por conversa do ViralizeAI. Já inclui o antigo patch `resolverImagens`.
  'src/providers/chatgpt/client.ts',
  // Inteiro também: entende o SSE novo do ChatGPT (deltas). Substitui os
  // antigos patches `viralizeai-imagem` deste arquivo.
  'src/providers/chatgpt/stream.ts',
  // Inteiro: o token do DeepSeek passou a ser lido da aba logada a cada
  // pedido, em vez do capturado uma vez no `webauth`. Substitui os antigos
  // patches `atualizarBearerDaPagina` e `viralizeai-deepseek`.
  'src/providers/deepseek/client.ts',
  'src/providers/deepseek/stream.ts',
  'src/providers/factory/base-api-client.ts',
  'src/providers/factory/types.ts',
  'src/providers/types.ts',
];

// Alterações pontuais em arquivos do gateway que não mantemos inteiros aqui.
// Cada patch procura um trecho exato; se o arquivo já tiver a marca, pula; se
// o trecho não existir (outra versão do gateway), avisa e não mexe em nada.
const patches = [
  {
    file: 'src/cli/chrome.ts',
    marca: '--disable-renderer-backgrounding',
    procurar: '\t\t"--disable-background-networking",',
    trocar: [
      '\t\t"--disable-background-networking",',
      '\t\t// Abas da automação abrem em segundo plano (para não fazer o noVNC piscar);',
      '\t\t// sem estas opções o Chrome desacelera essas abas e a geração atrasa.',
      '\t\t"--disable-background-timer-throttling",',
      '\t\t"--disable-renderer-backgrounding",',
      '\t\t"--disable-backgrounding-occluded-windows",',
    ].join('\n'),
  },
  // `gateway:restart` virava no-op quando o PID file sumia: o `stop` desistia
  // ("Gateway is not running"), o `start` esbarrava na porta ocupada
  // (EADDRINUSE) e o processo ANTIGO seguia servindo. No servidor isso deixou
  // um gateway de 14 dias no ar — todo `npm run gateway:sync` atualizava os
  // arquivos e nenhuma correção entrava, porque o código já estava carregado
  // na memória daquele processo.
  //
  // Agora, sem PID file, o processo que serve é procurado pela linha de
  // comando antes de desistir.
  // "PoW challenge missing in response": o pedido do desafio anti-robô da
  // DeepSeek volta 200, mas o desafio não está em nenhum dos três lugares que
  // o gateway conhece — eles mudaram o formato da resposta. Sem desafio, toda
  // matéria pedida à DeepSeek falha, mesmo com a sessão logada no VNC.
  //
  // Em vez de cravar um quarto caminho fixo, o desafio é procurado pelo seu
  // formato (algorithm + salt + challenge), onde quer que ele esteja. E se
  // mesmo assim não houver nenhum, a resposta inteira vai para o log: sem ela
  // o próximo conserto seria palpite outra vez.
  {
    file: 'src/cli/daemon.ts',
    marca: 'pidDoGatewayServindo',
    procurar: [
      'export async function stopDaemon() {',
      '\tconst pid = readPid();',
      '\tif (!pid) {',
      '\t\tconsole.log("Gateway is not running (no PID file found)");',
      '\t\treturn;',
      '\t}',
    ].join('\n'),
    trocar: [
      '/**',
      ' * viralizeai: acha o gateway que está servindo quando o PID file sumiu.',
      ' *',
      ' * Sem isto o `restart` desiste no `stop`, o `start` morre com EADDRINUSE',
      ' * e o processo velho continua de pé — por 14 dias, no caso que motivou',
      ' * este patch, com todas as correções do gateway paradas em disco.',
      ' *',
      ' * Procura pela linha de comando em /proc (Linux); em outro sistema devolve',
      ' * null e o comportamento antigo continua valendo.',
      ' */',
      'function pidDoGatewayServindo(): number | null {',
      '\tif (process.platform !== "linux") return null;',
      '\ttry {',
      '\t\tfor (const nome of readdirSync("/proc")) {',
      '\t\t\tif (!/^[0-9]+$/.test(nome)) continue;',
      '\t\t\tconst pid = Number(nome);',
      '\t\t\tif (pid === process.pid) continue;',
      '\t\t\tlet linha = "";',
      '\t\t\ttry {',
      '\t\t\t\tlinha = readFileSync(`/proc/${nome}/cmdline`, "utf8");',
      '\t\t\t} catch {',
      '\t\t\t\tcontinue; // processo morreu no meio da varredura, ou não é nosso',
      '\t\t\t}',
      '\t\t\tif (linha.includes("token-free-gateway") && linha.includes("__serve")) return pid;',
      '\t\t}',
      '\t} catch {',
      '\t\t/* sem /proc: cai no comportamento antigo */',
      '\t}',
      '\treturn null;',
      '}',
      '',
      'export async function stopDaemon() {',
      '\tlet pid = readPid();',
      '\tif (!pid) {',
      '\t\tpid = pidDoGatewayServindo();',
      '\t\tif (!pid) {',
      '\t\t\tconsole.log("Gateway is not running (no PID file found)");',
      '\t\t\treturn;',
      '\t\t}',
      '\t\tconsole.log(`Gateway sem PID file; achei quem está servindo (PID: ${pid})`);',
      '\t}',
    ].join('\n'),
  },
  {
    file: 'src/cli/daemon.ts',
    // A marca é a linha inteira, não só `readdirSync`: a palavra sozinha já
    // aparece no patch acima, e o guard de idempotência pulava este aqui.
    marca: 'readFileSync, readdirSync } from "node:fs"',
    procurar: 'import { closeSync, openSync, readFileSync } from "node:fs";',
    trocar: 'import { closeSync, openSync, readFileSync, readdirSync } from "node:fs";',
  },
  {
    file: 'src/server.ts',
    marca: 'handleChatCompletions(body, provider, req.signal)',
    procurar: '\treturn handleChatCompletions(body, provider);',
    trocar: [
      '\t// viralizeai: cancela a geração no Chrome quando o cliente desconecta.',
      '\treturn handleChatCompletions(body, provider, req.signal);',
    ].join('\n'),
  },
];

if (!fs.existsSync(path.join(targetRoot, 'package.json'))) {
  const message =
    '[gateway-sync] .tools/token-free-gateway não está instalado; overrides não aplicados.';
  if (required) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

const installedVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(targetRoot, 'package.json'), 'utf8')).version || '?';
  } catch {
    return '?';
  }
})();
if (installedVersion !== UPSTREAM_VERSION) {
  console.warn(
    `[gateway-sync] ATENÇÃO: gateway instalado é ${installedVersion}, overrides feitos para ${UPSTREAM_VERSION}. ` +
      'Confira se os arquivos sobrescritos ainda batem com esta versão.'
  );
  if (strict) process.exit(1);
}

let updated = 0;
for (const relativePath of files) {
  const source = path.join(sourceRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  if (!fs.existsSync(source)) {
    console.error(`[gateway-sync] override ausente: ${relativePath}`);
    process.exit(1);
  }

  const next = fs.readFileSync(source);
  const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (current && current.equals(next)) continue;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  updated += 1;
}

for (const patch of patches) {
  const target = path.join(targetRoot, patch.file);
  if (!fs.existsSync(target)) {
    console.warn(`[gateway-sync] patch ignorado, arquivo ausente: ${patch.file}`);
    continue;
  }
  const original = fs.readFileSync(target, 'utf8');
  if (original.includes(patch.marca)) continue;
  const crlf = original.includes('\r\n');
  const texto = crlf ? original.replace(/\r\n/g, '\n') : original;
  if (!texto.includes(patch.procurar)) {
    console.warn(`[gateway-sync] patch não aplicado (trecho não encontrado nesta versão): ${patch.file}`);
    continue;
  }
  let novo = texto.replace(patch.procurar, patch.trocar);
  if (crlf) novo = novo.replace(/\n/g, '\r\n');
  fs.writeFileSync(target, novo);
  updated += 1;
}

console.log(
  updated
    ? `[gateway-sync] ${updated} arquivo(s) do gateway atualizado(s).`
    : '[gateway-sync] gateway já está sincronizado.'
);
