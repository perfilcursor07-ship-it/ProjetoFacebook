const db = require('../config/db');
const gateway = require('./tokenFreeGatewayService');

/**
 * Modelos que o editor pode escolher no /materia-manual.
 *
 * O administrador marca em /claude quais modelos do Token-Free Gateway ficam
 * disponíveis. Sem nenhuma configuração salva (ou sem a tabela, antes da
 * migration), o comportamento é o de sempre: só o modelo do .env.
 */

const TABELA = 'materia_modelos';
const MODELO_CHATGPT = String(process.env.CHATGPT_IMAGE_MODEL || 'gpt-5.6').trim();
const ID_VALIDO = /^[a-z0-9][a-z0-9._:/-]{1,119}$/i;
const CACHE_MS = 15_000;

let cache = null;

function provedorDoModelo(modelo) {
  const valor = String(modelo || '').toLowerCase();
  if (/^(gpt|o\d|chatgpt)/.test(valor)) return 'chatgpt';
  if (valor.includes('claude')) return 'claude';
  if (valor.includes('deepseek') && !valor.includes('/')) return 'deepseek';
  // Id do Hugging Face vem como dono/modelo ("Qwen/Qwen3-…").
  if (require('./hfChatService').ehModeloHf(valor)) return 'huggingface';
  return 'outro';
}

function nomeModeloHumano(modelo) {
  const valor = String(modelo || '').trim();
  const lower = valor.toLowerCase();
  if (!valor) return 'Modelo IA';
  if (valor.includes('/')) {
    const curto = valor.split('/').pop().replace(/[-_]/g, ' ').replace(/:.*$/, '').trim();
    return `${curto} (HF)`;
  }
  if (lower.includes('claude-sonnet-5')) return 'Sonnet 5';
  if (lower.includes('claude-sonnet')) return 'Sonnet';
  if (lower.includes('claude-haiku')) return 'Haiku';
  if (lower.includes('claude-opus')) return 'Opus';
  if (lower.includes('deepseek-v4')) return 'DeepSeek V4';
  if (lower.includes('deepseek')) return 'DeepSeek';
  const gpt = lower.match(/^gpt-([\w.]+)/);
  if (gpt) return `ChatGPT ${gpt[1]}`;
  return valor
    .replace(/^claude-/i, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letra) => letra.toUpperCase());
}

function descrever(modelo, extra = {}) {
  return {
    id: modelo,
    nome: nomeModeloHumano(modelo),
    provedor: provedorDoModelo(modelo),
    ...extra,
  };
}

function erroDeTabelaAusente(err) {
  return err?.code === 'ER_NO_SUCH_TABLE' || /no such table|doesn't exist/i.test(String(err?.message || ''));
}

async function lerLinhas() {
  try {
    return await db(TABELA).select('modelo', 'habilitado', 'padrao').orderBy('id');
  } catch (err) {
    if (erroDeTabelaAusente(err)) {
      console.warn(`[materia-modelos] tabela ${TABELA} ausente; rode as migrations. Usando só ${gateway.MODELO}.`);
      return [];
    }
    throw err;
  }
}

/** Modelos liberados para o editor, com o padrão primeiro. Nunca vazio. */
async function listarHabilitados() {
  if (cache && cache.expiraEm > Date.now()) return cache.lista;

  const linhas = (await lerLinhas()).filter((linha) => Boolean(linha.habilitado));
  let lista = linhas.map((linha) => descrever(linha.modelo, { padrao: Boolean(linha.padrao) }));
  if (!lista.length) lista = [descrever(gateway.MODELO, { padrao: true })];
  if (!lista.some((item) => item.padrao)) lista[0].padrao = true;
  lista.sort((a, b) => Number(b.padrao) - Number(a.padrao));

  cache = { lista, expiraEm: Date.now() + CACHE_MS };
  return lista;
}

/** Modelo pedido pelo editor, se estiver liberado; senão o padrão. */
async function resolverModelo(pedido, { estrito = false } = {}) {
  const lista = await listarHabilitados();
  const id = String(pedido || '').trim();
  const escolhido = lista.find((item) => item.id === id);
  if (estrito && id && !escolhido) {
    const err = new Error('O modelo escolhido não está mais habilitado. Selecione outro modelo antes de criar as matérias.');
    err.status = 400;
    throw err;
  }
  return (escolhido || lista[0]).id;
}

/**
 * Modelos do "ChatGPT livre". A aba promete a conversa NO ChatGPT, então só
 * entram modelos do ChatGPT — os liberados em /claude e, sem nenhum
 * liberado, o modelo de sempre do ChatGPT (o mesmo da geração de imagem).
 */
