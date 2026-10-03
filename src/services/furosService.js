/**
 * Furos do dia: acha no Google News as notícias mais quentes de um nicho,
 * ordena pelo potencial de repercussão e gera matérias próprias (modo furo),
 * já com imagem e crédito, prontas para revisar e postar no Facebook.
 *
 * Reaproveita o radar de pautas (busca + agrupamento por assunto + pautas já
 * usadas) e o gerador de matérias por link. Aqui ficam só os nichos, a
 * pontuação e a orquestração.
 */

const NICHOS = Object.freeze([
  {
    id: 'politica',
    rotulo: 'Política',
    consultas: ['Congresso Nacional votação', 'STF decisão ministro', 'Senado aprova projeto', 'Câmara dos Deputados votação', 'governo Lula', 'Bolsonaro'],
    palavras: ['politica', 'stf', 'congresso', 'senado', 'camara', 'deputado', 'senador', 'lula', 'bolsonaro', 'eleicao', 'eleicoes', 'governo', 'ministro', 'planalto', 'tse', 'pec', 'medida provisoria'],
  },
  {
    id: 'politica-fe',
    rotulo: 'Política e fé',
    consultas: ['bancada evangélica', 'política evangélicos', 'frente parlamentar evangélica', 'deputado pastor', 'voto evangélico eleição', 'liberdade religiosa projeto'],
    palavras: ['bancada evangelica', 'frente parlamentar evangelica', 'evangelicos', 'evangelico', 'voto evangelico', 'liberdade religiosa', 'pastor', 'cristaos'],
  },
  {
    id: 'igreja',
    rotulo: 'Igreja',
    consultas: ['igreja evangélica', 'Assembleia de Deus', 'Igreja Universal', 'igreja batista', 'igreja culto polêmica', 'templo igreja'],
    palavras: ['igreja', 'igrejas', 'assembleia de deus', 'universal', 'batista', 'presbiteriana', 'denominacao', 'culto', 'templo', 'fieis', 'evangelica', 'evangelicos'],
  },
  {
    id: 'pastores',
    rotulo: 'Pastores',
    consultas: ['pastor polêmica', 'pastor evangélico', 'pastora', 'Silas Malafaia', 'bispo evangélico', 'apóstolo igreja'],
    palavras: ['pastor', 'pastora', 'apostolo', 'bispo', 'missionaria', 'missionario', 'lider evangelico', 'malafaia', 'pregador', 'pregadora'],
  },
  {
    id: 'gospel',
    rotulo: 'Música gospel',
    consultas: ['cantor gospel', 'cantora gospel', 'música gospel', 'louvor gospel', 'show gospel', 'gospel lançamento'],
    // "gospel" sozinho não serve: todo portal do nicho usa a palavra. Aqui
    // valem só termos do universo musical.
    palavras: ['cantor', 'cantora', 'louvor', 'musica', 'adoracao', 'banda', 'album', 'clipe', 'single', 'show'],
  },
  {
    id: 'catolicos',
    rotulo: 'Igreja Católica',
    consultas: ['Papa Vaticano', 'Igreja Católica padre', 'Papa Leão XIV', 'CNBB', 'bispo católico', 'padre polêmica'],
    palavras: ['papa', 'vaticano', 'catolica', 'catolico', 'catolicos', 'padre', 'cardeal', 'cnbb', 'leao xiv', 'nossa senhora', 'missa'],
  },
  {
    id: 'israel',
    rotulo: 'Israel e cristãos no mundo',
    consultas: ['Israel guerra', 'cristãos perseguidos', 'Israel Gaza', 'Jerusalém', 'perseguição religiosa', 'Oriente Médio conflito'],
    palavras: ['israel', 'israelense', 'jerusalem', 'gaza', 'hamas', 'perseguidos', 'perseguicao', 'cristaos', 'oriente medio'],
  },
  {
    id: 'policia',
    rotulo: 'Polícia e justiça',
    consultas: ['Polícia Federal operação', 'preso suspeito investigação', 'Polícia Civil prende', 'operação policial', 'condenado pela Justiça', 'crime investigação'],
    palavras: ['policia', 'preso', 'presos', 'prisao', 'operacao', 'investigacao', 'crime', 'condenado', 'suspeito', 'delegado'],
  },
]);

const NICHOS_PADRAO = ['politica-fe', 'igreja', 'pastores'];
const MAX_NICHOS = 4;
const MAX_PALAVRAS = 30;
// Muitas palavras-chave não viram dezenas de buscas: no Google News elas vão
// juntas, POR_GRUPO por consulta ("a" OR "b" OR …); no YouTube, que não tem
// OR confiável, cada busca usa algumas e o rodízio cobre o resto nas próximas.
const PALAVRAS_POR_GRUPO = 4;
const PALAVRAS_NO_YOUTUBE = 8;

