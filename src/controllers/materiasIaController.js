const materiaIaService = require('../services/materiaIaService');
const AiMatters = require('../models/AiMatters');
const AiMonitors = require('../models/AiMonitors');
const Users = require('../models/Users');
const { composeMatterArtwork } = require('../services/matterArtworkService');
const { extractMatterSourceLinks } = require('../services/matterSourceLinks');

function pickPageId(body = {}) {
  const raw = body.facebookPageId ?? body.facebook_page_id;
  return raw != null && raw !== '' ? Number(raw) : null;
}

async function resolvePageId(userId, body = {}) {
  const { defaultPageIdForUser, resolvePageForUser } = require('../services/facebookPageResolver');
  const fromBody = pickPageId(body);
  if (fromBody) {
    // Só aceita página do próprio usuário; caso contrário cai para a padrão dele.
    const page = await resolvePageForUser(userId, fromBody);
    if (page) return Number(page.id);
  }
  return defaultPageIdForUser(userId);
}

function pickTipo(body = {}) {
  const raw = body.tipoPublicacao ?? body.tipo_publicacao ?? 'texto';
  if (raw === 'foto') return 'foto';
  if (raw === 'reel') return 'reel';
  if (raw === 'auto') return 'auto';
  return 'texto';
}

async function pesquisar(req, res, next) {
  try {
    const body = req.body || {};
    const palavrasChave = body.palavrasChave || body.palavras_chave;
    const quantidadePorNicho = body.quantidadePorNicho ?? body.quantidade_por_nicho ?? 5;
    const incluirRedes = Boolean(
      body.incluirRedes ?? body.incluirRedesSociais ?? body.incluir_redes_sociais
    );
    const somenteRedes = Boolean(
      body.somenteRedes ?? body.somenteRedesSociais ?? body.somente_redes_sociais
    );
    const diasRecentes = body.diasRecentes ?? body.dias_recentes;
    const periodo =
      body.periodo ||
      (diasRecentes ? `${Number(diasRecentes)}d` : '24h');
    const filtrarPeriodo = body.filtrarPeriodo !== false;
    const facebookPageId = await resolvePageId(req.session.userId, body);

    if (!String(palavrasChave || '').trim()) {
      return res.status(400).json({ error: 'Informe palavras-chave' });
    }

    // trends / internacional: aceitos no body (extensão futura); Google News já cobre pt-BR
    void body.trends;
    void body.internacional;

    let topicos = await materiaIaService.pesquisarNichos(palavrasChave, quantidadePorNicho, {
      periodo,
      diasRecentes,
      incluirRedesSociais: incluirRedes,
      somenteRedesSociais: somenteRedes,
      filtrarPeriodo,
    });

    topicos = await materiaIaService.marcarJaPublicados(
      req.session.userId,
      facebookPageId,
      topicos
    );

    res.json({ ok: true, topicos });
  } catch (err) {
    next(err);
  }
}

async function emAlta(req, res, next) {
  try {
    const body = req.body || {};
    const palavrasExtras = body.palavrasExtras || body.palavras_extras || '';
    const horas = body.horas || 24;
    const facebookPageId = await resolvePageId(req.session.userId, body);
    const result = await materiaIaService.buscarEmAltaAgora(palavrasExtras, { horas });
    const topicos = await materiaIaService.marcarJaPublicados(
      req.session.userId,
      facebookPageId,
      result.topicos || []
    );
    res.json({ ok: true, ...result, topicos });
  } catch (err) {
    next(err);
  }
}

async function radarFace(req, res, next) {
  try {
    const body = req.body || {};
    const palavrasExtras = body.palavrasExtras || body.palavras_extras || body.keywords || '';
    const url = body.url || body.link || body.fonteUrl || '';
    const force = body.force === true || body.force === '1' || body.force === 1;
    const facebookPageId = await resolvePageId(req.session.userId, body);
    const radarFaceService = require('../services/radarFaceService');
    const result = await radarFaceService.analisarRadarFace({
      palavrasExtras,
      url,
      force,
    });
    const topicos = await materiaIaService.marcarJaPublicados(
      req.session.userId,
      facebookPageId,
      result.topicos || []
    );
    res.json({ ok: true, ...result, topicos });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, avisos: err.avisos || [] });
    return next(err);
  }
}

async function gerar(req, res, next) {
  try {
    const body = req.body || {};
    const topico = body.topico;
    if (!topico || !topico.titulo) {
      return res.status(400).json({ error: 'Envie um tópico válido' });
    }

    const facebookPageId = await resolvePageId(req.session.userId, body);
    const tipoPublicacao = pickTipo(body);
    const status = String(body.status || 'rascunho').toLowerCase() === 'publicado'
      ? 'publicado'
      : 'rascunho';

    if (status === 'publicado' && !facebookPageId) {
      return res.status(400).json({ error: 'Selecione a página do Facebook para publicar' });
    }

    const result = await materiaIaService.gerarCompleto({
      userId: req.session.userId,
      topico,
      facebookPageId,
      tipoPublicacao,
      status,
      investigativa: Boolean(body.investigativa),
      furoReportagem: Boolean(body.furoReportagem || body.furo_reportagem),
    });

    res.json({
      ok: true,
      ...result,
      preview: result.artigo,
      link: result.fbPostUrl || result.instagramPostUrl || null,
    });
  } catch (err) {
    next(err);
  }
}

