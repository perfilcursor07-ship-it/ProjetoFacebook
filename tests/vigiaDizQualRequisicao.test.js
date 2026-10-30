const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { medirRequisicao, requisicoesEmAndamento } = require('../src/services/vigiaLentidao');

// Por que este arquivo existe:
//
//   [travado] Node parado por 65024ms — rodando: nenhuma tarefa de fundo
//
// Essa linha dizia o que NÃO era e nada sobre o que era. Sobrava adivinhar — e
// eu adivinhei errado. Quem segura o processo por um minuto é quase sempre uma
// requisição; o log precisa dizer qual.

function parDeTeste(metodo, url) {
  const req = { method: metodo, originalUrl: url };
  const res = new EventEmitter();
  res.statusCode = 200;
  return { req, res };
}

test('requisição aberta aparece na lista', () => {
  const { req, res } = parDeTeste('POST', '/api/materias-ia/chat/conversas/nova/mensagens?x=1');
  medirRequisicao(req, res, () => {});
  const abertas = requisicoesEmAndamento();
  assert.equal(abertas.length, 1);
  // A query string sai: ela carrega dados e não ajuda a identificar a rota.
  assert.match(abertas[0], /^POST \/api\/materias-ia\/chat\/conversas\/nova\/mensagens \(há \d+s\)$/);
  res.emit('finish');
});

test('requisição terminada sai da lista', () => {
  const { req, res } = parDeTeste('GET', '/dots');
  medirRequisicao(req, res, () => {});
  assert.equal(requisicoesEmAndamento().length, 1);
  res.emit('finish');
  assert.equal(requisicoesEmAndamento().length, 0);
});

test('cliente que desconecta no meio não fica preso para sempre', () => {
  // `finish` não dispara quando a conexão cai; sem tratar `close` a
  // requisição poluiria todo log seguinte.
  const { req, res } = parDeTeste('GET', '/minhas-materias');
  medirRequisicao(req, res, () => {});
  assert.equal(requisicoesEmAndamento().length, 1);
  res.emit('close');
  assert.equal(requisicoesEmAndamento().length, 0);
});

test('a mais antiga vem primeiro', () => {
  // É ela a suspeita: quem está aberta há mais tempo quando o Node travou.
  const agora = Date.now();
  const velha = parDeTeste('POST', '/velha');
  const nova = parDeTeste('GET', '/nova');
  medirRequisicao(velha.req, velha.res, () => {});
  medirRequisicao(nova.req, nova.res, () => {});
  const abertas = requisicoesEmAndamento(agora + 90_000);
  assert.match(abertas[0], /\/velha/);
  assert.match(abertas[1], /\/nova/);
  assert.match(abertas[0], /\(há 90s\)/);
  velha.res.emit('finish');
  nova.res.emit('finish');
});

test('o log do travamento passou a citar as requisições', () => {
  const fonte = require('node:fs').readFileSync('src/services/vigiaLentidao.js', 'utf8');
  assert.match(fonte, /requisições abertas/);
  assert.match(fonte, /nenhuma requisição aberta/, 'o caso vazio também precisa ser dito');
  // Cinco bastam para identificar a culpada e não viram parede de texto.
  assert.match(fonte, /abertas\.slice\(0, 5\)/);
});
