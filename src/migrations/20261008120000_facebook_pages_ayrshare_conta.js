/**
 * Páginas x conta Ayrshare atual. Ao trocar de conta na Ayrshare, os Profile
 * Keys da conta antiga deixam de existir: a página que não está na conta atual
 * fica marcada (e escondida das listas) em vez de falhar em toda publicação.
 * Ver src/services/ayrshareContaService.js.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('facebook_pages'))) return;
  if (await knex.schema.hasColumn('facebook_pages', 'ayrshare_fora_da_conta')) return;
  await knex.schema.alterTable('facebook_pages', (table) => {
    table.boolean('ayrshare_fora_da_conta').notNullable().defaultTo(false);
    table.timestamp('ayrshare_verificada_at').nullable();
    table.string('ayrshare_motivo', 255).nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('facebook_pages'))) return;
  if (!(await knex.schema.hasColumn('facebook_pages', 'ayrshare_fora_da_conta'))) return;
  await knex.schema.alterTable('facebook_pages', (table) => {
    table.dropColumn('ayrshare_fora_da_conta');
    table.dropColumn('ayrshare_verificada_at');
    table.dropColumn('ayrshare_motivo');
  });
};
