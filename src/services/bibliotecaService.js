const crypto = require('crypto');
const BibliotecaFontes = require('../models/BibliotecaFontes');
const BibliotecaPosts = require('../models/BibliotecaPosts');
const BibliotecaAlertas = require('../models/BibliotecaAlertas');
const BibliotecaAutopilot = require('../models/BibliotecaAutopilot');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const Videos = require('../models/Videos');
const importService = require('./importService');
const materiaIaService = require('./materiaIaService');
const {
  resumirAlertaBiblioteca,
  ranquearPostsViralFacebook,
  assertDeepseek,
} = require('./deepseekService');
const { env } = require('../config/env');
const axios = require('axios');
const { titulosParecidos, mesmoAssuntoNoticia } = require('./editorialGuidelinesFb');

const geracaoTextoLocks = new Map();

/** external_id é VARCHAR(191); URLs do Google News passam disso → hash estável. */
function stableExternalId(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.length <= 180) return s;
  return `h:${crypto.createHash('sha256').update(s).digest('hex')}`;
}

function normalizarUrlBiblioteca(url) {
  try {
    const u = new URL(String(url || '').trim());
    u.hash = '';
    // Remove tracking / variantes que geram o mesmo artigo duas vezes
    [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'utm_id',
      'fbclid',
      'gclid',
      'mc_cid',
      'mc_eid',
      'ref',
      's',
      'oc',
      'hl',
      'gl',
      'ceid',
    ].forEach((k) => u.searchParams.delete(k));
    // Google News redirect: mantém só o path estável quando possível
    let href = u.href.replace(/\/$/, '').toLowerCase();
    href = href.replace(/^https?:\/\/(www\.)?/, 'https://');
    return href;
  } catch {
    return String(url || '')
      .split(/[?#]/)[0]
      .replace(/\/$/, '')
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, 'https://');
  }
}

/** Heurística simples: texto parece inglês/outro idioma (não PT). */
function pareceTextoEstrangeiro(texto) {
  const t = String(texto || '')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 18) return false;

  const temAcentoPt = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(t);
  const marcadoresPt =
    (t.match(/\b(não|você|está|também|após|sobre|igreja|pastor|segundo|durante|pela|pelos|pela|uma|umas|aos)\b/gi) || [])
      .length;
  if (temAcentoPt && marcadoresPt >= 1) return false;
  if (marcadoresPt >= 3) return false;

  const marcadoresEn =
    (t.match(
      /\b(the|and|of|to|in|for|with|from|that|this|are|was|were|have|has|will|should|church|after|before|their|they|said|about|into|over|under|christian|gospel|pastor|how|what|when|why|should)\b/gi
    ) || []).length;
  const palavras = t.split(/\s+/).filter(Boolean).length;
  if (marcadoresEn >= 3) return true;
  if (palavras >= 8 && marcadoresEn / palavras >= 0.12) return true;
  // Sem acento PT e muitas palavras latinas típicas de inglês
  if (!temAcentoPt && marcadoresEn >= 2 && palavras >= 6) return true;
  return false;
}

/**
 * Traduz título/resumo para PT-BR quando o original estiver em outro idioma.
 * Grava no post e devolve o registro atualizado.
 */
async function garantirPostEmPortugues(fonte, post) {
  if (!post || !env.deepseekApiKey) return post;
  const precisa =
    pareceTextoEstrangeiro(post.titulo) || pareceTextoEstrangeiro(post.resumo);
  if (!precisa) return post;

  try {
    const ia = await resumirAlertaBiblioteca({
      plataforma: fonte?.plataforma || 'site',
      nomeFonte: fonte?.nome || '',
      titulo: post.titulo,
      url: post.url,
      snippet: post.resumo,
    });
    const titulo = String(ia.titulo || post.titulo || 'Sem título').slice(0, 500);
    const resumo = String(ia.resumo || post.resumo || '').slice(0, 2000) || null;
    await BibliotecaPosts.update(post.id, { titulo, resumo });
    return { ...post, titulo, resumo };
  } catch (err) {
    console.warn('[biblioteca] traduzir post:', err.message);
    return post;
  }
}

async function traduzirItemBrutoSeEstrangeiro(fonte, item) {
  const titulo = item?.titulo || '';
  const resumo = item?.resumo || '';
  if (!env.deepseekApiKey) return { titulo, resumo };
  if (!pareceTextoEstrangeiro(titulo) && !pareceTextoEstrangeiro(resumo)) {
    return { titulo, resumo };
  }
  try {
    const ia = await resumirAlertaBiblioteca({
      plataforma: fonte?.plataforma || 'site',
      nomeFonte: fonte?.nome || '',
      titulo,
      url: item?.url,
      snippet: resumo,
    });
    return {
      titulo: String(ia.titulo || titulo).slice(0, 500),
      resumo: String(ia.resumo || resumo).slice(0, 2000) || null,
    };
  } catch (err) {
    console.warn('[biblioteca] traduzir item:', err.message);
    return { titulo, resumo };
  }
}

/**
 * Índice de matérias já geradas do usuário (URL + títulos).
 * Inclui rascunho/agendado/publicado — evita o autopilot gerar 5x a mesma notícia.
 */
async function carregarIndiceJaPublicados(userId) {
  const AiMatters = require('../models/AiMatters');
  const matters = await AiMatters.findByUser(userId, 300);
  const urls = new Set();
  const titulos = [];
  for (const m of matters || []) {
    const status = String(m.status || '');
    const usado =
      ['rascunho', 'pronto', 'agendado', 'publicado'].includes(status) ||
      Boolean(m.publication_id);
    if (!usado) continue;
    if (m.fonte_url) urls.add(normalizarUrlBiblioteca(m.fonte_url));
    if (m.fonte_titulo) titulos.push(String(m.fonte_titulo));
    if (m.titulo) titulos.push(String(m.titulo));
  }
  return { urls, titulos };
}

function postJaFoiPublicado(post, indice) {
  if (!post || !indice) return false;
  const url = normalizarUrlBiblioteca(post.url);
  if (url && indice.urls.has(url)) return true;
  const titulo = String(post.titulo || '').trim();
  const resumo = String(post.resumo || '').trim().slice(0, 160);
  if (titulo) {
    const hit = indice.titulos.some(
      (t) =>
        mesmoAssuntoNoticia(titulo, t) ||
        titulosParecidos(titulo, t) ||
        (resumo && mesmoAssuntoNoticia(resumo, t))
    );
    if (hit) return true;
  }
  return false;
}

async function assertPostNaoPublicado(userId, post) {
  if (post.matter_id) {
    const AiMatters = require('../models/AiMatters');
    const existing = await AiMatters.findById(post.matter_id);
    if (existing) {
      const st = String(existing.status || '');
      if (['rascunho', 'pronto', 'agendado', 'publicado'].includes(st) || existing.publication_id) {
        const err = new Error(
          `Esta pauta já virou matéria (#${existing.id}, ${st || 'salva'}). Abra em Matérias salvas em vez de gerar de novo.`
        );
        err.status = 409;
        throw err;
      }
    }
  }
  const indice = await carregarIndiceJaPublicados(userId);
  if (postJaFoiPublicado(post, indice)) {
    await BibliotecaPosts.update(post.id, {
      status: 'ignorado',
      viral_score: null,
      viral_reason: null,
      viral_analyzed_at: null,
    }).catch(() => null);
    const err = new Error(
      'Já existe matéria sobre este assunto (rascunho, agendada ou publicada). Evite duplicar — use Matérias salvas.'
    );
    err.status = 409;
    throw err;
  }
}

/** Remove da lista candidatos já publicados e marca-os como ignorados. */
async function filtrarPostsNaoPublicados(userId, posts) {
  const lista = Array.isArray(posts) ? posts : [];
  if (!lista.length) return [];
  const indice = await carregarIndiceJaPublicados(userId);
  const livres = [];
  for (const post of lista) {
    if (postJaFoiPublicado(post, indice)) {
      await BibliotecaPosts.update(post.id, {
        status: 'ignorado',
        viral_score: null,
        viral_reason: null,
        viral_analyzed_at: null,
      }).catch(() => null);
      continue;
    }
    livres.push(post);
  }
  return livres;
}

const directPublishingPosts = new Set();

function clampAutopilotInterval(minutos) {
  return Math.min(1440, Math.max(5, Number(minutos) || 30));
}

function clampAutopilotPosts(n) {
  return Math.min(5, Math.max(1, Number(n) || 1));
}

function nextAutopilotRun(intervaloMinutos) {
  return new Date(Date.now() + clampAutopilotInterval(intervaloMinutos) * 60 * 1000);
}

/** publicar | aguardar_aprovacao */
function normalizeAutopilotModo(value, fallback = 'publicar') {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  if (v === 'aguardar_aprovacao' || v === 'aguardar' || v === 'aprovacao') {
    return 'aguardar_aprovacao';
  }
  if (v === 'publicar' || v === 'publicar_agora') return 'publicar';
  return fallback === 'aguardar_aprovacao' ? 'aguardar_aprovacao' : 'publicar';
}

function isAutopilotAguardar(cfg) {
  return normalizeAutopilotModo(cfg?.modo) === 'aguardar_aprovacao';
}

/** Em modo aprovação sempre só sites; senão respeita o flag. */
function isAutopilotSomenteSites(cfg) {
  if (isAutopilotAguardar(cfg)) return true;
  return Boolean(cfg?.somente_sites);
}

function filtrarCandidatosPorPlataforma(candidatos, cfg) {
  const list = Array.isArray(candidatos) ? candidatos : [];
  if (!isAutopilotSomenteSites(cfg)) return list;
  return list.filter((p) => String(p.fonte_plataforma || '').toLowerCase() === 'site');
}

function normalizeUrl(raw) {
  const u = String(raw || '').trim();
  if (!/^https?:\/\//i.test(u)) {
    const err = new Error('Informe uma URL válida (http/https)');
    err.status = 400;
    throw err;
  }
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    const err = new Error('URL inválida');
    err.status = 400;
    throw err;
  }
}

function detectarPlataforma(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.includes('facebook.com') || host === 'fb.com' || host === 'fb.watch') return 'facebook';
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('tiktok.com')) return 'tiktok';
    // site de notícias / portal (não rede social)
    if (host && !host.includes('google.') && !host.includes('bing.')) return 'site';
  } catch {
    /* ignore */
  }
  return 'outro';
}

