const tokenFreeAdminService = require('../services/tokenFreeAdminService');

async function index(_req, res, next) {
  try {
    const initialStatus = await tokenFreeAdminService.status();
    return res.render('claude-gateway', {
      title: 'Sessões do Claude e ChatGPT',
      initialStatus,
    });
  } catch (err) {
    return next(err);
  }
}

async function status(_req, res, next) {
  try {
    return res.json({ ok: true, ...(await tokenFreeAdminService.status()) });
  } catch (err) {
    return next(err);
  }
}

async function iniciar(_req, res, next) {
  try {
    return res.json(await tokenFreeAdminService.iniciar());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function reiniciar(_req, res, next) {
  try {
    return res.json(await tokenFreeAdminService.reiniciar());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function autorizar(req, res, next) {
  try {
    const trocarConta = req.body?.trocarConta === true || req.body?.trocarConta === 'true';
    const provider = req.body?.provider === 'chatgpt' ? 'chatgpt' : 'claude';
    return res.status(202).json({
      ok: true,
      autorizacao: tokenFreeAdminService.iniciarAutorizacao({ trocarConta, provider }),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function continuarAutorizacao(_req, res, next) {
  try {
    return res.json({
      ok: true,
      autorizacao: tokenFreeAdminService.continuarAutorizacao(),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function testar(_req, res, next) {
  try {
    return res.json(await tokenFreeAdminService.testar());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Modelos que o administrador pode pausar: gateway, DeepSeek, Claude API e imagem. */
async function catalogoDePausa() {
  const { env } = require('../config/env');
  const materiaModelos = require('../services/materiaModelosService');
  let doGateway = [];
  try {
    doGateway = (await materiaModelos.listarCatalogo()).modelos || [];
  } catch {
    doGateway = [];
  }
  const extras = [
    { id: env.deepseekWriterModel || env.deepseekModel, uso: 'DeepSeek (redação e tarefas auxiliares)' },
    { id: env.deepseekModel, uso: 'DeepSeek' },
    { id: env.claudeWriterModel, uso: 'API oficial do Claude' },
    { id: String(process.env.CHATGPT_IMAGE_MODEL || 'gpt-5.6').trim(), uso: 'ChatGPT (texto e imagens)' },
  ];
  const vistos = new Set();
  const lista = [];
  for (const item of [...doGateway.map((m) => ({ id: m.id, nome: m.nome, uso: 'Gateway (Claude/ChatGPT web)' })), ...extras]) {
    const id = String(item.id || '').trim();
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    lista.push({ id, nome: item.nome || materiaModelos.nomeModeloHumano(id), uso: item.uso });
  }
  return lista;
}

async function pausaIa(_req, res, next) {
  try {
    const iaPausa = require('../services/iaPausaService');
    const [estado, modelos] = await Promise.all([iaPausa.estado(), catalogoDePausa()]);
    return res.json({ ok: true, ...estado, mensagem: iaPausa.MENSAGEM, catalogo: modelos });
  } catch (err) {
    return next(err);
  }
}

async function salvarPausaIa(req, res, next) {
  try {
    const iaPausa = require('../services/iaPausaService');
    const estado = await iaPausa.salvar({
      geral: req.body?.geral === true,
      modelos: req.body?.modelos,
      userId: req.session.userId,
    });
    console.info(`[ia-pausa] user ${req.session.userId}: geral=${estado.geral} modelos=${estado.modelos.join(',') || '-'}`);
    return res.json({ ok: true, ...estado, mensagem: iaPausa.MENSAGEM, catalogo: await catalogoDePausa() });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function modelosMateria(_req, res, next) {
  try {
    const materiaModelos = require('../services/materiaModelosService');
    return res.json({ ok: true, ...(await materiaModelos.listarCatalogo()) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function salvarModelosMateria(req, res, next) {
  try {
    const materiaModelos = require('../services/materiaModelosService');
    const catalogo = await materiaModelos.salvar({
      habilitados: req.body?.habilitados,
      padrao: req.body?.padrao,
    });
    return res.json({ ok: true, ...catalogo });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Modelo fixo por tarefa (piloto automático e títulos) e o que pode ser escolhido. */
/** Tarefas que não escolhem modelo de texto, e sim outra lista própria. */
function opcoesPorTarefa() {
  const { GERADORES, PADRAO } = require('../services/imagemIaService');
  return {
    imagem: {
      vazio: `${GERADORES[PADRAO]} (padrão)`,
      opcoes: Object.entries(GERADORES)
        .filter(([id]) => id !== PADRAO)
        .map(([id, nome]) => ({ id, nome })),
    },
  };
}

async function respostaModelosTarefa(escolhas) {
  const iaModeloTarefa = require('../services/iaModeloTarefaService');
  const { modelos, gatewayOnline } = await require('../services/materiaModelosService').listarCatalogo();
  const especiais = opcoesPorTarefa();
  return {
    ok: true,
    gatewayOnline,
    tarefas: Object.entries(iaModeloTarefa.TAREFAS).map(([id, nome]) => ({
      id,
      nome,
      ...(especiais[id] ? { vazio: especiais[id].vazio, opcoes: especiais[id].opcoes } : {}),
    })),
    escolhas: escolhas || (await iaModeloTarefa.todos()),
    modelos: modelos.map(({ id, nome, provedor, disponivel }) => ({ id, nome, provedor, disponivel })),
  };
}

async function modelosTarefa(_req, res, next) {
  try {
    return res.json(await respostaModelosTarefa());
  } catch (err) {
    return next(err);
  }
}

async function salvarModelosTarefa(req, res, next) {
  try {
    const iaModeloTarefa = require('../services/iaModeloTarefaService');
    const { modelos } = await require('../services/materiaModelosService').listarCatalogo();
    const especiais = opcoesPorTarefa();
    const escolhas = await iaModeloTarefa.salvar(req.body?.escolhas || {}, {
      userId: req.session.userId,
      permitidos: modelos.map((m) => m.id),
      permitidosPorTarefa: Object.fromEntries(
        Object.entries(especiais).map(([tarefa, { opcoes }]) => [tarefa, opcoes.map((o) => o.id)])
      ),
    });
    console.info(`[ia-modelo-tarefa] user ${req.session.userId}: ${JSON.stringify(escolhas)}`);
    return res.json(await respostaModelosTarefa(escolhas));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

module.exports = {
  modelosTarefa,
  salvarModelosTarefa,
  pausaIa,
  salvarPausaIa,
  modelosMateria,
  salvarModelosMateria,
  index,
  status,
  iniciar,
  reiniciar,
  autorizar,
  continuarAutorizacao,
  testar,
};
