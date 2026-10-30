const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SCRIPT = fs.readFileSync('scripts/install-token-free-gateway-overrides.js', 'utf8');
const ALVO = '.tools/token-free-gateway/src/providers/deepseek/client.ts';

// Por que este arquivo existe — o log do gateway:
//
//   [DeepSeekWebClient] Creating PoW challenge for /api/v0/chat/completion...
//   [chat-completions] non-streaming: PoW challenge missing in response
//
// O pedido do desafio anti-robô volta 200, mas o desafio não está em nenhum
// dos três caminhos que o gateway conhece. Com a sessão logada no VNC e tudo
// certo do lado do servidor, toda matéria pedida à DeepSeek falhava.

test('o desafio é procurado pelo formato, não por um caminho fixo', () => {
  assert.match(SCRIPT, /marca: 'viralizeai-deepseek'/);
  // algorithm + salt + challenge é o que define um desafio; onde ele está na
  // resposta é detalhe que eles já mudaram uma vez e podem mudar de novo.
  assert.ok(SCRIPT.includes('typeof o.algorithm === "string"'));
  assert.ok(SCRIPT.includes('typeof o.salt === "string"'));
  assert.ok(SCRIPT.includes('typeof o.challenge === "string"'));
});

test('os três caminhos antigos continuam sendo tentados primeiro', () => {
  // Enquanto funcionarem, são mais baratos que varrer a resposta.
  assert.ok(SCRIPT.includes('data.data?.biz_data?.challenge'));
  assert.ok(SCRIPT.includes('procurarDesafio(data)'));
  const i = SCRIPT.indexOf('data.data?.biz_data?.challenge ||');
  const j = SCRIPT.indexOf('procurarDesafio(data)', i);
  assert.ok(i > 0 && j > i, 'a varredura tem de ser o último recurso');
});

test('sem desafio nenhum, a resposta inteira vai para o log', () => {
  // Sem isso o próximo conserto seria palpite outra vez.
  assert.ok(SCRIPT.includes('[viralizeai-deepseek] resposta sem desafio'));
  assert.ok(SCRIPT.includes('JSON.stringify(data).slice(0, 800)'));
  // E continua falhando: desafio ausente não vira matéria vazia.
  assert.ok(SCRIPT.includes('throw new Error("PoW challenge missing in response")'));
});

test('a varredura não entra em recursão sem fim', () => {
  // Resposta com referência circular ou muito aninhada não pode travar o
  // gateway — ele é o processo que atende todas as matérias.
  assert.ok(SCRIPT.includes('nivel > 5'));
  assert.ok(SCRIPT.includes('nivel + 1'));
});

test('o patch foi aplicado no gateway, uma vez só', () => {
  if (!fs.existsSync(ALVO)) return; // gateway não instalado nesta máquina
  const codigo = fs.readFileSync(ALVO, 'utf8');
  assert.equal(
    (codigo.match(/const procurarDesafio = /g) || []).length,
    1,
    'patch ausente ou aplicado mais de uma vez'
  );
});

test('a varredura acha o desafio onde quer que ele esteja', () => {
  // Executa a mesma lógica do patch sobre formatos de resposta plausíveis.
  const procurarDesafio = (alvo, nivel = 0) => {
    if (!alvo || typeof alvo !== 'object' || nivel > 5) return null;
    if (Array.isArray(alvo)) {
      for (const item of alvo) {
        const achado = procurarDesafio(item, nivel + 1);
        if (achado) return achado;
      }
      return null;
    }
    const o = alvo;
    if (
      typeof o.algorithm === 'string' &&
      typeof o.salt === 'string' &&
      typeof o.challenge === 'string'
    ) {
      return o;
    }
    for (const valor of Object.values(o)) {
      const achado = procurarDesafio(valor, nivel + 1);
      if (achado) return achado;
    }
    return null;
  };

  const desafio = { algorithm: 'DeepSeekHashV1', challenge: 'abc', salt: 'xyz', difficulty: 144000, signature: 's' };
  assert.deepEqual(procurarDesafio({ data: { biz_data: { challenge: desafio } } }), desafio);
  // Um nível a mais, que é o tipo de mudança que quebrou o caminho fixo.
  assert.deepEqual(procurarDesafio({ data: { biz_data: { pow: { challenge: desafio } } } }), desafio);
  assert.deepEqual(procurarDesafio({ result: [{ pow_challenge: desafio }] }), desafio);
  // Envelope de erro não vira desafio falso.
  assert.equal(procurarDesafio({ code: 40003, msg: 'not logged in' }), null);
});
