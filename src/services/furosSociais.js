const path = require('path');
const { spawn } = require('child_process');

/**
 * Furos do dia vindos das redes:
 * - YouTube: busca vídeos recentes do nicho (filtro "hoje"/"esta semana"),
 *   com visualizações entrando na nota;
 * - Instagram e Facebook: posts que a Biblioteca já coletou das páginas e
 *   perfis monitorados, com o engajamento de cada um. Não faz busca nova com
 *   a conta do Instagram — buscar por conta própria foi o que derrubou a
 *   sessão antes.
 *
 * Todo item sai no mesmo formato das notícias do Furos, com `canal`.
 */

const SCRIPT_BUSCA_YOUTUBE = path.resolve(__dirname, '../../scripts/youtube-busca-recentes.mjs');
const CANAIS_SOCIAIS = ['youtube', 'instagram', 'facebook'];
/** Vídeo longo raramente é notícia e a transcrição demora demais. */
const MAX_DURACAO_MIN = 20;

/** "410.330 visualizações", "12 mil visualizações", "1,2 mi de visualizações" → número. */
function numeroDeViews(texto) {
  const t = String(texto || '').toLowerCase().replace(/\s+/g, ' ');
  if (!t || /nenhuma|no views/.test(t)) return 0;
  const m = t.match(/([\d.,]+)\s*(mil|mi|bi|k|m|b)?\b/);
  if (!m) return 0;
  const multiplicador = { mil: 1e3, k: 1e3, mi: 1e6, m: 1e6, bi: 1e9, b: 1e9 }[m[2]] || 1;
  const numero = multiplicador === 1
    ? Number(m[1].replace(/[.,]/g, ''))
    : Number(m[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(numero) ? Math.round(numero * multiplicador) : 0;
}

/** "há 23 h", "há 2 horas", "há 1 dia", "3 hours ago" → horas atrás (ou null). */
function horasAtras(texto) {
  const t = String(texto || '').toLowerCase();
  const m = t.match(/(\d+)\s*(segundos?|minutos?|min|horas?|h\b|dias?|semanas?|m[eê]s(?:es)?|anos?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2];
  if (/^seg|^second/.test(u)) return n / 3600;
  if (/^min/.test(u)) return n / 60;
  if (/^h/.test(u)) return n;
  if (/^dia|^day/.test(u)) return n * 24;
  if (/^semana|^week/.test(u)) return n * 168;
  if (/^m[eê]s|^month/.test(u)) return n * 720;
  return n * 8760;
}

/** "8:52" → 8.9 min; "1:10:08" → 70 min. */
function duracaoMinutos(texto) {
  const partes = String(texto || '').split(':').map(Number);
  if (!partes.length || partes.some((p) => !Number.isFinite(p))) return null;
  return partes.reduce((total, p) => total * 60 + p, 0) / 60;
}

function formatarViews(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',').replace(',0', '')} mi views`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} mil views`;
  return `${n} views`;
}

/**
 * Nota do item social: gatilhos e atualidade do Furos + alcance real
 * (visualizações no YouTube, engajamento medido na Biblioteca).
 */
function pontuarSocial(item, pontuarBomba, agora = Date.now()) {
  const base = pontuarBomba(item, agora);
  let pontos = base.score;
  const motivos = [...base.motivos];
  const views = Number(item.views) || 0;
  if (views >= 200_000) pontos += 30;
  else if (views >= 50_000) pontos += 24;
  else if (views >= 10_000) pontos += 16;
  else if (views >= 2_000) pontos += 8;
  if (views >= 2_000) motivos.unshift(formatarViews(views));
  const viral = Number(item.viralScore) || 0;
  if (viral) {
    pontos += Math.round(viral * 0.35);
    if (viral >= 60) motivos.unshift('Engajamento alto');
  }
  return { score: Math.max(0, Math.min(100, Math.round(pontos))), motivos: motivos.slice(0, 4) };
}

function cookieDoYoutube() {
  try {
    const { cookieHeaderDoYoutube } = require('./feedSugeridoColetor');
    return typeof cookieHeaderDoYoutube === 'function' ? cookieHeaderDoYoutube() : '';
  } catch {
    return '';
  }
}

async function rodarBuscaYoutube(entrada, timeoutMs = 90_000) {
  const youtubeLimiter = require('./youtubeLimiter');
  // Em pausa por bloqueio do YouTube: nem tenta (ver youtubeLimiter).
  try {
    await youtubeLimiter.esperarVez();
  } catch (err) {
    return { itens: [], erro: err.message };
  }
  const resultado = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_BUSCA_YOUTUBE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve({ itens: [], erro: 'o YouTube demorou demais' });
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      if (stdout.length < 800_000) stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < 2_000) stderr += c.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ itens: [], erro: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ itens: [], erro: stderr.trim().split('\n')[0] || `código ${code}` });
      try {
        resolve(JSON.parse(stdout.trim() || '{"itens":[]}'));
      } catch (err) {
        resolve({ itens: [], erro: err.message });
      }
    });
    child.stdin.end(JSON.stringify({ ...entrada, cookie: cookieDoYoutube(), intervaloMs: Math.min(youtubeLimiter.INTERVALO_MS, 3_000) }));
  });
  if (resultado.erro) youtubeLimiter.registrarFalha(new Error(resultado.erro));
  else if ((resultado.itens || []).length) youtubeLimiter.registrarSucesso();
  return resultado;
}

