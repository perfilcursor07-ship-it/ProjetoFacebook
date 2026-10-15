#!/usr/bin/env node
/**
 * Por que o ViralizeAI está lento?
 *
 * O site é um processo Node só — single-thread. Tudo o que o robô faz
 * (varrer fontes, baixar HTML, falar com IA) disputa o MESMO laço de eventos
 * que atende as suas telas. Por isso um projeto vizinho no servidor pode
 * estar rápido e este, não: lá é outro processo.
 *
 * Este script mede o que o robô tem para fazer e aponta o que está pesando.
 * Não altera nada.
 *
 *   node scripts/diagnostico-lentidao.js
 */
require('dotenv').config();

const db = require('../src/config/db');

/** Páginas do Facebook devolvem ~10 MB por variante, em ~8 variantes. */
const MB_POR_VARIANTE = 10.3;
const VARIANTES = 8;

function linha(rotulo, valor) {
  console.log(`   ${String(rotulo).padEnd(34)} ${valor}`);
}

async function fontes() {
  console.log('\n=== FONTES MONITORADAS (o que o robô relê o tempo todo) ===\n');
  if (!(await db.schema.hasTable('biblioteca_fontes'))) {
    console.log('   tabela biblioteca_fontes não existe.');
    return;
  }
  const temRecuo = await db.schema.hasColumn('biblioteca_fontes', 'falhas_seguidas').catch(() => false);

  const colunas = ['id', 'nome', 'plataforma', 'intervalo_minutos', 'ultimo_erro'];
  if (temRecuo) colunas.push('falhas_seguidas');
  const lista = await db('biblioteca_fontes').where({ monitorar: true }).select(colunas);

  const comErro = lista.filter((f) => f.ultimo_erro);
  const fbComErro = comErro.filter((f) => f.plataforma === 'facebook');

  linha('monitoradas', lista.length);
  linha('falhando agora', `${comErro.length} (${fbComErro.length} do Facebook)`);

  if (!temRecuo) {
    console.log(
      '\n   ATENÇÃO: a coluna falhas_seguidas não existe — a migração do recuo' +
        '\n   não rodou. Fonte quebrada ainda é relida no ritmo normal.'
    );
  }

  // Quanto HTML as páginas do Facebook quebradas puxam por dia.
  if (fbComErro.length) {
    const porDia = (f) => (24 * 60) / Math.max(15, Number(f.intervalo_minutos) || 60);
    const semRecuo = fbComErro.reduce((s, f) => s + porDia(f) * MB_POR_VARIANTE * VARIANTES, 0) / 1024;
    // Com recuo no teto (12 h) e variantes encerradas no 1º 401.
    const comRecuo = (fbComErro.length * 2 * MB_POR_VARIANTE) / 1024;
    console.log('');
    linha('HTML/dia sem recuo (estimado)', `${semRecuo.toFixed(1)} GB`);
    linha('HTML/dia com recuo no teto', `${comRecuo.toFixed(2)} GB`);
    if (temRecuo) {
      const recuando = fbComErro.filter((f) => Number(f.falhas_seguidas) > 0).length;
      linha('já recuando', `${recuando}/${fbComErro.length}`);
      if (recuando < fbComErro.length) {
        console.log('   (as demais recuam na próxima falha)');
      }
    }
  }

  const porPlataforma = new Map();
  for (const f of comErro) {
    const k = f.plataforma || 'outro';
    porPlataforma.set(k, (porPlataforma.get(k) || 0) + 1);
  }
  if (porPlataforma.size) {
    console.log('\n   falhando, por plataforma:');
    for (const [p, n] of [...porPlataforma].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(p).padEnd(12)} ${n}`);
    }
  }
}

async function filas() {
  console.log('\n\n=== FILAS E ROBÔS ===\n');
  const agora = new Date();

  const [{ total: pendentes = 0 } = {}] = await db('ai_fila_jobs')
    .where({ status: 'pendente' })
    .count({ total: '*' })
    .catch(() => [{ total: 0 }]);
  const [{ total: vencidos = 0 } = {}] = await db('ai_fila_jobs')
    .where({ status: 'pendente' })
    .where('run_at', '<=', agora)
    .count({ total: '*' })
    .catch(() => [{ total: 0 }]);
  linha('jobs pendentes', pendentes);
  linha('jobs com hora vencida', `${vencidos}${Number(vencidos) > 3 ? '  ← a fila não está vazando' : ''}`);

  if (await db.schema.hasTable('dots')) {
    const dots = await db('dots').select('estado', 'trabalhando').catch(() => []);
    linha('dots ativos', dots.filter((d) => d.estado === 'ativo').length);
    linha('dots trabalhando agora', dots.filter((d) => d.trabalhando).length);
  }

  const [{ total: posts = 0 } = {}] = await db('biblioteca_posts')
    .whereNull('matter_id')
    .whereIn('status', ['novo', 'visto'])
    .count({ total: '*' })
    .catch(() => [{ total: 0 }]);
  linha('posts na fila para escrever', posts);
}

function processo() {
  console.log('\n\n=== ESTE PROCESSO ===\n');
  const m = process.memoryUsage();
  const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
  linha('heap usado', mb(m.heapUsed));
  linha('heap total', mb(m.heapTotal));
  linha('residente (RSS)', mb(m.rss));
  console.log(
    '\n   Este script é um processo à parte: os números acima são dele, não' +
      '\n   do site. Para o site, use: pm2 status viralizeai'
  );
}

async function main() {
  await fontes();
  await filas();
  processo();
  console.log('\nNada foi alterado por este script.\n');
  await db.destroy();
}

main().catch(async (err) => {
  console.error('Falhou:', err.message);
  try {
    await db.destroy();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
