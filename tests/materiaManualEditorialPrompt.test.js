const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  blocoCriteriosMateriaManual,
  blocoEstiloJmNoticia,
  montarRodapeMateriaComFontes,
  removerComentariosEditoriaisIa,
} = require('../src/services/editorialGuidelinesFb');
const { priorizarFontesIndependentes } = require('../src/services/materiaIaService');
const { serializarMensagem } = require('../src/services/materiaChatService');

test('prompt da matéria manual exige redação original e fatos somente da apuração', () => {
  const prompt = blocoEstiloJmNoticia({ pesquisa: true });

  assert.match(prompt, /Nunca escreva fatos a partir de memória/i);
  assert.match(prompt, /reescreva 100% com palavras próprias/i);
  assert.match(prompt, /como reportagem nossa, não como resenha/i);
  assert.match(prompt, /no mínimo duas fontes independentes/i);
  assert.match(prompt, /ao menos um elemento ausente na fonte principal/i);
  assert.match(prompt, /contexto factual/i);
  assert.match(prompt, /Corpo com 3 a 6 parágrafos/i);
  assert.match(prompt, /até 2\.200 caracteres no total/i);
});

test('prompt preserva rodapé, hashtags e chamada do JM com o fechamento da matéria modelo', () => {
  const prompt = blocoEstiloJmNoticia({ pesquisa: false });

  assert.match(prompt, /Exatamente 5 hashtags pertinentes/i);
  assert.match(prompt, /quinta e última é #JMNotícia/i);
  assert.match(prompt, /Siga o JM Notícia/i);
  assert.match(prompt, /Fonte:\*\* nome — URL real/i);
  assert.match(prompt, /Foto:\*\* crédito real/i);
  // Fechamento igual ao da matéria que viralizou: frase curta de impacto,
  // nunca oração, lição de moral ou pergunta de engajamento.
  assert.match(prompt, /UMA frase curta de impacto/i);
  assert.match(prompt, /Proibido fechar com oração, “Amém”, sermão, lição de moral, pergunta/i);
  assert.match(prompt, /MODELO DE ESTRUTURA — copie a FORMA, NUNCA os fatos/i);
  assert.match(prompt, /segundo a publicação/i);
  assert.match(prompt, /não recuse escrever/i);
});

test('critérios compartilhados distinguem pesquisa ligada e desligada', () => {
  const comPesquisa = blocoCriteriosMateriaManual({ pesquisa: true });
  const semPesquisa = blocoCriteriosMateriaManual({ pesquisa: false });

  assert.match(comPesquisa, /duas fontes independentes/i);
  assert.match(comPesquisa, /elemento factual que não esteja na fonte principal/i);
  assert.match(semPesquisa, /somente o link, texto, legenda ou transcrição/i);
  assert.match(semPesquisa, /não acrescente contexto de memória/i);
  for (const prompt of [comPesquisa, semPesquisa]) {
    assert.match(prompt, /3 a 6 parágrafos/i);
    assert.match(prompt, /2\.200 caracteres/i);
    assert.match(prompt, /Proibido fechar com oração, “Amém”, sermão, lição de moral, pergunta/i);
    assert.match(prompt, /PADRÃO DA MATÉRIA QUE VIRALIZOU/);
    assert.match(prompt, /reacendeu o debate/i);
  }
});

test('geradores direto e pesquisado recebem os critérios editoriais compartilhados', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'deepseekService.js'),
    'utf8'
  );

  assert.match(source, /blocoCriteriosMateriaManual\(\{ pesquisa: false \}\)/);
  // O pesquisado já recebe o modelo pelo blocoEstiloNewsGospel: sem repetir.
  assert.match(source, /blocoCriteriosMateriaManual\(\{ pesquisa: true, comModelo: false \}\)/);
});

test('apuração prioriza fontes de domínios independentes', () => {
  const fontes = priorizarFontesIndependentes([
    { url: 'https://portal-a.test/noticia-principal', titulo: 'Principal' },
    { url: 'https://portal-a.test/contexto', titulo: 'Mesmo portal' },
    { url: 'https://portal-b.test/confirmacao', titulo: 'Fonte independente' },
  ]);

  assert.deepEqual(fontes.map((fonte) => fonte.titulo), [
    'Principal',
    'Fonte independente',
    'Mesmo portal',
  ]);
});

test('Mais lidas possui agrupamento e filtro por fonte', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'materia-chat-extras.js'),
    'utf8'
  );

  assert.match(source, /Filtrar matérias mais lidas por fonte/);
  assert.match(source, /mia-x-source-group/);
  assert.match(source, /aplicarFiltroFonte/);
  assert.match(source, /Todas as fontes/);
});

