/**
 * Conversas: de onde cada uma nasceu.
 *
 * Dots, Furos do dia, Piloto automático e Feed sugerido escrevem pelo mesmo
 * fluxo do chat, e a conversa que virou matéria fica no histórico. Resultado:
 * a lista do /materia-manual misturava o que o editor escreveu com dezenas de
 * conversas automáticas cujo título é o próprio link colado — e não havia como
 * distinguir uma da outra.
 *
 *   'chat'  — o editor escreveu no /materia-manual (padrão)
 *   'dots'  — um agente Dots
 *   'furos' — Furos do dia ou o Piloto automático
 *   'feed'  — Feed sugerido
 *
 * Tudo que já existe vira 'chat': sem a coluna não há como saber a origem das
 * antigas, e chutar erraria mais do que acertaria.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ai_chats'))) return;
  if (await knex.schema.hasColumn('ai_chats', 'origem')) return;
  await knex.schema.alterTable('ai_chats', (table) => {
    table.string('origem', 20).notNullable().defaultTo('chat');
    // A lista filtra por origem dentro do usuário.
    table.index(['user_id', 'origem'], 'ai_chats_origem_idx');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('ai_chats'))) return;
  if (!(await knex.schema.hasColumn('ai_chats', 'origem'))) return;
  await knex.schema.alterTable('ai_chats', (table) => {
    table.dropIndex(['user_id', 'origem'], 'ai_chats_origem_idx');
    table.dropColumn('origem');
  });
};
