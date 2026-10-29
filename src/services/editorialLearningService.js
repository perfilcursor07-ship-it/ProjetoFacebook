const EditorialAprendizados = require('../models/EditorialAprendizados');
const EditorialEstiloUsuario = require('../models/EditorialEstiloUsuario');
const { env } = require('../config/env');


/**
 * Destilar estilo, memória de chat e a lição do "Ensinar IA" são tarefas curtas
 * e repetitivas — entram como `auxiliar`, então seguem o mesmo roteamento do
 * resto do sistema (DeepSeek por padrão; Claude só se CLAUDE_TAREFAS incluir).
 */
function claudeParaAuxiliar() {
  try {
    return require('./deepseekService').usarClaude('auxiliar');
  } catch {
    return false;
  }
}

function deepseekPeloGateway() {
  try {
    return require('./deepseekService').deepseekPeloGateway();
  } catch {
    return false;
  }
}

function iaConfigurada() {
  if (claudeParaAuxiliar()) return Boolean(env.anthropicApiKey);
  return Boolean(env.deepseekApiKey) || deepseekPeloGateway();
}

async function chamarIaJson(messages, { timeout = 90_000 } = {}) {
  if (claudeParaAuxiliar()) {
    return require('./claudeService').chatCompletion(messages, {
      json: true,
      tarefa: 'auxiliar',
      maxTokens: 1500,
    });
  }
  // DeepSeek web do gateway com o token-free ligado; API oficial só sem ele
  // (ou com DEEPSEEK_USAR_API=true).
  return require('./deepseekService').chatCompletionDeepseekDireto(messages, {
    temperature: 0.2,
    json: true,
    timeout,
  });
}

const MAX_TRECHO = 4000;
const DISTILL_EVERY = 3;
const MAX_MEMORIAS_CHAT = 20;

const PADRAO_FEEDBACK_CHAT =
  /\b(aprend[ae]|lembre|memorize|sempre|nunca|prefir|eu gosto|eu n[aã]o gosto|n[aã]o quero|quero que (?:sempre|nunca|n[aã]o|use|mantenha|evite)|quando eu|quando for|da pr[oó]xima|pare de|evite|n[aã]o invent|use a legenda|use o [aá]udio|use a transcri[cç][aã]o|mantenha a fonte|n[aã]o apague a fonte|ficou errado|nada a ver|n[aã]o foi isso)\b/i;

/**
 * Antes o registro dependia de a frase conter "sempre", "nunca", "prefiro"…
 * Preferência dita de forma solta ("deixa mais curto", "tira a oração do fim")
 * passava batido. Agora o filtro só descarta o que claramente não é instrução
 * — quem decide é o modelo barato, que responde persistir:false na maioria.
 */
function podeConterPreferencia(texto) {
  const t = String(texto || '').trim();
  if (t.length < 12) return false;
  if (/^https?:/i.test(t) && !t.includes(' ')) return false;
  if (PADRAO_FEEDBACK_CHAT.test(t)) return true;
  return true;
}

function normText(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sliceSafe(s, max = MAX_TRECHO) {
  const t = normText(s);
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trim()}…`;
}

/** Preserva começo e fim; a regra mais recente costuma vir no fim do prompt. */
function recortarPedidoParaMemoria(s, max = 7000) {
  const t = normText(s);
  if (t.length <= max) return t;
  const metade = Math.floor((max - 80) / 2);
  return `${t.slice(0, metade).trim()}\n\n[...trecho intermediário omitido...]\n\n${t
    .slice(-metade)
    .trim()}`;
}

function diffSignificativo(antes, depois) {
  const a = normText(antes);
  const b = normText(depois);
  if (a === b) return false;
  if (!a && b.length >= 40) return true;
  if (!b) return false;
  const len = Math.max(a.length, b.length, 1);
  let same = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i += 1) {
    if (a[i] === b[i]) same += 1;
  }
  const changedRatio = 1 - same / len;
  const absChange = Math.abs(a.length - b.length) + (a === b ? 0 : Math.max(40, Math.floor(len * 0.05)));
  // Heurística do plano: >8% ou >80 chars de mudança efetiva
  if (Math.abs(a.length - b.length) >= 80) return true;
  if (changedRatio >= 0.08) return true;
  // Comparação simples por palavras
  const wa = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const wb = b.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (!wb.length) return false;
  let hit = 0;
  for (const w of wb) if (wa.has(w)) hit += 1;
  const overlap = hit / wb.length;
  return overlap < 0.92 || absChange >= 80;
}

function resumoDiff(antes, depois) {
  const a = normText(antes);
  const b = normText(depois);
  if (!a && b) return 'Texto criado/editado a partir do vazio';
  if (a && !b) return 'Texto removido';
  const delta = b.length - a.length;
  if (delta > 40) return `Expandiu (+${delta} chars)`;
  if (delta < -40) return `Enxugou (${delta} chars)`;
  return 'Reescreveu trechos mantendo tamanho parecido';
}

function cortarExemplo(texto, max = 420) {
  const t = normText(texto);
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trim()}…`;
}

