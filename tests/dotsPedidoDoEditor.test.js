const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { filtrarPorPalavras, resumoDoPlano } = require('../src/services/dotsService');

const POSTS = [
  { id: 1, titulo: 'Flávio Bolsonaro cobra explicações do governo', resumo: '' },
  { id: 2, titulo: 'Lula anuncia novo programa social', resumo: '' },
  { id: 3, titulo: 'Cantora gospel lança álbum em Jerusalém', resumo: '' },
  { id: 4, titulo: 'Prefeito inaugura ponte', resumo: 'Com presença de lula na cerimônia' },
];

test('recorte por palavra-chave: só passa quem cita o que foi pedido', () => {
  // Era o pedido ignorado: "quero só matérias com Flávio Bolsonaro ou Lula".
  const escolhidos = filtrarPorPalavras(POSTS, ['Flávio Bolsonaro', 'Lula']).map((p) => p.id);
  assert.deepEqual(escolhidos, [1, 2, 4], 'o gospel fica de fora');
});

test('a comparação ignora acento e caixa', () => {
  assert.deepEqual(
    filtrarPorPalavras(POSTS, ['flavio bolsonaro']).map((p) => p.id),
    [1],
    '"flavio" sem acento tem de casar com "Flávio"'
  );
});

test('o resumo também é olhado, não só o título', () => {
  const escolhidos = filtrarPorPalavras([POSTS[3]], ['lula']).map((p) => p.id);
  assert.deepEqual(escolhidos, [4], 'a palavra estava no resumo');
});

test('sem palavras pedidas, tudo passa', () => {
  assert.equal(filtrarPorPalavras(POSTS, []).length, 4);
  assert.equal(filtrarPorPalavras(POSTS, null).length, 4);
  assert.equal(filtrarPorPalavras(POSTS, ['ab']).length, 4, 'termo curto demais é ignorado');
});

test('o resumo mostra o recorte e o estilo pedidos', () => {
  const plano = {
    acao: 'monitorar_e_escrever',
    palavras: ['Flávio Bolsonaro', 'Lula'],
    estilo: 'título mais polêmico',
    criterio: 'Fato novo com texto suficiente.',
  };
  const config = { destino: 'rascunho', limite_dia: 20, scan_minutos: 60, modo_imagem: 'original' };
  const texto = resumoDoPlano(plano, ['a'], config).join(' | ');

  assert.match(texto, /Só escreve se o post citar: Flávio Bolsonaro, Lula/);
  assert.match(texto, /Estilo pedido: título mais polêmico/);
});

test('o estilo pedido chega a quem escreve', () => {
  // Antes ficava guardado no plano e nunca influenciava a escrita.
  const dots = fs.readFileSync('src/services/dotsService.js', 'utf8');
  assert.match(dots, /instrucaoEditorial: parseJson\(dot\.plano, \{\}\)\.estilo/);

  const porChat = fs.readFileSync('src/services/materiaPorChat.js', 'utf8');
  assert.match(porChat, /instrucaoEditorial = null/, 'precisa aceitar');
  assert.match(porChat, /^\s+instrucaoEditorial,$/m, 'e repassar ao chat');

  const chat = fs.readFileSync('src/services/materiaChatService.js', 'utf8');
  assert.match(chat, /Instrução editorial do pedido: \$\{instrucaoEditorial\}/);
});

test('o pedido salvo pode ser editado sem recriar o dot', () => {
  const dots = fs.readFileSync('src/services/dotsService.js', 'utf8');
  assert.match(dots, /async function atualizar\(userId, dotId, \{ nome, provedor, objetivo \}\)/);
  // Reinterpreta e recadastra as páginas, sem perder ritmo nem histórico.
  assert.match(dots, /dados\.plano = JSON\.stringify\(\{ \.\.\.anterior, \.\.\.plano \}\)/);
  assert.match(dots, /cadastrarFontes\(dot, extrairUrls\(texto\)\)/);

  const rota = fs.readFileSync('src/routes/dots.js', 'utf8');
  assert.match(rota, /objetivo: req\.body\.objetivo/);
});

test('o cadastro de páginas é um só, usado na criação e na edição', () => {
  const dots = fs.readFileSync('src/services/dotsService.js', 'utf8');
  const ocorrencias = (dots.match(/async function cadastrarFontes/g) || []).length;
  assert.equal(ocorrencias, 1, 'duplicar essa lógica faria as duas divergirem');
  assert.match(dots, /const \{ fonteIds, problemas \} = await cadastrarFontes\(dot, urls\)/);
});
