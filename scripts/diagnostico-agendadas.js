#!/usr/bin/env node
/**
 * Por que a matéria agendada não publicou?
 *
 * Cada caminho que tira uma matéria do agendado grava o motivo em algum lugar
 * (job.erro, matter.error_message, status da agenda) — mas nem todos escrevem
 * no log, então procurar no pm2 pode não achar nada. Aqui lemos o banco, que é
 * o registro autoritativo.
 *
 *   node scripts/diagnostico-agendadas.js            (últimas 24h)
 *   node scripts/diagnostico-agendadas.js 72         (últimas 72h)
 */
require('dotenv').config();

const db = require('../src/config/db');

const HORAS = Math.max(1, Number(process.argv[2]) || 24);

function linha(rotulo, valor) {
  console.log(`    ${String(rotulo).padEnd(18)} ${valor ?? '—'}`);
}

function quando(valor) {
  if (!valor) return '—';
  try {
    return new Date(valor).toLocaleString('pt-BR', { timeZone: 'America/Araguaina' });
  } catch {
    return String(valor);
  }
}

async function main() {
  const desde = new Date(Date.now() - HORAS * 3_600_000);
  console.log(`\n=== Agendadas que não saíram (últimas ${HORAS}h) ===\n`);

  // 1) Ainda marcadas como agendadas, mas com a hora já vencida.
  const atrasadas = await db('ai_matters')
    .where('status', 'agendado')
    .whereNotNull('scheduled_at')
    .where('scheduled_at', '<=', new Date())
    .select('id', 'titulo', 'scheduled_at', 'facebook_page_id', 'error_message')
    .orderBy('scheduled_at', 'asc')
    .limit(20);

  console.log(`[1] Agendadas com a hora vencida e ainda não publicadas: ${atrasadas.length}`);
  for (const m of atrasadas) {
    console.log(`\n  #${m.id} ${String(m.titulo || '').slice(0, 64)}`);
    linha('era para sair', quando(m.scheduled_at));
    linha('página', m.facebook_page_id || 'NENHUMA (não publica sem página)');
    linha('erro na matéria', m.error_message);

    const job = await db('ai_fila_jobs')
      .where({ matter_id: m.id })
      .orderBy('id', 'desc')
      .first('id', 'status', 'erro', 'run_at', 'attempts');
    if (!job) {
      linha('job da fila', 'NENHUM — nada vai publicar esta matéria');
    } else {
      linha('job da fila', `#${job.id} status=${job.status} tentativas=${job.attempts || 0}`);
      linha('job rodaria em', quando(job.run_at));
      if (job.erro) linha('erro do job', String(job.erro).slice(0, 160));
    }
  }

  // 2) Saíram do agendado recentemente sem virar publicação.
  const revertidas = await db('ai_matters')
    .whereIn('status', ['rascunho', 'pronto'])
    .whereNull('publication_id')
    .where('updated_at', '>=', desde)
    .select('id', 'titulo', 'status', 'updated_at', 'error_message')
    .orderBy('updated_at', 'desc')
    .limit(20);

  console.log(`\n\n[2] Voltaram para rascunho/pronto sem publicar: ${revertidas.length}`);
  for (const m of revertidas) {
    const job = await db('ai_fila_jobs')
      .where({ matter_id: m.id })
      .orderBy('id', 'desc')
      .first('status', 'erro');
    let agenda = null;
    try {
      agenda = await db('biblioteca_agenda')
        .where({ matter_id: m.id })
        .orderBy('id', 'desc')
        .first('status');
    } catch {
      /* tabela pode não existir */
    }

    // Sem job cancelado nem erro, a matéria pode nunca ter sido agendada.
    const motivo =
      job?.erro ||
      m.error_message ||
      (job ? `job ${job.status}, sem motivo gravado` : 'nenhum job — talvez nunca agendada');

    console.log(`\n  #${m.id} [${m.status}] ${String(m.titulo || '').slice(0, 56)}`);
    linha('mudou em', quando(m.updated_at));
    linha('motivo', String(motivo).slice(0, 160));
    if (agenda) linha('agenda', `status=${agenda.status}`);
  }

  // 3) Saúde da fila: job preso é diferente de job recusado.
  const porStatus = await db('ai_fila_jobs')
    .where('updated_at', '>=', desde)
    .select('status')
    .count({ total: '*' })
    .groupBy('status');

  console.log('\n\n[3] Jobs da fila nesse período:');
  for (const linhaStatus of porStatus) {
    console.log(`    ${String(linhaStatus.status).padEnd(12)} ${linhaStatus.total}`);
  }

  const pendentesVencidos = await db('ai_fila_jobs')
    .where({ status: 'pendente' })
    .where('run_at', '<=', new Date())
    .count({ total: '*' })
    .first();
  const presos = Number(pendentesVencidos?.total) || 0;
  if (presos) {
    console.log(
      `\n    ATENÇÃO: ${presos} job(s) pendentes com a hora vencida.` +
        '\n    Isso indica que o processador da fila não está rodando — nada a ver com bloqueio.'
    );
  }

  console.log('');
  await db.destroy();
}

main().catch(async (err) => {
  console.error('Falha no diagnóstico:', err.message);
  try {
    await db.destroy();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
