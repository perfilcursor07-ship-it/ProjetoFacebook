/**
 * Gerador "Qwen-Image 2.1 · Viggle Turbo" (Hugging Face) para o "Recortar foto
 * da imagem destacada". Escolhido em /claude → Geração de imagem.
 *
 * Diferente do ChatGPT/Grok/Gemini, não abre navegador: chama a API Gradio do
 * Space público https://huggingface.co/spaces/Viggle/Qwen-Image-2.1-viggle-turbo
 * (ZeroGPU). O HF_TOKEN faz o tempo de GPU sair da cota da conta (PRO = 40
 * min/dia; uma imagem leva ~3 s sem referência e ~10 s editando a foto).
 *
 * Fluxo da API: upload da referência → POST /call/generate (devolve event_id)
 * → GET /call/generate/<event_id> (stream SSE até "complete" ou "error") →
 * download do arquivo gerado.
 *
 * RÉPLICAS: o Space roda em mais de uma máquina e o proxy do Hugging Face
 * sorteia a réplica a cada requisição (o prefixo /--replicas/<id> não é
 * respeitado). Por isso:
 * - o resultado e o download são pedidos de novo enquanto caírem na réplica
 *   errada (404 imediato, sem gastar GPU);
 * - a foto de referência sobe até estar em todas as réplicas — o caminho do
 *   upload é o hash do conteúdo, igual em todas. Imagem embutida em base64 o
 *   Space recusa.
 */

const HOST = String(process.env.HF_QWEN_IMAGE_SPACE || 'https://viggle-qwen-image-2-1-viggle-turbo.hf.space').replace(/\/+$/, '');
const NOME = 'Qwen-Image 2.1 Viggle Turbo';
/** Vertical, o mais perto do 4:5 do feed entre os tamanhos destilados (vale para criar e editar). */
const TAMANHO = '3:4 · 896×1184 (1024² area)';
const PASSOS = 6;
const VERSAO = 'v0.3';
/** Fila do Space + geração. Uma imagem leva segundos; a folga cobre fila cheia. */
const LIMITE_MS = 4 * 60_000;

/** Quantas vezes repetir o pedido que caiu na réplica errada. */
const TENTATIVAS_REPLICA = 15;

/** Última imagem por matéria, para o "Pegar imagem nova gerada". */
const ultimasGeradas = new Map();

