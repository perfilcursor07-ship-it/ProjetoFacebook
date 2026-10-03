/**
 * Módulos da área "Matérias" liberados para cada usuário.
 *
 * Guardado como JSON em users para a semântica ficar sem ambiguidade:
 *   NULL  -> nunca foi configurado, o usuário vê tudo (comportamento de hoje,
 *            para ninguém perder acesso no deploy);
 *   '[]'  -> o administrador tirou todos de propósito;
 *   lista -> exatamente esses.
 *
 * Com tabela de vínculo, "sem linha" significaria as duas primeiras coisas ao
 * mesmo tempo, e desmarcar tudo seria indistinguível de não ter configurado.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('users'))) return;
  if (await knex.schema.hasColumn('users', 'modulos_materia')) return;
  await knex.schema.alterTable('users', (table) => {
    table.text('modulos_materia').nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('users'))) return;
  if (!(await knex.schema.hasColumn('users', 'modulos_materia'))) return;
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('modulos_materia');
  });
};
