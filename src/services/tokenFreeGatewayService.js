const { AsyncLocalStorage } = require('node:async_hooks');
const axios = require('axios');
const { env } = require('../config/env');
const { limparMarcacaoChatgpt, criarLimpadorDeStream, removerRespostaRepetida } = require('./chatgptMarkup');

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

  // O PEDIDO VEM PRIMEIRO.
  //
  // Antes a mensagem abria com "Preferências fornecidas pelo editor para esta
  // resposta:" e dez linhas de briefing; o que o editor tinha escrito ficava
  // lá embaixo. Como aqui tudo é um pedido comum do usuário (não há papel de
  // sistema), era isso que aparecia na conversa — e o editor via o bastidor
  // no lugar da própria pergunta. As regras continuam indo, curtas e no fim,
  // onde servem de rodapé em vez de enterrar o pedido.
  const partes = [
    atual?.content || '',
    historico.length
      ? `Contexto anterior da conversa:\n\n${historico
          .map((mensagem) => `${mensagem.role === 'assistant' ? 'Assistente' : 'Usuário'}: ${mensagem.content}`)
          .join('\n\n')}`
      : null,
    instrucoes.length ? `---\nComo responder: ${instrucoes.join('\n')}` : null,
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

/**
 * Repassa as imagens que vieram NA MESMA resposta do provedor.
 *
 * O campo é nosso (o gateway o acrescenta; veja
 * gateway-overrides/.../openai/chat-completions.ts) e pode não existir — em
 * provedor sem foto, em versão antiga do gateway ou quando a resposta é só
 * texto. Então nada aqui pode quebrar por ausência, e um erro do consumidor
 * não pode derrubar a geração da matéria.
 */
function entregarImagens(callback, valor, extras = {}) {
  if (typeof callback !== 'function') return;
  const urls = (Array.isArray(valor) ? valor : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (!urls.length) return;
  try {
    // `paginas`: de qual site veio cada foto (crédito). `daTela`: quantas das
    // primeiras são a foto que a tela do ChatGPT mostrou (o resto são
    // miniaturas de links citados). Gateway antigo não manda: undefined.
    callback(urls, {
      paginas: extras?.imagens_paginas && typeof extras.imagens_paginas === 'object' ? extras.imagens_paginas : {},
      daTela: Number.isFinite(extras?.imagens_da_tela) ? extras.imagens_da_tela : undefined,
    });
  } catch (err) {
    console.warn('[token-free] imagens da resposta ignoradas:', err.message);
  }
}

/**
 * Repassa em qual conversa do provedor a resposta ficou (hoje só o ChatGPT
 * informa: `chatgpt:<conversa>:<mensagem>`). Quem guarda esse ponteiro e o
 * manda de volta como `conversationId` continua a MESMA conversa no
 * chatgpt.com. Campo nosso, opcional, e nunca derruba a resposta.
 */
function entregarConversa(callback, evento) {
  if (typeof callback !== 'function') return;
  const ponteiro = String(evento?.conversa || '').trim();
  if (!ponteiro) return;
  try {
    callback({ ponteiro, url: String(evento?.conversa_url || '').trim() || null });
  } catch (err) {
    console.warn('[token-free] conversa da resposta ignorada:', err.message);
  }
}

/**
 * Buscas de imagem que o ChatGPT embute na resposta.
 *
 * Ele não manda a foto: escreve uma marca invisível
 * `\ue200image_group\ue202{"layout":"carousel","query":["…"]}\ue201` e a
 * tela dele é que busca as fotos com essa consulta. A marca é apagada do
 * texto (chatgptMarkup); antes disso, a consulta é aproveitada para o
 * ViralizeAI buscar as mesmas fotos reais.
 */
function buscasDeImagemNoTexto(texto) {
  const buscas = [];
  for (const marca of String(texto || '').matchAll(/\ue200image_group\ue202([^\ue201]*)\ue201/g)) {
    try {
      const dados = JSON.parse(marca[1]);
      const consultas = Array.isArray(dados?.query) ? dados.query : [dados?.query];
      for (const c of consultas) {
        const q = String(c || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (q.length >= 3 && !buscas.includes(q)) buscas.push(q);
      }
    } catch {
      // marca truncada: segue
    }
  }
  // <AsyncImage query="…"/> (e o grupo): o servidor do ChatGPT busca a foto
  // com essa consulta. Se a foto resolvida não chegar, ela serve de plano B.
  const ATRIBUTO = /\bquer(?:y|ies)=(?:"([^"]+)"|\{\[([^\]]*)\]\})/g;
  for (const tag of String(texto || '').matchAll(/<AsyncImage(?:Group)?\b[^>]*>/g)) {
    for (const m of tag[0].matchAll(ATRIBUTO)) {
      const lista = m[1] ? [m[1]] : String(m[2] || '').split(',').map((x) => x.replace(/^\s*["']|["']\s*$/g, ''));
      for (const c of lista) {
        const q = String(c || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (q.length >= 3 && !buscas.includes(q)) buscas.push(q);
      }
    }
  }
  return buscas;
}

function entregarBuscasDeImagem(callback, textoBruto) {
  if (typeof callback !== 'function') return;
  const buscas = buscasDeImagemNoTexto(textoBruto);
  if (!buscas.length) return;
  try {
    callback(buscas);
  } catch (err) {
    console.warn('[token-free] buscas de imagem ignoradas:', err.message);
  }
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
    // A resposta do ChatGPT pode trazer foto junto do texto (a imagem que ele
    // mostra na conversa). Ela chega num campo nosso, fora do padrão OpenAI, e
    // sai por aqui: o retorno continua sendo só o texto, como todos os
    // chamadores esperam.
    aoReceberImagens = null,
    aoReceberConversa = null,
    aoReceberBuscasDeImagem = null,
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
    entregarBuscasDeImagem(aoReceberBuscasDeImagem, data?.choices?.[0]?.message?.content);
    const texto = removerRespostaRepetida(limparMarcacaoChatgpt(data?.choices?.[0]?.message?.content || '')).trim();
    entregarImagens(aoReceberImagens, data?.imagens, data);
    entregarConversa(aoReceberConversa, data);
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
    aoReceberImagens = null,
    aoReceberConversa = null,
    aoReceberBuscasDeImagem = null,
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
          // Evento sem `choices`: é o nosso, com as imagens da resposta. O
          // gateway o emite depois do "stop" para não cair no meio do texto.
          entregarImagens(aoReceberImagens, evento?.imagens, evento);
          entregarConversa(aoReceberConversa, evento);
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
    entregarBuscasDeImagem(aoReceberBuscasDeImagem, full);
    return removerRespostaRepetida(limparMarcacaoChatgpt(full)).trim();
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
    // ChatGPT que chegou a responder (stream aberto, só sem texto legível) não
    // é falha de conexão: repetir mandaria o pedido de novo, abrindo outra
    // conversa no chatgpt.com e fazendo o editor esperar a pesquisa toda outra vez.
    if (/^(gpt|o\d|chatgpt)/i.test(modeloAtual()) && /stream vazio/i.test(String(err?.message || ''))) {
      const erro = new Error(
        'O ChatGPT respondeu, mas o texto não chegou até aqui. Veja no log do gateway as linhas [ChatGPT Web] desta conversa.'
      );
      erro.status = 502;
      throw erro;
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
      aoReceberImagens,
      aoReceberConversa,
      aoReceberBuscasDeImagem,
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

/**
 * Pedidos ao gateway em andamento agora. O vigia (tokenFreeAdminService) só
 * reinicia o gateway com zero: reiniciar no meio derrubava a resposta com
 * "Target page, context or browser has been closed".
 */
let pedidosAtivos = 0;
function contandoPedido(fn) {
  return async (...args) => {
    pedidosAtivos += 1;
    try {
      return await fn(...args);
    } finally {
      pedidosAtivos -= 1;
    }
  };
}

function pedidosEmAndamento() {
  return pedidosAtivos;
}

module.exports = {
  chatCompletion: contandoPedido(chatCompletion),
  chatCompletionStream: contandoPedido(chatCompletionStream),
  pedidosEmAndamento,
  buscasDeImagemNoTexto,
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
