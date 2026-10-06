const { AsyncLocalStorage } = require('node:async_hooks');
const axios = require('axios');
const { env } = require('../config/env');
const { limparMarcacaoChatgpt, criarLimpadorDeStream } = require('./chatgptMarkup');

/**
 * Cliente OpenAI-compatible do token-free-gateway.
 *
 * O gateway usa a sessao do Chrome para falar com o Claude. Este adaptador
 * roda somente no backend: cookie, perfil de autenticacao e porta CDP nunca
 * sao enviados ao navegador do usuario do ViralizeAI.
 */

const TAREFAS = new Set(
  String(process.env.TOKEN_FREE_GATEWAY_TAREFAS || 'conversa')
    .toLowerCase()
    .split(',')
    .map((tarefa) => tarefa.trim())
    .filter(Boolean)
);

function normalizarBaseUrl(valor) {
  const texto = String(valor || 'http://127.0.0.1:3456/v1').trim().replace(/\/+$/, '');
  return /\/v1$/i.test(texto) ? texto : `${texto}/v1`;
}

const BASE_URL = normalizarBaseUrl(env.tokenFreeGateway?.baseUrl);
const API_KEY = String(env.tokenFreeGateway?.apiKey || 'qualquer-coisa').trim();
const MODELO = String(
  env.tokenFreeGateway?.model || 'claude-sonnet-5'
).trim();
const TIMEOUT_MS = Math.max(10_000, Number(env.tokenFreeGateway?.timeoutMs) || 330_000);

/**
 * Modelo escolhido pelo editor no /materia-manual. Vale para todas as chamadas
 * ao gateway feitas durante aquela requisição (redação, títulos, revisão),
 * sem precisar repassar o parâmetro por cada função do fluxo.
 */
const modeloDaRequisicao = new AsyncLocalStorage();

function comModelo(modelo, tarefa) {
  const id = String(modelo || '').trim();
  return id ? modeloDaRequisicao.run(id, tarefa) : tarefa();
}

function modeloAtual() {
  return modeloDaRequisicao.getStore() || MODELO;
}

function provedorSelecionado() {
  return ['token-free', 'token_free', 'tokenfree'].includes(
    String(env.aiProvider || '').trim().toLowerCase()
  );
}

function isConfigured() {
  return provedorSelecionado() && Boolean(BASE_URL && MODELO);
}

function cobreTarefa(tarefa = 'conversa') {
  return isConfigured() && TAREFAS.has(String(tarefa || 'conversa').trim().toLowerCase());
}

function headers(aceitarStream = false) {
  return {
    Authorization: `Bearer ${API_KEY || 'qualquer-coisa'}`,
    'Content-Type': 'application/json',
    ...(aceitarStream ? { Accept: 'text/event-stream' } : {}),
  };
}

/**
 * O token-free-gateway aceita o campo response_format, mas a versao atual nao
 * o transforma em instrucao para o provedor web. Reforcar o contrato no system
 * evita respostas Markdown onde o restante do app espera JSON puro.
 */
function prepararMensagens(messages, json) {
  const copia = (Array.isArray(messages) ? messages : [])
    .filter((mensagem) => mensagem && mensagem.content != null)
    .map((mensagem) => ({
      ...mensagem,
      content: String(mensagem.content || ''),
    }));

  if (!json) return copia;

  const regra =
    '\n\nResponda SOMENTE com JSON valido, sem markdown, sem cerca de codigo e sem texto antes ou depois do JSON.';
  const indiceSystem = copia.findIndex((mensagem) => mensagem.role === 'system');
  if (indiceSystem >= 0) copia[indiceSystem].content += regra;
  else copia.unshift({ role: 'system', content: regra.trim() });
  return copia;
}

/**
 * O provedor web do Claude recebe apenas um `prompt` comum. O conversor
 * OpenAI-compatible do gateway normalmente serializa a conversa usando
 * rótulos como "System:" e "Human:"; dentro do claude.ai esses rótulos não
 * têm autoridade especial. Tudo é um pedido comum do usuário. Por isso o
 * briefing é apresentado honestamente como preferências do editor, sem fingir
 * que existe um bloco de sistema oculto.
 */
