const db = require('../config/db');

/**
 * VARCHAR(300) em ai_matters.titulo — corta antes do MySQL estourar.
 *
 * Também tira a marcação de bloco do Claude web, que já saiu publicada colada
 * no título ("<WritingBlock id="63928" variant="document">Pastor itinerante
 * é preso…"). A limpeza certa é na resposta da IA, em chatgptMarkup; aqui é a
 * última trava, para nenhum caminho de escrita furar.
 */
function limparTitulo(valor) {
  const { removerBlocosDoClaude } = require('../services/chatgptMarkup');
  return removerBlocosDoClaude(String(valor)).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function prepare(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  if (out.titulo != null) out.titulo = limparTitulo(out.titulo);
  if (out.titulo_ia != null) out.titulo_ia = limparTitulo(out.titulo_ia);
  if (out.fonte_titulo != null) {
    out.fonte_titulo = String(out.fonte_titulo).replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  if (out.fonte_credito != null) {
    out.fonte_credito = String(out.fonte_credito).replace(/\r\n/g, '\n').trim().slice(0, 2000);
  }
  return out;
}

/**
 * Critério da aba "Viralizou": posts com Bom OU Viralizou
 * (score >= 80 OU likes >= 40 OU comments >= 10).
 * Antes só entrava o nível "alto" (muito restrito) e posts sem engajamento
 * sincronizado no banco ficavam de fora.
 */
const VIRAL_SCORE_SQL =
  '(COALESCE(publications.fb_likes, 0) + COALESCE(publications.fb_comments, 0) * 3 + COALESCE(publications.fb_shares, 0) * 5 + LEAST(COALESCE(publications.fb_views, 0), 5000) / 50)';

function whereViralMinimo() {
  this.whereRaw(`${VIRAL_SCORE_SQL} >= 80`)
    .orWhere('publications.fb_likes', '>=', 40)
    .orWhere('publications.fb_comments', '>=', 10);
}

function whereViralAlto() {
  this.whereRaw(`${VIRAL_SCORE_SQL} >= 180`)
    .orWhere('publications.fb_likes', '>=', 80)
    .orWhere('publications.fb_comments', '>=', 25);
}

function applyViralizouFilter(query, nivel = 'all') {
  const filtro = ['alto', 'medio'].includes(String(nivel || '').toLowerCase())
    ? String(nivel).toLowerCase()
    : 'all';

  if (filtro === 'alto') return query.where(whereViralAlto);

  query = query.where(whereViralMinimo);
  if (filtro === 'medio') query = query.whereNot(whereViralAlto);
  return query;
}

/**
 * Critério da agenda "Viralizadas": páginas gospel mid-size.
 * Qualquer engajamento real já entra; ordenação por score puxa as melhores.
 */
function applyAgendaViralFilter(query) {
  return query.where(function engWhere() {
    this.where('publications.fb_likes', '>', 0)
      .orWhere('publications.fb_comments', '>', 0)
      .orWhere('publications.fb_views', '>', 0)
      .orWhere('publications.fb_shares', '>', 0);
  });
}

async function pageIdsDaConta(userId) {
  const FacebookAccounts = require('./FacebookAccounts');
  const FacebookPages = require('./FacebookPages');
  const account = await FacebookAccounts.findByUser(userId);
  if (!account) return [];
  return (await FacebookPages.findByAccount(account.id))
    .map((p) => Number(p.id))
    .filter(Boolean);
}

/**
 * IDs internos de facebook_pages que compartilham o mesmo page_id social (FB)
 * OU o mesmo nome de Página — inclui histórico de outros logins do ViralizeAI.
 */
async function pageRowIdsComMesmoSocial(userId) {
  const próprios = await pageIdsDaConta(userId);
  if (!próprios.length) return [];

  const rows = await db('facebook_pages')
    .whereIn('id', próprios)
    .select('id', 'page_id', 'page_name');

  const ids = new Set(próprios.map(Number));

  const sociais = [
    ...new Set(
      (rows || [])
        .map((r) => String(r.page_id || '').trim())
        .filter(Boolean)
    ),
  ];
  if (sociais.length) {
    const porSocial = await db('facebook_pages').whereIn('page_id', sociais).pluck('id');
    for (const id of porSocial || []) ids.add(Number(id));
  }

  // Fallback por nome (ex.: "Apocalipse Gospel" em outra conta sem page_id igual)
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const nomes = new Set((rows || []).map((r) => norm(r.page_name)).filter(Boolean));
  if (nomes.size) {
    const todas = await db('facebook_pages').select('id', 'page_name');
    for (const r of todas || []) {
      if (nomes.has(norm(r.page_name))) ids.add(Number(r.id));
    }
  }

  return [...ids].filter(Boolean);
}

function applySearchFilter(query, q) {
  const term = String(q || '').trim();
  if (!term) return query;
  const like = `%${term.replace(/[%_]/g, '')}%`;
  return query.andWhere(function whereQ() {
    this.where('ai_matters.titulo', 'like', like)
      .orWhere('ai_matters.materia', 'like', like)
      .orWhere('ai_matters.fonte_titulo', 'like', like)
      .orWhere('facebook_pages.page_name', 'like', like);
  });
}

/**
 * Ordenação da lista Minhas matérias:
 * - Aba Agendadas: horário de agendamento (mais cedo → mais tarde)
 * - Aba Todas: Agendadas (por horário) → Rascunhos → Prontas → Erros → Publicadas
 * - Aba Viralizou: maior pontuação de engajamento → menor (com outras opções)
 * - Demais abas: mais recentes primeiro
 */
function applyListOrder(query, status, viralOrder = 'viral') {
  const st = String(status || '').trim().toLowerCase();

  if (st === 'agendado') {
    return query.orderByRaw(
      'COALESCE(ai_matters.scheduled_at, ai_matters.created_at) ASC, ai_matters.id ASC'
    );
  }

  if (st === 'rascunho' || st === 'pronto' || st === 'erro') {
    return query.orderBy('ai_matters.created_at', 'desc');
  }

  if (st === 'viralizou') {
    const recentSql =
      'COALESCE(ai_matters.published_at, publications.published_at, ai_matters.created_at) DESC, ai_matters.id DESC';
    const orders = {
      viral: `${VIRAL_SCORE_SQL} DESC, ${recentSql}`,
      curtidas: `COALESCE(publications.fb_likes, 0) DESC, ${VIRAL_SCORE_SQL} DESC, ${recentSql}`,
      comentarios: `COALESCE(publications.fb_comments, 0) DESC, ${VIRAL_SCORE_SQL} DESC, ${recentSql}`,
      compartilhamentos: `COALESCE(publications.fb_shares, 0) DESC, ${VIRAL_SCORE_SQL} DESC, ${recentSql}`,
      visualizacoes: `COALESCE(publications.fb_views, 0) DESC, ${VIRAL_SCORE_SQL} DESC, ${recentSql}`,
      recente: recentSql,
    };
    const key = String(viralOrder || '').trim().toLowerCase();
    return query.orderByRaw(orders[key] || orders.viral);
  }

  if (st === 'publicado') {
    return query.orderByRaw(
      'COALESCE(ai_matters.published_at, publications.published_at, ai_matters.created_at) DESC'
    );
  }

  // Todas: agendadas primeiro (por horário), depois rascunhos, resto por data
  return query.orderByRaw(`
    CASE ai_matters.status
      WHEN 'agendado' THEN 0
      WHEN 'rascunho' THEN 1
      WHEN 'pronto' THEN 2
      WHEN 'erro' THEN 3
      WHEN 'publicado' THEN 4
      ELSE 5
    END ASC,
    CASE
      WHEN ai_matters.status = 'agendado'
      THEN COALESCE(ai_matters.scheduled_at, '9999-12-31 23:59:59')
      ELSE NULL
    END ASC,
    CASE
      WHEN ai_matters.status <> 'agendado'
      THEN COALESCE(ai_matters.published_at, ai_matters.created_at)
      ELSE NULL
    END DESC,
    ai_matters.id ASC
  `);
}

const AiMatters = {
  table: 'ai_matters',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByUser(userId, limit = 30) {
    return db(this.table).where({ user_id: userId }).orderBy('created_at', 'desc').limit(limit);
  },

  /**
   * Referências leves de todo o histórico que já virou matéria na conta.
   * Usado pelos radares para não oferecer novamente pauta publicada,
   * agendada, pronta ou ainda em rascunho.
   */
  findUsedReferencesByUser(userId) {
    return db(this.table)
      .where({ user_id: userId })
      .andWhere(function matterJaUsada() {
        this.whereIn('status', ['rascunho', 'pronto', 'agendado', 'publicado']).orWhereNotNull(
          'publication_id'
        );
      })
      .select(
        'id',
        'titulo',
        'fonte_titulo',
        'fonte_url',
        'status',
        'publication_id',
        'facebook_page_id'
      );
  },

  findRecentWithPage(userId, limit = 6) {
    return db(this.table)
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .where('ai_matters.user_id', userId)
      .select(
        'ai_matters.id',
        'ai_matters.titulo',
        'ai_matters.status',
        'ai_matters.scheduled_at',
        'ai_matters.published_at',
        'ai_matters.updated_at',
        'ai_matters.created_at',
        'facebook_pages.page_name as page_name'
      )
      .orderBy('ai_matters.updated_at', 'desc')
      .limit(Math.max(1, Math.min(20, Number(limit) || 6)));
  },

  countByDay(userId, days = 7) {
    const d = Math.max(1, Math.min(90, Number(days) || 7));
    return db(this.table)
      .where({ user_id: userId })
      .where('created_at', '>=', db.raw('DATE_SUB(CURDATE(), INTERVAL ? DAY)', [d - 1]))
      .select(db.raw('DATE(created_at) as dia'))
      .count('* as total')
      .groupByRaw('DATE(created_at)')
      .orderBy('dia', 'asc');
  },

  /**
   * Lista matérias com dados da publicação (views, link FB).
   * @param {object} opts
   * @param {string|null} [opts.status] status da matéria, ou 'viralizou'
   */
  findByUserWithPub(
    userId,
    { limit = 100, offset = 0, q = '', status = null, viralLevel = 'all', viralOrder = 'viral' } = {}
  ) {
    const st = String(status || '').trim().toLowerCase();
    const viralFilter = st === 'viralizou';

    let query = db(this.table)
      .leftJoin('publications', 'ai_matters.publication_id', 'publications.id')
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .where('ai_matters.user_id', userId)
      .select(
        'ai_matters.*',
        'publications.fb_post_id as pub_fb_post_id',
        'publications.fb_post_url as pub_fb_post_url',
        'publications.fb_views as pub_fb_views',
        'publications.fb_views_at as pub_fb_views_at',
        'publications.fb_likes as pub_fb_likes',
        'publications.fb_comments as pub_fb_comments',
        'publications.fb_shares as pub_fb_shares',
        'publications.fb_native_post_id as pub_fb_native_post_id',
        'publications.status as pub_status',
        'publications.published_at as pub_published_at',
        'facebook_pages.page_name as page_name'
      )
      .limit(Math.max(1, Math.min(100, Number(limit) || 20)))
      .offset(Math.max(0, Number(offset) || 0));

    if (viralFilter) {
      query = applyViralizouFilter(query, viralLevel);
    } else if (st && st !== 'all') {
      query = query.andWhere('ai_matters.status', st);
    }

    query = applySearchFilter(query, q);
    query = applyListOrder(query, viralFilter ? 'viralizou' : st || 'all', viralOrder);
    return query;
  },

  async countByUserWithPub(userId, { q = '', status = null, viralLevel = 'all' } = {}) {
    const st = String(status || '').trim().toLowerCase();
    const viralFilter = st === 'viralizou';

    let query = db(this.table)
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .where('ai_matters.user_id', userId);

    if (viralFilter) {
      query = query.leftJoin('publications', 'ai_matters.publication_id', 'publications.id');
      query = applyViralizouFilter(query, viralLevel);
    } else if (st && st !== 'all') {
      query = query.andWhere('ai_matters.status', st);
    }

    query = applySearchFilter(query, q);

    const row = await query.count({ total: '*' }).first();
    return Number(row?.total) || 0;
  },

  /**
   * Viralizadas p/ agenda: publicadas de TODAS as Páginas FB da conta
   * (bate pelo page_id social — pega Apocalipse mesmo se o histórico
   * estiver em outro login do ViralizeAI).
   */
  async findViralizadasDaConta(userId, { limit = 40 } = {}) {
    const pageIds = await pageRowIdsComMesmoSocial(userId);
    const lim = Math.min(80, Math.max(1, Number(limit) || 40));

    let query = db(this.table)
      .leftJoin('publications', 'ai_matters.publication_id', 'publications.id')
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .where(function ownership() {
        this.where('ai_matters.user_id', userId);
        if (pageIds.length) {
          this.orWhereIn('ai_matters.facebook_page_id', pageIds);
        }
      })
      .whereNotNull('ai_matters.publication_id')
      .select(
        'ai_matters.*',
        'publications.fb_post_id as pub_fb_post_id',
        'publications.fb_post_url as pub_fb_post_url',
        'publications.fb_views as pub_fb_views',
        'publications.fb_views_at as pub_fb_views_at',
        'publications.fb_likes as pub_fb_likes',
        'publications.fb_comments as pub_fb_comments',
        'publications.fb_shares as pub_fb_shares',
        'publications.fb_native_post_id as pub_fb_native_post_id',
        'publications.status as pub_status',
        'publications.published_at as pub_published_at',
        'facebook_pages.page_name as page_name'
      )
      .limit(lim);

    query = applyAgendaViralFilter(query);
    query = query.orderByRaw(
      `(COALESCE(publications.fb_likes, 0) + COALESCE(publications.fb_comments, 0) * 3 + COALESCE(publications.fb_shares, 0) * 5 + LEAST(COALESCE(publications.fb_views, 0), 5000) / 50) DESC`
    );

    return query;
  },

  async countViralizadasDaConta(userId) {
    const pageIds = await pageRowIdsComMesmoSocial(userId);

    let query = db(this.table)
      .leftJoin('publications', 'ai_matters.publication_id', 'publications.id')
      .where(function ownership() {
        this.where('ai_matters.user_id', userId);
        if (pageIds.length) {
          this.orWhereIn('ai_matters.facebook_page_id', pageIds);
        }
      })
      .whereNotNull('ai_matters.publication_id');
    query = applyAgendaViralFilter(query);
    const row = await query.count({ total: '*' }).first();
    return Number(row?.total) || 0;
  },

  /** Diagnóstico: engajamento por Página (próprias + mesmo page_id social em outras contas). */
  async diagnosticoEngajamentoConta(userId) {
    const próprios = await pageIdsDaConta(userId);
    const pageIdsExpandido = await pageRowIdsComMesmoSocial(userId);
    const pages = próprios.length
      ? await db('facebook_pages').whereIn('id', próprios).select('id', 'page_name', 'page_id')
      : [];

    const porPagina = [];
    for (const p of pages) {
      // Todas as rows facebook_pages com o mesmo page_id social
      let rowIds = [Number(p.id)];
      if (p.page_id) {
        const irmaos = await db('facebook_pages').where({ page_id: String(p.page_id) }).pluck('id');
        rowIds = [...new Set([...(irmaos || []).map(Number), Number(p.id)])];
      }

      const base = () =>
        db(this.table)
          .leftJoin('publications', 'ai_matters.publication_id', 'publications.id')
          .whereIn('ai_matters.facebook_page_id', rowIds)
          .whereNotNull('ai_matters.publication_id');

      const [{ total: publicadas }] = await base().count({ total: '*' });
      const [{ total: comEng }] = await applyAgendaViralFilter(base()).count({ total: '*' });
      const [{ total: viralStrict }] = await applyViralizouFilter(base()).count({ total: '*' });

      const top = await applyAgendaViralFilter(base())
        .select(
          'ai_matters.id',
          'ai_matters.titulo',
          'ai_matters.user_id',
          'ai_matters.facebook_page_id',
          'publications.fb_likes',
          'publications.fb_comments',
          'publications.fb_views',
          'publications.fb_views_at'
        )
        .orderByRaw(
          `(COALESCE(publications.fb_likes, 0) + COALESCE(publications.fb_comments, 0) * 3) DESC`
        )
        .limit(5);

      porPagina.push({
        page_id: p.id,
        page_name: p.page_name,
        fb_page_id: p.page_id,
        rows_equivalentes: rowIds,
        publicadas: Number(publicadas) || 0,
        com_engajamento: Number(comEng) || 0,
        viralizou_estrito: Number(viralStrict) || 0,
        top: (top || []).map((t) => ({
          id: t.id,
          user_id: t.user_id,
          facebook_page_id: t.facebook_page_id,
          titulo: String(t.titulo || '').slice(0, 80),
          likes: t.fb_likes,
          comments: t.fb_comments,
          views: t.fb_views,
          views_at: t.fb_views_at,
        })),
      });
    }

    return {
      userId: Number(userId),
      pageIds: próprios,
      pageIdsExpandido,
      porPagina,
    };
  },

  async countByStatusForUser(userId, { q = '' } = {}) {
    let query = db(this.table)
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .where('ai_matters.user_id', userId);

    query = applySearchFilter(query, q);

    const rows = await query
      .select('ai_matters.status')
      .count('* as total')
      .groupBy('ai_matters.status');

    const out = {};
    let all = 0;
    for (const row of rows || []) {
      const key = row.status || 'rascunho';
      const n = Number(row.total) || 0;
      out[key] = n;
      all += n;
    }
    out.all = all;

    // Contagem da aba Viralizou (critério de engajamento, não status)
    let viralQuery = db(this.table)
      .leftJoin('publications', 'ai_matters.publication_id', 'publications.id')
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .where('ai_matters.user_id', userId);
    viralQuery = applySearchFilter(viralQuery, q);
    viralQuery = applyViralizouFilter(viralQuery);
    const viralRow = await viralQuery.count({ total: '*' }).first();
    out.viralizou = Number(viralRow?.total) || 0;

    return out;
  },

  create(data) {
    return db(this.table).insert(prepare(data));
  },

  async update(id, data) {
    // Publicada ou falhou ao publicar: aviso no celular (ntfy), uma vez por mudança.
    const avisar = data?.status === 'publicado' || data?.status === 'erro';
    const antes = avisar ? await db(this.table).where({ id }).first('status') : null;
    const alteradas = await db(this.table).where({ id }).update({ ...prepare(data), updated_at: db.fn.now() });
    if (avisar && antes && antes.status !== data.status) {
      require('../services/avisoPublicacao').avisar(id, data.status);
    }
    return alteradas;
  },

  delete(id) {
    return db(this.table).where({ id }).del();
  },

  deleteByUser(id, userId) {
    return db(this.table).where({ id, user_id: userId }).del();
  },

  /** Exclui várias matérias do usuário. Opcionalmente restringe ao status (ex.: rascunho). */
  deleteManyByUser(ids, userId, { status = null } = {}) {
    const list = (Array.isArray(ids) ? ids : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!list.length) return Promise.resolve(0);
    let q = db(this.table).where({ user_id: userId }).whereIn('id', list);
    if (status) q = q.andWhere({ status: String(status) });
    return q.del();
  },

  /** Exclui todas as matérias do usuário com o status informado. */
  deleteAllByUserStatus(userId, status) {
    const st = String(status || '').trim();
    if (!st) return Promise.resolve(0);
    return db(this.table).where({ user_id: userId, status: st }).del();
  },

  /** Publicadas pendentes de sincronização; depois revisita as métricas mais antigas. */
  findRecentPublishedForSync(userId, limit = 30) {
    return db(`${this.table} as m`)
      .leftJoin('publications as p', 'p.id', 'm.publication_id')
      .where('m.user_id', userId)
      .whereNotNull('m.publication_id')
      .where(function statusPub() {
        this.where('m.status', 'publicado').orWhereNotNull('m.published_at');
      })
      .orderByRaw(
        'CASE WHEN p.fb_views_at IS NULL THEN 0 ELSE 1 END ASC, p.fb_views_at ASC, COALESCE(m.published_at, p.published_at, m.updated_at, m.created_at) DESC'
      )
      .limit(Math.max(1, Math.min(60, Number(limit) || 30)))
      .select(
        'm.id',
        'm.publication_id',
        'm.titulo',
        'm.status',
        'm.user_id',
        'm.facebook_page_id'
      );
  },

  /** Publicadas recentes de todas as Páginas FB equivalentes (mesmo page_id social). */
  async findRecentPublishedDaContaForSync(userId, limit = 40) {
    const pageIds = await pageRowIdsComMesmoSocial(userId);
    const lim = Math.max(1, Math.min(80, Number(limit) || 40));
    return db(`${this.table} as m`)
      .leftJoin('publications as p', 'p.id', 'm.publication_id')
      .where(function ownership() {
        this.where('m.user_id', userId);
        if (pageIds.length) this.orWhereIn('m.facebook_page_id', pageIds);
      })
      .whereNotNull('m.publication_id')
      .where(function statusPub() {
        this.where('m.status', 'publicado').orWhereNotNull('m.published_at');
      })
      .orderByRaw(
        'CASE WHEN p.fb_views_at IS NULL THEN 0 ELSE 1 END ASC, p.fb_views_at ASC, COALESCE(m.published_at, p.published_at, m.updated_at, m.created_at) DESC'
      )
      .limit(lim)
      .select(
        'm.id',
        'm.publication_id',
        'm.titulo',
        'm.status',
        'm.user_id',
        'm.facebook_page_id'
      );
  },

  /** True se a matéria é do user ou de Página FB equivalente à conta dele. */
  async matterAcessivelPelaConta(userId, matter) {
    if (!matter) return false;
    if (Number(matter.user_id) === Number(userId)) return true;
    const pageIds = await pageRowIdsComMesmoSocial(userId);
    return pageIds.includes(Number(matter.facebook_page_id));
  },
};

module.exports = AiMatters;
