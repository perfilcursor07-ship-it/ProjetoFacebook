/**
 * Índice para a listagem do banco de imagens.
 *
 * A grade filtra por `user_id` e ordena por `created_at DESC, id DESC`. O
 * único índice existente era `(user_id, origem)`, que não serve para essa
 * ordenação: o MySQL lia todas as imagens do editor e ordenava em memória
 * (filesort) a cada abertura da tela e a cada rolagem.
 *
 * `(user_id, created_at, id)` cobre o filtro e a ordem de uma vez.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('banco_imagens'))) return;
  const [existe] = await knex.raw(
    "SHOW INDEX FROM banco_imagens WHERE Key_name = 'banco_imagens_user_data_idx'"
  );
  if (Array.isArray(existe) && existe.length) return;
  await knex.schema.alterTable('banco_imagens', (table) => {
    table.index(['user_id', 'created_at', 'id'], 'banco_imagens_user_data_idx');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('banco_imagens'))) return;
  await knex.schema.alterTable('banco_imagens', (table) => {
    table.dropIndex(['user_id', 'created_at', 'id'], 'banco_imagens_user_data_idx');
  });
};
