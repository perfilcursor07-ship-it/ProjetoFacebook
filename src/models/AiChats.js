const db = require('../config/db');

const AiChats = {
  table: 'ai_chats',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByIdForUser(id, userId) {
    return db(this.table).where({ id, user_id: userId }).first();
  },

  /** Conversas do usuário com prévia da última mensagem (sidebar do chat). */
  async findByUser(userId, { limit = 60 } = {}) {
    const rows = await db(`${this.table} as c`)
      .where('c.user_id', userId)
      .orderBy('c.fixado', 'desc')
      .orderByRaw('COALESCE(c.last_message_at, c.created_at) DESC')
      .limit(Math.min(200, Math.max(1, Number(limit) || 60)))
      .select(
        'c.id',
        'c.titulo',
        'c.modo',
        // Sem a coluna aqui a lista não saberia separar chat de Dots/Furos.
        'c.origem',
        'c.fixado',
        'c.pesquisar_web',
        'c.tom',
        'c.periodo',
        'c.last_message_at',
        'c.created_at',
        db.raw(
          '(SELECT COUNT(*) FROM ai_chat_messages m WHERE m.chat_id = c.id) as total_mensagens'
        )
      );
    return rows;
  },

  async create(data) {
    const [id] = await db(this.table).insert(data);
    return id;
  },

  update(id, data) {
    return db(this.table)
      .where({ id })
      .update({ ...data, updated_at: db.fn.now() });
  },

  touch(id) {
    return db(this.table)
      .where({ id })
      .update({ last_message_at: db.fn.now(), updated_at: db.fn.now() });
  },

  remove(id, userId) {
    return db(this.table).where({ id, user_id: userId }).del();
  },

  /** Exclui várias conversas do usuário de uma vez; devolve quantas saíram. */
  removeMany(ids, userId) {
    return db(this.table).where({ user_id: userId }).whereIn('id', ids).del();
  },
};

module.exports = AiChats;
