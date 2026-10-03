/**
 * Dots: separa "de quanto em quanto tempo relê as páginas" de "de quanto em
 * quanto tempo entrega matéria".
 *
 * Antes havia um só `intervalo_minutos` para as duas coisas. Um pedido comum —
 * "monitore a cada 1 hora e publique 1 a cada 15 minutos" — não tinha como ser
 * representado: ou o dot trabalhava de hora em hora (e entregava 1 por hora,
 * não 4), ou relia as 26 páginas 4x mais que o pedido.
 *
 * Agora `intervalo_minutos` é o ritmo de entrega e `scan_minutos` o de leitura.
 * Nulo = relê a cada volta, que é o comportamento de antes.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;
  const novas = [];
  if (!(await knex.schema.hasColumn('dots', 'scan_minutos'))) novas.push('scan_minutos');
  if (!(await knex.schema.hasColumn('dots', 'ultimo_scan_at'))) novas.push('ultimo_scan_at');
  if (!novas.length) return;

  await knex.schema.alterTable('dots', (table) => {
    if (novas.includes('scan_minutos')) table.integer('scan_minutos').unsigned().nullable();
    if (novas.includes('ultimo_scan_at')) table.timestamp('ultimo_scan_at').nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;
  for (const coluna of ['scan_minutos', 'ultimo_scan_at']) {
    if (await knex.schema.hasColumn('dots', coluna)) {
      await knex.schema.alterTable('dots', (table) => table.dropColumn(coluna));
    }
  }
};
