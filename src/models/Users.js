const db = require('../config/db');

const Users = {
  table: 'users',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByEmail(email) {
    return db(this.table).where({ email }).first();
  },

  list() {
    return db(this.table)
      .select(
        'id',
        'nome',
        'email',
        'nivel_acesso',
        'logo_path',
        'default_facebook_page_id',
        // Sem esta coluna a tela de permissões remontava tudo marcado: o
        // usuário vinha sem o campo e `permitidos()` entendia como "nunca
        // configurado = tudo liberado".
        'modulos_materia',
        'created_at',
        'updated_at'
      )
      .orderBy('nome', 'asc');
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...data, updated_at: db.fn.now() });
  },

  remove(id) {
    return db(this.table).where({ id }).del();
  },

  countByAccess(nivelAcesso) {
    return db(this.table).where({ nivel_acesso: nivelAcesso }).count({ total: '*' }).first();
  },

  async getDefaultFacebookPageId(userId) {
    const row = await db(this.table).where({ id: userId }).select('default_facebook_page_id').first();
    const id = Number(row?.default_facebook_page_id || 0);
    return id > 0 ? id : null;
  },

  setDefaultFacebookPageId(userId, facebookPageId) {
    return this.update(userId, {
      default_facebook_page_id: facebookPageId ? Number(facebookPageId) : null,
    });
  },
};

module.exports = Users;
