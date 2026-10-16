const test = require('node:test');
const assert = require('node:assert/strict');
const { selecionarFontesRespostaLivre } = require('../src/services/materiaChatService');

// O ChatGPT escreve "Fonte: R7 https://…" (sem travessão). O link era partido
// nas barras — "R7 https:", "noticias.r7.com", "prisma"… — e cada pedaço virava
// um veículo sem link; o sistema saía "localizando a reportagem correta" no
// Google por uns 15 s, com o link certo já escrito na matéria.

const LINK = 'https://noticias.r7.com/prisma/refletindo-sobre-a-noticia-por-ana-carolina-cury/o-que-a-pesquisa-que-monitorou-as-igrejas-durante-as-eleicoes-descobriu-16102026/';

test('"Fonte: Veículo https://…" vira uma fonte só, com o link que a IA escreveu', () => {
  const texto = `Título\n\nCorpo da matéria.\n\nFonte: R7 ${LINK}\n\n#Fé #Igreja`;
  const fontes = selecionarFontesRespostaLivre(texto, {});
  assert.equal(fontes.length, 1);
  assert.equal(fontes[0].veiculo, 'R7');
  assert.equal(fontes[0].url, LINK);
});

test('link em markdown na linha Fonte também vale', () => {
  const texto = `Título\n\nCorpo.\n\nFonte: [G1](https://g1.globo.com/politica/noticia/x.ghtml)`;
  const fontes = selecionarFontesRespostaLivre(texto, {});
  assert.equal(fontes.length, 1);
  assert.equal(fontes[0].veiculo, 'G1');
  assert.equal(fontes[0].url, 'https://g1.globo.com/politica/noticia/x.ghtml');
});

test('dois veículos e dois links: cada um com o seu', () => {
  const texto = 'Título\n\nCorpo.\n\nFonte: UOL https://noticias.uol.com.br/a.htm; Metrópoles https://www.metropoles.com/b';
  const fontes = selecionarFontesRespostaLivre(texto, {});
  assert.deepEqual(
    fontes.map((f) => [f.veiculo, f.url]),
    [
      ['UOL', 'https://noticias.uol.com.br/a.htm'],
      ['Metrópoles', 'https://www.metropoles.com/b'],
    ]
  );
});

test('formato antigo "Veículo — link" continua igual', () => {
  const fontes = selecionarFontesRespostaLivre('T\n\nC.\n\nFonte: Folha de S.Paulo — https://www1.folha.uol.com.br/x.shtml', {});
  assert.equal(fontes.length, 1);
  assert.equal(fontes[0].veiculo, 'Folha de S.Paulo');
});
