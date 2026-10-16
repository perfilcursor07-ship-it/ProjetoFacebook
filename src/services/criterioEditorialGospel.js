/**
 * O critério editorial do "ChatGPT livre" — a pauta da casa.
 *
 * O editor descreveu, em sete critérios e uma estrutura de cinco partes,
 * como ele quer a matéria do público evangélico no Facebook. Antes ele
 * colava isso à mão no ChatGPT a cada pedido; aqui vira o padrão do modo.
 *
 * Três decisões sobre o lugar disto:
 *
 * 1. Vale SÓ no modo "ChatGPT livre" (`chat.modo === 'chatgpt'`), que é o de
 *    produção de notícia. O modo "livre" comum segue sem pauta nenhuma — foi
 *    pedido explícito que ele não herdasse briefing de outro modo.
 * 2. Só vale QUANDO há matéria para escrever. "Fala mano" continua recebendo
 *    resposta de uma linha, sem título e sem estrutura.
 * 3. O pedido escrito pelo editor na conversa VENCE isto. Critério é padrão,
 *    não camisa de força: se ele pedir outra coisa, é a dele que vale.
 *
 * Curto de propósito: no provedor web este texto vai junto do pedido e fica
 * à vista na conversa. Enfiar as sete linhas originais por extenso afogaria
 * o que o editor escreveu.
 */
const CRITERIO_EDITORIAL_GOSPEL = [
  'Pauta desta página (público evangélico no Facebook), quando for escrever matéria:',
  '- Fato dos últimos 7 dias, envolvendo pastor, cantor gospel, igreja, conversão ou testemunho.',
  '- Título desperta curiosidade sem entregar o desfecho ("surpreende fiéis", "revela o que aconteceu"), e precisa corresponder ao fato.',
  '- Prefira história com emoção (fé, superação, família, decisão difícil) ou assunto que divide opinião com respeito (música secular, política na igreja, dízimo, costumes).',
  '- Linguagem de portal popular: parágrafos curtos, sem termo difícil.',
  '- Estrutura: título · abertura que fisga · desenvolvimento com subtítulos que puxam a leitura · reflexão com passagem bíblica ligada ao fato · pergunta final que convida ao comentário.',
  '- A informação sai aos poucos, nos subtítulos; não entregue tudo na abertura.',
  'Nada disso autoriza inventar ou exagerar: confira data, declaração e fonte, e separe fato comprovado de testemunho pessoal. Polêmica forçada não é critério — matéria falsa destrói a página.',
  'Se o editor pedir outra coisa nesta conversa, é o pedido dele que vale.',
].join('\n');

module.exports = { CRITERIO_EDITORIAL_GOSPEL };
