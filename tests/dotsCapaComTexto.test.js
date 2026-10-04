const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * Troca um módulo do projeto por um dublê antes de o dotsService carregá-lo.
 * Sem isto o teste baixaria imagem de verdade e chamaria o ChatGPT.
 */
function dublar(relativo, exportado) {
  const arquivo = require.resolve(path.join('..', relativo));
  require.cache[arquivo] = { id: arquivo, filename: arquivo, loaded: true, exports: exportado };
}

const estado = { matter: null, ocr: null, baixou: [], gerou: 0, logs: [] };

// db: só o registrarLog usa aqui.
dublar('src/config/db', () => ({
  insert: async (linha) => {
    estado.logs.push(linha);
  },
}));
dublar('src/models/AiMatters', { findById: async () => estado.matter });
dublar('src/services/editorialCardService', {
  fetchImage: async (url) => {
    estado.baixou.push(url);
    if (!url) throw new Error('sem url');
    return Buffer.from('img');
  },
});
dublar('src/services/imageOcrService', {
  analisarTextoDaImagem: async () => {
    if (estado.ocr instanceof Error) throw estado.ocr;
    return estado.ocr;
  },
});
dublar('src/services/materiaPorChat', {
  aplicarCapaChatgpt: async () => {
    estado.gerou += 1;
  },
});

const { resolverCapa, fotoParaChecar } = require('../src/services/dotsService');

const DOT = { id: 1, user_id: 7, modo_imagem: 'ia_com_texto' };
// Caso real: os raspadores do Facebook gravam o post da biblioteca sem thumbnail.
const POST_SEM_THUMB = { id: 9, url: 'https://www.facebook.com/p/1', thumbnail: null };
const FOTO = 'https://scontent.fbcdn.net/v/foto.jpg';

function zerar({ matter = { imagem_fonte_url: FOTO }, ocr = { temTexto: false, palavras: 0 } } = {}) {
  Object.assign(estado, { matter, ocr, baixou: [], gerou: 0, logs: [] });
}

test('foto sem texto: mantém a original mesmo com o post da biblioteca sem thumbnail', async () => {
  zerar();
  const capa = await resolverCapa(DOT, POST_SEM_THUMB, 55);
  assert.equal(capa, 'original');
  assert.equal(estado.gerou, 0, 'não pode gerar imagem de IA');
  assert.deepEqual(estado.baixou, [FOTO], 'o OCR olha a foto que a matéria usa');
});

test('foto com texto embutido: gera com IA', async () => {
  zerar({ ocr: { temTexto: true, palavras: 14 } });
  assert.equal(await resolverCapa(DOT, POST_SEM_THUMB, 55), 'ia');
  assert.equal(estado.gerou, 1);
});

test('OCR falhando não vira imagem de IA: fica a foto original', async () => {
  zerar({ ocr: new Error('worker caiu') });
  assert.equal(await resolverCapa(DOT, POST_SEM_THUMB, 55), 'original');
  assert.equal(estado.gerou, 0);
  assert.match(estado.logs.at(-1).detalhe, /mantive a foto original/);
});

test('matéria sem foto nenhuma: a ilustração de IA é a única capa', async () => {
  zerar({ matter: { imagem_fonte_url: null } });
  assert.equal(await resolverCapa(DOT, POST_SEM_THUMB, 55), 'ia');
  assert.deepEqual(estado.baixou, [], 'não tenta baixar o nada');
});

test('modos original e sem_imagem nunca geram', async () => {
  zerar({ ocr: { temTexto: true, palavras: 30 } });
  assert.equal(await resolverCapa({ ...DOT, modo_imagem: 'original' }, POST_SEM_THUMB, 55), 'original');
  assert.equal(await resolverCapa({ ...DOT, modo_imagem: 'sem_imagem' }, POST_SEM_THUMB, 55), 'sem_imagem');
  assert.equal(estado.gerou, 0);
});

test('fotoParaChecar prefere a foto da matéria e ignora a arte composta', () => {
  assert.equal(fotoParaChecar({ imagem_fonte_url: FOTO }, { thumbnail: 'https://x/t.jpg' }), FOTO);
  assert.equal(
    fotoParaChecar({ imagem_fonte_url: '/media/artes/user_7/a.jpg' }, { thumbnail: 'https://x/t.jpg' }),
    'https://x/t.jpg'
  );
  assert.equal(fotoParaChecar(null, { thumbnail: null }), null);
  assert.equal(fotoParaChecar({ imagem_fonte_url: '/media/fontes/user_7/f.jpg' }, null), '/media/fontes/user_7/f.jpg');
});
