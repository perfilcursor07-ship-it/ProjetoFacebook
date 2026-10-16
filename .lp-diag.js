/**
 * Script temporário: gera os HTMLs de conferência da página inicial.
 *
 *  - diag.html    : a página + uma sonda que mede a largura e lista o que estoura.
 *  - harness.html : coloca o diag.html dentro de um iframe da largura pedida
 *                   (#390, #768, ...). O iframe cria um viewport próprio, então
 *                   dá para testar 390px de verdade — a janela do Chrome no
 *                   Windows não aceita menos de ~500px de largura.
 *  - preview.html : a página sem animação, para a captura sair sempre igual.
 *
 * Não faz parte do projeto — é removido depois da conferência.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const raiz = __dirname;
const dir = path.join(raiz, '.lp-shots');
fs.mkdirSync(dir, { recursive: true });

const html = ejs.render(fs.readFileSync(path.join(raiz, 'public', 'views', 'index.ejs'), 'utf8'), {
  title: 'Início',
});
const cssApp = fs.readFileSync(path.join(raiz, 'public', 'css', 'app.css'), 'utf8');
const cssLanding = fs.readFileSync(path.join(raiz, 'public', 'css', 'landing.css'), 'utf8');

const sonda = `
<script>
window.addEventListener('load', function () {
  var largura = window.innerWidth;
  var vazando = [];
  var todos = document.querySelectorAll('body *');
  for (var i = 0; i < todos.length; i++) {
    var el = todos[i];
    // O fundo decorativo é recortado de propósito, e o atalho de acessibilidade
    // fica fora da tela de propósito: nenhum dos dois é estouro real.
    if (el.closest('.lp-fundo') || el.closest('.lp-skip')) continue;
    var r = el.getBoundingClientRect();
    if (r.width > largura + 1 || r.right > largura + 1 || r.left < -1) {
      var classe = String(el.className || '').split(/\\s+/).slice(0, 3).join('.');
      vazando.push(el.tagName.toLowerCase() + '.' + classe +
        ' (w=' + Math.round(r.width) + ' l=' + Math.round(r.left) + ' r=' + Math.round(r.right) + ')');
    }
  }
  var pre = document.createElement('pre');
  pre.id = 'DIAG';
  pre.textContent = 'INNERWIDTH=' + largura +
    ' SCROLLW=' + document.documentElement.scrollWidth +
    ' SCROLLH=' + document.documentElement.scrollHeight +
    ' VAZANDO=' + vazando.length + ' :: ' + vazando.join(' ;; ');
  document.body.insertBefore(pre, document.body.firstChild);
});
</script>
`;

const comCss = (base) =>
  base
    .replace('<link rel="stylesheet" href="/css/app.css" />', '<style>\n' + cssApp + '\n</style>')
    .replace(
      /<link rel="stylesheet" href="\/css\/landing\.css[^"]*" \/>/,
      '<style>\n' + cssLanding + '\n</style>'
    );

fs.writeFileSync(path.join(dir, 'diag.html'), comCss(html).replace('</body>', sonda + '</body>'), 'utf8');

const overrides = [
  '<style>',
  '[data-revelar]{opacity:1!important;transform:none!important}',
  '.lp-entra{animation:none!important;opacity:1!important;transform:none!important}',
  '.lp-orbe,.lp-flutuante,.lp-etiqueta::before{animation:none!important}',
  '</style>',
].join('\n');
fs.writeFileSync(
  path.join(dir, 'preview.html'),
  comCss(html).replace('</head>', overrides + '\n</head>'),
  'utf8'
);

const harness = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><title>harness</title><style>
  html, body { margin: 0; padding: 0; background: #060910; }
  #f { display: block; border: 0; width: 390px; height: 9000px; }
  #DIAG { position: absolute; left: -99999px; top: 0; }
</style></head><body>
<iframe id="f" src="diag.html"></iframe>
<pre id="DIAG">aguardando</pre>
<script>
  var f = document.getElementById('f');
  var largura = parseInt((location.hash || '').replace('#', ''), 10) || 390;
  f.style.width = largura + 'px';
  f.addEventListener('load', function () {
    setTimeout(function () {
      var destino = document.getElementById('DIAG');
      try {
        var interno = f.contentDocument.getElementById('DIAG');
        destino.textContent = interno ? interno.textContent : 'SEM_SONDA_INTERNA';
      } catch (e) {
        destino.textContent = 'ERRO_IFRAME: ' + e.message;
      }
    }, 300);
  });
</script>
</body></html>
`;
fs.writeFileSync(path.join(dir, 'harness.html'), harness, 'utf8');

console.log('gerado: diag.html, harness.html, preview.html em .lp-shots');
