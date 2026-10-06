/**
 * Alterar título de várias matérias de uma vez (/minhas-materias → Rascunhos,
 * Prontas, Erros), antes de publicar ou agendar.
 *
 * Dois passos: `sugerir` só devolve os títulos novos (nada é salvo) para o
 * editor revisar; `aplicar` grava os que ele confirmou e refaz a arte.
 *
 * Modos do `sugerir`:
 * - tom      → a IA escreve um título novo no tom escolhido (polêmico, curiosidade…);
 * - corrigir → o editor digita o título e a IA só corrige o português.
 */

const AiMatters = require('../models/AiMatters');
const { composeMatterArtwork } = require('./matterArtworkService');

const MAX_ITENS = 30;
const STATUS_EDITAVEIS = new Set(['rascunho', 'pronto', 'erro', 'agendado']);

function erro400(mensagem) {
  const err = new Error(mensagem);
  err.status = 400;
  return err;
}

function lerIds(ids) {
  const lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0
  );
  if (!lista.length) throw erro400('Nenhuma matéria selecionada.');
  if (lista.length > MAX_ITENS) throw erro400(`Selecione no máximo ${MAX_ITENS} matérias por vez.`);
  return lista;
}

/** Roda `fn` em cada item com no máximo `limite` chamadas ao mesmo tempo, mantendo a ordem. */
async function emParalelo(itens, limite, fn) {
  const saida = new Array(itens.length);
  let cursor = 0;
  async function worker() {
    while (cursor < itens.length) {
      const i = cursor++;
      // eslint-disable-next-line no-await-in-loop
      saida[i] = await fn(itens[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, worker));
  return saida;
}

async function materiaEditavel(userId, id) {
  const matter = await AiMatters.findById(id);
  if (!matter || Number(matter.user_id) !== Number(userId)) return { erro: 'Matéria não encontrada' };
  if (!STATUS_EDITAVEIS.has(matter.status)) return { erro: 'Matéria já publicada', matter };
  return { matter };
}

/**
 * Gera (sem salvar) o título novo de cada matéria selecionada.
 * @returns {Promise<Array<{id:number, atual:string, titulo:string|null, alterado:boolean, aviso:string|null, erro:string|null}>>}
 */
async function sugerir({ userId, ids, modo, tom, titulos }) {
  const lista = lerIds(ids);
  const modoOk = modo === 'corrigir' ? 'corrigir' : 'tom';
  const digitados = titulos && typeof titulos === 'object' ? titulos : {};

  const deepseek = require('./deepseekService');
  let marcaModeloArte = null;
  if (modoOk === 'tom') {
    deepseek.assertDeepseek('conversa');
    const user = await require('../models/Users').findById(userId);
    marcaModeloArte = user?.marca_modelo_arte || null;
  }
  const { corrigirTitulo } = require('./tituloCorrecaoService');

  return emParalelo(lista, 3, async (id) => {
    const base = { id, atual: '', titulo: null, alterado: false, aviso: null, erro: null };
    try {
      const { matter, erro } = await materiaEditavel(userId, id);
      base.atual = String(matter?.titulo || '').trim();
      if (erro) return { ...base, erro };

      if (modoOk === 'corrigir') {
        const texto = String(digitados[id] ?? digitados[String(id)] ?? '').trim();
        if (!texto) return { ...base, erro: 'Digite o novo título.' };
        const r = await corrigirTitulo(texto);
        return { ...base, titulo: r.titulo, alterado: r.titulo !== base.atual, aviso: r.aviso };
      }

      const r = await deepseek.sugerirTituloMateria({
        tituloAtual: base.atual,
        materia: matter.materia,
        fonteTitulo: matter.fonte_titulo,
        tom,
        evitar: [base.atual].filter(Boolean),
        marcaModeloArte,
        tarefa: 'conversa',
      });
      return { ...base, titulo: r.titulo, alterado: r.titulo !== base.atual };
    } catch (err) {
      // IA pausada em /claude vale para todas: melhor avisar uma vez só.
      if (err.iaPausada) throw err;
      return { ...base, erro: err.message || 'Falha ao gerar título' };
    }
  });
}

/**
 * Grava o título na matéria e refaz a arte (ou a capa do Reel) com ele.
 * Usado pelo "Sugerir título" da tela da matéria e pelo lote.
 * @param {{ userId:number, matter:object, titulo:string, tituloIa?:boolean }} p
 */
async function aplicarTitulo({ userId, matter, titulo, tituloIa = false }) {
  const patch = { titulo, error_message: null };
  if (tituloIa) patch.titulo_ia = titulo;
  if (matter.status !== 'agendado') patch.status = 'rascunho';
  await AiMatters.update(matter.id, patch);

  let updated = await AiMatters.findById(matter.id);
  let imagemUrl = updated.imagem_url || null;
  let videoUrl = null;
  let aviso = null;

  // Reel: regenera capa só se o editor já tinha incluído a capa
  if (updated.tipo_publicacao === 'reel' && updated.video_clip_id) {
    try {
      const VideoClips = require('../models/VideoClips');
      const clipCapa = await VideoClips.findById(updated.video_clip_id);
      const temCapa =
        clipCapa?.capa_status === 'pronta' ||
        (clipCapa?.caminho_arquivo && /_capa_/i.test(String(clipCapa.caminho_arquivo)));
      if (temCapa) {
        const { applyCoverToClipNow } = require('./clipPostProcessService');
        await applyCoverToClipNow({ clipId: updated.video_clip_id, userId, titulo, force: true });
        updated = await AiMatters.findById(matter.id);
        if (updated.video_path) {
          videoUrl = `/media/${String(updated.video_path).replace(/\\/g, '/')}`;
        }
        aviso = 'Novo título aplicado e capa do Reel atualizada (Minha marca) ✓';
      } else {
        aviso = 'Novo título aplicado (capa do Reel continua desmarcada)';
      }
    } catch (err) {
      aviso = `Título atualizado, mas a capa do Reel não foi regenerada: ${err.message}`;
    }
    return { matter: updated, imagemUrl, videoUrl, aviso };
  }

  const sourceUrl =
    updated.imagem_fonte_url ||
    (!updated.imagem_path && /^https?:\/\//i.test(String(updated.imagem_url || ''))
      ? updated.imagem_url
      : null);

  if (sourceUrl) {
    try {
      const artwork = await composeMatterArtwork({
        userId,
        matterId: updated.id,
        sourceUrl,
        title: titulo,
        force: true,
      });
      updated = artwork.matter;
      imagemUrl = artwork.publicUrl;
    } catch (err) {
      aviso = `Título atualizado, mas a arte não foi regenerada: ${err.message}`;
    }
  } else {
    aviso = 'Título atualizado. Para gravar o título na arte, escolha uma imagem e aplique Minha marca.';
  }
  return { matter: updated, imagemUrl, videoUrl, aviso };
}

/**
 * Grava os títulos revisados pelo editor.
 * @param {{ userId:number, itens:Array<{id:number, titulo:string}>, origem?:string }} p
 */
async function aplicar({ userId, itens, origem }) {
  const lista = (Array.isArray(itens) ? itens : [])
    .map((it) => ({ id: Number(it?.id), titulo: String(it?.titulo || '').replace(/\s+/g, ' ').trim() }))
    .filter((it) => Number.isInteger(it.id) && it.id > 0);
  lerIds(lista.map((it) => it.id));

  const resultados = await emParalelo(lista, 2, async ({ id, titulo }) => {
    if (titulo.length < 8) return { id, ok: false, erro: 'Título muito curto' };
    try {
      const { matter, erro } = await materiaEditavel(userId, id);
      if (erro) return { id, ok: false, erro };
      const r = await aplicarTitulo({
        userId,
        matter,
        titulo: titulo.slice(0, 300),
        tituloIa: origem === 'tom',
      });
      return { id, ok: true, titulo: r.matter?.titulo || titulo, aviso: r.aviso };
    } catch (err) {
      return { id, ok: false, erro: err.message || 'Falha ao salvar' };
    }
  });

  return { feitas: resultados.filter((r) => r.ok).length, resultados };
}

module.exports = { sugerir, aplicar, aplicarTitulo };
