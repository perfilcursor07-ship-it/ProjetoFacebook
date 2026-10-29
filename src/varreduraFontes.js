/**
 * Varredura das fontes da Biblioteca num processo Node só dela.
 *
 * Ela rodava no mesmo processo do site, e o log mostrou o Node parado por
 * 80–87 s a cada ~5 min, sempre durante a varredura:
 *   [travado] Node parado por 83513ms — rodando: biblioteca-fontes
 * Nesse tempo nenhuma página abria, para ninguém. Aqui ela pode demorar o
 * quanto for: o site continua respondendo.
 *
 * O server.js inicia este arquivo com child_process.fork e o reinicia se cair.
 * Sem o processo pai (pm2 reload, deploy), este se encerra sozinho.
 */
require('./config/env');

const bibliotecaService = require('./services/bibliotecaService');
const vigiaLentidao = require('./services/vigiaLentidao');

const INTERVALO_MS = 60_000;
let rodando = false;

// Quando travar, o log diz qual fonte estava sendo lida.
vigiaLentidao.iniciar(() => {
  const atual = bibliotecaService.fonteEmVarredura();
  return rodando ? [`biblioteca-fontes${atual ? ` (${atual})` : ''}`] : [];
}, 'varredura');

async function tick() {
  if (rodando) {
    console.warn('[tick biblioteca-fontes] ainda rodando desde o tick anterior — pulei esta volta');
    return;
  }
  rodando = true;
  try {
    await bibliotecaService.tickFontes();
  } catch (err) {
    console.error('[tick biblioteca-fontes]', err.message);
  } finally {
    rodando = false;
  }
}

process.on('disconnect', () => process.exit(0));
process.on('unhandledRejection', (err) => {
  console.error('[varredura] promessa rejeitada:', err?.message || err);
});

console.log(`[varredura] processo das fontes iniciado (pid ${process.pid})`);
setInterval(tick, INTERVALO_MS);
setTimeout(tick, 15_000);
