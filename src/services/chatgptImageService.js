const axios = require('axios');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { env } = require('../config/env');
const { fetchImage } = require('./editorialCardService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const GATEWAY_ROOT = path.resolve(
  process.env.TOKEN_FREE_GATEWAY_SOURCE_DIR || path.join(PROJECT_ROOT, '.tools/token-free-gateway')
);
const AUTH_FILE = process.env.TFG_STORE_PATH || path.join(os.homedir(), '.token-free-gateway', 'auth-profiles.json');
const PLAYWRIGHT_PATH = path.join(GATEWAY_ROOT, 'node_modules', 'playwright-core');
const CHATGPT_MODEL = String(process.env.CHATGPT_IMAGE_MODEL || 'gpt-5.6').trim();
const MAX_PROMPT = 1800;
const FORMATO_FACEBOOK = [
  'REGRA OBRIGATÓRIA DE FORMATO:',
  'gere a imagem em orientação VERTICAL, na proporção EXATA 4:5, equivalente a 1080 × 1350 pixels para uma postagem no feed do Facebook.',
  'Não entregue imagem quadrada nem horizontal. Reorganize a composição para preencher completamente o quadro vertical, sem barras ou bordas.',
].join(' ');
const SEM_TEXTO_NA_IMAGEM = [
  'REGRA OBRIGATÓRIA: a imagem final deve ficar totalmente sem texto.',
  'Remova qualquer palavra, letra, número, legenda, placa legível, logotipo, marca d’água, moldura ou elemento gráfico presente na referência.',
  'Não recrie nem substitua esses elementos por outros textos.',
].join(' ');
const conversasRecentes = new Map();
let conexaoBrowser = null;
let filaPreparacao = Promise.resolve();

async function reservarPreparacao() {
  const anterior = filaPreparacao;
  let liberar;
  filaPreparacao = new Promise((resolve) => { liberar = resolve; });
  await anterior;
  return liberar;
}

async function obterBrowser() {
  if (!conexaoBrowser) {
    const tentativa = (async () => {
      let chromium;
      try {
        ({ chromium } = require(PLAYWRIGHT_PATH));
      } catch {
        throw erro('O módulo de navegador do gateway não está instalado.', 503);
      }
      try {
        return await chromium.connectOverCDP(await websocketCdp(), { timeout: 60_000 });
      } catch (cause) {
        if (cause.status) throw cause;
        // A conexão abre, mas o Playwright precisa se ligar a TODAS as abas;
        // uma aba travada ou abas demais seguram tudo. O log mostra quantas.
        // Em segundo plano: o diagnóstico nunca atrasa nem troca este erro.
        const motivo = String(cause?.message || '').split('\n')[0];
        Promise.resolve()
          .then(() => resumoDasAbas())
          .then((abas) => console.warn(`[chrome] conexão com o Chrome do servidor expirou (${abas}): ${motivo}`))
          .catch(() => {});
        throw erro('O Chrome do servidor (usado pelo ChatGPT, Grok e Gemini) não respondeu a tempo. Em /claude, clique em “Reiniciar gateway” e tente de novo.', 503);
      }
    })();
    conexaoBrowser = tentativa;
    tentativa.then((browser) => {
      browser.on('disconnected', () => {
        if (conexaoBrowser === tentativa) conexaoBrowser = null;
      });
    }, () => {
      if (conexaoBrowser === tentativa) conexaoBrowser = null;
    });
  }
  return conexaoBrowser;
}

async function aguardarEditor(page) {
  const input = page.locator('#prompt-textarea:visible, textarea:visible, [contenteditable="true"]:visible').first();
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    try {
      await input.waitFor({ state: 'visible', timeout: 45_000 });
      return input;
    } catch {
      if (page.isClosed()) throw erro('A conversa do ChatGPT foi fechada antes do envio. Tente novamente.', 503);
      const sessao = await verificarSessaoChatgpt(page);
      if (sessao.estado === 'expirada') {
        throw erro('A sessão do ChatGPT expirou. Entre novamente pela página /claude.', 401);
      }
      // A recarga ocorre somente antes de anexar a foto ou enviar o pedido.
      if (tentativa === 0) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
      }
    }
  }
  throw erro('O campo de mensagem do ChatGPT não carregou. Abra /claude e confira se há algum aviso ou verificação pendente; depois tente novamente.', 503);
}

function erro(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function credenciaisChatgpt() {
  let store;
  try {
    store = JSON.parse(await fs.readFile(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
  const credentials = store?.profiles?.['chatgpt-web']?.credentials;
  return credentials?.cookie || credentials?.accessToken ? credentials : null;
}

function cookiesDoHeader(raw) {
  return String(raw || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf('=');
      if (idx < 1) return null;
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1),
        // `url` cria um cookie host-only válido inclusive para os prefixos
        // __Host-* e __Secure-*. Combinar esses cookies com `domain` fazia o
        // Chrome rejeitar o lote inteiro com Storage.setCookies.
        url: 'https://chatgpt.com/',
        secure: true,
      };
    })
    .filter((cookie) =>
      Boolean(cookie?.name && cookie.value) && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name)
    );
}

