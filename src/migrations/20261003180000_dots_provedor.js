/**
 * Dots: qual IA escreve as matérias deste agente.
 *
 *   'auto'     — segue a configuração global do projeto (padrão de hoje).
 *   'claude'   — Claude pela API oficial (ANTHROPIC_API_KEY).
 *   'deepseek' — DeepSeek pela API oficial (DEEPSEEK_API_KEY).
 *   'gratis'   — camada grátis (Gemini / Groq / OpenRouter).
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;
  if (await knex.schema.hasColumn('dots', 'provedor')) return;
  await knex.schema.alterTable('dots', (table) => {
    table.string('provedor', 20).notNullable().defaultTo('auto');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;
  if (!(await knex.schema.hasColumn('dots', 'provedor'))) return;
  await knex.schema.alterTable('dots', (table) => {
    table.dropColumn('provedor');
  });
};
