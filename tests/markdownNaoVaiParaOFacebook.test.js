const test = require('node:test');
const assert = require('node:assert/strict');

const { limparArtefatosDeTextoLivre: limpar } = require('../src/services/materiaChatService');

/** A matéria real que saiu com as cerquilhas à mostra. */
const REAL = [
  '[[80 mil pessoas]]: pastor reúne estádio lotado para uma hora de oração nos EUA',
  '',
  'Cerca de 80 mil pessoas se reuniram no dia 10 de outubro no AT&T Stadium.',
  '',
  '### Estádio foi reservado para oração',
  '',
  'O evento, chamado **ACCESS — That Powerful Hour of Prayer**, não teve como foco um show.',
  '',
  '## Crescimento chamou atenção',
  '',
  'A edição deste ano foi realizada em um espaço maior. Veja [a reportagem](https://portal.com/x).',
  '',
  'Fonte: Christian Post https://www.christianpost.com/news/x.html',
  '',
  '#Gospel #Oracao #Fe',
].join('\n');

test('cabeçalho de Markdown vira subtítulo em texto comum', () => {
  // O Facebook não renderiza Markdown: "### Estádio foi reservado" ia para o
  // post com as cerquilhas. Apareceu quando a pauta passou a pedir subtítulos.
  const saida = limpar(REAL);
  assert.doesNotMatch(saida, /(^|\n)[ \t]*#{1,6}[ \t]/, 'nenhuma linha pode começar com cerquilha');
  assert.match(saida, /\nEstádio foi reservado para oração\n/, 'o subtítulo continua lá, sem a marcação');
  assert.match(saida, /\nCrescimento chamou atenção\n/);
});

test('negrito e itálico de Markdown saem', () => {
  const saida = limpar(REAL);
  assert.doesNotMatch(saida, /\*\*/);
  assert.match(saida, /chamado ACCESS — That Powerful Hour of Prayer, não teve/);
  assert.equal(limpar('texto com __sublinhado__ aqui'), 'texto com sublinhado aqui');
});

test('link de Markdown deixa só o texto', () => {
  // O endereço tem lugar próprio: a linha Fonte.
  const saida = limpar(REAL);
  assert.doesNotMatch(saida, /\]\(http/);
  assert.match(saida, /Veja a reportagem\./);
});

test('a linha de hashtags não é confundida com cabeçalho', () => {
  // "#Gospel" não tem espaço depois da cerquilha; "### " tem. É o que separa
  // uma hashtag de um cabeçalho — e apagar as hashtags quebraria o rodapé.
  const saida = limpar(REAL);
  assert.match(saida, /#Gospel #Oracao #Fe/);
  assert.equal(limpar('#UmaHashtagSozinha'), '#UmaHashtagSozinha');
  assert.equal(limpar('#Gospel #Fe #Oracao'), '#Gospel #Fe #Oracao');
});

test('a marcação da arte sobrevive', () => {
  // [[trecho]] é instrução para o renderizador da capa pintar o destaque.
  const saida = limpar(REAL);
  assert.match(saida, /\[\[80 mil pessoas\]\]/);
});

test('a linha Fonte continua inteira, com o endereço', () => {
  const saida = limpar(REAL);
  assert.match(saida, /Fonte: Christian Post https:\/\/www\.christianpost\.com\/news\/x\.html/);
});

test('texto sem Markdown nenhum passa intacto', () => {
  const simples = 'Primeiro parágrafo.\n\nSegundo parágrafo com 2 + 2 = 4 e um # solto.';
  assert.equal(limpar(simples), simples);
});

test('entrada vazia ou nula não quebra', () => {
  assert.equal(limpar(''), '');
  assert.equal(limpar(null), '');
  assert.equal(limpar(undefined), '');
});
