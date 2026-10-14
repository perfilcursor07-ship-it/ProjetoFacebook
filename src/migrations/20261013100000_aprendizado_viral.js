/**
 * Receita aprendida das matérias que bombaram.
 *
 * O aprendizado que já existia (`editorial_estilo_usuario`) olha as CORREÇÕES
 * do editor: o que ele reescreveu à mão. Isso ensina estilo, mas não ensina o
 * que o público responde.
 *
 * Aqui o sinal é outro: curtidas, comentários, compartilhamentos e views das
 * matérias que a página já publicou. A IA lê as que melhor performaram e
 * escreve um conjunto curto de regras ("o que essas têm em comum"), que entra
 * no prompt de quem escreve.
 *
 * Uma receita por página: duas páginas do mesmo editor têm públicos
 * diferentes, e misturá-las ensinaria a média de ninguém.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('aprendizado_viral'))) {
    await knex.schema.createTable('aprendizado_viral', (table) => {
      table.increments('id').primary();
      table.integer('user_id').unsigned().notNullable();
      table.integer('facebook_page_id').unsigned().nullable();
      // Regras em texto corrido, prontas para entrar no prompt.
      table.text('regras').nullable();
      // Títulos usados na análise: o editor precisa ver em cima do que a
      // receita foi feita, senão ela é um oráculo sem prestação de contas.
      table.text('amostra').nullable();
      table.integer('total_materias').unsigned().notNullable().defaultTo(0);
      table.integer('media_score').unsigned().nullable();
      table.dateTime('gerado_em').nullable();
      table.string('ultimo_erro', 500).nullable();
      table.timestamps(true, true);
      table.unique(['user_id', 'facebook_page_id'], 'aprendizado_viral_user_page_uq');
    });
  }

  if (await knex.schema.hasTable('dots')) {
    const temColuna = await knex.schema.hasColumn('dots', 'usar_estilo_viral');
    if (!temColuna) {
      await knex.schema.alterTable('dots', (table) => {
        // Desligado por padrão: o dot só muda de comportamento se o editor
        // pedir. Ligar sozinho mudaria a voz de páginas já em produção.
        table.boolean('usar_estilo_viral').notNullable().defaultTo(false);
      });
    }
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasTable('dots')) {
    if (await knex.schema.hasColumn('dots', 'usar_estilo_viral')) {
      await knex.schema.alterTable('dots', (table) => {
        table.dropColumn('usar_estilo_viral');
      });
    }
  }
  await knex.schema.dropTableIfExists('aprendizado_viral');
};
