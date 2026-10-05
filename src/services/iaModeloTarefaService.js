const db = require('../config/db');

/**
 * Modelo fixo por tarefa (página /claude). O administrador decide, por
 * exemplo, que o piloto automático escreve sempre no ChatGPT 5.6 e os títulos
 * saem do Sonnet 5, independente do que cada editor escolheu no chat.
 * Só vale quando a IA passa pelo Token-Free Gateway (é ele que troca de modelo).
 */

const TABELA = 'ia_modelo_tarefa';
const TAREFAS = Object.freeze({
  piloto: 'Piloto automático (escrever as matérias)',
  titulos: 'Títulos (sugerir e reescrever)',
  // Valor aqui é o gerador (chatgpt, grok, gemini), não um modelo de texto.
  imagem: 'Geração de imagem (Recortar foto da imagem destacada)',
});
const CACHE_MS = 15_000;
let cache = null;

function tabelaAusente(err) {
  return err?.code === 'ER_NO_SUCH_TABLE' || /no such table|doesn't exist/i.test(String(err?.message || ''));
}

async function todos() {
  if (cache && cache.expiraEm > Date.now()) return cache.valor;
  const valor = Object.fromEntries(Object.keys(TAREFAS).map((t) => [t, null]));
  try {
    const linhas = await db(TABELA).select('tarefa', 'modelo');
    for (const l of linhas) if (l.tarefa in valor) valor[l.tarefa] = l.modelo || null;
  } catch (err) {
    if (!tabelaAusente(err)) console.warn('[ia-modelo-tarefa] leitura falhou:', err.message);
  }
  cache = { valor, expiraEm: Date.now() + CACHE_MS };
  return valor;
}

/** Modelo fixado para a tarefa, ou null (segue o comportamento normal). */
async function modeloDaTarefa(tarefa) {
  if (!require('./deepseekService').usarTokenFree('conversa')) return null;
  return (await todos())[tarefa] || null;
}

async function salvar(escolhas = {}, { userId = null, permitidos = [], permitidosPorTarefa = {} } = {}) {
  const validos = new Set(permitidos);
  try {
    for (const tarefa of Object.keys(TAREFAS)) {
      if (!(tarefa in escolhas)) continue;
      const modelo = String(escolhas[tarefa] || '').trim() || null;
      const daTarefa = permitidosPorTarefa[tarefa] ? new Set(permitidosPorTarefa[tarefa]) : validos;
      if (modelo && !daTarefa.has(modelo)) {
        const err = new Error(`Modelo "${modelo}" não está disponível. Escolha um da lista.`);
        err.status = 400;
        throw err;
      }
      const dados = { modelo, atualizado_por: userId, updated_at: db.fn.now() };
      const atual = await db(TABELA).where({ tarefa }).first('id');
      if (atual) await db(TABELA).where({ id: atual.id }).update(dados);
      else await db(TABELA).insert({ tarefa, ...dados });
    }
  } catch (err) {
    if (tabelaAusente(err)) {
      const erro = new Error('A tabela de modelos por tarefa ainda não existe. Rode "npm run migrate" no servidor.');
      erro.status = 503;
      throw erro;
    }
    throw err;
  }
  cache = null;
  return todos();
}

module.exports = { TAREFAS, todos, modeloDaTarefa, salvar };
