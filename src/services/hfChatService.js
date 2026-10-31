const axios = require('axios');

/**
 * Modelos de TEXTO do Hugging Face (Inference Providers), para conversar no
 * /materia-manual como mais uma opção ao lado do Claude, do DeepSeek e do
 * gateway — sem tirar nenhum deles.
 *
 * É a rota OpenAI-compatible do HF: um POST /v1/chat/completions atende
 * qualquer modelo aberto servido por Groq, Together, Cerebras, Novita etc., e
 * o HF escolhe o provedor mais rápido. Por isso não existe adaptador por
 * provedor aqui — só o mesmo corpo que a API do DeepSeek já usa.
 *
 * O mesmo HF_TOKEN da geração de imagem (qwenImageService) serve aqui.
 * Cobrança: pay-as-you-go por token, com crédito mensal incluso no PRO.
 *
 * Doc: https://huggingface.co/docs/inference-providers
 */

const BASE_URL = String(process.env.HF_CHAT_BASE_URL || 'https://router.huggingface.co/v1').replace(/\/+$/, '');
const TIMEOUT_MS = Math.max(15_000, Number(process.env.HF_CHAT_TIMEOUT_MS) || 180_000);

/**
 * Modelos oferecidos no /claude quando a listagem da API não responder.
 * Abertos, com bom português e servidos por vários provedores.
 */
const MODELOS_PADRAO = Object.freeze([
  'openai/gpt-oss-120b',
  'deepseek-ai/DeepSeek-V3.1',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  'meta-llama/Llama-3.3-70B-Instruct',
]);

