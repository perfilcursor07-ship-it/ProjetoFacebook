const db = require('../config/db');
const { env } = require('../config/env');
const ayrshareService = require('./ayrshareService');

/**
 * Páginas x conta Ayrshare atual (a da AYRSHARE_API_KEY do servidor).
 *
 * Ao trocar de conta na Ayrshare, as páginas gravadas com Profile Key da conta
 * antiga passam a falhar com "The Profile Key is invalid". Aqui cada página é
 * conferida contra a conta atual:
 *  - Profile Key válido: ok;
 *  - Profile Key inválido, mas é a Página do Primary Profile (mesmo id ou
 *    nome): a chave velha é apagada e a página passa a publicar pelo Primary;
 *  - sem lugar na conta atual: fica marcada "fora da conta" e some das listas.
 *
 * Se a própria API Key do servidor falhar, nada é marcado (o problema é a
 * chave, não as páginas).
 */

const CACHE_CONTA_MS = 10 * 60_000;
const REVERIFICAR_MS = 30 * 60_000;

let cacheConta = null; // { em, conta }

function provedorAyrshare() {
  const modo = String(env.postpulse?.publishProvider || 'auto').toLowerCase();
  return ayrshareService.isConfigured() && (modo === 'ayrshare' || modo === 'auto');
}

/** Conta atual (Primary Profile), com cache curto. */
async function contaAtual({ forcar = false } = {}) {
  if (!forcar && cacheConta && Date.now() - cacheConta.em < CACHE_CONTA_MS) return cacheConta.conta;
  const conta = await ayrshareService.diagnosticarConta();
  if (conta.ok) cacheConta = { em: Date.now(), conta };
  return conta;
}

function limparCache() {
  cacheConta = null;
}

function normalizarNome(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A página é a do Primary Profile? true / false, ou null quando a Ayrshare
 * não informou nem id nem nome (não dá para afirmar nada).
 */
function ehDoPrimary(page, primary) {
  if (!primary?.facebookConnected) return false;
  const idPrimary = String(primary.facebookPageId || '').trim();
  const nomePrimary = normalizarNome(primary.facebookPageName);
  if (!idPrimary && !nomePrimary) return null;
  if (idPrimary && String(page?.page_id || '').trim() === idPrimary) return true;
  if (nomePrimary && normalizarNome(page?.page_name) === nomePrimary) return true;
  return false;
}

/** Erro da Ayrshare que significa "esse Profile Key não existe nesta conta". */
function profileKeyInvalido(err) {
  const texto = `${err?.message || ''} ${ayrshareService.apiErrorMessage ? ayrshareService.apiErrorMessage(err) : ''}`;
  if (/profile key is invalid|profile-key.*invalid|invalid profile key/i.test(texto)) return true;
  const corpo = err?.response?.data;
  if (Number(corpo?.code) === 144) return true;
  const status = Number(err?.response?.status || err?.status || 0);
  return status === 401 || status === 403;
}

async function gravar(pageId, dados) {
  try {
    await db('facebook_pages').where({ id: pageId }).update({ ...dados, updated_at: db.fn.now() });
  } catch (err) {
    // Migration ainda não rodou: confere, mas não grava.
    if (!/Unknown column|no such column|ER_BAD_FIELD_ERROR/i.test(String(err.message))) throw err;
  }
}

/**
 * Confere uma página contra a conta atual e grava o resultado.
 * Devolve { estado: 'ok'|'fora'|'desconhecido'|'ignorada', curada, motivo }.
 */
async function verificarPagina(page, { forcar = false, agora = Date.now() } = {}) {
  if (!page || !provedorAyrshare()) return { estado: 'ignorada' };
  const verificada = page.ayrshare_verificada_at ? new Date(page.ayrshare_verificada_at).getTime() : 0;
  if (!forcar && verificada && agora - verificada < REVERIFICAR_MS) {
    return { estado: page.ayrshare_fora_da_conta ? 'fora' : 'ok', cache: true, motivo: page.ayrshare_motivo || null };
  }
  const conta = await contaAtual({ forcar });
  if (!conta.ok) return { estado: 'desconhecido', motivo: conta.motivo || null };

  const primary = conta.primary;
  const doPrimary = ehDoPrimary(page, primary);
  const chave = String(page.ayrshare_profile_key || '').trim();
  const dados = {};
  let estado = 'ok';
  let motivo = null;
  let curada = false;

  if (chave) {
    try {
      const perfil = await ayrshareService.fetchProfileByKey(chave);
      if (!perfil.facebookConnected) {
        estado = 'fora';
        motivo = 'O User Profile desta página está sem Facebook conectado na Ayrshare.';
      }
    } catch (err) {
      if (!profileKeyInvalido(err)) return { estado: 'desconhecido', motivo: ayrshareService.apiErrorMessage(err) };
      if (doPrimary === true) {
        dados.ayrshare_profile_key = null;
        curada = true;
      } else {
        estado = 'fora';
        motivo = 'Profile Key de outra conta Ayrshare: esta página não está na conta atual.';
      }
    }
  } else if (doPrimary === false) {
    estado = 'fora';
    motivo = primary?.facebookConnected
      ? `Sem Profile Key e não é a página do Primary Profile (${primary.facebookPageName || 'outra página'}).`
      : 'Sem Profile Key e o Primary Profile da Ayrshare não tem Facebook conectado.';
  }

  await gravar(page.id, {
    ...dados,
    ayrshare_fora_da_conta: estado === 'fora',
    ayrshare_verificada_at: new Date(agora),
    ayrshare_motivo: motivo ? motivo.slice(0, 255) : null,
  });
  if (curada) console.info(`[ayrshare-conta] página #${page.id} “${page.page_name}”: Profile Key da conta antiga removido; publica pelo Primary Profile`);
  if (estado === 'fora' && !page.ayrshare_fora_da_conta) console.info(`[ayrshare-conta] página #${page.id} “${page.page_name}” fora da conta atual: ${motivo}`);
  return { estado, curada, motivo };
}

/** Confere várias (em sequência, poucas chamadas à Ayrshare). */
async function sincronizarPaginas(pages, { forcar = false } = {}) {
  const resumo = { verificadas: 0, fora: [], curadas: [] };
  if (!provedorAyrshare()) return resumo;
  for (const page of pages || []) {
    try {
      const r = await verificarPagina(page, { forcar });
      if (r.estado === 'ignorada' || r.estado === 'desconhecido') continue;
      resumo.verificadas += 1;
      if (r.estado === 'fora') resumo.fora.push({ id: page.id, page_name: page.page_name, motivo: r.motivo });
      if (r.curada) resumo.curadas.push({ id: page.id, page_name: page.page_name });
    } catch (err) {
      console.warn(`[ayrshare-conta] página #${page?.id}:`, err.message);
    }
  }
  return resumo;
}

module.exports = {
  provedorAyrshare,
  contaAtual,
  limparCache,
  ehDoPrimary,
  profileKeyInvalido,
  verificarPagina,
  sincronizarPaginas,
};