/**
 * @param {{ consultas: Array<{ consulta: string, nicho: string }>, horas: number, limitePorConsulta?: number }} opts
 */
/**
 * Mesma busca em 30 min (piloto a cada 5 min, editor clicando de novo)
 * reaproveita o resultado em vez de consultar o YouTube outra vez: o
 * YouTube limita por IP e a busca do piloto era a maior parte do volume.
 * Ajustável: YOUTUBE_BUSCA_CACHE_MIN.
 */
const CACHE_YOUTUBE_MS = Math.max(1, Number(process.env.YOUTUBE_BUSCA_CACHE_MIN) || 30) * 60 * 1000;
const cacheYoutube = new Map();

function buscaYoutubeComCache(entrada) {
  const chave = JSON.stringify([[...entrada.consultas].sort(), entrada.periodo, entrada.limite]);
  const guardado = cacheYoutube.get(chave);
  if (guardado && guardado.expiraEm > Date.now()) return guardado.promessa;
  const promessa = rodarBuscaYoutube(entrada).then((resultado) => {
    // Falha não fica guardada: a próxima busca tenta de novo.
    if (resultado.erro && !(resultado.itens || []).length) cacheYoutube.delete(chave);
    return resultado;
  });
  cacheYoutube.set(chave, { promessa, expiraEm: Date.now() + CACHE_YOUTUBE_MS });
  for (const [k, v] of cacheYoutube) if (v.expiraEm <= Date.now()) cacheYoutube.delete(k);
  return promessa;
}

async function buscarYoutube({ consultas, horas, limitePorConsulta = 10 }) {
  const nichoDaConsulta = new Map(consultas.map((c) => [c.consulta, c.nicho]));
  const resultado = await buscaYoutubeComCache({
    consultas: consultas.map((c) => c.consulta),
    periodo: horas <= 24 ? 'hoje' : 'semana',
    limite: limitePorConsulta,
  });
  const agora = Date.now();
  const itens = (resultado.itens || [])
    .filter((v) => !/transmitido|streamed/i.test(v.publicado))
    .filter((v) => {
      const min = duracaoMinutos(v.duracao);
      return min == null || min <= MAX_DURACAO_MIN;
    })
    .map((v) => ({ ...v, horas: horasAtras(v.publicado) }))
    .filter((v) => v.horas == null || v.horas <= horas)
    .map((v) => ({
      canal: 'youtube',
      externalId: v.videoId,
      titulo: v.titulo,
      url: v.curto ? `https://www.youtube.com/shorts/${v.videoId}` : `https://www.youtube.com/watch?v=${v.videoId}`,
      veiculo: v.canal || 'YouTube',
      veiculos: [],
      resumo: '',
      imagem: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      data: v.publicado || null,
      dataTimestamp: v.horas != null ? Math.round(agora - v.horas * 3_600_000) : null,
      nicho: nichoDaConsulta.get(v.consulta) || null,
      views: numeroDeViews(v.views),
    }));
  return { itens, erro: resultado.erro || null };
}

