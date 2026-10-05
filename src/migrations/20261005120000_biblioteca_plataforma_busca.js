/**
 * Adiciona a plataforma "busca": uma pesquisa por assunto no Google Notícias
 * que se comporta como fonte. É o que permite ao dot "pesquisar o que o editor
 * pediu" sem que ele precise colar link nenhum.
 */
exports.up = async function up(knex) {
  const client = knex.client?.config?.client || '';
  if (!String(client).includes('mysql')) return;

  await knex.raw(`
    ALTER TABLE biblioteca_fontes
    MODIFY COLUMN plataforma
    ENUM('youtube', 'facebook', 'instagram', 'tiktok', 'site', 'busca', 'outro')
    NOT NULL DEFAULT 'outro'
  `);
};

exports.down = async function down(knex) {
  const client = knex.client?.config?.client || '';
  if (!String(client).includes('mysql')) return;

  // Pesquisas não têm equivalente nas outras plataformas: saem da biblioteca.
  const ids = await knex('biblioteca_fontes').where({ plataforma: 'busca' }).pluck('id');
  if (ids.length) {
    await knex('biblioteca_alertas').whereIn('fonte_id', ids).del();
    await knex('biblioteca_posts').whereIn('fonte_id', ids).del();
    await knex('biblioteca_fontes').whereIn('id', ids).del();
  }
  await knex.raw(`
    ALTER TABLE biblioteca_fontes
    MODIFY COLUMN plataforma
    ENUM('youtube', 'facebook', 'instagram', 'tiktok', 'site', 'outro')
    NOT NULL DEFAULT 'outro'
  `);
};
