const test = require('node:test');
const assert = require('node:assert/strict');
const child_process = require('node:child_process');
const axios = require('axios');

const limiter = require('../src/services/googleNewsLimiter');

/**
 * O problema original: cada 503 do RSS caía no fallback em Python, que abre um
 * processo e bate em news.google.com + www.google.com de novo. 48 consultas
 * viravam ~108 requisições e o 503 se alimentava sozinho.
 */
function instrumentar() {
  const contagem = { axios: 0, spawns: 0 };
  const axiosOriginal = axios.get;
  const spawnOriginal = child_process.spawn;

  axios.get = async (url) => {
    if (!String(url).includes('google.com')) return axiosOriginal(url);
    contagem.axios += 1;
    throw Object.assign(new Error('Request failed with status code 503'), {
      response: { status: 503 },
    });
  };
  child_process.spawn = (...args) => {
    contagem.spawns += 1;
    return spawnOriginal(...args);
  };

  return {
    contagem,
    restaurar() {
      axios.get = axiosOriginal;
      child_process.spawn = spawnOriginal;
    },
  };
}

test('503 no RSS não dispara o fallback em Python (fim da cascata)', async () => {
  limiter.reiniciar();
  const espiao = instrumentar();
  try {
    const nr = require('../src/services/newsResearch');
    const itens = await nr.buscarGoogleNewsRss(`cascata-${Date.now()}`, { when: '1d' });

    assert.deepEqual(itens, [], 'deve devolver vazio em vez de insistir');
    assert.equal(espiao.contagem.axios, 1, 'uma tentativa, não várias');
    assert.equal(
      espiao.contagem.spawns,
      0,
      'nenhum processo Python deve abrir: era ele que batia no Google de novo'
    );
    assert.equal(limiter.emPausa(), true, 'o 503 deve ter aberto a pausa');
  } finally {
    espiao.restaurar();
    limiter.reiniciar();
  }
});

test('durante a pausa a rajada inteira não gera nenhuma requisição', async () => {
  limiter.reiniciar();
  const espiao = instrumentar();
  try {
    const nr = require('../src/services/newsResearch');

    // Primeira consulta abre a pausa (1 requisição).
    await nr.buscarGoogleNewsRss(`pausa-${Date.now()}`, { when: '1d' });
    assert.equal(limiter.emPausa(), true);
    const aposPrimeira = espiao.contagem.axios;

    // As outras 47 da rajada, todas com termos diferentes (sem ajuda do cache).
    const marca = Date.now();
    const resto = await Promise.all(
      Array.from({ length: 47 }, (_, i) =>
        nr.buscarGoogleNewsRss(`pausa-${marca}-${i}`, { when: '1d' })
      )
    );

    assert.equal(espiao.contagem.axios, aposPrimeira, 'nada deve sair durante a pausa');
    assert.equal(espiao.contagem.spawns, 0);
    assert.equal(
      resto.every((r) => Array.isArray(r) && r.length === 0),
      true,
      'cada consulta devolve lista vazia, sem estourar erro para a tela'
    );
  } finally {
    espiao.restaurar();
    limiter.reiniciar();
  }
});

test('em alta: o mesmo termo repetido só consulta o Google uma vez (cache)', async () => {
  limiter.reiniciar();
  const espiao = instrumentar();
  try {
    const nr = require('../src/services/newsResearch');
    const termo = `cache-alta-${Date.now()}`;

    await nr.buscarGoogleNewsEmAlta(termo);
    const depoisDaPrimeira = espiao.contagem.axios;
    assert.equal(depoisDaPrimeira, 1);

    // O radar pede o mesmo termo por vários coletores e a cada "Atualizar".
    await nr.buscarGoogleNewsEmAlta(termo);
    await nr.buscarGoogleNewsEmAlta(termo);
    assert.equal(espiao.contagem.axios, depoisDaPrimeira, 'repetições saem do cache');
  } finally {
    espiao.restaurar();
    limiter.reiniciar();
  }
});
