/**
 * Matéria a partir de um link de vídeo/post pelo MESMO fluxo do "Criar
 * matéria" do /materia-manual: transcrição, redator editorial escolhido pelo
 * admin, memória de estilo do editor e rodapé com a fonte. Usado pelo Feed
 * sugerido e pelo Furos do dia.
 *
 * O chat e o gateway entram por parâmetro para os testes poderem trocá-los.
 */

function corta(valor, max) {
  const texto = String(valor ?? '').trim();
  return texto ? texto.slice(0, max) : null;
}

/**
 * Escreve e salva o rascunho. Lança erro com code 'SEM_MATERIA' quando a IA
 * responde sem matéria (ex.: a checagem não confirmou os fatos).
 *
 * Só o link vai no pedido, como o editor faz no chat: texto longo junto de
 * um link social é tratado pelo chat como a legenda colada pelo editor, e
 * instruções ali viravam a "legenda" do post.
 *
 * @returns {Promise<{ matterId: number|null, chatId: number|null }>}
 */
async function escreverPeloChat(
  { chatService, comModelo },
  {
    userId,
    url,
    facebookPageId = null,
    imagemUrl = null,
    modelo = null,
    tom = 'natural',
    pesquisarWeb = false,
    onPasso = null,
    // Marca quem pediu a matéria. A conversa que vira matéria fica no
    // histórico do editor; sem isto ela se mistura com o que ele escreveu.
    origem = 'chat',
  }
) {
  let chatId = null;
  const onEvent = (evento) => {
    if (evento?.tipo === 'conversa' && evento.chat?.id) chatId = evento.chat.id;
    if (evento?.tipo === 'passo' && evento.passo?.texto && typeof onPasso === 'function') {
      try {
        onPasso(String(evento.passo.texto));
      } catch {
        // progresso é só visual
      }
    }
  };
  // Só as conversas que viraram matéria ficam no histórico do chat.
  const descartarConversa = () =>
    chatId ? chatService.excluirConversa({ userId, chatId }).catch(() => {}) : Promise.resolve();

  let resposta;
  try {
    resposta = await comModelo(modelo, () => chatService.responder({
      userId,
      texto: url,
      pesquisarWeb: Boolean(pesquisarWeb),
      tom: tom || 'natural',
      modo: 'escrever',
      tipoConversa: 'materia',
      transcreverVideo: true,
      origem,
      onEvent,
    }));
  } catch (err) {
    await descartarConversa();
    throw err;
  }

  const mensagem = resposta?.mensagem;
  if (!mensagem?.id || !mensagem.ehMateria) {
    await descartarConversa();
    const trecho = String(mensagem?.conteudo || mensagem?.content || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const err = new Error(corta(`A IA não escreveu matéria deste link${trecho ? `: ${trecho}` : '.'}`, 500));
    err.code = 'SEM_MATERIA';
    throw err;
  }

  const salvo = await chatService.salvarMateriaDoChat({
    userId,
    messageId: mensagem.id,
    facebookPageId: facebookPageId || null,
    imagemUrl: imagemUrl && /^https?:\/\//i.test(imagemUrl) ? imagemUrl : null,
  });
  return { matterId: salvo?.matterId || null, chatId: resposta.chatId || chatId };
}

/** Mesmo pedido de capa do botão "Capa com IA" do /materia-manual. */
function promptCapaIa(titulo) {
  return [
    'Crie uma NOVA imagem editorial fotorrealista inspirada na imagem de referência enviada.',
    'Mantenha o assunto, as pessoas e a atmosfera reconhecíveis, mas reconstrua a cena de forma original e natural.',
    'Não inclua texto, letras, legendas, placas legíveis, logotipos, marcas d’água, molduras ou elementos gráficos.',
    'Composição vertical exata 4:5 (1080 × 1350 pixels), em alta qualidade, adequada como imagem destacada de uma notícia no feed do Facebook. Não gere imagem quadrada ou horizontal.',
    `Contexto da matéria: ${String(titulo || '').replace(/\[\[|\]\]|\*\*/g, '').trim()}`,
  ].join('\n\n');
}

function comLimite(promise, ms, mensagem) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(mensagem)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Mesma foto, sem o texto embutido.
 *
 * Quando o editor marca "gerar só se a imagem tiver texto", o que ele quer é
 * limpar o print/card — não uma cena nova. `promptCapaIa` recriava a imagem do
 * zero, trocando pessoas e cenário por outros parecidos; aqui a ordem é apagar
 * as letras e devolver o resto igual.
 */
function promptSemTexto(titulo) {
  return [
    'Reproduza a imagem de referência REMOVENDO todo o texto sobreposto.',
    'Apague letras, legendas, títulos, placas legíveis, logotipos, marcas d’água,',
    'selos e tarjas, reconstruindo apenas o fundo que estava atrás deles.',
    'Mantenha TUDO o resto idêntico: as mesmas pessoas, roupas, expressões,',
    'enquadramento, cores, iluminação e cenário. Não reinterprete a cena, não',
    'troque o ângulo e não acrescente elementos.',
    'Não escreva nenhum texto novo na imagem.',
    'Composição vertical exata 4:5 (1080 × 1350 pixels), fotorrealista.',
    `Contexto da matéria (só para entender a cena, não para escrever): ${String(titulo || '')
      .replace(/\[\[|\]\]|\*\*/g, '')
      .trim()}`,
  ].join('\n\n');
}

/** Ilustração sem foto de referência: simbólica e sem pessoas reais. */
function promptCapaSimbolica(titulo) {
  return [
    `Crie uma ilustração editorial original e simbólica para a notícia: "${String(titulo || '').replace(/\[\[|\]\]|\*\*/g, '').trim()}".`,
    'Represente o tema com objetos, lugares e símbolos. Não represente pessoas reais identificáveis nem invente um acontecimento.',
    'Não inclua texto, letras, logotipos ou marcas d’água.',
    'Composição vertical exata 4:5 (1080 × 1350 pixels), fotorrealista e adequada ao feed do Facebook.',
  ].join('\n\n');
}

/**
 * Refaz a capa com o ChatGPT a partir da foto da matéria (até 8 min).
 * Sem foto de referência, `permitirSimbolica` pede uma ilustração simbólica.
 */
async function aplicarCapaChatgpt({
  userId,
  matterId,
  thumbnail,
  permitirSimbolica = false,
  // 'recriar' inventa uma cena nova inspirada na foto; 'limpar_texto' devolve
  // a mesma foto sem as letras. O dot com "gerar só se tiver texto" usa a 2ª.
  modo = 'recriar',
}) {
  const AiMatters = require('../models/AiMatters');
  const matter = await AiMatters.findById(matterId);
  if (!matter) throw new Error('matéria não encontrada');
  let fonte = String(matter.imagem_fonte_url || '').trim();
  if (!fonte || /\/media\/artes\//i.test(fonte)) fonte = thumbnail && /^https?:\/\//i.test(thumbnail) ? thumbnail : '';
  if (!fonte && !permitirSimbolica) throw new Error('não há foto de referência para o ChatGPT');
  const simbolica = !fonte;

  const chatgptImageService = require('./chatgptImageService');
  const { storeMatterSourceImage, composeMatterArtwork } = require('./matterArtworkService');
  const gerada = await comLimite(
    chatgptImageService.gerarImagem({
      sourceUrl: fonte || null,
      prompt: simbolica
        ? promptCapaSimbolica(matter.titulo)
        : modo === 'limpar_texto'
          ? promptSemTexto(matter.titulo)
          : promptCapaIa(matter.titulo),
      titulo: matter.titulo || '',
      materia: matter.materia || '',
      recoveryKey: `${userId}:${matterId}`,
      modo: simbolica ? 'simbolica' : 'referencia',
    }),
    8 * 60 * 1000,
    'o ChatGPT demorou mais de 8 min'
  );
  const guardada = await storeMatterSourceImage({ userId, matterId, buffer: gerada.buffer });
  await composeMatterArtwork({
    userId,
    matterId,
    sourceUrl: guardada.publicUrl,
    title: matter.titulo,
    force: true,
  });

  // Crédito honesto: a foto agora é ilustração gerada por IA.
  const trocarCredito = (texto) =>
    String(texto || '')
      .replace(/\(Foto:[^)\n]*\)/gi, '(Foto: Imagem gerada por IA)')
      .replace(/(\*\*Foto:\*\*)[^\n]*/gi, '$1 Imagem gerada por IA');
  const patch = {};
  if (matter.materia) patch.materia = trocarCredito(matter.materia);
  if (matter.fonte_credito) patch.fonte_credito = trocarCredito(matter.fonte_credito);
  if (Object.keys(patch).length) await AiMatters.update(matterId, patch);
}

module.exports = { escreverPeloChat, aplicarCapaChatgpt, promptCapaIa, promptSemTexto };
