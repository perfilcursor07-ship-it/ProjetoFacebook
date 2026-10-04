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
    // Marcar a caixa = gerar só quando a foto do post tiver texto embutido.
    modo_imagem:
      entrada.gerar_imagem_com_texto === true ||
      entrada.gerarImagemComTexto === true ||
      entrada.modo_imagem === 'ia_com_texto'
        ? 'ia_com_texto'
        : 'original',
  };
}

// ------------------------------------------------------------------ plano

const SISTEMA_PLANO = [
  'Você é o assistente que configura um agente ("dot") que trabalha sozinho no servidor.',
  'Converta o pedido do editor em configuração. Responda APENAS com JSON válido,',
  'sem markdown e sem texto fora do objeto.',
  '',
  'O editor já escolheu na tela o ritmo, a quantidade, o destino (rascunho,',
  'agendar ou publicar), a jornada e o tratamento da imagem. NÃO tente deduzir',
  'nada disso do texto: você decide apenas O QUE merece virar matéria.',
  '',
  'Campos (só estes quatro):',
  '  nome: rótulo curto (até 60 caracteres) que descreva o trabalho.',
  '  acao: "monitorar_e_escrever" ou "monitorar" (só acompanha, sem escrever).',
  '  criterio: uma frase dizendo o que, nestas páginas, merece virar matéria.',
  '  palavras: lista de termos que interessam (pode ser vazia).',
  '',
  'Exemplos:',
  '  "Monitore estas páginas e crie matéria do que render"',
  '      -> acao "monitorar_e_escrever", criterio sobre fato novo com texto suficiente.',
  '  "Só me avise o que aparecer, não escreva" -> acao "monitorar".',
  '  "Quero só política e bancada evangélica"',
  '      -> palavras ["política", "bancada evangélica"].',
  '',
  'Se o editor mencionar ritmo, quantidade ou destino, ignore: já está na tela.',
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
/**
 * A frase que o editor lê antes de confirmar.
 *
 * Agora o resumo descreve o que ELE escolheu na tela, não o que a IA deduziu:
 * jornada, ritmo da varredura, ritmo da saída e tratamento da imagem.
 */
function resumoDoPlano(plano, urls = [], config = {}) {
  const linhas = [];
  const quantidade = Number(config.saida_quantidade) || 1;
  const cadaMin = Number(config.saida_minutos) || 15;
  const scanMin = Number(config.scan_minutos) || 60;

  linhas.push(
    `Acompanha ${urls.length} ${plural(urls.length, 'página', 'páginas')} e relê cada uma a cada ${tempoPorExtenso(scanMin)}.`
  );

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

  if (urls.length > 1) {
    linhas.push('Alterna as páginas: a vez é de quem está há mais tempo sem render matéria.');
  }

  linhas.push(
    config.modo_imagem === 'ia_com_texto'
      ? 'Imagem: usa a foto do post; se ela tiver texto embutido, manda limpar o texto mantendo a foto.'
      : 'Imagem: usa a foto do post como veio.'
  );

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
 * Traduz o texto do editor em configuração. Falhando a IA, o dot ainda nasce
 * com um padrão sensato — o objetivo e os links já bastam para trabalhar.
 */
async function interpretar(texto) {
  const padrao = {
    nome: nomeDoTexto(texto),
    acao: 'monitorar_e_escrever',
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

    return {
      nome: corta(vindo.nome, 60) || padrao.nome,
      acao: vindo.acao === 'monitorar' ? 'monitorar' : 'monitorar_e_escrever',
      criterio: corta(vindo.criterio, 400) || padrao.criterio,
      palavras: Array.isArray(vindo.palavras)
        ? vindo.palavras.map((x) => corta(x, 60)).filter(Boolean).slice(0, 20)
        : [],
    };
  } catch (err) {
    // Sem a IA o dot ainda nasce util: objetivo e links ja bastam para trabalhar.
    console.warn('[dots] nao consegui interpretar o pedido, usando o padrao:', err.message);
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
async function previa(texto, jornada = {}) {
  if (!String(texto || '').trim()) throw erro('Escreva o que o dot deve fazer.');
  const plano = await interpretar(texto);
  const config = normalizarJornada(jornada);
  const urls = extrairUrls(texto);
  return { plano, config, urls, resumo: resumoDoPlano(plano, urls, config) };
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
async function criar(userId, { objetivo, nome = null, facebookPageId = null, provedor = 'auto', ...jornada }) {
  const texto = String(objetivo || '').trim();
  if (!texto) throw erro('Escreva o que o dot deve fazer.');
  if (texto.length > 8000) throw erro('O objetivo está longo demais (máximo 8000 caracteres).');

  // A IA só diz O QUE merece matéria. Ritmo, destino, jornada e imagem são
  // escolha do editor na tela — era a dedução disso que errava toda vez.
  const plano = await interpretar(texto);
  const config = normalizarJornada(jornada);
  const urls = extrairUrls(texto);

  const [id] = await db(TABELA).insert({
    user_id: userId,
    nome: corta(nome, 160) || plano.nome,
    objetivo: texto,
    plano: JSON.stringify({ ...plano, ...config }),
    fonte_ids: JSON.stringify([]),
    estado: 'ativo',
    // O ciclo acorda no ritmo da saída; a varredura tem o seu, em scan_minutos.
    intervalo_minutos: config.saida_minutos,
    scan_minutos: config.scan_minutos,
    limite_dia: config.limite_dia,
    facebook_page_id: facebookPageId || null,
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
 * Tira o que esta conta já publicou, com critério ESTRITO.
 *
 * A primeira versão usava `marcarJaPublicados`, que compara com até 1000
 * matérias de todo o histórico e aceita como repetido qualquer par com 3
 * palavras em comum. Numa página de política, 'lula', 'bolsonaro' e 'governo'
 * aparecem juntas em quase toda manchete: o dot rejeitava 25 de 25 candidatos
 * e nunca escrevia nada.
 *
 * Aqui só conta o que indica MESMA notícia: o link idêntico, ou títulos
 * parecidos pelo critério estrito (4 palavras ou 55% de sobreposição), e só
 * contra o que saiu nos últimos dias — notícia da semana passada não volta.
 */
async function filtrarJaPublicados(dot, posts) {
  const { titulosParecidos } = require('./editorialGuidelinesFb');
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
 * A foto que a matéria vai usar de fato — é ela que o OCR precisa olhar.
 *
 * `post.thumbnail` sozinho não serve: os raspadores do Facebook gravam o post
 * na biblioteca sem imagem, e a foto só aparece quando o chat extrai o link e
 * salva em `imagem_fonte_url`. Checar só a thumbnail fazia todo post cair no
 * "não consegui checar" e ganhar imagem de IA.
 */
function fotoParaChecar(matter, post) {
  const daMateria = String(matter?.imagem_fonte_url || matter?.imagem_url || '').trim();
  // /media/artes/ é a arte composta (com título por cima), não a foto original.
  if (daMateria && !/\/media\/artes\//i.test(daMateria)) return daMateria;
  const thumb = String(post?.thumbnail || '').trim();
  return /^https?:\/\//i.test(thumb) ? thumb : null;
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
  fotoParaChecar,
  resolverCapa,
  interpretar,
  janelaDeFontes,
  resumoDoPlano,
  rodiziarPorFonte,
  semRepetirAssunto,
  semAssuntoRepetidoNaLista,
  filtrarJaPublicados,
  DIAS_HISTORICO_REPETIDO,
  reservarCiclo,
  dentroDaJanela,
  normalizarJornada,
  horaEDiaLocais,
  lerDias,
  DIAS,
  INTERVALOS_VALIDOS,
};
