/**
 * Script temporário de verificação da página inicial.
 * Valida o render do EJS e o CSS da landing, e gera um HTML de pré-visualização
 * com o CSS embutido, para tirar screenshot sem servidor.
 *
 * Não faz parte do projeto — é removido depois da conferência.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const raiz = __dirname;
const alvoEjs = path.join(raiz, 'public', 'views', 'index.ejs');
const cssLanding = path.join(raiz, 'public', 'css', 'landing.css');
const cssApp = path.join(raiz, 'public', 'css', 'app.css');

let falhas = 0;
const erro = (msg) => {
  falhas += 1;
  console.log('FALHA: ' + msg);
};

// ---------------------------------------------------------------- 1) EJS ---
const fonteEjs = fs.readFileSync(alvoEjs, 'utf8');

let html = '';
try {
  html = ejs.render(fonteEjs, { title: 'Início' });
  console.log('OK  EJS renderiza — ' + html.length + ' bytes');
} catch (err) {
  erro('EJS não renderiza: ' + err.message);
}

if (html) {
  const conta = (re) => (html.match(re) || []).length;
  console.log('    módulos=' + conta(/class="lp-modulo /g));
  console.log('    data-revelar=' + conta(/data-revelar/g));

  const pares = [
    ['section', /<section/g, /<\/section>/g],
    ['div', /<div/g, /<\/div>/g],
    ['a', /<a /g, /<\/a>/g],
    ['ul', /<ul/g, /<\/ul>/g],
    ['ol', /<ol/g, /<\/ol>/g],
    ['li', /<li[ >]/g, /<\/li>/g],
    ['svg', /<svg/g, /<\/svg>/g],
    ['nav', /<nav/g, /<\/nav>/g],
  ];
  for (const [nome, abre, fecha] of pares) {
    const a = conta(abre);
    const f = conta(fecha);
    if (a !== f) erro('tag <' + nome + '> desbalanceada: ' + a + ' abre / ' + f + ' fecha');
    else console.log('OK  <' + nome + '> ' + a + ' par(es)');
  }

  // O CSS precisa ter todas as classes lp- usadas no HTML.
  const cssTxt = fs.readFileSync(cssLanding, 'utf8');
  const noCss = new Set();
  for (const m of cssTxt.matchAll(/\.(lp-[a-zA-Z0-9_-]+)/g)) noCss.add(m[1]);

  const noHtml = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c.startsWith('lp-')) noHtml.add(c);
  }
  const semEstilo = [...noHtml].filter((c) => !noCss.has(c));
  console.log('    classes lp- no HTML=' + noHtml.size + ', no CSS=' + noCss.size);
  if (semEstilo.length) erro('classes sem estilo: ' + semEstilo.join(', '));
  else console.log('OK  toda classe lp- do HTML tem regra no CSS');
}

// ---------------------------------------------------------------- 2) CSS ---
const cssTxt = fs.readFileSync(cssLanding, 'utf8');
const abre = (cssTxt.match(/\{/g) || []).length;
const fecha = (cssTxt.match(/\}/g) || []).length;
if (abre !== fecha) erro('CSS desbalanceado: ' + abre + ' { / ' + fecha + ' }');
else console.log('OK  CSS tem ' + abre + ' blocos balanceados');

// ------------------------------------------------- 3) pré-visualização ---
if (html) {
  const overrides = [
    '<style>',
    '/* overrides só para a captura: sem animação e tudo visível */',
    '[data-revelar]{opacity:1!important;transform:none!important}',
    '.lp-entra{animation:none!important;opacity:1!important;transform:none!important}',
    '.lp-orbe,.lp-flutuante,.lp-etiqueta::before{animation:none!important}',
    '.lp-janela{transform:none!important}',
    '</style>',
  ].join('\n');

  const preview = html
    .replace(
      '<link rel="stylesheet" href="/css/app.css" />',
      '<style>\n' + fs.readFileSync(cssApp, 'utf8') + '\n</style>'
    )
    .replace(
      /<link rel="stylesheet" href="\/css\/landing\.css[^"]*" \/>/,
      '<style>\n' + cssTxt + '\n</style>'
    )
    .replace('</head>', overrides + '\n</head>');

  const dirSaida = path.join(raiz, '.lp-shots');
  fs.mkdirSync(dirSaida, { recursive: true });
  const arquivo = path.join(dirSaida, 'preview.html');
  fs.writeFileSync(arquivo, preview, 'utf8');
  console.log('OK  pré-visualização: ' + arquivo);
  console.log('    tem app.css inline: ' + preview.includes('--tw-border-spacing-x'));
  console.log('    tem landing.css inline: ' + preview.includes('--lp-container'));
  console.log('    links de css restantes: ' + (preview.match(/rel="stylesheet"/g) || []).length);
}

console.log(falhas ? '\nRESULTADO: ' + falhas + ' falha(s)' : '\nRESULTADO: tudo certo');
process.exit(falhas ? 1 : 0);
