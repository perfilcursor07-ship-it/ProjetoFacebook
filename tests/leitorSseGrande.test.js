const test = require('node:test');
const assert = require('node:assert/strict');

const { criarLeitorSse } = require('../src/services/tokenFreeGatewayService');

// Por que este arquivo existe:
//
//   [travado] Node parado por 64313ms — rodando: nenhuma tarefa de fundo
//   [lento] POST /api/materias-ia/chat/conversas/nova/mensagens 107687ms
//
// A imagem que o ChatGPT mostra na conversa viaja no stream como `data:` em
// base64: uma ÚNICA linha SSE de dezenas de MB. O leitor antigo dava
// `buffer.split()` a cada pedaço que chegava, varrendo o buffer inteiro de
// novo — custo quadrático. Com o Node parado por um minuto, nenhuma página
// abria, para ninguém.

/** Quebra um texto em pedaços do tamanho que a rede entrega. */
function emPedacos(texto, tamanho = 64 * 1024) {
  const saida = [];
  for (let i = 0; i < texto.length; i += tamanho) saida.push(Buffer.from(texto.slice(i, i + tamanho)));
  return saida;
}

test('linha gigante não vira custo quadrático', () => {
  // 48 MB numa linha só: a ordem de grandeza de 3 fotos em base64.
  const gigante = 'data: ' + 'A'.repeat(48 * 1024 * 1024) + '\n';
  const linhas = [];
  const leitor = criarLeitorSse((l) => linhas.push(l.length));

  const inicio = Date.now();
  for (const pedaco of emPedacos(gigante)) leitor.escrever(pedaco);
  leitor.fim();
  const ms = Date.now() - inicio;

  assert.equal(linhas.length, 1);
  assert.equal(linhas[0], gigante.length - 1);
  // O jeito antigo levava dezenas de segundos aqui. A folga é larga de
  // propósito: o que importa é não ser quadrático, não cravar um número.
  assert.ok(ms < 5_000, `levou ${ms}ms — custo quadrático voltou`);
});

test('entrega uma linha por vez, na ordem', () => {
  const linhas = [];
  const leitor = criarLeitorSse((l) => linhas.push(l));
  leitor.escrever(Buffer.from('data: um\ndata: do'));
  leitor.escrever(Buffer.from('is\ndata: tres\n'));
  leitor.fim();
  assert.deepEqual(linhas, ['data: um', 'data: dois', 'data: tres']);
});

test('acento partido entre dois pedaços não vira lixo', () => {
  // "ação" em UTF-8 tem bytes de 2 posições; a rede corta onde quiser.
  const bytes = Buffer.from('data: ação cristã\n', 'utf8');
  const linhas = [];
  const leitor = criarLeitorSse((l) => linhas.push(l));
  for (let i = 0; i < bytes.length; i += 3) leitor.escrever(bytes.subarray(i, i + 3));
  leitor.fim();
  assert.deepEqual(linhas, ['data: ação cristã']);
});

test('linha pendurada no fim ainda é entregue', () => {
  // Conexão cortada antes da quebra final.
  const linhas = [];
  const leitor = criarLeitorSse((l) => linhas.push(l));
  leitor.escrever(Buffer.from('data: inteira\ndata: pendurada'));
  leitor.fim();
  assert.deepEqual(linhas, ['data: inteira', 'data: pendurada']);
});

test('CRLF não deixa sobra na linha', () => {
  // O \r fica no fim; quem consome dá trim(). Garante que a quebra é pelo \n.
  const linhas = [];
  const leitor = criarLeitorSse((l) => linhas.push(l.trim()));
  leitor.escrever(Buffer.from('data: um\r\ndata: dois\r\n'));
  leitor.fim();
  assert.deepEqual(linhas, ['data: um', 'data: dois']);
});

test('linha vazia (separador de evento SSE) não quebra nada', () => {
  const linhas = [];
  const leitor = criarLeitorSse((l) => linhas.push(l));
  leitor.escrever(Buffer.from('data: um\n\ndata: dois\n\n'));
  leitor.fim();
  assert.deepEqual(linhas, ['data: um', '', 'data: dois', '']);
});
