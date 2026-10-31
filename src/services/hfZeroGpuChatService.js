/**
 * Chat de texto pelo Space ZeroGPU do Hugging Face.
 *
 * Diferente de Inference Providers, isto consome a cota diária ZeroGPU da
 * conta autenticada (PRO: cota ampliada), não o saldo de inferência por token.
 * O Space é configurável porque Spaces públicos podem mudar de versão/API.
 */

const MODELO_RAPIDO = String(process.env.HF_CHAT_ZEROGPU_FAST_ID || 'zerogpu/Qwen3-4B-Rapido').trim();
const MODELO_QUALIDADE = String(process.env.HF_CHAT_ZEROGPU_ID || 'zerogpu/Qwen3.8-27B').trim();
const PERFIS = Object.freeze({
  [MODELO_RAPIDO]: {
    host: String(
      process.env.HF_CHAT_ZEROGPU_FAST_SPACE || 'https://zacheus10-free-ai-chat.hf.space'
    ).replace(/\/+$/, ''),
    maxTokens: Math.min(1536, Math.max(256, Number(process.env.HF_CHAT_ZEROGPU_FAST_MAX_TOKENS) || 1024)),
    // O Space aceita 4.096 tokens incluindo o system prompt próprio. Em
    // português, 8.500 caracteres deixa folga para não estourar esse teto.
    maxPromptChars: 8_500,
    thinking: null,
  },
  [MODELO_QUALIDADE]: {
    host: String(
      process.env.HF_CHAT_ZEROGPU_SPACE || 'https://steliotel-qwen3-8-27b-chat.hf.space'
    ).replace(/\/+$/, ''),
    maxTokens: Math.min(2048, Math.max(256, Number(process.env.HF_CHAT_ZEROGPU_MAX_TOKENS) || 1536)),
    maxPromptChars: 100_000,
    thinking: false,
  },
});
// `MODELO` continua sendo o fallback padrão; agora aponta para o perfil rápido.
const MODELO = MODELO_RAPIDO;
const MODELOS = Object.freeze([MODELO_RAPIDO, MODELO_QUALIDADE]);
const TIMEOUT_MS = Math.max(60_000, Number(process.env.HF_CHAT_ZEROGPU_TIMEOUT_MS) || 6 * 60_000);

function perfilDoModelo(modelo) {
  return PERFIS[String(modelo || '').trim()] || null;
}

function ehModelo(modelo) {
  return Boolean(perfilDoModelo(modelo));
}

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
  if (/conversation too long|context.*(?:too long|length)|input.*tokens/i.test(detalhe)) {
    return erro('O contexto da conversa ficou grande demais para o Qwen rápido.', 413, 'HF_ZEROGPU_CONTEXTO');
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
function limitarTexto(texto, limite) {
  const valor = String(texto || '');
  if (valor.length <= limite) return valor;
  const inicio = Math.floor(limite * 0.55);
  const fim = limite - inicio;
  return `${valor.slice(0, inicio)}\n\n[contexto intermediário reduzido para acelerar]\n\n${valor.slice(-fim)}`;
}

function montarPrompt(messages, json = false, maxChars = 100_000) {
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
  return limitarTexto(partes.join('\n\n---\n\n'), maxChars);
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

async function gerar(
  messages,
  { modelo = MODELO, temperature = 0.7, json = false, onDelta = null, timeout = TIMEOUT_MS } = {}
) {
  const perfil = perfilDoModelo(modelo);
  if (!perfil) throw erro(`O perfil ZeroGPU "${modelo}" não existe.`, 400, 'HF_ZEROGPU_MODELO');
  const inicio = Date.now();
  let limitePrompt = perfil.maxPromptChars;

  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    const message = montarPrompt(messages, json, limitePrompt);
    const body = {
      message,
      // Perguntas simples não precisam reservar uma matéria inteira. Isso
      // reduz o tempo de geração e devolve a GPU mais cedo.
      max_new_tokens: message.length < 2_500 ? Math.min(384, perfil.maxTokens) : perfil.maxTokens,
      temperature: Math.max(0, Math.min(1.5, Number(temperature) || 0.7)),
    };
    if (perfil.thinking != null) body.thinking = perfil.thinking;

    try {
      const fila = await requisitar(`${perfil.host}/gradio_api/call/v2/generate`, {
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
        `${perfil.host}/gradio_api/call/generate/${encodeURIComponent(eventoId)}`,
        { headers: cabecalhos({ Accept: 'text/event-stream' }) },
        timeout
      );
      if (!resultado.ok) throw traduzirErro(await resultado.text(), resultado.status);
      const resposta = await lerSse(resultado, onDelta);
      console.log(`[hf-zerogpu-chat] ${modelo} ${((Date.now() - inicio) / 1000).toFixed(1)}s`);
      return resposta;
    } catch (err) {
      if (err?.code !== 'HF_ZEROGPU_CONTEXTO' || tentativa > 0) throw err;
      limitePrompt = Math.max(4_500, Math.floor(limitePrompt * 0.6));
      console.warn(`[hf-zerogpu-chat] contexto excedeu o Space; repetindo com ${limitePrompt} caracteres`);
    }
  }
  throw erro('O Qwen ZeroGPU não conseguiu reduzir o contexto da conversa.', 413, 'HF_ZEROGPU_CONTEXTO');
}

module.exports = {
  MODELO,
  MODELOS,
  MODELO_RAPIDO,
  MODELO_QUALIDADE,
  ehModelo,
  montarPrompt,
  gerar,
};
