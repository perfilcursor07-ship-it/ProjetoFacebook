/**
 * Geração de imagem pelo Grok (grok.com) e pelo Google Gemini
 * (gemini.google.com), usando as contas logadas no Chrome do servidor — o
 * mesmo Chrome do gateway e do ChatGPT. O login é feito pelo noVNC em /claude.
 *
 * O caminho é o mesmo do ChatGPT web: abre uma aba em segundo plano, anexa a
 * foto de referência (quando houver), envia o pedido e baixa a primeira
 * imagem nova e grande que aparecer na conversa.
 */

const PROVEDORES = Object.freeze({
  grok: {
    nome: 'Grok',
    inicio: 'https://grok.com/',
    // Hosts das páginas de login: se a aba cair aqui, não há sessão.
    login: /accounts\.x\.ai|x\.com\/i\/flow\/login|grok\.com\/sign-in/i,
    // Conversa aberta depois do envio (para "Pegar imagem nova gerada").
    conversa: /^https:\/\/grok\.com\/(c|chat)\/[A-Za-z0-9-]+/i,
    editor: [
      'textarea[aria-label]:visible',
      'div[contenteditable="true"]:visible',
      'textarea:visible',
    ],
    enviar: [
      'button[type="submit"]:not([disabled])',
      'button[aria-label*="Submit" i]:not([disabled])',
      'button[aria-label*="Enviar" i]:not([disabled])',
    ],
    pedido: (prompt) => `Gere uma imagem. ${prompt}`,
  },
  gemini: {
    nome: 'Google Gemini',
    inicio: 'https://gemini.google.com/app',
    login: /accounts\.google\.com/i,
    conversa: /^https:\/\/gemini\.google\.com\/app\/[A-Za-z0-9]+/i,
    editor: [
      'rich-textarea div[contenteditable="true"]:visible',
      'div.ql-editor[contenteditable="true"]:visible',
      'div[contenteditable="true"]:visible',
      'textarea:visible',
    ],
    enviar: [
      'button[aria-label*="Send" i]:not([disabled])',
      'button[aria-label*="Enviar" i]:not([disabled])',
      'button.send-button:not([disabled])',
    ],
    pedido: (prompt) => `Crie uma imagem (geração de imagem). ${prompt}`,
  },
});

const LIMITE_GERACAO_MS = 300_000;
const conversasRecentes = new Map();
const filas = new Map();

function erro(message, status = 400, code = '') {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function provedor(id) {
  const config = PROVEDORES[id];
  if (!config) throw erro(`Gerador de imagem desconhecido: ${id}`, 400);
  return config;
}

/** Uma preparação por site de cada vez: duas abas digitando no mesmo editor se atrapalham. */
async function reservar(id) {
  const anterior = filas.get(id) || Promise.resolve();
  let liberar;
  const atual = new Promise((resolve) => { liberar = resolve; });
  filas.set(id, anterior.then(() => atual));
  await anterior;
  return liberar;
}

async function abrirAba(url) {
  const chatgpt = require('./chatgptImageService');
  const browser = await chatgpt.obterBrowser();
  const context = browser.contexts()[0];
  if (!context) throw erro('O Chrome isolado não disponibilizou um perfil de navegação.', 503);
  const page = await require('./abaEmSegundoPlano').novaAbaEmSegundoPlano(browser, context);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  return page;
}

function erroDeLogin(config) {
  return erro(
    `O ${config.nome} não está logado no Chrome do servidor. Entre pelo desktop privado em /claude, abra ${new URL(config.inicio).host} e faça o login.`,
    401
  );
}

async function aguardarEditor(page, config) {
  const limite = Date.now() + 45_000;
  while (Date.now() < limite) {
    if (config.login.test(page.url())) throw erroDeLogin(config);
    for (const seletor of config.editor) {
      const campo = page.locator(seletor).first();
      if (await campo.count().catch(() => 0)) return campo;
    }
    await page.waitForTimeout(1000);
  }
  if (config.login.test(page.url())) throw erroDeLogin(config);
  throw erro(
    `O campo de mensagem do ${config.nome} não carregou. Confira pelo desktop privado em /claude se há login ou verificação pendente.`,
    503
  );
}

/** Todas as imagens visíveis agora (para achar depois só as novas). */
function fotografarImagens(page) {
  return page.locator('img').evaluateAll((imagens) =>
    imagens.map((img) => img.currentSrc || img.src || '').filter(Boolean)
  ).catch(() => []);
}

/**
 * Anexa a foto: campo de arquivo do próprio site; se não houver, cola no
 * editor (os dois sites aceitam imagem colada). Confirma pela miniatura nova.
 */
async function anexarFoto(page, editor, upload, config) {
  const antes = new Set(await fotografarImagens(page));
  const arquivo = { name: upload.name, mimeType: upload.mimeType, buffer: upload.buffer };

  const campos = page.locator('input[type="file"]');
  const total = await campos.count().catch(() => 0);
  for (let i = 0; i < total; i += 1) {
    const aceita = String(await campos.nth(i).getAttribute('accept').catch(() => '') || '');
    if (aceita && !/image|\*/i.test(aceita)) continue;
    try {
      await campos.nth(i).setInputFiles(arquivo);
      if (await miniaturaApareceu(page, antes)) return;
    } catch {
      // tenta o próximo caminho
    }
  }

  await editor.focus().catch(() => {});
  await editor.evaluate((alvo, dados) => {
    const binario = atob(dados.base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
    const transferencia = new DataTransfer();
    transferencia.items.add(new File([bytes], dados.name, { type: dados.mimeType }));
    let evento;
    try {
      evento = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transferencia });
    } catch {
      evento = new Event('paste', { bubbles: true, cancelable: true });
    }
    if (!evento.clipboardData) Object.defineProperty(evento, 'clipboardData', { value: transferencia });
    alvo.dispatchEvent(evento);
  }, { name: upload.name, mimeType: upload.mimeType, base64: upload.buffer.toString('base64') });
  if (await miniaturaApareceu(page, antes)) return;

  throw erro(
    `Não consegui anexar a foto de referência no ${config.nome}. Tente de novo ou use a ilustração simbólica.`,
    502
  );
}