/**
 * Registra aprendizado quando o humano altera título/matéria gerados pela IA.
 * @returns {Promise<{ registered: boolean, estilo?: object|null }>}
 */
async function registrarAprendizado({
  userId,
  matterId = null,
  tituloAntes = null,
  tituloDepois = null,
  materiaAntes = null,
  materiaDepois = null,
  // Texto escrito do zero pelo editor entra como exemplo de estilo puro — a
  // nota vai junto para o destilador saber que ali não houve versão da IA.
  origem = null,
}) {
  // Num exemplo escrito do zero não existe "antes": o título dele já é o
  // padrão, então entra junto com o corpo.
  const tituloMudou = origem
    ? Boolean(normText(tituloDepois))
    : tituloAntes != null &&
      tituloDepois != null &&
      normText(tituloAntes) !== normText(tituloDepois);
  const materiaMudou = diffSignificativo(materiaAntes, materiaDepois);

  if (!tituloMudou && !materiaMudou) {
    return { registered: false };
  }

  // Matéria precisa de mudança real; título sozinho só conta se também houver corpo alterado
  // ou título bem diferente (>15 chars delta / texto diferente)
  if (!origem && !materiaMudou && tituloMudou) {
    const ta = normText(tituloAntes);
    const td = normText(tituloDepois);
    if (Math.abs(ta.length - td.length) < 8 && ta.length > 0) {
      const wordsA = new Set(ta.toLowerCase().split(/\s+/));
      const wordsB = td.toLowerCase().split(/\s+/);
      let hit = 0;
      for (const w of wordsB) if (wordsA.has(w)) hit += 1;
      if (wordsB.length && hit / wordsB.length >= 0.7) {
        return { registered: false };
      }
    }
  }

  await EditorialAprendizados.create({
    user_id: userId,
    matter_id: matterId || null,
    titulo_antes: !origem && tituloMudou ? String(tituloAntes || '').slice(0, 300) : null,
    titulo_depois: tituloMudou ? String(tituloDepois || '').slice(0, 300) : null,
    materia_antes: !origem && materiaMudou ? sliceSafe(materiaAntes) : null,
    materia_depois: materiaMudou || origem ? sliceSafe(materiaDepois) : null,
    diff_resumo:
      origem ||
      (materiaMudou ? resumoDiff(materiaAntes, materiaDepois) : 'Ajustou o título'),
  });

  const estilo = await EditorialEstiloUsuario.findByUser(userId);
  const total = Number(estilo?.total_edicoes || 0) + 1;
  const precisaDestilar = !estilo?.regras_estilo || total % DISTILL_EVERY === 0;

  await EditorialEstiloUsuario.upsert(userId, {
    total_edicoes: total,
    atualizado_em: new Date(),
    regras_estilo: estilo?.regras_estilo || null,
  });

  if (precisaDestilar && iaConfigurada()) {
    try {
      await atualizarRegrasEstilo(userId);
    } catch (err) {
      console.warn('[editorial-learning] destilar:', err.message);
    }
  }

  return { registered: true };
}

