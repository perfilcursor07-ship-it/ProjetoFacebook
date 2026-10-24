const fs = require('fs');
const path = require('path');
const app = require('./app');
const { env } = require('./config/env');
const { recoverStuckJobs } = require('./services/processingService');

const storageDirs = ['videos', 'clips', 'imagens', 'temp', 'tmp', 'splits', 'splits/frames'].map((dir) =>
  path.join(env.storagePath, dir)
);

for (const dir of storageDirs) {
  fs.mkdirSync(dir, { recursive: true });
}

// Testar os cookies do Facebook/Instagram faz um acesso logado. Fazer isso a
// cada boot (inclusive em loop de reinício) mandava centenas de logins do IP
// do servidor e a Meta bloqueava a conta ("várias sessões"). Agora o teste
// roda no máximo a cada SOCIAL_VALIDACAO_HORAS (padrão 12 h), entre reinícios.
const VALIDACAO_SOCIAL_ARQUIVO = path.join(env.storagePath, 'tmp', 'validacao-social.json');
function validacaoSocialLiberada(rede) {
  const horas = Number(process.env.SOCIAL_VALIDACAO_HORAS ?? 12);
  if (!(horas > 0)) return false; // 0 desliga o teste no boot
  let registro = {};
  try {
    registro = JSON.parse(fs.readFileSync(VALIDACAO_SOCIAL_ARQUIVO, 'utf8')) || {};
  } catch {
    registro = {};
  }
  const ultima = Number(registro[rede]) || 0;
  const passou = Date.now() - ultima;
  if (passou < horas * 60 * 60 * 1000) {
    console.log(`[${rede === 'facebook' ? 'fb' : 'ig'}-session] teste pulado (último há ${Math.round(passou / 60000)} min; limite ${horas} h)`);
    return false;
  }
  registro[rede] = Date.now();
  try {
    fs.writeFileSync(VALIDACAO_SOCIAL_ARQUIVO, JSON.stringify(registro));
  } catch {
    /* sem gravação: testa só desta vez */
  }
  return true;
}