async function miniaturaApareceu(page, antes, timeout = 15_000) {
  const limite = Date.now() + timeout;
  while (Date.now() < limite) {
    const agora = await fotografarImagens(page);
    if (agora.some((src) => !antes.has(src))) {
      // Espera o upload terminar antes de enviar.
      await page.waitForTimeout(2500);
      return true;
    }
    await page.waitForTimeout(600);
  }
  return false;
}

async function enviar(page, editor, config) {
  for (const seletor of config.enviar) {
    const botao = page.locator(seletor).filter({ visible: true }).last();
    if (await botao.count().catch(() => 0)) {
      try {
        await botao.click({ timeout: 5_000 });
        return;
      } catch {
        // tenta o próximo seletor
      }
    }
  }
  await editor.press('Enter');
}

/**
 * Primeira imagem nova, grande e já carregada por inteiro. Os dois sites
 * mostram uma prévia borrada antes da final; por isso a imagem precisa ficar
 * igual por alguns segundos antes de ser aceita.
 */
async function localizarImagemNova(page, ignoradas, { ultima = false } = {}) {
  const candidatas = await page.locator('img').evaluateAll((imagens) =>
    imagens.map((img) => {
      const caixa = img.getBoundingClientRect();
      return {
        src: img.currentSrc || img.src || '',
        largura: img.naturalWidth || 0,
        altura: img.naturalHeight || 0,
        exibida: caixa.width >= 160 && caixa.height >= 120,
        completa: img.complete,
      };
    })
  ).catch(() => []);
  const boas = candidatas.filter((img) =>
    img.src && !ignoradas.has(img.src) && img.completa && img.exibida && img.largura >= 512 && img.altura >= 512
  );
  // Na recuperação a foto enviada também está na conversa: vale a última.
  return (ultima ? boas.at(-1) : boas[0])?.src || '';
}

