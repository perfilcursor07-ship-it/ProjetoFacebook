/**
 * Páginas liberadas pelo administrador para um usuário publicar.
 *
 * Hoje a posse é em cadeia: facebook_pages -> facebook_accounts -> users. Como
 * uma página pertence a uma única conta, cada usuário precisava conectar o
 * Facebook e revincular a MESMA página no Ayrshare para poder publicar nela.
 *
 * Esta tabela separa posse de permissão: a página continua de quem conectou, e
 * o administrador concede acesso de publicação a quem precisar, sem duplicar
 * vínculo em lugar nenhum.
 *
 * `concedido_por` fica para auditoria — quem liberou o quê.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('user_facebook_pages')) return;

  await knex.schema.createTable('user_facebook_pages', (table) => {
    table.increments('id').primary();
    table
      .integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table
      .integer('facebook_page_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('facebook_pages')
      .onDelete('CASCADE');
    table
      .integer('concedido_por')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamps(true, true);
    table.unique(['user_id', 'facebook_page_id'], 'user_facebook_pages_unico');
    table.index(['user_id']);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('user_facebook_pages');
};
