/**
 * "ChatGPT livre" do /materia-manual: a conversa acontece no próprio
 * chatgpt.com, no Chrome do servidor (o mesmo do VNC e da geração de imagem).
 * O ChatGPT pesquisa, escreve e mostra a imagem do jeito dele; aqui só
 * levamos o pedido, esperamos a resposta terminar e trazemos de volta o
 * texto, os links citados e a imagem.
 *
 * Cada conversa do Viralizei corresponde a uma conversa do ChatGPT
 * (https://chatgpt.com/c/<id>): as mensagens seguintes ("outra", "mais
 * curta"…) continuam nela, e o ChatGPT lembra do contexto.
 */

const chatgpt = require('./chatgptImageService');

/** Pesquisa + raciocínio + imagem podem levar alguns minutos no ChatGPT. */
const LIMITE_RESPOSTA_MS = Number(process.env.CHATGPT_LIVRE_LIMITE_MS) || 6 * 60_000;
/** A resposta é dada como pronta quando o texto fica parado por este tempo. */
const ESTAVEL_MS = 5_000;
/**
 * Depois disto sem achar a resposta no DOM, o log recebe o retrato da aba.
 *
 * Nenhuma resposta aparece em menos que isso, então não há alarme falso; e
 * esperar os 6 minutos do limite para só então contar o que houve deixava o
 * editor olhando "pesquisando e escrevendo…" para uma conversa já respondida.
 */
const AVISO_SEM_RESPOSTA_MS = Number(process.env.CHATGPT_LIVRE_AVISO_MS) || 40_000;
const URL_CONVERSA = /^https:\/\/chatgpt\.com\/c\/[a-z0-9-]+/i;

/**
 * Só na primeira mensagem: pede o formato que o painel "Pronta para publicar"
 * entende (título na 1ª linha) e a imagem da notícia. O resto é com o ChatGPT.
 */
const ORIENTACAO_PRIMEIRA = [
  '',
  '(Como responder nesta conversa: entregue a matéria pronta, com o título na primeira linha e o texto em parágrafos logo abaixo, sem comentários antes ou depois.',
  'Mostre junto uma imagem da notícia — de preferência a foto real publicada pelos veículos; se não houver, gere uma imagem sem texto.',
  'Cite os links das fontes que usou.)',
].join('\n');

