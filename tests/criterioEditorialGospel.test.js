const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { CRITERIO_EDITORIAL_GOSPEL } = require('../src/services/criterioEditorialGospel');
const CHAT = fs.readFileSync('src/services/materiaChatService.js', 'utf8');

test('os sete critérios do editor estão todos lá', () => {
  const c = CRITERIO_EDITORIAL_GOSPEL;
  assert.match(c, /últimos 7 dias/, '1. recência');
  assert.match(c, /sem entregar o desfecho/, '2. título que desperta curiosidade');
  assert.match(c, /emoção \(fé, superação, família, decisão difícil\)/, '3. emoção');
  assert.match(c, /divide opinião com respeito/, '4. debate');
  assert.match(c, /parágrafos curtos, sem termo difícil/, '5. linguagem popular');
  assert.match(c, /não entregue tudo na abertura/, '6. curiosidade ao longo do texto');
  assert.match(c, /pergunta final que convida ao comentário/, '7. engajamento');
});

test('a estrutura de cinco partes está descrita', () => {
  assert.match(
    CRITERIO_EDITORIAL_GOSPEL,
    /título · abertura que fisga · desenvolvimento com subtítulos .* · reflexão com passagem bíblica .* · pergunta final/
  );
});

test('o critério mais importante do editor não foi perdido', () => {
  // "A matéria precisa ser verdadeira." Sem isto, a pauta vira licença para
  // inventar polêmica — exatamente o que ele disse não querer.
  const c = CRITERIO_EDITORIAL_GOSPEL;
  assert.match(c, /Nada disso autoriza inventar ou exagerar/);
  assert.match(c, /confira data, declaração e fonte/);
  assert.match(c, /separe fato comprovado de testemunho pessoal/);
  assert.match(c, /Polêmica forçada não é critério/);
});

test('o pedido escrito na conversa vence a pauta', () => {
  assert.match(CRITERIO_EDITORIAL_GOSPEL, /é o pedido dele que vale/);
});

test('a pauta só vale quando há matéria para escrever', () => {
  // "Fala mano" não pode virar reportagem com subtítulo e versículo.
  assert.match(CRITERIO_EDITORIAL_GOSPEL, /quando for escrever matéria/);
});

test('vale só no modo ChatGPT, não no livre comum', () => {
  // O modo livre foi explicitamente pedido sem briefing de outro modo.
  assert.match(
    CHAT,
    /memoriaEditorial: iaPesquisaSozinha\s*\n\s*\? \[CRITERIO_EDITORIAL_GOSPEL, memoriaEditorialLivre\]/
  );
  assert.match(CHAT, /: memoriaEditorialLivre,/);
});

test('o que o editor ensinou ao sistema pode sobrepor a pauta', () => {
  // A memória gravada é mais específica; por isso vem DEPOIS.
  const i = CHAT.indexOf('[CRITERIO_EDITORIAL_GOSPEL, memoriaEditorialLivre]');
  assert.ok(i > 0, 'a junção precisa existir');
  assert.match(CHAT.slice(i - 220, i), /precisa poder sobrepor/);
});

test('a pauta é curta o bastante para não afogar o pedido', () => {
  // No provedor web ela vai junto do pedido e fica à vista na conversa.
  assert.ok(
    CRITERIO_EDITORIAL_GOSPEL.length < 1400,
    `pauta com ${CRITERIO_EDITORIAL_GOSPEL.length} caracteres`
  );
});

test('a capa continua: foto real da reportagem antes de gerar', () => {
  // O editor pediu a imagem junto da matéria, e o critério dele pede
  // "foto real relacionada à notícia".
  const real = CHAT.indexOf('const linkCitado = primeiroLinkDeFonte(respostaLivreFinal);');
  const gerada = CHAT.indexOf('const gerada = await capaDaConversaLivre(');
  assert.ok(real > 0 && gerada > real, 'tenta a foto citada antes de gerar');
});