/** Catálogo fixo opcional: HF_CHAT_MODELS=id1,id2 (vazio = lista da API). */
function modelosDoEnv() {
  return String(process.env.HF_CHAT_MODELS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function token() {
  return String(process.env.HF_TOKEN || '').trim();
}

function isConfigured() {
  return Boolean(token());
}

/**
 * Id de modelo do Hugging Face tem dono/modelo ("Qwen/Qwen3-…"); os demais
 * provedores do projeto usam nome simples ("claude-sonnet-5"). É esse "/" que
 * diz ao despacho que a conversa vai para o HF.
 */
function ehModeloHf(id) {
  const valor = String(id || '').trim();
  return valor.includes('/') && !/^https?:/i.test(valor);
}

function erro(message, status = 502, code = '') {
  const err = new Error(message);
  err.status = status;
  // O controller do chat esconde erros com `code` por segurança (banco,
  // driver etc.). Estes textos já são saneados e precisam chegar ao editor.
  err.paraUsuario = true;
  if (code) err.code = code;
  return err;
}

function assertConfigurado() {
  if (!isConfigured()) {
    throw erro(
      'Falta o HF_TOKEN no .env do servidor para conversar com os modelos do Hugging Face.',
      503,
      'HF_SEM_TOKEN'
    );
  }
}

function cabecalhos(extra = {}) {
  return { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...extra };
}

/** Mensagem da API em português; cota e modelo sem provedor são o comum. */
function traduzirErro(err, modelo) {
  const status = err?.response?.status || 0;
  const detalhe = String(
    err?.response?.data?.error?.message || err?.response?.data?.error || err?.response?.data || err?.message || ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  if (status === 401 || status === 403) {
    return erro('O HF_TOKEN foi recusado pelo Hugging Face. Gere um token com permissão de Inference Providers.', 401, 'HF_TOKEN_INVALIDO');
  }
  if (status === 402 || /credit|quota|payment/i.test(detalhe)) {
    return erro('O crédito de inferência do Hugging Face acabou. Recarregue na conta ou escolha outro modelo no /materia-manual.', 429, 'HF_SEM_CREDITO');
  }
  if (status === 404) {
    return erro(`Nenhum provedor do Hugging Face está servindo "${modelo}" agora. Escolha outro modelo.`, 404, 'HF_MODELO_FORA');
  }
  if (status === 429) {
    return erro('O Hugging Face limitou a taxa de requisições. Tente de novo em alguns segundos.', 429, 'HF_RATE_LIMIT');
  }
  if (err?.code === 'ECONNABORTED') {
    return erro(`O modelo ${modelo} não respondeu em ${Math.round(TIMEOUT_MS / 1000)} s.`, 504);
  }
  return erro(`O Hugging Face não respondeu${detalhe ? `: ${detalhe}` : '.'}`);
}

/**
 * Catálogo para o /claude. A API devolve só o que tem provedor de pé agora,
 * então o administrador não marca um modelo que já ia falhar.
 */
async function listarModelos({ timeout = 6_000 } = {}) {
  const fixos = modelosDoEnv();
  if (fixos.length) return fixos;
  if (!isConfigured()) return [];
  try {
    const { data } = await axios.get(`${BASE_URL}/models`, { headers: cabecalhos(), timeout });
    const ids = (data?.data || [])
      .map((item) => String(item?.id || '').trim())
      .filter((id) => ehModeloHf(id));
    return ids.length ? ids : [...MODELOS_PADRAO];
  } catch (err) {
    console.warn('[hf-chat] listagem de modelos falhou, usando a lista padrão:', err.message);
    return [...MODELOS_PADRAO];
  }
}

/** Alguns provedores cercam o JSON em ```; o chamador espera JSON puro. */
function limparJson(raw) {
  let texto = String(raw || '').trim();
  const cerca = texto.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (cerca) texto = cerca[1].trim();
  if (texto.startsWith('{') || texto.startsWith('[')) return texto;
  const inicio = texto.search(/[[{]/);
  if (inicio < 0) return texto;
  const fecha = texto[inicio] === '{' ? '}' : ']';
  const fim = texto.lastIndexOf(fecha);
  return fim > inicio ? texto.slice(inicio, fim + 1).trim() : texto;
}

function logarUso(modelo, inicio, usage) {
  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
  const entrada = usage?.prompt_tokens ?? '?';
  const saida = usage?.completion_tokens ?? '?';
  console.log(`[hf-chat] ${modelo} ${segundos}s in=${entrada} out=${saida}`);
}

function corpo(messages, { modelo, temperature, json, stream }) {
  const body = {
    model: modelo,
    messages: (messages || []).map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : m?.role === 'system' ? 'system' : 'user',
      content: String(m?.content || ''),
    })),
    stream: Boolean(stream),
  };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  // response_format não é aceito por todo provedor do HF; o JSON é garantido
  // pelo prompt (que já pede) e limpo na volta por limparJson.
  if (json) body.messages = body.messages.map((m, i) =>
    i === body.messages.length - 1 && m.role === 'user'
      ? { ...m, content: `${m.content}\n\nResponda APENAS com o JSON pedido, sem cercas de código.` }
      : m
  );
  return body;
}

/** Mesmo contrato do chatCompletion da DeepSeek: devolve o texto cru. */
async function chatCompletion(
  messages,
  { modelo, temperature = 0.7, json = true, timeout = TIMEOUT_MS } = {}
) {
  assertConfigurado();
  const id = String(modelo || '').trim();
  if (!ehModeloHf(id)) throw erro('Nenhum modelo válido do Hugging Face foi escolhido para esta conversa.', 400);

  const inicio = Date.now();
  let data;
  try {
    ({ data } = await axios.post(
      `${BASE_URL}/chat/completions`,
      corpo(messages, { modelo: id, temperature, json, stream: false }),
      { headers: cabecalhos(), timeout }
    ));
  } catch (err) {
    throw traduzirErro(err, id);
  }

  logarUso(id, inicio, data?.usage);
  const texto = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!texto) throw erro(`O modelo ${id} (Hugging Face) devolveu resposta vazia.`);
  return json ? limparJson(texto) : texto;
}

/**
 * Streaming SSE, para a resposta aparecer palavra a palavra no chat. Falha de
 * stream cai para a chamada normal — o chamador já espera esse contrato.
 */
async function chatCompletionStream(
  messages,
  { modelo, temperature = 0.7, onDelta = null, timeout = TIMEOUT_MS } = {}
) {
  assertConfigurado();
  const id = String(modelo || '').trim();
  if (!ehModeloHf(id)) throw erro('Nenhum modelo válido do Hugging Face foi escolhido para esta conversa.', 400);

  const inicio = Date.now();
  let completo = '';
  try {
    const resposta = await axios.post(
      `${BASE_URL}/chat/completions`,
      corpo(messages, { modelo: id, temperature, json: false, stream: true }),
      { headers: cabecalhos({ Accept: 'text/event-stream' }), responseType: 'stream', timeout }
    );

    await new Promise((resolve, reject) => {
      let buffer = '';
      resposta.data.on('data', (pedaco) => {
        buffer += pedaco.toString('utf8');
        const linhas = buffer.split('\n');
        buffer = linhas.pop() || '';
        for (const linha of linhas) {
          const l = linha.trim();
          if (!l.startsWith('data:')) continue;
          const payload = l.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content || '';
            if (delta) {
              completo += delta;
              if (typeof onDelta === 'function') onDelta(delta);
            }
          } catch {
            /* pedaço incompleto do SSE — o resto vem no próximo chunk */
          }
        }
      });
      resposta.data.on('end', resolve);
      resposta.data.on('error', reject);
    });
  } catch (err) {
    console.warn(`[hf-chat] stream de ${id} falhou, usando modo normal:`, err.message);
    completo = '';
  }

  if (completo.trim()) {
    logarUso(id, inicio, null);
    return completo.trim();
  }

  const texto = await chatCompletion(messages, { modelo: id, temperature, json: false, timeout });
  if (typeof onDelta === 'function') onDelta(texto);
  return texto;
}

module.exports = {
  MODELOS_PADRAO,
  isConfigured,
  ehModeloHf,
  listarModelos,
  chatCompletion,
  chatCompletionStream,
  limparJson,
};