function extrairHandle(url, plataforma) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (plataforma === 'youtube') {
      const at = parts.find((p) => p.startsWith('@'));
      if (at) return at;
      if (parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user') return parts[1] || null;
      return parts[0] || null;
    }
    if (plataforma === 'instagram' || plataforma === 'tiktok') {
      return (parts[0] || '').replace(/^@/, '') || null;
    }
    if (plataforma === 'facebook') {
      // Página sem vanity URL (/profile.php?id=123): o identificador é o id,
      // senão as três viram todas '@profile.php' na lista.
      if (parts[0] === 'profile.php') return u.searchParams.get('id') || null;
      return parts[0] || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function nomePadrao(plataforma, handle, url) {
  if (handle) return handle.startsWith('@') ? handle : `@${handle}`;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return plataforma;
  }
}

async function resolvePage(userId, facebookPageId) {
  if (!facebookPageId) return null;
  const page = await FacebookPages.findById(facebookPageId);
  if (!page) return null;
  const account = await FacebookAccounts.findByUser(userId);
  if (!account || page.facebook_account_id !== account.id) return null;
  return page;
}

function nextRun(intervaloMinutos) {
  const mins = Math.min(Math.max(Number(intervaloMinutos) || 60, 15), 24 * 60);
  return new Date(Date.now() + mins * 60_000);
}

const SCAN_LIMIT = 10;
/** Facebook: API devolve poucos por página — pedimos mais e paginamos. */
const SCAN_LIMIT_FACEBOOK = 40;
const SCAN_LIMIT_SITE = 20;

function dataPublicacaoValida(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dedupeItens(itens, limite = SCAN_LIMIT) {
  const seen = new Set();
  const unicos = [];
  const max = Math.min(40, Math.max(1, Number(limite) || SCAN_LIMIT));
  for (const item of itens) {
    if (!item?.url) continue;
    const key = normalizarUrlBiblioteca(item.externalId || item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unicos.push({
      ...item,
      publicadoEm: dataPublicacaoValida(item.publicadoEm),
      ordemOriginal: unicos.length,
    });
  }

  return unicos
    .sort((a, b) => {
      const dataA = a.publicadoEm?.getTime() || 0;
      const dataB = b.publicadoEm?.getTime() || 0;
      return dataB - dataA || a.ordemOriginal - b.ordemOriginal;
    })
    .slice(0, max)
    .map(({ ordemOriginal, ...item }) => item);
}

function normalizarTipoMidia(item) {
  const explicit = String(item?.mediaType || item?.media_type || '').toLowerCase();
  if (['video', 'reel'].includes(explicit)) return 'video';
  if (explicit === 'image') return 'image';
  if (/instagram\.com\/(reel|reels|tv)\//i.test(String(item?.url || ''))) return 'video';
  return 'post';
}

/**
 * Lista itens recentes de um canal/perfil/site.
 */
async function coletarItensFonte(fonte) {
  const plataforma = fonte.plataforma;
  const url = fonte.url;
  const erros = [];

  if (plataforma === 'youtube' || plataforma === 'tiktok') {
    try {
      return dedupeItens(await coletarViaYtDlp(url, plataforma));
    } catch (err) {
      console.warn('[biblioteca] yt-dlp:', err.message);
      erros.push(err.message);
    }
  }

  if (plataforma === 'instagram') {
    const collected = [];
    // 1) API/HTML/cookies são usados apenas se ScrapeCreators não estiver configurada
    if (collected.length < 3) {
      try {
        collected.push(...(await coletarInstagramWebApi(fonte)));
      } catch (err) {
        console.warn('[biblioteca] ig api:', err.message);
        erros.push(`api: ${err.message}`);
      }
    }
    // 2) HTML / espelhos
    if (collected.length < 3) {
      try {
        collected.push(...(await coletarInstagramHtml(fonte)));
      } catch (err) {
        console.warn('[biblioteca] ig html:', err.message);
        erros.push(`html: ${err.message}`);
      }
    }
    // 3) yt-dlp com cookies do Instagram (não usa cookies do YouTube)
    if (collected.length < 3) {
      try {
        collected.push(...(await coletarViaYtDlp(url, 'instagram')));
      } catch (err) {
        console.warn('[biblioteca] ig yt-dlp:', err.message);
        erros.push(`yt-dlp: ${err.message}`);
      }
    }
    // 4) buscas (podem falhar por crédito)
    if (collected.length < SCAN_LIMIT) {
      collected.push(...(await coletarViaSerper(fonte)));
    }
    if (collected.length < 3) {
      collected.push(...(await coletarViaBraveWeb(fonte)));
    }
    const itens = dedupeItens(collected);
    if (!itens.length) {
      const err = new Error(
        [
          'Não foi possível listar posts do Instagram.',
          erros[0] || '',
          'Valide a sessão no servidor com: node scripts/test-ig-cookies.js. Se aparecer login_required ou challenge, reexporte os cookies Netscape de uma sessão ativa do Instagram.',
        ]
          .filter(Boolean)
          .join(' ')
      );
      err.status = 422;
      throw err;
    }
    return itens;
  }

  if (plataforma === 'facebook') {
    const collected = [];
    const erros = [];
    const scrapeCreatorsFb = require('./scrapeCreatorsFacebook');

    const fbPageScrape = require('./facebookPageScrape');

    // A API pagina o feed de forma previsível. A sessão autenticada entra como
    // complemento/fallback, especialmente para conteúdo ausente no modo público.
    if (scrapeCreatorsFb.isConfigured()) {
      try {
        const itens = await scrapeCreatorsFb.listarPostsPerfil(url, SCAN_LIMIT_FACEBOOK);
        if (itens.length) {
          console.log(`[scrapecreators-fb] ${url}: ${itens.length} post(s)`);
          collected.push(...itens);
          if (dedupeItens(collected, SCAN_LIMIT_FACEBOOK).length >= SCAN_LIMIT_FACEBOOK) {
            return dedupeItens(collected, SCAN_LIMIT_FACEBOOK);
          }
        }
      } catch (err) {
        console.warn('[biblioteca] scrapecreators-fb:', err.message);
        erros.push(err.message);
      }
    }

    if (
      dedupeItens(collected, SCAN_LIMIT_FACEBOOK).length < SCAN_LIMIT_FACEBOOK &&
      fbPageScrape.isConfigured()
    ) {
      try {
        const itens = await fbPageScrape.listarPostsPerfil(url, SCAN_LIMIT_FACEBOOK);
        if (itens.length) {
          collected.push(...itens);
          console.log(`[fb-page] ${url}: ${itens.length} post(s) aproveitado(s)`);
          if (dedupeItens(collected, SCAN_LIMIT_FACEBOOK).length >= SCAN_LIMIT_FACEBOOK) {
            return dedupeItens(collected, SCAN_LIMIT_FACEBOOK);
          }
        } else {
          erros.push('sessão do Facebook não encontrou posts na página');
        }
      } catch (err) {
        console.warn('[biblioteca] fb-page:', err.message);
        erros.push(`sessão FB: ${err.message}`);
      }
    }

    try {
      collected.push(...(await coletarViaSerper(fonte)));
    } catch (err) {
      console.warn('[biblioteca] serper-fb:', err.message);
      erros.push(`serper: ${err.message}`);
    }
    if (collected.length < 3) {
      try {
        collected.push(...(await coletarViaBraveWeb(fonte)));
      } catch (err) {
        console.warn('[biblioteca] brave-fb:', err.message);
        erros.push(`brave: ${err.message}`);
      }
    }
    if (collected.length < 3) {
      try {
        collected.push(...(await coletarViaYtDlp(url, 'facebook')));
      } catch (err) {
        console.warn('[biblioteca] yt-dlp-fb:', err.message);
        erros.push(`yt-dlp: ${err.message}`);
      }
    }

    const itens = dedupeItens(collected, SCAN_LIMIT_FACEBOOK);
    if (!itens.length) {
      const err = new Error(
        [
          'Não foi possível listar posts do Facebook.',
          erros[0] || 'Serper/Brave sem créditos ou página inacessível.',
          require('./facebookPageScrape').isConfigured()
            ? 'Valide a sessão com: node scripts/test-fb-page.js "<url da página>".'
            : 'Configure YTDLP_FB_COOKIES_FILE (leitura gratuita pela sessão) ou recarregue créditos em Serper/ScrapeCreators.',
        ].join(' ')
      );
      err.status = 422;
      throw err;
    }
    return itens;
  }

  if (plataforma === 'site' || plataforma === 'outro') {
    return coletarViaSite(fonte);
  }

  return [];
}

async function coletarViaYtDlp(profileUrl, plataforma) {
  const fs = require('fs');
  const { execSync } = require('child_process');
  const youtubedlPkg = require('youtube-dl-exec');
  const { runYtDlp } = require('./ytDlpAuth');

  let binary = String(process.env.YTDLP_PATH || '').trim();
  if (!binary || !fs.existsSync(binary)) {
    for (const c of ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
      if (fs.existsSync(c)) {
        binary = c;
        break;
      }
    }
  }
  if (!binary) {
    try {
      binary = execSync('which yt-dlp 2>/dev/null || where yt-dlp 2>nul', { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0];
    } catch {
      binary = null;
    }
  }
  const exec = binary ? youtubedlPkg.create(binary) : youtubedlPkg;
  const run = (u, flags) => runYtDlp(exec, u, flags, { platform: plataforma });

  let target = String(profileUrl || '').replace(/\/$/, '');
  if (plataforma === 'youtube' && !/\/(videos|streams|shorts)/i.test(target)) {
    if (/youtube\.com\/@/i.test(target)) target = `${target}/videos`;
  }
  if (plataforma === 'instagram') {
    target = target.replace(/\/(reels|tagged|followers|following)\/?$/i, '');
  }

  const data = await run(target, {
    dumpSingleJson: true,
    flatPlaylist: true,
    playlistEnd: SCAN_LIMIT,
    noWarnings: true,
    skipDownload: true,
  });

  const entries = Array.isArray(data.entries) ? data.entries : data.id ? [data] : [];
  return entries
    .map((e) => {
      const id = e.id || e.url || null;
      let link =
        e.webpage_url ||
        e.url ||
        (plataforma === 'youtube' && id ? `https://www.youtube.com/watch?v=${id}` : null);
      if (plataforma === 'instagram' && id && !/^https?:/i.test(String(link || ''))) {
        link = `https://www.instagram.com/p/${id}/`;
      }
      if (plataforma === 'instagram' && link && /instagram\.com\/(p|reel)\//i.test(link) === false && id) {
        link = `https://www.instagram.com/p/${id}/`;
      }
      if (!link) return null;
      return {
        externalId: String(id || link),
        mediaType:
          plataforma === 'instagram' &&
          ((e.vcodec && e.vcodec !== 'none') || /instagram\.com\/(reel|reels|tv)\//i.test(String(link)))
            ? 'video'
            : 'post',
        titulo: e.title || e.description?.slice(0, 80) || 'Publicação',
        url: link,
        resumo: e.description ? String(e.description).slice(0, 400) : null,
        thumbnail: e.thumbnail || (Array.isArray(e.thumbnails) ? e.thumbnails.at(-1)?.url : null) || null,
        publicadoEm: e.timestamp
          ? new Date(e.timestamp * 1000)
          : e.upload_date
            ? new Date(
                `${e.upload_date.slice(0, 4)}-${e.upload_date.slice(4, 6)}-${e.upload_date.slice(6, 8)}T12:00:00Z`
              )
            : null,
      };
    })
    .filter(Boolean);
}

async function coletarViaSerper(fonte) {
  if (!env.serperApiKey) return [];
  const handle = String(fonte.handle || extrairHandle(fonte.url, fonte.plataforma) || '')
    .replace(/^@/, '')
    .trim();
  let q;
  if (fonte.plataforma === 'instagram' && handle) {
    // Conta free do Serper rejeita padrões com OR / when:
    q = `site:instagram.com/${handle}`;
  } else if (fonte.plataforma === 'facebook' && handle) {
    q = `site:facebook.com/${handle}`;
  } else if (fonte.plataforma === 'site') {
    try {
      const host = new URL(fonte.url).hostname.replace(/^www\./, '');
      // Sem when:/tbs — plano free do Serper bloqueia esses padrões
      q = `site:${host}`;
    } catch {
      return [];
    }
  } else {
    q = fonte.nome ? String(fonte.nome) : fonte.url;
  }

  // Free tier costuma limitar num; 10 é seguro
  const num = Math.min(10, Number(SCAN_LIMIT) || 10);

  try {
    const { data } = await axios.post(
      'https://google.serper.dev/search',
      { q, num, gl: 'br', hl: 'pt-br' },
      {
        headers: { 'X-API-KEY': env.serperApiKey, 'Content-Type': 'application/json' },
        timeout: 15_000,
      }
    );
    return (data?.organic || [])
      .filter((r) => r.link)
      .map((r) => ({
        externalId: r.link,
        titulo: r.title || 'Publicação',
        url: r.link,
        resumo: r.snippet || null,
        thumbnail: null,
        publicadoEm: r.date ? new Date(r.date) : null,
      }));
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    console.warn('[biblioteca] serper:', detail);
    return [];
  }
}

async function coletarViaBraveWeb(fonte) {
  if (!env.braveSearchApiKey) return [];
  const handle = String(fonte.handle || extrairHandle(fonte.url, fonte.plataforma) || '')
    .replace(/^@/, '')
    .trim();
  let q;
  if (fonte.plataforma === 'instagram' && handle) {
    q = `site:instagram.com/${handle}`;
  } else if (fonte.plataforma === 'facebook' && handle) {
    q = `site:facebook.com/${handle}`;
  } else if (fonte.plataforma === 'site') {
    try {
      q = `site:${new URL(fonte.url).hostname.replace(/^www\./, '')}`;
    } catch {
      return [];
    }
  } else {
    return [];
  }

  try {
    const { data } = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: { q, count: SCAN_LIMIT, country: 'BR', search_lang: 'pt-br' },
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': env.braveSearchApiKey,
      },
      timeout: 15_000,
    });
    const results = data?.web?.results || [];
    return results
      .filter((r) => r.url)
      .map((r) => ({
        externalId: r.url,
        titulo: r.title || 'Publicação',
        url: r.url,
        resumo: r.description || null,
        thumbnail: r.thumbnail?.src || null,
        publicadoEm: r.age ? null : null,
      }));
  } catch (err) {
    console.warn('[biblioteca] brave web:', err.message);
    return [];
  }
}

/** API autenticada do Instagram: resolve o usuário e lista o feed recente. */
async function coletarInstagramAuthenticatedApi(handle) {
  const {
    buildInstagramCookieHeader,
    bootstrapInstagramSession,
    instagramApiHeaders,
    instagramFailureReason,
    validateInstagramSession,
  } = require('./instagramCookies');

  const configuredCookies = buildInstagramCookieHeader();
  if (!configuredCookies) return [];

  const boot = await bootstrapInstagramSession(axios);
  const cookieHeader = boot?.cookieHeader || configuredCookies;
  const webHeaders = instagramApiHeaders(cookieHeader, {
    mobile: false,
    wwwClaim: boot?.claim || '0',
  });
  const mobileHeaders = instagramApiHeaders(cookieHeader, {
    mobile: true,
    wwwClaim: boot?.claim || '0',
  });
  const attempts = [];
  let user = null;

  const searchAttempts = [
    {
      label: 'topsearch-web',
      url: 'https://www.instagram.com/web/search/topsearch/',
      params: { query: handle },
      headers: webHeaders,
      users(data) {
        return (Array.isArray(data?.users) ? data.users : []).map((entry) => entry?.user || entry);
      },
    },
    {
      label: 'users-search-web',
      url: 'https://www.instagram.com/api/v1/users/search/',
      params: { q: handle, count: 10 },
      headers: webHeaders,
      users(data) {
        return Array.isArray(data?.users) ? data.users : [];
      },
    },
    {
      label: 'users-search-mobile',
      url: 'https://i.instagram.com/api/v1/users/search/',
      params: { q: handle, count: 10 },
      headers: mobileHeaders,
      users(data) {
        return Array.isArray(data?.users) ? data.users : [];
      },
    },
  ];

  const semMobile = !require('./instagramCookies').instagramMobileLiberado();
  for (const attempt of searchAttempts.filter((a) => !(semMobile && /-mobile$/.test(a.label)))) {
    try {
      const response = await axios.get(attempt.url, {
        params: attempt.params,
        headers: attempt.headers,
        timeout: 20000,
        validateStatus: () => true,
      });
      if (response.status >= 400) {
        attempts.push(`${attempt.label}: ${instagramFailureReason(response.data, response.status)}`);
        continue;
      }
      const users = attempt.users(response.data);
      user = users.find(
        (item) => String(item?.username || '').toLowerCase() === handle.toLowerCase()
      );
      if (user?.pk || user?.id) break;
      attempts.push(`${attempt.label}: usuário não retornado`);
    } catch (err) {
      attempts.push(`${attempt.label}: ${instagramFailureReason(err.response?.data, err.response?.status || 0)}`);
    }
  }

  const userId = user?.pk || user?.id;
  if (!userId) {
    const session = await validateInstagramSession(axios, boot);
    if (!session.ok) {
      throw new Error(`sessão do Instagram rejeitada: ${session.reason}`);
    }
    throw new Error(`usuário @${handle} não encontrado (${attempts.slice(0, 2).join('; ')})`);
  }

  const feedAttempts = [
    {
      label: 'feed-web',
      url: `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(String(userId))}/`,
      headers: webHeaders,
    },
    {
      label: 'feed-mobile',
      url: `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(String(userId))}/`,
      headers: mobileHeaders,
    },
  ];
  let items = [];
  for (const attempt of feedAttempts.filter((a) => !(semMobile && /-mobile$/.test(a.label)))) {
    try {
      const response = await axios.get(attempt.url, {
        params: { count: SCAN_LIMIT },
        headers: {
          ...attempt.headers,
          Referer: `https://www.instagram.com/${handle}/`,
        },
        timeout: 20000,
        validateStatus: () => true,
      });
      if (response.status >= 400) {
        attempts.push(`${attempt.label}: ${instagramFailureReason(response.data, response.status)}`);
        continue;
      }
      items = Array.isArray(response.data?.items) ? response.data.items : [];
      if (items.length) break;
      attempts.push(`${attempt.label}: feed vazio`);
    } catch (err) {
      attempts.push(`${attempt.label}: ${instagramFailureReason(err.response?.data, err.response?.status || 0)}`);
    }
  }

  if (!items.length) {
    const session = await validateInstagramSession(axios, boot);
    if (!session.ok) {
      throw new Error(`sessão do Instagram rejeitada: ${session.reason}`);
    }
    throw new Error(`feed autenticado indisponível (${attempts.slice(-2).join('; ')})`);
  }

  return items
    .map((item) => {
      const shortcode = item?.code;
      if (!shortcode) return null;
      const caption = item.caption?.text || null;
      const isReel = item.product_type === 'clips' || Number(item.media_type) === 2;
      const thumbnail =
        item.image_versions2?.candidates?.[0]?.url ||
        item.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
        null;
      const mediaUrl =
        item.video_versions?.[0]?.url ||
        item.carousel_media?.find((media) => media?.video_versions?.[0]?.url)?.video_versions?.[0]
          ?.url ||
        null;
      return {
        externalId: String(shortcode),
        mediaType: isReel ? 'video' : 'image',
        titulo: String(caption || `Post @${handle}`).slice(0, 120),
        url: `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${shortcode}/`,
        resumo: caption ? String(caption).slice(0, 400) : null,
        thumbnail,
        mediaUrl: isReel ? mediaUrl : null,
        publicadoEm: item.taken_at ? new Date(Number(item.taken_at) * 1000) : null,
      };
    })
    .filter(Boolean)
    .slice(0, SCAN_LIMIT);
}

/** API do Instagram (sessão autenticada quando disponível, pública como fallback). */
async function coletarInstagramWebApi(fonte) {
  const handle = String(fonte.handle || extrairHandle(fonte.url, 'instagram') || '')
    .replace(/^@/, '')
    .trim();
  if (!handle) return [];

  let authenticatedError = null;
  try {
    const authenticatedItems = await coletarInstagramAuthenticatedApi(handle);
    if (authenticatedItems.length) return authenticatedItems;
  } catch (err) {
    authenticatedError = err;
    console.warn('[biblioteca] ig api autenticada:', err.message);
  }

  const headers = {
    'User-Agent':
      (process.env.SOCIAL_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'X-IG-App-ID': '936619743392459',
    'X-ASBD-ID': '129477',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `https://www.instagram.com/${handle}/`,
    Origin: 'https://www.instagram.com',
  };

  const cookieHeader = await buildInstagramCookieHeader();
  if (cookieHeader) headers.Cookie = cookieHeader;

  const urls = [
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
  ];

  let user = null;
  let lastErr = null;
  for (const apiUrl of urls) {
    try {
      const { data } = await axios.get(apiUrl, {
        headers,
        timeout: 20000,
        validateStatus: (s) => s >= 200 && s < 500,
      });
      if (data?.data?.user) {
        user = data.data.user;
        break;
      }
      if (data?.user) {
        user = data.user;
        break;
      }
      lastErr = new Error(data?.message || `HTTP sem user (${apiUrl})`);
    } catch (err) {
      lastErr = err;
    }
  }
  if (!user) {
    const details = [authenticatedError?.message, lastErr?.message].filter(Boolean);
    if (details.length) throw new Error(details.join('; '));
    return [];
  }

  const edges =
    user.edge_owner_to_timeline_media?.edges ||
    user.edge_felix_video_timeline?.edges ||
    [];

  const items = [];
  for (const edge of edges) {
    const n = edge?.node;
    if (!n) continue;
    const shortcode = n.shortcode || n.code;
    if (!shortcode) continue;
    const isReel = n.product_type === 'clips' || n.is_video;
    const pathPart = isReel && !n.edge_sidecar_to_children ? 'reel' : 'p';
    const caption =
      n.edge_media_to_caption?.edges?.[0]?.node?.text ||
      n.caption?.text ||
      null;
    items.push({
      externalId: String(shortcode),
      mediaType: isReel ? 'video' : 'image',
      titulo: String(caption || `Post @${handle}`).slice(0, 120),
      url: `https://www.instagram.com/${pathPart}/${shortcode}/`,
      resumo: caption ? String(caption).slice(0, 400) : null,
      thumbnail: n.thumbnail_src || n.display_url || n.thumbnail_url || null,
      mediaUrl: isReel ? n.video_url || n.video_versions?.[0]?.url || null : null,
      publicadoEm: n.taken_at_timestamp
        ? new Date(n.taken_at_timestamp * 1000)
        : n.taken_at
          ? new Date(Number(n.taken_at) * 1000)
          : null,
    });
  }
  return items.slice(0, SCAN_LIMIT);
}

/** Lê sessionid/csrftoken de YTDLP_IG_COOKIES_FILE (Netscape) se existir. */
async function buildInstagramCookieHeader() {
  const { buildInstagramCookieHeader: build } = require('./instagramCookies');
  return build();
}

/** Tenta ler o JSON embutido da página pública do perfil Instagram. */
async function coletarInstagramHtml(fonte) {
  const handle = String(fonte.handle || extrairHandle(fonte.url, 'instagram') || '')
    .replace(/^@/, '')
    .trim();
  if (!handle) return [];

  const headers = {
    'User-Agent':
      (process.env.SOCIAL_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  };
  const cookieHeader = await buildInstagramCookieHeader();
  if (cookieHeader) headers.Cookie = cookieHeader;

  const candidates = [
    `https://www.instagram.com/${handle}/`,
    `https://www.ddinstagram.com/${handle}/`,
    `https://imginn.com/${handle}/`,
  ];

  let raw = '';
  for (const profileUrl of candidates) {
    try {
      const { data: html, status } = await axios.get(profileUrl, {
        timeout: 20000,
        headers,
        validateStatus: (s) => s >= 200 && s < 500,
        maxRedirects: 5,
      });
      if (status >= 400 || !html) continue;
      raw = String(html || '');
      if (raw.length > 500) break;
    } catch (err) {
      console.warn('[biblioteca] ig fetch', profileUrl, err.message);
    }
  }
  if (!raw) return [];

  const edges = [];

  // window._sharedData (legado)
  const shared = raw.match(/window\._sharedData\s*=\s*(\{.+?\});<\/script>/s);
  if (shared) {
    try {
      const json = JSON.parse(shared[1]);
      const media =
        json?.entry_data?.ProfilePage?.[0]?.graphql?.user?.edge_owner_to_timeline_media?.edges || [];
      for (const edge of media) {
        const n = edge.node;
        if (!n?.shortcode) continue;
        edges.push({
          externalId: n.shortcode,
          titulo: (n.edge_media_to_caption?.edges?.[0]?.node?.text || 'Post Instagram').slice(0, 120),
          url: `https://www.instagram.com/p/${n.shortcode}/`,
          resumo: n.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 400) || null,
          thumbnail: n.thumbnail_src || n.display_url || null,
          publicadoEm: n.taken_at_timestamp ? new Date(n.taken_at_timestamp * 1000) : null,
        });
      }
    } catch {
      /* ignore parse */
    }
  }

  // JSON embutido moderno: "shortcode":"XXXX"
  if (!edges.length) {
    const codes = [
      ...raw.matchAll(/"shortcode"\s*:\s*"([A-Za-z0-9_-]+)"/g),
      ...raw.matchAll(/\/p\/([A-Za-z0-9_-]+)\//g),
      ...raw.matchAll(/\/reel\/([A-Za-z0-9_-]+)\//g),
    ].map((m) => m[1]);
    const unique = [...new Set(codes)].slice(0, SCAN_LIMIT);
    for (const code of unique) {
      const isReel = new RegExp(`/reel/${code}/`).test(raw);
      edges.push({
        externalId: code,
        titulo: `Post @${handle}`,
        url: `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${code}/`,
        resumo: null,
        thumbnail: null,
        publicadoEm: null,
      });
    }
  }

  return edges.slice(0, SCAN_LIMIT);
}

/**
 * Site / portal: RSS + busca site:domínio (últimas notícias).
 */
async function coletarViaSite(fonte) {
  const collected = [];
  const erros = [];
  const limite = SCAN_LIMIT_SITE;

  try {
    collected.push(...(await coletarViaRss(fonte.url)));
  } catch (err) {
    erros.push(`rss: ${err.message}`);
  }

  if (collected.length < limite) {
    try {
      collected.push(...(await coletarSiteGoogleNews(fonte.url, '7d')));
    } catch (err) {
      erros.push(`gnews: ${err.message}`);
    }
  }

  if (collected.length < limite) {
    collected.push(...(await coletarViaSerper({ ...fonte, plataforma: 'site' })));
  }

  if (collected.length < 3) {
    collected.push(...(await coletarViaBraveWeb({ ...fonte, plataforma: 'site' })));
  }

  if (collected.length < 3) {
    try {
      collected.push(...(await coletarLinksHomepage(fonte.url)));
    } catch (err) {
      erros.push(`home: ${err.message}`);
    }
  }

  const itens = dedupeItens(collected, limite);
  if (!itens.length) {
    const err = new Error(
      `Não encontrei notícias neste site. ${erros[0] || 'Tente a URL da home ou do feed RSS.'}`
    );
    err.status = 422;
    throw err;
  }
  return itens;
}

async function coletarViaRss(pageUrl) {
  const feeds = await descobrirFeedsRss(pageUrl);
  const itens = [];
  for (const feed of feeds.slice(0, 3)) {
    try {
      const { data } = await axios.get(feed, {
        timeout: 15000,
        headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const xml = String(data || '');
      const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
      for (const block of blocks.slice(0, SCAN_LIMIT)) {
        const titulo = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1];
        const link =
          (block.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] ||
          (block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i) || [])[1];
        const desc = (block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) ||
          block.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/i) ||
          [])[1];
        const pub = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
          block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) ||
          [])[1];
        const cleanTitle = String(titulo || '')
          .replace(/<[^>]+>/g, '')
          .trim();
        const cleanLink = String(link || '').trim();
        if (!cleanLink || !/^https?:/i.test(cleanLink)) continue;
        itens.push({
          externalId: cleanLink,
          titulo: cleanTitle || 'Notícia',
          url: cleanLink,
          resumo: desc
            ? String(desc)
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 400)
            : null,
          thumbnail: null,
          publicadoEm: pub ? new Date(pub) : null,
        });
      }
      if (itens.length >= SCAN_LIMIT) break;
    } catch (err) {
      console.warn('[biblioteca] rss feed:', err.message);
    }
  }
  return itens;
}

async function descobrirFeedsRss(pageUrl) {
  const feeds = new Set();
  try {
    const base = new URL(pageUrl);
    const candidates = [
      new URL('/feed', base).href,
      new URL('/rss', base).href,
      new URL('/feed/', base).href,
      new URL('/rss.xml', base).href,
      new URL('/atom.xml', base).href,
      new URL('/index.xml', base).href,
    ];
    candidates.forEach((f) => feeds.add(f));

    const { data: html } = await axios.get(pageUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ViralizeAI/1.0; +https://www.viralizeai.online)',
        Accept: 'text/html',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const links = String(html || '').matchAll(
      /<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]*>/gi
    );
    for (const m of links) {
      const href = (m[0].match(/href=["']([^"']+)["']/i) || [])[1];
      if (href) {
        try {
          feeds.add(new URL(href, pageUrl).href);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    console.warn('[biblioteca] descobrir rss:', err.message);
  }
  return [...feeds];
}

async function coletarSiteGoogleNews(pageUrl, janela = '7d') {
  let host;
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    return [];
  }
  const when = ['1d', '7d'].includes(String(janela)) ? String(janela) : '7d';
  const q = encodeURIComponent(`site:${host} when:${when}`);
  const rssUrl = `https://news.google.com/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
  const { data } = await axios.get(rssUrl, {
    timeout: 15000,
    headers: { Accept: 'application/rss+xml, text/xml' },
  });
  const xml = String(data || '');
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return blocks.slice(0, SCAN_LIMIT_SITE).map((block) => {
    const titulo = (block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
      block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ||
      [])[1];
    const link = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1];
    const desc = (block.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ||
      block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) ||
      [])[1];
    const pub = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1];
    return {
      externalId: String(link || '').trim(),
      titulo: String(titulo || 'Notícia')
        .replace(/<[^>]+>/g, '')
        .trim(),
      url: String(link || '').trim(),
      resumo: desc
        ? String(desc)
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 400)
        : null,
      thumbnail: null,
      publicadoEm: pub ? new Date(pub) : null,
    };
  }).filter((i) => i.url && /^https?:/i.test(i.url));
}

async function coletarLinksHomepage(pageUrl) {
  const { data: html } = await axios.get(pageUrl, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ViralizeAI/1.0)',
      Accept: 'text/html',
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const base = new URL(pageUrl);
  const hrefs = [...String(html || '').matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const itens = [];
  const seen = new Set();
  for (const m of hrefs) {
    let href;
    try {
      href = new URL(m[1], pageUrl).href;
    } catch {
      continue;
    }
    if (href.split('#')[0] === pageUrl.replace(/\/$/, '')) continue;
    if (!href.includes(base.hostname)) continue;
    if (/\.(jpg|png|gif|css|js|pdf|zip)(\?|$)/i.test(href)) continue;
    if (!/\/\d{4}\/|\/noticia|\/news|\/materia|\/post|\/article|\.html?$/i.test(href) && href.split('/').filter(Boolean).length < 4) {
      continue;
    }
    const key = href.split('?')[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const titulo = String(m[2] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (titulo.length < 18) continue;
    itens.push({
      externalId: href,
      titulo: titulo.slice(0, 200),
      url: href,
      resumo: null,
      thumbnail: null,
      publicadoEm: null,
    });
    if (itens.length >= SCAN_LIMIT) break;
  }
  return itens;
}

async function criarFonte({
  userId,
  url,
  nome,
  notas,
  monitorar = false,
  intervaloMinutos = 60,
  facebookPageId = null,
}) {
  const normalized = normalizeUrl(url);
  const plataforma = detectarPlataforma(normalized);
  const handle = extrairHandle(normalized, plataforma);
  const displayName = String(nome || nomePadrao(plataforma, handle, normalized)).trim().slice(0, 200);

  if (facebookPageId) {
    const page = await resolvePage(userId, facebookPageId);
    if (!page) {
      const err = new Error('Página do Facebook inválida');
      err.status = 400;
      throw err;
    }
  }

  let avatar = null;
  if (plataforma === 'youtube' || plataforma === 'tiktok') {
    try {
      const meta = await importService.fetchLinkMetadata(normalized);
      avatar = meta.thumbnail || null;
      if (!nome && meta.autor) {
        // keep displayName unless user passed nome
      }
    } catch {
      /* ignore preview */
    }
  }

  try {
    const [id] = await BibliotecaFontes.create({
      user_id: userId,
      plataforma,
      nome: displayName,
      url: normalized.slice(0, 500),
      handle,
      avatar_url: avatar,
      notas: notas ? String(notas).slice(0, 2000) : null,
      monitorar: Boolean(monitorar),
      intervalo_minutos: Math.min(Math.max(Number(intervaloMinutos) || 60, 15), 24 * 60),
      facebook_page_id: facebookPageId || null,
      proxima_execucao: monitorar ? new Date() : null,
    });
    return BibliotecaFontes.findById(id);
  } catch (err) {
    if (String(err.message || '').includes('Duplicate') || err.code === 'ER_DUP_ENTRY') {
      const e = new Error('Esta URL já está na sua biblioteca');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

/**
 * Fonte já cadastrada para esta URL, ou null.
 *
 * O Dots comparava a URL crua, como o editor colou, com a que está no banco —
 * que passou por `normalizeUrl` e perdeu a barra final. Então
 * "facebook.com/pagina/" nunca casava com "facebook.com/pagina": o dot tentava
 * criar, batia na unicidade (user_id, url) e nascia sem página nenhuma.
 *
 * A comparação mora aqui, junto da normalização, para não haver duas verdades.
 */
async function encontrarFontePorUrl(userId, url) {
  let normalizada;
  try {
    normalizada = normalizeUrl(url);
  } catch {
    return null;
  }

  const semBarra = (valor) => String(valor || '').replace(/\/+$/, '').toLowerCase();
  const alvo = semBarra(normalizada);
  const fontes = await BibliotecaFontes.findByUser(userId);

  const exata = fontes.find((f) => semBarra(f.url) === alvo);
  if (exata) return exata;

  // Mesmo perfil na mesma plataforma: cobre www, http/https e query a mais.
  const plataforma = detectarPlataforma(normalizada);
  const handle = extrairHandle(normalizada, plataforma);
  if (!handle) return null;
  return (
    fontes.find(
      (f) => f.plataforma === plataforma && semBarra(f.handle) === semBarra(handle)
    ) || null
  );
}

async function atualizarFonte(userId, fonteId, patch = {}) {
  const fonte = await BibliotecaFontes.findById(fonteId);
  if (!fonte || Number(fonte.user_id) !== Number(userId)) {
    const err = new Error('Fonte não encontrada');
    err.status = 404;
    throw err;
  }

  const data = {};
  if (patch.nome != null) data.nome = String(patch.nome).trim().slice(0, 200);
  if (patch.notas != null) data.notas = String(patch.notas).slice(0, 2000);
  if (patch.monitorar != null) {
    data.monitorar = Boolean(patch.monitorar);
    if (data.monitorar && !fonte.monitorar) data.proxima_execucao = new Date();
  }
  if (patch.intervaloMinutos != null || patch.intervalo_minutos != null) {
    data.intervalo_minutos = Math.min(
      Math.max(Number(patch.intervaloMinutos ?? patch.intervalo_minutos) || 60, 15),
      24 * 60
    );
  }
  if (patch.facebookPageId != null || patch.facebook_page_id != null) {
    const pageId = patch.facebookPageId ?? patch.facebook_page_id;
    if (pageId) {
      const page = await resolvePage(userId, pageId);
      if (!page) {
        const err = new Error('Página do Facebook inválida');
        err.status = 400;
        throw err;
      }
      data.facebook_page_id = pageId;
    } else {
      data.facebook_page_id = null;
    }
  }

  await BibliotecaFontes.update(fonteId, data);
  return BibliotecaFontes.findById(fonteId);
}

async function registrarItensNovos(fonte, itens, { gerarResumoIa = true } = {}) {
  const novos = [];
  // Em redes sociais, posts distintos podem ter legendas/títulos muito parecidos.
  // O link/external_id é a identidade confiável; dedupe semântico por título
  // fica restrito a sites, onde republicações são comuns.
  const deduplicarPorTitulo = ['site', 'outro'].includes(
    String(fonte.plataforma || '').toLowerCase()
  );
  // Pool recente da fonte p/ dedupe por URL normalizada e título parecido
  const recentes = await BibliotecaPosts.findByFonte(fonte.id, 120);
  const urlsVistas = new Set(
    (recentes || []).map((p) => normalizarUrlBiblioteca(p.url)).filter(Boolean)
  );
  const titulosVistos = (recentes || []).map((p) => String(p.titulo || ''));

  for (const item of itens) {
    const url = String(item.url || '').trim();
    if (!url) continue;
    const urlNorm = normalizarUrlBiblioteca(url);
    const externalId = stableExternalId(item.externalId || url);
    const exists = await BibliotecaPosts.findByExternal(fonte.id, externalId);
    if (exists) continue;
    if (urlNorm && urlsVistas.has(urlNorm)) continue;

    const tituloBruto = String(item.titulo || 'Sem título').slice(0, 500);
    if (
      deduplicarPorTitulo &&
      tituloBruto.length >= 24 &&
      titulosVistos.some((t) => titulosParecidos(t, tituloBruto) || mesmoAssuntoNoticia(t, tituloBruto))
    ) {
      continue;
    }

    // A IA pode ser desligada em coletas grandes; o item bruto continua íntegro.
    let tituloFinal = tituloBruto;
    let resumoFinal = item.resumo ? String(item.resumo).slice(0, 2000) : null;

    if (gerarResumoIa && env.deepseekApiKey) {
      try {
        const ia = await resumirAlertaBiblioteca({
          plataforma: fonte.plataforma,
          nomeFonte: fonte.nome,
          titulo: item.titulo,
          url: item.url,
          snippet: item.resumo,
        });
        tituloFinal = String(ia.titulo || tituloFinal).slice(0, 500);
        resumoFinal = String(ia.resumo || resumoFinal || '').slice(0, 2000) || null;
      } catch (err) {
        console.warn('[biblioteca] resumo/tradução IA:', err.message);
        const fallback = await traduzirItemBrutoSeEstrangeiro(fonte, item);
        tituloFinal = String(fallback.titulo || tituloFinal).slice(0, 500);
        resumoFinal = fallback.resumo ? String(fallback.resumo).slice(0, 2000) : resumoFinal;
      }
    }

    // Re-checa título após IA (às vezes a IA padroniza e bate com alerta anterior)
    if (
      deduplicarPorTitulo &&
      tituloFinal.length >= 24 &&
      titulosVistos.some((t) => titulosParecidos(t, tituloFinal) || mesmoAssuntoNoticia(t, tituloFinal))
    ) {
      continue;
    }

    let postId;
    try {
      [postId] = await BibliotecaPosts.create({
        fonte_id: fonte.id,
        user_id: fonte.user_id,
        external_id: externalId,
        titulo: tituloFinal,
        url,
        resumo: resumoFinal,
        thumbnail: item.thumbnail ? String(item.thumbnail).slice(0, 1000) : null,
        media_url: item.mediaUrl ? String(item.mediaUrl).slice(0, 8000) : null,
        media_type: normalizarTipoMidia(item),
        publicado_em: item.publicadoEm || null,
        status: 'novo',
      });
    } catch (err) {
      // unique (fonte_id, external_id) — corrida entre ticks
      if (String(err.code) === 'ER_DUP_ENTRY' || /duplicate/i.test(err.message)) continue;
      throw err;
    }

    urlsVistas.add(urlNorm);
    titulosVistos.push(tituloFinal);

    const jaTemAlerta = await BibliotecaAlertas.findByPostId(postId, fonte.user_id);
    if (!jaTemAlerta) {
      try {
        await BibliotecaAlertas.create({
          user_id: fonte.user_id,
          fonte_id: fonte.id,
          post_id: postId,
          titulo: `${fonte.nome}: ${tituloFinal}`.slice(0, 300),
          resumo: resumoFinal || `Novo conteúdo em ${fonte.plataforma}: ${item.url}`,
          lido: false,
        });
      } catch (err) {
        if (String(err.code) !== 'ER_DUP_ENTRY' && !/duplicate/i.test(err.message)) throw err;
      }
    }

    novos.push(await BibliotecaPosts.findById(postId));
  }
  return novos;
}

async function salvarItensFonte(fonte, itens, { silentFirst = false } = {}) {
  const jaTemPosts = (await BibliotecaPosts.findByFonte(fonte.id, 1)).length > 0;
  const limite =
    fonte.plataforma === 'site'
      ? SCAN_LIMIT_SITE
      : fonte.plataforma === 'facebook'
        ? SCAN_LIMIT_FACEBOOK
        : SCAN_LIMIT;
  const lote = dedupeItens(itens, limite);

  // Primeira varredura automática: cria uma base sem inundar os alertas.
  if (!jaTemPosts && silentFirst) {
    let salvos = 0;
    for (const item of lote) {
      const url = String(item.url || '').trim();
      if (!url) continue;
      const externalId = stableExternalId(item.externalId || url);
      const exists = await BibliotecaPosts.findByExternal(fonte.id, externalId);
      if (exists) continue;
      // Facebook pode trazer 40 itens: salve a base imediatamente e traduza depois.
      const traduzido =
        fonte.plataforma === 'facebook'
          ? { titulo: item.titulo, resumo: item.resumo }
          : await traduzirItemBrutoSeEstrangeiro(fonte, item);
      await BibliotecaPosts.create({
        fonte_id: fonte.id,
        user_id: fonte.user_id,
        external_id: externalId,
        titulo: String(traduzido.titulo || item.titulo || 'Sem título').slice(0, 500),
        url,
        resumo: traduzido.resumo
          ? String(traduzido.resumo).slice(0, 2000)
          : item.resumo
            ? String(item.resumo).slice(0, 2000)
            : null,
        thumbnail: item.thumbnail ? String(item.thumbnail).slice(0, 1000) : null,
        media_url: item.mediaUrl ? String(item.mediaUrl).slice(0, 8000) : null,
        media_type: normalizarTipoMidia(item),
        publicado_em: item.publicadoEm || null,
        status: 'visto',
      });
      salvos += 1;
    }
    await BibliotecaFontes.update(fonte.id, {
      ultimo_scan: new Date(),
      proxima_execucao: nextRun(fonte.intervalo_minutos),
      ultimo_erro: null,
      ultimo_external_id: lote[0]
        ? stableExternalId(lote[0].externalId || lote[0].url)
        : fonte.ultimo_external_id,
      total_detectados: Number(fonte.total_detectados || 0) + salvos,
    });
    return { novos: [], itens: lote.length, salvos };
  }

  const novos = await registrarItensNovos(fonte, lote, {
    gerarResumoIa: fonte.plataforma !== 'facebook',
  });
  await BibliotecaFontes.update(fonte.id, {
    ultimo_scan: new Date(),
    proxima_execucao: nextRun(fonte.intervalo_minutos),
    ultimo_erro: null,
    ultimo_external_id: lote[0]
      ? stableExternalId(lote[0].externalId || lote[0].url)
      : fonte.ultimo_external_id,
    total_detectados: Number(fonte.total_detectados || 0) + novos.length,
  });
  return { novos, itens: lote.length };
}

const BRIGHTDATA_TRIGGER_STALE_MS = 5 * 60_000;
const BRIGHTDATA_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;
let brightDataTickRunning = false;

function scrapeAgeMs(fonte) {
  const requestedAt = fonte?.scrape_requested_at
    ? new Date(fonte.scrape_requested_at).getTime()
    : 0;
  return requestedAt ? Math.max(0, Date.now() - requestedAt) : Infinity;
}

function scrapePendente(fonte) {
  return ['triggering', 'pending'].includes(String(fonte?.scrape_status || ''));
}

async function iniciarBrightDataScan(fonte, { silentFirst = false } = {}) {
  const brightdata = require('./brightdataInstagram');
  let atual = await BibliotecaFontes.findById(fonte.id);

  if (scrapePendente(atual)) {
    const staleTrigger =
      atual.scrape_status === 'triggering' &&
      scrapeAgeMs(atual) > BRIGHTDATA_TRIGGER_STALE_MS;

    if (!staleTrigger) {
      // Um clique manual transforma uma baseline automática pendente em scan visível.
      if (!silentFirst && atual.scrape_silent_first) {
        await BibliotecaFontes.update(atual.id, { scrape_silent_first: false });
      }
      return {
        pending: true,
        itens: 0,
        novos: [],
        message: 'Escaneando em segundo plano. Os posts aparecerão automaticamente.',
      };
    }

    await BibliotecaFontes.updateScrapeIfStatus(atual.id, 'triggering', {
      scrape_snapshot_id: null,
      scrape_status: 'failed',
      scrape_error: 'Disparo Bright Data interrompido antes de salvar o snapshot',
      scrape_silent_first: false,
    });
  }

  const claimed = await BibliotecaFontes.tryStartScrape(fonte.id, { silentFirst });
  if (!claimed) {
    return {
      pending: true,
      itens: 0,
      novos: [],
      message: 'Já existe um escaneamento em segundo plano.',
    };
  }

  try {
    const handle = atual.handle || extrairHandle(atual.url, 'instagram');
    const result = await brightdata.dispararColeta(handle, SCAN_LIMIT);

    if (result.posts) {
      const salvo = await salvarItensFonte(atual, result.posts, { silentFirst });
      await BibliotecaFontes.updateScrapeIfStatus(atual.id, 'triggering', {
        scrape_snapshot_id: null,
        scrape_status: null,
        scrape_requested_at: null,
        scrape_error: null,
        scrape_silent_first: false,
      });
      return { ...salvo, pending: false };
    }

    const snapshotSaved = await BibliotecaFontes.updateScrapeIfStatus(atual.id, 'triggering', {
      scrape_snapshot_id: result.snapshotId,
      scrape_status: 'pending',
      scrape_error: null,
      proxima_execucao: nextRun(atual.intervalo_minutos),
    });
    if (!snapshotSaved) {
      throw new Error('O estado da fonte mudou durante o disparo Bright Data');
    }
    console.log(`[brightdata-ig] snapshot ${result.snapshotId} iniciado para @${handle}`);
    return {
      pending: true,
      itens: 0,
      novos: [],
      message: 'Escaneando em segundo plano. Os posts aparecerão automaticamente.',
    };
  } catch (err) {
    await BibliotecaFontes.updateScrapeIfStatus(atual.id, 'triggering', {
      scrape_snapshot_id: null,
      scrape_status: 'failed',
      scrape_error: String(err.message || err).slice(0, 1000),
      scrape_silent_first: false,
      ultimo_erro: String(err.message || err).slice(0, 1000),
      ultimo_scan: new Date(),
      proxima_execucao: nextRun(atual.intervalo_minutos),
    });
    err.status = err.status || 502;
    throw err;
  }
}

async function escanearFonte(fonte, { silentFirst = false } = {}) {
  const scrapeCreators = require('./scrapeCreatorsInstagram');
  let resultado;

  const salvarColetados = async (itens) => salvarItensFonte(fonte, itens, { silentFirst });

  if (fonte.plataforma === 'instagram' && scrapeCreators.isConfigured()) {
    // Descarta qualquer estado legado da Bright Data antes da coleta direta.
    await BibliotecaFontes.update(fonte.id, {
      scrape_snapshot_id: null,
      scrape_status: null,
      scrape_requested_at: null,
      scrape_error: null,
      scrape_silent_first: false,
    });
    const handle = fonte.handle || extrairHandle(fonte.url, 'instagram');
    try {
      const itens = await scrapeCreators.listarPostsPerfil(handle, SCAN_LIMIT);
      console.log(`[scrapecreators-ig] @${handle}: ${itens.length} post(s)`);
      resultado = await salvarColetados(itens);
    } catch (err) {
      const msg = String(err.message || err);
      const semCredito = /out of credits|not enough credits|insufficient credits|buy more/i.test(msg);
      const bloqueado = /402|429|403|payment|quota|rate.?limit/i.test(msg);
      if (!semCredito && !bloqueado) throw err;
      console.warn(
        `[scrapecreators-ig] @${handle}: falhou (${semCredito ? 'sem créditos' : 'bloqueio'}), usando fallback cookies/yt-dlp: ${msg}`
      );
      const itens = await coletarItensFonte(fonte);
      resultado = await salvarColetados(itens);
    }
  } else {
    const itens = await coletarItensFonte(fonte);
    resultado = await salvarColetados(itens);
  }

  // No Facebook, não segura o scan com várias chamadas de IA: os posts aparecem
  // primeiro e o enriquecimento dos mais recentes acontece em segundo plano.
  if (fonte.plataforma === 'facebook') {
    traduzirPostsPendentesDaFonte(fonte, 12).catch((err) => {
      console.warn('[biblioteca] traduzir pendentes:', err.message);
    });
  } else {
    try {
      await traduzirPostsPendentesDaFonte(fonte, 12);
    } catch (err) {
      console.warn('[biblioteca] traduzir pendentes:', err.message);
    }
  }
  return resultado;
}

async function traduzirPostsPendentesDaFonte(fonte, limit = 12) {
  if (!env.deepseekApiKey) return 0;
  const posts = await BibliotecaPosts.findByFonte(fonte.id, Math.min(30, Math.max(1, limit)));
  let n = 0;
  for (const post of posts) {
    if (post.matter_id) continue;
    if (!pareceTextoEstrangeiro(post.titulo) && !pareceTextoEstrangeiro(post.resumo)) continue;
    await garantirPostEmPortugues(fonte, post);
    n += 1;
  }
  return n;
}

async function escanearAgora(userId, fonteId) {
  const fonte = await BibliotecaFontes.findById(fonteId);
  if (!fonte || Number(fonte.user_id) !== Number(userId)) {
    const err = new Error('Fonte não encontrada');
    err.status = 404;
    throw err;
  }
  try {
    // Scan manual: Facebook salva até 40 posts; os demais usam o limite da plataforma.
    return await escanearFonte(fonte, { silentFirst: false });
  } catch (err) {
    await BibliotecaFontes.update(fonte.id, {
      ultimo_erro: String(err.message || err).slice(0, 1000),
      proxima_execucao: nextRun(fonte.intervalo_minutos),
      ultimo_scan: new Date(),
    });
    throw err;
  }
}

function classificarLinkBiblioteca(url) {
  try {
    const host = new URL(String(url || '')).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be' || host === 'm.youtube.com') return 'youtube';
    if (
      host.includes('facebook.com') ||
      host === 'fb.com' ||
      host === 'fb.watch' ||
      host === 'm.facebook.com'
    ) {
      return 'facebook';
    }
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('tiktok.com')) return 'tiktok';
  } catch {
    /* ignore */
  }
  return null;
}

async function extrairYoutubeParaBiblioteca(url, post, fonte) {
  const meta = await importService.fetchLinkMetadata(url);
  const titulo = meta.titulo || post.titulo || null;
  const descricao = String(meta.description || post.resumo || '').trim();
  const veiculo = meta.autor || fonte?.nome || 'YouTube';
  let trecho = [titulo ? `Título: ${titulo}` : null, descricao || null].filter(Boolean).join('\n\n');

  try {
    const { trySubtitlesFromUrl } = require('./transcriptionService');
    const subs = await trySubtitlesFromUrl(url);
    if (subs?.text && String(subs.text).trim().length >= 40) {
      trecho = `${trecho}\n\nTranscrição/legendas:\n${String(subs.text).trim().slice(0, 12000)}`;
    }
  } catch (err) {
    console.warn('[biblioteca] youtube transcrição:', err.message);
  }

  if (trecho.trim().length < 180) return null;

  return {
    titulo,
    link: url,
    resumo: descricao || trecho.slice(0, 400),
    imagemFonte: meta.thumbnail || post.thumbnail || null,
    veiculo,
    fonte: veiculo,
    redeSocial: true,
    tipoFonte: 'rede_social',
    contextoApuracao: [
      titulo ? `Título do vídeo:\n${titulo}` : null,
      `Canal/perfil:\n${veiculo}`,
      `URL original:\n${url}`,
      `Texto documentado do vídeo:\n${trecho.slice(0, 14000)}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    fontesApuracao: [
      {
        veiculo,
        url,
        titulo,
        resumo: descricao || trecho.slice(0, 400),
        trecho: trecho.slice(0, 14000),
        ehRedeSocial: true,
        plataforma: 'youtube',
      },
    ],
  };
}

async function extrairOriginalParaTopicoBiblioteca(post, fonte) {
  const url = String(post?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;

  const tipo = classificarLinkBiblioteca(url);
  try {
    if (tipo === 'youtube') {
      return await extrairYoutubeParaBiblioteca(url, post, fonte);
    }

    if (tipo === 'facebook' || tipo === 'instagram') {
      const {
        isSocialPostUrl,
        normalizarUrlSocial,
        extrairPostSocial,
        socialParaTopico,
      } = require('./socialPostExtract');
      const link = normalizarUrlSocial(url);
      if (!isSocialPostUrl(link)) return null;
      const extraido = await extrairPostSocial(link);
      if (String(extraido?.texto || '').trim().length < 40) return null;
      const topico = socialParaTopico(extraido, link);
      return {
        ...topico,
        titulo: topico.titulo || post.titulo,
        resumo: topico.resumo || post.resumo,
        imagemFonte: topico.imagemFonte || post.thumbnail,
        veiculo: topico.veiculo || fonte?.nome || tipo,
        fonte: topico.fonte || fonte?.nome || tipo,
      };
    }
  } catch (err) {
    console.warn('[biblioteca] extrair original:', err.message);
  }

  return null;
}

/**
 * Gera matéria texto (ai_matters) a partir de um post da biblioteca.
 */
async function gerarTextoDePostImpl({
  userId,
  postId,
  facebookPageId,
  tipoPublicacao = 'texto',
  publicarAgora = false,
}) {
  assertDeepseek();
  const post = await BibliotecaPosts.findById(postId);
  if (!post || Number(post.user_id) !== Number(userId)) {
    const err = new Error('Post não encontrado');
    err.status = 404;
    throw err;
  }
  if (post.matter_id) {
    const AiMatters = require('../models/AiMatters');
    const existente = await AiMatters.findById(post.matter_id);
    if (existente) return { matter: existente, created: false, avisos: ['Esta pauta já tinha matéria gerada.'] };
  }
  const fonte = await BibliotecaFontes.findById(post.fonte_id);
  // Fonte em inglês/outro idioma → traduz título/resumo antes de checar duplicata e gerar
  const postPt = await garantirPostEmPortugues(fonte, post);
  await assertPostNaoPublicado(userId, {
    ...post,
    titulo: postPt.titulo || post.titulo,
    resumo: postPt.resumo || post.resumo,
    url: postPt.url || post.url,
  });
  let pageId = facebookPageId || fonte?.facebook_page_id || null;
  if (!pageId) {
    try {
      const Users = require('../models/Users');
      pageId = await Users.getDefaultFacebookPageId(userId);
    } catch {
      pageId = null;
    }
  }
  if (pageId) {
    const page = await resolvePage(userId, pageId);
    if (!page) {
      const err = new Error('Página do Facebook inválida');
      err.status = 400;
      throw err;
    }
  }

  const extraidoOriginal = await extrairOriginalParaTopicoBiblioteca(postPt, fonte);
  const postBase = {
    ...postPt,
    titulo: extraidoOriginal?.titulo || postPt.titulo,
    resumo: extraidoOriginal?.resumo || postPt.resumo,
    thumbnail: extraidoOriginal?.imagemFonte || postPt.thumbnail,
    url: extraidoOriginal?.link || postPt.url,
  };

  const urlPost = String(postBase.url || '');
  const ehRedeSocialUrl =
    /(?:instagram|facebook|fb\.watch|tiktok|youtube|youtu\.be)\.com/i.test(urlPost) ||
    /youtu\.be\//i.test(urlPost);

  const topico = {
    titulo: postBase.titulo,
    link: postBase.url,
    resumo: postBase.resumo,
    nicho: fonte?.nome || fonte?.plataforma || 'notícia',
    fonte: extraidoOriginal?.fonte || fonte?.nome,
    veiculo: extraidoOriginal?.veiculo || fonte?.nome || fonte?.plataforma,
    imagemFonte: postBase.thumbnail,
    contextoApuracao: extraidoOriginal?.contextoApuracao || [
      postBase.titulo ? `Título capturado da fonte:\n${postBase.titulo}` : null,
      postBase.resumo ? `Texto/resumo capturado da fonte:\n${postBase.resumo}` : null,
      urlPost ? `URL original:\n${urlPost}` : null,
    ]
      .filter(Boolean)
      .join('\n\n'),
    fontesApuracao: Array.isArray(extraidoOriginal?.fontesApuracao)
      ? extraidoOriginal.fontesApuracao
      : postBase.resumo
      ? [
          {
            veiculo: fonte?.nome || fonte?.plataforma || 'Biblioteca',
            url: postBase.url,
            titulo: postBase.titulo,
            resumo: postBase.resumo,
            trecho: postBase.resumo,
            ehRedeSocial: ehRedeSocialUrl,
          },
        ]
      : [],
    // Só trata como rede social se a URL for IG/FB/TikTok/YT —
    // sites de notícia (ex.: fuxicogospel) precisam de scrape de autor + capa.
    redeSocial: Boolean(extraidoOriginal?.redeSocial || ehRedeSocialUrl),
    tipoFonte: extraidoOriginal?.tipoFonte || (ehRedeSocialUrl ? 'rede_social' : 'noticia'),
    fonteMinimaBiblioteca: true,
    idiomaObrigatorio: 'pt-BR',
    traduzirFonte: true,
  };

  const gerado = await materiaIaService.gerarCompleto({
    userId,
    facebookPageId: pageId || null,
    topico,
    tipoPublicacao,
    status: publicarAgora ? 'publicado' : 'rascunho',
    factualEstrito: true,
    exigirFonteDocumentada: true,
  });

  await BibliotecaPosts.update(post.id, {
    status: 'gerado_texto',
    matter_id: gerado.matter?.id || null,
    titulo: postBase.titulo ? String(postBase.titulo).slice(0, 500) : null,
    resumo: postBase.resumo ? String(postBase.resumo).slice(0, 2000) : null,
  });

  // Se o post já estava na agenda (pré-agendado), religa a matéria e preserva o horário.
  if (gerado.matter?.id) {
    try {
      const agendaService = require('./bibliotecaAgendaService');
      await agendaService.vincularMateriaNaAgendaPorPost(userId, post.id, gerado.matter.id);
    } catch (err) {
      console.warn('[biblioteca] vincular agenda:', err.message);
    }
  }

  return gerado;
}

async function gerarTextoDePost(args) {
  const lockKey = `${args?.userId || 'u'}:${args?.postId || 'p'}:texto`;
  if (geracaoTextoLocks.has(lockKey)) return geracaoTextoLocks.get(lockKey);

  const promise = gerarTextoDePostImpl(args).finally(() => {
    geracaoTextoLocks.delete(lockKey);
  });
  geracaoTextoLocks.set(lockKey, promise);
  return promise;
}

/**
 * Enfileira importação de vídeo do post na Fila ou no pipeline de Reel.
 */
async function gerarVideoDePost({ userId, postId, facebookPageId = null }) {
  const post = await BibliotecaPosts.findById(postId);
  if (!post || Number(post.user_id) !== Number(userId)) {
    const err = new Error('Post não encontrado');
    err.status = 404;
    throw err;
  }
  await assertPostNaoPublicado(userId, post);

  const fonte = await BibliotecaFontes.findById(post.fonte_id);
  const instagramVideo =
    fonte?.plataforma === 'instagram' &&
    (post.media_type === 'video' || /instagram\.com\/(reel|reels|tv)\//i.test(String(post.url)));

  if (instagramVideo) {
    const result = await materiaIaService.gerarDeLink({
      userId,
      url: post.url,
      facebookPageId: facebookPageId || fonte?.facebook_page_id || null,
      tipoPublicacao: 'reel',
      status: 'rascunho',
    });
    await BibliotecaPosts.update(post.id, {
      status: 'gerado_video',
      matter_id: result.matter?.id || null,
      video_id: result.video?.id || null,
    });
    return result;
  }

  if (fonte && !['youtube', 'tiktok'].includes(fonte.plataforma)) {
    const err = new Error('Este item não foi identificado como vídeo. Escaneie a fonte novamente e tente em um Reel.');
    err.status = 422;
    throw err;
  }

  const existing = await Videos.findByUrl(userId, post.url);
  if (existing) {
    await BibliotecaPosts.update(post.id, { status: 'gerado_video', video_id: existing.id });
    return { video: existing, created: false, queued: existing.status === 'pendente' };
  }

  let meta = {};
  try {
    meta = await importService.fetchLinkMetadata(post.url);
  } catch {
    meta = { titulo: post.titulo, thumbnail: post.thumbnail };
  }

  const [id] = await Videos.create({
    user_id: userId,
    origem: 'link',
    termo_busca: `biblioteca:${fonte?.nome || 'fonte'}`.slice(0, 255),
    titulo: meta.titulo || post.titulo || post.url.slice(0, 120),
    url_original: post.url,
    thumbnail: meta.thumbnail || post.thumbnail || null,
    duracao: meta.duracao || null,
    autor: meta.autor || fonte?.nome || null,
    autor_url: meta.autorUrl || fonte?.url || null,
    status: 'pendente',
    metadata: { extractor: meta.extractor, biblioteca_post_id: post.id, fonte_id: fonte?.id },
  });

  const video = await Videos.findById(id);
  importService.queueLinkImport(video);
  await BibliotecaPosts.update(post.id, { status: 'gerado_video', video_id: id });

  return { video, created: true, queued: true };
}

/** Gera e publica imediatamente, ou autoriza o Reel a publicar assim que ficar pronto. */
async function executarPublicacaoDireta({ userId, postId, facebookPageId }) {
  const pageId = Number(facebookPageId || 0);
  if (!pageId) {
    const err = new Error('Selecione a Página do Facebook antes de publicar');
    err.status = 400;
    throw err;
  }
  const page = await resolvePage(userId, pageId);
  if (!page) {
    const err = new Error('Página do Facebook inválida');
    err.status = 400;
    throw err;
  }

  const post = await BibliotecaPosts.findById(postId);
  if (!post || Number(post.user_id) !== Number(userId)) {
    const err = new Error('Post não encontrado');
    err.status = 404;
    throw err;
  }
  const fonte = await BibliotecaFontes.findById(post.fonte_id);
  const isInstagramVideo =
    fonte?.plataforma === 'instagram' &&
    (post.media_type === 'video' ||
      /instagram\.com\/(reel|reels|tv)\//i.test(String(post.url || '')));

  // Requisição repetida após publicação: responde sem criar matéria/publicação duplicada.
  if (post.matter_id) {
    const AiMatters = require('../models/AiMatters');
    const existingMatter = await AiMatters.findById(post.matter_id);
    if (existingMatter?.status === 'publicado') {
      return {
        modo: existingMatter.tipo_publicacao === 'reel' ? 'reel' : 'foto',
        published: true,
        alreadyPublished: true,
        queued: false,
        matterId: existingMatter.id,
        message: 'Este conteúdo já foi publicado.',
      };
    }
  }

  // Também bloqueia se a mesma URL/título já saiu em outra matéria publicada
  try {
    await assertPostNaoPublicado(userId, post);
  } catch (err) {
    if (err.status === 409) {
      return {
        modo: 'foto',
        published: true,
        alreadyPublished: true,
        queued: false,
        matterId: post.matter_id || null,
        message: err.message,
      };
    }
    throw err;
  }

  if (isInstagramVideo) {
    const result = await gerarVideoDePost({
      userId,
      postId: post.id,
      facebookPageId: page.id,
    });
    if (!result.video?.id || !result.matter?.id) {
      const err = new Error('Não foi possível vincular o vídeo e a matéria do Reel');
      err.status = 422;
      throw err;
    }

    const reelPublisher = require('./bibliotecaReelAutopilotService');
    await reelPublisher.habilitarPublicacaoQuandoPronto({
      videoId: result.video.id,
      matterId: result.matter.id,
      bibliotecaPostId: post.id,
      facebookPageId: page.id,
      origem: 'manual',
    });
    const ready = await reelPublisher.publicarSePronto({
      videoId: result.video.id,
      clipId: result.clip?.id || null,
      matterId: result.matter.id,
    });

    return {
      modo: 'reel',
      published: Boolean(ready.published),
      alreadyPublished: Boolean(ready.alreadyPublished),
      queued: !ready.published,
      matterId: result.matter.id,
      message: ready.published
        ? 'Reel publicado no Facebook.'
        : 'Reel em processamento. Ele será publicado automaticamente quando a transcrição, a matéria e a capa ficarem prontas.',
    };
  }

  const gerado = await gerarTextoDePost({
    userId,
    postId: post.id,
    facebookPageId: page.id,
    tipoPublicacao: 'foto',
    publicarAgora: true,
  });
  const published = Boolean(
    gerado.publication || gerado.fbPostUrl || gerado.matter?.status === 'publicado'
  );
  return {
    modo: 'foto',
    published,
    queued: false,
    matterId: gerado.matter?.id || null,
    fbPostUrl: gerado.fbPostUrl || null,
    avisos: gerado.avisos || [],
    message: published
      ? 'Conteúdo publicado no Facebook.'
      : 'A matéria foi preparada, mas não foi publicada. Verifique os avisos da imagem/capa.',
  };
}

async function publicarPostDireto(options) {
  const key = `${Number(options?.userId || 0)}:${Number(options?.postId || 0)}`;
  if (directPublishingPosts.has(key)) {
    const err = new Error('Este conteúdo já está sendo preparado para publicação');
    err.status = 409;
    throw err;
  }
  directPublishingPosts.add(key);
  try {
    return await executarPublicacaoDireta(options);
  } finally {
    directPublishingPosts.delete(key);
  }
}

async function tickBrightDataSnapshots() {
  if (brightDataTickRunning) return;
  brightDataTickRunning = true;

  try {
    const brightdata = require('./brightdataInstagram');
    if (!brightdata.isConfigured()) return;

    const fontes = await BibliotecaFontes.findPendingScrapes(20);
    for (const fonte of fontes) {
      const age = scrapeAgeMs(fonte);
      const staleTrigger =
        fonte.scrape_status === 'triggering' && age > BRIGHTDATA_TRIGGER_STALE_MS;

      if (staleTrigger) {
        const message = 'Disparo Bright Data interrompido antes de salvar o snapshot';
        await BibliotecaFontes.updateScrapeIfStatus(fonte.id, 'triggering', {
          scrape_snapshot_id: null,
          scrape_status: 'failed',
          scrape_error: message,
          scrape_silent_first: false,
          ultimo_erro: message,
          ultimo_scan: new Date(),
          proxima_execucao: nextRun(fonte.intervalo_minutos),
        });
        continue;
      }

      if (fonte.scrape_status !== 'pending' || !fonte.scrape_snapshot_id) continue;
      const snapshotId = fonte.scrape_snapshot_id;

      try {
        const handle = fonte.handle || extrairHandle(fonte.url, 'instagram');
        // Faz uma consulta final antes de expirar, evitando abandonar resultado tardio.
        const result = await brightdata.obterResultado(snapshotId, handle);
        if (result.status === 'pending') {
          if (age > BRIGHTDATA_SNAPSHOT_MAX_AGE_MS) {
            const message = 'Snapshot Bright Data não concluiu em 30 minutos';
            await BibliotecaFontes.updateScrapeIfCurrent(fonte.id, snapshotId, {
              scrape_snapshot_id: null,
              scrape_status: 'failed',
              scrape_error: message,
              scrape_silent_first: false,
              ultimo_erro: message,
              ultimo_scan: new Date(),
              proxima_execucao: nextRun(fonte.intervalo_minutos),
            });
          } else if (result.error) {
            await BibliotecaFontes.updateScrapeIfCurrent(fonte.id, snapshotId, {
              scrape_error: String(result.error).slice(0, 1000),
            });
          }
          continue;
        }

        if (result.status === 'failed') {
          throw new Error(`Snapshot Bright Data falhou: ${result.error}`);
        }

        const salvo = await salvarItensFonte(fonte, result.posts, {
          silentFirst: Boolean(fonte.scrape_silent_first),
        });
        const completed = await BibliotecaFontes.updateScrapeIfCurrent(fonte.id, snapshotId, {
          scrape_snapshot_id: null,
          scrape_status: null,
          scrape_requested_at: null,
          scrape_error: null,
          scrape_silent_first: false,
        });
        if (completed) {
          console.log(
            `[brightdata-ig] @${handle}: ${salvo.itens} post(s), ${salvo.novos?.length || salvo.salvos || 0} novo(s) salvos`
          );
        }
      } catch (err) {
        console.error(`[brightdata-ig] fonte #${fonte.id}:`, err.message);
        await BibliotecaFontes.updateScrapeIfCurrent(fonte.id, snapshotId, {
          scrape_snapshot_id: null,
          scrape_status: 'failed',
          scrape_error: String(err.message || err).slice(0, 1000),
          scrape_silent_first: false,
          ultimo_erro: String(err.message || err).slice(0, 1000),
          ultimo_scan: new Date(),
          proxima_execucao: nextRun(fonte.intervalo_minutos),
        });
      }
    }
  } finally {
    brightDataTickRunning = false;
  }
}

async function tickFontes() {
  const due = await BibliotecaFontes.findDue();
  const userIds = new Set();
  for (const fonte of due) {
    if (fonte.user_id) userIds.add(Number(fonte.user_id));
    try {
      await escanearFonte(fonte, { silentFirst: true });
    } catch (err) {
      console.error(`[biblioteca] fonte #${fonte.id}:`, err.message);
      await BibliotecaFontes.update(fonte.id, {
        ultimo_erro: String(err.message || err).slice(0, 1000),
        proxima_execucao: nextRun(fonte.intervalo_minutos),
        ultimo_scan: new Date(),
      });
    }
  }
  // Limpeza de alertas órfãos / duplicados fora do carregamento da página
  for (const uid of userIds) {
    await BibliotecaAlertas.limparOrfaos(uid).catch(() => 0);
    const n = await BibliotecaAlertas.limparDuplicados(uid).catch(() => 0);
    if (n > 0) console.log(`[biblioteca] user #${uid}: removidos ${n} alerta(s) duplicado(s)`);
  }
}

async function salvarRankingViral(userId, ranking) {
  await BibliotecaPosts.clearViralRanking(userId);
  const analyzedAt = new Date();
  for (const item of ranking || []) {
    await BibliotecaPosts.saveViralRanking(item.id, {
      score: item.score,
      reason: item.motivo,
      analyzedAt,
      tituloPt: item.titulo_pt || null,
    });
  }
}

async function listarMelhoresParaPublicar(userId, limit = 30) {
  const lista = await BibliotecaPosts.findMelhoresPublicacao(userId, limit, 50);
  return filtrarPostsNaoPublicados(userId, lista);
}

async function ocultarMelhorParaPublicar(userId, postId) {
  const post = await BibliotecaPosts.findById(postId);
  if (!post || Number(post.user_id) !== Number(userId)) {
    const err = new Error('Sugestão não encontrada');
    err.status = 404;
    throw err;
  }
  await BibliotecaPosts.clearViralRankingPost(userId, postId);
  return listarMelhoresParaPublicar(userId, 30);
}

async function escanearFontesDoUsuario(userId, { silentFirst = false, concorrencia = 3 } = {}) {
  const fontes = await BibliotecaFontes.findByUser(userId);
  const ativas = (fontes || []).filter((f) => f.monitorar !== false && f.monitorar !== 0);
  const resultado = {
    fontes: ativas.length,
    escaneadas: 0,
    novas: 0,
    pendentes: 0,
    erros: [],
  };
  if (!ativas.length) return resultado;

  const fila = [...ativas];
  const workers = Math.min(Math.max(1, Number(concorrencia) || 3), fila.length);

  async function worker() {
    while (fila.length) {
      const fonte = fila.shift();
      if (!fonte) break;
      try {
        const r = await escanearFonte(fonte, { silentFirst });
        resultado.escaneadas += 1;
        if (r?.pending) {
          resultado.pendentes += 1;
        } else {
          resultado.novas += Array.isArray(r?.novos) ? r.novos.length : Number(r?.salvos || 0);
        }
      } catch (err) {
        resultado.erros.push(`${fonte.nome || fonte.url}: ${err.message || err}`);
        await BibliotecaFontes.update(fonte.id, {
          ultimo_erro: String(err.message || err).slice(0, 1000),
          proxima_execucao: nextRun(fonte.intervalo_minutos),
          ultimo_scan: new Date(),
        }).catch(() => null);
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return resultado;
}

async function analisarMelhoresParaPublicar(userId, limit = 30) {
  assertDeepseek();
  const quantidade = Math.min(30, Math.max(1, Number(limit) || 30));

  // Sempre varre as fontes antes de remontar a lista
  const scan = await escanearFontesDoUsuario(userId, { silentFirst: false, concorrencia: 3 });

  let candidatos = await BibliotecaPosts.findCandidatosAutopilot(userId, 40);
  candidatos = await filtrarPostsNaoPublicados(userId, candidatos);
  if (!candidatos.length) {
    await BibliotecaPosts.clearViralRanking(userId);
    return { melhores: [], scan };
  }

  const ranking = await ranquearPostsViralFacebook(
    candidatos.map((post) => ({
      id: post.id,
      fonte_id: post.fonte_id,
      titulo: post.titulo,
      resumo: post.resumo,
      fonte: post.fonte_nome,
      plataforma: post.fonte_plataforma,
      tipo_midia: post.media_type,
      status: post.status,
      publicado_em: post.publicado_em,
      created_at: post.created_at,
    })),
    quantidade
  );
  await salvarRankingViral(userId, ranking);
  const melhores = await listarMelhoresParaPublicar(userId, quantidade);
  return { melhores, scan };
}

async function dashboardUsuario(userId) {
  const Users = require('../models/Users');
  const user = await Users.findById(userId);
  // Limpa duplicatas já gravadas (mesmo post / mesmo título) antes de listar
  await BibliotecaAlertas.limparDuplicados(userId).catch(() => 0);
  const alertasKeywords = String(user?.biblioteca_alertas_keywords || '').trim();
  const hasKeywords = alertasKeywords.length > 0;

  // Alertas: sem filtro SQL pesado. Com keywords, um pool recente + filtro em JS.
  const [fontes, postsPorFonte, alertasNaoLidosRows, alertasLidosRows, alertasForaRows, autopilot] =
    await Promise.all([
      BibliotecaFontes.findByUser(userId),
      BibliotecaPosts.countsByUser(userId),
      BibliotecaAlertas.findByUser(userId, {
        apenasNaoLidos: true,
        limit: hasKeywords ? 200 : 50,
        keywords: hasKeywords ? alertasKeywords : null,
      }),
      hasKeywords
        ? BibliotecaAlertas.findByUser(userId, {
            apenasLidos: true,
            limit: 80,
            keywords: alertasKeywords,
          })
        : Promise.resolve([]),
      hasKeywords
        ? BibliotecaAlertas.findByUser(userId, {
            apenasNaoLidos: true,
            limit: 80,
            keywords: alertasKeywords,
            excludeKeywords: true,
          })
        : Promise.resolve([]),
      obterAutopilot(userId),
    ]);

  let alertasNaoLidos;
  let alertasLidos;
  let alertasForaNaoLidos = 0;
  let alertasForaLidos = 0;
  if (hasKeywords) {
    const [countKw, countKwLidos, countFora, countForaLidos] = await Promise.all([
      BibliotecaAlertas.countNaoLidos(userId, alertasKeywords),
      BibliotecaAlertas.countLidos(userId, alertasKeywords),
      BibliotecaAlertas.countNaoLidos(userId, alertasKeywords, { excludeKeywords: true }),
      BibliotecaAlertas.countLidos(userId, alertasKeywords, { excludeKeywords: true }),
    ]);
    alertasNaoLidos = Number(countKw?.total || alertasNaoLidosRows.length || 0);
    alertasLidos = Number(countKwLidos?.total || alertasLidosRows.length || 0);
    alertasForaNaoLidos = Number(countFora?.total || alertasForaRows.length || 0);
    alertasForaLidos = Number(countForaLidos?.total || 0);
  } else {
    const [countRow, countLidosRow] = await Promise.all([
      BibliotecaAlertas.countNaoLidos(userId, null),
      BibliotecaAlertas.countLidos(userId, null),
    ]);
    alertasNaoLidos = Number(countRow?.total || 0);
    alertasLidos = Number(countLidosRow?.total || 0);
  }

  const fontesComContagem = (fontes || []).map((f) => ({
    ...f,
    posts_count: Number(postsPorFonte[Number(f.id)] || 0),
  }));
  return {
    fontes: fontesComContagem,
    alertas: hasKeywords ? alertasNaoLidosRows.slice(0, 50) : alertasNaoLidosRows,
    alertasFora: hasKeywords ? alertasForaRows.slice(0, 40) : [],
    alertasNaoLidos,
    alertasLidos,
    alertasForaNaoLidos,
    alertasForaLidos,
    alertasKeywords,
    autopilot,
  };
}

async function detalheFonte(userId, fonteId) {
  const fonte = await BibliotecaFontes.findById(fonteId);
  if (!fonte || Number(fonte.user_id) !== Number(userId)) {
    const err = new Error('Fonte não encontrada');
    err.status = 404;
    throw err;
  }
  const [posts, countRow, indice] = await Promise.all([
    BibliotecaPosts.findByFonte(fonte.id, 80),
    BibliotecaPosts.countByFonte(fonte.id),
    carregarIndiceJaPublicados(userId),
  ]);
  const postsEnriquecidos = (posts || []).map((p) => {
    const jaPublicado = Boolean(
      p.matter_status === 'publicado' ||
        p.matter_publication_id ||
        postJaFoiPublicado(p, indice)
    );
    return { ...p, ja_publicado: jaPublicado };
  });
  return {
    fonte: { ...fonte, posts_count: Number(countRow?.total || 0) },
    posts: postsEnriquecidos,
  };
}

async function detalhePost(userId, postId) {
  const post = await BibliotecaPosts.findById(postId);
  if (!post || Number(post.user_id) !== Number(userId)) {
    const err = new Error('Post não encontrado');
    err.status = 404;
    throw err;
  }
  const fonte = post.fonte_id ? await BibliotecaFontes.findById(post.fonte_id) : null;
  if (fonte && Number(fonte.user_id) !== Number(userId)) {
    const err = new Error('Post não encontrado');
    err.status = 404;
    throw err;
  }
  return { post, fonte: fonte || null };
}

async function obterAutopilot(userId) {
  let row = await BibliotecaAutopilot.findByUser(userId);
  if (!row) {
    const [id] = await BibliotecaAutopilot.create({
      user_id: userId,
      facebook_page_id: null,
      ativo: false,
      intervalo_minutos: 30,
      posts_por_ciclo: 1,
      tipo_publicacao: 'foto',
      modo: 'aguardar_aprovacao',
      somente_sites: true,
      proxima_execucao: null,
      total_publicados: 0,
      total_gerados: 0,
    });
    row = await BibliotecaAutopilot.findById(id);
  }
  return {
    ...row,
    modo: normalizeAutopilotModo(row.modo, 'publicar'),
    somente_sites: Boolean(row.somente_sites) || normalizeAutopilotModo(row.modo) === 'aguardar_aprovacao',
    total_gerados: Number(row.total_gerados || 0),
  };
}

async function salvarAutopilot(userId, body = {}) {
  const atual = await obterAutopilot(userId);
  const ativo =
    body.ativo === true || body.ativo === '1' || body.ativo === 'on' || body.ativo === 1;
  const intervalo = clampAutopilotInterval(body.intervalo_minutos ?? body.intervaloMinutos ?? atual.intervalo_minutos);
  const postsPorCiclo = clampAutopilotPosts(body.posts_por_ciclo ?? body.postsPorCiclo ?? atual.posts_por_ciclo);
  const modo = normalizeAutopilotModo(
    body.modo ?? body.mode ?? atual.modo,
    'aguardar_aprovacao'
  );
  let somenteSites =
    body.somente_sites === true ||
    body.somente_sites === '1' ||
    body.somente_sites === 'on' ||
    body.somenteSites === true ||
    body.somenteSites === '1';
  if (body.somente_sites === false || body.somente_sites === '0' || body.somenteSites === false) {
    somenteSites = false;
  } else if (
    body.somente_sites == null &&
    body.somenteSites == null
  ) {
    somenteSites = Boolean(atual.somente_sites);
  }
  // Aguardar aprovação = sempre só sites da biblioteca
  if (modo === 'aguardar_aprovacao') somenteSites = true;

  let facebookPageId = body.facebook_page_id ?? body.facebookPageId;
  if (facebookPageId === '' || facebookPageId === undefined) {
    facebookPageId = atual.facebook_page_id;
  } else if (facebookPageId == null) {
    facebookPageId = null;
  } else {
    facebookPageId = Number(facebookPageId);
  }

  if (ativo) {
    if (!facebookPageId) {
      const err = new Error('Selecione uma Página do Facebook para ativar o piloto automático');
      err.status = 400;
      throw err;
    }
    const page = await resolvePage(userId, facebookPageId);
    if (!page) {
      const err = new Error('Página do Facebook inválida');
      err.status = 400;
      throw err;
    }
    facebookPageId = page.id;
  }

  const patch = {
    ativo: Boolean(ativo),
    facebook_page_id: facebookPageId || null,
    intervalo_minutos: intervalo,
    posts_por_ciclo: postsPorCiclo,
    tipo_publicacao: 'foto',
    modo,
    somente_sites: Boolean(somenteSites),
    ultimo_erro: null,
  };

  // Ao ativar (ou reativar), agenda o próximo ciclo em breve
  if (ativo) {
    const wasOff = !atual.ativo;
    if (wasOff || !atual.proxima_execucao) {
      patch.proxima_execucao = new Date(Date.now() + 60_000);
    }
  } else {
    patch.proxima_execucao = null;
  }

  await BibliotecaAutopilot.update(atual.id, patch);
  return obterAutopilot(userId);
}

/**
 * Gera matéria (foto + Minha marca) em rascunho — autor confirma antes de publicar.
 */
async function gerarRascunhoAutopilot({ userId, post, facebookPageId }) {
  const gerado = await gerarTextoDePost({
    userId,
    postId: post.id,
    facebookPageId,
    tipoPublicacao: 'foto',
    publicarAgora: false,
  });
  return {
    gerado,
    matterId: gerado.matter?.id || null,
    status: gerado.matter?.status || 'rascunho',
  };
}

/**
 * Gera e publica uma matéria a partir de um post (piloto — foto + Minha marca).
 */
async function publicarPostAutopilot({ userId, post, facebookPageId }) {
  const fonte = await BibliotecaFontes.findById(post.fonte_id);
  const instagramVideo =
    fonte?.plataforma === 'instagram' &&
    (post.media_type === 'video' || /instagram\.com\/(reel|reels|tv)\//i.test(String(post.url)));

  if (instagramVideo) {
    const reel = await materiaIaService.gerarDeLink({
      userId,
      url: post.url,
      facebookPageId,
      tipoPublicacao: 'reel',
      status: 'rascunho',
    });
    if (!reel.video?.id || !reel.matter?.id) {
      throw new Error('O pipeline do Reel não retornou vídeo e matéria vinculados');
    }

    const reelAutopilot = require('./bibliotecaReelAutopilotService');
    await reelAutopilot.habilitarPublicacaoAutomatica({
      videoId: reel.video.id,
      matterId: reel.matter.id,
      bibliotecaPostId: post.id,
      facebookPageId,
    });
    const ready = await reelAutopilot.publicarSePronto({
      videoId: reel.video.id,
      clipId: reel.clip?.id || null,
      matterId: reel.matter.id,
    });
    return {
      gerado: reel,
      publicado: Boolean(ready.published),
      enfileirado: !ready.published,
      contabilizado: Boolean(ready.published),
    };
  }

  const topico = {
    titulo: post.titulo,
    link: post.url,
    resumo: post.resumo,
    nicho: fonte?.nome || fonte?.plataforma || 'rede social',
    fonte: fonte?.nome,
    veiculo: fonte?.plataforma,
    imagemFonte: post.thumbnail,
    redeSocial: true,
    tipoFonte: 'rede_social',
  };

  const gerado = await materiaIaService.gerarCompleto({
    userId,
    facebookPageId,
    topico,
    tipoPublicacao: 'foto',
    status: 'publicado',
  });

  await BibliotecaPosts.update(post.id, {
    status: 'gerado_texto',
    matter_id: gerado.matter?.id || null,
  });

  const publicado = Boolean(gerado.publication || gerado.fbPostUrl || gerado.matter?.status === 'publicado');
  return { gerado, publicado, enfileirado: false };
}

async function tickAutopilot() {
  const due = await BibliotecaAutopilot.findDue();
  for (const cfg of due) {
    try {
      if (!cfg.facebook_page_id) {
        await BibliotecaAutopilot.update(cfg.id, {
          ativo: false,
          ultimo_erro: 'Piloto desativado: página do Facebook não configurada',
          proxima_execucao: null,
        });
        continue;
      }

      const page = await resolvePage(cfg.user_id, cfg.facebook_page_id);
      if (!page) {
        await BibliotecaAutopilot.update(cfg.id, {
          ativo: false,
          ultimo_erro: 'Piloto desativado: página do Facebook inválida',
          proxima_execucao: null,
        });
        continue;
      }

      const qtd = clampAutopilotPosts(cfg.posts_por_ciclo);
      const proxima = nextAutopilotRun(cfg.intervalo_minutos);
      const aguardar = isAutopilotAguardar(cfg);
      const somenteSites = isAutopilotSomenteSites(cfg);

      // Retoma Reels só no modo publicar (e quando não está restrito a sites).
      let retomados = 0;
      if (!aguardar && !somenteSites) {
        const reelAutopilot = require('./bibliotecaReelAutopilotService');
        retomados = await reelAutopilot.publicarPendentesDoUsuario(cfg.user_id, qtd);
        if (retomados >= qtd) {
          await BibliotecaAutopilot.update(cfg.id, {
            ultimo_tick: new Date(),
            proxima_execucao: proxima,
            ultimo_erro: null,
          });
          continue;
        }
      }

      assertDeepseek();

      const candidatosBrutos = await BibliotecaPosts.findCandidatosAutopilot(cfg.user_id, 30);
      let candidatos = await filtrarPostsNaoPublicados(cfg.user_id, candidatosBrutos);
      candidatos = filtrarCandidatosPorPlataforma(candidatos, cfg);

      if (!candidatos.length) {
        await BibliotecaAutopilot.update(cfg.id, {
          ultimo_tick: new Date(),
          proxima_execucao: proxima,
          ultimo_erro: null,
        });
        if (somenteSites) {
          console.log(
            `[biblioteca-autopilot] user #${cfg.user_id}: nenhum post de site pendente`
          );
        }
        continue;
      }

      const ranking = await ranquearPostsViralFacebook(
        candidatos.map((p) => ({
          id: p.id,
          fonte_id: p.fonte_id,
          titulo: p.titulo,
          resumo: p.resumo,
          fonte: p.fonte_nome,
          plataforma: p.fonte_plataforma,
          tipo_midia: p.media_type,
          status: p.status,
          publicado_em: p.publicado_em,
          created_at: p.created_at,
        })),
        qtd
      );

      const byId = new Map(candidatos.map((p) => [Number(p.id), p]));
      let processados = retomados;
      let publicadosNaoContabilizados = 0;
      let geradosAguardando = 0;
      const erros = [];

      const filaIds = ranking.map((r) => r.id);
      for (const c of candidatos) {
        if (!filaIds.includes(Number(c.id))) filaIds.push(Number(c.id));
      }

      for (const postId of filaIds) {
        if (processados >= qtd) break;
        const post = byId.get(Number(postId));
        if (!post) continue;
        try {
          if (aguardar) {
            await gerarRascunhoAutopilot({
              userId: cfg.user_id,
              post,
              facebookPageId: page.id,
            });
            processados += 1;
            geradosAguardando += 1;
          } else {
            const result = await publicarPostAutopilot({
              userId: cfg.user_id,
              post,
              facebookPageId: page.id,
            });
            processados += 1;
            if (result.publicado && !result.contabilizado) {
              publicadosNaoContabilizados += 1;
            } else if (!result.publicado && !result.enfileirado) {
              erros.push(`#${post.id}: gerado sem publicação (verifique imagem/arte)`);
            }
          }
        } catch (err) {
          const duplicata = err.status === 409 || /já existe matéria|já virou matéria|duplic/i.test(err.message || '');
          erros.push(`#${post.id}: ${err.message}`);
          try {
            await BibliotecaPosts.update(post.id, {
              status: duplicata ? 'ignorado' : 'visto',
            });
          } catch {
            /* ignore */
          }
          if (duplicata) {
            console.log(
              `[biblioteca-autopilot] user #${cfg.user_id}: post #${post.id} ignorado (assunto já gerado)`
            );
          }
        }
      }

      if (geradosAguardando) {
        await BibliotecaAutopilot.incrementGeneratedByUser(cfg.user_id, geradosAguardando);
        console.log(
          `[biblioteca-autopilot] user #${cfg.user_id}: ${geradosAguardando} rascunho(s) de site aguardando aprovação`
        );
      }
      if (publicadosNaoContabilizados) {
        await BibliotecaAutopilot.incrementPublishedByUser(
          cfg.user_id,
          publicadosNaoContabilizados
        );
      }

      await BibliotecaAutopilot.update(cfg.id, {
        ultimo_tick: new Date(),
        proxima_execucao: proxima,
        ultimo_erro: erros.length ? erros.slice(0, 3).join(' | ').slice(0, 1000) : null,
      });
    } catch (err) {
      console.error(`[biblioteca-autopilot] user #${cfg.user_id}:`, err.message);
      await BibliotecaAutopilot.update(cfg.id, {
        ultimo_erro: String(err.message || err).slice(0, 1000),
        proxima_execucao: nextAutopilotRun(cfg.intervalo_minutos),
      });
    }
  }
}

module.exports = {
  detectarPlataforma,
  criarFonte,
  encontrarFontePorUrl,
  atualizarFonte,
  escanearAgora,
  gerarTextoDePost,
  gerarVideoDePost,
  publicarPostDireto,
  tickBrightDataSnapshots,
  tickFontes,
  tickAutopilot,
  dashboardUsuario,
  detalheFonte,
  detalhePost,
  listarMelhoresParaPublicar,
  analisarMelhoresParaPublicar,
  escanearFontesDoUsuario,
  ocultarMelhorParaPublicar,
  obterAutopilot,
  salvarAutopilot,
  resolvePage,
  filtrarPostsNaoPublicados,
};
