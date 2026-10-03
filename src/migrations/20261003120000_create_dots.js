/**
 * Dots: agente que recebe um objetivo em texto e continua trabalhando sozinho
 * no servidor, sem precisar de nova mensagem.
 *
 *   `objetivo`  — o que o editor escreveu, na íntegra. É a fonte da verdade.
 *   `plano`     — o que a IA entendeu do objetivo (links, ação, nichos,
 *                 palavras, frequência). Fica salvo para o editor conferir e
 *                 para o ciclo não reinterpretar texto a cada volta.
 *   `fonte_ids` — as fontes da Biblioteca que este dot criou/assumiu. É por
 *                 aqui que o ciclo sabe quais posts são dele.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('dots'))) {
    await knex.schema.createTable('dots', (table) => {
      table.increments('id').primary();
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE');
      table.string('nome', 160).notNullable();
      table.text('objetivo').notNullable();
      table.text('plano').nullable();
      table.text('fonte_ids').nullable();
      table.string('estado', 20).notNullable().defaultTo('ativo');
      table.integer('intervalo_minutos').unsigned().notNullable().defaultTo(30);
      table.integer('limite_dia').unsigned().notNullable().defaultTo(10);
      table
        .integer('facebook_page_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('facebook_pages')
        .onDelete('SET NULL');
      // 'rascunho' deixa a matéria salva para o editor revisar; 'publicar'
      // manda para a fila de publicação como o piloto já faz.
      table.string('destino', 20).notNullable().defaultTo('rascunho');
      table.integer('feitas_hoje').unsigned().notNullable().defaultTo(0);
      table.date('dia_contagem').nullable();
      table.timestamp('proxima_execucao_at').nullable();
      table.timestamp('ultimo_run_at').nullable();
      table.string('ultimo_resumo', 500).nullable();
      table.string('ultimo_erro', 500).nullable();
      table.timestamps(true, true);
      table.index(['user_id', 'estado']);
      table.index(['estado', 'proxima_execucao_at'], 'dots_fila_idx');
    });
  }

  if (!(await knex.schema.hasTable('dots_execucoes'))) {
    await knex.schema.createTable('dots_execucoes', (table) => {
      table.increments('id').primary();
      table
        .integer('dot_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('dots')
        .onDelete('CASCADE');
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE');
      // 'criou_fonte' | 'escreveu' | 'ignorou' | 'erro' | 'varreu'
      table.string('acao', 30).notNullable();
      table.string('detalhe', 600).nullable();
      table.string('url', 1000).nullable();
      table.integer('matter_id').unsigned().nullable();
      table.timestamps(true, true);
      table.index(['dot_id', 'created_at']);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('dots_execucoes');
  await knex.schema.dropTableIfExists('dots');
};