/**
 * Posts recentes da Biblioteca (páginas e perfis monitorados) que ainda não
 * viraram matéria, do mais engajado para o menos.
 */
/**
 * Post curto demais não vira matéria.
 *
 * Uma ou duas linhas de legenda não dão base para escrever: não há fato,
 * contexto nem declaração para apurar, e a IA acaba inventando o resto. A
 * exceção é o post com vídeo — aí o texto curto não importa, porque o
 * conteúdo vem da transcrição.
 *
 * A medida ignora link, hashtag, menção e emoji: "Confira! 🔥 #gospel
 * #jesus https://..." tem 50 caracteres e nenhum conteúdo.
 */
const MIN_CARACTERES_POST = Number(process.env.FUROS_MIN_CARACTERES_POST || 180);
const MIN_PALAVRAS_POST = Number(process.env.FUROS_MIN_PALAVRAS_POST || 20);

function temVideoParaTranscrever(linha) {
  if (String(linha.media_type || '').toLowerCase() === 'video') return true;
  if (String(linha.media_url || '').trim()) return true;
  return /\/(reel|reels|videos|watch|tv)\//i.test(String(linha.url || ''));
}

function textoAproveitavel(texto) {
  return String(texto || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#@][\p{L}\p{N}_.]+/gu, ' ')
    .replace(/[\p{Extended_Pictographic}\u200d\uFE0F]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dá para escrever uma matéria a partir deste post? */
function conteudoSuficiente(linha) {
  if (temVideoParaTranscrever(linha)) return true;
  const texto = textoAproveitavel(linha.resumo || linha.titulo);
  if (texto.length < MIN_CARACTERES_POST) return false;
  return texto.split(/\s+/).filter(Boolean).length >= MIN_PALAVRAS_POST;
}

async function buscarBiblioteca({ userId, plataformas, horas, limite = 30 }) {
  if (!userId || !plataformas.length) return { itens: [], descartadosCurtos: 0 };
  const db = require('../config/db');
  const desde = new Date(Date.now() - horas * 3_600_000);
  const linhas = await db('biblioteca_posts as p')
    .join('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
    .where('p.user_id', userId)
    .whereIn('f.plataforma', plataformas)
    .whereNull('p.matter_id')
    .whereIn('p.status', ['novo', 'visto'])
    .whereRaw('COALESCE(p.publicado_em, p.created_at) >= ?', [desde])
    .orderByRaw('COALESCE(p.viral_score, 0) DESC, COALESCE(p.publicado_em, p.created_at) DESC')
    .limit(Math.min(120, limite * 3))
    .select(
      'p.id',
      'p.titulo',
      'p.url',
      'p.resumo',
      'p.thumbnail',
      'p.media_type',
      'p.media_url',
      'p.publicado_em',
      'p.created_at',
      'p.viral_score',
      'f.nome as fonte_nome',
      'f.handle as fonte_handle',
      'f.plataforma'
    );
  const comLink = linhas.filter((l) => /^https?:\/\//i.test(String(l.url || '')));
  const aproveitaveis = comLink.filter(conteudoSuficiente);
  const descartadosCurtos = comLink.length - aproveitaveis.length;
  const itens = aproveitaveis
    .map((l) => {
      const texto = String(l.resumo || l.titulo || '').replace(/\s+/g, ' ').trim();
      const quando = new Date(l.publicado_em || l.created_at).getTime();
      return {
        canal: l.plataforma,
        bibliotecaPostId: l.id,
        titulo: (String(l.titulo || '').trim() || texto || 'Publicação').slice(0, 300),
        url: String(l.url).trim().slice(0, 1000),
        veiculo: String(l.fonte_nome || l.fonte_handle || l.plataforma).trim().slice(0, 120),
        veiculos: [],
        resumo: texto.slice(0, 420),
        imagem: /^https?:\/\//i.test(String(l.thumbnail || '')) ? l.thumbnail : null,
        data: l.publicado_em || l.created_at || null,
        dataTimestamp: Number.isFinite(quando) ? quando : null,
        nicho: null,
        viralScore: Number(l.viral_score) || 0,
      };
    });
  return { itens, descartadosCurtos };
}

/** Tira vídeos/posts que já viraram matéria desta conta (últimos 60 dias). */
async function removerJaUsados(userId, itens) {
  if (!userId || !itens.length) return itens;
  const db = require('../config/db');
  const chave = (item) => (item.canal === 'youtube' ? item.externalId : null) || item.url;
  const chaves = [...new Set(itens.map(chave).filter(Boolean))].slice(0, 80);
  try {
    const desde = new Date(Date.now() - 60 * 24 * 3_600_000);
    const usadas = await db('ai_matters')
      .where('user_id', userId)
      .where('created_at', '>=', desde)
      .where(function porFonte() {
        for (const c of chaves) this.orWhere('fonte_url', 'like', `%${c.replace(/[%_]/g, '')}%`);
      })
      .select('fonte_url');
    const textos = usadas.map((u) => String(u.fonte_url || ''));
    return itens.filter((item) => {
      const c = chave(item);
      return !c || !textos.some((t) => t.includes(c));
    });
  } catch (err) {
    console.warn('[furos] checar usados:', err.message);
    return itens;
  }
}

/**
 * @param {{ userId: number, canais: string[], consultas: Array<{consulta:string,nicho:string}>, horas: number, limite: number, pontuarBomba: Function }} opts
 * @returns {Promise<{ itens: object[], avisos: string[] }>}
 */
async function buscarFurosSociais({ userId, canais, consultas, horas, limite, pontuarBomba }) {
  const avisos = [];
  const tarefas = [];
  if (canais.includes('youtube') && consultas.length) {
    tarefas.push(buscarYoutube({ consultas, horas }).then((r) => {
      if (r.erro && !r.itens.length) avisos.push(`YouTube: ${r.erro}`);
      return r.itens;
    }));
  }
  const daBiblioteca = canais.filter((c) => ['instagram', 'facebook', 'youtube'].includes(c));
  if (daBiblioteca.length) {
    tarefas.push(
      buscarBiblioteca({ userId, plataformas: daBiblioteca, horas, limite })
        .then((r) => {
          if (r.descartadosCurtos) {
            avisos.push(
              `${r.descartadosCurtos} post(s) sem texto suficiente para virar matéria foram ignorados.`
            );
          }
          for (const rede of ['instagram', 'facebook'].filter((c) => daBiblioteca.includes(c))) {
            if (!r.itens.some((i) => i.canal === rede)) {
              const nome = rede === 'instagram' ? 'Instagram' : 'Facebook';
              avisos.push(`${nome}: nenhum post novo das páginas monitoradas nas últimas ${horas}h (adicione perfis em Biblioteca)`);
            }
          }
          return r.itens;
        })
        .catch((err) => {
          avisos.push(`Biblioteca: ${err.message}`);
          return [];
        })
    );
  }
  const brutos = (await Promise.all(tarefas)).flat();

  // O mesmo vídeo pode vir da busca e da Biblioteca.
  const vistos = new Set();
  const unicos = brutos.filter((item) => {
    const chave = item.externalId || item.url;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
  const livres = await removerJaUsados(userId, unicos);
  const agora = Date.now();
  const itens = livres
    .map((item) => ({ ...item, ...pontuarSocial(item, pontuarBomba, agora) }))
    .sort((a, b) => b.score - a.score);
  return { itens, avisos };
}

module.exports = {
  CANAIS_SOCIAIS,
  buscarFurosSociais,
  // O Dots aplica o mesmo corte de post curto demais.
  conteudoSuficiente,
  // exportados para testes
  numeroDeViews,
  horasAtras,
  duracaoMinutos,
  pontuarSocial,
};