async function atualizarRegrasEstilo(userId) {
  if (!iaConfigurada()) return EditorialEstiloUsuario.findByUser(userId);
  const exemplos = await EditorialAprendizados.findRecentByUser(userId, 8);
  if (!exemplos.length) return EditorialEstiloUsuario.findByUser(userId);

  const blocos = exemplos
    .map((ex, i) => {
      const parts = [`Exemplo ${i + 1}:`];
      if (ex.titulo_antes || ex.titulo_depois) {
        parts.push(`Título IA: ${ex.titulo_antes || '—'}`);
        parts.push(`Título editado: ${ex.titulo_depois || '—'}`);
      }
      if (ex.materia_antes || ex.materia_depois) {
        parts.push(`Texto IA: ${cortarExemplo(ex.materia_antes, 500)}`);
        parts.push(`Texto editado: ${cortarExemplo(ex.materia_depois, 500)}`);
      }
      if (ex.diff_resumo) parts.push(`Nota: ${ex.diff_resumo}`);
      return parts.join('\n');
    })
    .join('\n\n');

  const messages = [
      {
        role: 'system',
        content:
          'Você analisa o trabalho de um editor humano em matérias gospel para Facebook. Cada exemplo é uma correção (texto da IA → versão editada) OU uma matéria que ele escreveu do zero — nesta última o texto dele é o padrão a seguir, não uma correção. Extraia padrões de ESTILO (não fatos das matérias). Responda JSON: {"regras":["bullet1",...]} com 8 a 12 bullets curtos em português sobre tom, tamanho, fechamento de fé, como citar cargos/pessoas, o que evitar, preferências de título.',
      },
      {
        role: 'user',
        content: `Com base nestas correções (IA → versão editada), liste as regras de estilo do editor:\n\n${blocos}`,
      },
  ];

  const raw = await chamarIaJson(messages);
  let regras = [];
  try {
    const parsed = JSON.parse(raw);
    regras = Array.isArray(parsed.regras) ? parsed.regras : [];
  } catch {
    regras = [];
  }

  const bullets = regras
    .map((r) => String(r || '').trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((r) => (r.startsWith('-') || r.startsWith('•') ? r : `- ${r}`));

  const regrasTxt = bullets.length
    ? bullets.join('\n')
    : String(raw || '')
        .trim()
        .slice(0, 2000);

  const estilo = await EditorialEstiloUsuario.findByUser(userId);
  return EditorialEstiloUsuario.upsert(userId, {
    regras_estilo: regrasTxt || null,
    total_edicoes: Number(estilo?.total_edicoes || exemplos.length),
    atualizado_em: new Date(),
  });
}

function memoriasComoLista(valor) {
  return String(valor || '')
    .split(/\r?\n/)
    .map((linha) => linha.replace(/^\s*[-•*]\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_MEMORIAS_CHAT);
}

/**
 * Aprende preferências declaradas no chat e as mantém entre conversas.
 * Não guarda fatos, nomes da pauta nem instruções que servem só para uma matéria.
 */
async function registrarFeedbackDoChat({ userId, pedido, respostaAnterior = null }) {
  const texto = normText(pedido);
  if (!userId || !podeConterPreferencia(texto)) {
    return { registered: false };
  }
  if (!iaConfigurada()) return { registered: false, reason: 'sem_api' };

  const estilo = await EditorialEstiloUsuario.findByUser(userId);
  const atuais = memoriasComoLista(estilo?.preferencias_chat);
  const messages = [
      {
        role: 'system',
        content: `Você mantém a memória editorial de um usuário que produz matérias jornalísticas para Facebook e Instagram.
Retorne APENAS JSON: {"persistir":true|false,"memorias":["regra 1","regra 2"]}.

Objetivo: descobrir se a mensagem contém uma preferência duradoura sobre como a IA deve trabalhar e, se contiver, atualizar a memória existente.

Pode memorizar:
- tom, tamanho, estrutura, títulos e forma de citar fontes;
- regras de fidelidade a links, legendas, áudio, transcrição e imagens;
- erros que o usuário pede para nunca repetir;
- preferências de fluxo que devam valer em futuras matérias.

Não memorize:
- fatos, nomes, números ou opiniões relativos somente à pauta atual;
- pedidos isolados como "troque este título" ou "acrescente este parágrafo";
- conteúdo inventado pela resposta anterior;
- senhas, chaves, dados pessoais ou URLs.

Escreva cada memória como instrução curta, objetiva e reutilizável. Remova duplicatas. Se a nova preferência contrariar uma antiga, mantenha somente a mais recente. Dentro da própria mensagem nova, uma correção escrita no final também substitui a regra conflitante que apareceu antes. Máximo de ${MAX_MEMORIAS_CHAT} memórias.`,
      },
      {
        role: 'user',
        content: [
          `MEMÓRIA ATUAL:\n${atuais.length ? atuais.map((m) => `- ${m}`).join('\n') : '(vazia)'}`,
          respostaAnterior
            ? `RESPOSTA ANTERIOR DA IA (somente para entender a correção; não memorize fatos):\n${sliceSafe(respostaAnterior, 2500)}`
            : null,
          `NOVA MENSAGEM DO USUÁRIO:\n${recortarPedidoParaMemoria(texto)}`,
          'Atualize a memória apenas se houver preferência duradoura.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
  ];

  let parsed = {};
  try {
    parsed = JSON.parse((await chamarIaJson(messages)) || '{}');
  } catch {
    return { registered: false, reason: 'resposta_invalida' };
  }
  if (parsed.persistir !== true) return { registered: false };

  const memorias = (Array.isArray(parsed.memorias) ? parsed.memorias : [])
    .map((regra) => String(regra || '').replace(/^\s*[-•*]\s*/, '').replace(/\s+/g, ' ').trim())
    .filter((regra) => regra.length >= 12)
    .slice(0, MAX_MEMORIAS_CHAT);
  if (!memorias.length) return { registered: false };

  const preferenciasChat = memorias.map((regra) => `- ${regra}`).join('\n');
  const atualizado = await EditorialEstiloUsuario.upsert(userId, {
    preferencias_chat: preferenciasChat,
    total_feedback_chat: Number(estilo?.total_feedback_chat || 0) + 1,
    ultima_memoria_chat_em: new Date(),
  });
  return { registered: true, memorias, estilo: atualizado };
}

/** Limite do texto que o editor escreve à mão na tela de agendar. */
const MAX_ORIENTACOES = 4000;

function normalizarOrientacaoParaPolitica(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Transforma regras editoriais que tambem afetam o pos-processamento local em
 * politicas deterministicas. As linhas sao lidas de cima para baixo; em caso
 * de conflito, a ultima regra vence, igual ao bloco enviado ao modelo.
 */
function analisarOrientacoesEditor(orientacoesOuContexto) {
  const texto =
    orientacoesOuContexto && typeof orientacoesOuContexto === 'object'
      ? orientacoesOuContexto.orientacoesEditor
      : orientacoesOuContexto;
  let omitirVeiculoNoCorpo = false;

  for (const linha of String(texto || '').split(/\r?\n/)) {
    const regra = normalizarOrientacaoParaPolitica(linha.replace(/^\s*[-•*]\s*/, ''));
    if (!regra) continue;

    const mencionaVeiculo = /\b(veiculo|site|portal|nome da fonte|nome do site)\b/.test(regra);
    const proibeCitacao =
      mencionaVeiculo &&
      (/\bnao\s+(cite|citar|mencione|mencionar|use|usar)\b/.test(regra) ||
        /\b(apenas|somente|so)\s+(na|no)\s+(fonte|credito|rodape)\b/.test(regra) ||
        /\b(cite|citar|mencione|mencionar)\b.*\b(apenas|somente|so)\b.*\b(fonte|credito|rodape)\b/.test(regra));
    const exigeCitacaoNoCorpo =
      mencionaVeiculo &&
      !/\bnao\b/.test(regra) &&
      /\b(cite|citar|mencione|mencionar|use|usar)\b.*\b(corpo|texto|materia)\b/.test(regra);

    if (proibeCitacao) omitirVeiculoNoCorpo = true;
    if (exigeCitacaoNoCorpo) omitirVeiculoNoCorpo = false;
  }

  return { omitirVeiculoNoCorpo };
}

/**
 * Orientações que o editor escreve na tela de agendar. Valem para todas as
 * próximas matérias — é instrução manual, não memória inferida do chat.
 */
async function obterOrientacoes(userId) {
  if (!userId) return { orientacoes: '', atualizadoEm: null };
  const estilo = await EditorialEstiloUsuario.findByUser(userId);
  return {
    orientacoes: String(estilo?.orientacoes_editor || ''),
    atualizadoEm: estilo?.orientacoes_atualizadas_em || null,
  };
}

/**
 * Grava as orientações do editor. Cada linha é uma regra; linhas repetidas ou
 * vazias saem para o texto não inchar o prompt a cada salvamento.
 */
async function salvarOrientacoes(userId, texto) {
  if (!userId) throw new Error('Usuário não identificado');

  const linhas = [];
  for (const linha of String(texto || '').split(/\r?\n/)) {
    const limpa = linha.replace(/^\s*[-•*]\s*/, '').replace(/\s+/g, ' ').trim();
    if (!limpa) continue;
    if (linhas.some((l) => l.toLowerCase() === limpa.toLowerCase())) continue;
    linhas.push(limpa);
  }

  let orientacoes = linhas.map((l) => `- ${l}`).join('\n');
  if (orientacoes.length > MAX_ORIENTACOES) {
    orientacoes = orientacoes.slice(0, MAX_ORIENTACOES).replace(/\n[^\n]*$/, '');
  }

  await EditorialEstiloUsuario.upsert(userId, {
    orientacoes_editor: orientacoes || null,
    orientacoes_atualizadas_em: new Date(),
  });

  return { orientacoes, total: linhas.length };
}

/**
 * Acrescenta uma orientação sem apagar as que já existem.
 */
async function acrescentarOrientacao(userId, texto) {
  const atual = await obterOrientacoes(userId);
  const nova = String(texto || '').trim();
  if (!nova) return { orientacoes: atual.orientacoes, total: 0 };
  return salvarOrientacoes(userId, `${atual.orientacoes}\n${nova}`);
}

/**
 * "Ensinar IA" na tela da matéria: o editor escreve a lição olhando para o
 * texto que acabou de sair ("em matéria assim, faça isso"). Essa frase só faz
 * sentido com a matéria na tela, então o modelo barato a reescreve como regra
 * que se sustenta sozinha antes de virar orientação permanente.
 */
async function ensinarComContexto({ userId, licao, titulo = null, materia = null }) {
  if (!userId) {
    const err = new Error('Usuário não identificado');
    err.status = 401;
    throw err;
  }
  const texto = normText(licao);
  if (texto.length < 6) {
    const err = new Error('Escreva o que a IA deve aprender para as próximas matérias.');
    err.status = 400;
    throw err;
  }

  let regra = texto;
  let normalizada = false;

  if (iaConfigurada()) {
    const instrucao = [
      'Você transforma a instrução de um editor numa REGRA de estilo reutilizável.',
      'Responda apenas JSON: {"regra":"..."}.',
      'A regra vale para matérias FUTURAS e será lida sem a matéria atual na tela:',
      '- se o editor disser "matérias assim" ou "esse tipo", descreva em palavras que tipo é (tema, tipo de fonte, tipo de personagem);',
      '- não guarde fatos, nomes próprios da pauta atual, números, datas nem links;',
      '- guarde só o padrão de escrita, formatação, tom, título ou tratamento de fonte.',
      'Uma frase, imperativa, curta, em português. Se não houver regra reaproveitável, devolva {"regra":""}.',
    ].join('\n');

    const contexto = [
      titulo ? `Matéria aberta na tela (contexto, não memorize): ${String(titulo).slice(0, 300)}` : null,
      materia ? `Trecho da matéria (contexto, não memorize): ${sliceSafe(materia, 800)}` : null,
      `Instrução do editor: ${texto}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const raw = await chamarIaJson([
        { role: 'system', content: instrucao },
        { role: 'user', content: contexto },
      ]);
      const limpa = String(JSON.parse(raw || '{}').regra || '').trim();
      if (limpa.length >= 8) {
        regra = limpa;
        normalizada = true;
      }
    } catch (err) {
      // Sem o modelo, a frase do editor vale como está — nunca perder a lição.
      console.warn('[ensinar-ia] normalizar regra:', err.message);
    }
  }

  const salvo = await salvarOrientacoes(userId, `${(await obterOrientacoes(userId)).orientacoes}\n${regra}`);
  return { ...salvo, regra, normalizada };
}

/**
 * Contexto para injetar no prompt de geração.
 */
async function obterContextoAprendizado(userId) {
  if (!userId) return null;
  const [estilo, exemplos] = await Promise.all([
    EditorialEstiloUsuario.findByUser(userId),
    EditorialAprendizados.findRecentByUser(userId, 3),
  ]);

  if (
    !estilo?.regras_estilo &&
    !estilo?.preferencias_chat &&
    !estilo?.orientacoes_editor &&
    !exemplos.length
  ) {
    return null;
  }

  return {
    regrasEstilo: estilo?.regras_estilo || null,
    preferenciasChat: estilo?.preferencias_chat || null,
    orientacoesEditor: estilo?.orientacoes_editor || null,
    totalEdicoes: Number(estilo?.total_edicoes || 0),
    totalFeedbackChat: Number(estilo?.total_feedback_chat || 0),
    exemplos: (exemplos || []).map((ex) => ({
      tituloAntes: ex.titulo_antes,
      tituloDepois: ex.titulo_depois,
      materiaAntes: cortarExemplo(ex.materia_antes, 380),
      materiaDepois: cortarExemplo(ex.materia_depois, 380),
      diffResumo: ex.diff_resumo,
    })),
  };
}

function formatarContextoAprendizadoParaPrompt(ctx) {
  if (!ctx) return null;
  const parts = [
    'PADRÕES APRENDIDOS COM O EDITOR DESTE USUÁRIO (obrigatório seguir o estilo; NÃO copie o conteúdo dos exemplos):',
  ];
  // Instrução escrita à mão pelo editor: tem precedência sobre o que a IA inferiu.
  if (ctx.orientacoesEditor) {
    parts.push(
      [
        'ORIENTAÇÕES FIXAS DO EDITOR (prioridade máxima — valem para TODAS as matérias):',
        'As regras abaixo estão em ordem. Se duas se contradisserem, siga a ÚLTIMA regra (a mais abaixo).',
        String(ctx.orientacoesEditor).slice(0, 4000),
        'Se uma orientação conflitar com outro padrão aprendido, siga a orientação do editor. Nenhuma orientação autoriza inventar fato ou ignorar a fonte.',
      ].join('\n')
    );
  }
  if (ctx.regrasEstilo) {
    parts.push(String(ctx.regrasEstilo).slice(0, 2500));
  }
  if (ctx.preferenciasChat) {
    parts.push(
      [
        'MEMÓRIA EXPLÍCITA DAS CONVERSAS (seguir em todas as novas matérias):',
        String(ctx.preferenciasChat).slice(0, 3500),
        'Estas preferências nunca autorizam inventar fatos nem ignorar a fonte atual.',
      ].join('\n')
    );
  }
  if (Array.isArray(ctx.exemplos) && ctx.exemplos.length) {
    parts.push('EXEMPLOS DE CORREÇÃO (IA → versão editada pelo humano):');
    ctx.exemplos.forEach((ex, i) => {
      const linhas = [`${i + 1})`];
      if (ex.tituloAntes || ex.tituloDepois) {
        linhas.push(`Título antes: ${ex.tituloAntes || '—'}`);
        linhas.push(`Título depois: ${ex.tituloDepois || '—'}`);
      }
      if (ex.materiaAntes || ex.materiaDepois) {
        linhas.push(`Texto antes: ${ex.materiaAntes || '—'}`);
        linhas.push(`Texto depois: ${ex.materiaDepois || '—'}`);
      }
      parts.push(linhas.join('\n'));
    });
    parts.push('Use o estilo do DEPOIS (tom, ritmo, fechamento). Não copie fatos dos exemplos.');
  }
  return parts.join('\n\n');
}

module.exports = {
  registrarAprendizado,
  registrarFeedbackDoChat,
  atualizarRegrasEstilo,
  obterOrientacoes,
  salvarOrientacoes,
  acrescentarOrientacao,
  ensinarComContexto,
  obterContextoAprendizado,
  analisarOrientacoesEditor,
  formatarContextoAprendizadoParaPrompt,
  diffSignificativo,
  normText,
};
