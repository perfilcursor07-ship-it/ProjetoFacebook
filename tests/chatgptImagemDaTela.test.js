const test = require('node:test');
const assert = require('node:assert/strict');

// A imagem que o ChatGPT mostra na conversa chega do gateway já baixada
// (`data:`), com a origem marcada. Ela tem de virar a capa — e o crédito
// precisa dizer de onde veio: foto achada na web não é "gerada por IA".

const artePath = require.resolve('../src/services/matterArtworkService');
const bancoPath = require.resolve('../src/services/bancoImagensService');
const guardadas = [];
require.cache[artePath] = {
  id: artePath,
  filename: artePath,
  loaded: true,
  exports: {
    storeMatterSourceImage: async ({ buffer }) => {
      guardadas.push(buffer);
      return { publicUrl: `/media/fontes/capa_${guardadas.length}.jpg` };
    },
  },
};
require.cache[bancoPath] = {
  id: bancoPath,
  filename: bancoPath,
  loaded: true,
  exports: { registrarEmSegundoPlano: () => {} },
};
const { capaGeradaNaConversa } = require('../src/services/materiaChatService');

const bytes = Buffer.alloc(4096, 9);
const dado = (origem) => `data:image/jpeg;${origem ? `origem=${origem};` : ''}base64,${bytes.toString('base64')}`;

test('foto que o ChatGPT achou na web: vira capa com crédito de reprodução', async () => {
  const passos = [];
  const capa = await capaGeradaNaConversa({
    userId: 1,
    chatId: 2,
    urls: [dado('web')],
    registrarPasso: (p) => passos.push(p),
  });
  assert.equal(capa.imagem, `/media/fontes/capa_${guardadas.length}.jpg`);
  assert.equal(capa.capaChatgpt, 'web');
  assert.equal(capa.creditoImagem, 'Reprodução/Internet');
  assert.ok(guardadas[guardadas.length - 1].equals(bytes), 'o arquivo salvo é a própria imagem da conversa');
});

test('imagem gerada pelo ChatGPT: crédito de IA', async () => {
  const capa = await capaGeradaNaConversa({ userId: 1, chatId: 2, urls: [dado('chatgpt')] });
  assert.equal(capa.capaChatgpt, 'gerada');
  assert.equal(capa.creditoImagem, 'Imagem gerada por IA');
  // Sem marca de origem (versão anterior do gateway): continua como antes.
  const antiga = await capaGeradaNaConversa({ userId: 1, chatId: 2, urls: [dado(null)] });
  assert.equal(antiga.creditoImagem, 'Imagem gerada por IA');
});
