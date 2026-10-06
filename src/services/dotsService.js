const db = require('../config/db');

/**
 * Dots — agente que recebe um objetivo em texto e continua trabalhando.
 *
 * A diferença para o Piloto automático é a porta de entrada: o piloto é
 * configurado em formulário (nichos, palavras, intervalo); o dot recebe uma
 * frase ("monitore estas páginas e crie matéria do que for bom") e traduz
 * sozinho para a configuração.
 *
 * Nada aqui reescreve o que já existe. O dot é um maestro:
 *   - cadastrar e varrer páginas  -> bibliotecaService
 *   - decidir o que presta        -> furosSociais (corte de post curto) + nota
 *   - escrever a matéria          -> materiaPorChat, o mesmo do /materia-manual
 *
 * Um ciclo por vez por dot, e o relógio é o `proxima_execucao_at`, igual ao
 * resto do projeto: reiniciar o servidor não perde nem duplica trabalho.
 */

const TABELA = 'dots';
const LOG = 'dots_execucoes';
/** Posts examinados por ciclo. Mais que isso só atrasa a próxima volta. */
const CANDIDATOS_POR_CICLO = 25;
/**
 * Teto de matérias por volta. Acompanha o máximo que a tela oferece (10): com
 * 5 aqui, escolher 10 na tela seria truncado em silêncio.
 */
const ESCRITAS_POR_CICLO_MAX = 10;
/**
 * Páginas varridas por volta. O resto fica para as próximas voltas, girando
 * pela lista — antes a janela era fixa nas 10 primeiras e quem acompanhava
 * mais páginas nunca via o fim da lista ser lido.
 */
const FONTES_POR_CICLO = 10;
/**
 * Depois disso a trava de um ciclo é considerada abandonada (processo reiniciou
 * no meio). Sem esse resgate, um pm2 reload travaria o dot para sempre.
 */
const TRAVA_CICLO_MS = 30 * 60 * 1000;
/**
 * Janela para considerar uma notícia repetida. Comparar com o histórico
 * inteiro fazia uma página de um tema só rejeitar todos os candidatos.
 */
const DIAS_HISTORICO_REPETIDO = Math.max(1, Number(process.env.DOTS_DIAS_REPETIDO) || 7);
const LIMITE_ESCRITA_MS = 15 * 60 * 1000;

let rodando = false;

function corta(texto, max) {
  const t = String(texto ?? '').trim();
  return t ? t.slice(0, max) : null;
}

function parseJson(raw, padrao) {
  if (raw == null) return padrao;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return padrao;
  }
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function erro(mensagem, status = 400) {
  const e = new Error(mensagem);
  e.status = status;
  return e;
}

/**
 * Quais IAs estão de fato disponíveis para escrever.
 *
 * Só entra na lista o provedor com chave configurada — não adianta oferecer
 * Claude no seletor se ANTHROPIC_API_KEY está vazia; o dot escolheria e
 * falharia na primeira volta.
 */
function provedores() {
  const lista = [
    {
      id: 'auto',
      nome: 'Automático',
      detalhe: 'Segue a configuração do projeto',
      disponivel: true,
    },
    {
      id: 'claude',
      nome: 'Claude',
      detalhe: process.env.CLAUDE_WRITER_MODEL || 'claude-sonnet-5',
      disponivel: Boolean(String(process.env.ANTHROPIC_API_KEY || '').trim()),
    },
    {
      id: 'deepseek',
      nome: 'DeepSeek',
      detalhe: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      disponivel: Boolean(String(process.env.DEEPSEEK_API_KEY || '').trim()),
    },
    {
      id: 'gratis',
      nome: 'Camada grátis',
      detalhe: 'Gemini, Groq ou OpenRouter',
      disponivel: require('./freeTierGateway').isConfigured(),
    },
  ];
  return lista.filter((p) => p.disponivel);
}

/** Só aceita provedor que exista e esteja configurado. */
function normalizarProvedor(valor) {
  const id = String(valor || '').trim().toLowerCase();
  return provedores().some((p) => p.id === id) ? id : 'auto';
}
/** Links soltos no texto do objetivo. É o que vira fonte monitorada. */
function extrairUrls(texto) {
  const achados = String(texto || '').match(/https?:\/\/[^\s<>"')]+/gi) || [];
  const limpos = achados.map((u) => u.replace(/[.,;:]+$/, '').trim());
  return [...new Set(limpos)];
}

// --------------------------------------------------------------- jornada

/** O projeto todo trata horário do editor neste fuso. */
const FUSO = 'America/Araguaina';
const INTERVALOS_VALIDOS = [10, 15, 30, 60, 120, 180, 360, 720, 1440];
const DIAS = Object.freeze([
  { id: 1, curto: 'seg' },
  { id: 2, curto: 'ter' },
  { id: 3, curto: 'qua' },
  { id: 4, curto: 'qui' },
  { id: 5, curto: 'sex' },
  { id: 6, curto: 'sáb' },
  { id: 7, curto: 'dom' },
]);

/**
 * Hora (0-23) e dia da semana (1=seg … 7=dom) no fuso do editor.
 *
 * `getHours()` daria a hora do servidor: "das 8h às 18h" viraria outra faixa
 * sempre que o servidor não estivesse no mesmo fuso que o editor.
 */
function horaEDiaLocais(data = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO,
    hourCycle: 'h23',
    hour: '2-digit',
    weekday: 'short',
  }).formatToParts(data);

  const sigla = partes.find((p) => p.type === 'weekday')?.value;
  const porSigla = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    hora: Number(partes.find((p) => p.type === 'hour')?.value) || 0,
    dia: porSigla[sigla] || 0,
  };
}

/** "1,2,3" -> [1,2,3], descartando o que não é dia da semana. */
function lerDias(valor) {
  if (Array.isArray(valor)) {
    return [...new Set(valor.map(Number).filter((d) => d >= 1 && d <= 7))].sort();
  }
  return [
    ...new Set(
      String(valor || '')
        .split(',')
        .map((d) => Number(String(d).trim()))
        .filter((d) => d >= 1 && d <= 7)
    ),
  ].sort();
}

/**
 * O dot pode trabalhar agora?
 *
 * Sem dia marcado ou sem horário, trabalha sempre — é o comportamento de quem
 * já tem dot criado e não configurou jornada.
 *
 * @returns {{ ok: boolean, motivo: string|null }}
 */
function dentroDaJanela(dot, agora = new Date()) {
  const { hora, dia } = horaEDiaLocais(agora);

  const dias = lerDias(dot?.dias_semana);
  if (dias.length && !dias.includes(dia)) {
    const nomes = dias.map((d) => DIAS.find((x) => x.id === d)?.curto).filter(Boolean);
    return { ok: false, motivo: `Fora dos dias de trabalho (${nomes.join(', ')}).` };
  }

  const inicio = Number(dot?.hora_inicio);
  const fim = Number(dot?.hora_fim);
  const temFaixa = Number.isFinite(inicio) && Number.isFinite(fim) && inicio !== fim;
  if (!temFaixa) return { ok: true, motivo: null };

  // Faixa que atravessa a meia-noite (22h às 6h) é válida e precisa do OR.
  const dentro = inicio < fim ? hora >= inicio && hora < fim : hora >= inicio || hora < fim;
  if (dentro) return { ok: true, motivo: null };
  return {
    ok: false,
    motivo: `Fora do horário de trabalho (${String(inicio).padStart(2, '0')}h às ${String(fim).padStart(2, '0')}h).`,
  };
}

/**
 * Normaliza o que a tela mandou. Tudo aqui é escolha do editor, não palpite da
 * IA: era a interpretação do texto livre que errava ritmo e destino.
 */
function normalizarJornada(entrada = {}) {
  const inteiro = (valor, min, max, padrao) => {
    const n = Math.trunc(Number(valor));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
  };
  const hora = (valor) => {
    const n = Math.trunc(Number(valor));
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : null;
  };

  const destinos = ['rascunho', 'agendar', 'publicar'];
  const destino = destinos.includes(entrada.destino) ? entrada.destino : 'rascunho';
  const dias = lerDias(entrada.dias_semana ?? entrada.diasSemana);

  const scanPedido = Math.trunc(Number(entrada.scan_minutos ?? entrada.scanMinutos));
  const horaInicio = hora(entrada.hora_inicio ?? entrada.horaInicio);
  const horaFim = hora(entrada.hora_fim ?? entrada.horaFim);

  return {
    dias_semana: dias.length && dias.length < 7 ? dias.join(',') : null,
    // Faixa igual (8h às 8h) não restringe nada: vale como "sem horário".
    hora_inicio: horaInicio !== null && horaFim !== null && horaInicio !== horaFim ? horaInicio : null,
    hora_fim: horaInicio !== null && horaFim !== null && horaInicio !== horaFim ? horaFim : null,
    scan_minutos: INTERVALOS_VALIDOS.includes(scanPedido) ? scanPedido : 60,
    destino,
    // Rascunho não tem ritmo de saída: fica tudo esperando revisão.
    saida_quantidade: destino === 'rascunho' ? 1 : inteiro(entrada.saida_quantidade ?? entrada.saidaQuantidade, 1, 10, 1),
    saida_minutos: destino === 'rascunho' ? 15 : inteiro(entrada.saida_minutos ?? entrada.saidaMinutos, 5, 1440, 15),
    limite_dia: inteiro(entrada.limite_dia ?? entrada.limiteDia, 1, 200, 20),
    // Três escolhas da tela: a foto da notícia, sempre uma imagem de IA, ou
    // limpar com IA só a foto que tiver texto embutido. A caixa antiga
    // (gerar_imagem_com_texto) continua valendo como a terceira.
    modo_imagem: MODOS_IMAGEM.includes(entrada.modo_imagem)
      ? entrada.modo_imagem
      : entrada.gerar_imagem_com_texto === true || entrada.gerarImagemComTexto === true
        ? 'ia_com_texto'
        : 'original',
  };
}

const MODOS_IMAGEM = Object.freeze(['original', 'ia_todas', 'ia_com_texto']);

// ------------------------------------------------------------------ plano

const SISTEMA_PLANO = [
  'Você configura um agente ("dot") que trabalha sozinho no servidor: pesquisa',
  'notícias, acompanha páginas e escreve matérias. Converta o pedido do editor',
  'em configuração. Responda APENAS com JSON válido, sem markdown e sem texto',
  'fora do objeto.',
  '',
  'O editor já escolheu na tela o ritmo, a quantidade, o destino (rascunho,',
  'agendar ou publicar), a página, a jornada e a imagem. NÃO tente deduzir nada',
  'disso do texto: você decide ONDE procurar e O QUE merece virar matéria.',
  '',
  'Campos (só estes):',
  '  nome: rótulo curto (até 60 caracteres) que descreva o trabalho.',
  '  acao: "monitorar_e_escrever" (padrão) ou "monitorar" — só quando o editor',
  '      pedir para NÃO escrever ("só me avise", "só liste").',
  '  pesquisas: assuntos para PESQUISAR no Google Notícias. Use quando o editor',
  '      pedir para pesquisar/buscar/procurar notícias sobre algo, ou quando ele',
  '      disser o assunto sem dizer onde procurar. Cada item é um termo curto,',
  '      como se digita no Google (1 a 6 palavras): "reforma tributária",',
  '      "Flávio Bolsonaro", "preço da gasolina". No máximo 5. Vazia quando ele',
  '      só quer acompanhar as páginas que citou.',
  '  fontes: sites, páginas, perfis e canais que o editor citou PELO NOME, sem',
  '      link. Cada item: {"tipo": "site"|"facebook"|"instagram"|"youtube"|"tiktok",',
  '      "nome": nome do veículo ou da pessoa ("Metrópoles", "Nikolas Ferreira"),',
  '      "url": o endereço só se tiver CERTEZA, senão null}. "o g1", "a Folha",',
  '      "o portal X" -> site. "página do X" -> facebook. "perfil do X" ->',
  '      instagram. "canal do X" -> youtube. Rede citada explicitamente manda.',
  '  palavras: nomes ou termos EXATOS que o post das páginas precisa citar',
  '      ("só o que citar Flávio Bolsonaro ou Lula" -> ["Flávio Bolsonaro",',
  '      "Lula"]). Vazia quando não houver esse recorte. Tema amplo vai em',
  '      recorte, não aqui.',
  '  recorte: tema amplo a que o post precisa pertencer, quando o editor',
  '      restringir por assunto ("só política" -> "política brasileira",',
  '      "só esporte" -> "esporte"). Um post de política raramente tem a',
  '      palavra "política": quem julga é a IA, lendo o título. Null sem recorte.',
  '  criterio: uma frase dizendo o que merece virar matéria.',
  '  estilo: como ESCREVER, nas palavras do editor ("título mais polêmico",',
  '      "texto curto e direto", "tom de denúncia"). Null quando ele não pedir',
  '      nada sobre a escrita. Não invente estilo.',
  '',
  'Exemplos:',
  '  "Pesquise notícias sobre reforma tributária e escreva matérias"',
  '      -> pesquisas ["reforma tributária"], fontes [].',
  '  "Notícias do Flávio Bolsonaro, com título polêmico"',
  '      -> pesquisas ["Flávio Bolsonaro"], estilo "título polêmico".',
  '  "Monitore o g1 e a página do Metrópoles no Facebook, só política"',
  '      -> fontes [{"tipo":"site","nome":"g1","url":"https://g1.globo.com"},',
  '         {"tipo":"facebook","nome":"Metrópoles","url":null}],',
  '         recorte "política brasileira", pesquisas [].',
  '  "Acompanhe o Instagram do Nikolas Ferreira e o canal da Jovem Pan"',
  '      -> fontes [{"tipo":"instagram","nome":"Nikolas Ferreira","url":null},',
  '         {"tipo":"youtube","nome":"Jovem Pan","url":null}].',
  '  "Monitore estas páginas e crie matéria do que render: <links>"',
  '      -> fontes [], pesquisas [] (os links já vêm separados).',
  '  "Só me avise o que aparecer, não escreva" -> acao "monitorar".',
  '',
  'Se o editor mencionar ritmo, quantidade ou destino, ignore: já está na tela.',
  'Links colados vêm separados, fora do seu JSON: não os repita em fontes e',
  'nunca invente link.',
].join('\n');

