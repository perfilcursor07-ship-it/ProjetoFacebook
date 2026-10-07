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
  'src/openai/chat-completions.ts',
  'src/openai/types.ts',
  'src/providers/claude/chunk-stream.ts',
  'src/providers/claude/client.ts',
  'src/providers/claude/errors.ts',
  'src/providers/claude/index.ts',
  'src/providers/claude/stream.ts',
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
    file: 'src/browser/manager.ts',
    marca: 'viralizeai: não sobrescreve sessão viva',
    procurar: '\t\t\t\tawait ctx.addCookies(cookies);',
    trocar: [
      '\t\t\t\t// viralizeai: não sobrescreve sessão viva. O Chrome logado (pelo',
      '\t\t\t\t// noVNC/webauth) é a fonte de verdade; o cookie salvo em',
      '\t\t\t\t// auth-profiles.json só entra se o Chrome ainda não tiver aquele',
      '\t\t\t\t// cookie. Antes, um sessionKey antigo derrubava o login do Claude.',
      '\t\t\t\tconst atuais = await ctx.cookies().catch(() => []);',
      '\t\t\t\tconst chave = (c: { name: string; domain?: string }) =>',
      '\t\t\t\t\t`${c.name}|${String(c.domain || "").replace(/^\\./, "")}`;',
      '\t\t\t\tconst existentes = new Set(atuais.filter((c) => c.value).map(chave));',
      '\t\t\t\tconst faltando = cookies.filter((c) => !existentes.has(chave(c)));',
      '\t\t\t\tif (faltando.length) await ctx.addCookies(faltando);',
    ].join('\n'),
  },
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
