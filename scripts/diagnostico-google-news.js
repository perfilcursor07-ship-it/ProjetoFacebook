#!/usr/bin/env node
/**
 * Diagnóstico do Google News neste servidor.
 *
 * Responde a pergunta que decide o que fazer: o 503 vem do ritmo das nossas
 * requisições (ajustável) ou o IP deste servidor está recusado pelo Google
 * (ritmo nenhum resolve)?
 *
 * Faz UMA requisição, de propósito — insistir é o que prolonga o bloqueio.
 *
 *   node scripts/diagnostico-google-news.js
 */
require('dotenv').config();

const axios = require('axios');

const URL_RSS =
  'https://news.google.com/rss/search?q=noticias%20when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419';

function linha(rotulo, valor) {
  console.log(`  ${String(rotulo).padEnd(26)} ${valor}`);
}

async function main() {
  console.log('\n=== Diagnóstico do Google News ===\n');

  const { env } = require('../src/config/env');
  const limiter = require('../src/services/googleNewsLimiter');
  const estado = limiter.estado();

  console.log('Configuração do limitador:');
  linha('simultâneas', estado.limiteParalelo);
  linha('intervalo entre inícios', `${estado.intervaloMs}ms`);
  linha('estado agora', estado.pausado ? `EM PAUSA até ${estado.ate}` : 'liberado');

  const proxy = String(process.env.GOOGLE_NEWS_PROXY || '').trim();
  linha('proxy do Google News', proxy ? `ativo (${proxy.replace(/\/\/[^@]*@/, '//***@')})` : 'nenhum');

  console.log('\nFontes alternativas (o que sobra se o Google cair):');
  linha('Brave News', env.braveSearchApiKey ? 'ATIVA' : 'desligada (SEARCH_ENABLE_BRAVE)');
  linha('Serper', env.serperApiKey ? 'ATIVA' : 'desligada (SEARCH_ENABLE_SERPER)');

  // Portais lidos direto no RSS: não dependem do Google nem de chave de API.
  let pautasDePortais = -1;
  try {
    const rota = require('../src/routes/materiaChatExtras');
    const pautas = await rota.pautasDosPortais(rota.TEMAS_PADRAO, 48);
    pautasDePortais = pautas.length;
    linha('Portais (RSS direto)', `${pautasDePortais} pauta(s) nas últimas 48h`);
  } catch (err) {
    linha('Portais (RSS direto)', `falhou: ${err.message}`);
  }

  const semAlternativa = !env.braveSearchApiKey && !env.serperApiKey;

  console.log('\nUma requisição ao Google News RSS...');
  const inicio = Date.now();
  let status = 0;
  let corpo = '';
  let erroRede = '';

  try {
    const resposta = await axios.get(URL_RSS, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ViralizeAI/1.0)',
        Accept: 'application/rss+xml, text/xml',
      },
      timeout: 20000,
      // Queremos ver o 503, não transformá-lo em exceção.
      validateStatus: () => true,
    });
    status = resposta.status;
    corpo = String(resposta.data || '').slice(0, 300);
  } catch (err) {
    status = Number(err.response?.status || 0);
    corpo = String(err.response?.data || '').slice(0, 300);
    if (!status) erroRede = err.message;
  }

  const ms = Date.now() - inicio;
  linha('HTTP', status || `sem resposta (${erroRede})`);
  linha('tempo', `${ms}ms`);
  if (corpo) {
    const itens = (corpo.match(/<item>/g) || []).length;
    linha('início do corpo', corpo.replace(/\s+/g, ' ').slice(0, 120));
    if (itens) linha('itens no feed', itens);
  }

  console.log('\n--- Veredito ---\n');

  if (status === 200) {
    console.log('  O IP NÃO está bloqueado: uma requisição isolada funciona.');
    console.log('  O 503 vinha do volume. O limitador e o cache já tratam isso.');
    console.log('  Se o 503 voltar, aumente o espaçamento:');
    console.log('    GOOGLE_NEWS_INTERVALO_MS=400');
    console.log('    GOOGLE_NEWS_PARALELO=2');
  } else if (status === 503 || status === 429) {
    console.log(`  O IP DESTE SERVIDOR está recusado pelo Google (HTTP ${status})`);
    console.log('  mesmo numa requisição isolada. Ajustar ritmo não resolve agora.');
    console.log('');
    console.log('  O que fazer, em ordem:');
    console.log('   1. Esperar. Bloqueio de IP do Google costuma soltar em algumas horas.');
    console.log('      O limitador já segura as consultas e testa com uma sonda sozinha.');
    if (pautasDePortais > 0) {
      console.log(
        `   2. O radar NAO fica vazio: os portais seguem entregando ${pautasDePortais} pauta(s)`
      );
      console.log('      por RSS direto, com link e foto, sem passar pelo Google.');
    } else {
      console.log('   2. Ligar o Brave: SEARCH_ENABLE_BRAVE=1 no .env (valide o saldo).');
    }
    console.log('   3. Para voltar a usar o Google: proxy SO para estas chamadas,');
    console.log('      no .env do servidor (nao precisa de VPN):');
    console.log('        GOOGLE_NEWS_PROXY=http://usuario:senha@host:porta');
    console.log('      NAO instale VPN na maquina: ela trocaria a rota de TODOS os');
    console.log('      sites do CloudPanel e das APIs do Facebook/Instagram.');
  } else if (!status) {
    console.log('  Não houve resposta: pode ser rede, DNS ou firewall do servidor.');
    console.log(`  Erro: ${erroRede}`);
  } else {
    console.log(`  HTTP ${status} — resposta inesperada; veja o corpo acima.`);
  }

  if (semAlternativa && pautasDePortais > 0) {
    console.log(
      `\n  Brave e Serper estao desligadas, mas os portais entregam ${pautasDePortais}`
    );
    console.log('  pauta(s) por RSS direto: o radar nao depende so do Google.');
  } else if (semAlternativa) {
    console.log('\n  ATENCAO: nenhuma fonte respondeu (Brave, Serper e portais).');
  }

  console.log('');
}

main().catch((err) => {
  console.error('Falha no diagnóstico:', err.message);
  process.exit(1);
});
