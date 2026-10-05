const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const axios = require('axios');

/**
 * Faxina das abas temporárias do Chrome compartilhado (gateway, leitor de
 * artigos, busca de imagens no Google).
 *
 * Quem abre essas abas fecha no `finally`, mas se o servidor reinicia no meio
 * (deploy, `pm2 restart`) ou o `page.close()` trava, a aba fica aberta para
 * sempre — cada uma gastando CPU e memória. Em produção chegaram a sobrar
 * dezenas de pesquisas do Google Imagens abertas há dias.
 *
 * A cada passada, anota as abas temporárias que vê; a que continuar aberta
 * depois de IDADE_MAXIMA_MS (uma aba temporária vive segundos) é fechada.
 * As abas das IAs e dos logins (ChatGPT, DeepSeek, Claude, Google, redes)
 * nunca são tocadas, e sempre sobra ao menos uma aba no Chrome.
 */

const INTERVALO_MS = 5 * 60_000;
const IDADE_MAXIMA_MS = 10 * 60_000;
/**
 * Abas abertas pelo próprio sistema (registradas em abaEmSegundoPlano): uma
 * geração de imagem leva no máximo ~6 min. Passou disso, sobrou — fecha
 * mesmo em site protegido. As do gateway nunca estão nesse registro.
 */
const IDADE_MAXIMA_NOSSA_MS = 12 * 60_000;

function processoVivo(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Sessões que o gateway e o editor mantêm abertas de propósito.
const HOSTS_PROTEGIDOS = [
  'chatgpt.com',
  'openai.com',
  'deepseek.com',
  'claude.ai',
  'anthropic.com',
  'gemini.google.com',
  'aistudio.google.com',
  'accounts.google.com',
  'myaccount.google.com',
  'instagram.com',
  'facebook.com',
  'youtube.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
];

const vistas = new Map(); // targetId -> primeira vez vista (ms)
let timer = null;
let rodando = false;

function hostProtegido(host) {
  return HOSTS_PROTEGIDOS.some((protegido) => host === protegido || host.endsWith(`.${protegido}`));
}

/** Aba que só existe durante uma leitura/busca e pode ser fechada se esquecida. */
function abaTemporaria(alvo) {
  if (alvo?.type !== 'page') return false;
  const url = String(alvo.url || '');
  if (url === 'about:blank') return true;
  let endereco;
  try {
    endereco = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(endereco.protocol)) return false; // chrome://, devtools://, extensões
  const host = endereco.hostname.toLowerCase();
  if (/(^|\.)google\.[a-z.]+$/.test(host) && endereco.pathname === '/search') return true;
  return !hostProtegido(host);
}

async function enderecoCdp() {
  const doAmbiente = String(process.env.TOKEN_FREE_GATEWAY_CDP_URL || process.env.TFG_CDP_URL || '').trim();
  if (doAmbiente) return doAmbiente.replace(/\/$/, '');
  try {
    const config = JSON.parse(
      await fs.readFile(path.join(os.homedir(), '.token-free-gateway', 'config.json'), 'utf8')
    );
    if (config?.cdpUrl) return String(config.cdpUrl).replace(/\/$/, '');
  } catch {
    // Sem config: porta local padrão do gateway.
  }
  return 'http://127.0.0.1:9222';
}

/** Uma passada da faxina. Devolve quantas abas fechou. */
async function faxinar({ agora = Date.now(), http = axios } = {}) {
  if (rodando) return 0;
  rodando = true;
  try {
    const base = await enderecoCdp();
    let alvos;
    try {
      ({ data: alvos } = await http.get(`${base}/json/list`, { timeout: 3_000 }));
    } catch {
      return 0; // Chrome do gateway desligado (ou máquina de desenvolvimento).
    }
    if (!Array.isArray(alvos)) return 0;

    const abertas = new Set(alvos.map((alvo) => alvo.id));
    for (const id of vistas.keys()) if (!abertas.has(id)) vistas.delete(id);

    let paginas = alvos.filter((alvo) => alvo.type === 'page').length;
    let fechadas = 0;
    const fechar = async (alvo) => {
      if (paginas <= 1) return false; // Fechar a última aba derrubaria a janela do Chrome.
      try {
        await http.get(`${base}/json/close/${encodeURIComponent(alvo.id)}`, { timeout: 3_000 });
        vistas.delete(alvo.id);
        paginas -= 1;
        fechadas += 1;
        return true;
      } catch (err) {
        console.warn('[chrome-faxina] não fechou', String(alvo.url).slice(0, 120), err.message);
        return false;
      }
    };

    // 1) Abas que o sistema abriu e não fechou (travou ou o servidor
    //    reiniciou no meio). Do processo anterior: fecha já; deste: pela idade.
    const abas = require('./abaEmSegundoPlano');
    const porId = new Map(alvos.map((alvo) => [alvo.id, alvo]));
    for (const nossa of abas.abasRegistradas()) {
      const alvo = porId.get(nossa.id);
      if (!alvo) {
        abas.esquecer(nossa.id); // já foi fechada
        continue;
      }
      const orfa = nossa.deOutroProcesso && !processoVivo(nossa.pid);
      if (!orfa && agora - nossa.aberta < IDADE_MAXIMA_NOSSA_MS) continue;
      if (await fechar(alvo)) {
        abas.esquecer(nossa.id);
        porId.delete(nossa.id);
      }
    }

    // 2) Abas temporárias de qualquer origem esquecidas há mais de 10 min.
    for (const alvo of alvos) {
      if (!porId.has(alvo.id)) continue;
      if (!abaTemporaria(alvo)) continue;
      if (!vistas.has(alvo.id)) {
        vistas.set(alvo.id, agora);
        continue;
      }
      if (agora - vistas.get(alvo.id) < IDADE_MAXIMA_MS) continue;
      if (paginas <= 1) break;
      await fechar(alvo);
    }
    if (fechadas) console.info(`[chrome-faxina] ${fechadas} aba(s) esquecida(s) fechada(s) no Chrome do gateway`);
    return fechadas;
  } finally {
    rodando = false;
  }
}

function iniciar() {
  if (timer || String(process.env.CHROME_FAXINA || '').trim() === '0') return;
  timer = setInterval(() => void faxinar().catch((err) => console.warn('[chrome-faxina]', err.message)), INTERVALO_MS);
  timer.unref?.();
  // Primeira passada logo após subir: anota as órfãs do processo anterior.
  setTimeout(() => void faxinar().catch(() => {}), 30_000).unref?.();
}

module.exports = { iniciar, faxinar, abaTemporaria, IDADE_MAXIMA_MS };
