/**
 * Diretrizes editoriais para matérias de Página do Facebook / Instagram.
 * Regra de tamanho: sempre mirar o TETO útil do feed (Face + Insta).
 * - Fonte longa → condensar preservando os dados principais.
 * - Fonte curta → ampliar com contexto real da apuração.
 */

/** Limite duro da legenda do Instagram, incluindo fonte, foto e hashtags. */
const INSTAGRAM_CAPTION_MAX_CHARS = 2200;
/** Teto do corpo; o corte final ainda reserva o limite de 2.200 para o Instagram. */
const MAX_MATERIA_CHARS = 2050;

/** Alvo do corpo sem créditos, para a legenda final chegar perto de 2.000–2.200. */
const FAIXA_CORPO_FB = Object.freeze({ min: 1750, max: 1950 });

/** Abaixo disso a fonte é tratada como “texto pequeno” (precisa expandir). */
const FONTE_CURTA_CHARS = 700;
/** Acima disso a fonte é “texto grande” (precisa condensar). */
const FONTE_LONGA_CHARS = 1800;

const FRASES_PROIBIDAS_IA = [
  'é importante destacar', 'é importante ressaltar', 'vale ressaltar', 'vale destacar', 'vale lembrar',
  'nesse sentido', 'diante disso', 'em suma', 'em resumo', 'por fim',
  'além disso', 'no entanto, é', 'cabe destacar', 'é fundamental',
  'desempenha um papel', 'cenário atual', 'nos dias de hoje',
  'não podemos esquecer', 'sem dúvida', 'com certeza', 'de fato,',
  'mergulhar', 'navegar por', 'panorama geral', 'era digital',
  'reacendeu o debate', 'reacende o debate', 'acendeu o debate',
  'abalou a comunidade', 'comoveu a comunidade', 'chocou a comunidade',
  'a discussão deve continuar', 'o debate deve continuar', 'deve continuar nas próximas',
  'a discussão não é nova', 'o debate não é novo', 'não é de hoje que',
  'trajetória marcada', 'figura conhecida', 'deixa um legado',
  'ganhou as redes', 'tomou as redes', 'movimentou as redes',
  'segue repercutindo', 'resta saber', 'só o tempo dirá',
  'diante do ocorrido', 'diante da repercussão',
  'não perca', 'assista até o final', 'compartilhe com quem precisa',
  'curta e compartilhe', 'deixe seu like', 'comente aqui embaixo',
];

/**
 * Remove comentários editoriais típicos da IA sem mexer nos fatos narrados.
 * Ressalvas de checagem não pertencem à matéria publicada: a apuração deve
 * decidir antes se o conteúdo pode ser escrito.
 */
