/**
 * Quantas vezes seguidas a fonte falhou — para espaçar quem não responde.
 *
 * O servidor ficou lento por isto: ~20 páginas do Facebook com a sessão
 * caída eram relidas a cada 15 minutos, e cada uma baixa ~10 MB de HTML em
 * 8 variantes. Dá ~1,6 GB por volta (o dobro disso em memória, já como
 * string) para devolver ZERO post. Node é single-thread: enquanto esse HTML
 * é baixado e varrido por regex, o laço de eventos não atende mais ninguém —
 * e o site inteiro fica lento.
 *
 * Com a contagem aqui, fonte que falha vai sendo reagendada cada vez mais
 * longe (30 min, 1 h, 2 h… até o teto), e volta ao ritmo normal assim que
 * responder de novo.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('biblioteca_fontes'))) return;
  if (await knex.schema.hasColumn('biblioteca_fontes', 'falhas_seguidas')) return;
  await knex.schema.alterTable('biblioteca_fontes', (table) => {
    table.integer('falhas_seguidas').unsigned().notNullable().defaultTo(0);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('biblioteca_fontes'))) return;
  if (!(await knex.schema.hasColumn('biblioteca_fontes', 'falhas_seguidas'))) return;
  await knex.schema.alterTable('biblioteca_fontes', (table) => {
    table.dropColumn('falhas_seguidas');
  });
};