async function verificarSessaoChatgpt(page) {
  if (/auth\/login|log-in|\/login(?:[/?#]|$)/i.test(page.url())) {
    return { estado: 'expirada', motivo: 'redirecionado para login' };
  }
  return page.evaluate(async () => {
    try {
      const response = await fetch('/api/auth/session', { credentials: 'include' });
      if (response.status === 401) return { estado: 'expirada', motivo: 'sessão HTTP 401' };
      if (!response.ok) return { estado: 'indefinida', motivo: `sessão HTTP ${response.status}` };
      const data = await response.json().catch(() => null);
      if (data?.accessToken || data?.user?.id || data?.user?.email) {
        return { estado: 'ativa', motivo: 'sessão validada' };
      }
      // Deslogado, o ChatGPT responde 200 com `{}` e ainda mostra o editor,
      // mas sem o botão de anexar: a geração seguia e falhava no anexo.
      const semLogin = data && typeof data === 'object' && !Object.keys(data).length;
      const botaoEntrar = typeof document !== 'undefined'
        && document.querySelector('[data-testid="login-button"], [data-testid="signup-button"]');
      if (semLogin || botaoEntrar) {
        return { estado: 'expirada', motivo: 'ChatGPT aberto sem login' };
      }
      return { estado: 'indefinida', motivo: 'resposta de sessão sem campos conhecidos' };
    } catch {
      return { estado: 'indefinida', motivo: 'consulta de sessão indisponível' };
    }
  }).catch(() => ({ estado: 'indefinida', motivo: 'navegador não respondeu à consulta de sessão' }));
}

async function garantirSessaoChatgpt(page, context, credentials) {
  let sessao = await verificarSessaoChatgpt(page);
  if (sessao.estado === 'ativa') return;

  // O perfil visual do Chrome é a fonte principal. Só reinjeta a cópia de
  // cookies quando houve prova de expiração; um 429/503 da API de sessão não
  // deve substituir cookies atuais nem ser anunciado como logout.
  if (sessao.estado === 'expirada' && credentials?.cookie) {
    const cookies = cookiesDoHeader(credentials.cookie);
    if (cookies.length) {
      await context.addCookies(cookies);
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      sessao = await verificarSessaoChatgpt(page);
    }
  }
  if (sessao.estado === 'expirada') {
    throw erro('A sessão do ChatGPT expirou. Entre novamente pela página /claude.', 401);
  }
  if (sessao.estado === 'ativa') return;

  // A API de sessão pode estar temporariamente indisponível ou mudar seu
  // formato. O editor autenticado, se visível, permite prosseguir com segurança.
  const editor = page.locator('#prompt-textarea:visible, textarea:visible, [contenteditable="true"]:visible').first();
  if (await editor.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)) return;
  throw erro(
    `Não foi possível confirmar a sessão do ChatGPT (${sessao.motivo}). Abra o Chrome em /claude e confira se o ChatGPT carrega normalmente.`,
    503
  );
}

/** "12 abas: grok.com 5, google.com 4, …" — para o log quando o Chrome trava. */
async function resumoDasAbas() {
  try {
    const ws = await websocketCdp();
    const base = ws.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/.*$/, '');
    const { data } = await axios.get(`${base}/json/list`, { timeout: 4000 });
    const paginas = (Array.isArray(data) ? data : []).filter((alvo) => alvo?.type === 'page');
    const porHost = new Map();
    for (const pagina of paginas) {
      let host = 'outra';
      try {
        host = new URL(pagina.url).host || pagina.url;
      } catch {
        // mantém "outra"
      }
      porHost.set(host, (porHost.get(host) || 0) + 1);
    }
    const lista = [...porHost].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([host, n]) => `${host} ${n}`);
    return `${paginas.length} abas${lista.length ? `: ${lista.join(', ')}` : ''}`;
  } catch (err) {
    return `abas desconhecidas (${err.message})`;
  }
}

async function websocketCdp() {
  const configPath = path.join(os.homedir(), '.token-free-gateway', 'config.json');
  let cdpUrl = 'http://127.0.0.1:9222';
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (config?.cdpUrl) cdpUrl = String(config.cdpUrl).replace(/\/$/, '');
  } catch {
    // Usa a porta local padrão do gateway.
  }
  try {
    const { data } = await axios.get(`${cdpUrl}/json/version`, { timeout: 4000 });
    const ws = String(data?.webSocketDebuggerUrl || '').trim();
    if (!ws) throw new Error('CDP sem websocket');
    return ws.replace(/ws:\/\/(0\.0\.0\.0|::)/, 'ws://127.0.0.1');
  } catch {
    throw erro('O Chrome isolado está desligado. Inicie o gateway na página /claude.', 503);
  }
}

