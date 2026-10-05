const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Abre uma aba no Chrome compartilhado (gateway, leitor de artigos, imagens
 * do ChatGPT/Grok/Gemini) SEM trazê-la para a frente.
 *
 * `context.newPage()` ativa a aba nova. Como a pesquisa e as gerações de
 * imagem abrem e fecham abas o tempo todo, a janela ficava pulando entre
 * elas e o desktop do noVNC "piscava", atrapalhando quem entra para fazer
 * login. `Target.createTarget` com `background: true` cria a aba atrás da
 * atual; se algo falhar, volta ao `newPage()` comum.
 *
 * Toda aba aberta aqui fica registrada (também em arquivo, para sobreviver a
 * um reinício). A faxina do Chrome fecha as registradas que sobrarem, mesmo
 * em sites protegidos como chatgpt.com — sem tocar nas abas fixas do gateway,
 * que nunca passam por aqui.
 */

const ARQUIVO_REGISTRO =
  process.env.CHROME_ABAS_REGISTRO ||
  path.join(os.homedir(), '.token-free-gateway', 'viralizeai-abas.json');
const FECHAR_TIMEOUT_MS = 5_000;

/** targetId -> { aberta: ms, pid } */
const registro = new Map();
let carregado = false;

function carregarRegistro() {
  if (carregado) return;
  carregado = true;
  try {
    const salvo = JSON.parse(fs.readFileSync(ARQUIVO_REGISTRO, 'utf8'));
    for (const [id, dados] of Object.entries(salvo || {})) {
      if (id && dados?.aberta) registro.set(id, { aberta: Number(dados.aberta), pid: Number(dados.pid) || 0 });
    }
  } catch {
    // sem arquivo ainda
  }
}

function salvarRegistro() {
  try {
    fs.mkdirSync(path.dirname(ARQUIVO_REGISTRO), { recursive: true });
    fs.writeFileSync(ARQUIVO_REGISTRO, JSON.stringify(Object.fromEntries(registro)));
  } catch {
    // o registro em memória continua valendo neste processo
  }
}

function registrar(targetId) {
  if (!targetId) return;
  carregarRegistro();
  registro.set(targetId, { aberta: Date.now(), pid: process.pid });
  salvarRegistro();
}

function esquecer(targetId) {
  carregarRegistro();
  if (targetId && registro.delete(targetId)) salvarRegistro();
}

/** Abas que o sistema abriu e ainda não fechou: [{ id, aberta, pid, deOutroProcesso }]. */
function abasRegistradas() {
  carregarRegistro();
  return [...registro].map(([id, dados]) => ({ id, aberta: dados.aberta, pid: dados.pid, deOutroProcesso: dados.pid !== process.pid }));
}

async function idDaAba(context, pagina) {
  const sessao = await context.newCDPSession(pagina).catch(() => null);
  if (!sessao) return null;
  const info = await sessao.send('Target.getTargetInfo').catch(() => null);
  await sessao.detach().catch(() => {});
  return info?.targetInfo?.targetId || null;
}

function marcar(pagina, targetId) {
  if (!targetId) return pagina;
  Object.defineProperty(pagina, '__viralizeTargetId', { value: targetId, configurable: true });
  registrar(targetId);
  return pagina;
}

async function novaAbaEmSegundoPlano(browser, context) {
  let cdp = null;
  let targetId = null;
  try {
    cdp = await browser.newBrowserCDPSession();
    const antes = new Set(context.pages());
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true }));
    const limite = Date.now() + 5000;
    while (Date.now() < limite) {
      for (const pagina of context.pages()) {
        if (antes.has(pagina)) continue;
        if ((await idDaAba(context, pagina)) === targetId) return marcar(pagina, targetId);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Não achou a aba criada: fecha para não deixar uma aba vazia sobrando.
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  } catch {
    if (cdp && targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
  }
  const pagina = await context.newPage();
  return marcar(pagina, await idDaAba(context, pagina));
}

/**
 * Fecha a aba sem deixar sobra: `page.close()` pode travar numa aba que não
 * responde. Depois de alguns segundos, fecha direto pelo Chrome (CDP).
 */
async function fecharAba(pagina) {
  if (!pagina) return;
  const targetId = pagina.__viralizeTargetId || null;
  let fechou = false;
  try {
    await Promise.race([
      pagina.close().then(() => { fechou = true; }),
      new Promise((resolve) => setTimeout(resolve, FECHAR_TIMEOUT_MS)),
    ]);
  } catch {
    // tenta pelo CDP
  }
  if (!fechou && targetId) {
    try {
      const sessao = await pagina.context().browser()?.newBrowserCDPSession();
      if (sessao) {
        await sessao.send('Target.closeTarget', { targetId }).catch(() => {});
        await sessao.detach().catch(() => {});
        fechou = true;
      }
    } catch {
      // a faxina fecha depois
    }
  }
  if (fechou) esquecer(targetId);
}

module.exports = { novaAbaEmSegundoPlano, fecharAba, abasRegistradas, esquecer, ARQUIVO_REGISTRO };
