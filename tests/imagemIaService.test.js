const test = require('node:test');
const assert = require('node:assert/strict');

const iaModeloTarefa = require('../src/services/iaModeloTarefaService');
const chatgpt = require('../src/services/chatgptImageService');
const web = require('../src/services/imagemWebService');
const imagemIa = require('../src/services/imagemIaService');

function comEscolha(valor, fn) {
  const original = iaModeloTarefa.todos;
  iaModeloTarefa.todos = async () => ({ piloto: null, titulos: null, imagem: valor });
  return Promise.resolve(fn()).finally(() => {
    iaModeloTarefa.todos = original;
  });
}

test('sem escolha em /claude, a imagem continua no ChatGPT', () =>
  comEscolha(null, async () => {
    const original = chatgpt.gerarImagem;
    chatgpt.gerarImagem = async () => ({ buffer: Buffer.from('x'), model: 'gpt' });
    try {
      const r = await imagemIa.gerarImagem({ recoveryKey: '1:1' });
      assert.equal(r.gerador, 'chatgpt');
      assert.deepEqual(await imagemIa.geradorAtual(), { id: 'chatgpt', nome: 'ChatGPT' });
    } finally {
      chatgpt.gerarImagem = original;
    }
  }));

test('Grok escolhido em /claude gera pelo Grok e a recuperação volta ao mesmo site', () =>
  comEscolha('grok', async () => {
    const chamadas = [];
    const [gerar, recuperar] = [web.gerarImagem, web.recuperarImagem];
    web.gerarImagem = async (id, args) => {
      chamadas.push(['gerar', id, args.recoveryKey]);
      return { buffer: Buffer.from('x'), model: 'Grok' };
    };
    web.recuperarImagem = async (id) => {
      chamadas.push(['recuperar', id]);
      return { buffer: Buffer.from('y'), model: id };
    };
    try {
      const r = await imagemIa.gerarImagem({ recoveryKey: '3:42', modo: 'referencia' });
      assert.equal(r.gerador, 'grok');
      // O admin troca para o Gemini depois: "Pegar imagem nova" ainda busca no Grok.
      await comEscolha('gemini', async () => {
        const rec = await imagemIa.recuperarImagem({ recoveryKey: '3:42' });
        assert.equal(rec.gerador, 'grok');
      });
      assert.deepEqual(chamadas, [['gerar', 'grok', '3:42'], ['recuperar', 'grok']]);
    } finally {
      web.gerarImagem = gerar;
      web.recuperarImagem = recuperar;
    }
  }));

test('valor desconhecido salvo no banco volta para o ChatGPT', () =>
  comEscolha('midjourney', async () => {
    assert.equal((await imagemIa.geradorAtual()).id, 'chatgpt');
  }));

test('/claude só aceita Grok ou Gemini para a tarefa de imagem', async () => {
  // Validação acontece antes de tocar no banco.
  await assert.rejects(
    iaModeloTarefa.salvar({ imagem: 'gpt-5.6' }, { permitidos: ['gpt-5.6'], permitidosPorTarefa: { imagem: ['grok', 'gemini'] } }),
    (err) => err.status === 400
  );
  await assert.rejects(
    iaModeloTarefa.salvar({ piloto: 'grok' }, { permitidos: ['gpt-5.6'], permitidosPorTarefa: { imagem: ['grok', 'gemini'] } }),
    (err) => err.status === 400
  );
});
