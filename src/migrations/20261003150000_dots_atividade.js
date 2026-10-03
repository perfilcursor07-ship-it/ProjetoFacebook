/**
 * Dots: o que o agente está fazendo AGORA.
 *
 * Sem isso a tela só conseguia mostrar o resumo do fim do ciclo — e um ciclo
 * leva minutos (varrer dezenas de páginas, escrever matéria). O editor ficava
 * olhando para "última volta há 4 min" sem saber se o dot estava vivo.
 *
 *   `trabalhando`  — separa "Em andamento" de "Agendado" na tela.
 *   `atividade`    — frase do passo atual ("escrevendo: Lula sanciona...").
 *   `atividade_em` — quando o passo começou, para a tela mostrar o tempo e
 *                    detectar ciclo travado.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;

  const novas = [];
  if (!(await knex.schema.hasColumn('dots', 'trabalhando'))) novas.push('trabalhando');
  if (!(await knex.schema.hasColumn('dots', 'atividade'))) novas.push('atividade');
  if (!(await knex.schema.hasColumn('dots', 'atividade_em'))) novas.push('atividade_em');
  if (!novas.length) return;

  await knex.schema.alterTable('dots', (table) => {
    if (novas.includes('trabalhando')) table.boolean('trabalhando').notNullable().defaultTo(false);
    if (novas.includes('atividade')) table.string('atividade', 300).nullable();
    if (novas.includes('atividade_em')) table.timestamp('atividade_em').nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('dots'))) return;
  for (const coluna of ['trabalhando', 'atividade', 'atividade_em']) {
    if (await knex.schema.hasColumn('dots', coluna)) {
      await knex.schema.alterTable('dots', (table) => table.dropColumn(coluna));
    }
  }
};