function erro(message, status = 502, code = '') {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function cabecalhos(extra = {}) {
  const token = String(process.env.HF_TOKEN || '').trim();
  if (!token) {
    throw erro('Falta o HF_TOKEN no .env do servidor para gerar imagem com o Qwen (Hugging Face).', 503, 'HF_SEM_TOKEN');
  }
  return { Authorization: `Bearer ${token}`, ...extra };
}

/** Mensagem do Space em português; cota do ZeroGPU é o erro mais comum. */
function traduzirErro(texto) {
  const t = String(texto || '').replace(/^"|"$/g, '').trim();
  if (/quota|gpu.*(?:limit|exceed)|exceeded your/i.test(t)) {
    return erro('A cota diária de GPU do Hugging Face acabou. Tente amanhã, compre mais tempo no Hugging Face ou troque o gerador em /claude.', 429, 'HF_COTA');
  }
  if (/sleeping|starting|building|paused/i.test(t)) {
    return erro('O Space do Qwen no Hugging Face está iniciando. Tente de novo em 1–2 minutos.', 503, 'HF_INICIANDO');
  }
  return erro(`O Qwen (Hugging Face) não gerou a imagem${t && t !== 'null' ? `: ${t.slice(0, 200)}` : '.'}`);
}

async function requisitar(url, opcoes = {}, limite = 60_000) {
  try {
    return await fetch(url, { ...opcoes, signal: AbortSignal.timeout(limite) });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw erro(`O Qwen (Hugging Face) não respondeu em ${Math.round(limite / 1000)} s.`, 504);
    throw erro(`Não foi possível falar com o Hugging Face: ${err.message}`);
  }
}

/** 404 do proxy ou do Gradio: o pedido caiu numa réplica que não o conhece. */
function replicaErrada(resposta, texto = '') {
  return resposta.status === 404 || /event:\s*error\s*data:\s*"404: Not Found"/.test(texto);
}

/**
 * Sobe a foto de referência até ela estar em todas as réplicas que aparecerem
 * e devolve o caminho (o mesmo em todas). Para quando duas subidas seguidas
 * não revelarem réplica nova.
 */
async function enviarReferencia({ buffer, mimeType, name }) {
  const replicas = new Set();
  let caminho = null;
  let semNovidade = 0;
  for (let i = 0; i < 8 && semNovidade < 2; i += 1) {
    const form = new FormData();
    form.append('files', new Blob([buffer], { type: mimeType }), name);
    const resposta = await requisitar(`${HOST}/gradio_api/upload`, { method: 'POST', headers: cabecalhos(), body: form });
    if (!resposta.ok) throw traduzirErro(`upload HTTP ${resposta.status}`);
    const [enviado] = await resposta.json().catch(() => []);
    if (!enviado) throw erro('O Hugging Face não aceitou a foto de referência.');
    caminho = caminho || enviado;
    const replica = resposta.headers.get('x-proxied-replica') || 'unica';
    if (replicas.has(replica)) semNovidade += 1;
    else {
      replicas.add(replica);
      semNovidade = 0;
    }
  }
  return caminho;
}

/** Espera o resultado do pedido, repetindo enquanto cair na réplica errada. */
async function aguardarResultado(eventoId) {
  for (let i = 0; i < TENTATIVAS_REPLICA; i += 1) {
    const resposta = await requisitar(`${HOST}/gradio_api/call/generate/${eventoId}`, { headers: cabecalhos() }, LIMITE_MS);
    const texto = await resposta.text();
    if (replicaErrada(resposta, texto)) continue;
    return lerEventoFinal(texto);
  }
  throw erro('O Hugging Face não devolveu o resultado (réplica do Space não encontrada). Tente de novo.');
}

/** Lê o stream SSE da chamada e devolve o `data` do evento final. */
function lerEventoFinal(texto) {
  let evento = null;
  let dados = null;
  for (const linha of String(texto || '').split('\n')) {
    if (linha.startsWith('event:')) evento = linha.slice(6).trim();
    else if (linha.startsWith('data:') && (evento === 'complete' || evento === 'error')) dados = linha.slice(5).trim();
  }
  if (evento === 'error') throw traduzirErro(dados);
  if (evento !== 'complete') throw erro('O Qwen (Hugging Face) encerrou sem devolver a imagem.');
  try {
    return JSON.parse(dados);
  } catch {
    throw erro('Resposta do Qwen (Hugging Face) em formato inesperado.');
  }
}

async function baixar(url) {
  let resposta = null;
  for (let i = 0; i < TENTATIVAS_REPLICA; i += 1) {
    resposta = await requisitar(url, { headers: cabecalhos() });
    if (resposta.status !== 404) break;
  }
  if (!resposta.ok) throw erro(`O Qwen gerou a imagem, mas o download falhou (HTTP ${resposta.status}).`, resposta.status === 404 ? 410 : 502);
  const buffer = Buffer.from(await resposta.arrayBuffer());
  if (!buffer.length) throw erro('O Qwen devolveu uma imagem vazia.');
  return { buffer, mimeType: String(resposta.headers.get('content-type') || 'image/png').split(';')[0] };
}

/**
 * Mesmo contrato do ChatGPT/Grok/Gemini (imagemIaService): com a foto da
 * notícia como referência, edita; no modo 'simbolica', cria do zero.
 */
async function gerarImagem({ sourceUrl, prompt, titulo, materia, recoveryKey, modo = 'referencia' }) {
  const chatgpt = require('./chatgptImageService');
  await require('./iaPausaService').garantirLiberada();
  const simbolica = modo === 'simbolica';
  const pedido = simbolica
    ? chatgpt.promptComFormatoFacebook(chatgpt.promptSimbolicoPadrao(), {}, { semReferencia: true })
    : chatgpt.promptComFormatoFacebook(prompt, { titulo, materia });

  const refs = [];
  if (!simbolica) {
    const caminho = await enviarReferencia(await chatgpt.imagemParaUpload(sourceUrl));
    refs.push({ image: { path: caminho, meta: { _type: 'gradio.FileData' } }, caption: null });
  }

  // Ordem dos campos do botão "Generate" do Space: prompt, referências, tamanho,
  // seed, seed aleatória, melhorar prompt, passos, largura, altura, versão.
  // "Melhorar prompt" fica desligado: ele manda texto e foto para um serviço de
  // terceiros (OpenRouter) e o nosso prompt já é completo.
  const inicio = await requisitar(`${HOST}/gradio_api/call/generate`, {
    method: 'POST',
    headers: cabecalhos({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: [pedido, refs, TAMANHO, 0, true, 'Off', PASSOS, 1024, 1024, VERSAO] }),
  });
  if (!inicio.ok) throw traduzirErro(`HTTP ${inicio.status} ${await inicio.text().catch(() => '')}`);
  const { event_id: eventoId } = await inicio.json().catch(() => ({}));
  if (!eventoId) throw erro('O Hugging Face não colocou o pedido na fila.');

  const [arquivo, info] = await aguardarResultado(eventoId);
  if (!arquivo?.url) throw erro('O Qwen (Hugging Face) não devolveu a imagem.');

  const imagem = await baixar(arquivo.url);
  const chave = String(recoveryKey || '').trim();
  if (chave) {
    ultimasGeradas.set(chave, arquivo.url);
    while (ultimasGeradas.size > 200) ultimasGeradas.delete(ultimasGeradas.keys().next().value);
  }
  console.info(`[imagem-qwen] gerada (${Math.round(imagem.buffer.length / 1024)} KB) · ${String(info || '').replace(/`/g, '')}`);
  return { ...imagem, prompt: pedido, model: NOME };
}

/** "Pegar imagem nova gerada": baixa de novo a última desta matéria. */
async function recuperarImagem({ recoveryKey }) {
  const url = ultimasGeradas.get(String(recoveryKey || '').trim());
  if (!url) throw erro(`Ainda não existe imagem recente do ${NOME} para esta matéria. Gere a imagem primeiro.`, 409);
  try {
    return { ...(await baixar(url)), model: NOME };
  } catch (err) {
    // O Space apaga os arquivos temporários depois de um tempo.
    if (err.status === 410) throw erro(`A última imagem do ${NOME} já expirou no Hugging Face. Gere de novo.`, 410);
    throw err;
  }
}

module.exports = { NOME, gerarImagem, recuperarImagem, lerEventoFinal };
