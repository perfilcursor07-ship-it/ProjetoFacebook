const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const FONTE = fs.readFileSync('src/services/materiaChatService.js', 'utf8');

// Por que este arquivo existe: com "Pesquisar fontes" DESMARCADO, o sistema
// saía apurando assim mesmo —
//
//   Analisando o pedido e montando as buscas (últimos 30 dias)…
//   Pesquisando na web (últimos 30 dias): "silas malafaia"
//   Lendo Folha de S.Paulo: ...
//
// porque o texto do pedido podia religar a pesquisa sozinho. Bastava conter
// "internet", "outras fontes", "viral" ou algo que `pedidoSolicitaPesquisa`
// reconhecesse. O que a tela mostrava não tinha relação com o que acontecia.

test('no fluxo normal, só o botão decide', () => {
  const i = FONTE.indexOf('let usarPesquisa =');
  assert.ok(i > 0, 'a decisão de pesquisar sumiu');
  const linha = FONTE.slice(i, FONTE.indexOf('\n', i));
  assert.ok(linha.includes('Boolean(pesquisarWeb)'), 'o botão precisa continuar valendo');
  assert.ok(!linha.includes('pedidoMandaPesquisar'), 'o texto do pedido não pode religar a pesquisa');
  // Listar pautas continua exigindo busca: é o objetivo do modo, e a própria
  // tela liga a caixa ao entrar nele.
  assert.ok(linha.includes('modoPautas'));
});

test('no modo Conversar, idem', () => {
  const i = FONTE.indexOf('const pesquisarLivre =');
  assert.ok(i > 0);
  const trecho = FONTE.slice(i, FONTE.indexOf(';', i));
  assert.ok(trecho.includes('pesquisarWeb'));
  assert.ok(!trecho.includes('pedidoSolicitaPesquisa'), 'palavra do pedido não liga pesquisa');
  // Link que o sistema não conseguiu ler continua valendo: é fonte escolhida
  // pelo editor, não pesquisa que ele não pediu.
  assert.ok(trecho.includes('artigoNaoExtraidoLivre'));
});

test('a tela não anuncia pesquisa que não vai acontecer', () => {
  // `pediuPesquisaClaude` escolhe entre "Pesquisando…" e "Escrevendo…".
  const i = FONTE.indexOf('const pediuPesquisaClaude =');
  assert.ok(i > 0);
  const trecho = FONTE.slice(i, FONTE.indexOf(');', i));
  assert.ok(!trecho.includes('pedidoSolicitaPesquisa'));
});

test('pedir pesquisa com o botão desligado avisa, não ignora em silêncio', () => {
  // Não pesquisar é o certo; não dizer por quê é que confunde.
  assert.ok(FONTE.includes('if (!usarPesquisa && pedidoMandaPesquisar) {'));
  assert.match(FONTE, /botão “Pesquisar fontes” está desligado/);
  const i = FONTE.indexOf('if (!usarPesquisa && pedidoMandaPesquisar) {');
  assert.match(FONTE.slice(i, i + 300), /kind: 'aviso'/);
});

test('o botão continua sendo enviado pela tela', () => {
  // Se o front parar de mandar, tudo acima vira letra morta.
  const front = fs.readFileSync('public/js/materia-chat.js', 'utf8');
  assert.match(front, /pesquisarWeb: state\.pesquisarWeb/);
  const ctrl = fs.readFileSync('src/controllers/materiaChatController.js', 'utf8');
  assert.match(ctrl, /body\.pesquisarWeb \?\? body\.pesquisar_web/);
});
