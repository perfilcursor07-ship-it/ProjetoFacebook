/**
 * Dots: jornada de trabalho e ritmo de saída escolhidos na tela.
 *
 * Antes tudo isso era adivinhado pela IA a partir do texto livre do editor —
 * ritmo, quantidade, destino, imagem. Dava erro de interpretação toda vez e o
 * editor não tinha onde corrigir. Agora o texto diz só O QUE fazer; QUANDO e
 * COMO ficam em campos explícitos.
 *
 *   dias_semana       "1,2,3,4,5" (1=segunda … 7=domingo). Null = todos os dias.
 *   hora_inicio/fim   janela em horas locais (8 e 18 = das 8h às 18h).
 *                     Null = sem restrição de horário.
 *   saida_quantidade  quantas matérias saem juntas em cada lote.
 *   saida_minutos     de quantos em quantos minutos sai um lote.
 *
 * `scan_minutos` (migration anterior) continua sendo o ritmo da varredura, que
 * é o que enche o estoque de posts de onde as matérias saem.
 *
 * @param {import('knex').Knex} knex
 */
const COLUNAS = ['dias_semana', 'hora_inicio', 'hora_fim', 'saida_quantidade', 'saida_minutos'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;

  const faltando = [];
  for (const coluna of COLUNAS) {
    if (!(await knex.schema.hasColumn('dots', coluna))) faltando.push(coluna);
  }
  if (!faltando.length) return;

  await knex.schema.alterTable('dots', (table) => {
    if (faltando.includes('dias_semana')) table.string('dias_semana', 20).nullable();
    if (faltando.includes('hora_inicio')) table.integer('hora_inicio').unsigned().nullable();
    if (faltando.includes('hora_fim')) table.integer('hora_fim').unsigned().nullable();
    // Default 1 e 15 reproduzem o comportamento de hoje para quem já tem dot.
    if (faltando.includes('saida_quantidade')) {
      table.integer('saida_quantidade').unsigned().notNullable().defaultTo(1);
    }
    if (faltando.includes('saida_minutos')) {
      table.integer('saida_minutos').unsigned().notNullable().defaultTo(15);
    }
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;
  for (const coluna of COLUNAS) {
    if (await knex.schema.hasColumn('dots', coluna)) {
      await knex.schema.alterTable('dots', (table) => table.dropColumn(coluna));
    }
  }
};