function prepararPromptUnicoClaudeWeb(messages) {
  const lista = (Array.isArray(messages) ? messages : [])
    .filter((mensagem) => mensagem && String(mensagem.content || '').trim())
    .map((mensagem) => ({
      role: mensagem.role === 'assistant'
        ? 'assistant'
        : mensagem.role === 'system' || mensagem.role === 'developer'
          ? 'instruction'
          : 'user',
      content: String(mensagem.content || '').trim(),
    }));
  if (!lista.length) return [];

  const instrucoes = lista
    .filter((mensagem) => mensagem.role === 'instruction')
    .map((mensagem) => mensagem.content);
  const dialogo = lista.filter((mensagem) => mensagem.role !== 'instruction');
  const atual = [...dialogo].reverse().find((mensagem) => mensagem.role === 'user');
  const indiceAtual = atual ? dialogo.lastIndexOf(atual) : -1;
  const historico = indiceAtual >= 0 ? dialogo.slice(0, indiceAtual) : dialogo;

  const partes = [
    instrucoes.length
      ? `Preferências fornecidas pelo editor para esta resposta:\n\n${instrucoes.join('\n\n')}`
      : null,
    historico.length
      ? `Contexto anterior da conversa:\n\n${historico
          .map((mensagem) => `${mensagem.role === 'assistant' ? 'Assistente' : 'Usuário'}: ${mensagem.content}`)
          .join('\n\n')}`
      : null,
    `Pedido atual do editor:\n\n${atual?.content || ''}`,
    'Entregue diretamente a resposta ao pedido atual.',
  ].filter(Boolean);

  return [{ role: 'user', content: partes.join('\n\n') }];
}