function erro(message, status = 502, code = '') {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

/**
 * Tempo de cada etapa, para o log dizer onde a demora está.
 *
 * "Está demorando" não dá para consertar sem saber se o tempo é da aba, do
 * carregamento do chatgpt.com, da sessão ou do próprio ChatGPT pensando — só
 * o último é inevitável.
 */
function cronometro() {
  const marcas = [];
  let ultimo = Date.now();
  return {
    marcar(nome) {
      const agora = Date.now();
      marcas.push(`${nome} ${((agora - ultimo) / 1000).toFixed(1)}s`);
      ultimo = agora;
    },
    resumo() {
      return marcas.join(' | ');
    },
  };
}

// Versões do ChatGPT marcam a resposta de jeitos diferentes: aceita os dois.
const SELETOR_ASSISTENTE = '[data-message-author-role="assistant"]';
const SELETOR_TURNO_ASSISTENTE = 'article[data-turn="assistant"], [data-testid^="conversation-turn"][data-turn="assistant"]';
const SELETOR_PARAR = '[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Parar" i]';
/** Último recurso: qualquer turno da conversa, seja de quem for. */
const SELETOR_TURNO = 'article, [data-testid^="conversation-turn"]';
const SELETOR_USUARIO = '[data-message-author-role="user"], [data-turn="user"]';

/**
 * Os quatro seletores, na ordem em que são tentados dentro da página.
 *
 * O terceiro caminho ("turno que não é do usuário") existe porque o ChatGPT
 * troca os atributos do DOM de tempos em tempos: quando os dois primeiros
 * param de casar, a conversa some para nós mesmo estando na tela, e a espera
 * ia até o limite de 6 minutos sem dizer por quê.
 */
const SELETORES = [SELETOR_ASSISTENTE, SELETOR_TURNO_ASSISTENTE, SELETOR_TURNO, SELETOR_USUARIO];

/** Quantas respostas do ChatGPT a conversa já tem (para achar a nova). */
function contarRespostas(page) {
  return page
    .evaluate(([porPapel, porTurno, qualquerTurno, doUsuario]) => {
      const papel = document.querySelectorAll(porPapel).length;
      if (papel) return papel;
      const turno = document.querySelectorAll(porTurno).length;
      if (turno) return turno;
      return [...document.querySelectorAll(qualquerTurno)].filter(
        (t) => !t.matches(doUsuario) && !t.querySelector(doUsuario)
      ).length;
    }, SELETORES)
    .catch(() => 0);
}

/** Última falha ao ler a página — vai para o diagnóstico em vez de sumir. */
let ultimoErroLeitura = null;

/**
 * Lê a última resposta: texto (só a parte em markdown, sem botões), links
 * citados e imagens do turno inteiro — a foto pode vir fora da mensagem.
 */
function lerUltimaResposta(page) {
  return page.evaluate(([seletor, seletorTurno, qualquerTurno, doUsuario]) => {
    const porPapel = [...document.querySelectorAll(seletor)];
    const porTurno = [...document.querySelectorAll(seletorTurno)];
    let mensagens = porPapel.length >= porTurno.length ? porPapel : porTurno;
    let via = porPapel.length >= porTurno.length ? 'papel' : 'turno';
    if (!mensagens.length) {
      // Marcadores mudaram: fica o turno que não é do usuário.
      mensagens = [...document.querySelectorAll(qualquerTurno)].filter(
        (t) => !t.matches(doUsuario) && !t.querySelector(doUsuario)
      );
      via = 'reserva';
    }
    const ultima = mensagens[mensagens.length - 1];
    if (!ultima) return null;
    const turno = ultima.closest('article, [data-testid^="conversation-turn"]') || ultima.parentElement || ultima;
    // Etiquetas de citação ("g1 +2") ficam fora do texto da matéria.
    const semCitacoes = (el) => {
      const copia = el.cloneNode(true);
      copia.querySelectorAll('[data-testid*="citation" i], [class*="citation" i], [data-testid*="webpage" i]')
        .forEach((c) => c.remove());
      // Cópia fora da página não tem innerText com quebras: junta por bloco.
      const partes = [...copia.querySelectorAll('h1, h2, h3, h4, p, li, blockquote')]
        .filter((b) => !b.parentElement.closest('p, li, blockquote'))
        .map((b) => b.textContent.trim())
        .filter(Boolean);
      return partes.length ? partes.join('\n\n') : copia.textContent;
    };
    const blocos = [...ultima.querySelectorAll('.markdown')];
    const texto = (blocos.length ? blocos.map(semCitacoes).join('\n\n') : semCitacoes(ultima)) || '';
    const links = [...turno.querySelectorAll('a[href^="http"]')]
      .map((a) => ({ url: a.href, titulo: (a.innerText || a.getAttribute('aria-label') || '').trim() }))
      .filter((l) => !/chatgpt\.com|openai\.com/i.test(l.url));
    const imagens = [...turno.querySelectorAll('img')]
      .map((img) => ({
        src: img.currentSrc || img.src || '',
        largura: img.naturalWidth || 0,
        altura: img.naturalHeight || 0,
        naTela: img.getBoundingClientRect().width,
        alt: img.getAttribute('alt') || '',
      }))
      // Ícone de site citado, avatar e favicon ficam de fora: precisa ser
      // grande no arquivo E aparecer grande na conversa.
      .filter((i) => i.src && i.largura >= 300 && i.altura >= 200 && i.naTela >= 100);
    return { texto, links, imagens, total: mensagens.length, via };
  }, SELETORES).catch((err) => {
    // Troca de página no meio (nova conversa vira /c/<id>) é passageira.
    ultimoErroLeitura = String(err?.message || err).split('\n')[0].slice(0, 200);
    return null;
  });
}

/**
 * Retrato da aba quando algo dá errado: o que havia na página e um print em
 * ~/logs (fora da pasta pública — a tela é da conta do ChatGPT).
 */
async function diagnosticar(page, motivo) {
  const resumo = await page.evaluate(([a, b]) => {
    const ultimoTurno = [...document.querySelectorAll('article, [data-testid^="conversation-turn"]')].pop();
    const composer = document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]');
    return {
      titulo: document.title,
      respostasPorPapel: document.querySelectorAll(a).length,
      respostasPorTurno: document.querySelectorAll(b).length,
      turnos: document.querySelectorAll('article, [data-testid^="conversation-turn"]').length,
      mensagensDoUsuario: document.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]').length,
      botaoParar: Boolean(document.querySelector('[data-testid="stop-button"]')),
      textoNaCaixa: String(composer?.innerText || composer?.value || '').trim().slice(0, 80),
      ultimoTurno: String(ultimoTurno?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      avisoNaTela: String(document.querySelector('[role="alert"], .text-token-text-error, [class*="error" i]')?.innerText || '').trim().slice(0, 200),
    };
  }, [SELETOR_ASSISTENTE, SELETOR_TURNO_ASSISTENTE]).catch((err) => ({ falhaAoLer: err.message }));
  let print = null;
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const pasta = fs.existsSync(path.join(os.homedir(), 'logs')) ? path.join(os.homedir(), 'logs') : os.tmpdir();
    print = path.join(pasta, `chatgpt-livre-${Date.now()}.png`);
    await page.screenshot({ path: print, fullPage: false, timeout: 15_000 });
  } catch {
    print = null;
  }
  console.warn(`[chatgpt-livre] ${motivo} · url=${page.url()} · ${JSON.stringify({ ...resumo, erroLeitura: ultimoErroLeitura })}${print ? ` · print: ${print}` : ''}`);
  return print;
}