/** Rótulos para a frase de confirmação. */
const ROTULO_IMAGEM = {
  original: 'usa a foto da matéria original',
  ia_todas: 'gera a imagem com IA em todas',
  ia_com_texto: 'gera com IA só quando a foto original tiver texto embutido',
  sem_imagem: 'publica sem imagem',
};

function plural(n, um, muitos) {
  return n === 1 ? um : muitos;
}

function tempoPorExtenso(min) {
  if (min === 60) return '1 hora';
  if (min === 120) return '2 horas';
  if (min === 180) return '3 horas';
  if (min === 360) return '6 horas';
  return `${min} min`;
}

/** Tipos de fonte que o editor pode citar (a pesquisa é à parte). */
const TIPOS_FONTE = Object.freeze(['site', 'facebook', 'instagram', 'youtube', 'tiktok']);

const LINHA_IMAGEM = {
  original: 'Imagem: usa a foto da notícia; sem foto, gera uma com IA.',
  ia_todas: 'Imagem: gera uma imagem nova com IA para cada matéria.',
  ia_com_texto: 'Imagem: usa a foto do post; se ela tiver texto embutido, manda limpar o texto mantendo a foto.',
};

/**
 * A frase que o editor lê antes de confirmar.
 *
 * Diz ONDE o dot vai procurar (pesquisas e páginas), o que o editor escolheu
 * na tela (jornada, ritmo, destino, imagem) e o recorte entendido do pedido.
 * `urls` vale para quem ainda passa a lista de links; com o plano novo, as
 * páginas vêm de `plano.fontes`.
 */
function resumoDoPlano(plano, urls = [], config = {}) {
  const linhas = [];
  const quantidade = Number(config.saida_quantidade) || 1;
  const cadaMin = Number(config.saida_minutos) || 15;
  const scanMin = Number(config.scan_minutos) || 60;

  const pesquisas = Array.isArray(plano.pesquisas) ? plano.pesquisas : [];
  const paginas = Array.isArray(plano.fontes)
    ? plano.fontes.filter((f) => f && f.url)
    : (Array.isArray(urls) ? urls : []).map((url) => ({ url }));

  if (pesquisas.length) {
    linhas.push(
      `Pesquisa no Google Notícias: ${pesquisas.map((p) => `“${p}”`).join(', ')} — de novo a cada ${tempoPorExtenso(scanMin)}.`
    );
  }
  if (paginas.length || !pesquisas.length) {
    linhas.push(
      `Acompanha ${paginas.length} ${plural(paginas.length, 'página', 'páginas')} e relê cada uma a cada ${tempoPorExtenso(scanMin)}.`
    );
  }

  // Jornada: sem dia nem hora marcados, trabalha sempre.
  const dias = lerDias(config.dias_semana);
  const temHora = config.hora_inicio !== null && config.hora_inicio !== undefined
    && config.hora_fim !== null && config.hora_fim !== undefined;
  if (dias.length || temHora) {
    const nomes = dias.length
      ? dias.map((d) => DIAS.find((x) => x.id === d)?.curto).filter(Boolean).join(', ')
      : 'todos os dias';
    const faixa = temHora
      ? `das ${String(config.hora_inicio).padStart(2, '0')}h às ${String(config.hora_fim).padStart(2, '0')}h`
      : 'a qualquer hora';
    linhas.push(`Trabalha ${nomes}, ${faixa}.`);
  } else {
    linhas.push('Trabalha todos os dias, a qualquer hora.');
  }

  if (plano.acao === 'monitorar') {
    linhas.push('Só acompanha e lista o que aparecer — não escreve matéria.');
    return linhas;
  }

  if (config.destino === 'rascunho') {
    linhas.push(
      `Escreve do estoque de posts e salva como rascunho, no teto de ${config.limite_dia} por dia. Nada sai sozinho.`
    );
  } else {
    const verbo = config.destino === 'publicar' ? 'publica' : 'agenda';
    const porDia = Math.round(quantidade * (1440 / cadaMin));
    linhas.push(
      `${quantidade === 1 ? '1 matéria' : `${quantidade} matérias`} a cada ${tempoPorExtenso(cadaMin)} — ${verbo} até ${config.limite_dia} por dia.`
    );
    if (config.limite_dia < porDia) {
      linhas.push(
        `Atenção: nesse ritmo daria ${porDia} por dia, mas o teto de ${config.limite_dia} para antes.`
      );
    }
  }

  if (paginas.length + pesquisas.length > 1) {
    linhas.push('Alterna as fontes: a vez é de quem está há mais tempo sem render matéria.');
  }

  linhas.push(LINHA_IMAGEM[config.modo_imagem] || LINHA_IMAGEM.original);

  if (Array.isArray(plano.palavras) && plano.palavras.length) {
    linhas.push(`Só escreve se o post citar: ${plano.palavras.join(', ')}.`);
  }
  if (plano.recorte) linhas.push(`Só escreve o que for de ${plano.recorte} (a IA confere cada título).`);
  if (plano.estilo) linhas.push(`Estilo pedido: ${plano.estilo}`);
  if (plano.criterio) linhas.push(`Critério: ${plano.criterio}`);
  return linhas;
}

