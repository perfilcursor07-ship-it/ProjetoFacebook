const test = require('node:test');
const assert = require('node:assert/strict');

const { instagramFailureReason } = require('../src/services/instagramCookies');

test('pedido real de verificação é reconhecido', () => {
  for (const resposta of [
    { message: 'challenge_required', status: 'fail' },
    { message: 'checkpoint_required' },
    { challenge: { url: '/challenge/ABC/' } },
    { message: 'erro', challenge_url: '/challenge/XYZ/' },
  ]) {
    const motivo = instagramFailureReason(resposta, 400);
    assert.match(motivo, /verificacao de seguranca/, `não reconheceu: ${JSON.stringify(resposta)}`);
  }
});

test('a palavra "challenge" dentro de dados normais NÃO vira checkpoint', () => {
  // Era este o bug: a busca varria até 200 KB do corpo atrás da palavra solta.
  // Uma resposta boa com um perfil chamado "challenge" ou uma legenda em inglês
  // marcava a sessão como bloqueada.
  const respostaBoa = {
    users: [
      { user: { username: 'challenge_fitness', full_name: 'Challenge Fitness' } },
      { user: { username: 'outro', biography: 'Join the 30 day challenge!' } },
    ],
    status: 'ok',
  };
  const motivo = instagramFailureReason(respostaBoa, 200);
  assert.doesNotMatch(motivo, /verificacao de seguranca/, `rotulou errado: ${motivo}`);
});

test('nome de bundle ou flag com "challenge" também não conta', () => {
  const resposta = { rollout: { challenge_ui_enabled: false }, data: {}, status: 'ok' };
  assert.doesNotMatch(instagramFailureReason(resposta, 200), /verificacao de seguranca/);
});

test('tela de login em HTML é reportada como tal', () => {
  const html = '<!doctype html><html><body>Entre para ver</body></html>';
  assert.match(instagramFailureReason(html, 200), /HTML em vez de dados/);
  assert.match(instagramFailureReason({ message: 'login_required' }, 403), /login_required/);
});

test('limite de requisições tem motivo próprio', () => {
  assert.match(instagramFailureReason({}, 429), /HTTP 429/);
});

test('200 sem o perfil mostra a forma da resposta, sem expor valores', () => {
  // Distingue bloqueio de mudança de formato da API — era impossível antes.
  const motivo = instagramFailureReason({ users: [], places: [], hashtags: [] }, 200);
  assert.match(motivo, /sem o perfil procurado/);
  assert.match(motivo, /users, places, hashtags/, 'os nomes dos campos ajudam a diagnosticar');
  assert.doesNotMatch(motivo, /sessionid|csrftoken/, 'nunca pode vazar valor de cookie');
});

test('mensagem explícita do Instagram é repassada', () => {
  assert.match(
    instagramFailureReason({ message: 'Please wait a few minutes' }, 400),
    /Please wait a few minutes \(HTTP 400\)/
  );
});

const { comoResolver } = require('../src/controllers/cookiesController');

test('verificação de segurança manda resolver na conta, não trocar cookies', () => {
  // Era o conselho errado: o editor acabara de exportar cookies novos.
  const texto = comoResolver('a conta precisa passar pela verificacao de seguranca do Instagram', 'instagram.com');
  assert.match(texto, /resolva o aviso/);
  assert.match(texto, /instagram\.com/);
  assert.match(texto, /vão falhar igual/, 'precisa dizer por que reexportar não adianta');
});

test('sessão caída manda reexportar, que aí sim resolve', () => {
  assert.match(comoResolver('login_required', 'facebook.com'), /Faça login em facebook\.com/);
});

test('limite de requisições manda esperar, não trocar cookies', () => {
  const texto = comoResolver('limite de requisicoes (HTTP 429)', 'instagram.com');
  assert.match(texto, /Espere alguns minutos/);
  assert.match(texto, /trocar os cookies não resolve/);
});

test('resposta sem o perfil pede nova tentativa antes de trocar a sessão', () => {
  const texto = comoResolver('o Instagram respondeu sem o perfil procurado (HTTP 200; campos: users)', 'instagram.com');
  assert.match(texto, /Teste de novo em alguns minutos/);
});

test('motivo desconhecido cai no conselho genérico', () => {
  assert.match(comoResolver('algo novo', 'instagram.com'), /Reexporte os cookies/);
});
