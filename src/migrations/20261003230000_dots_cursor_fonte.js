/**
 * Dots: por onde a varredura de páginas parou na última volta.
 *
 * Cada ciclo lia só as 10 primeiras páginas da lista — e sempre as mesmas.
 * Um dot que acompanha 26 páginas nunca chegava às 16 do fim: elas não
 * geravam matéria nenhuma, sem nada no log explicando por quê.
 *
 * Com o cursor, a volta continua de onde a anterior parou e dá a volta
 * completa na lista ao longo dos ciclos.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;
  if (await knex.schema.hasColumn('dots', 'cursor_fonte')) return;
  await knex.schema.alterTable('dots', (table) => {
    table.integer('cursor_fonte').unsigned().notNullable().defaultTo(0);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;
  if (!(await knex.schema.hasColumn('dots', 'cursor_fonte'))) return;
  await knex.schema.alterTable('dots', (table) => {
    table.dropColumn('cursor_fonte');
  });
};
