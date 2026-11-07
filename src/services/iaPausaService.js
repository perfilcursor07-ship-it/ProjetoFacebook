const db = require('../config/db');

/**
 * "Parar IA" (página /claude). O administrador pausa tudo ou só alguns
 * modelos; enquanto isso, toda chamada de IA recebe MENSAGEM em vez de gastar
 * créditos. A checagem fica nos pontos de entrada (gateway, DeepSeek, API do
 * Claude e imagem no ChatGPT), então vale para o chat, o editor e o piloto.
 *
 * Hugging Face (texto e o Qwen de imagem) fica fora do "Parar tudo": é a conta
 * PRO separada que segue escrevendo quando os outros créditos acabam. Só para
 * se o administrador pausar aquele modelo do HF na lista.
 */

const TABELA = 'ia_pausa';
const MENSAGEM = 'Créditos acabaram, por favor compre mais crédito na API.';
const CACHE_MS = 10_000;

let cache = null;

function tabelaAusente(err) {
  return err?.code === 'ER_NO_SUCH_TABLE' || /no such table|doesn't exist/i.test(String(err?.message || ''));
}

function lerLista(texto) {
  try {
    const lista = JSON.parse(texto || '[]');
    return Array.isArray(lista) ? lista.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function estado() {
  if (cache && cache.expiraEm > Date.now()) return cache.valor;
  let valor = { geral: false, modelos: [] };
  try {
    const linha = await db(TABELA).orderBy('id').first();
    if (linha) valor = { geral: Boolean(linha.pausado_geral), modelos: lerLista(linha.modelos_pausados) };
  } catch (err) {
    // Sem a migration a IA segue liberada: a pausa nunca pode travar o site.
    if (!tabelaAusente(err)) console.warn('[ia-pausa] leitura falhou:', err.message);
  }
  cache = { valor, expiraEm: Date.now() + CACHE_MS };
  return valor;
}

function erroDePausa() {
  const err = new Error(MENSAGEM);
  err.status = 402;
  // Sem `code`: o chat trata erro com code como falha interna e esconde o texto.
  err.iaPausada = true;
  return err;
}

/**
 * Lança o erro de créditos se a IA estiver pausada. `modelo` é o id usado na
 * chamada (ex.: "claude-sonnet-5", "gpt-5.6", "deepseek-v4-flash").
 */
async function garantirLiberada(modelo = null) {
  const { geral, modelos } = await estado();
  if (geral || (modelo && modelos.includes(String(modelo)))) throw erroDePausa();
}

/** Só a pausa por modelo, ignorando o "Parar tudo" (usado pelo Hugging Face). */
async function garantirModeloLiberado(modelo) {
  const { modelos } = await estado();
  if (modelo && modelos.includes(String(modelo))) throw erroDePausa();
}

async function salvar({ geral = false, modelos = [], userId = null } = {}) {
  const lista = [...new Set((Array.isArray(modelos) ? modelos : [])
    .map((m) => String(m || '').trim())
    .filter((m) => /^[a-z0-9][a-z0-9._:-]{1,119}$/i.test(m)))];
  const dados = {
    pausado_geral: Boolean(geral),
    modelos_pausados: JSON.stringify(lista),
    atualizado_por: userId || null,
    updated_at: db.fn.now(),
  };
  try {
    const linha = await db(TABELA).orderBy('id').first('id');
    if (linha) await db(TABELA).where({ id: linha.id }).update(dados);
    else await db(TABELA).insert(dados);
  } catch (err) {
    if (tabelaAusente(err)) {
      const erro = new Error('A tabela da pausa ainda não existe. Rode "npm run migrate" no servidor.');
      erro.status = 503;
      throw erro;
    }
    throw err;
  }
  cache = null;
  return estado();
}

module.exports = { MENSAGEM, estado, garantirLiberada, garantirModeloLiberado, salvar };
