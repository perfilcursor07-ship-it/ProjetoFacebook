const test = require('node:test');
const assert = require('node:assert/strict');

/** Banco falso: `registrarLog` grava, e nada mais toca MySQL neste caminho. */
function builder() {
  const b = {
    where: () => b,
    andWhere: () => b,
    select: () => b,
    first: () => Promise.resolve(null),
    update: () => Promise.resolve(1),
    insert: () => Promise.resolve([1]),
    limit: () => Promise.resolve([]),
  };
  return b;
}
const dbFalso = () => builder();
dbFalso.fn = { now: () => new Date() };

const caminhoDb = require.resolve('../src/config/db');
require.cache[caminhoDb] = { id: caminhoDb, filename: caminhoDb, loaded: true, exports: dbFalso };

/** Matéria devolvida pelo modelo; o teste troca entre os casos. */
let materiaAtual = null;
const caminhoMatters = require.resolve('../src/models/AiMatters');
require.cache[caminhoMatters] = {
  id: caminhoMatters,
  filename: caminhoMatters,
  loaded: true,
  exports: { findById: async () => materiaAtual },
};

/** Registra se a geração de imagem foi chamada e com quais opções. */
let geracoes = [];
const caminhoPorChat = require.resolve('../src/services/materiaPorChat');
require.cache[caminhoPorChat] = {
  id: caminhoPorChat,
  filename: caminhoPorChat,
  loaded: true,
  exports: {
    aplicarCapaChatgpt: async (opcoes) => {
      geracoes.push(opcoes);
    },
  },
};

const { fotoParaChecar, resolverCapa } = require('../src/services/dotsService');

const DOT = { id: 1, user_id: 7, modo_imagem: 'original' };
const POST = { url: 'https://portal.com/materia', thumbnail: null };

test('fotoParaChecar prefere a foto da matéria e ignora a arte composta', () => {
  assert.equal(
    fotoParaChecar({ imagem_fonte_url: 'https://cdn.com/foto.jpg' }, {}),
    'https://cdn.com/foto.jpg'
  );
  // /media/artes/ é a arte com o título por cima, não a foto original.
  assert.equal(
    fotoParaChecar({ imagem_fonte_url: 'https://site.com/media/artes/x.jpg' }, { thumbnail: 'https://cdn.com/t.jpg' }),
    'https://cdn.com/t.jpg'
  );
  assert.equal(fotoParaChecar(null, {}), null);
  assert.equal(fotoParaChecar({}, { thumbnail: 'nao-e-url' }), null);
});

test('modo original SEM foto gera ilustração em vez de sair sem capa', async () => {
  // Link de site bloqueado para leitura direta cai muito aqui: a matéria ia ao
  // ar sem imagem nenhuma, inútil no feed.
  geracoes = [];
  materiaAtual = { id: 9, imagem_fonte_url: null, imagem_url: null };

  const capa = await resolverCapa(DOT, POST, 9);
  assert.equal(capa, 'ia', 'tinha de gerar');
  assert.equal(geracoes.length, 1);
  assert.equal(geracoes[0].permitirSimbolica, true, 'sem foto de referência, ilustração simbólica');
});

test('modo original COM foto não gasta geração à toa', async () => {
  geracoes = [];
  materiaAtual = { id: 9, imagem_fonte_url: 'https://cdn.com/foto-real.jpg' };

  const capa = await resolverCapa(DOT, POST, 9);
  assert.equal(capa, 'original');
  assert.equal(geracoes.length, 0, 'a foto da fonte serve: não chama a IA');
});

test('"sem imagem" continua sendo respeitado', async () => {
  geracoes = [];
  materiaAtual = { id: 9, imagem_fonte_url: null };

  const capa = await resolverCapa({ ...DOT, modo_imagem: 'sem_imagem' }, POST, 9);
  assert.equal(capa, 'sem_imagem');
  assert.equal(geracoes.length, 0, 'escolha explícita do editor, não se contraria');
});

test('a capa de artigo tenta o Chrome quando o acesso direto é bloqueado', () => {
  const fonte = require('node:fs').readFileSync('src/services/articleSource.js', 'utf8');
  // O texto já era lido pelo Chrome; só a imagem usava a busca fraca e levava 403.
  assert.match(fonte, /capaViaChrome/, 'precisa existir o resgate');
  assert.match(fonte, /\[401, 403, 405, 406, 429\]\.includes\(status\)/, 'nos status de bloqueio');
  assert.match(fonte, /capa recuperada pelo Chrome/, 'e tem de aparecer no log');
});