/** Nome de reserva: primeira frase do pedido, sem link e sem cortar palavra. */
function nomeDoTexto(texto) {
  const limpo = String(texto || '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return 'Novo dot';
  const frase = limpo.split(/[.;:\n]/)[0].trim() || limpo;
  if (frase.length <= 60) return frase;
  return `${frase.slice(0, 57).replace(/\s+\S*$/, '')}…`;
}

/**
 * Assunto para pesquisar quando o pedido não diz onde procurar e a IA não
 * respondeu. "Pesquise notícias sobre reforma tributária e escreva" vira
 * "reforma tributária". Melhor uma pesquisa aproximada do que um dot que
 * nasce sem nada para ler.
 */
function termoDeReserva(texto) {
  let t = String(texto || '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  const sobre = t.match(/\bsobre\s+(.+)/i);
  if (sobre) {
    t = sobre[1];
  } else {
    t = t
      .replace(/^(?:por favor,?\s*)?(?:(?:me\s+)?(?:pesquise|pesquisar|busque|buscar|procure|procurar|monitore|monitorar|acompanhe|acompanhar|traga|trazer|mande|crie|criar|escreva|escrever|fa[çc]a|quero|preciso\s+de)\s+)+/i, '')
      .replace(/^(?:as?\s+|os?\s+)?(?:[úu]ltimas\s+)?(?:not[íi]cias?|mat[ée]rias?|posts?|conte[úu]dos?)\s+(?:d[aeo]s?\s+|sobre\s+)?/i, '');
  }
  t = t.split(/[.;:!?\n,]|\s(?:e|com|para|pra|que|no|na|em)\s/i)[0];
  const palavras = t.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  return palavras.join(' ').slice(0, 80) || null;
}

function compactoNome(texto) {
  return normalizarBusca(texto).replace(/[^a-z0-9]+/g, '');
}

function chaveFonte(f) {
  return `${f.tipo}|${compactoNome(f.nome)}`;
}

/** Endereço comparável: sem barra final, sem "www.", minúsculo. */
function chaveUrl(url) {
  return String(url || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Termos de pesquisa limpos: sem repetidos, 2 a 80 caracteres, até 5. */
function limparPesquisas(lista) {
  const vistos = new Set();
  const saida = [];
  for (const item of Array.isArray(lista) ? lista : []) {
    const termo = String(item || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const chave = compactoNome(termo);
    if (termo.length < 2 || !chave || vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(termo);
    if (saida.length >= 5) break;
  }
  return saida;
}

function limparLista(lista, max, quantos) {
  return (Array.isArray(lista) ? lista : []).map((x) => corta(x, max)).filter(Boolean).slice(0, quantos);
}

/** "@poder360" para rede social; o domínio para site. */
function nomeDoLink(url) {
  const { tipoDoLink, handleDoPerfil } = require('./dotsFontesService');
  const tipo = tipoDoLink(url);
  if (tipo && tipo !== 'site') {
    const handle = handleDoPerfil(url);
    if (handle) return `@${handle.replace(/^@/, '')}`;
  }
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return String(url || '').slice(0, 80);
  }
}

/** Links colados no pedido, no mesmo formato das fontes citadas pelo nome. */
function fontesDosLinks(links) {
  const { tipoDoLink } = require('./dotsFontesService');
  return links.map((url) => ({
    tipo: tipoDoLink(url) || 'site',
    nome: nomeDoLink(url),
    url,
    verificado: true,
    titulo: null,
    via: 'link',
    motivo: null,
  }));
}

/** Fontes citadas pelo nome, como a IA mandou, só com o que é válido. */
function limparFontesCitadas(lista, links = []) {
  const { tipoDoLink } = require('./dotsFontesService');
  const jaColadas = new Set(links.map(chaveUrl));
  const vistas = new Set();
  const saida = [];
  for (const f of Array.isArray(lista) ? lista : []) {
    const nome = corta(f?.nome, 120);
    if (!nome || nome.length < 2) continue;
    const tipo = TIPOS_FONTE.includes(f?.tipo) ? f.tipo : 'site';
    let url = /^https?:\/\//i.test(String(f?.url || '')) ? String(f.url).trim() : null;
    if (url && tipoDoLink(url) !== tipo) url = null;
    // Quem já veio com link no pedido não é procurado de novo.
    if (url && jaColadas.has(chaveUrl(url))) continue;
    const item = { tipo, nome, url };
    if (vistas.has(chaveFonte(item))) continue;
    vistas.add(chaveFonte(item));
    saida.push(item);
    if (saida.length >= 8) break;
  }
  return saida;
}

/**
 * Traduz o texto do editor em configuração. Falhando a IA, o dot ainda nasce
 * com um padrão sensato: os links colados, ou uma pesquisa pelo assunto.
 */
async function interpretar(texto) {
  const padrao = {
    nome: nomeDoTexto(texto),
    acao: 'monitorar_e_escrever',
    criterio: 'Post com fato novo e texto suficiente para apurar.',
    palavras: [],
    recorte: null,
    estilo: null,
    pesquisas: [],
    fontes: [],
  };

  try {
    const { chatCompletion } = require('./deepseekService');
    const bruto = await chatCompletion(
      [
        { role: 'system', content: SISTEMA_PLANO },
        { role: 'user', content: String(texto || '').slice(0, 4000) },
      ],
      { json: true, tarefa: 'auxiliar', temperature: 0.2 }
    );
    const vindo = parseJson(bruto, null);
    if (!vindo || typeof vindo !== 'object') throw new Error('plano vazio');

    return {
      nome: corta(vindo.nome, 60) || padrao.nome,
      acao: vindo.acao === 'monitorar' ? 'monitorar' : 'monitorar_e_escrever',
      criterio: corta(vindo.criterio, 400) || padrao.criterio,
      palavras: limparLista(vindo.palavras, 60, 20),
      recorte: corta(vindo.recorte, 120),
      estilo: corta(vindo.estilo, 300),
      pesquisas: limparPesquisas(vindo.pesquisas),
      fontes: Array.isArray(vindo.fontes) ? vindo.fontes : [],
    };
  } catch (err) {
    // Sem a IA o dot ainda nasce útil: links ou a pesquisa de reserva bastam.
    console.warn('[dots] não consegui interpretar o pedido, usando o padrão:', err.message);
    return padrao;
  }
}

/**
 * O plano completo de um pedido: o que a IA entendeu + as fontes citadas pelo
 * nome já com endereço achado e conferido + a garantia de ter onde procurar.
 *
 * `anterior` é o plano salvo do dot (ao editar o pedido): fonte já achada não
 * é procurada de novo, e o que o editor acrescentou ou tirou pelo painel
 * continua valendo.
 */
async function montarPlano(texto, { anterior = null } = {}) {
  const bruto = await interpretar(texto);
  const links = extrairUrls(texto);
  const citadas = limparFontesCitadas(bruto.fontes, links);

  const conhecidas = new Map(
    (Array.isArray(anterior?.fontes) ? anterior.fontes : [])
      .filter((f) => f && f.url && f.via !== 'link')
      .map((f) => [chaveFonte(f), f])
  );
  const faltam = citadas.filter((f) => !conhecidas.has(chaveFonte(f)));
  const achadas = faltam.length ? await require('./dotsFontesService').resolverFontes(faltam) : [];
  const porChave = new Map(achadas.filter(Boolean).map((f) => [chaveFonte(f), f]));
  const resolvidas = citadas.map((f) => conhecidas.get(chaveFonte(f)) || porChave.get(chaveFonte(f)) || {
    ...f,
    url: null,
    verificado: false,
    titulo: null,
    via: null,
    motivo: `Não achei "${f.nome}". Cole o link.`,
  });

  let pesquisas = bruto.pesquisas;
  const manuais = anterior?.manuais || { fontes: [], pesquisas: [] };
  const removidas = new Set(Array.isArray(anterior?.removidas) ? anterior.removidas : []);

  // Junta o que veio do texto com o que o editor acrescentou pelo painel, e
  // tira o que ele removeu por lá.
  const vistas = new Set();
  const fontes = [...fontesDosLinks(links), ...resolvidas, ...(manuais.fontes || [])].filter((f) => {
    const chave = f.url ? `url|${chaveUrl(f.url)}` : chaveFonte(f);
    if (vistas.has(chave) || (f.url && removidas.has(`url|${chaveUrl(f.url)}`))) return false;
    vistas.add(chave);
    return true;
  });
  pesquisas = limparPesquisas([...pesquisas, ...(manuais.pesquisas || [])])
    .filter((p) => !removidas.has(`busca|${compactoNome(p)}`));

  // Sem nada para ler e sem fonte citada: pesquisa o assunto do pedido. Com
  // fonte citada que não foi achada, NÃO inventa pesquisa — a tela mostra o
  // que faltou e o editor cola o link.
  if (!fontes.some((f) => f.url) && !pesquisas.length && !citadas.length) {
    pesquisas = limparPesquisas(bruto.palavras.length ? bruto.palavras.slice(0, 3) : [termoDeReserva(texto)]);
  }

  const { fontes: _citadasDaIa, ...resto } = bruto;
  return {
    ...resto,
    pesquisas,
    fontes,
    manuais: { fontes: manuais.fontes || [], pesquisas: manuais.pesquisas || [] },
    removidas: [...removidas],
  };
}

/** Avisos para a tela: fontes não achadas, não conferidas, ou nada para ler. */
function avisosDoPlano(plano) {
  const avisos = (plano.fontes || [])
    .filter((f) => !f.url || !f.verificado)
    .map((f) => f.motivo || `Confira o link de "${f.nome}".`);
  if (!(plano.fontes || []).some((f) => f.url) && !(plano.pesquisas || []).length) {
    avisos.unshift('Não achei onde procurar. Cole o link da página ou diga o assunto para eu pesquisar.');
  }
  return avisos;
}

/**
 * O plano que a tela devolve depois da prévia (com o que o editor tirou).
 * Usar este plano em vez de interpretar de novo garante que o dot criado é o
 * mesmo que o editor viu — a IA pode responder diferente na segunda vez.
 */
function planoDaTela(enviado) {
  if (!enviado || typeof enviado !== 'object' || !Array.isArray(enviado.fontes)) return null;
  const { tipoDoLink } = require('./dotsFontesService');
  const fontes = enviado.fontes
    .slice(0, 30)
    .map((f) => {
      const url = /^https?:\/\//i.test(String(f?.url || '')) ? corta(f.url, 500) : null;
      return {
        tipo: TIPOS_FONTE.includes(f?.tipo) ? f.tipo : (url && tipoDoLink(url)) || 'site',
        nome: corta(f?.nome, 120) || (url ? nomeDoLink(url) : null),
        url,
        verificado: Boolean(f?.verificado),
        titulo: corta(f?.titulo, 200),
        via: corta(f?.via, 30),
        motivo: corta(f?.motivo, 300),
      };
    })
    .filter((f) => f.nome || f.url);
  return {
    nome: corta(enviado.nome, 60) || null,
    acao: enviado.acao === 'monitorar' ? 'monitorar' : 'monitorar_e_escrever',
    criterio: corta(enviado.criterio, 400) || 'Post com fato novo e texto suficiente para apurar.',
    palavras: limparLista(enviado.palavras, 60, 20),
    recorte: corta(enviado.recorte, 120),
    estilo: corta(enviado.estilo, 300),
    pesquisas: limparPesquisas(enviado.pesquisas),
    fontes,
    manuais: { fontes: [], pesquisas: [] },
    removidas: [],
  };
}

/**
 * Publica o passo atual para a tela acompanhar em tempo real.
 *
 * Um ciclo leva minutos; sem isso o editor só veria o resumo no fim e não
 * saberia se o dot está vivo ou travado.
 */
async function marcarAtividade(dotId, texto, { trabalhando = true } = {}) {
  try {
    await db(TABELA).where({ id: dotId }).update({
      trabalhando,
      atividade: corta(texto, 300),
      atividade_em: new Date(),
    });
  } catch (err) {
    console.warn('[dots] atividade:', err.message);
  }
}

/** Só para a tela de criação mostrar o que vai acontecer antes de salvar. */
async function previa(texto, jornada = {}) {
  if (!String(texto || '').trim()) throw erro('Escreva o que o dot deve fazer.');
  const plano = await montarPlano(texto);
  const config = normalizarJornada(jornada);
  return {
    plano,
    config,
    urls: plano.fontes.filter((f) => f.url).map((f) => f.url),
    resumo: resumoDoPlano(plano, [], config),
    avisos: avisosDoPlano(plano),
  };
}

// ------------------------------------------------------------------ criar

async function registrarLog(dot, acao, { detalhe = null, url = null, matterId = null } = {}) {
  try {
    await db(LOG).insert({
      dot_id: dot.id,
      user_id: dot.user_id,
      acao,
      detalhe: corta(detalhe, 600),
      url: corta(url, 1000),
      matter_id: matterId || null,
    });
  } catch (err) {
    console.warn('[dots] log:', err.message);
  }
}

/**
 * Página escolhida na tela, conferida: só vale página do próprio editor (ou
 * concedida a ele). Agendar e publicar sem página mandariam a matéria para a
 * página padrão da conta sem ninguém ver — então isso é recusado aqui.
 */
async function paginaDoEditor(userId, facebookPageId, destino) {
  const id = Number(facebookPageId) || null;
  if (!id) {
    if (destino && destino !== 'rascunho') {
      throw erro('Escolha a página onde publicar. Sem página, o dot só pode deixar em rascunho.');
    }
    return null;
  }
  const pagina = await require('./facebookPageResolver').resolvePageForUser(userId, id);
  if (!pagina) throw erro('Esta página do Facebook não está ligada à sua conta.');
  return Number(pagina.id);
}

/**
 * Cria o dot e já cadastra as fontes na Biblioteca, monitorando. A varredura
 * em si fica para o tick — criar não pode travar esperando 26 sites.
 *
 * `plano` é o que a prévia mostrou (com o que o editor tirou). Sem prévia, o
 * pedido é interpretado aqui mesmo.
 */
async function criar(userId, { objetivo, nome = null, facebookPageId = null, provedor = 'auto', plano: planoEnviado = null, ...jornada }) {
  const texto = String(objetivo || '').trim();
  if (!texto) throw erro('Escreva o que o dot deve fazer.');
  if (texto.length > 8000) throw erro('O objetivo está longo demais (máximo 8000 caracteres).');

  // A IA só diz ONDE procurar e O QUE merece matéria. Ritmo, destino, jornada
  // e imagem são escolha do editor na tela.
  const config = normalizarJornada(jornada);
  const paginaId = await paginaDoEditor(userId, facebookPageId, config.destino);
  const plano = planoDaTela(planoEnviado) || (await montarPlano(texto));
  if (!plano.fontes.some((f) => f.url) && !plano.pesquisas.length) {
    throw erro(avisosDoPlano(plano).join(' '));
  }

  const [id] = await db(TABELA).insert({
    user_id: userId,
    nome: corta(nome, 160) || plano.nome || nomeDoTexto(texto),
    objetivo: texto,
    plano: JSON.stringify({ ...plano, ...config }),
    fonte_ids: JSON.stringify([]),
    estado: 'ativo',
    // O ciclo acorda no ritmo da saída; a varredura tem o seu, em scan_minutos.
    intervalo_minutos: config.saida_minutos,
    scan_minutos: config.scan_minutos,
    limite_dia: config.limite_dia,
    facebook_page_id: paginaId,
    destino: config.destino,
    materias_por_volta: config.saida_quantidade,
    modo_imagem: config.modo_imagem,
    agendar_minutos: config.destino === 'agendar' ? config.saida_minutos : null,
    dias_semana: config.dias_semana,
    hora_inicio: config.hora_inicio,
    hora_fim: config.hora_fim,
    saida_quantidade: config.saida_quantidade,
    saida_minutos: config.saida_minutos,
    provedor: normalizarProvedor(provedor),
    proxima_execucao_at: new Date(),
  });

  const dot = await db(TABELA).where({ id }).first();
  const { fonteIds, problemas } = await cadastrarFontes(dot, plano);

  // Nenhuma fonte entrou: um dot sem nada para ler só giraria em falso. Sai
  // com o motivo, para o editor corrigir o pedido.
  if (!fonteIds.length) {
    await db(TABELA).where({ id }).del();
    throw erro(`Nenhuma fonte entrou: ${problemas.join(' | ') || 'confira os links e o assunto.'}`);
  }

  await db(TABELA).where({ id }).update({
    fonte_ids: JSON.stringify(fonteIds),
    ultimo_resumo: corta(
      `Criado com ${fonteIds.length} fonte(s).${problemas.length ? ` ${problemas.length} não entraram.` : ''}`,
      500
    ),
  });

  return { id, plano, fontes: fonteIds.length, problemas };
}

/**
 * Cadastra (ou reaproveita) as fontes do plano na Biblioteca e liga o
 * monitorar: os links e os endereços achados pelo nome viram fontes comuns; os
 * assuntos viram pesquisas no Google Notícias.
 *
 * Mora fora do `criar` porque editar o pedido de um dot salvo precisa do
 * mesmo trabalho: fontes novas entram, e o motivo de uma não entrar tem de
 * aparecer na atividade.
 */
async function cadastrarFontes(dot, plano) {
  const fonteIds = [];
  const problemas = [];
  const bibliotecaService = require('./bibliotecaService');
  const userId = dot.user_id;
  const urls = [...new Set((plano?.fontes || []).filter((f) => f && f.url).map((f) => f.url))];

  for (const url of urls) {
    try {
      // A comparação vive no bibliotecaService, junto da normalização: era a
      // falta disso que fazia "pagina/" não casar com "pagina" e o dot nascer
      // sem fonte nenhuma.
      const existente = await bibliotecaService.encontrarFontePorUrl(userId, url);
      if (existente) {
        await db('biblioteca_fontes').where({ id: existente.id }).update({ monitorar: true });
        fonteIds.push(Number(existente.id));
        continue;
      }

      const criada = await bibliotecaService.criarFonte({
        userId,
        url,
        monitorar: true,
        intervaloMinutos: Number(dot.scan_minutos) || 60,
      });
      const novoId = criada?.id || criada;
      if (novoId) fonteIds.push(Number(novoId));
    } catch (err) {
      // "Já está na biblioteca" não é problema: é a fonte que queremos.
      if (err.status === 409) {
        const achada = await bibliotecaService.encontrarFontePorUrl(userId, url).catch(() => null);
        if (achada) {
          await db('biblioteca_fontes').where({ id: achada.id }).update({ monitorar: true });
          fonteIds.push(Number(achada.id));
          continue;
        }
      }
      problemas.push(`${url}: ${err.message}`);
    }
  }

  for (const termo of plano?.pesquisas || []) {
    try {
      const fonte = await bibliotecaService.criarFonteBusca({
        userId,
        termo,
        intervaloMinutos: Number(dot.scan_minutos) || 60,
      });
      if (fonte?.id) fonteIds.push(Number(fonte.id));
    } catch (err) {
      problemas.push(`pesquisa “${termo}”: ${err.message}`);
    }
  }

  // Fonte citada pelo nome que não foi achada: o motivo vai junto.
  for (const f of plano?.fontes || []) {
    if (f && !f.url) problemas.push(f.motivo || `Não achei "${f.nome}".`);
  }

  const unicas = [...new Set(fonteIds)];
  await registrarLog(dot, 'criou_fonte', {
    detalhe: corta(
      `${unicas.length} fonte(s) monitorada(s)` +
        (plano?.pesquisas?.length ? ` (${plano.pesquisas.length} pesquisa(s) no Google Notícias)` : '') +
        (problemas.length ? `; ${problemas.length} com problema — ${problemas.join(' | ')}` : ''),
      600
    ),
  });

  return { fonteIds: unicas, problemas };
}

// ------------------------------------------------------------------ ciclo

/**
 * Posts novos das páginas deste dot, já sem os curtos demais.
 *
 * Reusa o mesmo critério do Furos (`conteudoSuficiente`): post de uma ou duas
 * linhas sem vídeo não vira matéria, porque não há o que apurar.
 */
async function candidatosDoDot(dot) {
  const fonteIds = parseJson(dot.fonte_ids, []);
  if (!fonteIds.length) return [];

  // Post que acabou de falhar não volta já: a próxima volta pega o seguinte.
  const falharam = await urlsQueFalharamRecentemente(dot);

  const linhas = await db('biblioteca_posts as p')
    .join('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
    .where('p.user_id', dot.user_id)
    .whereIn('p.fonte_id', fonteIds)
    .whereNull('p.matter_id')
    .whereIn('p.status', ['novo', 'visto'])
    .modify((q) => {
      if (falharam.length) q.whereNotIn('p.url', falharam);
    })
    .orderByRaw('COALESCE(p.viral_score, 0) DESC, COALESCE(p.publicado_em, p.created_at) DESC')
    .limit(CANDIDATOS_POR_CICLO)
    .select(
      'p.id',
      'p.fonte_id',
      'p.titulo',
      'p.url',
      'p.resumo',
      'p.thumbnail',
      'p.media_type',
      'p.media_url',
      'p.publicado_em',
      'p.created_at',
      'p.viral_score',
      'f.nome as fonte_nome',
      'f.plataforma as fonte_plataforma'
    );

  // Texto mínimo só vale para post de rede social; link de site a IA lê inteiro.
  const uteis = linhas
    .filter((l) => /^https?:\/\//i.test(String(l.url || '')))
    .filter(postTemMaterial);

  // O editor pode pedir um recorte ("só o que falar de Flávio Bolsonaro").
  // Vale para as PÁGINAS acompanhadas: notícia de pesquisa já é do assunto
  // pesquisado e não precisa repetir a palavra no título.
  const plano = parseJson(dot.plano, {});
  const comPalavra = uteis.filter(
    (p) => p.fonte_plataforma === 'busca' || filtrarPorPalavras([p], plano.palavras).length
  );
  if (comPalavra.length !== uteis.length) {
    await registrarLog(dot, 'ignorou', {
      detalhe:
        `${uteis.length - comPalavra.length} post(s) fora das palavras pedidas ` +
        `(${(plano.palavras || []).slice(0, 5).join(', ')})`,
    });
  }

  // Tema amplo ("só política"): a IA confere o título, uma vez por post.
  const noRecorte = await triarPeloRecorte(dot, plano, comPalavra);

  const ordenados = rodiziarPorFonte(noRecorte, await ultimaMateriaPorFonte(dot, fonteIds));
  return semRepetirAssunto(dot, ordenados);
}

const TRIAGEM = 'dots_triagem';

/** Vereditos já dados para estes posts neste dot: Map(postId -> cabe). */
async function vereditosDaTriagem(dotId, postIds) {
  if (!postIds.length) return new Map();
  const linhas = await db(TRIAGEM)
    .where({ dot_id: dotId })
    .whereIn('post_id', postIds)
    .select('post_id', 'cabe')
    .catch(() => []);
  return new Map(linhas.map((l) => [Number(l.post_id), Boolean(l.cabe)]));
}

/**
 * Mantém só os posts do tema pedido ("só política", "só esporte").
 *
 * Palavra-chave não resolve tema amplo — notícia de política raramente tem a
 * palavra "política" no título. A IA julga os títulos ainda não julgados, em
 * um lote só por volta, e o veredito fica gravado: a próxima volta e o painel
 * usam o mesmo julgamento. Se a IA falhar, o dot não para: segue sem triagem
 * nesta volta e tenta de novo na próxima.
 */
async function triarPeloRecorte(dot, plano, posts) {
  const recorte = String(plano?.recorte || '').trim();
  if (!recorte || !posts.length) return posts;

  const vereditos = await vereditosDaTriagem(dot.id, posts.map((p) => Number(p.id)));
  const faltam = posts.filter((p) => !vereditos.has(Number(p.id))).slice(0, 30);
  if (faltam.length) {
    const novos = await julgarRecorte(recorte, faltam).catch((err) => {
      console.warn(`[dots #${dot.id}] triagem por tema falhou: ${err.message}`);
      return null;
    });
    if (!novos) return posts;
    const linhas = [...novos].map(([postId, cabe]) => ({ dot_id: dot.id, post_id: postId, cabe }));
    if (linhas.length) await db(TRIAGEM).insert(linhas).onConflict(['dot_id', 'post_id']).merge().catch(() => {});
    for (const [postId, cabe] of novos) vereditos.set(postId, cabe);
  }

  const dentro = posts.filter((p) => vereditos.get(Number(p.id)) !== false);
  if (dentro.length !== posts.length) {
    await registrarLog(dot, 'ignorou', {
      detalhe: `${posts.length - dentro.length} post(s) fora do tema pedido (${recorte})`,
    });
  }
  return dentro;
}

/** Pergunta à IA quais títulos são do tema. Map(postId -> cabe) ou null. */
async function julgarRecorte(recorte, posts) {
  const { chatCompletion } = require('./deepseekService');
  const lista = posts
    .map((p, i) => `${i + 1}. ${String(p.titulo || '').slice(0, 200)}${p.resumo ? ` — ${String(p.resumo).slice(0, 160)}` : ''}`)
    .join('\n');
  const bruto = await chatCompletion(
    [
      {
        role: 'system',
        content:
          'Você faz a triagem de notícias para um editor. Diga quais itens pertencem ao tema pedido. ' +
          'Responda APENAS com JSON no formato {"cabem": [números dos itens]}. Na dúvida, inclua o item.',
      },
      { role: 'user', content: `Tema: ${recorte}\n\nItens:\n${lista}` },
    ],
    { json: true, tarefa: 'auxiliar', temperature: 0 }
  );
  const vindo = parseJson(bruto, null);
  if (!vindo || !Array.isArray(vindo.cabem)) return null;
  const cabem = new Set(vindo.cabem.map(Number));
  return new Map(posts.map((p, i) => [Number(p.id), cabem.has(i + 1)]));
}

/**
 * Tira o que já virou matéria e o que repete assunto dentro da mesma lista.
 *
 * `matter_id IS NULL` só impede reusar o MESMO post. A mesma notícia chega por
 * páginas diferentes (UOL e Folha sobre a mesma pesquisa) e virava duas
 * matérias publicadas — o dot não tinha checagem nenhuma, ao contrário do
 * Furos e do Piloto, que já usavam estes mesmos mecanismos.
 */
async function semRepetirAssunto(dot, posts) {
  if (!posts.length) return posts;

  let lista = posts;
  try {
    const { porUrl, porTitulo, novos } = await filtrarJaPublicados(dot, posts);
    const repetidos = porUrl + porTitulo;
    if (repetidos) {
      await registrarLog(dot, 'ignorou', {
        detalhe:
          `${repetidos} post(s) já publicados nos últimos ${DIAS_HISTORICO_REPETIDO} dias` +
          ` (${porUrl} pelo link, ${porTitulo} pelo título)`,
      });
    }
    // Filtrar tudo é sinal de regra apertada demais, não de dia sem notícia.
    if (!novos.length && posts.length) {
      await registrarLog(dot, 'ignorou', {
        detalhe:
          `Nenhum dos ${posts.length} post(s) passou: todos já viraram matéria nos últimos ` +
          `${DIAS_HISTORICO_REPETIDO} dias. Se isso se repetir todo dia, as páginas podem não ` +
          'estar trazendo post novo.',
      });
    }
    lista = novos;
  } catch (err) {
    console.warn(`[dots #${dot.id}] checagem de repetido falhou: ${err.message}`);
    await registrarLog(dot, 'erro', {
      detalhe: corta(`não consegui checar repetido (${err.message})`, 600),
    });
  }

  return semAssuntoRepetidoNaLista(lista);
}

/**
 * Mantém só os posts que citam alguma palavra pedida pelo editor.
 *
 * Sem palavras na lista, tudo passa — o recorte é opcional. A comparação é
 * sem acento e sem caixa, e aceita a palavra dentro de frase maior
 * ("flavio bolsonaro" casa com "Flávio Bolsonaro cobra...").
 */
function filtrarPorPalavras(posts, palavras) {
  const termos = (Array.isArray(palavras) ? palavras : [])
    .map((p) => normalizarBusca(p))
    .filter((p) => p.length >= 3);
  if (!termos.length) return posts;

  return posts.filter((post) => {
    const texto = normalizarBusca(`${post.titulo || ''} ${post.resumo || ''}`);
    return termos.some((termo) => texto.includes(termo));
  });
}

/** Qual das palavras pedidas o post cita (para mostrar na atividade). */
function palavraQueCasou(post, palavras) {
  const texto = normalizarBusca(`${post?.titulo || ''} ${post?.resumo || ''}`);
  return (Array.isArray(palavras) ? palavras : [])
    .find((p) => normalizarBusca(p).length >= 3 && texto.includes(normalizarBusca(p))) || null;
}

function normalizarBusca(valor) {
  return String(valor || '')
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tira o que esta conta já publicou, com critério ESTRITO.
 *
 * A primeira versão usava `marcarJaPublicados`, que compara com até 1000
 * matérias de todo o histórico e aceita como repetido qualquer par com 3
 * palavras em comum. Numa página de política, 'lula', 'bolsonaro' e 'governo'
 * aparecem juntas em quase toda manchete: o dot rejeitava 25 de 25 candidatos
 * e nunca escrevia nada.
 *
 * Aqui só conta o que indica MESMA notícia: o link idêntico, ou título
 * praticamente igual (75% das palavras em comum — ver mesmaNoticia), e só
 * contra o que saiu nos últimos dias. Assunto parecido pode sair.
 */
/**
 * Mesma notícia = título praticamente igual: pelo menos 75% das palavras do
 * título maior em comum. Assunto PARECIDO passa (o editor quer publicar
 * desdobramentos sobre Lula/Flávio); só a mesma manchete reescrita é barrada.
 */
function mesmaNoticia(a, b) {
  return require('./editorialGuidelinesFb').mesmaNoticiaEstrita(a, b);
}

async function filtrarJaPublicados(dot, posts) {
  const titulosParecidos = mesmaNoticia;
  const desde = new Date(Date.now() - DIAS_HISTORICO_REPETIDO * 86_400_000);

  const publicadas = await db('ai_matters')
    .where('user_id', dot.user_id)
    .where('created_at', '>=', desde)
    .select('titulo', 'fonte_url', 'fonte_titulo')
    .limit(500);

  const semQuery = (valor) =>
    String(valor || '')
      .split(/[?#]/)[0]
      .toLowerCase()
      .replace(/\/+$/, '');

  const urls = new Set(publicadas.map((m) => semQuery(m.fonte_url)).filter(Boolean));
  const titulos = publicadas
    .flatMap((m) => [m.titulo, m.fonte_titulo])
    .map((t) => String(t || '').trim())
    .filter(Boolean);

  let porUrl = 0;
  let porTitulo = 0;
  const novos = [];
  for (const post of posts) {
    const link = semQuery(post.url);
    if (link && urls.has(link)) {
      porUrl += 1;
      continue;
    }
    const titulo = String(post.titulo || '').trim();
    if (titulo && titulos.some((t) => titulosParecidos(t, titulo))) {
      porTitulo += 1;
      continue;
    }
    novos.push(post);
  }
  return { porUrl, porTitulo, novos };
}

/**
 * Tira da própria lista os posts que contam a mesma notícia.
 *
 * A mesma pesquisa eleitoral chega por UOL, Folha e Poder360 na mesma volta.
 * Sem isto, duas delas podiam virar matéria e ir as duas para a fila.
 */
function semAssuntoRepetidoNaLista(posts) {
  const { titulosSimilares } = require('./newsResearch');
  const titulosAceitos = [];
  const escolhidos = [];
  for (const post of Array.isArray(posts) ? posts : []) {
    const titulo = String(post?.titulo || '').trim();
    if (titulo && titulosAceitos.some((a) => titulosSimilares(a, titulo))) continue;
    if (titulo) titulosAceitos.push(titulo);
    escolhidos.push(post);
  }
  return escolhidos;
}

/**
 * Quando cada página produziu matéria pela última vez para este usuário.
 * Página que nunca produziu não aparece no mapa — e por isso entra na frente.
 */
async function ultimaMateriaPorFonte(dot, fonteIds) {
  const linhas = await db('biblioteca_posts')
    .where({ user_id: dot.user_id })
    .whereIn('fonte_id', fonteIds)
    .whereNotNull('matter_id')
    .groupBy('fonte_id')
    .select('fonte_id')
    .max({ ultima: 'created_at' });

  return new Map(
    linhas.map((l) => [Number(l.fonte_id), new Date(l.ultima || 0).getTime() || 0])
  );
}

/**
 * Ordena para dar a vez à página que está há mais tempo sem render matéria.
 *
 * Sem isto a ordem era só `viral_score DESC`: a página mais popular da lista
 * ganhava todas as voltas e as outras 25 nunca viravam matéria — o contrário de
 * "uma de cada página". Dentro da mesma página, o melhor post continua na
 * frente.
 */
function rodiziarPorFonte(posts, ultimaPorFonte = new Map()) {
  const melhorDaFonte = new Map();
  for (const post of posts) {
    const fonte = Number(post.fonte_id);
    // `posts` já vem por viral_score DESC, então o primeiro de cada fonte é o melhor.
    if (!melhorDaFonte.has(fonte)) melhorDaFonte.set(fonte, post);
  }

  const vez = (post) => ultimaPorFonte.get(Number(post.fonte_id)) ?? 0;
  const naFrente = [...melhorDaFonte.values()].sort((a, b) => {
    const diferenca = vez(a) - vez(b);
    if (diferenca) return diferenca;
    return (Number(b.viral_score) || 0) - (Number(a.viral_score) || 0);
  });

  // O resto vai atrás, para a volta não ficar sem candidato se os da frente
  // falharem na escrita.
  const jaEscolhidos = new Set(naFrente.map((p) => p.id));
  return [...naFrente, ...posts.filter((p) => !jaEscolhidos.has(p.id))];
}

/** Escreve pelo mesmo caminho do "Criar matéria" do chat. */
/**
 * Link que a IA vai ler. Post vindo do Google Notícias aponta para o Google,
 * não para a reportagem: a IA recebia só o endereço do Google e respondia que
 * não havia conteúdo. Converte para o link original; sem ele, desiste do post.
 */
async function urlParaEscrever(post) {
  const url = String(post?.url || '').trim();
  if (!/news\.google\.com/i.test(url)) return url;
  let real = null;
  try {
    real = (await require('./newsResearch').decodificarLinksGoogle([url])).get(url) || null;
  } catch {
    real = null;
  }
  if (!real) {
    real = await require('./articleSource').resolverUrlNoticia(url).catch(() => null);
  }
  if (real && !/news\.google\.com/i.test(real)) {
    // Guarda o link real: a lista de posts e as próximas voltas já usam ele.
    await db('biblioteca_posts').where({ id: post.id }).update({ url: corta(real, 500) }).catch(() => {});
    return real;
  }
  const err = new Error('link do Google Notícias sem a reportagem original');
  err.code = 'SEM_MATERIA';
  throw err;
}

/** Espera a promessa até `ms`; passou disso, devolve null (sem derrubar nada). */
function comPrazo(promessa, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promessa).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Capa de dentro da reportagem para um post que chegou sem imagem (feeds RSS
 * e do Google não trazem foto). Mesmo caminho do Furos/piloto: link real da
 * matéria → og:image, com o Chrome de reserva quando o site bloqueia.
 * Grava no post e devolve a imagem (ou null).
 */
async function capaDoPost(post) {
  if (require('./articleSource').imagemServeDeCapa(post?.thumbnail)) return post.thumbnail;
  let url = String(post?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  if (/news\.google\.com/i.test(url)) {
    const real = (await comPrazo(require('./newsResearch').decodificarLinksGoogle([url]), 15_000))?.get(url);
    if (!real) return null;
    url = real;
    await db('biblioteca_posts').where({ id: post.id }).update({ url: corta(real, 500) }).catch(() => {});
  }
  const meta = await comPrazo(require('./articleSource').extrairMetadadosImagemArtigo(url), 20_000);
  if (!require('./articleSource').imagemServeDeCapa(meta?.imagem)) return null;
  const imagem = corta(String(meta.imagem), 1000);
  await db('biblioteca_posts').where({ id: post.id }).update({ thumbnail: imagem }).catch(() => {});
  return imagem;
}

// Uma busca por dot de cada vez; post já tentado não é tentado de novo.
const capasEmAndamento = new Set();
const capasTentadas = new Set();

/**
 * Completa em segundo plano as capas dos posts recentes do dot que ficaram
 * sem imagem — primeiro os do assunto pedido. 3 ao mesmo tempo, para não
 * sobrecarregar os sites; cada post é tentado uma vez por processo.
 */
async function completarCapasDosPosts(dot, { limite = 12 } = {}) {
  if (capasEmAndamento.has(dot.id)) return 0;
  const fonteIds = parseJson(dot.fonte_ids, []);
  if (!fonteIds.length) return 0;
  capasEmAndamento.add(dot.id);
  try {
    return await completarCapasAgora(dot, fonteIds, limite);
  } finally {
    capasEmAndamento.delete(dot.id);
  }
}

async function completarCapasAgora(dot, fonteIds, limite) {
  const plano = parseJson(dot.plano, {});
  const linhas = await db('biblioteca_posts')
    .where('user_id', dot.user_id)
    .whereIn('fonte_id', fonteIds)
    .where((q) => q.whereNull('thumbnail').orWhere('thumbnail', ''))
    .where('created_at', '>=', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
    .orderBy('created_at', 'desc')
    .limit(60)
    .select('id', 'url', 'titulo', 'resumo', 'thumbnail')
    .catch(() => []);
  const fila = linhas
    .filter((p) => !capasTentadas.has(p.id))
    .map((p) => ({ p, noAssunto: palavraQueCasou(p, plano.palavras) ? 1 : 0 }))
    .sort((a, b) => b.noAssunto - a.noAssunto)
    .slice(0, limite)
    .map((x) => x.p);

  let feitas = 0;
  let proximo = 0;
  await Promise.all(Array.from({ length: Math.min(3, fila.length) }, async () => {
    while (proximo < fila.length) {
      const post = fila[proximo];
      proximo += 1;
      capasTentadas.add(post.id);
      if (capasTentadas.size > 5000) capasTentadas.delete(capasTentadas.values().next().value);
      if (await capaDoPost(post).catch(() => null)) feitas += 1;
    }
  }));
  if (feitas) console.info(`[dots #${dot.id}] ${feitas} capa(s) de reportagem completada(s)`);
  return feitas;
}

const HOST_SOCIAL = /(?:^|\.)(?:facebook\.com|fb\.watch|instagram\.com|tiktok\.com|x\.com|twitter\.com|youtube\.com|youtu\.be|threads\.net)$/i;

/**
 * O post tem material para virar matéria? A regra de texto mínimo é para post
 * de rede social (a legenda é tudo o que existe). Link de site de notícia vem
 * do feed só com título/resumo, mas a IA lê a reportagem inteira ao escrever —
 * descartar por "pouco texto" jogava fora matéria boa do g1, BBC etc.
 */
function postTemMaterial(post) {
  let host = '';
  try {
    host = new URL(String(post?.url || '')).hostname.replace(/^www\./i, '');
  } catch {
    host = '';
  }
  // Notícia do Google Notícias (pesquisa) também é reportagem: na hora de
  // escrever, o link do Google vira o da reportagem e a IA lê o texto inteiro.
  if (host && !HOST_SOCIAL.test(host)) return true;
  return require('./furosSociais').conteudoSuficiente(post);
}

/** Posts que falharam neste dot nas últimas horas (não voltam já na próxima volta). */
async function urlsQueFalharamRecentemente(dot, horas = 2) {
  return db(LOG)
    .where({ dot_id: dot.id, acao: 'erro' })
    .whereNotNull('url')
    .where('created_at', '>=', new Date(Date.now() - horas * 60 * 60 * 1000))
    .distinct('url')
    .pluck('url')
    .catch(() => []);
}

/**
 * Post que não virou matéria sai da fila: na 2ª falha (ou quando a IA diz que
 * não há conteúdo) vira "ignorado" de vez. Antes ele ficava como "novo" e
 * cada volta — e cada "Trabalhar agora" — tentava escrever o MESMO post.
 */
async function tirarPostDaFila(dot, post, err) {
  const anteriores = await db(LOG)
    .where({ dot_id: dot.id, acao: 'erro', url: post.url })
    .count({ total: '*' })
    .then(([r]) => Number(r?.total) || 0)
    .catch(() => 0);
  const definitivo = err?.code === 'SEM_MATERIA' || anteriores >= 1;
  // Não definitivo: devolve o post à fila (ele estava reservado para escrita).
  await db('biblioteca_posts')
    .where({ id: post.id })
    .whereNull('matter_id')
    .update({ status: definitivo ? 'ignorado' : 'visto' })
    .catch(() => {});
  return definitivo;
}

async function escrever(dot, post) {
  const { escreverPeloChat } = require('./materiaPorChat');
  const { comProvedor } = require('./deepseekService');
  const escolhido = dot.provedor && dot.provedor !== 'auto' ? dot.provedor : null;
  // Dot em "automático": escreve com o modelo fixado em /claude → Piloto
  // automático (ex.: ChatGPT 5.6), igual ao piloto. Antes passava um
  // comModelo vazio e a matéria saía pelo Claude, ignorando a escolha.
  const modeloPiloto = escolhido
    ? null
    : await require('./iaModeloTarefaService').modeloDaTarefa('piloto').catch(() => null);
  const tokenFree = require('./tokenFreeGatewayService');
  // Post sem foto (feed RSS/Google): busca a capa de dentro da reportagem
  // antes de escrever, igual ao piloto, para a matéria já nascer com ela.
  if (!require('./articleSource').imagemServeDeCapa(post.thumbnail)) {
    post.thumbnail = (await capaDoPost(post).catch(() => null)) || post.thumbnail;
  }
  // Link da reportagem original (não o do Google Notícias).
  const urlLeitura = await urlParaEscrever(post);

  // comProvedor fixa a IA só nesta volta; sem escolha, roteamento normal.
  const tarefa = comProvedor(escolhido, () => escreverPeloChat(
    {
      chatService: require('./materiaChatService'),
      comModelo: modeloPiloto ? tokenFree.comModelo : (_modelo, fn) => fn(),
    },
    {
      userId: dot.user_id,
      modelo: modeloPiloto,
      url: urlLeitura,
      facebookPageId: dot.facebook_page_id || null,
      imagemUrl: require('./articleSource').imagemServeDeCapa(post.thumbnail) ? post.thumbnail : null,
      origem: 'dots',
      // "título mais polêmico", "texto curto" — o pedido do editor chegava a
      // ser interpretado e guardado, mas nunca influenciava a escrita.
      instrucaoEditorial: parseJson(dot.plano, {}).estilo || null,
    }
  ));

  const limite = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('a escrita passou de 15 min')), LIMITE_ESCRITA_MS).unref?.()
  );
  const { matterId } = await Promise.race([tarefa, limite]);
  return matterId;
}

/**
 * A foto que a matéria vai usar de fato — é ela que o OCR precisa olhar.
 *
 * `post.thumbnail` sozinho não serve: os raspadores do Facebook gravam o post
 * na biblioteca sem imagem, e a foto só aparece quando o chat extrai o link e
 * salva em `imagem_fonte_url`. Checar só a thumbnail fazia todo post cair no
 * "não consegui checar" e ganhar imagem de IA.
 */
function fotoParaChecar(matter, post) {
  const { imagemServeDeCapa } = require('./articleSource');
  const daMateria = String(matter?.imagem_fonte_url || matter?.imagem_url || '').trim();
  // /media/artes/ é a arte composta (com título por cima), não a foto original.
  // Logo do Google Notícias/agregador conta como "sem foto": aí a IA gera a capa.
  if (daMateria && !/\/media\/artes\//i.test(daMateria) && imagemServeDeCapa(daMateria)) return daMateria;
  const thumb = String(post?.thumbnail || '').trim();
  return imagemServeDeCapa(thumb) ? thumb : null;
}

/**
 * Resolve a imagem da matéria conforme o modo escolhido no dot.
 *
 * 'ia_com_texto' é o caso interessante: foto de portal costuma vir com
 * manchete, logo ou marca d’água embutida, e aí republicar a foto fica ruim.
 * O OCR decide — abaixo do limiar, a foto original serve e não se gasta uma
 * geração de imagem à toa.
 *
 * Nunca lança: imagem é acessório, matéria escrita não se perde por isso.
 */
async function resolverCapa(dot, post, matterId) {
  const modo = dot.modo_imagem || 'original';
  // Escolha explícita de não ter arte: respeita e sai.
  if (modo === 'sem_imagem') return modo;

  if (modo === 'original') {
    const matter = await require('../models/AiMatters').findById(matterId).catch(() => null);
    if (fotoParaChecar(matter, post)) return 'original';
    // Sem foto nenhuma a matéria ia ao ar sem capa — inútil no feed. Link de
    // site bloqueado para leitura direta cai muito aqui.
    await registrarLog(dot, 'ignorou', {
      detalhe: 'nenhuma foto veio da fonte — gerando ilustração com IA',
      url: post.url,
      matterId,
    });
  }

  if (modo === 'ia_com_texto') {
    const matter = await require('../models/AiMatters').findById(matterId).catch(() => null);
    const foto = fotoParaChecar(matter, post);

    if (foto) {
      try {
        const { fetchImage } = require('./editorialCardService');
        const buffer = await fetchImage(foto);
        const { analisarTextoDaImagem } = require('./imageOcrService');
        const ocr = await analisarTextoDaImagem(buffer);
        if (!ocr.temTexto) {
          await registrarLog(dot, 'ignorou', {
            detalhe: `foto original sem texto (${ocr.palavras} palavra(s)) — mantida sem gerar IA`,
            url: post.url,
            matterId,
          });
          return 'original';
        }
      } catch (err) {
        // O editor pediu IA SÓ quando a foto tiver texto. Sem conseguir checar,
        // não há texto confirmado: fica a foto original. Gerar "por garantia"
        // era o que fazia toda matéria sair com imagem de IA.
        console.warn(`[dots #${dot.id}] OCR falhou, mantendo a foto original: ${err.message}`);
        await registrarLog(dot, 'erro', {
          detalhe: corta(
            `não consegui checar texto na foto (${err.message}); mantive a foto original`,
            600
          ),
          url: post.url,
          matterId,
        });
        return 'original';
      }
    } else {
      // Sem foto nenhuma não há original para manter: a ilustração é a única capa.
      await registrarLog(dot, 'ignorou', {
        detalhe: 'matéria sem foto original — gerando ilustração com IA',
        url: post.url,
        matterId,
      });
    }
  }

  try {
    await require('./materiaPorChat').aplicarCapaChatgpt({
      userId: dot.user_id,
      matterId,
      thumbnail: post.thumbnail,
      permitirSimbolica: true,
      // "só se tiver texto" quer a foto limpa, não uma cena inventada.
      modo: modo === 'ia_com_texto' ? 'limpar_texto' : 'recriar',
    });
    return 'ia';
  } catch (err) {
    await registrarLog(dot, 'erro', {
      detalhe: corta(`imagem da IA falhou (${err.message}); fica a foto original`, 600),
      url: post.url,
      matterId,
    });
    return 'original';
  }
}

/**
 * Agenda a saída da matéria, do mesmo jeito que o Piloto automático faz:
 * marca a matéria como 'agendado' com scheduled_at e cria o job na fila que
 * publica na hora marcada. Só mexer no ai_matters não publicaria nada.
 *
 * O horário acumula a partir da última agendada deste dot, para duas matérias
 * da mesma volta não saírem no mesmo minuto.
 */
async function agendarSaida(dot, matterId, posicao, { imediato = false } = {}) {
  const minutos = Number(dot.agendar_minutos) || Number(dot.intervalo_minutos) || 15;
  try {
    // Publicar não espalha no tempo: o próprio ciclo já dá o ritmo (1 por
    // volta, a cada intervalo_minutos). Espaçar de novo atrasaria a saída.
    let quando = new Date();
    if (!imediato) {
      const ultima = await db(TABELA).where({ id: dot.id }).first('proxima_saida_at');
      const base = ultima?.proxima_saida_at ? new Date(ultima.proxima_saida_at).getTime() : 0;
      quando = new Date(Math.max(Date.now(), base) + minutos * 60_000 * (posicao === 0 ? 0 : 1));
    }

    const AiMatters = require('../models/AiMatters');
    await AiMatters.update(matterId, {
      status: 'agendado',
      scheduled_at: quando,
      ...(dot.facebook_page_id ? { facebook_page_id: dot.facebook_page_id } : {}),
    });

    const job = await db('ai_fila_jobs').where({ matter_id: matterId, status: 'pendente' }).first('id');
    if (job) await db('ai_fila_jobs').where({ id: job.id }).update({ run_at: quando });
    else await db('ai_fila_jobs').insert({
      user_id: dot.user_id,
      matter_id: matterId,
      run_at: quando,
      status: 'pendente',
      payload: JSON.stringify({ action: 'publish', matterId, origem: 'dots' }),
    });

    // Guarda o próximo horário livre para a volta seguinte não atropelar.
    if (!imediato) {
      await db(TABELA)
        .where({ id: dot.id })
        .update({ proxima_saida_at: new Date(quando.getTime() + minutos * 60_000) });
    }
    return quando;
  } catch (err) {
    console.warn(`[dots #${dot.id}] agendar matéria ${matterId}: ${err.message}`);
    await registrarLog(dot, 'erro', { detalhe: corta(`não consegui agendar: ${err.message}`, 600), matterId });
    return null;
  }
}

/**
 * Quais páginas esta volta varre, girando pela lista.
 *
 * Antes a janela era `slice(0, 10)` fixo: um dot com 26 páginas lia sempre as
 * 10 primeiras e as 16 do fim nunca geravam matéria. Aqui a volta continua de
 * onde a anterior parou e a lista inteira é coberta ao longo dos ciclos.
 *
 * @returns {{ aVarrer: number[], proximoCursor: number }}
 */
function janelaDeFontes(fonteIds, cursor = 0, tamanho = FONTES_POR_CICLO) {
  const lista = Array.isArray(fonteIds) ? fonteIds : [];
  if (!lista.length) return { aVarrer: [], proximoCursor: 0 };
  if (lista.length <= tamanho) return { aVarrer: [...lista], proximoCursor: 0 };

  const inicio = ((Number(cursor) || 0) % lista.length + lista.length) % lista.length;
  const aVarrer = Array.from({ length: tamanho }, (_, i) => lista[(inicio + i) % lista.length]);
  return { aVarrer, proximoCursor: (inicio + tamanho) % lista.length };
}

/** Uma volta de trabalho de um dot. Nunca lança: erro vira registro. */
/**
 * Pega o dot para esta volta, em uma única instrução no banco.
 *
 * O botão "Trabalhar agora" chamava `rodarCiclo` direto, sem respeitar o
 * `rodando` do tick nem a reserva do `proxima_execucao_at`. Clicar nele
 * enquanto o tick já rodava o mesmo dot gerava dois ciclos em paralelo: cada
 * um escolhia o mesmo melhor candidato antes de o outro marcá-lo, e a matéria
 * saía duplicada.
 *
 * `trabalhando` já existia na tabela, mas só como enfeite da tela. Aqui ele
 * vira a trava: o UPDATE condicional só afeta linha se ninguém estiver com o
 * dot, e quem não afetar nada desiste da volta.
 */
async function reservarCiclo(dotId) {
  const limiteTrava = new Date(Date.now() - TRAVA_CICLO_MS);
  const linhas = await db(TABELA)
    .where({ id: dotId })
    .andWhere(function livre() {
      this.where('trabalhando', false).orWhere('atividade_em', '<', limiteTrava);
    })
    .update({
      trabalhando: true,
      atividade: 'Começando a volta…',
      atividade_em: new Date(),
    });
  return Number(linhas) > 0;
}

/**
 * Escreve UM post: matéria, capa, agenda/publicação e registro. Usada pela
 * volta automática e pelo botão "Escrever agora" do painel. Nunca lança:
 * falha tira o post da fila e devolve false.
 */
async function processarPost(dot, post, { indice = 1, total = 1, plano = parseJson(dot.plano, {}) } = {}) {
  // Reserva o post antes de escrever: dois dots com a mesma página (ou a volta
  // e o "Escrever agora") pegavam o mesmo post ao mesmo tempo e a matéria
  // saía repetida. Só quem reservar escreve.
  const reservou = await db('biblioteca_posts')
    .where({ id: post.id })
    .whereNull('matter_id')
    .whereIn('status', ['novo', 'visto'])
    .update({ status: 'gerado_texto' })
    .catch(() => 0);
  if (!reservou) {
    await registrarLog(dot, 'ignorou', { detalhe: 'post já está sendo escrito (ou já virou matéria) — pulei', url: post.url });
    return false;
  }
  await marcarAtividade(
    dot.id,
    `Escrevendo ${indice}/${total}: ${corta(post.titulo || post.fonte_nome, 120) || post.url}`
  );
  try {
    const matterId = await escrever(dot, post);
    if (matterId) {
      await db('biblioteca_posts').where({ id: post.id }).update({ matter_id: matterId });

      await marcarAtividade(dot.id, `Resolvendo a imagem de ${indice}/${total}…`);
      const capa = await resolverCapa(dot, post, matterId);

      // 'publicar' só escrevia "na fila" no log e não enfileirava nada: a
      // matéria ficava parada como rascunho enquanto a tela dizia que saiu.
      let agendada = null;
      let publicada = false;
      if (dot.destino === 'agendar') {
        agendada = await agendarSaida(dot, matterId, indice - 1);
      } else if (dot.destino === 'publicar') {
        publicada = Boolean(await agendarSaida(dot, matterId, indice - 1, { imediato: true }));
      }

      const casou = palavraQueCasou(post, plano.palavras);
      await registrarLog(dot, 'escreveu', {
        detalhe: corta(
          [
            post.titulo || post.fonte_nome || 'matéria',
            ...(casou ? [`palavra-chave: ${casou}`] : []),
            capa === 'ia' ? 'imagem IA' : capa === 'sem_imagem' ? 'sem imagem' : 'foto original',
            agendada
              ? `sai ${agendada.toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
              : dot.destino === 'publicar'
                ? publicada
                  ? 'na fila para publicar'
                  : 'não entrou na fila — ficou como rascunho'
                : 'rascunho',
          ].join(' · '),
          600
        ),
        url: post.url,
        matterId,
      });
      return true;
    } else {
      const semMateria = Object.assign(new Error('a IA não gerou matéria'), { code: 'SEM_MATERIA' });
      await tirarPostDaFila(dot, post, semMateria);
      await registrarLog(dot, 'ignorou', { detalhe: 'a IA não gerou matéria — post tirado da fila, vou para o próximo', url: post.url });
    }
  } catch (err) {
    if (falhaDaIa(err)) {
      // O post não tem culpa: volta para a fila sem contar falha (o log vai
      // sem url, para não entrar na quarentena de 2 h). A volta para aqui —
      // tentar o próximo post só repetiria o erro e queimaria a fila.
      await db('biblioteca_posts')
        .where({ id: post.id })
        .whereNull('matter_id')
        .update({ status: 'visto' })
        .catch(() => {});
      await registrarLog(dot, 'erro', {
        detalhe: corta(`A IA que escreve não respondeu (${err.message}). O post voltou para a fila.`, 600),
      });
      throw Object.assign(
        new Error(
          `A IA que escreve está fora do ar: ${err.message} Os posts continuam na fila. ` +
            'Ligue essa IA ou troque em Configuração › "IA que escreve".'
        ),
        { infraIa: true }
      );
    }
    // Sem isto o post seguia como "novo" e era escolhido de novo na volta
    // seguinte (ou no "Trabalhar agora"), falhando sempre no mesmo lugar.
    const definitivo = await tirarPostDaFila(dot, post, err);
    await registrarLog(dot, 'erro', {
      detalhe: corta(
        `${err.message} — ${definitivo ? 'post descartado' : 'post fica de fora por 2 h'}, vou para o próximo`,
        600
      ),
      url: post.url,
    });
  }
  return false;
}

/**
 * Confere em até 3 s se a IA que vai escrever está no ar. Só o gateway
 * (ChatGPT/Claude pelo navegador) cai sozinho; DeepSeek e Claude por API
 * respondem o próprio erro na hora, então não precisam disso.
 */
async function conferirIaDeEscrita(dot) {
  if (dot.provedor && dot.provedor !== 'auto') return;
  const tokenFree = require('./tokenFreeGatewayService');
  const modelo = await require('./iaModeloTarefaService').modeloDaTarefa('piloto').catch(() => null);
  if (!modelo && !tokenFree.isConfigured()) return;
  try {
    await tokenFree.verificarSaude({ timeout: 3000 });
  } catch (err) {
    if (falhaDaIa(err)) {
      throw erro(
        `A IA que escreve está fora do ar: ${err.message} Ligue essa IA ou troque em Configuração › "IA que escreve".`,
        503
      );
    }
  }
}

/**
 * A falha é da IA que escreve (fora do ar, sessão expirada, sem crédito,
 * limite de uso) e não do post? Antes o post levava a culpa: na 2ª falha era
 * descartado para sempre — com o gateway desligado, cada volta queimava uma
 * notícia boa.
 */
function falhaDaIa(err) {
  if (!err) return false;
  if (err.iaPausada || err.infraIa) return true;
  const status = Number(err.status || err.response?.status || 0);
  if (status === 402 || status === 429) return true;
  const codigo = String(err.code || '').toUpperCase();
  if (['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'].includes(codigo)) return true;
  return /Token-Free Gateway (?:nao|não) esta acessivel|Sessao do Token-Free Gateway expirada|Token-Free Gateway excedeu|limitou temporariamente|Créditos acabaram|insufficient[_ ]quota|ECONNREFUSED|socket hang up/i
    .test(String(err.message || ''));
}

async function rodarCiclo(dot) {
  // Duas voltas no mesmo dot escrevem a mesma matéria duas vezes.
  if (!(await reservarCiclo(dot.id))) {
    console.info(`[dots #${dot.id}] já há uma volta em andamento; esta foi dispensada`);
    return;
  }

  const agora = new Date();

  // Jornada: fora dos dias/horário escolhidos o dot não trabalha. Dorme até a
  // próxima volta em vez de varrer e escrever de madrugada.
  const jornada = dentroDaJanela(dot, agora);
  if (!jornada.ok) {
    await db(TABELA).where({ id: dot.id }).update({
      trabalhando: false,
      atividade: null,
      proxima_execucao_at: new Date(Date.now() + Math.max(15, Number(dot.saida_minutos) || 15) * 60_000),
      ultimo_resumo: corta(jornada.motivo, 500),
      ultimo_erro: null,
    });
    return;
  }

  const plano = parseJson(dot.plano, {});
  let escritas = 0;
  let ignorados = 0;
  let cursorFonte = Number(dot.cursor_fonte) || 0;
  let scanEm = dot.ultimo_scan_at || null;

  // Contagem do dia zera sozinha na virada.
  const dia = hoje();
  const feitasHoje = dot.dia_contagem === dia ? Number(dot.feitas_hoje) || 0 : 0;
  const saldo = Math.max(0, Number(dot.limite_dia) - feitasHoje);

  try {
    // 1) Puxa post novo das páginas do dot.
    //
    // Entregar de 15 em 15 min não obriga a reler as 26 páginas de 15 em 15:
    // com scan_minutos, a leitura segue o ritmo que o editor pediu e as voltas
    // intermediárias só aproveitam o que já está na biblioteca.
    const fonteIds = parseJson(dot.fonte_ids, []);
    const scanCada = Number(dot.scan_minutos) || 0;
    const ultimoScan = dot.ultimo_scan_at ? new Date(dot.ultimo_scan_at).getTime() : 0;
    const scanVencido = !scanCada || !ultimoScan || Date.now() - ultimoScan >= scanCada * 60_000;

    // Estoque vazio e a próxima varredura só daqui a uma hora deixaria o dot
    // ocioso justamente quando há vaga para escrever. Nesse caso ele relê
    // agora: é isso que mantém varredura e escrita em sincronia.
    let estoqueVazio = false;
    if (!scanVencido && fonteIds.length && plano.acao !== 'monitorar' && saldo) {
      const [{ total = 0 } = {}] = await db('biblioteca_posts')
        .where('user_id', dot.user_id)
        .whereIn('fonte_id', fonteIds)
        .whereNull('matter_id')
        .whereIn('status', ['novo', 'visto'])
        .count({ total: '*' });
      estoqueVazio = Number(total) === 0;
      if (estoqueVazio) {
        await marcarAtividade(dot.id, 'Estoque vazio: relendo as páginas antes da hora…');
      }
    }

    const vaiVarrer = scanVencido || estoqueVazio;

    const janela = vaiVarrer
      ? janelaDeFontes(fonteIds, dot.cursor_fonte)
      : { aVarrer: [], proximoCursor: Number(dot.cursor_fonte) || 0 };
    const aVarrer = janela.aVarrer;
    cursorFonte = janela.proximoCursor;
    if (vaiVarrer) scanEm = agora;

    if (aVarrer.length) {
      const bibliotecaService = require('./bibliotecaService');
      let n = 0;
      for (const fonteId of aVarrer) {
        n += 1;
        await marcarAtividade(
          dot.id,
          `Varrendo página ${n} de ${aVarrer.length}` +
            (fonteIds.length > aVarrer.length ? ` (de ${fonteIds.length} no total)` : '') +
            '…'
        );
        try {
          await bibliotecaService.escanearAgora(dot.user_id, fonteId);
        } catch (err) {
          console.warn(`[dots #${dot.id}] varrer fonte ${fonteId}:`, err.message);
        }
      }
    }

    // Sem fonte nenhuma o dot gira para sempre sem nada para ler, mas a tela
    // mostrava "Agendado · próxima volta em 4 min" como se estivesse saudável.
    if (!fonteIds.length) {
      await db(TABELA).where({ id: dot.id }).update({
        trabalhando: false,
        atividade: null,
        ultimo_run_at: agora,
        proxima_execucao_at: new Date(Date.now() + dot.intervalo_minutos * 60_000),
        ultimo_resumo: 'Nenhuma página monitorada: não há o que ler.',
        ultimo_erro:
          'Este dot não tem página monitorada. Veja em Atividade por que o link não entrou e crie o dot de novo.',
      });
      return;
    }

    // 2) Escolhe o que presta.
    await marcarAtividade(dot.id, 'Separando os posts que dão matéria…');
    const candidatos = await candidatosDoDot(dot);

    if (plano.acao === 'monitorar' || !saldo) {
      await db(TABELA).where({ id: dot.id }).update({
        trabalhando: false,
        atividade: null,
        ultimo_run_at: agora,
        cursor_fonte: cursorFonte,
        ultimo_scan_at: scanEm,
        proxima_execucao_at: new Date(Date.now() + dot.intervalo_minutos * 60_000),
        ultimo_resumo: corta(
          saldo
            ? `${candidatos.length} post(s) novo(s) em acompanhamento.`
            : `Limite de ${dot.limite_dia} por dia atingido.`,
          500
        ),
        ultimo_erro: null,
      });
      return;
    }

    // 3) Escreve, respeitando o saldo do dia.
    const porVolta = Math.min(
      Math.max(1, Number(dot.materias_por_volta) || 1),
      ESCRITAS_POR_CICLO_MAX
    );
    const paraEscrever = candidatos.slice(0, Math.min(porVolta, saldo));
    let indice = 0;
    // IA de escrita fora do ar: a volta para no primeiro post (que volta para
    // a fila) e o motivo aparece no dot, em vez de queimar os outros posts.
    let iaForaDoAr = null;
    for (const post of paraEscrever) {
      indice += 1;
      try {
        if (await processarPost(dot, post, { indice, total: paraEscrever.length, plano })) escritas += 1;
        else ignorados += 1;
      } catch (err) {
        if (!err.infraIa) throw err;
        iaForaDoAr = err.message;
        break;
      }
    }

    await db(TABELA).where({ id: dot.id }).update({
      trabalhando: false,
      atividade: null,
      ultimo_run_at: agora,
      cursor_fonte: cursorFonte,
      ultimo_scan_at: scanEm,
      proxima_execucao_at: new Date(Date.now() + dot.intervalo_minutos * 60_000),
      feitas_hoje: feitasHoje + escritas,
      dia_contagem: dia,
      ultimo_resumo: corta(
        `${candidatos.length} candidato(s); ${escritas} matéria(s) escrita(s)` +
          `${ignorados ? `; ${ignorados} sem sucesso` : ''}.`,
        500
      ),
      ultimo_erro: iaForaDoAr ? corta(iaForaDoAr, 500) : null,
    });
    // Depois da volta, completa as capas que os feeds não trouxeram.
    completarCapasDosPosts(dot).catch(() => {});
  } catch (err) {
    console.error(`[dots #${dot.id}]`, err.message);
    await db(TABELA).where({ id: dot.id }).update({
      trabalhando: false,
      atividade: null,
      ultimo_run_at: agora,
      cursor_fonte: cursorFonte,
      ultimo_scan_at: scanEm,
      proxima_execucao_at: new Date(Date.now() + dot.intervalo_minutos * 60_000),
      ultimo_erro: corta(err.message, 500),
    });
    await registrarLog(dot, 'erro', { detalhe: corta(err.message, 600) });
  } finally {
    // Rede de segurança da trava: se até o `catch` estourar (banco fora, por
    // exemplo), sem isto o dot ficaria preso até o resgate de 30 min.
    try {
      await db(TABELA).where({ id: dot.id }).update({ trabalhando: false });
    } catch (err) {
      console.warn(`[dots #${dot.id}] não consegui liberar a trava:`, err.message);
    }
  }
}

/**
 * Chamado pelo tick do servidor. Pega um dot vencido por vez: escrever é
 * lento, e dois ciclos juntos competiriam pela mesma conta de IA.
 */
/** Quando este processo subiu: o que ficou "trabalhando" antes disso é sobra. */
const INICIO_PROCESSO = new Date();
let travasConferidas = false;

/**
 * Libera o que o processo anterior deixou preso (servidor reiniciado, pm2
 * reload no meio de uma volta).
 *
 * Sem isto o dot ficava 30 min travado como "trabalhando", e o post que ele
 * estava escrevendo ficava reservado ('gerado_texto' sem matéria) para
 * sempre: nem virava matéria, nem voltava para a fila. Só mexe no que é
 * anterior ao início deste processo — uma volta iniciada agora (um clique em
 * "Escrever agora" logo após o boot) não é tocada.
 *
 * Premissa: um único processo roda o tick (ecosystem.config.cjs: instances 1,
 * fork). Com duas instâncias, uma soltaria a trava da volta da outra.
 */
async function liberarTravasDoProcessoAnterior() {
  const presos = await db(TABELA)
    .where({ trabalhando: true })
    .andWhere(function antigos() {
      this.whereNull('atividade_em').orWhere('atividade_em', '<', INICIO_PROCESSO);
    })
    .select('id', 'user_id', 'fonte_ids');
  if (!presos.length) return 0;

  await db(TABELA).whereIn('id', presos.map((d) => d.id)).update({ trabalhando: false, atividade: null });
  let posts = 0;
  for (const dot of presos) {
    // Outro dot do mesmo editor escrevendo agora (neste processo) pode estar
    // com um destes posts: aí não mexe.
    const ocupado = await db(TABELA)
      .where({ user_id: dot.user_id, trabalhando: true })
      .where('atividade_em', '>=', INICIO_PROCESSO)
      .first('id')
      .catch(() => null);
    const fonteIds = parseJson(dot.fonte_ids, []);
    if (ocupado || !fonteIds.length) continue;
    posts += Number(
      await db('biblioteca_posts')
        .whereIn('fonte_id', fonteIds)
        .where({ user_id: dot.user_id, status: 'gerado_texto' })
        .whereNull('matter_id')
        .update({ status: 'visto' })
        .catch(() => 0)
    ) || 0;
  }
  console.info(`[dots] processo reiniciado: ${presos.length} dot(s) destravado(s), ${posts} post(s) de volta à fila`);
  return presos.length;
}

async function tick() {
  if (rodando) return;
  rodando = true;
  try {
    if (!travasConferidas) {
      travasConferidas = true;
      await liberarTravasDoProcessoAnterior().catch((err) => console.warn('[dots] destravar:', err.message));
    }
    const dot = await db(TABELA)
      .where('estado', 'ativo')
      .andWhere(function vencido() {
        this.whereNull('proxima_execucao_at').orWhere('proxima_execucao_at', '<=', new Date());
      })
      .orderBy('proxima_execucao_at', 'asc')
      .first();
    if (!dot) return;
    // Reserva: empurra o relógio antes de trabalhar, para outra volta do tick
    // não pegar o mesmo dot se este ciclo demorar.
    await db(TABELA)
      .where({ id: dot.id })
      .update({ proxima_execucao_at: new Date(Date.now() + dot.intervalo_minutos * 60_000) });
    await rodarCiclo(dot);
  } catch (err) {
    console.error('[dots tick]', err.message);
  } finally {
    rodando = false;
  }
}

// ------------------------------------------------------------------ painel

async function listar(userId) {
  const linhas = await db(TABELA).where({ user_id: userId }).orderBy('created_at', 'desc');

  // Para onde cada dot manda. O cartão não mostrava isso, então uma matéria na
  // página errada era impossível de perceber antes de ir ao ar.
  const paginaIds = [...new Set(linhas.map((d) => Number(d.facebook_page_id)).filter(Boolean))];
  const nomePorPagina = new Map();
  if (paginaIds.length) {
    const paginas = await db('facebook_pages').whereIn('id', paginaIds).select('id', 'page_name');
    for (const p of paginas) nomePorPagina.set(Number(p.id), p.page_name || `Página ${p.id}`);
  }

  return linhas.map((d) => {
    const plano = parseJson(d.plano, {});
    return {
      id: d.id,
      nome: d.nome,
      objetivo: d.objetivo,
      plano,
      fontes: parseJson(d.fonte_ids, []).length,
      pesquisas: Array.isArray(plano.pesquisas) ? plano.pesquisas : [],
      estado: d.estado,
      trabalhando: Boolean(d.trabalhando),
      atividade: d.atividade,
      atividade_em: d.atividade_em,
      intervalo_minutos: d.intervalo_minutos,
      limite_dia: d.limite_dia,
      destino: d.destino,
      materias_por_volta: d.materias_por_volta || 1,
      modo_imagem: d.modo_imagem || 'original',
      agendar_minutos: d.agendar_minutos,
      provedor: d.provedor || 'auto',
      facebook_page_id: d.facebook_page_id || null,
      // Sem página escolhida, a matéria cai na página padrão da conta na hora
      // de salvar — e era justamente isso que acontecia sem ninguém ver.
      pagina: d.facebook_page_id
        ? nomePorPagina.get(Number(d.facebook_page_id)) || `Página ${d.facebook_page_id}`
        : null,
      feitas_hoje: d.dia_contagem === hoje() ? d.feitas_hoje : 0,
      proxima_execucao_at: d.proxima_execucao_at,
      ultimo_run_at: d.ultimo_run_at,
      ultimo_resumo: d.ultimo_resumo,
      ultimo_erro: d.ultimo_erro,
    };
  });
}

/** Matéria no formato que o painel usa (cartão com ações). */
function materiaParaTela(m) {
  return {
    id: m.id,
    titulo: m.titulo,
    imagem: m.imagem_url || null,
    status: m.status,
    agendada_para: m.scheduled_at,
    link: m.fb_post_url || null,
    facebook_page_id: m.facebook_page_id || null,
    pagina: m.page_name || null,
    criada_em: m.created_at || null,
    gerando_imagem: imagensEmAndamento.has(Number(m.id)),
  };
}

async function detalhe(userId, dotId) {
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);
  // Posts sem miniatura no painel: completa em segundo plano; a próxima
  // atualização da tela (30 s) já mostra as capas.
  completarCapasDosPosts(dot).catch(() => {});
  const execucoes = await db(LOG)
    .where({ dot_id: dotId })
    .orderBy('created_at', 'desc')
    .limit(50);

  // Todas as matérias que este dot escreveu (não só as do log recente), para
  // os números do painel baterem com o que existe de fato.
  const idsEscritas = await db(LOG)
    .where({ dot_id: dotId, acao: 'escreveu' })
    .whereNotNull('matter_id')
    .distinct('matter_id')
    .pluck('matter_id')
    .catch(() => []);

  // Matérias que o dot rastreou e escreveu, com a arte, o status e a página
  // atuais — a tela mostra a matéria de verdade e as ações sobre ela.
  const ids = [...new Set([
    ...idsEscritas.map(Number),
    ...execucoes.filter((e) => e.acao === 'escreveu' && e.matter_id).map((e) => Number(e.matter_id)),
  ])];
  // O link do post publicado mora em `publications` (ai_matters não tem
  // fb_post_url). Pedir a coluna inexistente quebrava a consulta, e o catch
  // silencioso fazia o painel mostrar "nenhuma matéria" para sempre.
  const materias = ids.length
    ? await db('ai_matters as m')
      .leftJoin('facebook_pages as fp', 'fp.id', 'm.facebook_page_id')
      .leftJoin('publications as pub', 'pub.id', 'm.publication_id')
      .whereIn('m.id', ids)
      .where('m.user_id', userId)
      .select(
        'm.id',
        'm.titulo',
        'm.imagem_url',
        'm.status',
        'm.scheduled_at',
        'pub.fb_post_url',
        'm.facebook_page_id',
        'm.created_at',
        'fp.page_name'
      )
      .catch((err) => {
        console.warn(`[dots #${dotId}] matérias do painel: ${err.message}`);
        return [];
      })
    : [];
  const porId = new Map(materias.map((m) => [Number(m.id), m]));
  const plano = parseJson(dot.plano, {});

  // Fontes do dot com o estado de cada uma: o editor vê o que está sendo lido
  // e por que uma fonte não traz nada.
  const fonteIds = parseJson(dot.fonte_ids, []);
  const desde7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [linhasFontes, contagemPorFonte] = fonteIds.length
    ? await Promise.all([
      db('biblioteca_fontes')
        .whereIn('id', fonteIds)
        .where('user_id', userId)
        .select('id', 'nome', 'plataforma', 'url', 'handle', 'ultimo_scan', 'ultimo_erro')
        .catch(() => []),
      db('biblioteca_posts')
        .whereIn('fonte_id', fonteIds)
        .where('created_at', '>=', desde7d)
        .groupBy('fonte_id')
        .select('fonte_id')
        .count({ total: '*' })
        .catch(() => []),
    ])
    : [[], []];
  const postsDaFonte = new Map(contagemPorFonte.map((l) => [Number(l.fonte_id), Number(l.total) || 0]));
  const fonteRow = new Map(linhasFontes.map((f) => [Number(f.id), f]));
  const fontes = fonteIds
    .map((id) => fonteRow.get(Number(id)))
    .filter(Boolean)
    .map((f) => ({
      id: f.id,
      nome: f.nome,
      plataforma: f.plataforma,
      url: f.url,
      termo: f.plataforma === 'busca' ? f.handle : null,
      ultimo_scan: f.ultimo_scan,
      ultimo_erro: f.ultimo_erro,
      posts_7d: postsDaFonte.get(Number(f.id)) || 0,
    }));

  // Posts que o dot leu (últimos 7 dias) e o que aconteceu com cada um — é o
  // que o editor precisa para entender por que saiu ou não saiu matéria.
  let postsLidos = [];
  if (fonteIds.length) {
    postsLidos = await db('biblioteca_posts as p')
      .join('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
      .where('p.user_id', userId)
      .whereIn('p.fonte_id', fonteIds)
      .where('p.created_at', '>=', desde7d)
      .orderBy('p.created_at', 'desc')
      .limit(200)
      .select(
        'p.id',
        'p.titulo',
        'p.resumo',
        'p.url',
        'p.thumbnail',
        'p.status',
        'p.matter_id',
        'p.created_at',
        'p.publicado_em',
        'p.media_type',
        'p.media_url',
        'f.nome as fonte_nome',
        'f.plataforma as fonte_plataforma',
        'f.handle as fonte_handle'
      )
      .catch(() => []);
  }
  const temPalavras = Array.isArray(plano.palavras) && plano.palavras.length > 0;
  const vereditos = plano.recorte
    ? await vereditosDaTriagem(dot.id, postsLidos.map((p) => Number(p.id)))
    : new Map();
  // As mesmas regras da volta (candidatosDoDot): palavra só para as páginas,
  // tema pela triagem da IA.
  const foraDasPalavras = (p) => p.fonte_plataforma !== 'busca' && temPalavras && !palavraQueCasou(p, plano.palavras);
  const foraDoTema = (p) => vereditos.get(Number(p.id)) === false;

  // Mesmas regras da volta, para o painel dizer a verdade: "na fila" que
  // nunca saía era post que o ciclo pulava (repetido ou falhou há pouco).
  const falhas = await db(LOG)
    .where({ dot_id: dotId, acao: 'erro' })
    .whereNotNull('url')
    .where('created_at', '>=', new Date(Date.now() - 2 * 60 * 60 * 1000))
    .select('url', 'created_at')
    .catch(() => []);
  const falhouEm = new Map();
  for (const f of falhas) {
    const t = new Date(f.created_at).getTime();
    if (!falhouEm.has(f.url) || t > falhouEm.get(f.url)) falhouEm.set(f.url, t);
  }
  const elegiveis = postsLidos.filter((p) =>
    !p.matter_id && ['novo', 'visto'].includes(p.status) &&
    !foraDasPalavras(p) && !foraDoTema(p) && postTemMaterial(p) && !falhouEm.has(p.url)
  );
  let novosIds = new Set(elegiveis.map((p) => p.id));
  try {
    const { novos } = await filtrarJaPublicados(dot, elegiveis);
    novosIds = new Set(semAssuntoRepetidoNaLista(novos).map((p) => p.id));
  } catch {
    // sem a checagem, mostra como elegível
  }

  const posts = postsLidos.map((p) => {
    // Notícia de pesquisa mostra o assunto pesquisado; post de página, a
    // palavra pedida que ele citou.
    const palavra = p.fonte_plataforma === 'busca' ? p.fonte_handle || null : palavraQueCasou(p, plano.palavras);
    let situacao;
    let voltaEm = null;
    if (p.matter_id) situacao = 'materia';
    else if (foraDasPalavras(p) || foraDoTema(p)) situacao = 'fora_do_assunto';
    else if (!postTemMaterial(p)) situacao = 'pouco_texto';
    else if (!['novo', 'visto'].includes(p.status)) situacao = p.status === 'gerado_texto' ? 'escrevendo' : 'descartado';
    else if (falhouEm.has(p.url)) {
      situacao = 'falhou';
      voltaEm = new Date(falhouEm.get(p.url) + 2 * 60 * 60 * 1000).toISOString();
    } else if (!novosIds.has(p.id)) situacao = 'repetido';
    else situacao = 'proximo';
    return {
      volta_em: voltaEm,
      id: p.id,
      titulo: corta(p.titulo || p.resumo || '', 200),
      url: p.url,
      thumbnail: require('./articleSource').imagemServeDeCapa(p.thumbnail) ? p.thumbnail : null,
      fonte: p.fonte_plataforma === 'busca' ? corta(p.resumo, 80) || p.fonte_nome : p.fonte_nome,
      plataforma: p.fonte_plataforma,
      lido_em: p.created_at,
      publicado_em: p.publicado_em,
      palavra,
      situacao,
      matter_id: p.matter_id || null,
    };
  });

  const desde24h = Date.now() - 24 * 60 * 60 * 1000;
  const contar = (fn) => materias.filter(fn).length;
  const resumo = {
    lidos: posts.length,
    no_assunto: posts.filter((p) => p.situacao !== 'fora_do_assunto').length,
    fora_do_assunto: posts.filter((p) => p.situacao === 'fora_do_assunto').length,
    proximos: posts.filter((p) => p.situacao === 'proximo').length,
    escritas: materias.length,
    agendadas: contar((m) => m.status === 'agendado'),
    publicadas: contar((m) => m.status === 'publicado'),
    rascunhos: contar((m) => !['agendado', 'publicado'].includes(m.status)),
    problemas_24h: execucoes.filter((e) => e.acao === 'erro' && new Date(e.created_at).getTime() >= desde24h).length,
  };

  return {
    ...(await listar(userId)).find((d) => d.id === Number(dotId)),
    resumo,
    fontes_lista: fontes,
    // Citadas pelo nome e não achadas: a tela pede o link.
    fontes_nao_achadas: (Array.isArray(plano.fontes) ? plano.fontes : [])
      .filter((f) => f && !f.url)
      .map((f) => ({ tipo: f.tipo, nome: f.nome, motivo: f.motivo || null })),
    posts: posts.slice(0, 80),
    materias: materias.map(materiaParaTela).sort((a, b) => b.id - a.id),
    execucoes: execucoes.map((e) => {
      const m = e.matter_id ? porId.get(Number(e.matter_id)) : null;
      return m ? { ...e, materia: materiaParaTela(m) } : e;
    }),
  };
}

async function alterarEstado(userId, dotId, estado) {
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);
  await db(TABELA)
    .where({ id: dotId })
    .update({
      estado,
      ...(estado === 'ativo' ? { proxima_execucao_at: new Date(), ultimo_erro: null } : {}),
    });
  return { estado };
}

/** Atualiza nome e/ou provedor. Campo ausente fica como está. */
async function atualizar(userId, dotId, { nome, provedor, objetivo }) {
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);

  const dados = {};
  if (nome !== undefined) {
    const limpo = corta(nome, 160);
    if (!limpo) throw erro('Dê um nome ao dot.');
    dados.nome = limpo;
  }
  if (provedor !== undefined) dados.provedor = normalizarProvedor(provedor);

  // Mudar o que o dot deve fazer exigia apagar e recriar, perdendo o histórico
  // e a contagem do dia. Aqui o pedido é reinterpretado e as páginas novas
  // entram, mantendo o resto da configuração como está.
  let resumoFontes = null;
  if (objetivo !== undefined) {
    const texto = String(objetivo || '').trim();
    if (!texto) throw erro('Escreva o que o dot deve fazer.');
    if (texto.length > 8000) throw erro('O objetivo está longo demais (máximo 8000 caracteres).');

    if (texto !== String(dot.objetivo || '').trim()) {
      const anterior = parseJson(dot.plano, {});
      // Fonte já achada pelo nome não é procurada de novo, e o que o editor
      // acrescentou ou tirou pelo painel continua valendo.
      const plano = await montarPlano(texto, { anterior });
      dados.objetivo = texto;
      // Só o que a IA decide é substituído; ritmo e jornada são da tela.
      dados.plano = JSON.stringify({ ...anterior, ...plano });

      // As fontes passam a ser exatamente as do pedido novo: link apagado do
      // texto deixa de ser lido. Se nada entrar, as antigas continuam.
      const { fonteIds, problemas } = await cadastrarFontes(dot, plano);
      if (fonteIds.length) dados.fonte_ids = JSON.stringify(fonteIds);
      resumoFontes = { fontes: fonteIds.length, problemas, plano };
    }
  }

  if (Object.keys(dados).length) await db(TABELA).where({ id: dotId }).update(dados);
  return { ...dados, ...(resumoFontes || {}) };
}

async function renomear(userId, dotId, nome) {
  const limpo = corta(nome, 160);
  if (!limpo) throw erro('Dê um nome ao dot.');
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);
  await db(TABELA).where({ id: dotId }).update({ nome: limpo });
  return { nome: limpo };
}

async function excluir(userId, dotId) {
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);
  await db(TABELA).where({ id: dotId }).del();
  return { removido: true };
}

// ------------------------------------------------ fontes pelo painel

const TIPOS_ADICIONAR = ['busca', ...TIPOS_FONTE];

/**
 * Acrescenta uma fonte pelo painel: um assunto para pesquisar, um link, ou um
 * nome (site, página, perfil, canal) que é procurado e conferido como na
 * criação. Fica gravado em `plano.manuais` para sobreviver a uma edição do
 * pedido.
 */
async function adicionarFonte(userId, dotId, { tipo, texto }) {
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);
  const valor = String(texto || '').replace(/\s+/g, ' ').trim();
  if (valor.length < 2) throw erro('Escreva o assunto, o nome ou o link da fonte.');
  const plano = parseJson(dot.plano, {});
  const manuais = { fontes: [], pesquisas: [], ...(plano.manuais || {}) };
  const removidas = new Set(Array.isArray(plano.removidas) ? plano.removidas : []);

  let pedido;
  const link = extrairUrls(valor)[0];
  if (link) {
    const fonte = fontesDosLinks([link])[0];
    pedido = { fontes: [fonte], pesquisas: [] };
    manuais.fontes = [...manuais.fontes, fonte];
    removidas.delete(`url|${chaveUrl(link)}`);
  } else if (!TIPOS_ADICIONAR.includes(tipo) || tipo === 'busca') {
    const termo = limparPesquisas([valor])[0];
    if (!termo) throw erro('Escreva o assunto que devo pesquisar.');
    pedido = { fontes: [], pesquisas: [termo] };
    manuais.pesquisas = limparPesquisas([...manuais.pesquisas, termo]);
    removidas.delete(`busca|${compactoNome(termo)}`);
  } else {
    const achada = await require('./dotsFontesService').resolverFonte({ tipo, nome: valor });
    if (!achada.url) throw erro(achada.motivo || `Não achei "${valor}". Cole o link.`, 422);
    pedido = { fontes: [achada], pesquisas: [] };
    manuais.fontes = [...manuais.fontes, achada];
    removidas.delete(`url|${chaveUrl(achada.url)}`);
  }

  const { fonteIds, problemas } = await cadastrarFontes(dot, pedido);
  if (!fonteIds.length) throw erro(problemas.join(' | ') || 'A fonte não entrou.', 422);

  const atuais = parseJson(dot.fonte_ids, []).map(Number);
  const todas = [...new Set([...atuais, ...fonteIds])];
  await db(TABELA).where({ id: dot.id }).update({
    fonte_ids: JSON.stringify(todas),
    plano: JSON.stringify({ ...plano, manuais, removidas: [...removidas] }),
    // Fonte nova merece leitura já, não daqui a uma hora.
    ultimo_scan_at: null,
    ...(dot.estado === 'ativo' && !dot.trabalhando ? { proxima_execucao_at: new Date() } : {}),
  });
  return { fontes: todas.length, adicionada: pedido.fontes[0] || { pesquisa: pedido.pesquisas[0] } };
}

/**
 * Tira uma fonte do dot (a Biblioteca continua com ela). Fica anotada em
 * `plano.removidas`, para não voltar quando o pedido for editado.
 */
async function removerFonte(userId, dotId, fonteId) {
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);
  const atuais = parseJson(dot.fonte_ids, []).map(Number);
  if (!atuais.includes(Number(fonteId))) throw erro('Esta fonte não é deste dot.', 404);
  if (atuais.length === 1) {
    throw erro('É a única fonte deste dot. Acrescente outra antes de tirar esta, ou pause o dot.', 409);
  }

  const fonte = await db('biblioteca_fontes').where({ id: Number(fonteId), user_id: userId }).first();
  const plano = parseJson(dot.plano, {});
  const removidas = new Set(Array.isArray(plano.removidas) ? plano.removidas : []);
  const manuais = { fontes: [], pesquisas: [], ...(plano.manuais || {}) };
  if (fonte?.plataforma === 'busca') {
    const termo = fonte.handle || '';
    removidas.add(`busca|${compactoNome(termo)}`);
    manuais.pesquisas = manuais.pesquisas.filter((p) => compactoNome(p) !== compactoNome(termo));
  } else if (fonte?.url) {
    removidas.add(`url|${chaveUrl(fonte.url)}`);
    manuais.fontes = manuais.fontes.filter((f) => chaveUrl(f.url) !== chaveUrl(fonte.url));
  }

  const restantes = atuais.filter((id) => id !== Number(fonteId));
  await db(TABELA).where({ id: dot.id }).update({
    fonte_ids: JSON.stringify(restantes),
    plano: JSON.stringify({ ...plano, manuais, removidas: [...removidas] }),
  });
  await registrarLog(dot, 'criou_fonte', {
    detalhe: corta(`Fonte retirada: ${fonte?.nome || `#${fonteId}`}. Ficam ${restantes.length}.`, 600),
  });
  return { fontes: restantes.length };
}

// ------------------------------------------------ imagem pelo painel

/** Matérias com imagem sendo gerada agora (a tela mostra "Gerando…"). */
const imagensEmAndamento = new Set();

/**
 * "Gerar imagem com IA" de uma matéria do dot. Leva minutos (ChatGPT), então
 * roda em segundo plano; o painel mostra o andamento e a nova arte quando
 * ficar pronta. 'limpar_texto' mantém a foto e só tira as letras.
 */
async function gerarImagemDaMateria(userId, dotId, matterId, { modo = 'recriar' } = {}) {
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);
  const matter = await db('ai_matters').where({ id: Number(matterId), user_id: userId }).first('id', 'status', 'titulo');
  if (!matter) throw erro('Matéria não encontrada.', 404);
  if (matter.status === 'publicado') throw erro('Esta matéria já foi publicada: a imagem não muda mais.', 409);
  if (imagensEmAndamento.has(Number(matter.id))) throw erro('A imagem desta matéria já está sendo gerada.', 409);

  imagensEmAndamento.add(Number(matter.id));
  setImmediate(async () => {
    try {
      await require('./materiaPorChat').aplicarCapaChatgpt({
        userId,
        matterId: Number(matter.id),
        thumbnail: null,
        permitirSimbolica: true,
        modo: modo === 'limpar_texto' ? 'limpar_texto' : 'recriar',
      });
      await registrarLog(dot, 'imagem', {
        detalhe: corta(`Imagem nova com IA: ${matter.titulo || `matéria #${matter.id}`}`, 600),
        matterId: matter.id,
      });
    } catch (err) {
      await registrarLog(dot, 'erro', {
        detalhe: corta(`imagem com IA falhou (${err.message}); a imagem anterior continua`, 600),
        matterId: matter.id,
      });
    } finally {
      imagensEmAndamento.delete(Number(matter.id));
    }
  });
  return { iniciado: true };
}

/** "Trabalhar agora", para não esperar o relógio. */
/**
 * "Escrever agora" de um post do painel: escreve aquele post na hora, sem
 * esperar a volta e sem os filtros de repetido (o editor escolheu). Respeita
 * o destino do dot (rascunho/agendar/publicar) e o limite do dia.
 */
async function escreverPostAgora(userId, dotId, postId) {
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);
  if (dot.trabalhando) throw erro('Este dot já está trabalhando agora. Espere esta volta terminar.', 409);

  const fonteIds = parseJson(dot.fonte_ids, []);
  const post = await db('biblioteca_posts as p')
    .join('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
    .where({ 'p.id': Number(postId), 'p.user_id': userId })
    .whereIn('p.fonte_id', fonteIds.length ? fonteIds : [0])
    .first('p.*', 'f.nome as fonte_nome');
  if (!post) throw erro('Post não encontrado neste dot.', 404);
  if (post.matter_id) throw erro('Este post já virou matéria.', 409);

  const dia = hoje();
  const feitasHoje = dot.dia_contagem === dia ? Number(dot.feitas_hoje) || 0 : 0;
  if (feitasHoje >= Number(dot.limite_dia)) {
    throw erro(`Limite de ${dot.limite_dia} matérias por dia atingido.`, 409);
  }
  // Avisa na hora, em vez de dizer "escrevendo" e falhar um minuto depois.
  await conferirIaDeEscrita(dot);
  if (!(await reservarCiclo(dot.id))) {
    throw erro('Este dot já está trabalhando agora. Espere esta volta terminar.', 409);
  }

  setImmediate(async () => {
    let escrita = false;
    let iaForaDoAr = null;
    try {
      escrita = await processarPost(dot, post);
    } catch (err) {
      // processarPost só lança quando a IA que escreve está fora do ar: o
      // aviso vai para o dot (sem isto a rejeição ficava solta no processo).
      iaForaDoAr = err.message;
    } finally {
      await db(TABELA).where({ id: dot.id }).update({
        trabalhando: false,
        atividade: null,
        ...(escrita ? { feitas_hoje: feitasHoje + 1, dia_contagem: dia, ultimo_erro: null } : {}),
        ...(iaForaDoAr ? { ultimo_erro: corta(iaForaDoAr, 500) } : {}),
      }).catch(() => {});
    }
  });
  return { iniciado: true };
}

async function rodarAgora(userId, dotId) {
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);
  if (dot.estado !== 'ativo') throw erro('Ative o dot antes de mandar trabalhar.');

  // Clicar no botão durante a volta automática era o que duplicava a matéria.
  // A trava em `rodarCiclo` já recusa a segunda, mas dizer "iniciado" seria
  // mentira: o editor clicaria de novo achando que não pegou.
  if (dot.trabalhando) {
    throw erro('Este dot já está trabalhando agora. Espere esta volta terminar.', 409);
  }

  setImmediate(() => void rodarCiclo(dot));
  return { iniciado: true };
}

module.exports = {
  previa,
  criar,
  adicionarFonte,
  removerFonte,
  gerarImagemDaMateria,
  renomear,
  atualizar,
  provedores,
  listar,
  detalhe,
  alterarEstado,
  excluir,
  rodarAgora,
  escreverPostAgora,
  tick,
  // Expostos para teste
  extrairUrls,
  falhaDaIa,
  liberarTravasDoProcessoAnterior,
  montarPlano,
  planoDaTela,
  avisosDoPlano,
  termoDeReserva,
  limparPesquisas,
  limparFontesCitadas,
  fontesDosLinks,
  triarPeloRecorte,
  chaveUrl,
  MODOS_IMAGEM,
  urlParaEscrever,
  postTemMaterial,
  capaDoPost,
  palavraQueCasou,
  fotoParaChecar,
  resolverCapa,
  interpretar,
  janelaDeFontes,
  resumoDoPlano,
  rodiziarPorFonte,
  semRepetirAssunto,
  semAssuntoRepetidoNaLista,
  filtrarJaPublicados,
  filtrarPorPalavras,
  DIAS_HISTORICO_REPETIDO,
  reservarCiclo,
  dentroDaJanela,
  normalizarJornada,
  horaEDiaLocais,
  lerDias,
  DIAS,
  INTERVALOS_VALIDOS,
};
