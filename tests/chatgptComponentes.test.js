const test = require('node:test');
const assert = require('node:assert/strict');
const { limparMarcacaoChatgpt, criarLimpadorDeStream } = require('../src/services/chatgptMarkup');
const { buscasDeImagemNoTexto } = require('../src/services/tokenFreeGatewayService');

// Caso Ella Langley: o ChatGPT escreveu componentes que a tela dele desenha.
// Aqui o <AsyncImage> ficou na 1ª linha e virou o TÍTULO (em negrito), e o
// <Cite …/> apareceu no meio do parágrafo.
const BRUTO = [
  '<AsyncImage query="Ella Langley performing live on stage microphone concert October 2026 photo" aspectRatio="16:9" width="100%" alt="A cantora Ella Langley durante apresentação musical"/>',
  '',
  '**Ella Langley surpreende público ao falar de Jesus após show ser cancelado por ameaça: “Não vou viver com medo”**',
  '',
  'O caso aconteceu depois que uma apresentação foi cancelada. A polícia não encontrou ameaça crível. <Cite refs={["turn464859search0"]}/>',
  '',
  '### Cantora interrompeu a agenda por segurança',
].join('\n');

test('componentes do ChatGPT saem; o título volta a ser a 1ª linha', () => {
  const limpo = limparMarcacaoChatgpt(BRUTO);
  assert.equal(
    limpo.split('\n')[0],
    '**Ella Langley surpreende público ao falar de Jesus após show ser cancelado por ameaça: “Não vou viver com medo”**'
  );
  assert.doesNotMatch(limpo, /AsyncImage|<Cite|turn464859/);
  assert.match(limpo, /A polícia não encontrou ameaça crível\./);
  assert.match(limpo, /### Cantora interrompeu a agenda por segurança/);
});

test('no streaming o componente não aparece nem pela metade', () => {
  const limpador = criarLimpadorDeStream();
  let tela = '';
  for (let i = 0; i < BRUTO.length; i += 17) {
    tela += limpador.empurrar(BRUTO.slice(i, i + 17));
    assert.doesNotMatch(tela, /<Async|<Cite|aspectRatio/, tela.slice(-80));
  }
  assert.match(tela, /Ella Langley surpreende público/);
});

test('link e cartão: fica o conteúdo, sai a marcação', () => {
  assert.equal(
    limparMarcacaoChatgpt('Leia <Link href="https://x.com/a">a reportagem</Link> completa.'),
    'Leia a reportagem completa.'
  );
  assert.equal(limparMarcacaoChatgpt('<box><title>Resumo</title><divider/>Texto</box>'), 'ResumoTexto');
});

test('texto normal e HTML comum não são mexidos', () => {
  for (const t of ['Matéria com <b>negrito</b>.', 'Nota 5 < 7 e 9 > 3.', 'Use <br> para quebrar.']) {
    assert.equal(limparMarcacaoChatgpt(t), t);
  }
});

test('a consulta do <AsyncImage> vira plano B para buscar a foto', () => {
  assert.deepEqual(buscasDeImagemNoTexto(BRUTO), [
    'Ella Langley performing live on stage microphone concert October 2026 photo',
  ]);
  assert.deepEqual(buscasDeImagemNoTexto('<AsyncImageGroup queries={["Sued Silva cantora", "Sued Silva Onimusic"]}/>'), [
    'Sued Silva cantora',
    'Sued Silva Onimusic',
  ]);
});

test('foto de images.openai.com (achada pelo ChatGPT na web) não é "gerada por IA"', () => {
  const fs = require('node:fs');
  const CHAT = fs.readFileSync('src/services/materiaChatService.js', 'utf8');
  const i = CHAT.indexOf('function imagemGeradaPeloChatgpt(url) {');
  assert.match(CHAT.slice(i, i + 400), /images\\\.openai\\\.com[\s\S]*return false/);
});