/** Espera a resposta nova terminar: sem botão "parar" e texto parado. */
async function aguardarResposta(page, respostasAntes, onPasso) {
  const comeco = Date.now();
  const limite = comeco + LIMITE_RESPOSTA_MS;
  let anterior = '';
  let paradoDesde = 0;
  let avisouEscrevendo = false;
  // A resposta pode estar na tela e não chegar até aqui (o ChatGPT troca os
  // atributos do DOM). Antes isso só aparecia no log depois de 6 minutos de
  // silêncio; agora conta em segundos, com o retrato da aba junto.
  let avisouSumico = false;
  while (Date.now() < limite) {
    await page.waitForTimeout(1500);
    if (page.isClosed()) throw erro('A conversa do ChatGPT foi fechada antes de terminar.', 503);
    const lida = await lerUltimaResposta(page);
    if (!lida || lida.total <= respostasAntes) {
      if (!avisouSumico && Date.now() - comeco > AVISO_SEM_RESPOSTA_MS) {
        avisouSumico = true;
        await diagnosticar(
          page,
          `resposta não encontrada no DOM após ${Math.round(AVISO_SEM_RESPOSTA_MS / 1000)}s ` +
            `(respostasAntes=${respostasAntes}, lida=${lida ? `total ${lida.total} via ${lida.via}` : 'null'})`
        );
        onPasso({
          kind: 'aviso',
          texto:
            'O ChatGPT pode já ter respondido, mas não consigo ler a resposta na página. ' +
            'Veja o log [chatgpt-livre] no servidor — tem um print da tela.',
        });
      }
      continue;
    }
    const texto = String(lida.texto || '').trim();
    if (texto && !avisouEscrevendo) {
      avisouEscrevendo = true;
      onPasso({ kind: 'pensando', texto: 'ChatGPT está escrevendo a matéria…' });
    }
    const gerando = await page.locator(SELETOR_PARAR).first().isVisible().catch(() => false);
    if (gerando || !texto) {
      paradoDesde = 0;
      anterior = texto;
      continue;
    }
    // Texto mudou, ou o botão "parar" acabou de sumir: começa a contar daqui.
    if (texto !== anterior || !paradoDesde) {
      anterior = texto;
      paradoDesde = Date.now();
      continue;
    }
    if (Date.now() - paradoDesde >= ESTAVEL_MS) return lida;
  }
  const parcial = String(anterior || '').replace(/\s+/g, ' ').trim();
  await diagnosticar(page, parcial ? 'resposta não terminou' : 'nenhuma resposta encontrada');
  throw erro(
    parcial
      ? `O ChatGPT não terminou a resposta a tempo. Último trecho: ${parcial.slice(-200)}`
      : 'O ChatGPT não respondeu dentro do tempo esperado. Os detalhes (e um print da tela) foram gravados no log do servidor como [chatgpt-livre].',
    504
  );
}