async function listarChatgpt() {
  const liberados = (await listarHabilitados()).filter((item) => item.provedor === 'chatgpt');
  if (!liberados.length) return [descrever(MODELO_CHATGPT, { padrao: true })];
  const lista = liberados.map((item, indice) => ({ ...item, padrao: indice === 0 }));
  return lista;
}

/**
 * Modelo que escreve no "ChatGPT livre": o pedido, se for um ChatGPT
 * oferecido; senão o primeiro ChatGPT da lista. Nunca cai em Claude — antes a
 * aba mandava o modelo do seletor geral e quem respondia era o Claude.
 */
async function resolverModeloChatgpt(pedido) {
  const lista = await listarChatgpt();
  const id = String(pedido || '').trim();
  return (lista.find((item) => item.id === id) || lista[0]).id;
}

/**
 * Tudo que o administrador pode marcar: modelos anunciados pelo gateway agora,
 * os conhecidos (Claude do .env e ChatGPT) e os já salvos antes.
 */
async function listarCatalogo() {
  let doGateway = [];
  let gatewayOnline = false;
  try {
    doGateway = (await gateway.listarModelos({ timeout: 3_500 }))
      .map((item) => String(item?.id || '').trim())
      .filter((id) => ID_VALIDO.test(id));
    gatewayOnline = true;
  } catch {
    doGateway = [];
  }

  // Modelos de texto do Hugging Face: aparecem para o administrador marcar,
  // lado a lado com os do gateway. Sem HF_TOKEN a lista vem vazia e nada muda.
  const huggingFaceConfigurado = require('./hfChatService').isConfigured();
  let doHuggingFace = [];
  try {
    doHuggingFace = (await require('./hfChatService').listarModelos({ timeout: 4_000 }))
      .filter((id) => ID_VALIDO.test(id));
  } catch {
    doHuggingFace = [];
  }

  const linhas = await lerLinhas();
  const salvos = new Map(linhas.map((linha) => [linha.modelo, linha]));
  const semConfiguracao = !linhas.some((linha) => linha.habilitado);
  const ids = [...new Set([gateway.MODELO, MODELO_CHATGPT, ...doGateway, ...doHuggingFace, ...salvos.keys()])];

  return {
    gatewayOnline,
    huggingFaceConfigurado,
    modelos: ids.map((id) => {
      const linha = salvos.get(id);
      const provedor = provedorDoModelo(id);
      const disponivel = provedor === 'huggingface'
        ? (huggingFaceConfigurado ? doHuggingFace.includes(id) : false)
        : gatewayOnline
          ? doGateway.includes(id)
          : null;
      return descrever(id, {
        disponivel,
        habilitado: linha ? Boolean(linha.habilitado) : semConfiguracao && id === gateway.MODELO,
        padrao: linha ? Boolean(linha.padrao) : semConfiguracao && id === gateway.MODELO,
      });
    }),
  };
}

async function salvar({ habilitados = [], padrao = null } = {}) {
  const ids = [...new Set((Array.isArray(habilitados) ? habilitados : [])
    .map((id) => String(id || '').trim())
    .filter((id) => ID_VALIDO.test(id)))];
  if (!ids.length) {
    const err = new Error('Habilite pelo menos um modelo para escrever matérias.');
    err.status = 400;
    throw err;
  }
  const idPadrao = ids.includes(String(padrao || '').trim()) ? String(padrao).trim() : ids[0];

  try {
    await db.transaction(async (trx) => {
      await trx(TABELA).update({ habilitado: false, padrao: false, updated_at: trx.fn.now() });
      for (const id of ids) {
        const dados = { habilitado: true, padrao: id === idPadrao, updated_at: trx.fn.now() };
        const atualizados = await trx(TABELA).where({ modelo: id }).update(dados);
        if (!atualizados) await trx(TABELA).insert({ modelo: id, ...dados });
      }
    });
  } catch (err) {
    if (erroDeTabelaAusente(err)) {
      const erro = new Error('A tabela de modelos ainda não existe. Rode "npm run migrate" no servidor.');
      erro.status = 503;
      throw erro;
    }
    throw err;
  }

  cache = null;
  return listarCatalogo();
}

module.exports = {
  listarHabilitados,
  listarCatalogo,
  resolverModelo,
  listarChatgpt,
  resolverModeloChatgpt,
  salvar,
  nomeModeloHumano,
  provedorDoModelo,
};
