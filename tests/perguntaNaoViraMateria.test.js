const test = require('node:test');
const assert = require('node:assert/strict');

const { pareceConversaComOEditor, separarMaterias } = require('../src/services/materiaChatService');

// Por que este arquivo existe: a IA respondeu com três opções numeradas
// perguntando o que o editor queria, e a tela mostrou "3 matérias criadas" —
// com uma das PERGUNTAS salva como rascunho (#7535). A separação por lista
// numerada tratava qualquer item com 15+ caracteres como título de matéria.

/** A resposta real que virou três matérias. */
const PERGUNTAS = [
  '1. O fato real (link, print, vídeo ou post) que você quer cobrir — eu apuro e escrevo.',
  '',
  '2. O tema fechado, por exemplo: "pastor expulsa jovem do culto por usar calça jeans". Eu disparo a apuração e volto com o texto pronto para revisão.',
  '',
  '3. Ou confirma que é para eu acionar a pesquisa sobre um dos temas da sua lista, que eu apuro e redijo em cima do que aparecer. Qual você prefere?',
].join('\n');

test('resposta que pergunta ao editor não vira lote de matérias', () => {
  assert.equal(pareceConversaComOEditor(PERGUNTAS), true);
  assert.deepEqual(separarMaterias(PERGUNTAS), []);
});

test('pergunta ao LEITOR no fim da matéria continua valendo', () => {
  // A pauta da casa pede que a matéria termine perguntando ao leitor. Usar
  // "termina com ?" como sinal apagaria matéria boa.
  const materia = [
    'Pastor reúne estádio lotado para uma hora de oração',
    '',
    'Cerca de 80 mil pessoas se reuniram no AT&T Stadium.',
    '',
    'E aí, o que você acha? Deixa sua opinião!',
  ].join('\n');
  assert.equal(pareceConversaComOEditor(materia), false);
});

test('reconhece as formas de oferecer trabalho ao editor', () => {
  for (const frase of [
    'Quer que eu escreva sobre isso?',
    'Qual você prefere?',
    'Qual vc prefere?',
    'Prefere que eu aprofunde o segundo tema?',
    'Posso gerar uma versão mais curta',
    'Eu apuro e escrevo',
    'Eu disparo a apuração',
    'Me diga o tema',
    'Me manda o link',
    'Cole o link da publicação',
  ]) {
    assert.equal(pareceConversaComOEditor(frase), true, frase);
  }
});

test('texto de matéria comum não é confundido com conversa', () => {
  for (const frase of [
    'O pastor afirmou que o culto seguiu normalmente.',
    'Fonte: Christian Post https://www.christianpost.com/news/x.html',
    'Segundo a reportagem, o evento reuniu 80 mil pessoas.',
    'A igreja disse que não vai se pronunciar.',
    '#Gospel #Fe #Oracao',
  ]) {
    assert.equal(pareceConversaComOEditor(frase), false, frase);
  }
});

test('lote de verdade continua sendo separado', () => {
  // O marcador explícito pedido no prompt não pode ser afetado pela guarda.
  const lote = [
    '### MATÉRIA 1',
    'Pastor reúne estádio lotado para uma hora de oração',
    '',
    'Cerca de 80 mil pessoas se reuniram no AT&T Stadium, no dia 10 de outubro.',
    '',
    'Fonte: Christian Post https://www.christianpost.com/news/a.html',
    '',
    '### MATÉRIA 2',
    'Cantora gospel anuncia turnê por dez capitais brasileiras',
    '',
    'A turnê começa em março e passa por dez capitais, segundo a assessoria.',
    '',
    'Fonte: Gospel Prime https://www.gospelprime.com.br/b.html',
  ].join('\n');
  assert.ok(separarMaterias(lote).length >= 2, 'lote explícito deixou de ser separado');
});

test('entrada vazia ou nula não quebra', () => {
  assert.equal(pareceConversaComOEditor(''), false);
  assert.equal(pareceConversaComOEditor(null), false);
  assert.equal(pareceConversaComOEditor(undefined), false);
});
