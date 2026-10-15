const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { prepararAba } = require('../src/services/abaEmSegundoPlano');

const ABA = fs.readFileSync('src/services/abaEmSegundoPlano.js', 'utf8');
const LIVRE = fs.readFileSync('src/services/chatgptLivreService.js', 'utf8');

/** CDP falso: registra o que foi enviado e pode falhar em comandos escolhidos. */
function cdpFalso({ falharEm = [] } = {}) {
  const enviados = [];
  const sessao = {
    async send(cmd, args) {
      enviados.push({ cmd, args });
      if (falharEm.some((f) => cmd.includes(f))) throw new Error(`${cmd} não suportado`);
      return {};
    },
    async detach() {
      enviados.push({ cmd: 'detach' });
    },
  };
  return { enviados, context: { newCDPSession: async () => sessao } };
}

test('a aba de fundo ganha viewport e se considera visível', () => {
  // Sem isto, o Chrome não renderiza a aba criada com background:true. A
  // lista de mensagens do ChatGPT é virtualizada e montava ZERO linhas: o log
  // do servidor mostrou turnos=0 numa conversa já respondida, com o título
  // certo (document.title não depende de layout).
  const { enviados, context } = cdpFalso();
  return prepararAba(context, { marca: 'pagina' }).then((pagina) => {
    assert.equal(pagina.marca, 'pagina', 'devolve a própria página');
    const metricas = enviados.find((e) => e.cmd === 'Emulation.setDeviceMetricsOverride');
    assert.ok(metricas, 'precisa dar um viewport de layout');
    assert.ok(metricas.args.width >= 1024, 'largura de desktop: no estreito o ChatGPT muda o layout');
    assert.ok(metricas.args.height >= 600);
    assert.equal(metricas.args.mobile, false);
    assert.ok(
      enviados.some((e) => e.cmd === 'Emulation.setFocusEmulationEnabled' && e.args.enabled === true),
      'a página precisa se considerar visível e focada'
    );
    assert.ok(enviados.some((e) => e.cmd === 'detach'), 'a sessão CDP não pode vazar');
  });
});

test('Chrome sem um dos comandos não derruba a abertura da aba', async () => {
  const { enviados, context } = cdpFalso({ falharEm: ['setFocusEmulationEnabled'] });
  const pagina = await prepararAba(context, { marca: 'pagina' });
  assert.equal(pagina.marca, 'pagina');
  assert.ok(enviados.some((e) => e.cmd === 'detach'), 'ainda assim solta a sessão');
});

test('sem sessão CDP, segue como antes', async () => {
  const context = { newCDPSession: async () => null };
  const pagina = await prepararAba(context, { marca: 'pagina' });
  assert.equal(pagina.marca, 'pagina');
});

test('os dois caminhos de abertura preparam a aba', () => {
  // A reserva (`newPage()`) também precisa: a janela do VNC pode estar
  // minúscula e o layout sairia estreito do mesmo jeito.
  // `return prepararAba(` conta só as chamadas: a declaração da função casa
  // com o mesmo texto e contaria três.
  const chamadas = (ABA.match(/return prepararAba\(context, /g) || []).length;
  assert.equal(chamadas, 2, 'aba de fundo e reserva');
  assert.match(ABA, /return prepararAba\(context, marcar\(pagina, targetId\)\);/);
  assert.match(ABA, /return prepararAba\(context, marcar\(pagina, await idDaAba\(context, pagina\)\)\);/);
});

test('a aba continua nascendo atrás — o VNC não pode voltar a piscar', () => {
  assert.match(ABA, /Target\.createTarget', \{ url: 'about:blank', background: true \}/);
  assert.doesNotMatch(ABA, /bringToFront/, 'trazer para a frente era o problema que a aba de fundo resolveu');
});

test('o tamanho é ajustável sem mexer no código', () => {
  assert.match(ABA, /process\.env\.CHROME_ABA_LARGURA/);
  assert.match(ABA, /process\.env\.CHROME_ABA_ALTURA/);
});

test('o diagnóstico passa a dizer visibilidade e viewport', () => {
  // Para confirmar o conserto no próximo log, em vez de deduzir de novo.
  assert.match(LIVRE, /visibilidade: document\.visibilityState,/);
  assert.match(LIVRE, /viewport: `\$\{window\.innerWidth\}x\$\{window\.innerHeight\}`,/);
});