function limparCercaJson(valor) {
  let texto = String(valor || '').trim();
  const cerca = texto.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (cerca) texto = cerca[1].trim();
  if (texto.startsWith('{') || texto.startsWith('[')) return texto;

  const inicio = texto.search(/[\[{]/);
  if (inicio < 0) return texto;
  const abre = texto[inicio];
  const fecha = abre === '{' ? '}' : ']';
  const fim = texto.lastIndexOf(fecha);
  return fim > inicio ? texto.slice(inicio, fim + 1).trim() : texto;
}

function mensagemRemota(err) {
  return (
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.message ||
    'erro desconhecido'
  );
}

function normalizarErro(err) {
  const status = Number(err?.response?.status || err?.status || 0);
  const codigo = String(err?.code || '').toUpperCase();
  const remoto = String(mensagemRemota(err)).trim();
  let mensagem;

  if (codigo === 'ECONNREFUSED' || codigo === 'ENOTFOUND') {
    mensagem = `Token-Free Gateway nao esta acessivel em ${BASE_URL}. Execute "token-free-gateway start".`;
  } else if (status === 401 || /session expired|sess[aã]o expir/i.test(remoto)) {
    mensagem = `Sessao do Token-Free Gateway expirada ou sem autorizacao. Execute "token-free-gateway webauth". (${remoto})`;
  } else if (status === 404 && /authorized provider|model/i.test(remoto)) {
    mensagem = `Modelo ${modeloAtual()} nao esta autorizado no Token-Free Gateway. Execute "token-free-gateway webauth" e confira /v1/models. (${remoto})`;
  } else if (status === 429) {
    mensagem = `Claude limitou temporariamente as requisicoes do Token-Free Gateway. Tente novamente em alguns minutos. (${remoto})`;
  } else if (codigo === 'ECONNABORTED' || status === 504) {
    mensagem = `Token-Free Gateway excedeu o limite de ${Math.round(TIMEOUT_MS / 1000)}s. Confira o Chrome e a sessao do Claude. (${remoto})`;
  } else {
    mensagem = `Token-Free Gateway falhou${status ? ` (HTTP ${status})` : ''}: ${remoto}`;
  }

  const normalizado = new Error(mensagem);
  normalizado.status = status || 502;
  normalizado.code = codigo || undefined;
  normalizado.cause = err;
  return normalizado;
}

function assertConfigured(tarefa = 'conversa') {
  if (!provedorSelecionado()) {
    const err = new Error('Defina AI_PROVIDER=token-free para usar o Token-Free Gateway.');
    err.status = 500;
    throw err;
  }
  if (!TAREFAS.has(String(tarefa || 'conversa').trim().toLowerCase())) {
    const err = new Error(
      `TOKEN_FREE_GATEWAY_TAREFAS nao inclui a tarefa "${tarefa}".`
    );
    err.status = 500;
    throw err;
  }
}

function bodyDaChamada(
  messages,
  { temperature, json, stream, tarefa, conversationId, conversationName, webSearch }
) {
  const modelo = modeloAtual();
  const base = conversationId || `viralizeai:internal:${String(tarefa || 'conversa')}`;
  // Cada modelo mantém a própria conversa no gateway: trocar de Claude para
  // ChatGPT no meio do chat não pode reaproveitar a sessão do outro provedor.
  const conversa = String(modelo === MODELO ? base : `${base}:model:${modelo}`).slice(0, 240);
  const mensagensPreparadas = prepararMensagens(messages, json);
  return {
    model: modelo,
    // A tarefa "conversa" é atendida pelo claude.ai via navegador. Um único
    // prompt evita que o gateway mostre "System:" como texto do usuário.
    messages: String(tarefa || '').trim().toLowerCase() === 'conversa'
      ? prepararPromptUnicoClaudeWeb(mensagensPreparadas)
      : mensagensPreparadas,
    temperature,
    stream: Boolean(stream),
    conversation_id: conversa,
    conversation_name: String(
      conversationName || (conversationId ? 'ViralizeAI' : 'ViralizeAI — tarefas internas')
    ).slice(0, 100),
    web_search: Boolean(webSearch),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
}

function logar(inicio, tipo, usage = null) {
  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
  const tokens = usage?.total_tokens || '?';
  console.log(`[token-free] ${modeloAtual()} ${tipo} ${segundos}s tokens=${tokens}`);
}

async function chatCompletion(
  messages,
  {
    temperature = 0.7,
    json = true,
    timeout = TIMEOUT_MS,
    tarefa = 'conversa',
    conversationId = null,
    conversationName = null,
    webSearch = false,
  } = {}
) {
  assertConfigured(tarefa);
  // "Parar IA" em /claude: geral ou só este modelo.
  await require('./iaPausaService').garantirLiberada(modeloAtual());
  const inicio = Date.now();

  try {
    const { data } = await axios.post(
      `${BASE_URL}/chat/completions`,
      bodyDaChamada(messages, {
        temperature,
        json,
        stream: false,
        tarefa,
        conversationId,
        conversationName,
        webSearch,
      }),
      { headers: headers(false), timeout }
    );
    const texto = limparMarcacaoChatgpt(data?.choices?.[0]?.message?.content || '').trim();
    if (!texto) throw new Error('resposta vazia');
    logar(inicio, tarefa, data?.usage);
    return json ? limparCercaJson(texto) : texto;
  } catch (err) {
    const normalizado = normalizarErro(err);
    if (podeIrPelaApiDeepseek(normalizado)) {
      avisarDesvioDeepseek(normalizado);
      const deepseek = require('./deepseekService');
      return deepseek.comProvedor('deepseek', () => deepseek.chatCompletion(messages, { temperature, json, tarefa }));
    }
    throw normalizado;
  }
}

/** O modelo escolhido para esta chamada é a DeepSeek (DeepSeek web no gateway)? */
function ehModeloDeepseek(modelo = modeloAtual()) {
  return /deepseek/i.test(String(modelo || ''));
}

/**
 * O DeepSeek web do gateway quebra quando a DeepSeek muda o desafio anti-robô
 * ("PoW challenge missing in response") ou a sessão do navegador expira. Com
 * DEEPSEEK_API_KEY configurada, a mesma chamada segue pela API oficial — o
 * editor escolheu DeepSeek e recebe DeepSeek, em vez de um erro na tela.
 * Quando o web voltar a funcionar, ele volta a ser usado sozinho.
 */
function podeIrPelaApiDeepseek(err) {
  if (!ehModeloDeepseek() || !String(env.deepseekApiKey || '').trim()) return false;
  if (err?.iaPausada) return false;
  const texto = `${err?.message || ''} ${mensagemRemota(err?.cause || err)}`;
  return /PoW challenge|create_pow_challenge|Failed to create PoW|deepseek/i.test(texto)
    || [401, 403, 502, 503].includes(Number(err?.status || err?.response?.status || 0));
}

let ultimoAvisoDesvio = 0;
function avisarDesvioDeepseek(err) {
  if (Date.now() - ultimoAvisoDesvio < 60_000) return;
  ultimoAvisoDesvio = Date.now();
  console.warn(`[token-free] DeepSeek web falhou (${err?.message || err}); seguindo pela API oficial da DeepSeek`);
}

/**
 * Streaming SSE compativel com a interface usada pelo /materia-manual.
 * Se a conexao falhar antes do primeiro delta, tenta a chamada comum. Depois
 * do primeiro delta nao repete a requisicao, para nao duplicar texto na tela.
 */
async function chatCompletionStream(
  messages,
  {
    temperature = 0.7,
    onDelta = null,
    timeout = TIMEOUT_MS,
    tarefa = 'conversa',
    conversationId = null,
    conversationName = null,
    webSearch = false,
  } = {}
) {
  assertConfigured(tarefa);
  // "Parar IA" em /claude: geral ou só este modelo.
  await require('./iaPausaService').garantirLiberada(modeloAtual());
  const inicio = Date.now();
  let full = '';
  const limpador = criarLimpadorDeStream();

  try {
    const response = await axios.post(
      `${BASE_URL}/chat/completions`,
      bodyDaChamada(messages, {
        temperature,
        json: false,
        stream: true,
        tarefa,
        conversationId,
        conversationName,
        webSearch,
      }),
      {
        headers: headers(true),
        responseType: 'stream',
        timeout,
      }
    );

    await new Promise((resolve, reject) => {
      let buffer = '';
      const processarLinha = (linha) => {
        const texto = String(linha || '').trim();
        if (!texto.startsWith('data:')) return;
        const payload = texto.slice(5).trim();
        if (!payload || payload === '[DONE]') return;

        try {
          const evento = JSON.parse(payload);
          if (evento?.error?.message) {
            const erro = new Error(evento.error.message);
            erro.status = 502;
            reject(erro);
            return;
          }
          const delta = evento?.choices?.[0]?.delta?.content || '';
          if (delta) {
            full += delta;
            const visivel = limpador.empurrar(delta);
            if (visivel && typeof onDelta === 'function') onDelta(visivel);
          }
        } catch (err) {
          if (err instanceof SyntaxError) return;
          reject(err);
        }
      };

      response.data.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const linhas = buffer.split(/\r?\n/);
        buffer = linhas.pop() || '';
        linhas.forEach(processarLinha);
      });
      response.data.on('end', () => {
        if (buffer.trim()) processarLinha(buffer);
        resolve();
      });
      response.data.on('error', reject);
    });

    if (!full.trim()) throw new Error('stream vazio');
    logar(inicio, `${tarefa}/stream`);
    return limparMarcacaoChatgpt(full).trim();
  } catch (err) {
    if (full.trim()) throw normalizarErro(err);
    // DeepSeek web fora: em vez de tentar o gateway de novo (falha igual),
    // segue em streaming pela API oficial — o texto continua aparecendo aos poucos.
    if (podeIrPelaApiDeepseek(normalizarErro(err))) {
      avisarDesvioDeepseek(normalizarErro(err));
      return require('./deepseekService').chatCompletionStream(messages, {
        temperature,
        onDelta,
        tarefa,
        forceDeepseek: true,
      });
    }
    console.warn('[token-free-stream] stream indisponivel; tentando modo comum:', mensagemRemota(err));
    const texto = await chatCompletion(messages, {
      temperature,
      json: false,
      timeout,
      tarefa,
      conversationId,
      conversationName,
      webSearch,
    });
    if (typeof onDelta === 'function') onDelta(texto);
    return texto;
  }
}

async function verificarSaude({ timeout = 8_000 } = {}) {
  try {
    const url = new URL(BASE_URL);
    url.pathname = '/health';
    url.search = '';
    const { data } = await axios.get(url.toString(), { timeout });
    return data;
  } catch (err) {
    throw normalizarErro(err);
  }
}

async function listarModelos({ timeout = 8_000 } = {}) {
  try {
    const { data } = await axios.get(`${BASE_URL}/models`, {
      headers: headers(false),
      timeout,
    });
    return Array.isArray(data?.data) ? data.data : [];
  } catch (err) {
    throw normalizarErro(err);
  }
}

module.exports = {
  chatCompletion,
  chatCompletionStream,
  verificarSaude,
  listarModelos,
  bodyDaChamada,
  comModelo,
  modeloAtual,
  isConfigured,
  cobreTarefa,
  prepararMensagens,
  prepararPromptUnicoClaudeWeb,
  limparCercaJson,
  normalizarBaseUrl,
  BASE_URL,
  MODELO,
};