app.listen(env.port, async () => {
  console.log(`ViralizeAI rodando em http://localhost:${env.port}`);
  try {
    const {
      diagnoseInstagramCookies,
      validateInstagramSession,
    } = require('./services/instagramCookies');
    const ig = diagnoseInstagramCookies();
    console.log(
      `[ig-cookies] ${ig.ok ? 'FORMATO OK' : 'FALHA'} — ${ig.reason}` +
        (ig.file ? ` (${ig.file}, ${ig.size || 0}b, tabs=${ig.hasTabs})` : '')
    );
    if (ig.ok && validacaoSocialLiberada('instagram')) {
      const axios = require('axios');
      const remote = await validateInstagramSession(axios);
      console.log(
        `[ig-session] ${remote.ok ? 'AUTENTICADA' : 'REJEITADA'} — ${remote.reason}` +
          (remote.status ? ` (HTTP ${remote.status})` : '')
      );
    }
  } catch (err) {
    console.warn('[ig-cookies] diagnose:', err.message);
  }
  try {
    const {
      diagnoseFacebookCookies,
      validateFacebookSession,
    } = require('./services/facebookCookies');
    const fb = diagnoseFacebookCookies();
    console.log(
      `[fb-cookies] ${fb.ok ? 'FORMATO OK' : 'FALHA'} — ${fb.reason}` +
        (fb.file ? ` (${fb.file}, ${fb.size || 0}b, tabs=${fb.hasTabs})` : '')
    );
    if (fb.ok && validacaoSocialLiberada('facebook')) {
      const axios = require('axios');
      const remote = await validateFacebookSession(axios);
      console.log(
        `[fb-session] ${remote.ok ? 'AUTENTICADA' : 'REJEITADA'} — ${remote.reason}` +
          (remote.status ? ` (HTTP ${remote.status})` : '')
      );
    }
  } catch (err) {
    console.warn('[fb-cookies] diagnose:', err.message);
  }
  try {
    await recoverStuckJobs();
  } catch (err) {
    console.error('[recover] falhou:', err.message);
  }
  try {
    await require('./services/feedSugeridoService').retomarAposReinicio();
  } catch (err) {
    console.error('[feed-sugerido] retomar falhou:', err.message);
  }
  // Furos do dia no automático: varre, escreve, gera imagem e publica sozinho.
  require('./services/furosAutopilotService').iniciar();
  // Fecha abas temporárias esquecidas no Chrome do gateway (CPU/memória).
  require('./services/chromeFaxina').iniciar();

  // Não interrompe o site: se o gateway tiver voltado sem a sessão em memória,
  // reaproveita silenciosamente o login que já está salvo no Chrome privado.
  setTimeout(() => {
    const { recuperarClaudeAposReload } = require('./services/tokenFreeAdminService');
    void recuperarClaudeAposReload();
  }, 8_000);
  // Gateway e Chrome não são do PM2: depois de um reinício do servidor (ou
  // se caírem) ficavam desligados até alguém clicar em "Iniciar" no /claude.
  // O vigia confere a cada minuto e religa sozinho. TFG_VIGIA=false desliga.
  require('./services/tokenFreeAdminService').iniciarVigia();

  try {
    const materiaIaService = require('./services/materiaIaService');
    const bibliotecaService = require('./services/bibliotecaService');
    // Cada etapa isolada, com nome e com trava de reentrada.
    //
    // Antes tudo dividia o mesmo try e a mesma espera. Duas consequências:
    //
    // 1) Etapa que estourasse levava embora as seguintes — monitor com erro
    //    cancelava a publicação das agendadas daquele minuto, sem deixar
    //    rastro na matéria. Era o agendamento "que não funciona".
    // 2) A varredura das fontes passa de 8 min quando as sessões do Facebook
    //    e do Instagram caem (cada página: ~7s e 11 MB de HTML, todas
    //    falhando). O tick de 60s começava outro por cima, e a fila do Dots
    //    e das agendadas quase nunca chegava a rodar.
    //
    // Agora: publicar e escrever (rápido) andam em paralelo com varrer
    // (lento), e etapa que ainda está rodando não é começada de novo.
    const rodando = new Set();
    // Quando o Node trava, o log diz qual destas etapas estava rodando.
    require('./services/vigiaLentidao').iniciar(() => rodando);
    const correr = async (nome, executar) => {
      if (rodando.has(nome)) {
        console.warn(`[tick ${nome}] ainda rodando desde o tick anterior — pulei esta volta`);
        return;
      }
      rodando.add(nome);
      try {
        await executar();
      } catch (err) {
        console.error(`[tick ${nome}]`, err.message);
      } finally {
        rodando.delete(nome);
      }
    };

    // Sai na hora marcada: nada aqui pode esperar por varredura.
    const rapidas = [
      ['fila-agendadas', () => materiaIaService.tickFilaJobs()],
      ['dots', () => require('./services/dotsService').tick()],
      ['agenda-auto', () => require('./services/bibliotecaAgendaService').tickAgendaPre()],
      [
        'biblioteca-manual',
        () => require('./services/bibliotecaReelAutopilotService').publicarPendentesManuais(3),
      ],
    ];
    // Vai no ritmo que der: rede, scraping e IA.
    const lentas = [
      ['monitores', () => materiaIaService.tickMonitores()],
      ['biblioteca-fontes', () => bibliotecaService.tickFontes()],
      ['biblioteca-autopilot', () => bibliotecaService.tickAutopilot()],
    ];
    const emSequencia = async (etapas) => {
      for (const [nome, executar] of etapas) await correr(nome, executar);
    };
    const tick = () => {
      void emSequencia(rapidas);
      void emSequencia(lentas);
    };
    setInterval(tick, 60_000);
    setTimeout(tick, 15_000);
  } catch (err) {
    console.error('[materias-ia] init tick falhou:', err.message);
  }
});