async function imagemParaUpload(sourceUrl) {
  const original = await fetchImage(sourceUrl);
  const buffer = await sharp(original, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate()
    .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  return { name: 'imagem-referencia.jpg', mimeType: 'image/jpeg', buffer };
}

function promptPadrao({ titulo = '', materia = '' } = {}) {
  const contexto = [String(titulo || '').trim(), String(materia || '').replace(/\s+/g, ' ').trim().slice(0, 650)]
    .filter(Boolean)
    .join('\n');
  return [
    'Crie uma NOVA imagem editorial fotorrealista inspirada na imagem de referência enviada.',
    'Mantenha o assunto, as pessoas e a atmosfera reconhecíveis, mas reconstrua a cena de forma original e natural.',
    'Não inclua texto, letras, legendas, placas legíveis, logotipos, marcas d’água, molduras ou elementos gráficos.',
    'Composição vertical exata 4:5 (1080 × 1350 pixels), em alta qualidade, adequada como imagem destacada de uma notícia no feed do Facebook.',
    'Não altere a identidade de pessoas públicas presentes na referência e não invente acontecimentos.',
    contexto ? `Contexto da matéria:\n${contexto}` : null,
  ].filter(Boolean).join('\n\n');
}

function promptSimbolicoPadrao() {
  return [
    'Crie uma ilustração editorial original e simbólica sobre fé e esperança.',
    'Mostre luz suave atravessando uma janela e iluminando uma mesa simples com uma Bíblia fechada.',
    'Não represente pessoas, silhuetas, pacientes, hospitais ou um acontecimento real.',
    'A imagem não deve parecer uma fotografia documental da matéria.',
  ].join(' ');
}

function recusaDeSeguranca(resposta) {
  return /guardrails|acceptable depictions of teens and children|violate.*polic|violat.*diretriz|pol[ií]tica de conte[uú]do|não posso gerar essa imagem/i.test(String(resposta || ''));
}

function promptComFormatoFacebook(prompt, contexto = {}, { semReferencia = false } = {}) {
  const pedido = String(prompt || '').trim().slice(0, MAX_PROMPT) || promptPadrao(contexto);
  const regraSemTexto = semReferencia
    ? SEM_TEXTO_NA_IMAGEM.replace('presente na referência', 'que apareça na imagem')
    : SEM_TEXTO_NA_IMAGEM;
  return `${pedido}\n\n${regraSemTexto}\n\n${FORMATO_FACEBOOK}`;
}

async function baixarImagemDaPagina(page, src) {
  const dataUrl = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`download HTTP ${response.status}`);
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('falha ao ler imagem'));
      reader.readAsDataURL(blob);
    });
  }, src);
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) throw erro('O ChatGPT gerou a imagem, mas não foi possível baixá-la.', 502);
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function registrarConversa(recoveryKey, url) {
  const chave = String(recoveryKey || '').trim();
  const conversaUrl = String(url || '').trim();
  if (!chave || !/^https:\/\/chatgpt\.com\/c\/[a-z0-9-]+/i.test(conversaUrl)) return;
  conversasRecentes.set(chave, { url: conversaUrl, updatedAt: Date.now() });
  while (conversasRecentes.size > 200) conversasRecentes.delete(conversasRecentes.keys().next().value);
}

async function localizarImagemGerada(page, ignoradas = new Set()) {
  const imagens = page.locator('img');
  const total = await imagens.count();
  for (let i = total - 1; i >= 0; i -= 1) {
    const candidata = imagens.nth(i);
    const dados = await candidata.evaluate((img) => ({
      src: img.currentSrc || img.src || '',
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
      displayedWidth: img.getBoundingClientRect().width,
      displayedHeight: img.getBoundingClientRect().height,
      alt: img.getAttribute('alt') || '',
      authorRole: img.closest('[data-message-author-role]')?.getAttribute('data-message-author-role') || '',
    })).catch(() => null);
    const imagemNova = dados?.src && !ignoradas.has(dados.src);
    const tamanhoValido = dados?.width >= 256 && dados?.height >= 256;
    const exibicaoValida = dados?.displayedWidth >= 180 && dados?.displayedHeight >= 120;
    const pareceGerada = /generated|gerada|criada|image|imagem/i.test(dados?.alt || '');
    const imagemDaReferencia = dados?.authorRole === 'user'
      || /uploaded image|imagem enviada|anexo do usuário/i.test(dados?.alt || '');
    if (imagemNova && !imagemDaReferencia && tamanhoValido && (exibicaoValida || pareceGerada)) {
      return dados.src;
    }
  }
  return '';
}

