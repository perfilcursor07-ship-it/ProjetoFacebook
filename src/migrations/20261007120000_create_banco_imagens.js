/**
 * Banco de imagens do editor: fotos limpas (sem o título e sem a marca da
 * arte) para reaproveitar como capa sem gerar de novo.
 *
 * Entram aqui as imagens geradas com IA (ChatGPT, Grok, Gemini) pelo
 * sistema, as enviadas pelo editor, as importadas da biblioteca do ChatGPT
 * ou do Grok e as fotos antigas que já estavam em storage/fontes.
 *
 * O arquivo é uma CÓPIA em storage/banco-imagens: as fontes das matérias
 * são apagadas quando a capa é trocada ou recortada, e a imagem do banco
 * precisa continuar existindo.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('banco_imagens')) return;
  await knex.schema.createTable('banco_imagens', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable();
    // ia | upload | chatgpt | grok | sistema
    table.string('origem', 20).notNullable().defaultTo('upload');
    table.string('gerador', 20).nullable();
    table.string('titulo', 255).nullable();
    table.text('prompt').nullable();
    table.string('arquivo', 255).notNullable();
    table.string('miniatura', 255).notNullable();
    table.integer('largura').unsigned().nullable();
    table.integer('altura').unsigned().nullable();
    table.string('hash', 64).notNullable();
    table.integer('matter_id').unsigned().nullable();
    table.integer('usos').unsigned().notNullable().defaultTo(0);
    table.dateTime('usada_em').nullable();
    table.timestamps(true, true);
    // A mesma imagem gerada/enviada duas vezes vira um registro só.
    table.unique(['user_id', 'hash'], 'banco_imagens_user_hash_uq');
    table.index(['user_id', 'origem'], 'banco_imagens_user_origem_idx');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('banco_imagens');
};
