const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Banco falso montado ANTES de carregar o dotsService, para testar a trava do
 * ciclo sem MySQL. Guarda a condição do UPDATE para dar para conferir.
 */
const chamadas = [];
let linhasAfetadas = 1;

function builderFalso() {
  const estado = { condicoes: [], patch: null };
  const builder = {
    where(...args) {
      estado.condicoes.push(args);
      return builder;
    },
    andWhere(fn) {
      // A condição "livre OU trava velha" chega como função; roda contra um
      // sub-builder só para registrar o que ela pediu.
      const sub = {
        where(...a) {
          estado.condicoes.push(['or-where', ...a]);
          return sub;
        },
        orWhere(...a) {
          estado.condicoes.push(['or-where', ...a]);
          return sub;
        },
      };
      if (typeof fn === 'function') fn.call(sub);
      return builder;
    },
    update(patch) {
      estado.patch = patch;
      chamadas.push(estado);
      return Promise.resolve(linhasAfetadas);
    },
    first() {
      return Promise.resolve(null);
    },
  };
  return builder;
}

const dbFalso = () => builderFalso();
dbFalso.fn = { now: () => new Date() };
dbFalso.raw = (x) => x;
dbFalso.transaction = async (fn) => fn(dbFalso);

const caminhoDb = require.resolve('../src/config/db');
require.cache[caminhoDb] = { id: caminhoDb, filename: caminhoDb, loaded: true, exports: dbFalso };

const { reservarCiclo } = require('../src/services/dotsService');

test('a volta é recusada quando outra já está com o dot', async () => {
  chamadas.length = 0;
  // Nenhuma linha afetada = a condição não casou = alguém está trabalhando.
  linhasAfetadas = 0;
  assert.equal(await reservarCiclo(9), false, 'segunda volta tem de desistir');
});

test('a volta é aceita quando o dot está livre', async () => {
  chamadas.length = 0;
  linhasAfetadas = 1;
  assert.equal(await reservarCiclo(9), true);

  const { patch, condicoes } = chamadas[0];
  assert.equal(patch.trabalhando, true, 'tem de marcar o dot como ocupado');
  assert.ok(patch.atividade_em instanceof Date, 'a hora da trava é o que permite o resgate');

  // A trava precisa ser condicional: sem isso o UPDATE sempre casaria e
  // dois ciclos passariam juntos, que era o bug da matéria duplicada.
  const texto = JSON.stringify(condicoes);
  assert.match(texto, /trabalhando/, 'a condição precisa olhar `trabalhando`');
  assert.match(texto, /atividade_em/, 'e precisa resgatar trava abandonada');
});

test('a reserva é um único UPDATE condicional, não leitura e depois escrita', async () => {
  chamadas.length = 0;
  linhasAfetadas = 1;
  await reservarCiclo(9);
  assert.equal(chamadas.length, 1, 'ler e depois gravar abriria janela de corrida');
});

test('"Trabalhar agora" passa a respeitar a trava', () => {
  const fonte = fs.readFileSync(
    path.resolve(__dirname, '../src/services/dotsService.js'),
    'utf8'
  );
  // Antes: setImmediate(() => void rodarCiclo(dot)) sem checagem nenhuma.
  assert.match(fonte, /if \(!\(await reservarCiclo\(dot\.id\)\)\)/, 'o ciclo tem de reservar');
  assert.match(fonte, /dot\.trabalhando\s*\)\s*\{[\s\S]{0,120}já está trabalhando/, 'o botão tem de avisar');
  assert.match(fonte, /TRAVA_CICLO_MS/, 'trava abandonada precisa de resgate por tempo');
  // E a liberação não pode depender de o caminho felizar.
  assert.match(fonte, /\} finally \{[\s\S]{0,260}trabalhando: false/, 'finally garante a liberação');
});