async function estadoDosAnexos(composer) {
  return composer.evaluate((root) => {
    // Observar a página inteira gerava falso positivo: avatares, ícones e
    // botões "remover" do histórico eram contados como anexo, e o prompt
    // saía sem a foto. Sinais genéricos só valem dentro do compositor; na
    // página inteira contam apenas prévias locais (blob:/data:) e o nome do arquivo.
    const pagina = root.ownerDocument || document;
    // Compositor: sem <form> nas versões novas, sobe do editor até achar o
    // "+", o enviar ou um campo de arquivo.
    const editor = pagina.querySelector('#prompt-textarea') || pagina.querySelector('[contenteditable="true"]');
    let form = editor?.closest('form, [data-testid="composer"], #composer-background') || null;
    for (let el = editor?.parentElement, i = 0; !form && el && i < 10; el = el.parentElement, i += 1) {
      if (el.querySelector('[data-testid="composer-plus-btn"], [data-testid="send-button"], input[type="file"]')) form = el;
    }
    const texto = String(form?.innerText || '').toLowerCase();
    const previasLocais = [...pagina.querySelectorAll('img')].filter((img) =>
      /^(blob:|data:image\/)/i.test(String(img.currentSrc || img.src || ''))
    ).length;
    const imagensNoCompositor = form
      ? [...form.querySelectorAll('img')].filter((img) => img.naturalWidth >= 32 && img.naturalHeight >= 32).length
      : 0;
    const controlesRemover = form
      ? [...form.querySelectorAll('button, [role="button"]')].filter((node) => {
        const rotulo = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`;
        return /remove|remover|excluir|delete/i.test(rotulo);
      }).length
      : 0;
    const marcadores = form
      ? form.querySelectorAll('[data-testid*="attachment"], [data-testid*="file-thumbnail"], [data-testid*="image-preview"]').length
      : 0;
    return {
      nomeDoArquivo: texto.includes('imagem-referencia'),
      imagens: previasLocais + imagensNoCompositor,
      controlesRemover,
      marcadores,
    };
  });
}

/**
 * A foto foi junto com o pedido? Responde 'sim', 'nao' ou 'desconhecido'.
 *
 * A fonte de verdade é a própria conversa na API do ChatGPT (mensagem do
 * usuário multimodal ou com anexos). Procurar <img> no HTML dava falso
 * negativo: o ChatGPT muda com frequência onde e como mostra a miniatura, e a
 * geração era bloqueada mesmo com a foto enviada.
 */
async function imagemFoiNoPedido(page, timeout = 25_000) {
  const limite = Date.now() + timeout;
  let viaHtml = false;
  while (Date.now() < limite) {
    const idConversa = (String(page.url()).match(/\/c\/([a-z0-9-]+)/i) || [])[1];
    if (idConversa) {
      const viaApi = await page.evaluate(async (id) => {
        try {
          const sessao = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json());
          if (!sessao?.accessToken) return 'desconhecido';
          const resp = await fetch(`/backend-api/conversation/${id}`, {
            credentials: 'include',
            headers: { Authorization: `Bearer ${sessao.accessToken}` },
          });
          if (!resp.ok) return resp.status === 404 ? 'aguardar' : 'desconhecido';
          const dados = await resp.json();
          const doUsuario = Object.values(dados?.mapping || {})
            .map((no) => no?.message)
            .filter((m) => m?.author?.role === 'user');
          if (!doUsuario.length) return 'aguardar';
          const temAnexo = doUsuario.some((m) =>
            m?.content?.content_type === 'multimodal_text' ||
            (m?.content?.parts || []).some((p) => p && typeof p === 'object' && (p.asset_pointer || p.content_type === 'image_asset_pointer')) ||
            (m?.metadata?.attachments || []).length > 0
          );
          return temAnexo ? 'sim' : 'nao';
        } catch {
          return 'desconhecido';
        }
      }, idConversa).catch(() => 'desconhecido');
      if (viaApi === 'sim' || viaApi === 'nao') return viaApi;
    }
    // Plano B: miniatura no turno do usuário (qualquer <img> ou imagem de fundo).
    viaHtml = await page.evaluate(() => {
      const mensagens = document.querySelectorAll('[data-message-author-role="user"]');
      const ultima = mensagens[mensagens.length - 1];
      if (!ultima) return false;
      const turno = ultima.closest('article, section, [data-testid^="conversation-turn"]') || ultima.parentElement || ultima;
      if (turno.querySelector('img, [data-testid*="image" i], [data-testid*="attachment" i]')) return true;
      return [...turno.querySelectorAll('*')].some((el) => /url\(/.test(getComputedStyle(el).backgroundImage || ''));
    }).catch(() => false);
    if (viaHtml) return 'sim';
    await page.waitForTimeout(1000);
  }
  return 'desconhecido';
}

async function aguardarAnexo(composer, anterior, timeout = 35_000) {
  const limite = Date.now() + timeout;
  while (Date.now() < limite) {
    const atual = await estadoDosAnexos(composer).catch(() => null);
    if (atual && (
      atual.nomeDoArquivo
      || atual.imagens > anterior.imagens
      || atual.controlesRemover > anterior.controlesRemover
      || atual.marcadores > anterior.marcadores
    )) return true;
    await composer.page().waitForTimeout(500);
  }
  return false;
}

async function colarImagemNoComposer(input, upload) {
  await input.focus();
  return input.evaluate((target, arquivo) => {
    const binario = atob(arquivo.base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
    const file = new File([bytes], arquivo.name, { type: arquivo.mimeType });
    const transferencia = new DataTransfer();
    transferencia.items.add(file);

    let evento;
    try {
      evento = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transferencia,
      });
    } catch {
      evento = new Event('paste', { bubbles: true, cancelable: true });
    }
    // Algumas versões do Chromium ignoram clipboardData no construtor, mas o
    // ChatGPT consulta essa propriedade no manipulador de paste.
    if (!evento.clipboardData) {
      Object.defineProperty(evento, 'clipboardData', { value: transferencia });
    }
    return target.dispatchEvent(evento);
  }, {
    name: upload.name,
    mimeType: upload.mimeType,
    base64: upload.buffer.toString('base64'),
  });
}

async function soltarImagemNoComposer(input, upload) {
  return input.evaluate((target, arquivo) => {
    const binario = atob(arquivo.base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
    const transferencia = new DataTransfer();
    transferencia.items.add(new File([bytes], arquivo.name, { type: arquivo.mimeType }));
    const alvo = target.closest('form') || target;
    for (const tipo of ['dragenter', 'dragover', 'drop']) {
      alvo.dispatchEvent(new DragEvent(tipo, { bubbles: true, cancelable: true, dataTransfer: transferencia }));
    }
  }, {
    name: upload.name,
    mimeType: upload.mimeType,
    base64: upload.buffer.toString('base64'),
  });
}

async function anexarImagemNoComposer(page, input, upload) {
  // O ChatGPT deixou de envolver o editor num <form>. O compositor passa a
  // ser o primeiro ancestral do editor que tem o "+", o enviar ou um campo de
  // arquivo; sem ele, a página inteira (a confirmação já olha a página toda).
  const candidatos = [
    input.locator('xpath=ancestor::form[1]'),
    input.locator('xpath=ancestor::*[.//*[@data-testid="composer-plus-btn"] or .//*[@data-testid="send-button"] or .//input[@type="file"]][1]'),
    page.locator('#composer-background, [data-testid="composer"]').filter({ visible: true }).first(),
  ];
  let composer = page.locator('body');
  for (const candidato of candidatos) {
    if (await candidato.count().catch(() => 0)) {
      composer = candidato;
      break;
    }
  }

  // A miniatura que o ChatGPT cria pode ficar em um portal fora do <form>.
  // Por isso a confirmação observa a página toda, embora o arquivo continue
  // sendo colocado exclusivamente no input do compositor ativo.
  const areaDeConfirmacao = page.locator('body');
  const anterior = await estadoDosAnexos(areaDeConfirmacao);

  // Colar uma imagem no editor usa o mesmo fluxo suportado pelo ChatGPT para
  // capturas de tela e independe do idioma ou da estrutura do menu de anexos.
  await colarImagemNoComposer(input, upload).catch(() => {});
  if (await aguardarAnexo(areaDeConfirmacao, anterior, 8_000)) return;

  // O ChatGPT deixou de aceitar o paste sintético em algumas versões. Tenta
  // os <input type="file"> existentes, priorizando os que aceitam imagem; cada
  // tentativa é confirmada pela miniatura antes de passar para a próxima.
  const inputsDeArquivo = page.locator('input[type="file"]');
  const totalInputs = await inputsDeArquivo.count();
  const ordem = [];
  for (let i = 0; i < totalInputs; i += 1) {
    const accept = String(await inputsDeArquivo.nth(i).getAttribute('accept').catch(() => '') || '');
    if (/image|\*/i.test(accept) || !accept) ordem.push({ i, prioridade: /image/i.test(accept) ? 0 : 1 });
  }
  ordem.sort((a, b) => a.prioridade - b.prioridade);
  for (const { i } of ordem.slice(0, 4)) {
    const ok = await inputsDeArquivo.nth(i).setInputFiles(upload).then(() => true, () => false);
    if (ok && await aguardarAnexo(areaDeConfirmacao, anterior, 12_000)) return;
  }

  // Arrastar e soltar no compositor usa o mesmo manipulador de "drop" da interface.
  await soltarImagemNoComposer(input, upload).catch(() => {});
  if (await aguardarAnexo(areaDeConfirmacao, anterior, 10_000)) return;

  // Último recurso: aciona o fluxo real do menu de anexos.
  const botaoAnexar = page.locator([
    '[data-testid="composer-plus-btn"]:visible',
    'button[aria-label*="Attach" i]:visible',
    'button[aria-label*="Anex" i]:visible',
    'button[aria-label*="Adicionar" i]:visible',
  ].join(',')).last();
  if (!(await botaoAnexar.count())) {
    const info = await page.evaluate(() => ({
      url: location.pathname,
      entrar: Boolean(document.querySelector('[data-testid="login-button"], [data-testid="signup-button"]')),
      inputs: document.querySelectorAll('input[type="file"]').length,
    })).catch(() => ({}));
    console.warn('[chatgpt-imagem] botão de anexar ausente', info);
    if (info.entrar) {
      throw erro('O ChatGPT do servidor está sem login (sem login não há como anexar a foto). Entre novamente pela página /claude.', 401);
    }
    throw erro(`O botão de anexar imagem não foi encontrado no ChatGPT (página ${info.url || '?'}, ${info.inputs ?? '?'} campos de arquivo).`, 502);
  }

  let escolhaPromise = page.waitForEvent('filechooser', { timeout: 2500 }).catch(() => null);
  await botaoAnexar.click();
  let escolha = await escolhaPromise;

  if (!escolha) {
    let opcaoUpload = page.locator([
      '[role="menuitem"]:has-text("Adicionar fotos e arquivos"):visible',
      '[role="menuitem"]:has-text("Add photos & files"):visible',
      '[role="menuitem"]:has-text("Carregar do computador"):visible',
      '[role="menuitem"]:has-text("Upload from computer"):visible',
      '[role="menuitem"]:has-text("Enviar arquivo"):visible',
      '[role="menuitem"]:has-text("Upload file"):visible',
      'button:has-text("Adicionar fotos e arquivos"):visible',
      'button:has-text("Add photos & files"):visible',
      'button:has-text("Carregar do computador"):visible',
      'button:has-text("Upload from computer"):visible',
    ].join(',')).first();

    try {
      await opcaoUpload.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      const opcaoGenerica = page.locator('[role="menuitem"]:visible, [role="option"]:visible')
        .filter({ hasText: /foto|photo|arquivo|file|upload|carregar/i })
        .first();
      if (await opcaoGenerica.count()) {
        opcaoUpload = opcaoGenerica;
      } else {
        throw erro('O ChatGPT não aceitou a imagem de referência (colar, campo de arquivo, arrastar e menu de anexos falharam). Confira se o ChatGPT abre normalmente no Chrome da página /claude.', 502);
      }
    }
    if (!escolha) {
      escolhaPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
      await opcaoUpload.click();
      escolha = await escolhaPromise;
    }
  }

  if (escolha) {
    await escolha.setFiles(upload);
  } else {
    // Compatibilidade com versões que não disparam filechooser, mas criam o
    // input correto somente depois de clicar na opção da interface.
    const inputAberto = composer.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (!(await inputAberto.count())) throw erro('O seletor de arquivos do ChatGPT não abriu.', 502);
    await inputAberto.setInputFiles(upload);
  }

  if (!(await aguardarAnexo(areaDeConfirmacao, anterior))) {
    const diagnostico = await page.evaluate(() => ({
      url: location.href,
      inputs: [...document.querySelectorAll('input[type="file"]')].map((node) => ({
        accept: node.getAttribute('accept') || '',
        files: [...(node.files || [])].map((file) => file.name),
        noFormulario: Boolean(node.closest('form')),
      })),
    })).catch(() => null);
    console.warn('[chatgpt-imagem] anexo não confirmado', diagnostico);
    throw erro(
      'A imagem de referência não foi anexada ao ChatGPT. O prompt não foi enviado; tente novamente.',
      502
    );
  }
}

/**
 * A miniatura aparece antes de a foto terminar de subir. Enviar nesse meio
 * tempo pode mandar o pedido sem a foto; espera sumir o indicador de envio
 * (barra de progresso ou elemento ocupado) no compositor, até 45 s.
 */
async function aguardarUploadDoAnexo(page, timeout = 45_000) {
  const limite = Date.now() + timeout;
  await page.waitForTimeout(800);
  while (Date.now() < limite) {
    const enviando = await page.evaluate(() => {
      const editor = document.querySelector('#prompt-textarea') || document.querySelector('[contenteditable="true"]');
      let form = editor?.closest('form, [data-testid="composer"], #composer-background') || null;
      for (let el = editor?.parentElement, i = 0; !form && el && i < 10; el = el.parentElement, i += 1) {
        if (el.querySelector('[data-testid="composer-plus-btn"], [data-testid="send-button"], input[type="file"]')) form = el;
      }
      if (!form) return false;
      return Boolean(form.querySelector('[role="progressbar"], [aria-busy="true"], circle[stroke-dasharray]'));
    }).catch(() => false);
    if (!enviando) return;
    await page.waitForTimeout(700);
  }
  console.warn('[chatgpt-imagem] a foto ainda parecia estar subindo após 45 s; enviando mesmo assim');
}

async function executarGeracao({ sourceUrl, prompt, titulo, materia, recoveryKey, modo = 'referencia' }) {
  const credentials = await credenciaisChatgpt();
  const simbolica = modo === 'simbolica';
  const upload = simbolica ? null : await imagemParaUpload(sourceUrl);
  const liberarPreparacao = await reservarPreparacao();
  let page;
  try {
    const browser = await obterBrowser();
    const context = browser.contexts()[0];
    if (!context) throw erro('O Chrome isolado não disponibilizou um perfil de navegação.', 503);
    page = await require('./abaEmSegundoPlano').novaAbaEmSegundoPlano(browser, context);
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await garantirSessaoChatgpt(page, context, credentials);

    const input = await aguardarEditor(page);
    if (upload) {
      await anexarImagemNoComposer(page, input, upload);
      await aguardarUploadDoAnexo(page);
    }

    const pedido = simbolica
      ? promptComFormatoFacebook(promptSimbolicoPadrao(), {}, { semReferencia: true })
      : promptComFormatoFacebook(prompt, { titulo, materia });
    await input.fill(pedido);
    // A referência anexada também é um <img>. Guardamos tudo que já existe
    // para buscar somente a nova imagem criada depois do envio.
    const imagensAntesDoEnvio = new Set(await page.locator('img').evaluateAll((imagens) =>
      imagens.map((img) => img.currentSrc || img.src || '').filter(Boolean)
    ));
    const sendButton = page.locator(
      '[data-testid="send-button"]:not([disabled]), button[aria-label*="Send prompt" i]:not([disabled]), button[aria-label*="Enviar" i]:not([disabled])'
    ).first();
    try {
      await sendButton.waitFor({ state: 'visible', timeout: 30_000 });
      await sendButton.click();
    } catch {
      // A interface pode trocar o seletor; Enter mantém compatibilidade com
      // versões em que o botão não possui data-testid/aria-label estável.
      await page.waitForTimeout(1800);
      await input.press('Enter');
    }

    await page.waitForURL(/https:\/\/chatgpt\.com\/c\//i, { timeout: 30_000 }).catch(() => {});
    registrarConversa(recoveryKey, page.url());
    liberarPreparacao();

    if (upload) {
      const foto = await imagemFoiNoPedido(page);
      // Só bloqueia com prova de que a foto não foi. Sem confirmação (API fora
      // do ar ou HTML diferente), segue: se o ChatGPT pedir a foto, a resposta
      // dele aparece no erro abaixo, em vez de um falso "não chegou".
      if (foto === 'nao') {
        throw erro(
          'A imagem de referência não chegou ao ChatGPT junto com o pedido. Tente gerar novamente.',
          502
        );
      }
      if (foto === 'desconhecido') {
        console.warn('[chatgpt-imagem] não confirmei a foto no pedido; aguardando a resposta mesmo assim', page.url());
      }
    }

    const limite = Date.now() + 300_000;
    let src = '';
    while (Date.now() < limite && !src) {
      // Nas versões atuais, a arte pode ser renderizada fora do elemento com
      // data-message-author-role="assistant". Procura na conversa inteira.
      src = await localizarImagemGerada(page, imagensAntesDoEnvio);
      if (!src) {
        const respostaAtual = String(await page.locator('[data-message-author-role="assistant"]').last().innerText().catch(() => ''));
        if (recusaDeSeguranca(respostaAtual)) {
          const falha = erro('O ChatGPT recusou gerar esta imagem por suas regras de segurança. Use a foto original ou peça uma ilustração simbólica sem pessoas.', 422);
          falha.code = 'image_safety_refusal';
          throw falha;
        }
        await page.waitForTimeout(2000);
      }
    }
    if (!src) {
      const assistant = page.locator('[data-message-author-role="assistant"]').last();
      const resposta = String(await assistant.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      throw erro(
        resposta
          ? `O ChatGPT não devolveu uma imagem: ${resposta.slice(0, 240)}`
          : 'O ChatGPT não concluiu a imagem dentro do tempo esperado.',
        502
      );
    }
    const result = await baixarImagemDaPagina(page, src);
    return { ...result, prompt: pedido, model: CHATGPT_MODEL };
  } finally {
    liberarPreparacao();
    if (page) await require('./abaEmSegundoPlano').fecharAba(page);
  }
}

async function recuperarImagem({ recoveryKey }) {
  const registro = conversasRecentes.get(String(recoveryKey || '').trim());
  if (!registro?.url) {
    throw erro('Ainda não existe uma conversa recente do ChatGPT para esta matéria. Gere a imagem primeiro.', 409);
  }

  const browser = await obterBrowser();
  const context = browser.contexts()[0];
  if (!context) throw erro('O Chrome isolado não disponibilizou um perfil de navegação.', 503);
  const page = await require('./abaEmSegundoPlano').novaAbaEmSegundoPlano(browser, context);
  try {
    await page.goto(registro.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await garantirSessaoChatgpt(page, context, await credenciaisChatgpt());
    const limite = Date.now() + 60_000;
    let src = '';
    while (Date.now() < limite && !src) {
      src = await localizarImagemGerada(page);
      if (!src) await page.waitForTimeout(1500);
    }
    if (!src) throw erro('Nenhuma imagem gerada foi encontrada na última conversa do ChatGPT.', 404);
    const result = await baixarImagemDaPagina(page, src);
    return { ...result, model: CHATGPT_MODEL };
  } finally {
    await require('./abaEmSegundoPlano').fecharAba(page);
  }
}

// API oficial de imagens (opcional). Com OPENAI_API_KEY no .env, a imagem sai
// direto da API — mais rápida e sem depender da tela do ChatGPT no Chrome.
// Sem a chave (ou se a API falhar), continua o fluxo pelo ChatGPT web.
const OPENAI_IMAGE_MODEL = String(process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare').trim();
// 4:5 exato com lados múltiplos de 16, como a API exige.
const OPENAI_IMAGE_SIZE = '1088x1360';

async function gerarViaApiOpenAI({ sourceUrl, prompt, titulo, materia, modo = 'referencia' }) {
  const chave = String(process.env.OPENAI_API_KEY || '').trim();
  const simbolica = modo === 'simbolica';
  const pedido = simbolica
    ? promptComFormatoFacebook(promptSimbolicoPadrao(), {}, { semReferencia: true })
    : promptComFormatoFacebook(prompt, { titulo, materia });
  const comum = {
    model: OPENAI_IMAGE_MODEL,
    prompt: pedido,
    size: OPENAI_IMAGE_SIZE,
    quality: String(process.env.OPENAI_IMAGE_QUALITY || 'medium'),
    output_format: 'jpeg',
    n: '1',
  };
  let resposta;
  if (simbolica) {
    resposta = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...comum, n: 1 }),
      signal: AbortSignal.timeout(180_000),
    });
  } else {
    const referencia = await imagemParaUpload(sourceUrl);
    const form = new FormData();
    for (const [campo, valor] of Object.entries(comum)) form.append(campo, valor);
    form.append('image', new Blob([referencia.buffer], { type: referencia.mimeType }), referencia.name);
    resposta = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${chave}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
  }
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const mensagem = dados?.error?.message || `API de imagens HTTP ${resposta.status}`;
    const falha = erro(mensagem, resposta.status >= 500 ? 502 : resposta.status);
    falha.code = dados?.error?.code || '';
    throw falha;
  }
  const b64 = dados?.data?.[0]?.b64_json;
  if (!b64) throw erro('A API de imagens respondeu sem imagem.', 502);
  return {
    mimeType: 'image/jpeg',
    buffer: Buffer.from(b64, 'base64'),
    prompt: pedido,
    model: `${OPENAI_IMAGE_MODEL} (API)`,
  };
}

function recusaDaApi(err) {
  return /moderation|safety|content_policy/i.test(`${err?.code || ''} ${err?.message || ''}`);
}

async function gerarImagem(args) {
  // "Parar IA": pausar o ChatGPT (ou tudo) também para a geração de imagem.
  const pausa = require('./iaPausaService');
  await pausa.garantirLiberada(CHATGPT_MODEL);
  if (String(process.env.OPENAI_API_KEY || '').trim()) await pausa.garantirLiberada(OPENAI_IMAGE_MODEL);
  if (String(process.env.OPENAI_API_KEY || '').trim()) {
    const inicio = Date.now();
    try {
      const resultado = await gerarViaApiOpenAI(args);
      console.info(`[chatgpt-imagem] gerada pela API (${OPENAI_IMAGE_MODEL}) em ${((Date.now() - inicio) / 1000).toFixed(1)}s`);
      return resultado;
    } catch (err) {
      if (recusaDaApi(err)) {
        const falha = erro('A OpenAI recusou gerar esta imagem por suas regras de segurança. Use a foto original ou peça uma ilustração simbólica sem pessoas.', 422);
        falha.code = 'image_safety_refusal';
        throw falha;
      }
      console.warn('[chatgpt-imagem] API de imagens falhou; tentando pelo ChatGPT web:', err.message);
    }
  }
  return executarGeracao(args);
}

module.exports = {
  gerarImagem,
  recuperarImagem,
  promptPadrao,
  promptSimbolicoPadrao,
  recusaDeSeguranca,
  promptComFormatoFacebook,
  // Reaproveitados pela geração no Grok e no Gemini (imagemWebService).
  obterBrowser,
  imagemParaUpload,
  // Exposto somente para validar a compatibilidade dos cookies do Chrome.
  cookiesDoHeader,
  verificarSessaoChatgpt,
  garantirSessaoChatgpt,
};