function removerComentariosEditoriaisIa(texto) {
  const marcador = /^(?:[*_]+\s*)?(?:[ée]\s+importante\s+(?:destacar|ressaltar|lembrar|observar)|vale\s+(?:destacar|ressaltar|lembrar|observar)|cabe\s+(?:destacar|ressaltar|lembrar|observar)|[ée]\s+fundamental\s+(?:destacar|ressaltar|lembrar|observar)|n[aã]o\s+podemos\s+esquecer)(?:\s+que)?\s*[:,;—–-]?\s*/i;
  const ressalvaDeChecagem = /\b(?:sem\s+confirma[cç][aã]o|n[aã]o\s+(?:foi|foram|h[aá]|havia|existe|existia)\s+(?:poss[ií]vel\s+)?(?:confirmar|confirma[cç][aã]o|verificar|verifica[cç][aã]o)|confirma[cç][aã]o\s+(?:m[eé]dica|oficial|independente)|verifica[cç][aã]o\s+independente|laudo\s+m[eé]dico|dispon[ií]vel\s+publicamente)\b/i;

  return removerSecaoTitulosAlternativos(texto)
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((paragrafo) => {
      const original = String(paragrafo || '').trim();
      if (!original || !marcador.test(original)) return original;
      const factual = original.replace(marcador, '').trim();
      if (!factual || ressalvaDeChecagem.test(factual)) return '';
      const neutro = factual.replace(/^se\s+trata\s+de\b/i, 'Trata-se de');
      return neutro.replace(/^([\p{Ll}])/u, (letra) => letra.toLocaleUpperCase('pt-BR'));
    })
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removerSecaoTitulosAlternativos(texto) {
  // O corte de sugestões termina na próxima matéria, nunca no fim do lote.
  const blocos = String(texto || '').replace(/\r\n/g, '\n')
    .split(/(?=^#{1,6}\s*mat[eé]ria\s*\d+\b)/im);
  if (blocos.length > 1) {
    return blocos.map((bloco) => limparTitulosAlternativosDoBloco(bloco)).filter(Boolean).join('\n\n');
  }
  return limparTitulosAlternativosDoBloco(texto);
}

function limparTitulosAlternativosDoBloco(texto) {
  return String(texto || '')
    .replace(/\r\n/g, '\n')
    .replace(
      /(?:^|\n+)\s*(?:[*_]{1,3}\s*)?(?:(?:tr[eê]s|3)\s+)?(?:t[ií]tulos?\s+alternativos?|op[cç][oõ]es\s+de\s+t[ií]tulos?|sugest(?:ões|oes)\s+de\s+t[ií]tulos?)\s*:?\s*(?:[*_]{1,3})?(?=\s*(?:$|\n|\d{1,2}\s*[.)]|[-*•]|\[|["“]))[\s\S]*$/i,
      ''
    )
    .replace(
      /((?:^|\s)#[\p{L}\p{M}\p{N}_]+(?:\s+#[\p{L}\p{M}\p{N}_]+){0,20})\s+(?:[*_]{1,3}\s*)?(?:(?:tr[eê]s|3)\s+)?(?:t[ií]tulos?\s+alternativos?|op[cç][oõ]es\s+de\s+t[ií]tulos?|sugest(?:ões|oes)\s+de\s+t[ií]tulos?)\s*:?\s*(?:[*_]{1,3})?[\s\S]*$/iu,
      '$1'
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sortearFaixaChars() {
  // Sempre o mesmo alvo: tamanho máximo útil para Face/Insta.
  return { min: FAIXA_CORPO_FB.min, max: FAIXA_CORPO_FB.max };
}

/**
 * Classifica o volume da fonte para orientar condensar × expandir.
 * @returns {'curta'|'media'|'longa'}
 */
function classificarVolumeFonte(textoFonte) {
  const n = contarChars(textoFonte);
  if (n <= FONTE_CURTA_CHARS) return 'curta';
  if (n >= FONTE_LONGA_CHARS) return 'longa';
  return 'media';
}

function blocoRegraTamanhoAdaptativo(faixa, volumeFonte) {
  const alvo = `${faixa.min}–${faixa.max}`;
  if (volumeFonte === 'longa') {
    return `TAMANHO (fonte LONGA — CONDENSE):
- A apuração é extensa. CONDENSE até ${alvo} caracteres (máx. Face/Insta).
- Preserve os dados principais: nomes, números, datas, lugares, decisões e até 3 falas literais.
- Corte só repetição, enrolação e detalhes secundários — nunca o furo.
- O texto final deve chegar PERTO do máximo (${faixa.max}), não ficar telegráfico.`;
  }
  if (volumeFonte === 'curta') {
    return `TAMANHO (fonte CURTA — AMPLIE):
- A apuração é curta. AMPLIE até ${alvo} caracteres (máx. Face/Insta).
- Use só contexto REAL da apuração: quem é a pessoa, o que já se sabe dela, lugar, ministério/carreira, desdobramento e fechamento de fé.
- NÃO invente fatos, números, cargos nem citações.
- O texto final deve chegar PERTO do máximo (${faixa.max}) — matéria completa, não bilhete.`;
  }
  return `TAMANHO (fonte MÉDIA — COMPLETE):
- Reescreva a narrativa e preencha até ${alvo} caracteres (máx. Face/Insta).
- Preserve os dados principais e desenvolva com contexto real da apuração.
- Meta: perto de ${faixa.max} caracteres no corpo.`;
}

function sortearEstiloLead() {
  const estilos = [
    'Abra apresentando QUEM é a pessoa + o que ela fez/decidiu agora (ex.: ator X tem se dedicado ao chamado missionário…).',
    'Abra pelo FATO com tom de esperança ou contraste (ex.: em meio à devastação, uma notícia trouxe esperança…).',
    'Abra situando a pessoa pelo que o público já conhece (novelas, ministério, cargo) e em seguida o fato novo.',
    'Abra pelo testemunho/decisão espiritual da pessoa, já no primeiro parágrafo.',
    'Abra por um detalhe humano concreto (dias sob escombros, frase dita, lugar) e amarre ao fato principal.',
  ];
  return estilos[Math.floor(Math.random() * estilos.length)];
}

function sortearEstiloTitulo() {
  const estilos = [
    'Manchete direta e factual (sujeito + verbo + fato).',
    'Manchete com o detalhe mais forte da apuração (número, decisão, milagre, chamada).',
    'Manchete de duas partes (fato: desdobramento espiritual ou humano).',
    'Manchete curta e impactante, sem clickbait enganoso.',
    'Manchete com trecho curto entre aspas simples só se a fala estiver nas fontes.',
  ];
  return estilos[Math.floor(Math.random() * estilos.length)];
}

function sortearVozRedator() {
  const vozes = [
    'Redator de portal gospel (estilo News Gospel): jornalístico, claro e caloroso; apresenta a pessoa, conta o fato e fecha no fato — sem sensacionalismo e sem oração final.',
    'Repórter de testemunho cristão: prioriza nomes, contexto (igreja, cidade, carreira) e falas reais entre aspas; tom respeitoso e próximo do leitor.',
    'Redator de notícia com esperança: narra o fato com precisão e encerra no desenvolvimento jornalístico — sem oração, sem “amém”, sem pedido de fé no fechamento.',
    'Cronista gospel leve: frases médias bem encadeadas, linguagem acessível, sem muletas de IA nem pedido de like.',
    'Repórter de fé e cultura: situar quem é a pessoa (TV, ministério, cargo), o que mudou e por que isso importa — sem oração nas últimas linhas.',
  ];
  return vozes[Math.floor(Math.random() * vozes.length)];
}

/**
 * Critérios do estilo News Gospel — usados em vídeo, imagem, link e pauta.
 */
function pareceFormatoJmNoticia(texto) {
  const t = String(texto || '');
  return (
    /\*{0,2}Fonte:\*{0,2}/i.test(t) &&
    /#JMNot[ií]cia\b/i.test(t) &&
    /\*{0,2}Siga o JM Not[ií]cia\.?\*{0,2}/i.test(t)
  );
}

/** Núcleo factual compartilhado pelo chat e pelos geradores que retornam JSON. */
function blocoCriteriosMateriaManual({ pesquisa = false } = {}) {
  const regraFonte = pesquisa
    ? `- Cruze no mínimo duas fontes independentes sobre o mesmo fato.
- Acrescente ao menos um elemento factual que não esteja na fonte principal: dado, contexto anterior, decisão documentada, número comparativo ou outro lado.`
    : `- Use somente o link, texto, legenda ou transcrição fornecidos.
- Não acrescente contexto de memória. Atribua alegações à publicação quando não houver confirmação independente.`;

  return `CRITÉRIOS EDITORIAIS OBRIGATÓRIOS:
- Escreva somente com fatos presentes na apuração; nunca use a memória para completar lacunas.
- Reescreva com estrutura e palavras próprias, sem copiar frases longas nem a organização das fontes.
- Não basta trocar sinônimos: crie uma manchete própria, escolha um lead factual e reorganize os fatos por relevância. Não reproduza a sequência de parágrafos da fonte.
- Preserve nomes, números, datas e o sentido das informações. Citação direta deve ser curta, literal e atribuída; mantenha o crédito da apuração original.
${regraFonte}
- Produza de 3 a 6 parágrafos conforme a quantidade de fatos. Não aumente o texto com repetição ou enrolação.
- Inclua contexto factual verificável somente quando ele estiver documentado na apuração.
- Encerre no último fato relevante. Não use opinião, lição moral, oração ou pergunta de engajamento.
- Não use muletas como “é importante destacar”, “vale ressaltar” ou “reacendeu o debate”.
- O texto completo publicado deve respeitar o limite de 2.200 caracteres.`;
}

/**
 * Padrão editorial JM Notícia (Instagram + Facebook) para o chat /materia-manual.
 * pesquisa=true: pode cruzar fontes. pesquisa=false: só o conteúdo extraído.
 */
function blocoEstiloJmNoticia({ pesquisa = false } = {}) {
  const regraApuracao = pesquisa
    ? `COM PESQUISA LIGADA:
- Busque sempre fontes adicionais sobre o fato.
- Fato já noticiado: use no mínimo duas fontes independentes. A matéria precisa conter ao menos um elemento ausente na fonte principal — dado, contexto anterior, decisão prévia, número comparativo ou outro lado. Sem esse elemento adicional, não feche a matéria como se a apuração estivesse completa.
- Fato sem cobertura adicional: escreva normalmente, tratando o material original como material próprio. Registre no rodapé a origem e a data — vídeo, transmissão, publicação ou entrevista.
- Busca sem retorno não é motivo para recusar. Use o material original disponível e nunca afirme que outros veículos confirmaram o fato.`
    : `COM PESQUISA DESLIGADA:
- Use somente o conteúdo do link, texto, legenda ou transcrição extraídos pelo sistema.
- Atribua alegações quando necessário (“segundo a publicação”, “de acordo com o relato”, “teria”) e não recuse escrever.
- Não acrescente contexto de memória nem afirme confirmação por outros veículos.`;

  return `VOCÊ É REDATOR DO JM NOTÍCIA.

Sua função é escrever matérias jornalísticas originais a partir do material de apuração fornecido pelo sistema — link extraído, transcrição de vídeo, texto enviado ou resultado de pesquisa web. Nunca escreva fatos a partir de memória.

APURAÇÃO
${regraApuracao}

REGRAS DE TEXTO
- Extraia os fatos e reescreva 100% com palavras próprias. Nunca copie frases longas nem a estrutura da fonte.
- Não faça uma troca de sinônimos frase a frase. Crie título e lead próprios e organize os fatos por relevância, sem seguir a sequência de parágrafos da fonte.
- Antes de entregar, compare o título e a abertura com o material fornecido: reescreva trechos de prosa copiados, preservando nomes, números, datas e citações literais curtas atribuídas.
- Escreva como reportagem nossa, não como resenha do site de origem.
- Número, data, cargo, local, igreja, pastor e declaração só entram se estiverem na apuração.
- Aspas apenas se a fala for literal na apuração. Use no máximo 3.
- Proibido bastidor inventado: “fontes ouvidas”, “aliados afirmam”, “nos bastidores” e equivalentes.
- Não transforme “acreditam que” em “profecia se cumpriu”, nem “investigado” em “culpado”.
- Furo é o melhor ângulo do que já existe, nunca fato inventado.

CONTEXTO OBRIGATÓRIO
- Toda matéria leva um parágrafo de contexto factual: o que aconteceu antes, histórico do envolvido, decisão ou declaração anterior sobre o mesmo tema ou número comparativo.
- Contexto é fato datado e verificável presente na apuração, não opinião nem lição moral.
- Se o material original não trouxer contexto e a busca não encontrar outro fato verificável, não invente: faça uma nota proporcional e registre com precisão a origem e a data disponíveis.

ESTRUTURA
- Entregue somente a matéria pronta, começando diretamente pelo título. Nada de “Claro”, “Segue a matéria” ou comentários ao editor.
- Título forte e fiel aos fatos na primeira linha, em negrito markdown.
- Em seguida, uma âncora em CAIXA ALTA e negrito, sem repetir o título.
- Corpo com 3 a 6 parágrafos, variando conforme a densidade do fato. Não use sempre o mesmo número.
- Cubra quem, o quê, onde, contexto, números e os lados envolvidos somente quando estiverem documentados.
- Encerre no último fato relevante. Não inclua pergunta para engajamento, conclusão opinativa ou interpretação da IA.
- Fonte em linha separada: **Fonte:** nome — URL real. Nunca invente URL.
- Foto em outra linha: **Foto:** crédito real; se não existir, **Foto:** Reprodução Internet.
- Exatamente 5 hashtags pertinentes; a quinta e última é #JMNotícia.
- Última linha: **Siga o JM Notícia.**
- Alvo: até 2.200 caracteres no total, incluindo título, âncora, fonte, foto, hashtags e chamada final.

IMAGEM
- Se a imagem for gerada por IA, marque-a como ilustração na própria arte e sinalize isso na publicação.
- Nunca use IA para simular registro fotográfico de fato real ou de pessoa pública identificável.
- Foto de terceiro exige crédito e, de preferência, frame de fonte oficial ou banco de imagem livre.

PROIBIDO
- Opinião, lição, alerta moral ou oração no fechamento.
- Muletas de IA: “é importante destacar”, “vale ressaltar”, “reacendeu o debate”, “em um cenário cada vez mais” e equivalentes.
- Pedido de like, “não perca”, “assista até o final” ou pergunta artificial para gerar comentários.
- Emoji, preâmbulo, títulos alternativos dentro do corpo, notas ao editor ou texto depois de “Siga o JM Notícia.”

FORMATO VISUAL MANTIDO PELO SISTEMA:
**TÍTULO FORTE**

**ÂNCORA EM CAIXA ALTA**

[3 a 6 parágrafos]

**Fonte:** Nome — URL

**Foto:** Crédito

#Tag1 #Tag2 #Tag3 #Tag4 #JMNotícia

**Siga o JM Notícia.**`;
}

function blocoEstiloNewsGospel() {
  return `
ESTILO NEWS GOSPEL — MINIMATÉRIA (obrigatório):
1) LEAD: apresente quem/o quê com contexto (nome, o que a pessoa é conhecida por, cidade, ministério, carreira). Uma ou duas frases fortes.
2) DESENVOLVIMENTO: minimatéria do conteúdo original. Se a fonte for grande, condense preservando os dados principais; se for pequena, use somente o contexto real disponível e entregue uma nota proporcional.
3) Use no máximo 3 falas literais entre aspas ("…"), cada uma em parágrafo próprio de até 2 linhas (~90 caracteres), só as importantes para o contexto quando houver na fonte — introduza com "afirmou", "declarou", "contou", "disse".
4) FECHAMENTO: encerre no fato / última informação jornalística. PROIBIDO terminar com oração, “Que Deus…”, “Seguimos em oração”, “Amém”, pedido de fé ou as 1–2 últimas linhas só de reflexão espiritual.
5) TOM: jornalístico + evangélico caloroso. Sem clickbait.
6) FORMATO: de 3 a 6 parágrafos, conforme a densidade dos fatos, separados por linha em branco (\\n\\n). Texto puro, sem HTML/markdown, repetição ou emoji obrigatório no final.
7) PROIBIDO: colar a fonte inteira; inventar citações; "não perca", "assista até o final", "compartilhe com quem precisa".
8) NÃO coloque bloco de "Fontes:" / "Fonte:" / créditos no JSON — o sistema anexa créditos automaticamente (uma vez só).
9) VOZ PRÓPRIA — NÃO COMENTE A FONTE: escreva a NOTÍCIA como reportagem nossa, nunca como resenha do que outro site publicou.
   PROIBIDO narrar o veículo: "o site X publicou", "em matéria publicada pelo portal X", "a reportagem do X afirma que", "a publicação destaca", "o artigo explica", "segundo o texto do site".
   O lead começa pelo FATO (quem + o que aconteceu), nunca pelo veículo.
   Se precisar atribuir, use a forma padrão e só DEPOIS do lead: "Segundo o <veículo>, …" ou "Ainda de acordo com o <veículo>, …" — no máximo 2 atribuições no texto inteiro.`;
}

function sortearTemperatura(investigativa = false) {
  if (investigativa) return 0.4 + Math.random() * 0.1; // 0.40–0.50
  return 0.75 + Math.random() * 0.07; // 0.75–0.82
}

function contarChars(texto) {
  return String(texto || '').trim().length;
}

/** Encurta no fim de uma frase (ou palavra), sem deixar a legenda quebrada. */
function cortarTextoComSeguranca(texto, limite) {
  const raw = String(texto || '').replace(/\r\n/g, '\n').trim();
  const max = Math.max(40, Math.floor(Number(limite) || 0));
  if (!raw || raw.length <= max) return raw;

  const margem = Math.floor(max * 0.62);
  const trecho = raw.slice(0, Math.max(1, max - 1)).trimEnd();
  let corteFrase = -1;
  const reFim = /[.!?…]["”')\]]?(?=\s|$)/g;
  let match;
  while ((match = reFim.exec(trecho))) {
    const fim = match.index + match[0].length;
    if (fim >= margem) corteFrase = fim;
  }
  if (corteFrase >= margem) return trecho.slice(0, corteFrase).trim();

  const quebraParagrafo = trecho.lastIndexOf('\n\n');
  if (quebraParagrafo >= margem) return trecho.slice(0, quebraParagrafo).trim();

  const espaco = trecho.lastIndexOf(' ');
  const corte = espaco >= margem ? espaco : trecho.length;
  return `${trecho.slice(0, corte).trim()}…`;
}

/**
 * Garante uma legenda publicável no Instagram e preserva, sempre que possível,
 * os blocos finais de fonte, crédito da foto e hashtags.
 */
function limitarLegendaInstagram(texto, limite = INSTAGRAM_CAPTION_MAX_CHARS) {
  const raw = String(texto || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const max = Math.max(200, Math.floor(Number(limite) || INSTAGRAM_CAPTION_MAX_CHARS));
  if (!raw || raw.length <= max) return raw;

  const blocos = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const rodape = [];
  const ehRodape = (p) =>
    /^(?:#|Fontes?\s*:|Foto\s*:|\(Foto\s*:|Por\s+.+?[—–-]\s*Site\s*:)/i.test(p);
  while (blocos.length > 1 && ehRodape(blocos[blocos.length - 1])) {
    rodape.unshift(blocos.pop());
  }

  let sufixo = rodape.join('\n\n');
  if (sufixo.length > Math.floor(max * 0.35)) {
    sufixo = cortarTextoComSeguranca(sufixo, Math.floor(max * 0.35));
  }
  const separador = sufixo ? 2 : 0;
  const corpo = cortarTextoComSeguranca(
    blocos.join('\n\n'),
    Math.max(120, max - sufixo.length - separador)
  );
  const final = [corpo, sufixo].filter(Boolean).join('\n\n').trim();
  return final.length <= max ? final : cortarTextoComSeguranca(final, max);
}

function avaliarComprimentoFb(materia, faixa) {
  const chars = contarChars(materia);
  const min = faixa?.min || 400;
  const max = Math.min(faixa?.max || 650, MAX_MATERIA_CHARS);
  return {
    chars,
    curto: chars < min * 0.85,
    longo: chars > max * 1.15 || chars > MAX_MATERIA_CHARS,
    ok: chars >= min * 0.85 && chars <= Math.min(max * 1.15, MAX_MATERIA_CHARS),
    min,
    max,
  };
}

function detectarMuletasIa(texto) {
  const lower = String(texto || '').toLowerCase();
  return FRASES_PROIBIDAS_IA.filter((f) => lower.includes(f));
}

function normalizarBusca(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Citações com nomes que não estão na apuração → possível invenção.
 */
function detectarCitacoesInventadas(materia, contextoApuracao) {
  const texto = String(materia || '');
  const contexto = normalizarBusca(contextoApuracao || '');
  const suspeitos = new Set();

  const rxNome =
    /\b([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+(?:\s+(?:de|da|do|dos|das))?\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+)\b/g;
  const rxFala =
    /[“"][^”"]{12,280}[”"][^.”"]{0,100}?(?:diz|disse|afirma|afirmou|declara|declarou|garante|garantiu|comenta|comentou)|(?:diz|disse|afirma|afirmou|declara|declarou|segundo)[^.]{0,100}?[“"][^”"]{12,280}[”"]/gi;

  const blocos = texto.match(rxFala) || [];
  for (const bloco of blocos) {
    let m;
    rxNome.lastIndex = 0;
    while ((m = rxNome.exec(bloco)) !== null) {
      const nome = m[1].trim();
      if (/^(São|Rio|Belo|Porto|Assembleia|Igreja|Santa|Santo|Nova|Google|Espírito)\b/i.test(nome)) continue;
      if (!contexto.includes(normalizarBusca(nome))) suspeitos.add(nome);
    }
  }
  return [...suspeitos];
}

const STOP_ASSUNTO = new Set([
  'para', 'com', 'sobre', 'apos', 'apos', 'ainda', 'mais', 'menos', 'quando', 'onde',
  'como', 'tambem', 'depois', 'antes', 'hoje', 'ontem', 'agora', 'muito', 'muita',
  'deixam', 'deixou', 'deixam', 'mostra', 'mostram', 'video', 'videos', 'foto',
  'fotos', 'veja', 'veja', 'confira', 'saiba', 'entenda', 'alerta', 'ultimas',
  'noticias', 'gospel', 'cristaos', 'cristao', 'fieis', 'oracao', 'oracoes',
  'clamam', 'clamor', 'unem', 'meio', 'caos', 'entre', 'sobre', 'pelos', 'pelas',
]);

/** Tokens úteis para comparar se duas manchetes são o mesmo fato. */
function tokensAssunto(texto) {
  const raw = normalizarBusca(texto);
  const nums = (raw.match(/\d+[.,]\d+/g) || []).map((n) => `n${n.replace(/[.,]/g, '')}`);
  const words = raw
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_ASSUNTO.has(w));
  return [...nums, ...words];
}

/**
 * Mesma notícia (critério estrito): 75% das palavras do título maior em
 * comum. Assunto parecido NÃO conta — só a mesma manchete reescrita.
 */
function mesmaNoticiaEstrita(a, b) {
  const ta = [...new Set(tokensAssunto(a))];
  const tb = [...new Set(tokensAssunto(b))];
  if (ta.length < 3 || tb.length < 3) return false;
  const setB = new Set(tb);
  const comuns = ta.filter((w) => setB.has(w)).length;
  return comuns / Math.max(ta.length, tb.length) >= 0.75;
}

function titulosParecidos(a, b) {
  const na = tokensAssunto(a);
  const nb = tokensAssunto(b);
  if (!na.length || !nb.length) return false;
  const setB = new Set(nb);
  const inter = na.filter((w) => setB.has(w)).length;
  return inter >= Math.min(4, Math.ceil(Math.min(na.length, nb.length) * 0.55));
}

/**
 * Detecta a mesma notícia mesmo com títulos reescritos pela IA
 * (ex.: várias versões de “terremoto 7,1 no Japão”).
 */
function mesmoAssuntoNoticia(a, b) {
  if (titulosParecidos(a, b)) return true;
  const na = tokensAssunto(a);
  const nb = tokensAssunto(b);
  if (!na.length || !nb.length) return false;
  const setB = new Set(nb);
  const inter = [...new Set(na.filter((w) => setB.has(w)))];
  if (inter.length < 2) return false;

  const forte =
    /^(terremoto|tsunami|incendio|tiroteio|enchente|desabamento|acidente|atentado|sequestro|prisao|eleicao|morte|assassinato|desabou|evacuados|shopping|japao|israel|gaza|ucrania|china|russia|bahia|brasilia|kumamoto)/;
  const fortes = inter.filter((w) => forte.test(w) || /^n\d+$/.test(w) || w.length >= 8);
  // Ex.: terremoto + japao, ou n71 + japao, ou terremoto + n71
  if (fortes.length >= 2) return true;
  // 3+ tokens em comum já basta (manchetes longas reescritas)
  return inter.length >= 3;
}

function normalizeHashtagToken(raw) {
  return String(raw || '')
    .replace(/^#/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9À-ÿ]/g, '')
    .trim();
}

function formatHashtagsLine(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const vistos = new Set();
  const cleaned = [];
  for (const item of list) {
    const tag = normalizeHashtagToken(item);
    const chave = tag.toLocaleLowerCase('pt-BR');
    if (tag.length < 2 || vistos.has(chave)) continue;
    vistos.add(chave);
    cleaned.push(tag);
    if (cleaned.length >= 5) break;
  }
  return cleaned.map((t) => `#${t}`).join(' ');
}

/**
 * Garante hashtags no final do texto (após o corpo), sem duplicar.
 */
function anexarHashtagsAoFinal(materia, hashtags) {
  const extracted = extrairHashtagsDoTexto(materia);
  const tags =
    Array.isArray(hashtags) && hashtags.length
      ? hashtags
      : extracted.tags;
  const line = formatHashtagsLine(tags);
  const body = String(extracted.body || '').trim();
  if (!line) return body;
  return `${body}\n\n${line}`.trim();
}

/** Extrai hashtags do final do texto e devolve { body, tags }. */
function extrairHashtagsDoTexto(texto) {
  const raw = String(texto || '').replace(/\r\n/g, '\n').trim();
  const rxAntesDoSiga =
    /((?:#[\p{L}\p{M}\p{N}_]+[ \t]*)+)(?=(?:\s|\n)+Siga\s+o\s+JM\s+Not[ií]cia\.?\s*$)/iu;
  let match =
    raw.match(/\n\n((?:#[\wÀ-ÿ]+(?:\s+|$))+)$/u) ||
    raw.match(/\n((?:#[\wÀ-ÿ]+(?:\s+|$))+)$/u);
  let inicio = match?.index ?? -1;
  let tamanho = match?.[0]?.length || 0;

  // O Claude costuma pôr "Siga o JM Notícia" depois das hashtags. Nesse caso
  // elas não são literalmente o último bloco, mas continuam sendo o rodapé.
  if (!match) {
    const antesDoSiga = raw.match(rxAntesDoSiga);
    if (antesDoSiga) {
      match = antesDoSiga;
      inicio = antesDoSiga.index;
      tamanho = antesDoSiga[0].length;
    }
  }
  if (!match) return { body: raw, tags: [] };
  const tags = match[1]
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^#/, ''))
    .filter(Boolean);
  let bodySemTags = `${raw.slice(0, inicio)}${raw.slice(inicio + tamanho)}`;

  // Rascunhos que já foram abertos com a regra antiga podem conter as duas
  // linhas: uma antes de "Siga" e outra no fim. Remove também a anterior.
  const repetidaAntesDoSiga = bodySemTags.match(rxAntesDoSiga);
  if (repetidaAntesDoSiga) {
    tags.push(
      ...repetidaAntesDoSiga[1]
        .trim()
        .split(/\s+/)
        .map((t) => t.replace(/^#/, ''))
        .filter(Boolean)
    );
    bodySemTags = `${bodySemTags.slice(0, repetidaAntesDoSiga.index)}${bodySemTags.slice(
      repetidaAntesDoSiga.index + repetidaAntesDoSiga[0].length
    )}`;
  }
  const tagsUnicas = [];
  const tagsVistas = new Set();
  for (const tag of tags) {
    const chave = normalizeHashtagToken(tag).toLocaleLowerCase('pt-BR');
    if (!chave || tagsVistas.has(chave)) continue;
    tagsVistas.add(chave);
    tagsUnicas.push(tag);
  }

  const body = bodySemTags
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}(?=Siga\s+o\s+JM\s+Not[ií]cia)/gi, ' ')
    .trim();
  return { body, tags: tagsUnicas };
}

/**
 * Quebra texto corrido em parágrafos curtos (1–2 frases) para o feed do Facebook.
 * Preserva blocos de crédito (Fontes: / Fonte:) sem achatar linhas internas.
 */
function quebrarEmParagrafos(texto) {
  let t = String(texto || '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';

  // Separa créditos do corpo para não juntar "Fontes:\n• …" numa linha só
  let creditos = '';
  const creditMatch = t.match(
    /\n\n((?:Fontes:\s*\n(?:[•\-*].+\n?)+)|(?:Fonte:\s*[^\n]+(?:\n\(Foto:[^\n]+\))?)|(?:Por\s+[^\n]+?\s*[—\-–]\s*Site:\s*[^\n]+(?:\n\(Foto:[^\n]+\))?)|(?:\(Foto:[^\n]+\)))\s*$/i
  );
  if (creditMatch) {
    creditos = creditMatch[1].trim();
    t = t.slice(0, creditMatch.index).trim();
  }

  let body;
  if (/\n\s*\n/.test(t)) {
    body = t
      .split(/\n\s*\n/)
      .map((p) => p.replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n');
  } else {
    const sentences = t.match(/[^.!?…]+[.!?…]+(?:["”')\]]*)?|[^.!?…]+$/g) || [t];
    const paras = [];
    let buf = '';
    let frasesNoBuf = 0;

    for (const raw of sentences) {
      const piece = String(raw).replace(/\s+/g, ' ').trim();
      if (!piece) continue;
      const next = buf ? `${buf} ${piece}` : piece;
      const wouldBeLong = next.length > 240;
      if (buf && (frasesNoBuf >= 2 || wouldBeLong)) {
        paras.push(buf);
        buf = piece;
        frasesNoBuf = 1;
      } else {
        buf = next;
        frasesNoBuf += 1;
      }
    }
    if (buf) paras.push(buf);
    body = paras.join('\n\n');
  }

  body = fundirParagrafosIncompletos(body);
  return creditos ? `${body}\n\n${creditos}`.trim() : body;
}

function paragrafoTemFimDeFrase(p) {
  return /[.!?…]["”')\]]*$/.test(String(p || '').trim());
}

/** Lead truncado típico da limpeza ruim / IA: "A apresentadora X, conhecida" */
function pareceParagrafoTruncado(p) {
  const t = String(p || '').trim();
  if (!t || paragrafoTemFimDeFrase(t)) return false;
  if (t.length > 140) return false;
  if (/,\s*$/.test(t)) return true;
  if (
    /\b(conhecida|conhecido|considerada|considerado|apontada|apontado|nascida|nascido|eleita|eleito|chamada|chamado)\s*$/i.test(
      t
    )
  ) {
    return true;
  }
  return t.split(/\s+/).length <= 10;
}

/**
 * Remove lead cortado no início e funde parágrafos sem pontuação final.
 */
function fundirParagrafosIncompletos(body) {
  const paras = String(body || '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!paras.length) return '';

  while (paras.length > 1 && pareceParagrafoTruncado(paras[0])) {
    paras.shift();
  }

  const out = [];
  for (let i = 0; i < paras.length; i += 1) {
    let cur = paras[i];
    while (i + 1 < paras.length && !paragrafoTemFimDeFrase(cur) && cur.length < 320) {
      i += 1;
      cur = `${cur} ${paras[i]}`.replace(/\s+/g, ' ').trim();
    }
    out.push(cur);
  }
  return out.join('\n\n');
}

/**
 * Facebook só permite a mesma @menção 1× por dia (Ayrshare code 159).
 * Converte @handles em #hashtags; não altera e-mails (texto antes do @).
 */
function sanitizeFacebookMentions(text) {
  return String(text || '').replace(
    /(^|[^A-Za-z0-9._])@([A-Za-z0-9._]{2,50})\b/g,
    '$1#$2'
  );
}

/**
 * Monta a legenda final do post: título opcional + corpo + crédito/fonte + hashtags.
 * O título ainda é usado para removê-lo do início do corpo quando incluirTitulo=false.
 */
function formatFacebookCaption({ titulo, materia, hashtags, fonteCredito, incluirTitulo = true } = {}) {
  // [[destaque]] / ((faixa)) são só para a arte 4:5 — na legenda do FB vão limpos.
  let title = String(titulo || '').replace(/\s+/g, ' ').trim();
  try {
    const { stripAlertMarks } = require('./editorialCardService');
    title = stripAlertMarks(title).replace(/\s+/g, ' ').trim();
  } catch {
    title = title.replace(/\[\[|\]\]/g, '').replace(/\(\(|\)\)/g, '').replace(/\s+/g, ' ').trim();
  }
  let working = removerFechamentoOracao(removerSecaoTitulosAlternativos(materia));
  const extracted = extrairHashtagsDoTexto(working);
  let body = extracted.body;

  if (title && body.toLowerCase().startsWith(title.toLowerCase())) {
    body = body.slice(title.length).replace(/^[\s:—\-–.]+/, '').trim();
  }

  body = quebrarEmParagrafos(body);

  // Crédito fica SÓ no conteúdo (materia). Campo fonte_credito não é anexado de novo.
  body = dedupeBlocosCredito(body);
  const credit = '';

  const tagsLine = formatHashtagsLine(
    Array.isArray(hashtags) && hashtags.length ? hashtags : extracted.tags
  );

  const parts = [];
  if (title && incluirTitulo) parts.push(title);
  if (body) parts.push(body);
  if (credit) parts.push(credit);
  if (tagsLine) parts.push(tagsLine);
  return sanitizeFacebookMentions(parts.join('\n\n').trim());
}

/** Mantém no máximo um bloco de créditos no texto. */
function dedupeBlocosCredito(texto) {
  let body = String(texto || '');
  const reFontes = /\n*Fontes:\s*\n(?:[•\-*].+\n?)+/gi;
  const matches = [...body.matchAll(reFontes)];
  if (matches.length > 1) {
    for (let i = 0; i < matches.length - 1; i += 1) {
      body = body.replace(matches[i][0], '\n');
    }
  }
  // Se sobrou Fonte: solta + Fontes:, remove a solta
  if (/Fontes:\s*\n/i.test(body)) {
    body = body.replace(/\n*Fonte:\s*.+(?:\n\(Foto:[^\n]+\))?/gi, '');
  }
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Estilo de crédito por página:
 * - jm → "Por Autor - Site: dominio" + "(Foto: …)"
 * - apocalipse → "Fontes:" com bullets Conteúdo/Imagem (padrão)
 */
function estiloCreditoDaPagina(pageName) {
  const n = String(pageName || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (
    /\bjm\b/.test(n) ||
    n.includes('jm noticia') ||
    n.includes('jm noticias') ||
    n === 'jm' ||
    /^jm[\s_-]/.test(n)
  ) {
    return 'jm';
  }
  return 'apocalipse';
}

function limparAutorArtigo(value) {
  const v = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^por\s+/i, '')
    .replace(/^by\s+/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim()
    .slice(0, 80);
  if (!v || v.length < 2) return null;
  if (/^(redacao|redação|equipe|staff|editor|admin|adminstracao|administração)$/i.test(v)) {
    return null;
  }
  if (/\.(com|br|net|org)\b/i.test(v)) return null;
  return v;
}

/**
 * Monta crédito padrão da matéria (editável depois).
 * JM: "Por Abby Trivett - Site: terra.com.br" + "(Foto: Reprodução)"
 * Demais: "Fonte: G1" + "(Foto: Reprodução)" (campo fonte_credito)
 */
function montarFonteCredito({
  veiculo,
  fonte,
  host,
  tipoPublicacao,
  imagemOrigem,
  autorArtigo,
  estilo,
} = {}) {
  let nome = String(veiculo || fonte || '').replace(/\s+/g, ' ').trim();
  if (host) {
    const fromHost = nomeSiteDeUrl(host);
    // Use o nome da URL somente quando não houver nome editorial ou quando o valor atual
    // ainda for hostname/rede social. Nomes como “O Fuxico Gospel” devem ser preservados.
    if (
      fromHost &&
      (!nome ||
        (/\./.test(nome) && !/\s/.test(nome)) ||
        nome.toLocaleLowerCase('pt-BR').startsWith(fromHost.toLocaleLowerCase('pt-BR')) ||
        /instagram|facebook|tiktok|youtube|rede social/i.test(nome))
    ) {
      nome = fromHost;
    }
  }
  if (!nome && host) {
    try {
      const hostname = String(host).includes('://') ? new URL(host).hostname : host;
      nome = String(hostname).replace(/^www\./i, '');
    } catch {
      /* ignore */
    }
  }
  if (nome && /\./.test(nome) && !/\s/.test(nome)) {
    nome = nome.replace(/^www\./i, '');
  }

  const genericos = /^(fonte|google news|brave|editorial|serpapi|pexels|rede social|instagram|facebook)$/i;
  if (nome && genericos.test(nome)) nome = '';

  const autor = limparAutorArtigo(autorArtigo) || (estilo === 'jm' ? 'Redação' : null);
  const estiloFinal = estilo === 'jm' ? 'jm' : 'simples';
  const lines = [];

  if (estiloFinal === 'jm') {
    if (autor && nome) lines.push(`Por ${autor} — Site: ${nome}`);
    else if (autor) lines.push(`Por ${autor}`);
    else if (nome) lines.push(`Por Redação — Site: ${nome}`);
  } else if (nome) {
    lines.push(`Fonte: ${nome}`);
  }

  const temFoto = tipoPublicacao === 'foto' || Boolean(imagemOrigem);
  if (temFoto) {
    if (imagemOrigem?.tipo === 'pexels') {
      lines.push('(Foto: Pexels)');
    } else if (imagemOrigem?.autor) {
      const a = limparCreditoAutor(imagemOrigem.autor);
      lines.push(`(Foto: ${a === CREDITO_IMAGEM_FALLBACK ? 'Reprodução' : a})`);
    } else {
      lines.push('(Foto: Reprodução)');
    }
  }

  return lines.join('\n').slice(0, 400) || null;
}

/** Crédito padrão quando a imagem interna não traz autor identificável. */
const CREDITO_IMAGEM_FALLBACK = 'Reprodução/Internet';

/**
 * Extrai nome de autor/fotógrafo dos metadados da imagem interna (heurística).
 * Retorna null se não houver nome claro (aí cai no fallback ou na IA).
 */
function extrairAutorImagemHeuristico({ autor, fonte, titulo } = {}) {
  const limpar = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim()
      .slice(0, 80);

  const pareceAutor = (s) => {
    const v = limpar(s);
    if (!v || v.length < 2 || v.length > 80) return false;
    if (/^(pexels|unsplash|getty|shutterstock|google|internet|reprodu[cç][aã]o|reprodu[cç][aã]o\/internet|stock|foto|image|imagem)$/i.test(v)) {
      return false;
    }
    if (/^(instagram|facebook|twitter|x|tiktok|youtube|g1|uol|globo|bbc|cnn|reuters)$/i.test(v)) {
      return false;
    }
    if (/\.(com|br|net|org|io)\b/i.test(v)) return false;
    return true;
  };

  const a = limpar(autor);
  if (pareceAutor(a)) return a;

  const f = limpar(fonte);
  const pexels = f.match(/^Pexels\s*[·\-–|]\s*(.+)$/i);
  if (pexels && pareceAutor(pexels[1])) return limpar(pexels[1]);
  if (pareceAutor(f) && /\b[\p{Lu}][\p{L}'’.-]{1,}(?:\s+[\p{Lu}][\p{L}'’.-]{1,})+/u.test(f)) {
    return f;
  }

  const t = String(titulo || '');
  const tm =
    t.match(
      /(?:foto|fotografia|cr[eé]dito|photographer|photo\s*by|by|por)\s*[:：\-–]\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\- ]{1,60})/i
    ) || t.match(/©\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\- ]{1,60})/i);
  if (tm && pareceAutor(tm[1])) {
    return limpar(tm[1].replace(/\s*[|/·].*$/, ''));
  }

  return null;
}

/** Nome amigável do site a partir da URL (sem link). */
function nomeSiteDeUrl(url) {
  try {
    const host = new URL(String(url || '').trim()).hostname.replace(/^www\./i, '');
    if (!host) return null;
    const base = host.split('.')[0] || host;
    const conhecidos = {
      g1: 'G1',
      uol: 'UOL',
      globo: 'Globo',
      folha: 'Folha',
      estadao: 'Estadão',
      cnn: 'CNN',
      bbc: 'BBC',
      youtube: 'YouTube',
      instagram: 'Instagram',
      facebook: 'Facebook',
      tiktok: 'TikTok',
      twitter: 'X',
      x: 'X',
      terra: 'terra.com.br',
      christianpost: 'christianpost.com',
      fuxicogospel: 'O Fuxico Gospel',
    };
    if (conhecidos[base.toLowerCase()]) return conhecidos[base.toLowerCase()];
    // Mantém domínio curto quando útil (terra.com.br)
    if (host.split('.').length <= 3) return host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return null;
  }
}

function removerBlocoCreditosDoCorpo(cleanBody) {
  // NÃO usar /Por\s+.+/gi solto — apaga "conhecida por …" no meio da matéria.
  return removerSecaoTitulosAlternativos(cleanBody)
    .replace(/\n*Fontes:\s*\n(?:[•\-*].+\n?)+/gi, '')
    .replace(/(?:^|\n+)Fonte:\s*\n(?:[•\-*].+\n?)+/gi, '\n')
    .replace(/(?:^|\n+)Fonte:\s*[^\n]+(?:\n\(Foto:[^\n]+\))?/gi, '\n')
    // JM em 2 linhas OU colado numa linha: Por … Site: … (Foto: …) #tags
    .replace(
      /(?:^|\n+)Por\s+[^\n]+?\s*[—\-–]\s*Site:\s*[^\n]+/gi,
      '\n'
    )
    .replace(/(?:^|\n+)\(Foto:\s*[^\n]+\)/gi, '\n')
    .replace(/(?:^|\n+)Foto:\s*[^\n]+/gi, '\n')
    // URLs soltas / "Veículo — https://…" deixados no fim pela IA
    .replace(/(?:^|\n+)[^\n—\-–]+?\s*[—\-–]\s*https?:\/\/[^\s\n]+/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function materiaJaTemCredito(materia) {
  const t = String(materia || '');
  return (
    /Fontes:\s*\n/i.test(t) ||
    /[•\*]\s*Conte[uú]do\s*:/i.test(t) ||
    /^Fonte:\s/m.test(t) ||
    /Por\s+.+\s*[—\-–]\s*Site\s*:/i.test(t) ||
    /\(Foto:\s*[^)]+\)/i.test(t) ||
    /^Foto:\s.+/m.test(t)
  );
}

/**
 * Remove oração / fechamento de fé típico das 1–2 últimas linhas do corpo.
 */
function removerFechamentoOracao(texto) {
  const { body, tags } = extrairHashtagsDoTexto(texto);
  let clean = String(body || '').trim();
  if (!clean) return String(texto || '').trim();

  // Também separa créditos JM/Fontes para não misturar com o último parágrafo
  const creditoMatch = clean.match(
    /\n\n((?:Fontes:\s*\n(?:[•\-*].+\n?)+)|(?:Fonte:\s*\n(?:[•\-*].+\n?)+\n+Foto:\s*[^\n]+)|(?:Fonte:\s*\n(?:[•\-*].+\n?)+)|(?:Foto:\s*[^\n]+)|(?:Por\s+.+\s*[—\-–]\s*Site\s*:[\s\S]*?)|(?:Fonte:\s*.+(?:\n\(Foto:[^\n]+\))?)|(?:\(Foto:[^\n]+\)))\s*$/i
  );
  let creditoTail = '';
  if (creditoMatch) {
    creditoTail = creditoMatch[1].trim();
    clean = clean.slice(0, creditoMatch.index).trim();
  }

  const paras = clean.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const pareceOracao = (p) => {
    const t = String(p || '').trim();
    if (!t || t.length > 480) return false;
    if (
      /^(que\s+(deus|o\s+senhor|o\s+esp[ií]rito|possamos)|seguimos\s+em\s+ora|oremos|oramos|em\s+ora[cç][aã]o|gl[oó]ria\s+a\s+deus|senhor\s+nos\s+guarde|que\s+o\s+senhor)/i.test(
        t
      )
    ) {
      return true;
    }
    if (/am[eé]m\.?\s*$/i.test(t) || /🙏/.test(t)) return true;
    if (
      /(?:ora[cç][aã]o|oramos|oremos|que\s+deus|que\s+o\s+senhor|esp[ií]rito\s+santo|seguimos\s+em\s+ora)/i.test(
        t
      ) &&
      !/[“"]/.test(t) &&
      t.length < 400
    ) {
      return true;
    }
    return false;
  };

  let removed = 0;
  while (paras.length > 2 && removed < 2 && pareceOracao(paras[paras.length - 1])) {
    paras.pop();
    removed += 1;
  }

  let out = paras.join('\n\n');
  if (creditoTail) out = `${out}\n\n${creditoTail}`;
  return anexarHashtagsAoFinal(out, tags);
}

/**
 * Anexa bloco de créditos antes das hashtags.
 * Apocalipse: Fontes: + bullets Conteúdo/Imagem
 * JM: Por Autor - Site: dominio + (Foto: …)
 */
function converterCreditosParaJm(materia, { fonteUrl, autorArtigo } = {}) {
  const { body } = extrairHashtagsDoTexto(materia);
  let site = null;
  let img = null;
  const conteudo = String(body || '').match(/[•\*]\s*Conte[uú]do\s*:\s*([^\n]+)/i);
  const imagem = String(body || '').match(/[•\*]\s*Imagem\s*:\s*([^\n]+)/i);
  if (conteudo) site = conteudo[1].trim();
  if (imagem) img = imagem[1].trim();
  if (!site) site = nomeSiteDeUrl(fonteUrl) || null;

  return anexarCreditosFontes(body, {
    fonteNome: site,
    fonteUrl,
    imagemAutor: img || CREDITO_IMAGEM_FALLBACK,
    autorArtigo: autorArtigo || null,
    estilo: 'jm',
  });
}

/**
 * Nome curto do veículo para o rodapé "Fonte: Globo, UOL" (sem domínio/URL).
 */
function nomeCurtoFonte(veiculo, url) {
  const v = String(veiculo || '')
    .replace(/\s+/g, ' ')
    .trim();
  let host = '';
  try {
    host = new URL(String(url || '').trim()).hostname.replace(/^www\d*\./i, '').toLowerCase();
  } catch {
    if (/\./.test(v)) host = v.replace(/^https?:\/\//i, '').replace(/^www\d*\./i, '').toLowerCase();
  }
  const blob = `${host} ${v}`.toLowerCase();

  // Em rede social, o nome útil é o canal/perfil que publicou, não apenas
  // “YouTube”, “Instagram” ou “Facebook”. Mantém o criador no crédito.
  const hostSocial = /(^|\.)(?:youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch|tiktok\.com|x\.com|twitter\.com)$/.test(
    host
  );
  const nomeGenericoSocial = /^(?:youtube|instagram|facebook|tiktok|x|twitter)$/i.test(v);
  if (hostSocial && v && !nomeGenericoSocial) return v.slice(0, 60);

  if (/\bg1\b/.test(blob) || host.startsWith('g1.')) return 'G1';
  if (/folha/.test(blob)) return 'Folha';
  if (/\buol\b/.test(blob) || /(^|\.)uol\./.test(host)) return 'UOL';
  if (/oglobo|globo\.com/.test(blob) || /\bglobo\b/.test(blob)) return 'Globo';
  if (/estadao|estadão/.test(blob)) return 'Estadão';
  if (/\bcnn\b/.test(blob)) return 'CNN';
  if (/bbc news brasil/.test(blob)) return 'BBC News Brasil';
  if (/\bbbc\b/.test(blob)) return 'BBC News';
  if (/veja\.abril|\bveja\b/.test(blob)) return 'Veja';
  if (/gazetadopovo|gazeta do povo/.test(blob)) return 'Gazeta do Povo';
  if (/brasil247|brasil\s*247/.test(blob)) return 'Brasil 247';
  if (/metropoles|metr[oó]poles/.test(blob)) return 'Metrópoles';
  if (/poder360/.test(blob)) return 'Poder360';
  if (/exame/.test(blob)) return 'Exame';
  if (/terra\.com|\bterra\b/.test(blob)) return 'Terra';
  if (/r7\.com|\br7\b/.test(blob)) return 'R7';
  if (/band\.|bandnews/.test(blob)) return 'Band';
  if (/jetss/.test(blob)) return 'Jetss';

  const fromUrl = nomeSiteDeUrl(url);
  if (fromUrl && !/\.(com|br|org|net|online)\b/i.test(fromUrl)) return fromUrl;

  if (v && !/\.(com|br|org|net)\b/i.test(v) && !/^https?:\/\//i.test(v)) {
    return v.replace(/^O\s+/i, '').slice(0, 40);
  }
  return fromUrl || v.slice(0, 40) || 'Web';
}

/**
 * Rodapé organizado p/ matéria manual com pesquisa:
 * - no conteúdo: "Fonte: Globo, UOL" (só nomes) + Foto + hashtags — sem URL
 * - em fonteCredito: lista com links para o campo Fonte/crédito
 */
function montarRodapeMateriaComFontes({
  materia,
  fontes = [],
  creditoImagem = null,
  hashtags = [],
  limitarLegenda = true,
} = {}) {
  const { body, tags } = extrairHashtagsDoTexto(removerSecaoTitulosAlternativos(materia));
  let cleanBody = removerBlocoCreditosDoCorpo(body);
  // Remove linhas soltas de URL/crédito que a IA às vezes deixa no fim
  cleanBody = cleanBody
    .replace(/(?:^|\n+)(?:Fonte|Fontes|Foto)\s*:\s*[^\n]*/gi, '\n')
    .replace(/(?:^|\n+)Por\s+[^\n]+?\s*[—\-–]\s*Site\s*:[^\n]*/gi, '\n')
    .replace(/(?:^|\n+)[•\*]\s*[^\n]+?\s*[—\-–]\s*https?:\/\/[^\n]+/gi, '\n')
    .replace(/https?:\/\/[^\s)\]>,"']+/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lista = Array.isArray(fontes) ? fontes.filter(Boolean) : [];
  const nomes = [];
  const linhasCredito = [];
  const vistosNome = new Set();
  const vistosUrl = new Set();

  for (const f of lista.slice(0, 5)) {
    const url = String(f.url || '').trim();
    const nome = nomeCurtoFonte(f.veiculo, url);
    const nomeKey = nome.toLowerCase();
    if (nome && !vistosNome.has(nomeKey)) {
      vistosNome.add(nomeKey);
      nomes.push(nome);
    }
    if (url && /^https?:\/\//i.test(url)) {
      const urlKey = url.replace(/\/$/, '').toLowerCase();
      if (!vistosUrl.has(urlKey)) {
        vistosUrl.add(urlKey);
        linhasCredito.push(`• ${nome} — ${url}`);
      }
    } else if (nome && !linhasCredito.some((l) => l === `• ${nome}`)) {
      linhasCredito.push(`• ${nome}`);
    }
  }

  const fotoRaw = limparCreditoAutor(creditoImagem);
  const foto =
    !fotoRaw || fotoRaw === CREDITO_IMAGEM_FALLBACK || /reprodu[cç][aã]o/i.test(fotoRaw)
      ? 'Reprodução'
      : fotoRaw;

  const parts = [];
  if (cleanBody) parts.push(cleanBody);
  if (nomes.length) {
    parts.push(`Fonte: ${nomes.join(', ')}`);
  }
  parts.push(`Foto: ${foto}`);

  const tagLine = formatHashtagsLine(
    Array.isArray(hashtags) && hashtags.length ? hashtags : tags
  );
  if (tagLine) parts.push(tagLine);
  const textoCompleto = parts.join('\n\n').trim();
  const materiaFinal = limitarLegenda === false
    ? textoCompleto.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : limitarLegendaInstagram(textoCompleto);

  const fonteCreditoParts = [];
  if (linhasCredito.length) {
    fonteCreditoParts.push(`Fonte:\n${linhasCredito.join('\n')}`);
  }
  fonteCreditoParts.push(`(Foto: ${foto})`);

  return {
    materia: sanitizeFacebookMentions(materiaFinal),
    fonteCredito: fonteCreditoParts.join('\n').trim().slice(0, 2000),
  };
}

function anexarCreditosFontes(
  materia,
  { fonteNome, fonteUrl, imagemAutor, autorArtigo, estilo } = {}
) {
  const { body, tags } = extrairHashtagsDoTexto(materia);
  let cleanBody = removerBlocoCreditosDoCorpo(body);

  const estiloFinal = estilo === 'jm' ? 'jm' : 'apocalipse';

  let site = String(fonteNome || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!site || /^https?:\/\//i.test(site) || /rede social|instagram|facebook/i.test(site)) {
    site = nomeSiteDeUrl(fonteUrl || site) || site;
  } else if (/^https?:\/\//i.test(String(fonteUrl || ''))) {
    if (/^(site|fonte|not[ií]cia|post|link)$/i.test(site)) {
      site = nomeSiteDeUrl(fonteUrl) || site;
    }
  }

  const fonteEhRedeSocial =
    /(?:instagram|facebook|fb\.watch|tiktok|twitter|x|youtube|youtu\.be)\./i.test(
      String(fonteUrl || '')
    );
  const usarAutorSite =
    estiloFinal === 'jm' ||
    (/^https?:\/\//i.test(String(fonteUrl || '')) && !fonteEhRedeSocial);

  let bloco;
  if (usarAutorSite) {
    bloco = montarFonteCredito({
      veiculo: site,
      host: fonteUrl,
      autorArtigo,
      estilo: 'jm',
      tipoPublicacao: 'foto',
      imagemOrigem: {
        tipo: /pexels/i.test(String(imagemAutor || '')) ? 'pexels' : 'fonte',
        autor:
          imagemAutor && !/reprodu[cç][aã]o/i.test(String(imagemAutor))
            ? imagemAutor
            : null,
      },
    });
  } else {
    const linhas = [];
    // Evita @menção no crédito (FB limita a mesma menção a 1×/dia).
    const siteSafe = sanitizeFacebookMentions(site);
    const imgCredito = limparCreditoAutor(imagemAutor);
    const imgNorm = String(imgCredito || '')
      .toLocaleLowerCase('pt-BR')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const siteNorm = String(siteSafe || '')
      .toLocaleLowerCase('pt-BR')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (siteSafe) linhas.push(`• Conteúdo: ${siteSafe}`);
    // Não repetir o mesmo nome do site na linha de imagem
    const imgFinal =
      siteNorm && imgNorm && (imgNorm === siteNorm || imgNorm.includes(siteNorm) || siteNorm.includes(imgNorm))
        ? CREDITO_IMAGEM_FALLBACK
        : imgCredito;
    linhas.push(`• Imagem: ${imgFinal}`);
    bloco = `Fontes:\n${linhas.join('\n')}`;
  }

  if (!bloco) return anexarHashtagsAoFinal(cleanBody, tags);
  return sanitizeFacebookMentions(anexarHashtagsAoFinal(`${cleanBody}\n\n${bloco}`, tags));
}

function limparCreditoAutor(value) {
  const v = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!v || /^reprodu[cç][aã]o(\/internet)?$/i.test(v) || /^internet$/i.test(v)) {
    return CREDITO_IMAGEM_FALLBACK;
  }
  return v.slice(0, 80);
}

function normalizarNomeFonte(value) {
  return String(value || '')
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(?:com|br|org|net|online)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function nomeFontePrincipal({ fonteNome, fonteUrl } = {}) {
  const pelaUrl = nomeSiteDeUrl(fonteUrl);
  if (pelaUrl) return pelaUrl;
  const nome = String(fonteNome || '').replace(/\s+/g, ' ').trim();
  return nome && nome.length <= 80 ? nome : null;
}

/** Garante a origem jornalística no conteúdo sem tocar no crédito da imagem. */
function garantirFonteNoConteudo(materia, { fonteNome, fonteUrl } = {}) {
  const fonte = nomeFontePrincipal({ fonteNome, fonteUrl });
  if (!fonte) return String(materia || '').trim();

  const { body, tags } = extrairHashtagsDoTexto(materia);
  let cleanBody = String(body || '').trim();
  const fonteNorm = normalizarNomeFonte(fonte);

  const linhaFonte = cleanBody.match(/^Fonte:\s*(.+)$/im);
  if (linhaFonte) {
    const atualNorm = normalizarNomeFonte(linhaFonte[1]);
    if (fonteNorm && !atualNorm.includes(fonteNorm) && !fonteNorm.includes(atualNorm)) {
      cleanBody = cleanBody.replace(/^Fonte:\s*(.+)$/im, `Fonte: ${fonte}, $1`);
    }
    return anexarHashtagsAoFinal(cleanBody, tags);
  }

  const linhaSite = cleanBody.match(/^(Por\s+[^\n]+?\s*[—\-–]\s*Site:\s*)([^\n]+)$/im);
  if (linhaSite) {
    const atualNorm = normalizarNomeFonte(linhaSite[2]);
    if (fonteNorm && !atualNorm.includes(fonteNorm) && !fonteNorm.includes(atualNorm)) {
      cleanBody = cleanBody.replace(
        /^(Por\s+[^\n]+?\s*[—\-–]\s*Site:\s*)([^\n]+)$/im,
        `$1${fonte}`
      );
    }
    return anexarHashtagsAoFinal(cleanBody, tags);
  }

  const blocoFontes = cleanBody.match(/Fontes:\s*\n(?:[•\-*].+\n?)*/i);
  if (blocoFontes) {
    const atualNorm = normalizarNomeFonte(blocoFontes[0]);
    if (fonteNorm && !atualNorm.includes(fonteNorm) && !fonteNorm.includes(atualNorm)) {
      cleanBody = cleanBody.replace(
        /Fontes:\s*\n/i,
        `Fontes:\n• Conteúdo: ${fonte}\n`
      );
    }
    return anexarHashtagsAoFinal(cleanBody, tags);
  }

  const novaLinha = `Fonte: ${fonte}`;
  if (/^(?:\(Foto|Foto):\s*/im.test(cleanBody)) {
    cleanBody = cleanBody.replace(/^(?=(?:\(Foto|Foto):\s*)/im, `${novaLinha}\n`);
  } else {
    cleanBody = `${cleanBody}\n\n${novaLinha}`.trim();
  }
  return anexarHashtagsAoFinal(cleanBody, tags);
}

/**
 * Substitui exclusivamente o crédito visual. Linhas de Fonte/Fontes e URLs são
 * tratadas como dados imutáveis neste fluxo. Também repara créditos de foto
 * duplicados ou colados na mesma linha da fonte por versões antigas.
 */
function atualizarSomenteCreditoDaImagem(texto, imagemAutor, { parentetico = false } = {}) {
  const original = String(texto || '').replace(/\r\n/g, '\n').trim();
  if (imagemAutor == null || String(imagemAutor).trim() === '') return original || null;

  const credito = limparCreditoAutor(imagemAutor);
  const foto = credito === CREDITO_IMAGEM_FALLBACK ? 'Reprodução' : credito;
  const tinhaParentetico = /\(Foto:\s*[^)]+\)/i.test(original);
  const tinhaImagemEmLista = /^\s*[•*\-]\s*Imagem\s*:/im.test(original);
  const linhaFoto = tinhaImagemEmLista
    ? `• Imagem: ${credito}`
    : parentetico || tinhaParentetico
      ? `(Foto: ${foto})`
      : `Foto: ${foto}`;
  const saida = [];
  let inserido = false;

  for (const linhaOriginal of original.split('\n')) {
    const linha = String(linhaOriginal || '');
    if (/^\s*[•*\-]\s*Imagem\s*:/i.test(linha) || /^\s*\(?Foto\s*:/i.test(linha)) {
      if (!inserido) {
        saida.push(linhaFoto);
        inserido = true;
      }
      continue;
    }

    // Corrige: "Fonte: ... Foto: Reprodução Foto: Reprodução" sem tocar no
    // texto que vem antes do primeiro crédito visual.
    const fotoColada = linha.search(/\s+\(?Foto\s*:/i);
    if (fotoColada >= 0) {
      const prefixo = linha.slice(0, fotoColada).trimEnd();
      if (prefixo) saida.push(prefixo);
      if (!inserido) {
        saida.push(linhaFoto);
        inserido = true;
      }
      continue;
    }
    saida.push(linha);
  }

  if (!inserido) {
    let indice = saida.findIndex((linha) => /^\s*(?:#|Siga\s+o\s+JM\s+Not[ií]cia)/i.test(linha));
    if (indice < 0) indice = saida.length;
    saida.splice(indice, 0, linhaFoto, '');
  }

  return saida
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 12000) || null;
}

/** Repara registros antigos com duas linhas Foto sem escolher uma fonte nova. */
function normalizarCreditosImagemDuplicados(texto) {
  const original = String(texto || '').replace(/\r\n/g, '\n').trim();
  const marcadores = original.match(/\(?Foto\s*:|^[ \t]*[•*\-][ \t]*Imagem\s*:/gim) || [];
  if (marcadores.length <= 1) return original || null;

  const matchFoto = original.match(
    /\(?Foto\s*:\s*(.*?)(?=\s+\(?Foto\s*:|\)?(?:\s*$|\n))/i
  );
  const matchImagem = original.match(/^[ \t]*[•*\-][ \t]*Imagem\s*:\s*([^\n]+)/im);
  const credito = String(matchFoto?.[1] || matchImagem?.[1] || CREDITO_IMAGEM_FALLBACK)
    .replace(/\)\s*$/, '')
    .trim();
  return atualizarSomenteCreditoDaImagem(original, credito, {
    parentetico: /\(Foto\s*:/i.test(original),
  });
}

/** Mantém o campo de fontes byte a byte e altera somente Foto/Imagem. */
function atualizarFonteCreditoDaImagem(fonteCredito, imagemAutor) {
  return atualizarSomenteCreditoDaImagem(fonteCredito, imagemAutor, { parentetico: true });
}

/** Mantém a fonte jornalística no conteúdo e altera somente a linha Foto. */
function atualizarCreditoImagemNaMateria(materia, imagemAutor) {
  return atualizarSomenteCreditoDaImagem(materia, imagemAutor, { parentetico: false });
}

/**
 * Parte das diretrizes que NUNCA muda entre matérias. Fica no início do system
 * para o cache de prompt do Claude poder reaproveitá-la (leitura de cache custa
 * 10% do token de entrada). Não coloque nada sorteado aqui.
 */
function blocoRegrasFacebookBase() {
  return `
DIRETRIZES FACEBOOK + INSTAGRAM / MINIMATÉRIA:
- Fonte longa → condensar preservando dados principais. Fonte curta → ampliar SÓ com fatos das fontes de apuração / internet documentadas.
- NÃO copie a fonte inteira nem frases longas: reescreva com estrutura e palavras próprias (anti-plágio).
- FALAS LITERAIS: no máximo 3 falas literais entre aspas ("…"), cada uma em parágrafo próprio de até 2 linhas (~90 caracteres), só as importantes para o contexto — SOMENTE se estiverem documentadas na apuração.
- NÃO invente fatos, números, datas, igrejas, pastores, locais, cargos nem declarações.
- Se um detalhe NÃO estiver nas fontes documentadas: omita ou generalize (“segundo informações divulgadas”) — nunca preencha com “conhecimento geral” duvidoso.
- Sem clickbait, sem pedir like/compartilhar/"não perca"/"assista até o final".
- Formato: de 3 a 6 parágrafos conforme a densidade dos fatos, separados por linha em branco (\\n\\n), sem repetição ou preenchimento artificial.
- Gancho forte nos primeiros ~120 caracteres (quem + fato).
- 3 a 5 hashtags no campo hashtags, SEM espaços internos, sem # no valor.
- Muletas PROIBIDAS: ${FRASES_PROIBIDAS_IA.slice(0, 22).map((f) => `"${f}"`).join(', ')}…
- FECHAMENTO: no fato jornalístico — PROIBIDO oração / “Que Deus…” / “Seguimos em oração” / “Amém” nas últimas linhas.
- NÃO inclua bloco Fontes:/Fonte: no corpo — o sistema anexa créditos uma única vez.

${blocoEstiloNewsGospel()}`;
}

/** Parte que muda a cada matéria: faixa de tamanho sorteada e volume da fonte. */
function blocoRegrasFacebookVariavel(faixa, volumeFonte = 'media') {
  return `ALVO DESTA MATÉRIA:
- Meta de tamanho: SEMPRE o máximo útil do feed (${faixa.min}–${faixa.max} chars no corpo; teto ${MAX_MATERIA_CHARS} com créditos/hashtags).

${blocoRegraTamanhoAdaptativo(faixa, volumeFonte)}`;
}

/** Mantido para quem monta o prompt num bloco só (caminho DeepSeek). */
function blocoRegrasFacebook(faixa, volumeFonte = 'media') {
  return `${blocoRegrasFacebookVariavel(faixa, volumeFonte)}

${blocoRegrasFacebookBase()}`;
}

function mensagemAvisoQualidade(avaliacao) {
  if (avaliacao.curto) {
    return `Texto com ${avaliacao.chars} caracteres (alvo mín. ~${avaliacao.min}). Complemente antes de publicar.`;
  }
  if (avaliacao.longo) {
    return `Texto com ${avaliacao.chars} caracteres (alvo máx. ~${avaliacao.max} para melhor alcance no feed). Enxugue antes de publicar.`;
  }
  return null;
}

module.exports = {
  INSTAGRAM_CAPTION_MAX_CHARS,
  MAX_MATERIA_CHARS,
  FAIXA_CORPO_FB,
  FONTE_CURTA_CHARS,
  FONTE_LONGA_CHARS,
  FRASES_PROIBIDAS_IA,
  sortearFaixaChars,
  classificarVolumeFonte,
  blocoRegraTamanhoAdaptativo,
  sortearEstiloLead,
  sortearEstiloTitulo,
  sortearVozRedator,
  sortearTemperatura,
  contarChars,
  cortarTextoComSeguranca,
  limitarLegendaInstagram,
  avaliarComprimentoFb,
  detectarMuletasIa,
  removerComentariosEditoriaisIa,
  removerSecaoTitulosAlternativos,
  detectarCitacoesInventadas,
  titulosParecidos,
  mesmaNoticiaEstrita,
  mesmoAssuntoNoticia,
  tokensAssunto,
  normalizarBusca,
  blocoRegrasFacebook,
  blocoRegrasFacebookBase,
  blocoRegrasFacebookVariavel,
  blocoEstiloNewsGospel,
  blocoCriteriosMateriaManual,
  blocoEstiloJmNoticia,
  pareceFormatoJmNoticia,
  mensagemAvisoQualidade,
  formatFacebookCaption,
  sanitizeFacebookMentions,
  montarFonteCredito,
  nomeCurtoFonte,
  estiloCreditoDaPagina,
  limparAutorArtigo,
  quebrarEmParagrafos,
  fundirParagrafosIncompletos,
  formatHashtagsLine,
  anexarHashtagsAoFinal,
  anexarCreditosFontes,
  montarRodapeMateriaComFontes,
  converterCreditosParaJm,
  garantirFonteNoConteudo,
  atualizarFonteCreditoDaImagem,
  atualizarCreditoImagemNaMateria,
  normalizarCreditosImagemDuplicados,
  extrairAutorImagemHeuristico,
  limparCreditoAutor,
  materiaJaTemCredito,
  removerFechamentoOracao,
  removerBlocoCreditosDoCorpo,
  CREDITO_IMAGEM_FALLBACK,
  extrairHashtagsDoTexto,
};
