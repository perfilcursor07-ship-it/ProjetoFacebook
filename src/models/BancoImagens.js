const db = require('../config/db');

const BancoImagens = {
  table: 'banco_imagens',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByArquivo(userId, arquivo) {
    return db(this.table).where({ user_id: userId, arquivo }).first();
  },

  findByHash(userId, hash) {
    return db(this.table).where({ user_id: userId, hash }).first();
  },

  /** Mais recentes primeiro; `origem` filtra e `q` procura no título/pedido. */
  listar(userId, { origem = null, q = '', limite = 60, pagina = 1 } = {}) {
    const lim = Math.min(120, Math.max(1, Number(limite) || 60));
    const pag = Math.max(1, Number(pagina) || 1);
    const query = db(this.table).where({ user_id: userId });
    if (origem === 'ia') query.whereIn('origem', ['ia', 'chatgpt', 'grok']);
    else if (origem) query.andWhere({ origem });
    const termo = String(q || '').trim();
    if (termo) {
      query.andWhere((w) => {
        w.where('titulo', 'like', `%${termo}%`).orWhere('prompt', 'like', `%${termo}%`);
      });
    }
    return query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(lim + 1)
      .offset((pag - 1) * lim);
  },

  async contarPorOrigem(userId) {
    const linhas = await db(this.table)
      .where({ user_id: userId })
      .select('origem')
      .count('* as total')
      .groupBy('origem');
    return Object.fromEntries(linhas.map((l) => [l.origem, Number(l.total) || 0]));
  },

  async create(data) {
    const [id] = await db(this.table).insert(data);
    return id;
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...data, updated_at: db.fn.now() });
  },

  marcarUso(id) {
    return db(this.table)
      .where({ id })
      .update({ usos: db.raw('usos + 1'), usada_em: db.fn.now(), updated_at: db.fn.now() });
  },

  delete(id) {
    return db(this.table).where({ id }).delete();
  },
};

module.exports = BancoImagens;
