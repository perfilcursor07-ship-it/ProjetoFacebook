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
/** Teto de matérias por volta. O dot escolhe dentro disso. */
const ESCRITAS_POR_CICLO_MAX = 5;
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

// ------------------------------------------------------------------ plano

const SISTEMA_PLANO = [
  'Você é o assistente que configura um agente ("dot") que trabalha sozinho no servidor.',
  'Converta o pedido do editor em configuração. Responda APENAS com JSON válido,',
  'sem markdown e sem texto fora do objeto.',
  '',
  'Campos:',
  '  nome: rótulo curto (até 60 caracteres) que descreva o trabalho.',
  '  acao: "monitorar_e_escrever" ou "monitorar" (só acompanha, sem escrever).',
  '  intervalo_minutos: de quanto em quanto tempo ele ENTREGA matéria.',
  '      Aceita 10, 15, 30, 60, 120, 180 ou 360.',
  '      Este é o ritmo que o editor vê acontecer. Quando ele disser dois ritmos',
  '      ("monitore a cada 1 hora e publique a cada 15 min"), o ritmo de',
  '      ENTREGA é o que vem para cá: intervalo_minutos 15.',
  '  scan_minutos: de quanto em quanto tempo ele relê as páginas. Use quando o',
  '      editor pedir um ritmo de monitoramento diferente do de entrega',
  '      (no exemplo acima: 60). Null quando ele não separar os dois.',
  '  materias_por_volta: quantas matérias ele escreve a cada volta (1 a 5).',
  '  limite_dia: teto de matérias por dia (1 a 200). Quando o editor disser um',
  '      ritmo, calcule o teto a partir dele (ex.: 1 a cada 15 min = 96 por dia)',
  '      em vez de escolher um número qualquer — teto baixo trava o ritmo pedido.',
  '  destino: "rascunho" (salva para revisar), "agendar" (programa a saída e',
  '      publica na hora marcada — use quando o editor disser "agende e publique")',
  '      ou "publicar" (vai direto para a fila).',
  '  agendar_minutos: com destino "agendar", de quantos em quantos minutos',
  '      cada matéria pronta sai. Null quando não for agendar.',
  '  modo_imagem: "original" usa a foto da matéria de origem;',
  '      "ia_todas" gera imagem com IA para toda matéria;',
  '      "ia_com_texto" gera com IA só quando a foto original tiver texto',
  '      embutido (print, card, montagem) — nesses casos a foto não serve;',
  '      "sem_imagem" publica sem arte.',
  '  criterio: uma frase dizendo o que merece virar matéria neste pedido.',
  '  palavras: lista de termos que interessam (pode ser vazia).',
  '',
  'Traduza o jeito de falar do editor. Exemplos:',
  '  "3 matérias por hora"        -> intervalo_minutos 60, materias_por_volta 3',
  '  "uma a cada 15 minutos"      -> intervalo_minutos 15, materias_por_volta 1, limite_dia 96',
  '  "monitore a cada 1 hora e publique 1 a cada 15 min, uma de cada página"',
  '      -> intervalo_minutos 15, scan_minutos 60, materias_por_volta 1,',
  '         limite_dia 96, destino "publicar". O dot já alterna as páginas',
  '         sozinho: não multiplique por quantidade de página.',
  '  "só quando a foto tiver texto" -> modo_imagem "ia_com_texto"',
  '  "deixa no rascunho"          -> destino "rascunho"',
  '  "vai publicando de 20 em 20 min" -> destino "agendar", agendar_minutos 20',
  '  "agende e publique de 15 em 15 min" -> destino "agendar", agendar_minutos 15',
  '  "publique" / "publica direto"  -> destino "publicar"',
  '',
  'Na dúvida: intervalo_minutos 30, materias_por_volta 1, limite_dia 10,',
  'destino "rascunho", modo_imagem "original".',
  'Nunca invente link: os links vêm separados, fora do seu JSON.',
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

/**
 * A frase que o editor lê antes de confirmar.
 *
 * O pedido vem em linguagem solta ("3 por hora, só rascunho"); aqui ele volta
 * em números concretos, incluindo o ritmo por hora e por dia, que é onde o
 * editor costuma se surpreender.
 */
function resumoDoPlano(plano, urls = []) {
  const linhas = [];
  const porVolta = plano.materias_por_volta;
  const intervalo = plano.intervalo_minutos;

  // Dois ritmos: entregar e reler. Mostrar só um deles era o que fazia o
  // editor pedir "publique a cada 15 min" e ler "trabalha a cada 1 hora".
  const scan = Number(plano.scan_minutos) || 0;
  linhas.push(
    scan && scan !== intervalo
      ? `Acompanha ${urls.length} ${plural(urls.length, 'página', 'páginas')}: relê a cada ${tempoPorExtenso(scan)} e entrega a cada ${tempoPorExtenso(intervalo)}.`
      : `Acompanha ${urls.length} ${plural(urls.length, 'página', 'páginas')} e trabalha a cada ${tempoPorExtenso(intervalo)}.`
  );

  if (plano.acao === 'monitorar') {
    linhas.push('Só acompanha e lista o que aparecer — não escreve matéria.');
  } else {
    const porHora = (porVolta * 60) / intervalo;
    const porHoraTexto = Number.isInteger(porHora) ? String(porHora) : porHora.toFixed(1).replace('.', ',');
    linhas.push(
      `Escreve ${porVolta} ${plural(porVolta, 'matéria', 'matérias')} por volta — cerca de ${porHoraTexto} por hora, no teto de ${plano.limite_dia} por dia.`
    );

    // Teto menor que o ritmo faz o dot parar no meio do dia. Dizer só "no teto
    // de N por dia" escondia isso: o editor lia como se o ritmo valesse 24h.
    const porDiaDoRitmo = Math.round(porVolta * (1440 / intervalo));
    if (plano.limite_dia < porDiaDoRitmo) {
      const horas = plano.limite_dia / porHora;
      const horasTexto = Number.isInteger(horas) ? String(horas) : horas.toFixed(1).replace('.', ',');
      linhas.push(
        `Atenção: nesse ritmo daria ${porDiaDoRitmo} por dia, mas o teto de ${plano.limite_dia} para antes — ele trabalha cerca de ${horasTexto}h e espera a virada do dia.`
      );
    }
    if (urls.length > 1) {
      linhas.push(
        'Alterna as páginas: a vez é sempre de quem está há mais tempo sem render matéria.'
      );
    }
    linhas.push(`Imagem: ${ROTULO_IMAGEM[plano.modo_imagem] || ROTULO_IMAGEM.original}.`);

    if (plano.destino === 'rascunho') {
      linhas.push('Cada matéria fica salva como rascunho para você revisar. Nada sai sozinho.');
    } else if (plano.destino === 'agendar') {
      linhas.push(
        `Cada matéria é agendada para sair a cada ${tempoPorExtenso(plano.agendar_minutos || intervalo)}, uma depois da outra.`
      );
    } else {
      linhas.push('Cada matéria vai direto para a fila de publicação, sem revisão.');
    }
  }

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
 * Traduz o texto do editor em configuração. Falhando a IA, o dot ainda nasce
 * com um padrão sensato — o objetivo e os links já bastam para trabalhar.
 */
async function interpretar(texto) {
  const urls = extrairUrls(texto);
  const padrao = {
    nome: nomeDoTexto(texto),
    acao: 'monitorar_e_escrever',
    intervalo_minutos: 30,
    scan_minutos: null,
    materias_por_volta: 1,
    limite_dia: 10,
    destino: 'rascunho',
    agendar_minutos: null,
    modo_imagem: 'original',
    criterio: 'Post com fato novo e texto suficiente para apurar.',
    palavras: [],
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

    const intervalos = [10, 15, 30, 60, 120, 180, 360];
    const destinos = ['rascunho', 'agendar', 'publicar'];
    const imagens = ['original', 'ia_todas', 'ia_com_texto', 'sem_imagem'];
    const intervalo = Number(vindo.intervalo_minutos);
    return {
      nome: corta(vindo.nome, 60) || padrao.nome,
      acao: vindo.acao === 'monitorar' ? 'monitorar' : 'monitorar_e_escrever',
      intervalo_minutos: intervalos.includes(intervalo) ? intervalo : padrao.intervalo_minutos,
      // Reler mais devagar que entregar é o único sentido útil: varrer mais
      // rápido que a entrega só gastaria raspagem sem gerar nada a mais.
      scan_minutos: (() => {
        const pedido = Number(vindo.scan_minutos);
        if (!intervalos.includes(pedido)) return null;
        const entrega = intervalos.includes(intervalo) ? intervalo : padrao.intervalo_minutos;
        return pedido > entrega ? pedido : null;
      })(),
      materias_por_volta: Math.min(5, Math.max(1, Number(vindo.materias_por_volta) || 1)),
      limite_dia: Math.min(200, Math.max(1, Number(vindo.limite_dia) || padrao.limite_dia)),
      destino: destinos.includes(vindo.destino) ? vindo.destino : padrao.destino,
      agendar_minutos:
        vindo.destino === 'agendar'
          ? Math.min(360, Math.max(5, Number(vindo.agendar_minutos) || intervalo || 15))
          : null,
      modo_imagem: imagens.includes(vindo.modo_imagem) ? vindo.modo_imagem : padrao.modo_imagem,
      criterio: corta(vindo.criterio, 400) || padrao.criterio,
      palavras: Array.isArray(vindo.palavras)
        ? vindo.palavras.map((p) => corta(p, 60)).filter(Boolean).slice(0, 20)
        : [],
    };
  } catch (err) {
    console.warn('[dots] não consegui interpretar o pedido, usando o padrão:', err.message);
    return padrao;
  }
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
async function previa(texto) {
  if (!String(texto || '').trim()) throw erro('Escreva o que o dot deve fazer.');
  const plano = await interpretar(texto);
  const urls = extrairUrls(texto);
  return { plano, urls, resumo: resumoDoPlano(plano, urls) };
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
 * Cria o dot e já cadastra as páginas na Biblioteca, monitorando. A varredura
 * em si fica para o tick — criar não pode travar esperando 26 sites.
 */
async function criar(userId, { objetivo, nome = null, facebookPageId = null, provedor = 'auto' }) {
  const texto = String(objetivo || '').trim();
  if (!texto) throw erro('Escreva o que o dot deve fazer.');
  if (texto.length > 8000) throw erro('O objetivo está longo demais (máximo 8000 caracteres).');

  const plano = await interpretar(texto);
  const urls = extrairUrls(texto);

  const [id] = await db(TABELA).insert({
    user_id: userId,
    nome: corta(nome, 160) || plano.nome,
    objetivo: texto,
    plano: JSON.stringify(plano),
    fonte_ids: JSON.stringify([]),
    estado: 'ativo',
    intervalo_minutos: plano.intervalo_minutos,
    scan_minutos: plano.scan_minutos,
    limite_dia: plano.limite_dia,
    facebook_page_id: facebookPageId || null,
    destino: plano.destino,
    materias_por_volta: plano.materias_por_volta,
    modo_imagem: plano.modo_imagem,
    agendar_minutos: plano.agendar_minutos,
    provedor: normalizarProvedor(provedor),
    proxima_execucao_at: new Date(),
  });

  const dot = await db(TABELA).where({ id }).first();
  const fonteIds = [];
  const problemas = [];

  if (urls.length) {
    const bibliotecaService = require('./bibliotecaService');
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
          intervaloMinutos: plano.intervalo_minutos,
        });
        const novoId = criada?.id || criada;
        if (novoId) fonteIds.push(Number(novoId));
      } catch (err) {
        // "Já está na biblioteca" não é problema: é a fonte que queremos. Pode
        // acontecer num formato de URL que a busca ainda não cobre.
        if (err.status === 409) {
          const achada = await bibliotecaService
            .encontrarFontePorUrl(userId, url)
            .catch(() => null);
          if (achada) {
            await db('biblioteca_fontes').where({ id: achada.id }).update({ monitorar: true });
            fonteIds.push(Number(achada.id));
            continue;
          }
        }
        problemas.push(`${url}: ${err.message}`);
      }
    }
    // O motivo ia só para o retorno da função: na tela aparecia "1 com
    // problema" sem dizer qual nem por quê, e o dot ficava inútil em silêncio.
    await registrarLog(dot, 'criou_fonte', {
      detalhe: corta(
        `${fonteIds.length} página(s) monitorada(s)` +
          (problemas.length ? `; ${problemas.length} com problema — ${problemas.join(' | ')}` : ''),
        600
      ),
    });
  }

  await db(TABELA).where({ id }).update({
    fonte_ids: JSON.stringify(fonteIds),
    ultimo_resumo: corta(
      `Criado com ${fonteIds.length} página(s).${problemas.length ? ` ${problemas.length} link(s) não entraram.` : ''}`,
      500
    ),
  });

  return { id, plano, fontes: fonteIds.length, problemas };
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

  const linhas = await db('biblioteca_posts as p')
    .join('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
    .where('p.user_id', dot.user_id)
    .whereIn('p.fonte_id', fonteIds)
    .whereNull('p.matter_id')
    .whereIn('p.status', ['novo', 'visto'])
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
      'f.nome as fonte_nome'
    );

  const { conteudoSuficiente } = require('./furosSociais');
  const uteis = linhas
    .filter((l) => /^https?:\/\//i.test(String(l.url || '')))
    .filter(conteudoSuficiente);

  const ordenados = rodiziarPorFonte(uteis, await ultimaMateriaPorFonte(dot, fonteIds));
  return semRepetirAssunto(dot, ordenados);
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
    // Histórico do usuário: matérias escritas e publicações já feitas.
    const { marcarJaPublicados } = require('./materiaIaService');
    const marcados = await marcarJaPublicados(dot.user_id, dot.facebook_page_id || null, posts);
    const novos = marcados.filter((p) => !p.jaPublicado);
    const repetidos = marcados.length - novos.length;
    if (repetidos) {
      await registrarLog(dot, 'ignorou', {
        detalhe: `${repetidos} post(s) de assunto já publicado por esta conta`,
      });
    }
    lista = novos;
  } catch (err) {
    // Falha na checagem não pode travar o dot, mas tem de aparecer: sem ela o
    // risco é justamente publicar repetido.
    console.warn(`[dots #${dot.id}] checagem de repetido falhou: ${err.message}`);
    await registrarLog(dot, 'erro', {
      detalhe: corta(`não consegui checar assunto repetido (${err.message})`, 600),
    });
  }

  return semAssuntoRepetidoNaLista(lista);
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
async function escrever(dot, post) {
  const { escreverPeloChat } = require('./materiaPorChat');
  const { comProvedor } = require('./deepseekService');
  const escolhido = dot.provedor && dot.provedor !== 'auto' ? dot.provedor : null;

  // comProvedor fixa a IA só nesta volta; sem escolha, roteamento normal.
  const tarefa = comProvedor(escolhido, () => escreverPeloChat(
    {
      chatService: require('./materiaChatService'),
      // Sem fixar modelo: usa a cadeia de provedores padrão do projeto.
      comModelo: (_modelo, fn) => fn(),
    },
    {
      userId: dot.user_id,
      url: post.url,
      facebookPageId: dot.facebook_page_id || null,
      imagemUrl: /^https?:\/\//i.test(String(post.thumbnail || '')) ? post.thumbnail : null,
      origem: 'dots',
    }
  ));

  const limite = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('a escrita passou de 15 min')), LIMITE_ESCRITA_MS).unref?.()
  );
  const { matterId } = await Promise.race([tarefa, limite]);
  return matterId;
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
  if (modo === 'original' || modo === 'sem_imagem') return modo;

  if (modo === 'ia_com_texto') {
    try {
      const { fetchImage } = require('./editorialCardService');
      const buffer = await fetchImage(post.thumbnail);
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
      // Antes isso só saía num console.warn. Se o OCR quebrar no servidor, TODA
      // imagem passa a ser gerada — o contrário do que o editor pediu, e com
      // custo. Agora a falha aparece na atividade do dot.
      console.warn(`[dots #${dot.id}] OCR falhou, gerando imagem: ${err.message}`);
      await registrarLog(dot, 'erro', {
        detalhe: corta(
          `não consegui checar texto na foto (${err.message}); gerei a imagem por garantia`,
          600
        ),
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

async function rodarCiclo(dot) {
  // Duas voltas no mesmo dot escrevem a mesma matéria duas vezes.
  if (!(await reservarCiclo(dot.id))) {
    console.info(`[dots #${dot.id}] já há uma volta em andamento; esta foi dispensada`);
    return;
  }

  const plano = parseJson(dot.plano, {});
  const agora = new Date();
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
    const vaiVarrer = !scanCada || !ultimoScan || Date.now() - ultimoScan >= scanCada * 60_000;

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
    for (const post of paraEscrever) {
      indice += 1;
      await marcarAtividade(
        dot.id,
        `Escrevendo ${indice}/${paraEscrever.length}: ${corta(post.titulo || post.fonte_nome, 120) || post.url}`
      );
      try {
        const matterId = await escrever(dot, post);
        if (matterId) {
          escritas += 1;
          await db('biblioteca_posts').where({ id: post.id }).update({ matter_id: matterId });

          await marcarAtividade(dot.id, `Resolvendo a imagem de ${indice}/${paraEscrever.length}…`);
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

          await registrarLog(dot, 'escreveu', {
            detalhe: corta(
              [
                post.titulo || post.fonte_nome || 'matéria',
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
        } else {
          ignorados += 1;
          await registrarLog(dot, 'ignorou', { detalhe: 'a IA não gerou matéria', url: post.url });
        }
      } catch (err) {
        ignorados += 1;
        await registrarLog(dot, 'erro', { detalhe: corta(err.message, 600), url: post.url });
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
      ultimo_erro: null,
    });
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
async function tick() {
  if (rodando) return;
  rodando = true;
  try {
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

  return linhas.map((d) => ({
    id: d.id,
    nome: d.nome,
    objetivo: d.objetivo,
    plano: parseJson(d.plano, {}),
    fontes: parseJson(d.fonte_ids, []).length,
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
    // Sem página escolhida, a matéria cai na página padrão da conta na hora de
    // salvar — e era justamente isso que acontecia sem ninguém ver.
    pagina: d.facebook_page_id
      ? nomePorPagina.get(Number(d.facebook_page_id)) || `Página ${d.facebook_page_id}`
      : null,
    feitas_hoje: d.dia_contagem === hoje() ? d.feitas_hoje : 0,
    proxima_execucao_at: d.proxima_execucao_at,
    ultimo_run_at: d.ultimo_run_at,
    ultimo_resumo: d.ultimo_resumo,
    ultimo_erro: d.ultimo_erro,
  }));
}

async function detalhe(userId, dotId) {
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);
  const execucoes = await db(LOG)
    .where({ dot_id: dotId })
    .orderBy('created_at', 'desc')
    .limit(50);
  return {
    ...(await listar(userId)).find((d) => d.id === Number(dotId)),
    execucoes,
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
async function atualizar(userId, dotId, { nome, provedor }) {
  const dot = await db(TABELA).where({ id: dotId, user_id: userId }).first();
  if (!dot) throw erro('Dot não encontrado.', 404);
  const dados = {};
  if (nome !== undefined) {
    const limpo = corta(nome, 160);
    if (!limpo) throw erro('Dê um nome ao dot.');
    dados.nome = limpo;
  }
  if (provedor !== undefined) dados.provedor = normalizarProvedor(provedor);
  if (Object.keys(dados).length) await db(TABELA).where({ id: dotId }).update(dados);
  return { ...dados };
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

/** "Trabalhar agora", para não esperar o relógio. */
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
  renomear,
  atualizar,
  provedores,
  listar,
  detalhe,
  alterarEstado,
  excluir,
  rodarAgora,
  tick,
  // Expostos para teste
  extrairUrls,
  interpretar,
  janelaDeFontes,
  resumoDoPlano,
  rodiziarPorFonte,
  semRepetirAssunto,
  semAssuntoRepetidoNaLista,
  reservarCiclo,
};
