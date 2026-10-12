const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  removerBlocosDoClaude,
  limparMarcacaoChatgpt,
  criarLimpadorDeStream,
} = require('../src/services/chatgptMarkup');

/** Os dois títulos que foram publicados no Facebook com a tag colada. */
const REAIS = [
  '<WritingBlock id="63928" variant="document">Pastor itinerante é preso suspeito de matar ex-mulher durante aniversário do filho em SP',
  '<WritingBlock id="62741" variant="document">Pastor faz alerta sobre desenho infantil da Netflix que mostra o diabo levando almas ao inferno',
];

test('a tag do Claude sai do título', () => {
  assert.equal(
    limparMarcacaoChatgpt(REAIS[0]).trim(),
    'Pastor itinerante é preso suspeito de matar ex-mulher durante aniversário do filho em SP'
  );
  assert.equal(
    limparMarcacaoChatgpt(REAIS[1]).trim(),
    'Pastor faz alerta sobre desenho infantil da Netflix que mostra o diabo levando almas ao inferno'
  );
});

test('abertura e fechamento, com corpo no meio', () => {
  const bruto = '<WritingBlock id="1" variant="document">Título aqui\n\nPrimeiro parágrafo.</WritingBlock>';
  assert.equal(removerBlocosDoClaude(bruto), 'Título aqui\n\nPrimeiro parágrafo.');
});

test('outros blocos em PascalCase também saem', () => {
  for (const tag of ['CodeBlock', 'ThinkingBlock', 'DocumentBlock']) {
    assert.equal(removerBlocosDoClaude(`<${tag} id="9">Texto</${tag}>`), 'Texto', tag);
  }
  assert.equal(removerBlocosDoClaude('<Artifact id="1">Texto</Artifact>'), 'Texto');
  assert.equal(removerBlocosDoClaude('<antArtifact type="x">Texto</antArtifact>'), 'Texto');
  assert.equal(removerBlocosDoClaude('<WritingBlock id="1" />Texto'), 'Texto', 'tag que se fecha sozinha');
});

test('a forma antiga com ::: continua tratada', () => {
  const bruto = ':::writing{variant="document" id="31847" title="T"}\nMatéria.\n:::';
  assert.equal(removerBlocosDoClaude(bruto).trim(), 'Matéria.');
});

test('texto comum com < e > não é mexido', () => {
  // Não pode virar censura de sinal de menor em preço, placar ou comparação.
  for (const texto of [
    'Pesquisa aponta 3 < 5 pontos de diferença',
    'Preço caiu de 10<20 reais na semana',
    'Vereador diz que a <b>igreja</b> cresceu',
    'Fonte: <https://portal.com/noticia>',
    'Placar: Flamengo 2 > 1 Vasco',
  ]) {
    assert.equal(removerBlocosDoClaude(texto), texto, texto);
  }
});

test('entrada vazia ou nula não quebra', () => {
  assert.equal(removerBlocosDoClaude(''), '');
  assert.equal(removerBlocosDoClaude(null), '');
  assert.equal(removerBlocosDoClaude(undefined), '');
});

test('no streaming, meia tag não aparece para o editor', () => {
  const limpador = criarLimpadorDeStream();
  let visto = '';
  visto += limpador.empurrar('<Writing');
  assert.equal(visto, '', 'tag pela metade fica segurada');
  visto += limpador.empurrar('Block id="7" variant="document">Pastor');
  assert.equal(visto, 'Pastor', 'ao fechar a tag, só o texto sai');
  visto += limpador.empurrar(' é preso');
  assert.equal(visto, 'Pastor é preso');
});

test('no streaming, texto que só tem "<" segue saindo', () => {
  const limpador = criarLimpadorDeStream();
  let visto = '';
  visto += limpador.empurrar('Caiu de 10');
  visto += limpador.empurrar('<20 reais hoje');
  assert.equal(visto, 'Caiu de 10<20 reais hoje');
});

test('o modelo da matéria é a última trava do título', () => {
  // A limpeza certa é na resposta da IA, mas nenhum caminho de escrita pode
  // furar: foi assim que a tag chegou ao Facebook.
  const modelo = fs.readFileSync('src/models/AiMatters.js', 'utf8');
  assert.match(modelo, /function limparTitulo\(valor\)/);
  assert.match(modelo, /removerBlocosDoClaude/);
  assert.match(modelo, /if \(out\.titulo != null\) out\.titulo = limparTitulo\(out\.titulo\);/);
  assert.match(modelo, /if \(out\.titulo_ia != null\) out\.titulo_ia = limparTitulo\(out\.titulo_ia\);/);

  const AiMatters = require('../src/models/AiMatters');
  assert.equal(typeof AiMatters.create, 'function', 'o modelo tem de carregar sem ciclo de require');
});

test('existe como limpar o que já está gravado', () => {
  const script = fs.readFileSync('scripts/limpar-titulos-com-marcacao.js', 'utf8');
  // Mostrar por padrão e só gravar com --aplicar: é banco de produção.
  assert.match(script, /const APLICAR = process\.argv\.includes\('--aplicar'\)/);
  assert.match(script, /if \(!APLICAR\) \{/);
  assert.match(script, /Nada gravado\./);
  assert.match(script, /COLUNAS = \['titulo', 'titulo_ia', 'fonte_titulo'\]/);
});
