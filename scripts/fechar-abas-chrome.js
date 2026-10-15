#!/usr/bin/env node
/**
 * Fecha abas do Chrome do gateway (o do VNC) para aliviar o servidor.
 *
 *   node scripts/fechar-abas-chrome.js           fecha tudo, MENOS as abas de
 *                                                login das IAs (ChatGPT, Claude,
 *                                                DeepSeek, Gemini, Grok)
 *   node scripts/fechar-abas-chrome.js --listar  só mostra as abas, não fecha
 *   node scripts/fechar-abas-chrome.js --todas   fecha também as das IAs (deixa
 *                                                uma aba em branco). Depois,
 *                                                em /claude, clique em
 *                                                "Reiniciar gateway".
 *
 * Fechar aba não desloga ninguém: os logins ficam nos cookies do perfil.
 * Evite rodar no meio de uma geração de imagem ou do ChatGPT livre — a aba
 * dela seria fechada e o pedido falharia.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const IAS = /(?:^|\.)(?:chatgpt\.com|openai\.com|claude\.ai|anthropic\.com|deepseek\.com|gemini\.google\.com|aistudio\.google\.com|grok\.com)$/i;

function enderecoCdp() {
  const doAmbiente = String(process.env.TFG_CDP_URL || process.env.TOKEN_FREE_GATEWAY_CDP_URL || '').trim();
  if (doAmbiente) return doAmbiente.replace(/\/$/, '');
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.token-free-gateway', 'config.json'), 'utf8'));
    if (config?.cdpUrl) return String(config.cdpUrl).replace(/\/$/, '');
  } catch {
    // porta padrão
  }
  return 'http://127.0.0.1:9222';
}

function host(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function main() {
  const listar = process.argv.includes('--listar');
  const todas = process.argv.includes('--todas');
  const base = enderecoCdp();

  let alvos;
  try {
    const resposta = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(5000) });
    alvos = await resposta.json();
  } catch (err) {
    console.error(`Chrome do gateway não respondeu em ${base} (${err.message}). Ele está ligado?`);
    process.exit(1);
  }
  const abas = alvos.filter((a) => a.type === 'page');
  console.log(`${abas.length} aba(s) abertas no Chrome do gateway:`);
  for (const aba of abas) {
    const ia = IAS.test(host(aba.url));
    console.log(`  ${ia ? '[IA]   ' : '       '}${String(aba.url).slice(0, 110)}`);
  }
  if (listar) return;

  const fechar = abas.filter((aba) => todas || !IAS.test(host(aba.url)));
  // Fechar a última aba derruba a janela do Chrome: sempre sobra uma.
  if (fechar.length >= abas.length) {
    await fetch(`${base}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).catch(() =>
      fetch(`${base}/json/new?about:blank`, { signal: AbortSignal.timeout(5000) }).catch(() => {})
    );
  }
  let fechadas = 0;
  for (const aba of fechar) {
    try {
      await fetch(`${base}/json/close/${encodeURIComponent(aba.id)}`, { signal: AbortSignal.timeout(5000) });
      fechadas += 1;
    } catch (err) {
      console.warn(`  não fechou ${String(aba.url).slice(0, 80)}: ${err.message}`);
    }
  }
  console.log(`\nFechadas: ${fechadas}. Mantidas: ${abas.length - fechadas}${todas ? ' (+1 em branco)' : ' (logins das IAs)'}.`);
  if (todas) console.log('Agora, em /claude, clique em "Reiniciar gateway" para o gateway reabrir as abas dele.');
}

main();
