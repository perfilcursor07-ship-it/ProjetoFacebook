/**
 * Furos do dia: de onde vem a imagem de cada publicação do piloto.
 *
 *   'ia'       — gera com IA (comportamento de sempre); se falhar, ainda vale
 *                o `foto_original_se_falhar` como rede de segurança.
 *   'original' — usa a foto da matéria original e nunca chama a IA. Serve para
 *                a pauta em que imagem gerada não cabe (pessoa real, tragédia,
 *                nota oficial).
 *
 * Padrão 'ia' para não mudar o comportamento de quem já usa.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (await knex.schema.hasColumn('furos_autopilot', 'modo_imagem')) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.string('modo_imagem', 20).notNullable().defaultTo('ia');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (!(await knex.schema.hasColumn('furos_autopilot', 'modo_imagem'))) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.dropColumn('modo_imagem');
  });
};
