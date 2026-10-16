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

test('"não gere imagem" em qualquer pedido da conversa: nada de capa gerada por IA', () => {
  const fs = require('node:fs');
  const CHAT = fs.readFileSync('src/services/materiaChatService.js', 'utf8');
  const i = CHAT.indexOf('const proibiuGerarImagem =');
  assert.ok(i > 0);
  const re = require('../src/services/materiaChatService').PROIBE_GERAR_IMAGEM;
  for (const frase of [
    'Inclua uma foto real relacionada à notícia. a imagem da materia que quero, nao gere imagem',
    'não quero que você gere imagem',
    'não precisa gerar imagem',
  ]) assert.ok(re.test(frase), frase);
  for (const frase of ['quero a imagem para a materia', 'gere uma imagem bonita', 'outra']) {
    assert.ok(!re.test(frase), frase);
  }
  // Vale para a conversa toda (o pedido estava na 1ª mensagem; "outra" não repete).
  assert.match(CHAT.slice(i, i + 300), /anteriores\.filter\(\(m\) => m\.role === 'user'\)/);
  // E a geração por IA respeita a regra.
  assert.match(CHAT, /if \(chat\.modo === 'chatgpt' && !proibiuGerarImagem && !fontesFinais\.some/);
});

test('"quero a imagem": a foto volta junto da matéria anterior, não presa numa legenda', () => {
  const fs = require('node:fs');
  const CHAT = fs.readFileSync('src/services/materiaChatService.js', 'utf8');
  const i = CHAT.indexOf("if (capaDaConversa && String(respostaLivreFinal || '').trim().length < 600)");
  assert.ok(i > 0, 'resposta curta com foto reaproveita a matéria anterior');
  const trecho = CHAT.slice(i, i + 1200);
  assert.match(trecho, /respostaLivreFinal = String\(materiaAnterior\.content\)/);
  assert.match(trecho, /fontesFinais = \[\.\.\.fontesDaAnterior, capaDaConversa\]/);
});