/** Baixa a imagem com os cookies do navegador; blob:/data: só dentro da página. */
async function baixarImagem(page, src) {
  if (/^https?:/i.test(src)) {
    try {
      const resposta = await page.context().request.get(src, { timeout: 60_000 });
      if (resposta.ok()) {
        const mimeType = String(resposta.headers()['content-type'] || 'image/jpeg').split(';')[0];
        if (/^image\//i.test(mimeType)) return { mimeType, buffer: await resposta.body() };
      }
    } catch {
      // tenta pela página
    }
  }
  return chatgpt.baixarImagemDaPagina(page, src);
}

/** A maior imagem do turno que der para baixar; sem imagem, segue só com o texto. */
async function melhorImagem(page, imagens = []) {
  const ordenadas = [...imagens].sort((a, b) => b.largura * b.altura - a.largura * a.altura);
  for (const candidata of ordenadas.slice(0, 4)) {
    try {
      const imagem = await baixarImagem(page, candidata.src);
      if (imagem?.buffer?.length > 5_000) {
        const gerada = /chatgpt\.com|oaiusercontent|openai|estuary|^blob:|^data:/i.test(candidata.src) ||
          /gerada|generated|criada/i.test(candidata.alt);
        return { ...imagem, src: candidata.src, gerada };
      }
    } catch (err) {
      console.warn('[chatgpt-livre] imagem não baixada:', err.message);
    }
  }
  return null;
}

/**
 * Tira do texto as marcas de citação que o ChatGPT desenha na tela: "+2" e
 * linhas soltas que são só o nome de um link citado ("g1").
 */
function limparTexto(texto, links = []) {
  const nomes = new Set(
    links.map((l) => String(l.titulo || '').trim().toLowerCase()).filter((t) => t && t.length <= 40)
  );
  return String(texto || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((linha) => {
      const t = linha.trim().toLowerCase();
      return !/^\+\d+$/.test(t) && !nomes.has(t);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Manda uma mensagem ao ChatGPT e devolve a resposta.
 * @param {object} p
 * @param {string} p.pedido o que o editor escreveu
 * @param {string|null} p.conversaUrl conversa do ChatGPT a continuar (null = nova)
 * @returns {{ texto, links, imagem, conversaUrl }}
 */
async function conversar({ pedido, conversaUrl = null, onPasso = () => {} }) {
  const texto = String(pedido || '').trim();
  if (!texto) throw erro('Escreva o que você quer que o ChatGPT faça.', 400);
  await require('./iaPausaService').garantirLiberada();
  const credenciais = await chatgpt.credenciaisChatgpt();
  const continuar = URL_CONVERSA.test(String(conversaUrl || ''));

  const liberar = await chatgpt.reservarPreparacao();
  const relogio = cronometro();
  let page;
  try {
    const browser = await chatgpt.obterBrowser();
    const context = browser.contexts()[0];
    if (!context) throw erro('O Chrome do servidor não disponibilizou um perfil de navegação.', 503);
    page = await require('./abaEmSegundoPlano').novaAbaEmSegundoPlano(browser, context);
    relogio.marcar('aba');
    onPasso({ kind: 'pensando', texto: continuar ? 'Abrindo a conversa no ChatGPT…' : 'Abrindo o ChatGPT…' });
    await page.goto(continuar ? conversaUrl : 'https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    relogio.marcar('abrir');

    // Caminho feliz primeiro: se a caixa de mensagem aparece, a sessão está
    // de pé e não há o que conferir. A checagem de sessão é um fetch à API
    // da OpenAI dentro da página — rodá-la SEMPRE punha um ida-e-volta de
    // rede na frente de toda mensagem, inclusive das que iam dar certo.
    let input = await chatgpt.editorVisivel(page, 12_000);
    if (!input) {
      await chatgpt.garantirSessaoChatgpt(page, context, credenciais);
      input = await chatgpt.aguardarEditor(page);
    }
    relogio.marcar('editor');
    // A conversa antiga carrega as respostas aos poucos; espera assentar.
    if (continuar) await page.waitForTimeout(2500);
    liberar();
    const respostasAntes = await contarRespostas(page);

    await input.click().catch(() => {});
    await input.fill(continuar ? texto : `${texto}\n${ORIENTACAO_PRIMEIRA}`);
    const enviar = page.locator(
      '[data-testid="send-button"]:not([disabled]), button[aria-label*="Send prompt" i]:not([disabled]), button[aria-label*="Enviar" i]:not([disabled])'
    ).first();
    try {
      await enviar.waitFor({ state: 'visible', timeout: 30_000 });
      await enviar.click();
    } catch {
      await page.waitForTimeout(1500);
      await input.press('Enter');
    }
    await page.waitForURL(URL_CONVERSA, { timeout: 45_000 }).catch(() => {});
    // O pedido saiu? Se a caixa ainda tem o texto e a conversa não andou,
    // tenta o Enter uma vez; senão avisa já, em vez de esperar 6 minutos.
    const naoSaiu = async () => {
      const naCaixa = String(await input.innerText().catch(() => '') || await input.inputValue().catch(() => '')).trim();
      return naCaixa.length > 20 && (await contarRespostas(page)) <= respostasAntes;
    };
    if (await naoSaiu()) {
      await input.press('Enter').catch(() => {});
      await page.waitForTimeout(5000);
      if (await naoSaiu()) {
        await diagnosticar(page, 'pedido não foi enviado');
        throw erro('O pedido ficou parado na caixa do ChatGPT e não foi enviado. Veja o log [chatgpt-livre] no servidor.', 502);
      }
    }
    relogio.marcar('envio');
    onPasso({ kind: 'pesquisa', texto: 'ChatGPT está pesquisando e escrevendo (pode levar alguns minutos)…' });

    const lida = await aguardarResposta(page, respostasAntes, onPasso);
    relogio.marcar('resposta');
    console.log(`[chatgpt-livre] ${continuar ? 'continuou' : 'nova conversa'} | ${relogio.resumo()}`);
    const resposta = limparTexto(lida.texto, lida.links);
    if (!resposta) throw erro('O ChatGPT respondeu sem texto.');

    let imagem = null;
    if (lida.imagens.length) {
      onPasso({ kind: 'pensando', texto: 'Trazendo a imagem do ChatGPT…' });
      imagem = await melhorImagem(page, lida.imagens);
    }
    onPasso({
      kind: imagem ? 'fontes' : 'aviso',
      texto: imagem
        ? 'Imagem do ChatGPT pronta — já entra como capa.'
        : 'O ChatGPT não mostrou imagem nesta resposta; escolha a capa no painel.',
    });

    const links = [];
    const vistos = new Set();
    for (const link of lida.links) {
      const chave = link.url.split('#')[0];
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      links.push(link);
    }
    return {
      texto: resposta,
      links: links.slice(0, 12),
      imagem,
      conversaUrl: URL_CONVERSA.test(page.url()) ? page.url().split('?')[0] : conversaUrl,
    };
  } finally {
    liberar();
    if (page) await require('./abaEmSegundoPlano').fecharAba(page);
  }
}

module.exports = {
  conversar,
  limparTexto,
  // Expostos para o teste da leitura da resposta (página que imita o ChatGPT).
  aguardarResposta,
  melhorImagem,
};
