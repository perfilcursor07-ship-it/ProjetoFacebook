/**
 * Quem gera a imagem no "Recortar foto da imagem destacada": o gerador
 * escolhido pelo administrador em /claude (tarefa "imagem"). Sem escolha,
 * continua o ChatGPT, como antes.
 */

const GERADORES = Object.freeze({
  chatgpt: 'ChatGPT',
  grok: 'Grok',
  gemini: 'Google Gemini',
});
const PADRAO = 'chatgpt';

async function geradorAtual() {
  let escolhido = null;
  try {
    escolhido = (await require('./iaModeloTarefaService').todos()).imagem;
  } catch {
    escolhido = null;
  }
  const id = GERADORES[escolhido] ? escolhido : PADRAO;
  return { id, nome: GERADORES[id] };
}

function servico(id) {
  if (id === 'chatgpt') {
    const chatgpt = require('./chatgptImageService');
    return { gerar: (args) => chatgpt.gerarImagem(args), recuperar: (args) => chatgpt.recuperarImagem(args) };
  }
  const web = require('./imagemWebService');
  return { gerar: (args) => web.gerarImagem(id, args), recuperar: (args) => web.recuperarImagem(id, args) };
}

/**
 * A recuperação ("Pegar imagem nova gerada") precisa ir ao mesmo site da
 * geração, mesmo que o administrador troque o gerador no meio.
 */
const geradorDaChave = new Map();

async function gerarImagem(args) {
  const gerador = await geradorAtual();
  const chave = String(args?.recoveryKey || '').trim();
  if (chave) {
    geradorDaChave.set(chave, gerador.id);
    while (geradorDaChave.size > 400) geradorDaChave.delete(geradorDaChave.keys().next().value);
  }
  const resultado = await servico(gerador.id).gerar(args);
  return { ...resultado, gerador: gerador.id };
}

async function recuperarImagem(args) {
  const chave = String(args?.recoveryKey || '').trim();
  const id = geradorDaChave.get(chave) || (await geradorAtual()).id;
  const resultado = await servico(id).recuperar(args);
  return { ...resultado, gerador: id };
}

module.exports = { GERADORES, PADRAO, geradorAtual, gerarImagem, recuperarImagem };
