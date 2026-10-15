const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const FONTE = fs.readFileSync('src/services/chatgptLivreService.js', 'utf8');

/**
 * O código que escolhe as mensagens roda DENTRO da página (page.evaluate), e
 * por isso precisa ser autocontido — não dá para importá-lo. Em vez de
 * reescrevê-lo aqui (um teste que não testaria o que roda em produção), o
 * trecho real é extraído do arquivo e executado contra um DOM do jsdom.
 */
function trechoEntre(inicio, fim) {
  const a = FONTE.indexOf(inicio);
  const b = FONTE.indexOf(fim, a);
  assert.ok(a > 0 && b > a, `trecho não encontrado: ${inicio}`);
  return FONTE.slice(a, b);
}

const SELETORES = [
  '[data-message-author-role="assistant"]',
  'article[data-turn="assistant"], [data-testid^="conversation-turn"][data-turn="assistant"]',
  'article, [data-testid^="conversation-turn"]',
  '[data-message-author-role="user"], [data-turn="user"]',
];

/**
 * Roda o corpo REAL de `contarRespostas` contra um HTML.
 *
 * O corte para antes de `}, SELETORES)`, então o `}` que fecha a função
 * precisa voltar.
 */
function contar(html) {
  const corpo = `${trechoEntre(
    '([porPapel, porTurno, qualquerTurno, doUsuario]) => {',
    '}, SELETORES)'
  )}}`;
  const dom = new JSDOM(html);
  const fn = new Function('document', `return (${corpo})(${JSON.stringify(SELETORES)});`);
  return fn(dom.window.document);
}

/** Roda a escolha de mensagens de `lerUltimaResposta` contra um HTML. */
function escolher(html) {
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const [seletor, seletorTurno, qualquerTurno, doUsuario] = SELETORES;
  const porPapel = [...document.querySelectorAll(seletor)];
  const porTurno = [...document.querySelectorAll(seletorTurno)];
  let mensagens = porPapel.length >= porTurno.length ? porPapel : porTurno;
  let via = porPapel.length >= porTurno.length ? 'papel' : 'turno';
  if (!mensagens.length) {
    mensagens = [...document.querySelectorAll(qualquerTurno)].filter(
      (t) => !t.matches(doUsuario) && !t.querySelector(doUsuario)
    );
    via = 'reserva';
  }
  return { total: mensagens.length, via, ultima: mensagens[mensagens.length - 1] || null };
}

const COM_PAPEL = `
  <article data-turn="user"><div data-message-author-role="user">fala mano</div></article>
  <article data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown"><p>Fala, mano! Tudo certo?</p></div></div></article>`;

const SO_TURNO = `
  <article data-turn="user">fala mano</article>
  <article data-turn="assistant"><div class="markdown"><p>Fala, mano!</p></div></article>`;

// O caso que quebrou: ChatGPT trocou os atributos e nenhum marcador casa.
const SEM_MARCADOR = `
  <article><div data-message-author-role="user">fala mano</div></article>
  <article><div class="markdown"><p>Fala, mano! Tudo certo?</p></div></article>`;

test('conta pelo papel da mensagem quando ele existe', () => {
  assert.equal(contar(COM_PAPEL), 1);
  assert.equal(escolher(COM_PAPEL).via, 'papel');
});

test('conta pelo turno quando só o turno está marcado', () => {
  assert.equal(contar(SO_TURNO), 1);
  assert.equal(escolher(SO_TURNO).via, 'turno');
});

test('sem marcador nenhum, vale o turno que não é do usuário', () => {
  // Era aqui que a conversa sumia: respondida na tela, invisível para nós,
  // e o painel ficava em "pesquisando e escrevendo…" até o limite de 6 min.
  assert.equal(contar(SEM_MARCADOR), 1, 'o turno do usuário não pode entrar na conta');
  const r = escolher(SEM_MARCADOR);
  assert.equal(r.via, 'reserva');
  assert.equal(r.total, 1);
  assert.match(r.ultima.textContent, /Fala, mano/);
});

test('a reserva não conta o turno do usuário como resposta', () => {
  // Contar o pedido como resposta faria a espera terminar antes da hora,
  // devolvendo o próprio texto do editor como se fosse a matéria.
  const soPedido = '<article><div data-message-author-role="user">fala mano</div></article>';
  assert.equal(contar(soPedido), 0);
  assert.equal(escolher(soPedido).ultima, null);
});

test('conversa vazia conta zero', () => {
  assert.equal(contar('<main></main>'), 0);
  assert.equal(escolher('<main></main>').ultima, null);
});

test('conversa com várias respostas devolve a última', () => {
  const duas = `
    <article data-turn="assistant"><div data-message-author-role="assistant">primeira</div></article>
    <article data-turn="assistant"><div data-message-author-role="assistant">segunda</div></article>`;
  assert.equal(contar(duas), 2);
  assert.match(escolher(duas).ultima.textContent, /segunda/);
});

test('o sumiço vira log em segundos, não em 6 minutos', () => {
  assert.match(FONTE, /const AVISO_SEM_RESPOSTA_MS = Number\(process\.env\.CHATGPT_LIVRE_AVISO_MS\) \|\| 40_000;/);
  assert.match(FONTE, /if \(!avisouSumico && Date\.now\(\) - comeco > AVISO_SEM_RESPOSTA_MS\)/);
  assert.match(FONTE, /resposta não encontrada no DOM após/);
  // Uma vez só: diagnosticar tira print, e um por segundo encheria o disco.
  assert.match(FONTE, /avisouSumico = true;/);
  // E o editor precisa saber, não só o log.
  assert.match(FONTE, /não consigo ler a resposta na página/);
});

test('o diagnóstico diz por qual caminho a leitura veio', () => {
  assert.match(FONTE, /total: mensagens\.length, via/);
  assert.match(FONTE, /lida \? `total \$\{lida\.total\} via \$\{lida\.via\}` : 'null'/);
});