async function reescreverLink(req, res, next) {
  try {
    const body = req.body || {};
    const url = body.url || body.link;
    if (!String(url || '').trim()) {
      return res.status(400).json({ error: 'Cole o link da notícia' });
    }

    const facebookPageId = await resolvePageId(req.session.userId, body);
    const tipoPublicacao = pickTipo(body);
    const status = String(body.status || 'rascunho').toLowerCase() === 'publicado'
      ? 'publicado'
      : 'rascunho';

    if (status === 'publicado' && !facebookPageId) {
      return res.status(400).json({ error: 'Selecione a página do Facebook para publicar' });
    }

    const result = await materiaIaService.gerarDeLink({
      userId: req.session.userId,
      url,
      facebookPageId,
      tipoPublicacao,
      status,
      textoManual: body.textoManual || body.legenda || body.texto || '',
      imagemManual: body.imagemManual || body.imagemUrl || body.imagem || '',
    });

    // Reel: AiMatter + processamento em background → /materias-ia/:id
    if (result.modo === 'reel') {
      return res.status(result.queued ? 202 : 200).json({
        ok: true,
        modo: 'reel',
        queued: result.queued,
        matter: result.matter,
        video: result.video,
        clip: result.clip || null,
        redirect: result.redirect || (result.matter?.id ? `/materias-ia/${result.matter.id}` : '/minhas-materias'),
        aviso: result.aviso,
      });
    }

    res.json({
      ok: true,
      ...result,
      preview: result.artigo,
      link: result.fbPostUrl || result.instagramPostUrl || result.xPostUrl || null,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function gerarPreview(req, res, next) {
  try {
    const topico = req.body?.topico;
    if (!topico || !topico.titulo) {
      return res.status(400).json({ error: 'Envie um tópico válido' });
    }
    const tipo = pickTipo(req.body);
    const facebookPageId = await resolvePageId(req.session.userId, req.body);
    const gerado = await materiaIaService.gerarPreviewDeTopico(topico, {
      userId: req.session.userId,
      facebookPageId,
      tipoPublicacao: tipo,
      investigativa: Boolean(req.body.investigativa),
    });
    const matter = await materiaIaService.salvarMateria({
      userId: req.session.userId,
      facebookPageId,
      gerado,
      topico: gerado.topico || topico,
      tipoPublicacao: tipo,
      status: 'rascunho',
    });
    res.json({
      ok: true,
      matter,
      artigo: {
        titulo: gerado.titulo,
        materia: gerado.materia,
        hashtags: gerado.hashtags,
        imagemUrl: gerado.imagemUrl,
        imagemOrigem: gerado.imagemOrigem || null,
        termos_imagem: gerado.termos_imagem || [],
      },
      avisos: [...(gerado.avisos || []), gerado.avisoFoto].filter(Boolean),
      qualidade: {
        chars: gerado._chars,
        ok: gerado._qualidadeOk,
        estilo: gerado._estilo,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function criarManual(req, res, next) {
  try {
    const body = req.body || {};
    const facebookPageId = await resolvePageId(req.session.userId, body);
    const matter = await materiaIaService.criarMateriaManual({
      userId: req.session.userId,
      facebookPageId,
      titulo: body.titulo,
      materia: body.materia || body.texto,
      hashtags: body.hashtags,
      fonteCredito: body.fonteCredito || body.fonte_credito,
      tipoPublicacao: body.tipoPublicacao || body.tipo_publicacao || 'foto',
    });
    res.status(201).json({
      ok: true,
      matter,
      redirect: `/materias-ia/${matter.id}`,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function revisarTextoManual(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'Matéria já publicada. Gere uma nova para revisar.' });
    }

    const deepseekService = require('../services/deepseekService');
    deepseekService.assertDeepseek();

    let hashtags = [];
    try {
      hashtags = Array.isArray(matter.hashtags)
        ? matter.hashtags
        : JSON.parse(matter.hashtags || '[]');
    } catch {
      hashtags = [];
    }

    const revisado = await deepseekService.revisarMateriaManual({
      titulo: String(req.body?.titulo || matter.titulo || '').trim(),
      materia: String(req.body?.materia || matter.materia || '').trim(),
      hashtags,
    });

    await AiMatters.update(matterId, {
      titulo: revisado.titulo,
      materia: revisado.materia,
      hashtags: JSON.stringify(revisado.hashtags || []),
      status: matter.status === 'agendado' ? 'agendado' : 'rascunho',
      error_message: null,
    });

    res.json({
      ok: true,
      titulo: revisado.titulo,
      materia: revisado.materia,
      hashtags: revisado.hashtags || [],
      matter: await AiMatters.findById(matterId),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function gerarLote(req, res, next) {
  try {
    const body = req.body || {};
    const { topicos } = body;
    const facebook_page_id = await resolvePageId(req.session.userId, body);
    const tipo_publicacao = pickTipo(body);
    if (!Array.isArray(topicos) || !topicos.length) {
      return res.status(400).json({ error: 'Selecione ao menos um tópico' });
    }
    if (!facebook_page_id) {
      return res.status(400).json({ error: 'Selecione a página do Facebook' });
    }
    const result = await materiaIaService.gerarEPublicarLote({
      userId: req.session.userId,
      topicos,
      facebookPageId: facebook_page_id,
      tipoPublicacao: tipo_publicacao,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function publicar(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const body = req.body || {};
    const matter = await AiMatters.findById(matterId);
    const tipoBody = pickTipo(body);
    // Se a matéria já é reel, nunca deixa o body forçar texto
    const tipo =
      matter?.tipo_publicacao === 'reel' ? 'reel' : tipoBody === 'auto' ? matter?.tipo_publicacao : tipoBody;

    const result = await materiaIaService.publicarMateria(req.session.userId, matterId, {
      facebook_page_id: matter?.distribution_brand
        ? matter.facebook_page_id
        : await resolvePageId(req.session.userId, body),
      tipo_publicacao: tipo || matter?.tipo_publicacao || 'texto',
      titulo: body.titulo,
      materia: body.materia,
      imagem_url: body.imagem_url || body.imagemUrl,
      sync: Boolean(body.sync),
      forcar: Boolean(body.forcar || body.republicar),
      // Esta rota é sempre clique do editor: notícia repetida vira pergunta
      // (409 NOTICIA_REPETIDA), não rascunho; confirmarRepetida publica.
      manual: true,
      ignorarRepetida: body.confirmarRepetida === true,
      publicar_facebook:
        body.publicarFacebook ?? body.publicar_facebook ?? body.facebook ?? null,
      publicar_instagram:
        body.publicarInstagram ?? body.publicar_instagram ?? body.instagram ?? null,
      publicar_x: body.publicarX ?? body.publicar_x ?? body.x ?? null,
      texto_x: body.textoX ?? body.texto_x ?? null,
      imagem_x_url: body.imagemXUrl ?? body.imagem_x_url ?? null,
    });
    res.status(result.queued ? 202 : 200).json({
      ok: true,
      ...result,
      link: result.fbPostUrl || result.instagramPostUrl || result.xPostUrl || null,
    });
  } catch (err) {
    next(err);
  }
}

async function gerarTextoX(req, res, next) {
  try {
    const resultado = await materiaIaService.gerarTextoXDaMateria({
      userId: req.session.userId,
      matterId: Number(req.params.id),
      titulo: req.body?.titulo ?? null,
      materia: req.body?.materia ?? null,
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function listarMaterias(req, res, next) {
  try {
    const matters = await AiMatters.findByUser(req.session.userId, 40);
    res.json({ ok: true, matters });
  } catch (err) {
    next(err);
  }
}

async function obterMateria(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    res.json({ ok: true, matter });
  } catch (err) {
    next(err);
  }
}

/** Próximo horário sugerido (+30 min após o último agendamento). */
async function proximoSlotAgenda(req, res, next) {
  try {
    const info = await materiaIaService.obterUltimoAgendamento(req.session.userId);
    res.json({
      ok: true,
      ultimo: info.ultimo || null,
      proximoSlotLocal: info.proximoSlotLocal || null,
      proximoSlotLabel: info.proximoSlotLabel || null,
    });
  } catch (err) {
    next(err);
  }
}

async function removerMateria(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    try {
      const db = require('../config/db');
      await db('biblioteca_agenda')
        .where({ user_id: req.session.userId, matter_id: matterId })
        .whereNotIn('status', ['cancelado', 'publicado'])
        .update({
          status: 'pendente',
          matter_id: null,
          updated_at: db.fn.now(),
        });
      await db('ai_fila_jobs')
        .where({ matter_id: matterId, status: 'pendente' })
        .update({
          status: 'cancelado',
          erro: 'Matéria excluída — agenda voltou para pré-agendada',
        });
    } catch (syncErr) {
      console.warn('[materias-ia] remover sync agenda:', syncErr.message);
    }
    await AiMatters.deleteByUser(matterId, req.session.userId);
    res.json({ ok: true, id: matterId });
  } catch (err) {
    next(err);
  }
}

/** Exclusão em lote — só rascunhos do usuário (ids ou todos os rascunhos). */
async function removerMateriasLote(req, res, next) {
  try {
    const userId = req.session.userId;
    const body = req.body || {};
    const allDrafts = body.allDrafts === true || body.all === true;

    if (allDrafts) {
      const deleted = await AiMatters.deleteAllByUserStatus(userId, 'rascunho');
      return res.json({ ok: true, deleted: Number(deleted) || 0, allDrafts: true });
    }

    const ids = (Array.isArray(body.ids) ? body.ids : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!ids.length) {
      return res.status(400).json({ error: 'Nenhuma matéria selecionada' });
    }
    // Só apaga rascunhos — evita excluir publicadas por engano
    const deleted = await AiMatters.deleteManyByUser(ids, userId, { status: 'rascunho' });
    res.json({ ok: true, deleted: Number(deleted) || 0, requested: ids.length });
  } catch (err) {
    next(err);
  }
}

function parseHashtags(value) {
  if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
    } catch {
      /* texto livre */
    }
    return trimmed
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * "Ensinar IA" na tela da matéria: grava uma regra permanente a partir do que
 * o editor escreve olhando para a matéria aberta. Vale para as próximas.
 */
async function ensinarIa(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }

    const learning = require('../services/editorialLearningService');
    const salvo = await learning.ensinarComContexto({
      userId: req.session.userId,
      licao: req.body?.licao ?? req.body?.texto ?? '',
      titulo: matter.titulo,
      materia: matter.materia,
    });

    return res.json({ ok: true, ...salvo });
  } catch (err) {
    return next(err);
  }
}

/**
 * Mesmo "Ensinar IA", mas sem matéria salva: o chat manda o texto que está na
 * tela como contexto, então dá para ensinar antes mesmo de virar rascunho.
 */
async function ensinarIaLivre(req, res, next) {
  try {
    const learning = require('../services/editorialLearningService');
    const salvo = await learning.ensinarComContexto({
      userId: req.session.userId,
      licao: req.body?.licao ?? req.body?.texto ?? '',
      titulo: String(req.body?.titulo || '').slice(0, 300) || null,
      materia: String(req.body?.materia || '').slice(0, 4000) || null,
    });
    return res.json({ ok: true, ...salvo });
  } catch (err) {
    return next(err);
  }
}

/** Regras que a IA já aprendeu, para a tela mostrar antes de ensinar outra. */
async function listarEnsinamentos(req, res, next) {
  try {
    const learning = require('../services/editorialLearningService');
    const dados = await learning.obterOrientacoes(req.session.userId);
    return res.json({ ok: true, ...dados });
  } catch (err) {
    return next(err);
  }
}

async function atualizarMateria(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }

    const body = req.body || {};
    const patch = {};
    const {
      removerFechamentoOracao,
      removerSecaoTitulosAlternativos,
    } = require('../services/editorialGuidelinesFb');
    if (body.titulo != null) patch.titulo = String(body.titulo).trim().slice(0, 300);
    if (body.materia != null) {
      patch.materia = removerFechamentoOracao(removerSecaoTitulosAlternativos(body.materia));
    }
    if (body.fonteCredito != null || body.fonte_credito != null) {
      const raw = body.fonteCredito != null ? body.fonteCredito : body.fonte_credito;
      patch.fonte_credito = String(raw || '').trim().slice(0, 2000) || null;
    }
    if (body.hashtags != null) patch.hashtags = JSON.stringify(parseHashtags(body.hashtags));
    if (body.tipoPublicacao != null || body.tipo_publicacao != null) {
      const t = pickTipo(body);
      patch.tipo_publicacao =
        matter.tipo_publicacao === 'reel' ? 'reel' : t === 'auto' || t === 'reel' ? matter.tipo_publicacao : t;
    }
    if (body.facebookPageId != null || body.facebook_page_id != null) {
      patch.facebook_page_id = pickPageId(body);
    }
    if (body.publicarInstagram != null || body.publicar_instagram != null) {
      const raw = body.publicarInstagram != null ? body.publicarInstagram : body.publicar_instagram;
      patch.publicar_instagram = raw === true || raw === 1 || raw === '1' || raw === 'true';
    }
    if (body.publicarX != null || body.publicar_x != null) {
      const raw = body.publicarX != null ? body.publicarX : body.publicar_x;
      patch.publicar_x = raw === true || raw === 1 || raw === '1' || raw === 'true';
    }
    if (body.textoX != null || body.texto_x != null) {
      const raw = body.textoX != null ? body.textoX : body.texto_x;
      const { truncateForTwitter } = require('../services/ayrshareService');
      patch.texto_x = truncateForTwitter(String(raw || '').trim()) || null;
    }
    if (body.imagemXUrl != null || body.imagem_x_url != null) {
      const raw = body.imagemXUrl != null ? body.imagemXUrl : body.imagem_x_url;
      patch.imagem_x_url = String(raw || '').trim().slice(0, 2000) || null;
    }
    if (matter.status === 'publicado') {
      const camposPermitidos = new Set(['publicar_x', 'texto_x', 'imagem_x_url']);
      const somenteVersaoX =
        Object.keys(patch).length > 0 && Object.keys(patch).every((campo) => camposPermitidos.has(campo));
      if (!somenteVersaoX) {
        return res.status(400).json({ error: 'Matéria já publicada. Gere uma nova se precisar alterar.' });
      }
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Nada para atualizar' });
    }
    if (matter.status === 'agendado') {
      /* permite editar texto ainda agendado */
    } else if (['rascunho', 'pronto', 'erro'].includes(matter.status)) {
      patch.status = 'rascunho';
    }

    await AiMatters.update(matterId, patch);
    const updated = await AiMatters.findById(matterId);

    // Aprende com edições humanas vs snapshot da IA (silencioso)
    if (body.titulo != null || body.materia != null) {
      try {
        const { registrarAprendizado } = require('../services/editorialLearningService');
        const tituloAntes = matter.titulo_ia != null ? matter.titulo_ia : matter.titulo;
        const materiaAntes = matter.materia_ia != null ? matter.materia_ia : matter.materia;
        await registrarAprendizado({
          userId: req.session.userId,
          matterId,
          tituloAntes: body.titulo != null ? tituloAntes : null,
          tituloDepois: body.titulo != null ? updated.titulo : null,
          materiaAntes: body.materia != null ? materiaAntes : null,
          materiaDepois: body.materia != null ? updated.materia : null,
        });
      } catch (err) {
        console.warn('[editorial-learning] salvar:', err.message);
      }
    }

    const titleChanged =
      body.titulo != null && String(body.titulo).trim() !== String(matter.titulo || '').trim();
    const sourceUrl =
      updated.imagem_fonte_url ||
      (!updated.imagem_path && /^https?:\/\//i.test(String(updated.imagem_url || ''))
        ? updated.imagem_url
        : null);

    if (titleChanged && sourceUrl) {
      try {
        const artwork = await composeMatterArtwork({
          userId: req.session.userId,
          matterId: updated.id,
          sourceUrl,
          title: updated.titulo,
          force: true,
        });
        return res.json({ ok: true, matter: artwork.matter, imagemUrl: artwork.publicUrl });
      } catch (err) {
        return res.json({
          ok: true,
          matter: updated,
          aviso: `Texto salvo, mas a arte não foi regenerada: ${err.message}`,
        });
      }
    }

    return res.json({ ok: true, matter: updated });
  } catch (err) {
    return next(err);
  }
}

async function showMatter(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(404).render('404', { title: 'Não encontrado', path: req.path });
    }
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).render('404', { title: 'Não encontrado', path: req.path });
    }
    matter.fontes_links = extractMatterSourceLinks(matter);

    let hashtags = [];
    try {
      const raw = matter.hashtags;
      if (Array.isArray(raw)) hashtags = raw;
      else if (typeof raw === 'string' && raw.trim()) hashtags = JSON.parse(raw);
    } catch {
      hashtags = [];
    }

    const {
      anexarHashtagsAoFinal,
      removerFechamentoOracao,
      removerComentariosEditoriaisIa,
      fundirParagrafosIncompletos,
      extrairHashtagsDoTexto,
      normalizarCreditosImagemDuplicados,
    } = require('../services/editorialGuidelinesFb');
    if (Array.isArray(hashtags) && hashtags.length) {
      matter.materia = anexarHashtagsAoFinal(matter.materia || '', hashtags);
    }

    // Crédito só no Conteúdo: limpa campo Fonte/crédito se já estiver no corpo
    const patchShow = {};
    let materiaLimpa = removerComentariosEditoriaisIa(
      removerFechamentoOracao(matter.materia || '')
    );
    // Corrige lead truncado ("A apresentadora X, conhecida") deixado por limpeza antiga de créditos
    {
      const { body, tags } = extrairHashtagsDoTexto(materiaLimpa);
      const corpo = fundirParagrafosIncompletos(body);
      materiaLimpa = anexarHashtagsAoFinal(corpo, tags.length ? tags : hashtags);
    }
    materiaLimpa = normalizarCreditosImagemDuplicados(materiaLimpa) || materiaLimpa;
    if (materiaLimpa !== String(matter.materia || '').trim()) {
      matter.materia = materiaLimpa;
      if (['rascunho', 'pronto', 'erro', 'agendado'].includes(matter.status)) {
        patchShow.materia = materiaLimpa;
      }
    }
    const fonteCreditoLimpa = normalizarCreditosImagemDuplicados(matter.fonte_credito);
    if (fonteCreditoLimpa !== (String(matter.fonte_credito || '').trim() || null)) {
      matter.fonte_credito = fonteCreditoLimpa;
      if (['rascunho', 'pronto', 'erro', 'agendado'].includes(matter.status)) {
        patchShow.fonte_credito = fonteCreditoLimpa;
      }
    }
    if (Object.keys(patchShow).length) {
      try {
        await AiMatters.update(matter.id, patchShow);
      } catch {
        /* não bloqueia a tela */
      }
    }

    let ultimoAgendamento = null;
    let proximoSlotLocal = null;
    let proximoSlotLabel = null;
    let horarioAtualAgendado = null;
    let agendaBiblioteca = null;
    try {
      const agendaService = require('../services/bibliotecaAgendaService');
      agendaBiblioteca = await agendaService.obterAgendaDaMateria(req.session.userId, matter.id);
    } catch (err) {
      console.warn('[showMatter] agenda biblioteca:', err.message);
    }
    try {
      const jaAgendada = String(matter.status) === 'agendado' && matter.scheduled_at;
      if (jaAgendada) {
        horarioAtualAgendado = materiaIaService.formatarHorarioAgendamento(matter.scheduled_at);
      } else if (agendaBiblioteca?.horario) {
        // Pré-agendada na Biblioteca: mostra o horário no editor sem confirmar ainda
        horarioAtualAgendado = agendaBiblioteca.horario;
      }
      const info = await materiaIaService.obterUltimoAgendamento(req.session.userId);
      ultimoAgendamento = info.ultimo || null;
      proximoSlotLocal = info.proximoSlotLocal || null;
      proximoSlotLabel = info.proximoSlotLabel || null;
    } catch (err) {
      console.warn('[showMatter] ultimo agendamento:', err.message);
    }

    let marcaModeloArte = null;
    let artModelChoices = [];
    let brandPreviewVersion = Date.now();
    try {
      const Users = require('../models/Users');
      const storedBrandUser = await Users.findById(req.session.userId);
      const user = require('../services/pageDistributionEditorial').effectiveBrand(storedBrandUser, matter);
      const {
        normalizeArtModel,
        getUserArtModelChoices,
        resolveArtModelForMatter,
      } = require('../services/editorialCardModels');
      marcaModeloArte = normalizeArtModel(user?.marca_modelo_arte);
      const picked = getUserArtModelChoices(user);
      artModelChoices = picked.choices;
      brandPreviewVersion = [
        user?.updated_at || '',
        user?.marca_modelo_arte || '',
        user?.marca_modelo_arte_secundario || '',
        user?.marca_cor_primaria || '',
        user?.logo_path || '',
      ].join('|');

      // Matérias antigas sem [[ ]] / (( )): aplica markup e regenera a imagem destacada
      const activeModel = resolveArtModelForMatter(user, matter.arte_modelo);
      if (
        activeModel === 'urgente_alerta' &&
        ['rascunho', 'pronto', 'erro', 'agendado'].includes(String(matter.status || ''))
      ) {
        const {
          ensureTituloUrgenteAlerta,
          tituloTemMarkupAlerta,
        } = require('../services/editorialCardService');
        const cur = String(matter.titulo || '').trim();
        if (cur && !tituloTemMarkupAlerta(cur)) {
          const marked = ensureTituloUrgenteAlerta(cur);
          if (marked && marked !== cur) {
            await AiMatters.update(matter.id, { titulo: marked, titulo_ia: marked });
            matter.titulo = marked;
            const sourceUrl =
              matter.imagem_fonte_url ||
              (!matter.imagem_path && /^https?:\/\//i.test(String(matter.imagem_url || ''))
                ? matter.imagem_url
                : null);
            if (sourceUrl) {
              try {
                const artwork = await composeMatterArtwork({
                  userId: req.session.userId,
                  matterId: matter.id,
                  sourceUrl,
                  title: marked,
                  force: true,
                  model: activeModel,
                });
                Object.assign(matter, artwork.matter || {});
              } catch (artErr) {
                console.warn('[showMatter] arte urgente:', artErr.message);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[showMatter] marca modelo:', err.message);
    }

    const arteModeloAtivo = String(matter.arte_modelo || marcaModeloArte || '').trim();
    const titulosAlternativos = require('../services/materiaIaService').parseTitulosAlternativos(
      matter.titulos_alternativos
    );

    // Redes adicionais só aparecem quando foram ativadas na Página de destino em /paginas.
    let instagramPagina = { ativo: false, username: null, pageName: null };
    let xPagina = { ativo: false, username: null, pageName: null };
    try {
      const { resolvePageForUser, defaultPageForUser } = require('../services/facebookPageResolver');
      const pageDestino = matter.facebook_page_id
        ? await resolvePageForUser(req.session.userId, matter.facebook_page_id)
        : await defaultPageForUser(req.session.userId);
      if (pageDestino) {
        instagramPagina = {
          ativo: Boolean(pageDestino.instagram_ativo),
          username: pageDestino.instagram_username || null,
          pageName: pageDestino.page_name || null,
        };
        xPagina = {
          ativo: Boolean(pageDestino.x_ativo),
          username: pageDestino.x_username || null,
          pageName: pageDestino.page_name || null,
        };
      }
    } catch (err) {
      console.warn('[showMatter] redes da página:', err.message);
    }

    return res.render('materia-ia-editar', {
      title: matter.titulo || 'Matéria IA',
      matter,
      titulosAlternativos,
      instagramPagina,
      xPagina,
      hashtags: Array.isArray(hashtags) ? hashtags : [],
      ultimoAgendamento,
      proximoSlotLocal,
      proximoSlotLabel,
      horarioAtualAgendado,
      agendaBiblioteca,
      marcaModeloArte,
      artModelChoices,
      arteModeloAtivo,
      brandPreviewVersion,
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    return next(err);
  }
}

async function listPage(req, res, next) {
  try {
    return res.render('materias-ia', {
      title: 'Criar conteúdo',
      miaStandalone: true,
    });
  } catch (err) {
    return next(err);
  }
}

async function showLotePage(req, res, next) {
  try {
    return res.render('conteudo-lote', {
      title: 'Gerando matérias',
      currentPath: '/materias-ia',
    });
  } catch (err) {
    return next(err);
  }
}

async function listMinhasMaterias(req, res, next) {
  try {
    const q = String(req.query.q || req.query.busca || '').trim();
    const allowed = new Set(['all', 'rascunho', 'pronto', 'agendado', 'publicado', 'erro', 'viralizou']);
    const rawStatus = String(req.query.status || 'all').trim().toLowerCase();
    const statusFilter = allowed.has(rawStatus) ? rawStatus : 'all';
    const allowedViralLevels = new Set(['all', 'alto', 'medio']);
    const rawViralLevel = String(req.query.nivel || 'all').trim().toLowerCase();
    const viralLevel = allowedViralLevels.has(rawViralLevel) ? rawViralLevel : 'all';
    const allowedViralOrders = new Set([
      'viral',
      'curtidas',
      'comentarios',
      'compartilhamentos',
      'visualizacoes',
      'recente',
    ]);
    const rawViralOrder = String(req.query.ordem || 'viral').trim().toLowerCase();
    const viralOrder = allowedViralOrders.has(rawViralOrder) ? rawViralOrder : 'viral';
    const perPage = 10;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);

    // Aba Viralizou: sincroniza engajamento das publicadas recentes ANTES de filtrar
    // (senão posts que viralizaram no FB mas ainda sem dado no banco não aparecem)
    let engajamentoSync = null;
    if (statusFilter === 'viralizou') {
      try {
        engajamentoSync = await materiaIaService.sincronizarEngajamentoRecentes(req.session.userId, {
          limit: 35,
          concurrency: 3,
        });
      } catch (err) {
        console.warn('[minhas-materias] sync engajamento:', err.message);
      }
    }

    if (statusFilter === 'agendado') {
      try {
        const agendaService = require('../services/bibliotecaAgendaService');
        await agendaService.cancelarAgendamentosPendentesDaBiblioteca(req.session.userId);
        await materiaIaService.repararAgendamentosSobrepostos(req.session.userId, {
          intervaloMinutos: 30,
        });
      } catch (err) {
        console.warn('[minhas-materias] reparar agendados:', err.message);
      }
    }

    const [statusCounts, total] = await Promise.all([
      AiMatters.countByStatusForUser(req.session.userId, { q }),
      AiMatters.countByUserWithPub(req.session.userId, {
        q,
        status: statusFilter === 'all' ? null : statusFilter,
        viralLevel,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * perPage;

    const matters = await AiMatters.findByUserWithPub(req.session.userId, {
      limit: perPage,
      offset,
      q,
      status: statusFilter === 'all' ? null : statusFilter,
      viralLevel,
      viralOrder,
    });

    return res.render('minhas-materias', {
      title: 'Minhas matérias',
      matters,
      searchQuery: q,
      statusFilter,
      viralLevel,
      viralOrder,
      statusCounts,
      engajamentoSync,
      pagination: {
        page: safePage,
        perPage,
        total,
        totalPages,
      },
    });
  } catch (err) {
    return next(err);
  }
}

async function gerarManual(req, res, next) {
  try {
    const body = req.body || {};
    const informacoes = body.informacoes || body.info || body.texto || body.fatos;
    const facebookPageId = await resolvePageId(req.session.userId, body);
    const pesquisarRaw = body.pesquisarWeb ?? body.pesquisar_web;
    const result = await materiaIaService.gerarMateriaManual({
      userId: req.session.userId,
      informacoes,
      angulo: body.angulo || body.tema || null,
      tom: body.tom || body.tone || 'natural',
      facebookPageId,
      imagemBuffer: req.file?.buffer || null,
      imagemUrl: body.imagemUrl || body.imagem_url || null,
      creditoImagem: body.creditoImagem || body.credito_imagem || null,
      pesquisarWeb: ['1', 'true', 'on', 'sim'].includes(String(pesquisarRaw ?? '').toLowerCase()),
      palavrasChave: body.palavrasChave || body.palavras_chave || null,
      periodo: body.periodo || '30d',
    });
    res.status(201).json({
      ok: true,
      ...result,
      redirect: result.matter?.id ? `/materias-ia/${result.matter.id}` : '/minhas-materias',
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function gerarVariacao(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    const body = req.body || {};
    const result = await materiaIaService.gerarVariacaoDeMateria({
      userId: req.session.userId,
      matterId,
      facebookPageId: await resolvePageId(req.session.userId, body),
      tipoPublicacao: body.tipoPublicacao || body.tipo_publicacao || null,
    });
    res.status(201).json({
      ok: true,
      ...result,
      redirect: result.matter?.id ? `/materias-ia/${result.matter.id}` : '/minhas-materias',
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Reel narrado: imagem da matéria + voz ElevenLabs → MP4 9:16 */
async function gerarReel(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    const { gerarReelNarrado } = require('../services/matterReelService');
    const result = await gerarReelNarrado({
      userId: req.session.userId,
      matterId,
    });
    res.json({
      ok: true,
      ...result,
      redirect: result.matter?.id ? `/materias-ia/${result.matter.id}` : '/minhas-materias',
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function atualizarViews(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    const force = req.query.force === '1' || req.body?.force === true;
    const result = await materiaIaService.atualizarViewsDaMateria(req.session.userId, matterId, {
      force,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    // Nunca devolver 502 ao browser — engajamento é best-effort
    console.warn('[atualizarViews]', err.message);
    res.json({
      ok: false,
      likes: null,
      comments: null,
      views: null,
      message: err.message || 'Não foi possível ler o engajamento agora',
    });
  }
}

/** Diagnóstico: por que o engajamento não aparece nesta matéria. */
async function engajamentoDebug(req, res) {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    const result = await materiaIaService.diagnosticarEngajamento(
      req.session.userId,
      matterId
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}

/** Sincroniza engajamento das publicadas recentes (lote). */
async function sincronizarEngajamento(req, res, next) {
  try {
    const limit = Math.min(20, Math.max(5, Number(req.body?.limit || req.query?.limit) || 12));
    const result = await materiaIaService.sincronizarEngajamentoRecentes(req.session.userId, {
      limit,
      concurrency: 2,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.warn('[sincronizarEngajamento]', err.message);
    res.json({
      ok: false,
      checked: 0,
      updated: 0,
      message: err.message || 'Sync de engajamento falhou',
    });
  }
}

async function agendar(req, res, next) {
  try {
    const matterId = Number(req.params.id || req.body.matter_id);
    const body = req.body || {};

    if (body.titulo != null || body.materia != null) {
      const matter = await AiMatters.findById(matterId);
      if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
        return res.status(404).json({ error: 'Matéria não encontrada' });
      }
      const patch = {};
      if (body.titulo != null) patch.titulo = String(body.titulo).trim().slice(0, 300);
      if (body.materia != null) patch.materia = String(body.materia);
      if (Object.keys(patch).length) await AiMatters.update(matterId, patch);
    }

    const result = await materiaIaService.agendarMateria({
      userId: req.session.userId,
      matterId,
      runAt: body.run_at || body.runAt,
    });
    try {
      const agendaService = require('../services/bibliotecaAgendaService');
      await agendaService.sincronizarAgendamentoDaMateria(
        req.session.userId,
        matterId,
        result.runAt
      );
    } catch (syncErr) {
      console.warn('[materias-ia] sync agenda biblioteca:', syncErr.message);
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

/** Lista resumida das matérias agendadas (hora, título e página), em ordem de saída. */
async function agendadasResumo(req, res, next) {
  try {
    const db = require('../config/db');
    const agendadas = await db('ai_matters as m')
      .leftJoin('facebook_pages as fp', 'fp.id', 'm.facebook_page_id')
      .where('m.user_id', req.session.userId)
      .where('m.status', 'agendado')
      .orderBy('m.scheduled_at', 'asc')
      .orderBy('m.id', 'asc')
      .limit(200)
      .select('m.id', 'm.titulo', 'm.scheduled_at', 'fp.page_name');
    res.json({ ok: true, agendadas });
  } catch (err) {
    next(err);
  }
}

/** Agenda ou publica várias matérias selecionadas de uma vez. */
async function lote(req, res, next) {
  try {
    const body = req.body || {};
    const result = await materiaIaService.filaEmLote({
      userId: req.session.userId,
      ids: body.ids,
      acao: body.acao,
      facebookPageId: body.facebook_page_id || null,
      inicio: body.inicio || null,
      intervaloMinutos: body.intervalo_minutos,
    });
    if (result.acao === 'agendar') {
      const agendaService = require('../services/bibliotecaAgendaService');
      for (const r of result.resultados.filter((x) => x.ok)) {
        await agendaService
          .sincronizarAgendamentoDaMateria(req.session.userId, r.id, r.quando)
          .catch((err) => console.warn('[materias-ia] sync agenda (lote):', err.message));
      }
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

/** Lote: gera (sem salvar) o título novo das matérias selecionadas. */
async function sugerirTitulosLote(req, res, next) {
  try {
    const body = req.body || {};
    const itens = await require('../services/titulosLoteService').sugerir({
      userId: req.session.userId,
      ids: body.ids,
      modo: body.modo,
      tom: String(body.tom || 'natural').trim().toLowerCase(),
      titulos: body.titulos,
    });
    res.json({ ok: true, itens });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
}

/** Lote: grava os títulos revisados e refaz a arte de cada matéria. */
async function aplicarTitulosLote(req, res, next) {
  try {
    const body = req.body || {};
    const result = await require('../services/titulosLoteService').aplicar({
      userId: req.session.userId,
      itens: body.itens,
      origem: body.origem,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
}

/** Tira a matéria da agenda (volta a rascunho e cancela a publicação marcada). */
async function desagendar(req, res, next) {
  try {
    const result = await materiaIaService.desagendarMateria({
      userId: req.session.userId,
      matterId: Number(req.params.id),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function monitorCriar(req, res, next) {
  try {
    const body = req.body || {};
    const monitor = await materiaIaService.criarMonitor({
      userId: req.session.userId,
      facebookPageId: await resolvePageId(req.session.userId, body),
      palavrasChave: body.palavrasChave || body.palavras_chave,
      intervaloMinutos: body.intervaloMinutos || body.intervalo_minutos,
      postsPorCiclo: body.postsPorCiclo || body.posts_por_ciclo,
      tipoPublicacao: pickTipo(body),
      inicioEm: body.inicioEm || body.inicio_em,
      fimEm: body.fimEm || body.fim_em,
    });
    res.status(201).json({ ok: true, monitor });
  } catch (err) {
    next(err);
  }
}

async function monitorLista(req, res, next) {
  try {
    const monitores = await AiMonitors.findByUser(req.session.userId);
    res.json({ ok: true, monitores });
  } catch (err) {
    next(err);
  }
}

async function monitorPausar(req, res, next) {
  try {
    const id = Number(req.params.id);
    const monitor = await AiMonitors.findById(id);
    if (!monitor || monitor.user_id !== req.session.userId) {
      return res.status(404).json({ error: 'Monitor não encontrado' });
    }
    await AiMonitors.update(id, { ativo: false });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function monitorRetomar(req, res, next) {
  try {
    const id = Number(req.params.id);
    const monitor = await AiMonitors.findById(id);
    if (!monitor || monitor.user_id !== req.session.userId) {
      return res.status(404).json({ error: 'Monitor não encontrado' });
    }
    await AiMonitors.update(id, {
      ativo: true,
      proxima_execucao: new Date(),
      ultimo_erro: null,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * Lista (ou gera de novo) os 3 títulos alternativos ao principal.
 * Não troca o título: o editor escolhe qual aplicar.
 */
async function titulosAlternativos(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }

    const materiaIaService = require('../services/materiaIaService');
    const guardados = materiaIaService.parseTitulosAlternativos(matter.titulos_alternativos);
    const gerarNovos = req.method === 'POST' || req.query.novos === '1';
    if (!gerarNovos && guardados.length) {
      return res.json({ ok: true, titulos: guardados });
    }

    const tituloAtual = String(req.body?.tituloAtual || matter.titulo || '').trim();
    const materia = String(req.body?.materia || matter.materia || '').trim();
    const orientacaoEditor = String(req.body?.orientacao || req.body?.pedido || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    const titulos = await materiaIaService.gerarESalvarTitulosAlternativos({
      matterId,
      userId: req.session.userId,
      titulo: tituloAtual,
      materia,
      fonteTitulo: matter.fonte_titulo || null,
      // Não repete o que o editor já viu nesta matéria.
      evitar: guardados,
      orientacaoEditor,
    });
    if (!titulos.length) {
      return res
        .status(502)
        .json({ error: 'A IA não devolveu títulos alternativos agora. Tente de novo.' });
    }
    return res.json({ ok: true, titulos });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Sugere outro título via IA (tom opcional) e regenera a arte Minha marca. */
async function sugerirTitulo(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'Matéria já publicada. Gere uma nova se precisar alterar o título.' });
    }

    const deepseekService = require('../services/deepseekService');
    deepseekService.assertDeepseek('conversa');

    const tom = String(req.body?.tom || 'natural').trim().toLowerCase();
    const evitar = Array.isArray(req.body?.evitar) ? req.body.evitar : [];
    const tituloNaTela = String(req.body?.tituloAtual || '').trim();
    const tituloAtual = tituloNaTela || String(matter.titulo || '').trim();
    const materiaNaTela = String(req.body?.materia || '').trim();
    const rascunhoManual = String(req.body?.rascunhoManual || req.body?.rascunho || '').trim();

    const Users = require('../models/Users');
    const user = await Users.findById(req.session.userId);
    const sugerido = await deepseekService.sugerirTituloMateria({
      tituloAtual,
      materia: materiaNaTela || matter.materia,
      fonteTitulo: matter.fonte_titulo,
      tom,
      evitar: [...evitar, matter.titulo, tituloAtual].filter(Boolean),
      marcaModeloArte: user?.marca_modelo_arte || null,
      rascunhoManual,
      tarefa: 'conversa',
    });

    const { aplicarTitulo } = require('../services/titulosLoteService');
    const { matter: updated, imagemUrl, videoUrl, aviso } = await aplicarTitulo({
      userId: req.session.userId,
      matter,
      titulo: sugerido.titulo,
      tituloIa: true,
    });

    return res.json({
      ok: true,
      titulo: sugerido.titulo,
      tom: sugerido.tom,
      matter: updated,
      imagemUrl,
      videoUrl,
      aviso,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Rebusca a capa na URL da fonte e aplica Minha marca. */
async function buscarImagemFonte(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'Matéria já publicada. A imagem não pode ser alterada.' });
    }

    const fonteUrl = String(req.body?.url || matter.fonte_url || '').trim();
    if (!/^https?:\/\//i.test(fonteUrl)) {
      return res.status(400).json({
        error: 'Esta matéria não tem URL de fonte. Cole o link da notícia ou envie uma imagem manualmente.',
      });
    }

    const { extrairMetadadosArtigo } = require('../services/articleSource');
    const meta = await extrairMetadadosArtigo(fonteUrl);
    if (!meta?.imagem) {
      return res.status(422).json({
        error:
          'Não encontramos foto de capa nessa página. Escolha uma imagem manualmente ou tente outro link da notícia.',
      });
    }

    const patch = {
      imagem_url: meta.imagem,
      error_message: null,
    };
    if (meta.titulo && (!matter.fonte_titulo || /^not[ií]cia\s*[—\-]/i.test(matter.fonte_titulo))) {
      patch.fonte_titulo = meta.titulo;
    }
    if (meta.url && meta.url !== matter.fonte_url) {
      patch.fonte_url = meta.url;
    }
    if (matter.status !== 'agendado') patch.status = 'rascunho';
    await AiMatters.update(matterId, patch);

    let updated = await AiMatters.findById(matterId);
    let imagemUrl = meta.imagem;
    let aviso = null;

    try {
      const artwork = await composeMatterArtwork({
        userId: req.session.userId,
        matterId: updated.id,
        sourceUrl: meta.imagem,
        title: updated.titulo,
        force: true,
      });
      updated = artwork.matter;
      imagemUrl = artwork.publicUrl;
    } catch (err) {
      aviso = `Imagem da fonte encontrada, mas a arte Minha marca falhou: ${err.message}`;
    }

    return res.json({
      ok: true,
      matter: updated,
      imagemUrl,
      imagemFonte: meta.imagem,
      aviso,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** IA analisa a matéria e sugere fotos reais (Google Images via Serper).
 *  Com body.q / consulta: busca direta pela palavra digitada (sem IA).
 */
async function sugerirImagens(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }

    const {
      sugerirImagensParaMateria,
      buscarImagensPorPalavra,
    } = require('../services/imageSuggestService');
    // O editor usa uma grade grande: 24 opções evitam que a escolha dependa
    // das primeiras fotos devolvidas por um único buscador.
    const limite = Math.min(Number(req.body?.limite) || 24, 30);
    const consultaManual = String(
      req.body?.q ?? req.body?.consulta ?? req.body?.busca ?? req.body?.query ?? ''
    ).trim();

    if (consultaManual) {
      const result = await buscarImagensPorPalavra(consultaManual, { limite });
      return res.json({ ok: true, ...result });
    }

    const imagemAtual =
      matter.imagem_fonte_url ||
      (!matter.imagem_path && /^https?:\/\//i.test(String(matter.imagem_url || ''))
        ? matter.imagem_url
        : null);

    const result = await sugerirImagensParaMateria({
      titulo: matter.titulo,
      materia: matter.materia,
      fonteTitulo: matter.fonte_titulo,
      imagemAtual,
      limite,
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Aplica URL de imagem sugerida e gera arte Minha marca. */
async function aplicarImagemUrl(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'Matéria já publicada. A imagem não pode ser alterada.' });
    }

    const imageUrl = String(req.body?.imageUrl || req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(imageUrl) && !String(imageUrl).startsWith('/media/')) {
      return res.status(400).json({ error: 'Informe a URL da imagem sugerida' });
    }

    const title = String(req.body?.titulo || matter.titulo || '').trim();
    const artwork = await composeMatterArtwork({
      userId: req.session.userId,
      matterId,
      sourceUrl: imageUrl,
      title,
      force: true,
    });

    // Crédito da imagem: autor dos metadados internos, senão Reprodução/Internet
    const deepseekService = require('../services/deepseekService');
    const {
      atualizarFonteCreditoDaImagem,
      CREDITO_IMAGEM_FALLBACK,
    } = require('../services/editorialGuidelinesFb');
    let imagemAutor = CREDITO_IMAGEM_FALLBACK;
    // Imagem do banco do editor: o crédito já é conhecido (ex.: gerada por IA).
    const creditoDoBanco = require('../services/bancoImagensService').ehUrlDoBanco(imageUrl, req.session.userId)
      ? String(req.body?.creditoFixo || '').trim().slice(0, 80)
      : '';
    if (creditoDoBanco) {
      imagemAutor = creditoDoBanco;
    } else {
      try {
        const identificado = await deepseekService.identificarAutorImagem({
          autor: req.body?.autor || null,
          fonte: req.body?.fonte || null,
          titulo: req.body?.imagemTitulo || req.body?.title || null,
          origem: req.body?.origem || null,
        });
        imagemAutor = identificado || CREDITO_IMAGEM_FALLBACK;
      } catch {
        imagemAutor = CREDITO_IMAGEM_FALLBACK;
      }
    }

    // Trocar a imagem destacada não altera o texto da matéria: só o campo
    // estruturado de crédito. Reescrever a linha "Foto:" do corpo mudava o
    // conteúdo que o editor já revisou.
    const fonteCreditoAtual = artwork.matter?.fonte_credito ?? matter.fonte_credito;
    const fonteCreditoComImagem = atualizarFonteCreditoDaImagem(
      fonteCreditoAtual,
      imagemAutor
    );
    if (fonteCreditoComImagem !== fonteCreditoAtual) {
      await AiMatters.update(matterId, {
        fonte_credito: fonteCreditoComImagem,
      });
      artwork.matter = await AiMatters.findById(matterId);
    }

    return res.json({
      ok: true,
      matter: artwork.matter,
      imagemUrl: artwork.publicUrl,
      imagemFonteUrl: artwork.matter?.imagem_fonte_url || imageUrl,
      hasLogo: artwork.hasLogo,
      imagemAutor,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * Monta imagem destacada com DUAS fotos (lado a lado ou cima/baixo) + Minha marca.
 */
async function aplicarColagemDuasImagens(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'Matéria já publicada. A imagem não pode ser alterada.' });
    }

    const imageUrlA = String(req.body?.imageUrlA || req.body?.urlA || '').trim();
    const imageUrlB = String(req.body?.imageUrlB || req.body?.urlB || '').trim();
    const thumbnailA = String(req.body?.thumbnailA || req.body?.thumbA || '').trim() || null;
    const thumbnailB = String(req.body?.thumbnailB || req.body?.thumbB || '').trim() || null;
    const layout = String(req.body?.layout || 'lado').toLowerCase() === 'cima' ? 'cima' : 'lado';
    const fit = String(req.body?.fit || req.body?.enquadramento || 'preservar').toLowerCase() === 'preencher'
      ? 'preencher'
      : 'preservar';
    const zoomRaw = Number(req.body?.zoom);
    const offsetXRaw = Number(req.body?.offsetX ?? req.body?.offset_x);
    const offsetYRaw = Number(req.body?.offsetY ?? req.body?.offset_y);
    const zoom = Number.isFinite(zoomRaw) ? zoomRaw : (fit === 'preservar' ? 92 : 108);
    const offsetX = Number.isFinite(offsetXRaw) ? offsetXRaw : 50;
    const offsetY = Number.isFinite(offsetYRaw) ? offsetYRaw : 50;

    const okUrl = (u) => /^https?:\/\//i.test(u) || String(u).startsWith('/media/');
    if (!okUrl(imageUrlA) || !okUrl(imageUrlB)) {
      return res.status(400).json({ error: 'Informe as duas URLs das imagens' });
    }

    const { composeDualCollageArtwork } = require('../services/matterArtworkService');
    const title = String(req.body?.titulo || matter.titulo || '').trim();
    const artwork = await composeDualCollageArtwork({
      userId: req.session.userId,
      matterId,
      imageUrlA,
      imageUrlB,
      thumbnailA,
      thumbnailB,
      layout,
      fit,
      title,
      zoom,
      offsetX,
      offsetY,
    });

    return res.json({
      ok: true,
      matter: artwork.matter,
      imagemUrl: artwork.publicUrl,
      imagemFonteUrl: artwork.matter?.imagem_fonte_url || null,
      hasLogo: artwork.hasLogo,
      layout,
      fit,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * Reescreve a matéria incorporando informações avulsas digitadas pelo usuário.
 */
async function reescreverComInfo(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({
        error: 'Matéria já publicada. Gere uma nova se precisar reescrever o texto.',
      });
    }

    const infoExtra = String(req.body?.infoExtra || req.body?.info || req.body?.texto || '').trim();
    if (!infoExtra) {
      return res.status(400).json({ error: 'Cole as informações extras no campo antes de reescrever.' });
    }

    const deepseekService = require('../services/deepseekService');
    deepseekService.assertDeepseek();

    let hashtags = [];
    try {
      hashtags = Array.isArray(matter.hashtags)
        ? matter.hashtags
        : JSON.parse(matter.hashtags || '[]');
    } catch {
      hashtags = [];
    }

    const materiaAtual = String(req.body?.materia || matter.materia || '').trim();
    const tituloAtual = String(req.body?.titulo || matter.titulo || '').trim();

    const reescrito = await deepseekService.reescreverMateriaComInfo({
      titulo: tituloAtual,
      materia: materiaAtual,
      infoExtra,
      hashtags,
      fonteTitulo: matter.fonte_titulo,
    });

    const patch = {
      titulo: reescrito.titulo,
      materia: reescrito.materia,
      titulo_ia: reescrito.titulo,
      materia_ia: reescrito.materia,
      hashtags: JSON.stringify(reescrito.hashtags || []),
      error_message: null,
    };
    if (matter.status !== 'agendado') patch.status = 'rascunho';
    await AiMatters.update(matterId, patch);

    let updated = await AiMatters.findById(matterId);
    let imagemUrl = updated.imagem_url || null;
    let videoUrl = null;
    let aviso = 'Texto reescrito com as informações incluídas ✓';

    // Atualiza arte/capa se o título mudou
    const titleChanged =
      String(reescrito.titulo || '').trim() !== String(matter.titulo || '').trim();

    if (titleChanged && updated.tipo_publicacao === 'reel' && updated.video_clip_id) {
      try {
        const { applyCoverToClipNow } = require('../services/clipPostProcessService');
        await applyCoverToClipNow({
          clipId: updated.video_clip_id,
          userId: req.session.userId,
          titulo: reescrito.titulo,
          force: true,
        });
        updated = await AiMatters.findById(matterId);
        if (updated.video_path) {
          videoUrl = `/media/${String(updated.video_path).replace(/\\/g, '/')}`;
        }
        aviso = 'Texto reescrito e capa do Reel atualizada ✓';
      } catch (err) {
        aviso = `Texto reescrito, mas a capa do Reel não foi regenerada: ${err.message}`;
      }
    } else if (titleChanged) {
      const sourceUrl =
        updated.imagem_fonte_url ||
        (!updated.imagem_path && /^https?:\/\//i.test(String(updated.imagem_url || ''))
          ? updated.imagem_url
          : null);
      if (sourceUrl) {
        try {
          const artwork = await composeMatterArtwork({
            userId: req.session.userId,
            matterId: updated.id,
            sourceUrl,
            title: reescrito.titulo,
            force: true,
          });
          updated = artwork.matter;
          imagemUrl = artwork.publicUrl;
          aviso = 'Texto reescrito e arte atualizada ✓';
        } catch (err) {
          aviso = `Texto reescrito, mas a arte não foi regenerada: ${err.message}`;
        }
      }
    }

    return res.json({
      ok: true,
      titulo: reescrito.titulo,
      materia: reescrito.materia,
      hashtags: reescrito.hashtags,
      matter: updated,
      imagemUrl,
      videoUrl,
      aviso,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * Busca fontes relacionadas (Brave) e enriquecem a matéria com fatos — sem plágio.
 */
async function enriquecerFontes(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const result = await materiaIaService.enriquecerMateriaComWeb({
      userId: req.session.userId,
      matterId,
      tituloAtual: req.body?.titulo,
      materiaAtual: req.body?.materia,
      palavrasChave: req.body?.palavrasChave || req.body?.palavras_chave || req.body?.q,
      periodo: req.body?.periodo || '180d',
    });
    return res.json({
      ok: true,
      titulo: result.titulo,
      materia: result.materia,
      hashtags: result.hashtags,
      fatosUsados: result.fatosUsados,
      fontes: result.fontes,
      queryUsada: result.queryUsada,
      matter: result.matter,
      imagemUrl: result.imagemUrl,
      videoUrl: result.videoUrl,
      aviso: result.aviso,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function linksLista(req, res, next) {
  try {
    const conteudoLinksService = require('../services/conteudoLinksService');
    const links = await conteudoLinksService.listar(req.session.userId);
    res.json({ ok: true, links });
  } catch (err) {
    next(err);
  }
}

async function linksSalvar(req, res, next) {
  try {
    const body = req.body || {};
    const conteudoLinksService = require('../services/conteudoLinksService');
    const link = await conteudoLinksService.salvar(req.session.userId, {
      url: body.url,
      nome: body.nome,
      notas: body.notas,
      tipo: body.tipo,
    });
    res.status(201).json({ ok: true, link });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function linksRemover(req, res, next) {
  try {
    const conteudoLinksService = require('../services/conteudoLinksService');
    await conteudoLinksService.remover(req.session.userId, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

module.exports = {
  pesquisar,
  emAlta,
  radarFace,
  gerar,
  reescreverLink,
  gerarPreview,
  criarManual,
  gerarLote,
  publicar,
  gerarTextoX,
  listarMaterias,
  obterMateria,
  proximoSlotAgenda,
  desagendar,
  lote,
  agendadasResumo,
  sugerirTitulosLote,
  aplicarTitulosLote,
  removerMateria,
  removerMateriasLote,
  atualizarMateria,
  ensinarIa,
  ensinarIaLivre,
  listarEnsinamentos,
  sugerirTitulo,
  titulosAlternativos,
  revisarTextoManual,
  reescreverComInfo,
  enriquecerFontes,
  buscarImagemFonte,
  sugerirImagens,
  aplicarImagemUrl,
  aplicarColagemDuasImagens,
  showMatter,
  listPage,
  showLotePage,
  listMinhasMaterias,
  gerarManual,
  gerarVariacao,
  gerarReel,
  atualizarViews,
  engajamentoDebug,
  sincronizarEngajamento,
  agendar,
  monitorCriar,
  monitorLista,
  monitorPausar,
  monitorRetomar,
  linksLista,
  linksSalvar,
  linksRemover,
};
