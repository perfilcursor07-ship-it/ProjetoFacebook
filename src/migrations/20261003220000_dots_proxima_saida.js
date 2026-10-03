/**
 * Dots: horário livre seguinte da fila de publicação deste agente.
 *
 * Sem isso, cada volta recomeçaria a contar do "agora" e duas matérias de
 * voltas diferentes podiam cair no mesmo minuto.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;
  if (await knex.schema.hasColumn('dots', 'proxima_saida_at')) return;
  await knex.schema.alterTable('dots', (table) => {
    table.timestamp('proxima_saida_at').nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;
  if (!(await knex.schema.hasColumn('dots', 'proxima_saida_at'))) return;
  await knex.schema.alterTable('dots', (table) => {
    table.dropColumn('proxima_saida_at');
  });
};