async function aguardarImagem(page, ignoradas, config, timeout, opcoes = {}) {
  const limite = Date.now() + timeout;
  let ultima = '';
  let desde = 0;
  while (Date.now() < limite) {
    const src = await localizarImagemNova(page, ignoradas, opcoes);
    if (src && src === ultima && Date.now() - desde >= 4_000) return src;
    if (src !== ultima) {
      ultima = src;
      desde = Date.now();
    }
    await page.waitForTimeout(2_000);
  }
  if (ultima) return ultima;
  const resposta = String(await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  if (/não posso|can't (create|generate)|cannot (create|generate)|policy|polític|diretriz/i.test(resposta.slice(-600))) {
    throw erro(
      `O ${config.nome} recusou gerar esta imagem por suas regras. Use a foto original ou peça uma ilustração simbólica sem pessoas.`,
      422,
      'image_safety_refusal'
    );
  }
  throw erro(`O ${config.nome} não devolveu uma imagem dentro do tempo esperado.`, 502);
}

/** Baixa com os cookies da aba; imagem blob: só existe dentro da página. */
async function baixarImagem(page, src, config) {
  if (/^https?:/i.test(src)) {
    try {
      const resposta = await page.context().request.get(src, { timeout: 60_000 });
      if (resposta.ok()) {
        const tipo = String(resposta.headers()['content-type'] || 'image/jpeg').split(';')[0];
        return { mimeType: tipo, buffer: await resposta.body() };
      }
    } catch {
      // tenta pela página
    }
  }
  const dataUrl = await page.evaluate(async (url) => {
    const resposta = await fetch(url, { credentials: 'include' });
    if (!resposta.ok) throw new Error(`download HTTP ${resposta.status}`);
    const blob = await resposta.blob();
    return new Promise((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onload = () => resolve(leitor.result);
      leitor.onerror = () => reject(leitor.error || new Error('falha ao ler imagem'));
      leitor.readAsDataURL(blob);
    });
  }, src).catch(() => '');
  const partes = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/s);
  if (!partes) throw erro(`O ${config.nome} gerou a imagem, mas não foi possível baixá-la.`, 502);
  return { mimeType: partes[1], buffer: Buffer.from(partes[2], 'base64') };
}

function registrarConversa(recoveryKey, id, url, config) {
  const chave = String(recoveryKey || '').trim();
  if (!chave || !config.conversa.test(String(url || ''))) return;
  conversasRecentes.set(`${id}:${chave}`, { url, em: Date.now() });
  while (conversasRecentes.size > 200) conversasRecentes.delete(conversasRecentes.keys().next().value);
}

async function gerarImagem(id, { sourceUrl, prompt, titulo, materia, recoveryKey, modo = 'referencia' }) {
  const config = provedor(id);
  const chatgpt = require('./chatgptImageService');
  await require('./iaPausaService').garantirLiberada();
  const simbolica = modo === 'simbolica';
  const upload = simbolica ? null : await chatgpt.imagemParaUpload(sourceUrl);
  const pedido = simbolica
    ? chatgpt.promptComFormatoFacebook(chatgpt.promptSimbolicoPadrao(), {}, { semReferencia: true })
    : chatgpt.promptComFormatoFacebook(prompt, { titulo, materia });

  const liberar = await reservar(id);
  let page;
  try {
    page = await abrirAba(config.inicio);
    const editor = await aguardarEditor(page, config);
    if (upload) await anexarFoto(page, editor, upload, config);

    await editor.click().catch(() => {});
    await editor.fill(config.pedido(pedido)).catch(async () => {
      await page.keyboard.insertText(config.pedido(pedido));
    });
    const ignoradas = new Set(await fotografarImagens(page));
    await enviar(page, editor, config);
    await page.waitForTimeout(3_000);
    registrarConversa(recoveryKey, id, page.url(), config);
    liberar();

    const src = await aguardarImagem(page, ignoradas, config, LIMITE_GERACAO_MS);
    registrarConversa(recoveryKey, id, page.url(), config);
    const imagem = await baixarImagem(page, src, config);
    console.info(`[imagem-${id}] gerada (${Math.round(imagem.buffer.length / 1024)} KB)`);
    return { ...imagem, prompt: pedido, model: config.nome };
  } finally {
    liberar();
    if (page) await page.close().catch(() => {});
  }
}

async function recuperarImagem(id, { recoveryKey }) {
  const config = provedor(id);
  const registro = conversasRecentes.get(`${id}:${String(recoveryKey || '').trim()}`);
  if (!registro?.url) {
    throw erro(`Ainda não existe uma conversa recente do ${config.nome} para esta matéria. Gere a imagem primeiro.`, 409);
  }
  const page = await abrirAba(registro.url);
  try {
    if (config.login.test(page.url())) throw erroDeLogin(config);
    const src = await aguardarImagem(page, new Set(), config, 60_000, { ultima: true });
    const imagem = await baixarImagem(page, src, config);
    return { ...imagem, model: config.nome };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { PROVEDORES, gerarImagem, recuperarImagem };
