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
 *   errada (404, ou 403 no download — imediato, sem gastar GPU);
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
    // Arquivo pedido à réplica que não o gerou: o Gradio responde 403 ou 404.
    if (resposta.status !== 404 && resposta.status !== 403) break;
  }
  if (!resposta.ok) throw erro(`O Qwen gerou a imagem, mas o download falhou (HTTP ${resposta.status}).`, [403, 404].includes(resposta.status) ? 410 : 502);
  const buffer = Buffer.from(await resposta.arrayBuffer());
  if (!buffer.length) throw erro('O Qwen devolveu uma imagem vazia.');
  return { buffer, mimeType: String(resposta.headers.get('content-type') || 'image/png').split(';')[0] };
}

/**
 * Pedidos do Qwen. O prompt do ChatGPT (português, longo, com o título da
 * matéria no fim) não servia: o Qwen segue melhor instruções curtas em inglês
 * e é ótimo em DESENHAR texto — mandar o título no pedido convidava a imagem a
 * sair com letras, e era preciso gerar duas vezes para limpar.
 */
const SEM_TEXTO =
  'The final image must contain absolutely no text: no words, letters, numbers, captions, headlines, subtitles, ' +
  'logos, watermarks, banners, lower thirds, frames or graphic overlays anywhere.';
const PEDIDO_LIMPAR =
  'Remove ALL text and graphic overlays from this photo: every headline, caption, subtitle, word, letter, number, ' +
  'logo, watermark, banner, lower third, frame and sticker. Rebuild those areas naturally with the surrounding ' +
  'background so no trace remains. Keep the same people, faces, identity, clothing, pose, setting, lighting and ' +
  'composition. Photorealistic editorial news photo, vertical framing. ' + SEM_TEXTO;
const PEDIDO_LIMPAR_DE_NOVO =
  'This image still has some text left. Erase every remaining word, letter, number, logo and watermark completely, ' +
  'filling the area with the natural background. Change nothing else in the photo. ' + SEM_TEXTO;
const PEDIDO_SIMBOLICO =
  'Original symbolic editorial illustration about faith and hope: soft light coming through a window onto a simple ' +
  'wooden table with a closed Bible. No people, no silhouettes, no hospital, not a documentary photo of a real event. ' +
  'Vertical framing. ' + SEM_TEXTO;

/** O pedido padrão da capa (ChatGPT) começa assim; pedido personalizado do editor, não. */
function pedidoPadraoDoSistema(prompt) {
  const t = String(prompt || '').trim();
  return !t || /^crie uma nova imagem editorial fotorrealista inspirada/i.test(t);
}

function pedidoParaQwen({ prompt, simbolica }) {
  if (simbolica) return PEDIDO_SIMBOLICO;
  if (pedidoPadraoDoSistema(prompt)) return PEDIDO_LIMPAR;
  // Pedido escrito pelo editor: vai como está, sem título/matéria, com a regra do texto.
  return `${String(prompt).trim().slice(0, 1500)}

Keep the people and their identity from the reference photo. ${SEM_TEXTO}`;
}

/** Foto em JPEG ≤1536 px para subir como referência. */
async function paraReferencia(buffer) {
  const jpeg = await require('sharp')(buffer, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate()
    .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  return { name: 'referencia.jpg', mimeType: 'image/jpeg', buffer: jpeg };
}

/** Uma chamada ao Space: devolve a imagem, o link dela e a linha de info. */
async function gerarNoSpace(pedido, referencia = null) {
  const refs = [];
  if (referencia) {
    const caminho = await enviarReferencia(referencia);
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
  return { ...(await baixar(arquivo.url)), url: arquivo.url, info: String(info || '').replace(/`/g, '') };
}

/** Passadas extras de limpeza quando o OCR ainda acha texto na imagem. */
const LIMPEZAS_EXTRAS = 2;

/** OCR da imagem gerada; falha do OCR não impede a entrega. */
async function aindaTemTexto(buffer) {
  try {
    const ocr = await require('./imageOcrService').analisarTextoDaImagem(buffer);
    return ocr.temTexto ? ocr : null;
  } catch (err) {
    console.warn('[imagem-qwen] OCR falhou, sigo sem conferir o texto:', err.message);
    return null;
  }
}

/**
 * Mesmo contrato do ChatGPT/Grok/Gemini (imagemIaService): com a foto da
 * notícia como referência, edita; no modo 'simbolica', cria do zero.
 *
 * O editor clica UMA vez: se o OCR ainda achar texto no resultado, a imagem
 * volta ao Qwen para mais uma limpeza (até LIMPEZAS_EXTRAS) antes de entregar.
 */
async function gerarImagem({ sourceUrl, prompt, recoveryKey, modo = 'referencia' }) {
  await require('./iaPausaService').garantirLiberada();
  const simbolica = modo === 'simbolica';
  const pedido = pedidoParaQwen({ prompt, simbolica });
  const referencia = simbolica ? null : await require('./chatgptImageService').imagemParaUpload(sourceUrl);

  let imagem = await gerarNoSpace(pedido, referencia);
  console.info(`[imagem-qwen] gerada (${Math.round(imagem.buffer.length / 1024)} KB) · ${imagem.info}`);
  for (let passada = 1; passada <= LIMPEZAS_EXTRAS; passada += 1) {
    const ocr = await aindaTemTexto(imagem.buffer);
    if (!ocr) break;
    console.info(`[imagem-qwen] ainda tem texto (${ocr.palavras} palavras, OCR ${ocr.confianca}%) — limpeza extra ${passada}/${LIMPEZAS_EXTRAS}`);
    imagem = await gerarNoSpace(PEDIDO_LIMPAR_DE_NOVO, await paraReferencia(imagem.buffer));
  }

  const chave = String(recoveryKey || '').trim();
  if (chave) {
    ultimasGeradas.set(chave, imagem.url);
    while (ultimasGeradas.size > 200) ultimasGeradas.delete(ultimasGeradas.keys().next().value);
  }
  return { buffer: imagem.buffer, mimeType: imagem.mimeType, prompt: pedido, model: NOME };
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
