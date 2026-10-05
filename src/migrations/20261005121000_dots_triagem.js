/**
 * Triagem por tema dos posts de cada dot.
 *
 * "Só política" não se resolve com palavra-chave: uma notícia de política
 * raramente tem a palavra "política" no título. A IA julga o título uma vez
 * por dot e o veredito fica aqui — a volta seguinte e o painel usam o mesmo
 * julgamento, sem perguntar de novo.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('dots_triagem')) return;
  await knex.schema.createTable('dots_triagem', (table) => {
    table.integer('dot_id').unsigned().notNullable().references('id').inTable('dots').onDelete('CASCADE');
    table
      .integer('post_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('biblioteca_posts')
      .onDelete('CASCADE');
    table.boolean('cabe').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.primary(['dot_id', 'post_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('dots_triagem');
};
