const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * Com a API sobrecarregada, a DeepSeek segura a conexão mandando keep-alive e
 * o `timeout` do axios (que só conta silêncio) nunca disparava: a chamada
 * ficava 15 min pendurada e a tela parava em "Montando 3 títulos…".
 */

process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'teste';

function dublar(relativo, exportado) {
  const arquivo = require.resolve(path.join('..', relativo));
  require.cache[arquivo] = { id: arquivo, filename: arquivo, loaded: true, exports: exportado };
}

const chamadas = { deepseek: 0, padrao: 0 };

dublar('src/services/iaPausaService', { garantirLiberada: async () => {} });
dublar('src/services/iaModeloTarefaService', { modeloDaTarefa: async () => 'deepseek-v4-flash' });

// axios que nunca responde — só termina quando o sinal aborta, como a conexão
// presa em keep-alive.
const axios = require('axios');
axios.post = (_url, _body, opcoes = {}) => {
  chamadas.deepseek += 1;
  return new Promise((_, reject) => {
    opcoes.signal?.addEventListener('abort', () => {
      const err = new Error('canceled');
      err.name = 'CanceledError';
      err.code = 'ERR_CANCELED';
      reject(err);
    });
  });
};

const deepseek = require('../src/services/deepseekService');

test('chamada pendurada é cortada no prazo total, sem repetir', async () => {
  chamadas.deepseek = 0;
  // AbortSignal.timeout não segura o processo; no servidor ele já vive sozinho.
  const vivo = setInterval(() => {}, 50);
  const inicio = Date.now();
  try {
    await assert.rejects(
      deepseek.chatCompletionDeepseekDireto([{ role: 'user', content: 'oi' }], { timeout: 300 }),
      (err) => err.code === 'DEEPSEEK_PRAZO' && /não respondeu em/.test(err.message)
    );
  } finally {
    clearInterval(vivo);
  }
  const levou = Date.now() - inicio;
  assert.ok(levou < 2000, `deveria cortar em ~300ms, levou ${levou}ms`);
  assert.equal(chamadas.deepseek, 1, 'prazo estourado não é repetido');
});