// Palavras que não identificam assunto ("a", "de", "para"…): ficam fora do
// filtro da palavra-chave, senão qualquer notícia passaria.
const PALAVRAS_VAZIAS = new Set([
  'que', 'com', 'para', 'por', 'dos', 'das', 'nos', 'nas', 'uma', 'umas', 'uns', 'sobre', 'entre', 'ate', 'mais', 'como', 'sem', 'ser',
]);

/**
 * Palavras-chave digitadas pelo editor: aceita lista ou texto separado por
 * vírgula/linha, sem repetir, até MAX_PALAVRAS de no máximo 60 caracteres.
 */
function palavrasValidas(entrada) {
  const lista = Array.isArray(entrada) ? entrada : String(entrada || '').split(/[,;\n]/);
  const vistas = new Set();
  const saida = [];
  for (const bruta of lista) {
    const palavra = String(bruta || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const chave = normalizar(palavra);
    if (chave.length < 2 || vistas.has(chave)) continue;
    vistas.add(chave);
    saida.push(palavra);
    if (saida.length >= MAX_PALAVRAS) break;
  }
  return saida;
}

/**
 * A palavra-chave vira um "nicho" de uma busca só: as mesmas fontes (Google
 * News, portais, YouTube, redes) procuram por ela, e a pauta só conta como do
 * assunto se citar todos os termos dela ("Silas Malafaia" exige os dois).
 */
/** Grupos de palavras-chave buscados juntos no Google News (operador OR). */
function gruposDePalavras(nichosDePalavra) {
  const grupos = [];
  for (let i = 0; i < nichosDePalavra.length; i += PALAVRAS_POR_GRUPO) {
    const membros = nichosDePalavra.slice(i, i + PALAVRAS_POR_GRUPO);
    const termos = membros.map((n) => (n.rotulo.includes(' ') ? `"${n.rotulo}"` : n.rotulo));
    grupos.push({
      rotulo: `__palavras-${grupos.length}`,
      consultas: [termos.join(' OR ')],
      membros,
    });
  }
  return grupos;
}

/** Palavras que vão ao YouTube nesta busca: rodízio a cada 10 min. */
function palavrasDaVezNoYoutube(nichosDePalavra, agora = Date.now()) {
  if (nichosDePalavra.length <= PALAVRAS_NO_YOUTUBE) return nichosDePalavra;
  const voltas = Math.ceil(nichosDePalavra.length / PALAVRAS_NO_YOUTUBE);
  const inicio = (Math.floor(agora / 600_000) % voltas) * PALAVRAS_NO_YOUTUBE;
  return nichosDePalavra.slice(inicio, inicio + PALAVRAS_NO_YOUTUBE);
}

function nichoDaPalavra(palavra, indice) {
  const chave = normalizar(palavra);
  const termos = chave.split(' ').filter((t) => t.length >= 3 && !PALAVRAS_VAZIAS.has(t));
  const consultas = chave.includes(' ') ? [palavra, `"${palavra}"`] : [palavra];
  return {
    id: `palavra-${indice}`,
    rotulo: palavra,
    consultas,
    palavras: termos.length ? termos : [chave],
    exigeTodas: true,
    palavraChave: true,
  };
}

/**
 * Palavras que costumam indicar notícia de alta repercussão no feed. Pesam
 * junto com a quantidade de veículos cobrindo o assunto e a atualidade.
 */
const GATILHOS = [
  { rotulo: 'Polêmica', peso: 12, termos: ['polemica', 'polemico', 'critica', 'critico', 'revolta', 'repercute', 'repercussao', 'viraliza', 'viralizou'] },
  { rotulo: 'Denúncia', peso: 14, termos: ['denuncia', 'escandalo', 'acusa', 'acusado', 'acusacao', 'fraude', 'desvio', 'investigado', 'investigacao'] },
  { rotulo: 'Justiça', peso: 12, termos: ['preso', 'prisao', 'condenado', 'condenacao', 'stf', 'pf', 'operacao', 'mandado', 'inquerito', 'cassado', 'cassacao'] },
  { rotulo: 'Tragédia', peso: 10, termos: ['morre', 'morte', 'morto', 'mortos', 'tragedia', 'acidente', 'ataque', 'atentado'] },
  { rotulo: 'Reviravolta', peso: 10, termos: ['revela', 'exclusivo', 'inedito', 'reviravolta', 'rompe', 'renuncia', 'demitido', 'afastado', 'expulso'] },
  { rotulo: 'Disputa', peso: 8, termos: ['briga', 'bate-boca', 'rebate', 'responde', 'ataca', 'confronto', 'embate', 'processa'] },
  { rotulo: 'Urgente', peso: 8, termos: ['urgente', 'agora', 'ultima hora', 'alerta'] },
];

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contemTermo(textoNormalizado, termo) {
  return new RegExp(`(^|\\s)${termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(textoNormalizado);
}

function timestampDoItem(item) {
  const ts = Number(item?.dataTimestamp) || Date.parse(String(item?.data || '')) || 0;
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

/**
 * Nota de 0 a 100 e os motivos em linguagem simples, para o editor entender
 * por que a pauta subiu na lista.
 */
function pontuarBomba(item, agora = Date.now()) {
  const texto = normalizar(`${item?.titulo || ''} ${item?.resumo || ''}`);
  const motivos = [];
  let pontos = 0;

  const veiculos = Math.max(Number(item?.contagemFontes) || 0, (item?.veiculos || []).length, 1);
  pontos += Math.min(veiculos - 1, 6) * 6;
  if (veiculos >= 2) motivos.push(`${veiculos} veículos`);

  if (item?.sinalGoogleNews || item?.emAlta || item?.sinalTrends) {
    pontos += 12;
    motivos.push('Em alta no Google');
  }
  if (item?.sinalRedes || item?.redeSocial) {
    pontos += 6;
    motivos.push('Repercute nas redes');
  }

  for (const gatilho of GATILHOS) {
    if (gatilho.termos.some((termo) => contemTermo(texto, termo))) {
      pontos += gatilho.peso;
      motivos.push(gatilho.rotulo);
    }
  }

  const ts = timestampDoItem(item);
  if (ts) {
    const horas = (agora - ts) / 3_600_000;
    if (horas <= 3) {
      pontos += 14;
      motivos.push('Últimas 3h');
    } else if (horas <= 8) {
      pontos += 9;
    } else if (horas <= 24) {
      pontos += 4;
    }
  }

  return { score: Math.max(0, Math.min(100, Math.round(pontos))), motivos: motivos.slice(0, 4) };
}

/**
 * O Google devolve, para "pastor polêmica", até notícia de celebridade sem
 * pastor nenhum. Pauta que não cita o nicho vai para o fim da fila.
 */
function pertenceAoNicho(item, nicho) {
  if (!nicho) return true;
  const texto = normalizar(`${item?.titulo || ''} ${item?.resumo || ''}`);
  const cita = (palavra) => comecaCom(texto, palavra);
  return nicho.exigeTodas ? nicho.palavras.every(cita) : nicho.palavras.some(cita);
}

/** Palavra do nicho como prefixo: "pastor" também pega "pastores" e "pastora". */
function comecaCom(textoNormalizado, prefixo) {
  return new RegExp(`(^|\\s)${prefixo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(textoNormalizado);
}

function comPrazo(promessa, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promessa).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const EH_LINK_GOOGLE = /news\.google\.com/i;

/**
 * Os links do Google News não redirecionam mais para a matéria. A busca em
 * Python devolve os endereços reais; com as mesmas consultas do nicho, ela
 * vira um índice título → link para casar com as pautas do radar.
 */
async function indiceDeLinksDiretos(consultas, horas) {
  const nr = require('./newsResearch');
  const when = horas <= 24 ? '1d' : '2d';
  const listas = await Promise.all(
    consultas.map((consulta) => comPrazo(nr.buscarGoogleNewsPython(consulta, { when, limit: 20 }), 20_000))
  );
  return listas
    .flat()
    .filter((item) => item?.titulo && /^https?:\/\//i.test(String(item.link || '')) && !EH_LINK_GOOGLE.test(item.link));
}

/**
 * Prefere a matéria do mesmo veículo. Se só achar a notícia em outro site,
 * devolve esse veículo junto: fonte e foto precisam citar a mesma matéria.
 */
async function linkDiretoPeloTitulo(furo, indice) {
  const nr = require('./newsResearch');
  const mesmoVeiculo = (item) => normalizar(item.veiculo) === normalizar(furo.veiculo);
  const escolher = (lista) => {
    const parecidos = (lista || []).filter(
      (item) => !EH_LINK_GOOGLE.test(String(item.link || '')) && nr.titulosSimilares(item.titulo, furo.titulo)
    );
    return parecidos.find(mesmoVeiculo) || parecidos[0] || null;
  };
  const achado = escolher(indice)
    || escolher(await comPrazo(nr.buscarGoogleNewsPython(furo.titulo, { when: '2d', limit: 5 }), 15_000));
  return achado ? { url: achado.link, veiculo: String(achado.veiculo || '').trim() || null } : null;
}

/**
 * Só para as pautas que vão aparecer: troca o link do Google pelo da matéria
 * e lê a og:image. Com prazo curto; sem foto, a pauta continua valendo.
 */
async function completarLinkEImagem(furo, indice) {
  const { extrairMetadadosImagemArtigo } = require('./articleSource');
  const direto = EH_LINK_GOOGLE.test(furo.url)
    ? await comPrazo(linkDiretoPeloTitulo(furo, indice), 18_000)
    : { url: furo.url, veiculo: null };
  if (!direto?.url) return furo;
  const completo = { ...furo, url: direto.url };
  if (direto.veiculo && normalizar(direto.veiculo) !== normalizar(furo.veiculo)) {
    completo.veiculos = [...new Set([direto.veiculo, furo.veiculo, ...(furo.veiculos || [])])].slice(0, 5);
    completo.veiculo = direto.veiculo;
    // A foto encontrada pelo radar era do outro veículo; lê a da matéria nova.
    completo.imagem = null;
  }
  if (!completo.imagem) {
    const meta = await comPrazo(extrairMetadadosImagemArtigo(completo.url), 9_000);
    if (/^https?:\/\//i.test(String(meta?.imagem || ''))) completo.imagem = String(meta.imagem);
  }
  return completo;
}

/** Roda `tarefa` em todos os itens com no máximo `limite` ao mesmo tempo. */
async function emLotes(itens, limite, tarefa) {
  const saida = new Array(itens.length);
  let proximo = 0;
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (proximo < itens.length) {
      const atual = proximo;
      proximo += 1;
      saida[atual] = await tarefa(itens[atual]);
    }
  });
  await Promise.all(trabalhadores);
  return saida;
}

/**
 * Reparte as vagas entre os nichos escolhidos, do mais quente para o menos
 * quente em cada um. Sem isso, um nicho movimentado ocupava a lista inteira.
 */
function repartirPorNicho(itens, rotulos, limite) {
  const filas = new Map(rotulos.map((rotulo) => [rotulo, []]));
  const sobra = [];
  for (const item of itens) (filas.get(item.nicho) || sobra).push(item);
  const escolhidos = [];
  while (escolhidos.length < limite && [...filas.values()].some((fila) => fila.length)) {
    for (const fila of filas.values()) {
      if (escolhidos.length >= limite) break;
      if (fila.length) escolhidos.push(fila.shift());
    }
  }
  for (const item of sobra) {
    if (escolhidos.length >= limite) break;
    escolhidos.push(item);
  }
  return escolhidos;
}

function nichosValidos(ids) {
  const conhecidos = new Set(NICHOS.map((n) => n.id));
  return [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => conhecidos.has(id)))]
    .slice(0, MAX_NICHOS);
}

/**
 * "Automático": os nichos que mais aparecem nas matérias recentes da conta.
 * Sem histórico suficiente, usa o foco padrão do produto.
 */
async function escolherNichosAutomaticos(userId) {
  let materias = [];
  try {
    const AiMatters = require('../models/AiMatters');
    materias = await AiMatters.findByUser(userId, 80);
  } catch (err) {
    console.warn('[furos] histórico indisponível:', err.message);
  }

  const contagem = new Map(NICHOS.map((n) => [n.id, 0]));
  for (const materia of materias) {
    const texto = normalizar(`${materia.titulo || ''} ${materia.hashtags || ''}`);
    for (const nicho of NICHOS) {
      if (nicho.palavras.some((palavra) => comecaCom(texto, palavra))) {
        contagem.set(nicho.id, contagem.get(nicho.id) + 1);
      }
    }
  }

  const ordenados = [...contagem.entries()]
    .filter(([, total]) => total >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => id);
  return ordenados.length ? ordenados : [...NICHOS_PADRAO];
}

function listarNichos() {
  return NICHOS.map(({ id, rotulo }) => ({ id, rotulo }));
}

const CANAIS = ['noticias', 'youtube', 'instagram', 'facebook'];

/** Períodos aceitos, em horas. 3h é o "Recente" da tela. */
const JANELAS_HORAS = [3, 8, 12, 24, 48];

function canaisValidos(canais) {
  const lista = [...new Set((Array.isArray(canais) ? canais : []).map(String).filter((c) => CANAIS.includes(c)))];
  return lista.length ? lista : [...CANAIS];
}

/**
 * Ordem de entrada dos itens das redes: alterna YouTube, Instagram e
 * Facebook e, dentro de cada rede, reparte entre os nichos.
 */
function alternarRedes(sociais, rotulos) {
  const porCanal = new Map();
  for (const item of sociais) {
    if (!porCanal.has(item.canal)) porCanal.set(item.canal, []);
    porCanal.get(item.canal).push(item);
  }
  for (const [canal, fila] of porCanal) {
    const comNicho = fila.filter((i) => i.nicho);
    const semNicho = fila.filter((i) => !i.nicho);
    porCanal.set(canal, [...repartirPorNicho(comNicho, rotulos, comNicho.length), ...semNicho]);
  }
  const alternados = [];
  while ([...porCanal.values()].some((fila) => fila.length)) {
    for (const fila of porCanal.values()) if (fila.length) alternados.push(fila.shift());
  }
  return alternados;
}

/**
 * Junta as notícias dos portais do nicho às do Google News. A mesma história
 * vira uma pauta só (mais veículos = nota maior) e, quando o Google só tinha o
 * link dele, passa a usar o link direto e a foto do portal.
 */
const NICHOS_GENERICOS_DE_PORTAL = ['igreja', 'pastores', 'politica-fe'];

function mesclarPortais(pontuados, itensPortal, selecionados, agora) {
  const { titulosSimilares } = require('./newsResearch');
  // A nota das pautas do Google já inclui sinais que não ficam guardados
  // (ex.: "Em alta no Google"); por isso a fusão só soma, não recalcula.
  const somarMotivo = (alvo, motivo, substituir = null) => {
    const resto = (alvo.motivos || []).filter((m) => m !== motivo && !(substituir && substituir.test(m)));
    alvo.motivos = [motivo, ...resto].slice(0, 4);
  };
  const somarVeiculo = (alvo, veiculo) => {
    const antes = new Set([alvo.veiculo, ...(alvo.veiculos || [])].filter(Boolean));
    if (!veiculo || antes.has(veiculo)) return;
    alvo.veiculos = [...antes, veiculo].slice(0, 5);
    alvo.score = Math.min(100, alvo.score + 6);
    somarMotivo(alvo, `${antes.size + 1} veículos`, /^\d+ veículos$/);
  };
  const marcarPortalDoNicho = (alvo) => {
    if ((alvo.motivos || []).includes('Portal do nicho')) return;
    alvo.score = Math.min(100, alvo.score + 6);
    somarMotivo(alvo, 'Portal do nicho');
  };

  const novos = [];
  for (const item of itensPortal) {
    // Portal geral (CNN, Metrópoles…) publica de tudo: o nicho precisa estar
    // no título. No portal gospel, título ou resumo bastam; sem palavra-chave,
    // a notícia só entra num nicho genérico, nunca em Música gospel ou Israel.
    const texto = item.especializado ? item : { titulo: item.titulo };
    const nicho =
      selecionados.find((n) => pertenceAoNicho(texto, n)) ||
      // Portal internacional não tem essa folga: sem citar o nicho, fica de fora.
      (item.especializado && !item.internacional
        ? selecionados.find((n) => NICHOS_GENERICOS_DE_PORTAL.includes(n.id) && item.portalNichos.includes(n.id))
        : null);
    if (!nicho) continue;

    const existente = [...pontuados, ...novos].find((p) => titulosSimilares(p.titulo, item.titulo));
    if (existente) {
      const linkDoGoogle = EH_LINK_GOOGLE.test(existente.url);
      somarVeiculo(existente, item.veiculo);
      if (linkDoGoogle) {
        // Link, veículo e foto passam juntos para o portal: o crédito precisa
        // citar a mesma matéria de onde veio a foto.
        existente.url = item.link;
        existente.veiculo = item.veiculo;
        existente.imagem = item.imagem || null;
      }
      if (item.especializado) marcarPortalDoNicho(existente);
      continue;
    }

    const { score, motivos } = pontuarBomba(item, agora);
    const novo = {
      canal: 'noticias',
      noNicho: true,
      titulo: item.titulo,
      url: item.link,
      veiculo: item.veiculo,
      veiculos: [item.veiculo],
      resumo: item.resumo,
      imagem: item.imagem,
      data: item.data,
      dataTimestamp: item.dataTimestamp,
      nicho: nicho.rotulo,
      score,
      motivos,
    };
    if (item.especializado) marcarPortalDoNicho(novo);
    novos.push(novo);
  }

  return [...pontuados, ...novos].sort((a, b) => b.score - a.score);
}

/** Título claramente em espanhol (o YouTube mistura mesmo com idioma pt). */
function pareceEspanhol(titulo) {
  const t = String(titulo || '');
  return !/[ãõç]/i.test(t) && /\b(por el|del|los|las|en el|y la|el pastor|la iglesia)\b/i.test(t);
}

/**
 * Busca e ordena. `nichos` vazio ou ['auto'] usa a escolha automática.
 * `canais`: 'noticias' (Google News), 'youtube', 'instagram', 'facebook'.
 * `palavras`: palavras-chave do editor. Com "Automático", a busca fica só
 * nelas; com nichos marcados, procura nos dois.
 */
/**
 * `completar: false` (piloto automático) pula a troca do link do Google News
 * e a leitura da foto de cada pauta — dezenas de buscas em Python por
 * varredura. O piloto faz isso só na pauta que for escrever.
 */
async function buscarFuros({ userId, nichos = [], palavras = [], horas = 24, limite = 12, canais = [], completar = true } = {}) {
  const termos = palavrasValidas(palavras);
  const pediuAutomatico = !nichos.length || nichos.includes('auto');
  // Palavra-chave digitada com "Automático": a busca é só pelo que foi digitado.
  const soPalavras = termos.length > 0 && pediuAutomatico;
  const automatico = pediuAutomatico && !soPalavras;
  const ids = soPalavras ? [] : automatico ? await escolherNichosAutomaticos(userId) : nichosValidos(nichos);
  if (!ids.length && !termos.length) {
    const err = new Error('Escolha pelo menos um nicho ou digite uma palavra-chave.');
    err.status = 400;
    throw err;
  }

  const doNichoFixo = NICHOS.filter((n) => ids.includes(n.id));
  const rotulosFixos = new Set(doNichoFixo.map((n) => normalizar(n.rotulo)));
  const selecionados = [
    ...termos.filter((p) => !rotulosFixos.has(normalizar(p))).map(nichoDaPalavra),
    ...doNichoFixo,
  ];
  const listaCanais = canaisValidos(canais);
  const querNoticias = listaCanais.includes('noticias');
  const { radarPorTemas } = require('../routes/materiaChatExtras');
  const { buscarFurosSociais } = require('./furosSociais');
  const janela = JANELAS_HORAS.includes(Number(horas)) ? Number(horas) : 24;
  const vazio = { topicos: [], totalAnalisado: 0, totalOcultado: 0 };
  const { buscarNosPortais } = require('./portaisNichoService');
  // Busca no Google: palavras-chave em grupos (OR) + nichos fixos.
  const nichosDePalavra = selecionados.filter((n) => n.palavraChave);
  const grupos = gruposDePalavras(nichosDePalavra);
  const grupoPorRotulo = new Map(grupos.map((g) => [g.rotulo, g]));
  const temasDeBusca = [
    ...grupos.map(({ rotulo, consultas }) => ({ rotulo, consultas })),
    ...doNichoFixo.map((n) => ({ rotulo: n.rotulo, consultas: n.consultas })),
  ];
  const consultasSociais = [
    ...palavrasDaVezNoYoutube(nichosDePalavra).map((n) => ({ consulta: n.rotulo, nicho: n.rotulo })),
    ...doNichoFixo.flatMap((n) => n.consultas.slice(0, 5).map((consulta) => ({ consulta, nicho: n.rotulo }))),
  ];
  const [resultado, indiceDireto, sociais, portais] = await Promise.all([
    querNoticias
      ? radarPorTemas(
          temasDeBusca,
          // Seis buscas por nicho e sem reapurar todas as candidatas: só as que
          // vão aparecer ganham link direto e foto (completarLinkEImagem).
          { horas: janela, limite: Math.max(limite * 2, 30), userId, consultasPorTema: 6, apurar: false }
        )
      : vazio,
    querNoticias && completar
      ? indiceDeLinksDiretos(temasDeBusca.flatMap((t) => t.consultas.slice(0, 2)), janela).catch(() => [])
      : [],
    buscarFurosSociais({
      userId,
      canais: listaCanais.filter((c) => c !== 'noticias'),
      consultas: consultasSociais,
      horas: janela,
      limite,
      pontuarBomba,
    }).catch((err) => ({ itens: [], avisos: [err.message] })),
    // Portais gospel e de política lidos direto (feed/WordPress), com cache.
    querNoticias
      ? buscarNosPortais({
          // Só palavra-chave: lê todos os portais e fica com o que citar a palavra.
          nichos: soPalavras ? NICHOS.map((n) => n.id) : doNichoFixo.map((n) => n.id),
          horas: janela,
        }).catch(() => ({ itens: [], status: [] }))
      : { itens: [], status: [] },
  ]);

  const agora = Date.now();
  const nichoPorRotulo = new Map(selecionados.map((n) => [n.rotulo, n]));
  // Notícia de um grupo de palavras: fica com a palavra que ela cita.
  const temaDaNoticia = (t) => {
    const grupo = grupoPorRotulo.get(t.tema);
    if (!grupo) return { nicho: t.tema || null, noNicho: pertenceAoNicho(t, nichoPorRotulo.get(t.tema)) };
    const cita = grupo.membros.find((n) => pertenceAoNicho(t, n));
    return { nicho: (cita || grupo.membros[0]).rotulo, noNicho: Boolean(cita) };
  };
  const doGoogle = (resultado.topicos || [])
    .filter((t) => t && t.titulo && (t.link || t.url))
    .map((t) => {
      const { score, motivos } = pontuarBomba(t, agora);
      const tema = temaDaNoticia(t);
      return {
        canal: 'noticias',
        noNicho: tema.noNicho,
        titulo: String(t.titulo).replace(/\s+/g, ' ').trim().slice(0, 300),
        url: String(t.link || t.url).trim().slice(0, 1000),
        veiculo: String(t.veiculo || t.fonte || 'Web').trim().slice(0, 120),
        veiculos: (t.veiculos || []).slice(0, 5),
        resumo: String(t.resumo || t.trecho || '').replace(/\s+/g, ' ').trim().slice(0, 420),
        imagem: /^https?:\/\//i.test(String(t.imagemFonte || t.imagem || '')) ? String(t.imagemFonte || t.imagem) : null,
        data: t.data || null,
        dataTimestamp: timestampDoItem(t),
        nicho: tema.nicho,
        score,
        motivos,
      };
    })
    .sort((a, b) => b.score - a.score);
  // O radar deixa passar sem data o que o Google marca "em alta"; aqui o
  // período escolhido vale para tudo. Pauta sem data conhecida continua.
  const dentroDaJanela = (item) => !item.dataTimestamp || agora - item.dataTimestamp <= janela * 3_600_000;
  const pontuados = mesclarPortais(doGoogle, portais.itens || [], selecionados, agora).filter(dentroDaJanela);

  // Pauta que não cita o nicho é ruído do Google; só completa uma lista curta.
  const rotulos = selecionados.map((n) => n.rotulo);
  // Vídeo do YouTube que não cita o nicho no título costuma ser ruído da busca.
  // Na busca só por palavra-chave, post das páginas monitoradas (sem nicho)
  // precisa citar a palavra; senão a lista enche de post fora do assunto.
  const citaAlgumaPalavra = (item) => selecionados.some((n) => n.palavraChave && pertenceAoNicho(item, n));
  const sociaisNoNicho = (sociais.itens || []).filter(
    (item) =>
      dentroDaJanela(item) &&
      (!soPalavras || item.nicho || citaAlgumaPalavra(item)) &&
      (item.canal !== 'youtube' ||
        (!pareceEspanhol(item.titulo) && (!item.nicho || pertenceAoNicho(item, nichoPorRotulo.get(item.nicho)))))
  );
  // Redes ficam com até metade das vagas; as notícias repartem o resto entre
  // os nichos. Se faltar notícia, as redes completam a lista.
  const redesEmOrdem = alternarRedes(sociaisNoNicho, rotulos);
  const cotaRedes = querNoticias ? Math.min(redesEmOrdem.length, Math.ceil(limite * 0.5)) : Math.min(redesEmOrdem.length, limite);

  const doNicho = pontuados.filter((p) => p.noNicho);
  const foraDoNicho = pontuados.filter((p) => !p.noNicho);
  const vagasNoticias = limite - cotaRedes;
  const escolhidos = repartirPorNicho(doNicho, rotulos, vagasNoticias);
  const minimo = Math.min(vagasNoticias, 5);
  if (escolhidos.length < minimo) escolhidos.push(...foraDoNicho.slice(0, minimo - escolhidos.length));
  for (const item of escolhidos) delete item.noNicho;

  const redesEscolhidas = redesEmOrdem.slice(0, limite - escolhidos.length);
  const misturados = [...escolhidos, ...redesEscolhidas].sort((a, b) => b.score - a.score);
  const furos = completar
    ? await emLotes(misturados, 8, (furo) =>
        furo.canal === 'noticias' ? completarLinkEImagem(furo, indiceDireto) : furo
      )
    : misturados;

  const porCanal = {};
  for (const furo of furos) porCanal[furo.canal] = (porCanal[furo.canal] || 0) + 1;
  return {
    nichos: doNichoFixo.map(({ id, rotulo }) => ({ id, rotulo })),
    palavras: selecionados.filter((n) => n.palavraChave).map((n) => n.rotulo),
    canais: listaCanais,
    automatico,
    horas: janela,
    totalAnalisado:
      (Number(resultado.totalAnalisado) || 0) + (sociais.itens || []).length + (portais.itens || []).length,
    portais: (portais.status || []).map(({ nome, itens, erro }) => ({ nome, itens, erro })),
    totalOcultado: Number(resultado.totalOcultado) || 0,
    porCanal,
    avisos: sociais.avisos || [],
    furos,
  };
}

/**
 * Uma pauta → um rascunho. O front chama uma por vez para mostrar o
 * progresso e não segurar uma requisição por vários minutos.
 */
async function gerarFuro({ userId, pauta = {}, facebookPageId = null } = {}) {
  const url = String(pauta.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    const err = new Error('Pauta sem link válido.');
    err.status = 400;
    throw err;
  }

  const materiaIaService = require('./materiaIaService');
  // O gerador apura o link (texto, autor e og:image) antes de escrever e
  // mantém a imagem que o radar já encontrou quando a página não expõe outra.
  const topico = {
    link: url,
    titulo: String(pauta.titulo || '').trim().slice(0, 300) || null,
    resumo: String(pauta.resumo || '').trim().slice(0, 1200) || null,
    fonte: String(pauta.veiculo || '').trim().slice(0, 120) || null,
    veiculo: String(pauta.veiculo || '').trim().slice(0, 120) || null,
    imagemFonte: /^https?:\/\//i.test(String(pauta.imagem || '')) ? String(pauta.imagem) : null,
  };

  let pageId = facebookPageId;
  if (!pageId) {
    const { defaultPageIdForUser } = require('./facebookPageResolver');
    pageId = await defaultPageIdForUser(userId).catch(() => null);
  }

  const result = await materiaIaService.gerarCompleto({
    userId,
    topico,
    facebookPageId: pageId || null,
    tipoPublicacao: 'foto',
    status: 'rascunho',
    furoReportagem: true,
    exigirFonteDocumentada: true,
  });

  const matter = result?.matter || null;
  return {
    matterId: matter?.id || null,
    titulo: matter?.titulo || topico.titulo || 'Matéria',
    imagem: matter?.imagem_url || topico.imagemFonte || null,
    redirect: matter?.id ? `/materias-ia/${matter.id}` : '/minhas-materias',
  };
}

/* ------------------------- vídeos e posts das redes ------------------------- */

const CANAIS_DE_REDE = ['youtube', 'instagram', 'facebook'];
const geracoes = new Map();
const VALIDADE_GERACAO_MS = 2 * 60 * 60 * 1000;

function ehPautaDeRede(pauta) {
  return CANAIS_DE_REDE.includes(String(pauta?.canal || ''));
}

function limparGeracoesAntigas() {
  const limite = Date.now() - VALIDADE_GERACAO_MS;
  for (const [id, g] of geracoes) if (g.atualizadoEm < limite) geracoes.delete(id);
}

/**
 * Vídeo/post das redes vira matéria pelo mesmo fluxo do chat (transcrição +
 * redator editorial). Pode levar minutos, então roda em segundo plano e o
 * painel acompanha por `statusGeracao`.
 */
async function iniciarGeracaoDeRede({ userId, pauta = {}, facebookPageId = null, modelo = null } = {}) {
  const url = String(pauta.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    const err = new Error('Pauta sem link válido.');
    err.status = 400;
    throw err;
  }
  const deepseekService = require('./deepseekService');
  let modeloFinal = null;
  if (deepseekService.usarTokenFree('conversa')) {
    modeloFinal = await require('./materiaModelosService').resolverModelo(modelo, { estrito: true });
  }
  let pageId = facebookPageId;
  if (!pageId) {
    const { defaultPageIdForUser } = require('./facebookPageResolver');
    pageId = await defaultPageIdForUser(userId).catch(() => null);
  }

  limparGeracoesAntigas();
  const id = require('crypto').randomUUID();
  const geracao = { id, userId: Number(userId), estado: 'gerando', etapa: 'Lendo o link…', atualizadoEm: Date.now() };
  geracoes.set(id, geracao);

  setImmediate(async () => {
    try {
      const { escreverPeloChat } = require('./materiaPorChat');
      const { matterId, chatId } = await escreverPeloChat(
        { chatService: require('./materiaChatService'), comModelo: require('./tokenFreeGatewayService').comModelo },
        {
          userId,
          url,
          facebookPageId: pageId || null,
          imagemUrl: pauta.imagem,
          modelo: modeloFinal,
          origem: 'furos',
          onPasso: (texto) => {
            geracao.etapa = String(texto).slice(0, 200);
            geracao.atualizadoEm = Date.now();
          },
        }
      );
      if (pauta.bibliotecaPostId && matterId) {
        await require('../models/BibliotecaPosts')
          .update(Number(pauta.bibliotecaPostId), { status: 'rascunho', matter_id: matterId })
          .catch(() => {});
      }
      try {
        const titulo = String(pauta.titulo || '').replace(/\[\[|\]\]|\*\*/g, '').trim();
        await require('./materiaChatService').renomearConversa({
          userId,
          chatId,
          titulo: `Furo ${pauta.canal} · ${titulo}`.slice(0, 180),
        });
      } catch {
        // nome da conversa é só conveniência
      }
      Object.assign(geracao, {
        estado: matterId ? 'ok' : 'erro',
        matterId,
        redirect: matterId ? `/materias-ia/${matterId}` : null,
        erro: matterId ? null : 'A matéria não foi salva.',
      });
    } catch (err) {
      console.warn(`[furos] ${pauta.canal} ${url}:`, err.message);
      Object.assign(geracao, { estado: 'erro', erro: err.message || 'Falha ao escrever a matéria.' });
    } finally {
      geracao.atualizadoEm = Date.now();
    }
  });

  return { jobId: id, estado: geracao.estado, etapa: geracao.etapa };
}

function statusGeracao(userId, jobId) {
  const g = geracoes.get(String(jobId || ''));
  if (!g || g.userId !== Number(userId)) {
    const err = new Error('Geração não encontrada ou expirada (o servidor pode ter reiniciado).');
    err.status = 404;
    throw err;
  }
  return {
    jobId: g.id,
    estado: g.estado,
    etapa: g.etapa,
    matterId: g.matterId || null,
    redirect: g.redirect || null,
    erro: g.erro || null,
  };
}

module.exports = {
  NICHOS,
  CANAIS,
  JANELAS_HORAS,
  ehPautaDeRede,
  iniciarGeracaoDeRede,
  statusGeracao,
  listarNichos,
  escolherNichosAutomaticos,
  palavrasValidas,
  gruposDePalavras,
  palavrasDaVezNoYoutube,
  pontuarBomba,
  buscarFuros,
  gerarFuro,
  linkDiretoPeloTitulo,
  completarLinkEImagem,
  mesclarPortais,
};
