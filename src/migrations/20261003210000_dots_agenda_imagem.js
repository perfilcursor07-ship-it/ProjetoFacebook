/**
 * Dots: como o agente entrega o trabalho.
 *
 *   `materias_por_volta` — quantas matérias ele escreve a cada volta. Com o
 *                          intervalo, é isso que define o ritmo: 2 matérias a
 *                          cada 30 min são 4 por hora.
 *   `modo_imagem`        — 'original'     usa a foto da matéria de origem;
 *                          'ia_todas'     gera imagem com IA sempre;
 *                          'ia_com_texto' gera só quando a foto original tem
 *                                         texto embutido (detectado por OCR),
 *                                         que é o caso em que a foto não serve;
 *                          'sem_imagem'   publica sem arte.
 *   `agendar_minutos`    — com destino 'agendar', de quantos em quantos minutos
 *                          cada matéria pronta sai. Null = usa o intervalo.
 *
 * `destino` já existia com 'rascunho' e 'publicar'; passa a aceitar 'agendar'.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;

  const faltando = [];
  for (const coluna of ['materias_por_volta', 'modo_imagem', 'agendar_minutos']) {
    if (!(await knex.schema.hasColumn('dots', coluna))) faltando.push(coluna);
  }
  if (!faltando.length) return;

  await knex.schema.alterTable('dots', (table) => {
    if (faltando.includes('materias_por_volta')) {
      table.integer('materias_por_volta').unsigned().notNullable().defaultTo(1);
    }
    if (faltando.includes('modo_imagem')) {
      table.string('modo_imagem', 20).notNullable().defaultTo('original');
    }
    if (faltando.includes('agendar_minutos')) {
      table.integer('agendar_minutos').unsigned().nullable();
    }
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;
  for (const coluna of ['materias_por_volta', 'modo_imagem', 'agendar_minutos']) {
    if (await knex.schema.hasColumn('dots', coluna)) {
      await knex.schema.alterTable('dots', (table) => table.dropColumn(coluna));
    }
  }
};
