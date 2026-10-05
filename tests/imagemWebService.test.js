const test = require('node:test');
const assert = require('node:assert/strict');

const chatgpt = require('../src/services/chatgptImageService');
const aba = require('../src/services/abaEmSegundoPlano');
const pausa = require('../src/services/iaPausaService');
const web = require('../src/services/imagemWebService');

/**
 * Página falsa no formato do Playwright: só o que o serviço usa. As imagens
 * da página mudam conforme o roteiro (anexo → miniatura, envio → resultado).
 */
function paginaFalsa({ url = 'https://grok.com/', aposEnvio = [], logado = true } = {}) {
  const estado = { url: logado ? url : 'https://accounts.x.ai/sign-in', imagens: [], texto: '', anexou: false, enviou: false, baixou: null };
  const imagem = (src, w = 1024, h = 1280) => ({ src, largura: w, altura: h, exibida: true, completa: true });
  const localizador = (seletor) => {
    const api = {
      first: () => api,
      last: () => api,
      nth: () => api,
      filter: () => api,
      count: async () => {
        if (seletor === 'img') return estado.imagens.length;
        if (seletor.startsWith('input[type="file"]')) return 1;
        if (/contenteditable|textarea/.test(seletor)) return estado.url.includes('sign-in') ? 0 : 1;
        if (/button/.test(seletor)) return 1;
        return 0;
      },
      getAttribute: async () => 'image/*',
      setInputFiles: async () => {
        estado.anexou = true;
        estado.imagens.push(imagem('blob:miniatura', 600, 600));
      },
      evaluateAll: async (fn) => {
        // fotografarImagens pede a lista de src; localizarImagemNova pede os detalhes.
        const texto = String(fn);
        return texto.includes('naturalWidth')
          ? estado.imagens
          : estado.imagens.map((i) => i.src);
      },
      click: async () => {
        if (/button/.test(seletor)) {
          estado.enviou = true;
          estado.url = 'https://grok.com/c/abc123';
          setTimeout(() => estado.imagens.push(...aposEnvio.map((s) => imagem(s))), 0);
        }
      },
      fill: async (t) => { estado.texto = t; },
      focus: async () => {},
      press: async () => {},
      evaluate: async () => {},
      innerText: async () => '',
    };
    return api;
  };
  const page = {
    estado,
    goto: async () => {},
    url: () => estado.url,
    locator: localizador,
    // Cede a vez ao event loop (o resultado chega por setTimeout).
    waitForTimeout: () => new Promise((resolve) => setTimeout(resolve, 5)),
    keyboard: { insertText: async () => {} },
    evaluate: async () => '',
    context: () => ({
      request: {
        get: async (src) => {
          estado.baixou = src;
          return { ok: () => true, headers: () => ({ 'content-type': 'image/png' }), body: async () => Buffer.from('png') };
        },
      },
    }),
    close: async () => {},
  };
  return page;
}

function preparar(page) {
  const originais = [chatgpt.obterBrowser, chatgpt.imagemParaUpload, aba.novaAbaEmSegundoPlano, pausa.garantirLiberada];
  chatgpt.obterBrowser = async () => ({ contexts: () => [{}] });
  chatgpt.imagemParaUpload = async () => ({ name: 'ref.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpg') });
  aba.novaAbaEmSegundoPlano = async () => page;
  pausa.garantirLiberada = async () => {};
  return () => {
    [chatgpt.obterBrowser, chatgpt.imagemParaUpload, aba.novaAbaEmSegundoPlano, pausa.garantirLiberada] = originais;
  };
}

test('Grok: anexa a foto, envia o pedido e baixa a imagem nova (não a miniatura)', async () => {
  const page = paginaFalsa({ aposEnvio: ['https://assets.grok.com/gerada.jpg'] });
  const restaurar = preparar(page);
  try {
    const r = await web.gerarImagem('grok', { sourceUrl: 'https://x/foto.jpg', prompt: 'Uma cena editorial', recoveryKey: '1:9' });
    assert.equal(page.estado.anexou, true);
    assert.equal(page.estado.enviou, true);
    assert.match(page.estado.texto, /^Gere uma imagem\./);
    assert.match(page.estado.texto, /4:5/);
    assert.equal(page.estado.baixou, 'https://assets.grok.com/gerada.jpg');
    assert.equal(r.model, 'Grok');
    assert.equal(r.mimeType, 'image/png');
  } finally {
    restaurar();
  }
});

test('ilustração simbólica não anexa foto', async () => {
  const page = paginaFalsa({ aposEnvio: ['https://assets.grok.com/simbolica.jpg'] });
  const restaurar = preparar(page);
  try {
    await web.gerarImagem('grok', { modo: 'simbolica', recoveryKey: '1:10' });
    assert.equal(page.estado.anexou, false);
    assert.equal(page.estado.baixou, 'https://assets.grok.com/simbolica.jpg');
  } finally {
    restaurar();
  }
});

test('sem login no site, o erro manda entrar pelo desktop privado', async () => {
  const page = paginaFalsa({ logado: false });
  const restaurar = preparar(page);
  try {
    await assert.rejects(
      web.gerarImagem('grok', { modo: 'simbolica' }),
      (err) => err.status === 401 && /não está logado/.test(err.message) && /\/claude/.test(err.message)
    );
  } finally {
    restaurar();
  }
});