test('matéria manual remove bloco de títulos alternativos do corpo salvo', () => {
  const textoGerado = `**[[LISTA DE CONVIDADOS]]: celular de Vorcaro revela conversas com Fábio Faria sobre festa**

**MENSAGENS APREENDIDAS CITAM CONVITES E CONTATOS COM EX-MINISTRO**

O celular de Daniel Vorcaro revelou conversas com Fábio Faria sobre uma festa organizada em meio às investigações envolvendo o Banco Master.

Segundo as mensagens, o ex-ministro aparece tratando do encaminhamento de convites, mas negou envolvimento com qualquer assunto financeiro.

#BancoMaster #FabioFaria #DanielVorcaro #Politica #JMNotícia

**Títulos alternativos:** 1. [[LISTA DE CONVIDADOS]]: celular de Vorcaro revela conversas com Fábio Faria sobre festa 2. Genro de Silvio Santos aparece em mensagens apreendidas de dono do Banco Master 3. "Só encaminhei convites": Fábio Faria nega envolvimento após vazamento de conversas com Vorcaro`;

  const resultado = montarRodapeMateriaComFontes({
    materia: textoGerado,
    fontes: [{ veiculo: 'Metrópoles', url: 'https://www.metropoles.com/exemplo' }],
    creditoImagem: 'Reprodução',
    hashtags: ['BancoMaster', 'FabioFaria', 'DanielVorcaro', 'Politica', 'JMNotícia'],
    limitarLegenda: false,
  });

  assert.doesNotMatch(resultado.materia, /Títulos alternativos/i);
  assert.doesNotMatch(resultado.materia, /Genro de Silvio Santos aparece em mensagens/i);
  assert.match(resultado.materia, /O celular de Daniel Vorcaro revelou conversas/);
  assert.match(resultado.materia, /Fonte: Metrópoles/);
  assert.match(resultado.materia, /#BancoMaster #FabioFaria #DanielVorcaro #Politica #JMNoticia/);
});

test('matéria manual remove títulos alternativos grudados na linha de hashtags', () => {
  const textoGerado = `Um vídeo com uma profecia atribuída ao evangelista Rubens Gabriel voltou a circular nas redes sociais após os desdobramentos do caso Banco Master.

Na gravação, o evangelista afirma ter recebido uma mensagem sobre situações ocultas no STF e cita Alexandre de Moraes.

#AlexandreDeMoraes #STF #Profecia #RubensGabriel #BancoMaster #Gospel Três títulos alternativos: 1. ["Eu vejo o impeachment dele": profecia sobre Moraes viraliza após caso Master] 2. [[Vídeo de 2023 "previu" crise de Moraes no STF, dizem internautas]] 3. [[Profecia sobre "balança do STF" repercute em meio a revelações do caso Master]]`;

  const resultado = montarRodapeMateriaComFontes({
    materia: textoGerado,
    fontes: [{ veiculo: 'Instagram', url: 'https://www.instagram.com/p/exemplo/' }],
    creditoImagem: 'Reprodução',
    hashtags: ['AlexandreDeMoraes', 'STF', 'Profecia', 'RubensGabriel', 'BancoMaster'],
    limitarLegenda: false,
  });

  assert.doesNotMatch(resultado.materia, /Três títulos alternativos/i);
  assert.doesNotMatch(resultado.materia, /Eu vejo o impeachment dele/i);
  assert.match(resultado.materia, /#AlexandreDeMoraes #STF #Profecia #RubensGabriel #BancoMaster/);
  assert.match(resultado.materia, /Fonte: Instagram/);
});

test('resposta exibida no chat remove títulos alternativos em lista numerada', () => {
  const textoGerado = `**\"Cavalo de Troia\": pastor critica psicologia moderna nas igrejas**

O pastor publicou um vídeo em que apresenta sua interpretação sobre o tema.

**Fonte:** YouTube

#Psicologia #Fé #Igreja #Notícia #JMNotícia

**Siga o JM Notícia.**

Títulos alternativos:

1. [[quem nomeia o problema decide a solução]]: pastor critica psicologia

2. Pastor compara psicologia moderna a \"cavalo de Troia\"

3. [[a culpa não é do agente]]: pastor critica avanço da psicologia`;

  const resultado = removerComentariosEditoriaisIa(textoGerado);

  assert.match(resultado, /Cavalo de Troia/);
  assert.match(resultado, /Siga o JM Notícia/);
  assert.doesNotMatch(resultado, /Títulos alternativos/i);
  assert.doesNotMatch(resultado, /quem nomeia o problema/i);
  assert.doesNotMatch(resultado, /Pastor compara psicologia moderna/i);

  const mensagemAntiga = serializarMensagem({
    id: 1,
    role: 'assistant',
    content: textoGerado,
    hashtags: '[]',
    fontes: '[]',
    passos: '[]',
    titulos_alternativos: '[]',
  });
  assert.doesNotMatch(mensagemAntiga.content, /Títulos alternativos/i);
  assert.doesNotMatch(mensagemAntiga.content, /quem nomeia o problema/i);
});
