const test = require('node:test');
const assert = require('node:assert/strict');

const { escreverPeloChat } = require('../src/services/materiaPorChat');

/**
 * Chat de mentira que registra o que recebeu. O `materiaPorChat` aceita o
 * chatService por parâmetro justamente para isto.
 */
function chatFalso({ ehMateria = true } = {}) {
  const chamadas = { responder: [], excluidas: [] };
  return {
    chamadas,
    chatService: {
      async responder(args) {
        chamadas.responder.push(args);
        args.onEvent?.({ tipo: 'conversa', chat: { id: 77 } });
        return { chatId: 77, mensagem: { id: 5, ehMateria, conteudo: 'texto' } };
      },
      async salvarMateriaDoChat() {
        return { matterId: 123 };
      },
      async excluirConversa({ chatId }) {
        chamadas.excluidas.push(chatId);
      },
    },
    comModelo: (_modelo, fn) => fn(),
  };
}

test('a origem informada chega no responder', async () => {
  for (const origem of ['dots', 'furos', 'feed']) {
    const falso = chatFalso();
    await escreverPeloChat(falso, {
      userId: 1,
      url: 'https://www.facebook.com/reel/123',
      origem,
    });
    assert.equal(falso.chamadas.responder[0].origem, origem);
  }
});

test('sem informar, a conversa nasce como do editor', async () => {
  const falso = chatFalso();
  await escreverPeloChat(falso, { userId: 1, url: 'https://www.facebook.com/reel/123' });
  assert.equal(
    falso.chamadas.responder[0].origem,
    'chat',
    'o padrão não pode marcar como automática uma conversa do editor'
  );
});

test('conversa que não virou matéria continua sendo descartada', async () => {
  // A marca de origem não deve manter no histórico o que antes era apagado.
  const falso = chatFalso({ ehMateria: false });
  await assert.rejects(
    escreverPeloChat(falso, { userId: 1, url: 'https://x.com/a', origem: 'dots' }),
    (err) => err.code === 'SEM_MATERIA'
  );
  assert.deepEqual(falso.chamadas.excluidas, [77], 'a conversa inútil tem de sair do histórico');
});

test('as quatro origens conhecidas estão declaradas no serviço do chat', () => {
  const { ORIGENS } = require('../src/services/materiaChatService');
  assert.deepEqual([...ORIGENS].sort(), ['chat', 'dots', 'feed', 'furos']);
});

test('os quatro serviços automáticos marcam a própria origem', () => {
  const fs = require('node:fs');
  const esperado = {
    'src/services/dotsService.js': "origem: 'dots'",
    'src/services/furosService.js': "origem: 'furos'",
    'src/services/furosAutopilotService.js': "origem: 'furos'",
    'src/services/feedSugeridoService.js': "origem: 'feed'",
  };
  // Serviço novo que esquecer a marca volta a sujar a lista do editor.
  for (const [arquivo, marca] of Object.entries(esperado)) {
    const fonte = fs.readFileSync(arquivo, 'utf8');
    assert.ok(fonte.includes(marca), `${arquivo} não marca ${marca}`);
  }
});

test('a lista da sidebar seleciona a coluna origem', () => {
  // Mesmo erro que escondeu os módulos de permissão: select explícito sem a
  // coluna nova faz a tela achar que tudo é 'chat'.
  const fonte = require('node:fs').readFileSync('src/models/AiChats.js', 'utf8');
  assert.match(fonte, /'c\.origem'/);
});
