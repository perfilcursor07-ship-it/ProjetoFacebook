const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  HORAS_FRESCAS,
  postEhRecente,
  limiteDeFrescor,
} = require('../src/services/dotsService');

const DOTS = fs.readFileSync('src/services/dotsService.js', 'utf8');
const TELA = fs.readFileSync('public/js/dots.js', 'utf8');

const AGORA = new Date('2026-10-12T15:00:00Z').getTime();
const hAtras = (n) => new Date(AGORA - n * 3_600_000).toISOString();

test('a janela padrão é de 48 horas', () => {
  assert.equal(HORAS_FRESCAS, 48);
  assert.match(DOTS, /Number\(process\.env\.DOTS_HORAS_FRESCAS\) \|\| 48/, 'ajustável sem mexer no código');
  // Contido: 0 pararia o dot e 1 ano não filtraria nada.
  assert.match(DOTS, /Math\.min\(720, Math\.max\(1,/);
});

test('notícia de hoje passa; de mais de 48h não', () => {
  assert.equal(postEhRecente({ publicado_em: hAtras(2) }, AGORA), true);
  assert.equal(postEhRecente({ publicado_em: hAtras(47) }, AGORA), true);
  assert.equal(postEhRecente({ publicado_em: hAtras(49) }, AGORA), false);
  // Os posts que o painel mostrava como "sai na próxima volta": 5 e 6 dias.
  assert.equal(postEhRecente({ publicado_em: hAtras(120) }, AGORA), false);
  assert.equal(postEhRecente({ publicado_em: hAtras(144) }, AGORA), false);
});

test('sem data de publicação, vale a data da leitura', () => {
  // Muita página de rede social não informa data. Barrar tudo sem data
  // esvaziaria a fila dessas fontes.
  assert.equal(postEhRecente({ publicado_em: null, created_at: hAtras(10) }, AGORA), true);
  assert.equal(postEhRecente({ publicado_em: null, created_at: hAtras(60) }, AGORA), false);
});

test('post sem data nenhuma não é descartado por engano', () => {
  assert.equal(postEhRecente({}, AGORA), true);
  assert.equal(postEhRecente({ publicado_em: 'nao-e-data' }, AGORA), true);
  assert.equal(postEhRecente(null, AGORA), true);
});

test('o limite é uma data, pronta para o SQL', () => {
  const limite = limiteDeFrescor(AGORA);
  assert.ok(limite instanceof Date);
  assert.equal(AGORA - limite.getTime(), HORAS_FRESCAS * 3_600_000);
});

test('a volta do dot não busca post velho no banco', () => {
  const trecho = DOTS.slice(DOTS.indexOf('async function candidatosDoDot'));
  assert.match(
    trecho.slice(0, 2500),
    /whereRaw\('COALESCE\(p\.publicado_em, p\.created_at\) >= \?', \[limiteDeFrescor\(\)\]\)/,
    'o corte tem de ser no SQL, não só na memória'
  );
  // O critério de "melhor post" dentro da janela não muda.
  assert.match(
    trecho.slice(0, 2500),
    /COALESCE\(p\.viral_score, 0\) DESC, COALESCE\(p\.publicado_em, p\.created_at\) DESC/
  );
});

test('fila cheia só de post velho explica no log', () => {
  // Era a confusão: "26 posts esperando" e nenhuma matéria saindo.
  const trecho = DOTS.slice(DOTS.indexOf('async function candidatosDoDot'));
  assert.match(trecho.slice(0, 3500), /if \(!uteis\.length\) \{/);
  assert.match(trecho.slice(0, 3500), /têm mais de \$\{HORAS_FRESCAS\}h — notícia velha não vira matéria/);
  assert.match(
    trecho.slice(0, 3500),
    /whereRaw\('COALESCE\(publicado_em, created_at\) < \?'/,
    'a contagem tem de usar o mesmo critério'
  );
});

test('o painel para de prometer "sai na próxima volta" para notícia velha', () => {
  assert.match(DOTS, /else if \(!postEhRecente\(p\)\) situacao = 'velho';/);
  // E a mesma janela sai da conta de "prontos".
  const elegiveis = DOTS.slice(DOTS.indexOf('const elegiveis = postsLidos.filter'));
  assert.match(elegiveis.slice(0, 500), /postEhRecente\(p\)/);
  assert.match(DOTS, /velhos: posts\.filter\(\(p\) => p\.situacao === 'velho'\)\.length,/);
  // A tela precisa da janela para o rótulo não mentir um número fixo.
  assert.match(DOTS, /horas_frescas: HORAS_FRESCAS,/);
});

test('a tela mostra "Notícia antiga" e deixa o editor escrever na mão', () => {
  assert.match(TELA, /velho: \{ icone: '🗓️', texto: 'Notícia antiga'/);
  assert.match(TELA, /pode: true \},\s*$/m);
  assert.match(TELA, /mais de \$\{janelaFrescor\}h, o dot não pega sozinho/);
  assert.match(TELA, /if \(Number\(dados\?\.horas_frescas\) > 0\) janelaFrescor = Number\(dados\.horas_frescas\)/);
  assert.match(TELA, /\{ id: 'velho', texto: 'Antigas'/, 'filtro para ver só as antigas');
});

test('escrever na mão continua possível: a trava é do automático', () => {
  // O editor clicando em "Escrever agora" é decisão dele; o que o dot não faz
  // é pegar notícia velha sozinho.
  const trecho = DOTS.slice(DOTS.indexOf('async function escreverPostAgora'));
  assert.doesNotMatch(
    trecho.slice(0, 1800),
    /postEhRecente|limiteDeFrescor/,
    'o caminho manual não leva a janela'
  );
});
