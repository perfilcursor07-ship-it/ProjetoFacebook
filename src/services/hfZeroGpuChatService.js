/**
 * Chat de texto pelo Space ZeroGPU do Hugging Face.
 *
 * Diferente de Inference Providers, isto consome a cota diária ZeroGPU da
 * conta autenticada (PRO: cota ampliada), não o saldo de inferência por token.
 * O Space é configurável porque Spaces públicos podem mudar de versão/API.
 */

const HOST = String(
  process.env.HF_CHAT_ZEROGPU_SPACE || 'https://steliotel-qwen3-8-27b-chat.hf.space'
).replace(/\/+$/, '');
const MODELO = String(process.env.HF_CHAT_ZEROGPU_ID || 'zerogpu/Qwen3.8-27B').trim();
const TIMEOUT_MS = Math.max(60_000, Number(process.env.HF_CHAT_ZEROGPU_TIMEOUT_MS) || 6 * 60_000);
const MAX_NOVOS_TOKENS = Math.min(2048, Math.max(256, Number(process.env.HF_CHAT_ZEROGPU_MAX_TOKENS) || 1536));

function token() {
  return String(process.env.HF_TOKEN || '').trim();
}

function erro(message, status = 502, code = '') {
  const err = new Error(message);
  err.status = status;
  err.paraUsuario = true;
  if (code) err.code = code;
  return err;
}

function cabecalhos(extra = {}) {
  if (!token()) throw erro('Falta o HF_TOKEN no servidor para usar o chat ZeroGPU.', 503, 'HF_SEM_TOKEN');
  return { Authorization: `Bearer ${token()}`, ...extra };
}

function traduzirErro(texto, status = 0) {
  const detalhe = String(texto || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (status === 401 || status === 403 || /invalid.*token|unauthorized/i.test(detalhe)) {
    return erro('O HF_TOKEN foi recusado pelo Hugging Face. Confira se ele pertence à conta PRO.', 401, 'HF_TOKEN_INVALIDO');
  }
  if (status === 429 || /quota|gpu.*(?:limit|exceed)|exceeded your/i.test(detalhe)) {
    return erro('A cota diária ZeroGPU da conta Hugging Face acabou. Ela volta após a renovação diária da cota PRO.', 429, 'HF_ZEROGPU_COTA');
  }
  if (/sleeping|starting|building|paused|loading/i.test(detalhe)) {
    return erro('O Space de chat ZeroGPU está iniciando. Tente novamente em 1 ou 2 minutos.', 503, 'HF_ZEROGPU_INICIANDO');
  }
  return erro(`O chat ZeroGPU do Hugging Face não respondeu${detalhe ? `: ${detalhe}` : '.'}`);
}

async function requisitar(url, opcoes = {}, timeout = TIMEOUT_MS) {
  try {
    return await fetch(url, { ...opcoes, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw erro('O Qwen ZeroGPU demorou além do limite. Tente novamente.', 504, 'HF_ZEROGPU_TIMEOUT');
    throw traduzirErro(err?.message);
  }
}

/** O Space recebe um campo só; serializamos sistema + histórico nesse campo. */
function montarPrompt(messages, json = false) {
  const lista = (Array.isArray(messages) ? messages : [])
    .filter((item) => item && String(item.content || '').trim())
    .map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user',
      content: String(item.content || '').trim(),
    }));
  const sistemas = lista.filter((item) => item.role === 'system').map((item) => item.content);
  const dialogo = lista.filter((item) => item.role !== 'system');
  const partes = [];
  if (sistemas.length) partes.push(`INSTRUÇÕES DO SISTEMA:\n${sistemas.join('\n\n')}`);
  if (dialogo.length) {
    partes.push(dialogo.map((item) => `${item.role === 'assistant' ? 'ASSISTENTE' : 'USUÁRIO'}:\n${item.content}`).join('\n\n'));
  }
  if (json) partes.push('REGRA DE SAÍDA: responda somente com o JSON solicitado, sem markdown nem cercas de código.');
  partes.push('Responda agora somente à última mensagem do usuário. Não repita os rótulos acima.');
  // Mantém o fim (pedido atual) se a apuração ficar excepcionalmente grande.
  return partes.join('\n\n---\n\n').slice(-100_000);
}

function extrairTexto(payload) {
  try {
    const valor = JSON.parse(payload);
    if (Array.isArray(valor)) return String(valor[0] ?? '');
    return String(valor?.data?.[0] ?? valor?.output ?? valor ?? '');
  } catch {
    return String(payload || '').replace(/^"|"$/g, '');
  }
}

/**
 * Lê os eventos do Gradio. Eventos `generating` carregam a resposta completa
 * até aquele ponto; transformamos isso em deltas para o chat da aplicação.
 */
async function lerSse(response, onDelta) {
  if (!response.body) throw traduzirErro('stream vazio', response.status);
  const leitor = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let evento = '';
  let completo = '';

  const processarLinha = (linha) => {
    if (linha.startsWith('event:')) {
      evento = linha.slice(6).trim();
      return;
    }
    if (!linha.startsWith('data:')) return;
    const payload = linha.slice(5).trim();
    // Alguns Spaces encerram o generator com erro depois de já terem emitido
    // a resposta completa. Nesse caso o texto útil prevalece; sem texto, o
    // erro continua sendo mostrado normalmente.
    if (evento === 'error') {
      if (completo.trim()) return;
      throw traduzirErro(payload);
    }
    if (!['generating', 'complete'].includes(evento)) return;
    const atual = extrairTexto(payload);
    if (!atual) return;
    const delta = atual.startsWith(completo) ? atual.slice(completo.length) : atual;
    completo = atual;
    if (delta && typeof onDelta === 'function') onDelta(delta);
  };

  while (true) {
    const { value, done } = await leitor.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const linhas = buffer.split(/\r?\n/);
    buffer = done ? '' : (linhas.pop() || '');
    for (const linha of linhas) processarLinha(linha);
    if (done) break;
  }
  if (buffer) processarLinha(buffer);
  if (!completo.trim()) throw traduzirErro('o Space encerrou sem gerar texto');
  return completo.trim();
}

async function gerar(messages, { temperature = 0.7, json = false, onDelta = null, timeout = TIMEOUT_MS } = {}) {
  const inicio = Date.now();
  const body = {
    message: montarPrompt(messages, json),
    max_new_tokens: MAX_NOVOS_TOKENS,
    temperature: Math.max(0, Math.min(1.5, Number(temperature) || 0.7)),
    thinking: false,
  };
  const fila = await requisitar(`${HOST}/gradio_api/call/v2/generate`, {
    method: 'POST',
    headers: cabecalhos({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  }, Math.min(timeout, 60_000));
  const textoFila = await fila.text();
  if (!fila.ok) throw traduzirErro(textoFila, fila.status);
  let eventoId = '';
  try { eventoId = String(JSON.parse(textoFila)?.event_id || ''); } catch { /* tratado abaixo */ }
  if (!eventoId) throw traduzirErro(textoFila || 'event_id ausente');

  const resultado = await requisitar(
    `${HOST}/gradio_api/call/generate/${encodeURIComponent(eventoId)}`,
    { headers: cabecalhos({ Accept: 'text/event-stream' }) },
    timeout
  );
  if (!resultado.ok) throw traduzirErro(await resultado.text(), resultado.status);
  const resposta = await lerSse(resultado, onDelta);
  console.log(`[hf-zerogpu-chat] ${MODELO} ${((Date.now() - inicio) / 1000).toFixed(1)}s`);
  return resposta;
}

module.exports = {
  HOST,
  MODELO,
  montarPrompt,
  gerar,
};
