const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ejs = require('ejs');
const axios = require('axios');
const service = require('../src/services/ayrshareService');
const controller = require('../src/controllers/ayrshareController');
const db = require('../src/config/db');
const { env } = require('../src/config/env');

test('cadastro valida perfil antes de gravar e não duplica página', async (t) => {
  const rows = [];
  let account = null;
  let writes = 0;
  const profile = { refId: 'ref-test', facebookConnected: true, facebookPageId: '1234', facebookPageName: 'Página teste' };
  t.mock.method(service, 'isAyrshareApiKey', () => false);
  t.mock.method(service, 'fetchProfileByKey', async () => profile);
  t.mock.method(db, 'transaction', async (run) => {
    const trx = (table) => {
      const query = {
        where() { return this; }, forUpdate() { return this; },
        async first() { return table === 'users' ? { id: 7 } : account; },
        then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
        async insert(row) {
          writes++;
          if (table === 'facebook_accounts') account = { ...row, id: 9 };
          else rows.push({ ...row, id: 10 });
          return [10];
        },
        async update(patch) { Object.assign(rows[0], patch); },
      };
      return query;
    };
    trx.fn = { now: () => new Date() };
    return run(trx);
  });
  async function call(body) {
    let result, error;
    await controller.addPage({ session: { userId: 7 }, body }, { json: (data) => { result = data; } }, (err) => { error = err; });
    return { result, error };
  }
  assert.equal((await call({})).error.status, 400);
  assert.equal((await call({ profile_key: 'a'.repeat(40) })).error.status, 400);
  assert.equal((await call({ profile_key: 'key', ref_id: 'wrong' })).error.status, 422);
  profile.facebookConnected = false;
  assert.equal((await call({ profile_key: 'key' })).error.status, 422);
  assert.equal(writes, 0);
  profile.facebookConnected = true;
  const first = await call({ profile_key: 'key', ref_id: 'ref-test' });
  assert.equal(first.result.page.page_name, 'Página teste');
  assert.equal(rows[0].facebook_account_id, 9);
  assert.equal(account.user_id, 7);
  assert.equal((await call({ profile_key: 'key' })).result.page.existing, true);
  assert.equal(rows.length, 1);
  assert.equal((await call({ profile_key: 'other-key' })).error.status, 409);
});

test('consulta de perfis preserva paginação sem retornar chaves', async (t) => {
  const previous = env.ayrshare.apiKey;
  env.ayrshare.apiKey = 'test-only';
  t.after(() => { env.ayrshare.apiKey = previous; });
  t.mock.method(axios, 'get', async (url, options) => {
    assert.ok(url.endsWith('/profiles'));
    assert.equal(options.params.cursor, 'cursor-1');
    return { data: { profiles: [{ title: 'Perfil', refId: 'ref', status: 'active', activeSocialAccounts: ['facebook'], profileKey: 'secret' }], pagination: { hasMore: true, nextCursor: 'cursor-2' } } };
  });
  const result = await service.listProfiles({ cursor: 'cursor-1' });
  assert.equal(result.next_cursor, 'cursor-2');
  assert.equal(result.profiles[0].facebook_connected, true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('template e scripts renderizam para administrador, usuário e outro provedor', () => {
  const source = fs.readFileSync('public/views/paginas.ejs', 'utf8');
  for (const role of ['administrador', 'usuario']) {
    for (const provider of ['ayrshare', 'postsyncer']) {
      const html = ejs.render(source, { include: () => '', publishProvider: provider, ayrshareConfigured: true, user: { nivel_acesso: role } });
      for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
      assert.equal(html.includes('id="ay-discover"'), provider === 'ayrshare' && role === 'administrador');
    }
  }
});

/** transaction falsa: guarda as páginas inseridas/alteradas. */
function bancoFalso(t, { paginas = [] } = {}) {
  const rows = paginas;
  let account = { id: 9, user_id: 7 };
  t.mock.method(db, 'transaction', async (run) => {
    const trx = (table) => {
      let filtro = null;
      const query = {
        where(cond) { filtro = cond; return this; }, forUpdate() { return this; },
        async first() { return table === 'users' ? { id: 7 } : account; },
        then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
        async insert(row) {
          if (table === 'facebook_accounts') account = { ...row, id: 9 };
          else rows.push({ ...row, id: 20 + rows.length });
          return [20 + rows.length - 1];
        },
        async update(patch) { Object.assign(rows.find((r) => r.id === filtro.id), patch); },
      };
      return query;
    };
    trx.fn = { now: () => new Date() };
    return run(trx);
  });
  return rows;
}

async function chamarAddPage(body) {
  let result, error;
  await controller.addPage({ session: { userId: 7 }, body }, { json: (data) => { result = data; } }, (err) => { error = err; });
  return { result, error };
}

test('conta só com Primary Profile: adiciona a página sem Profile Key e marca como padrão', async (t) => {
  const Users = require('../src/models/Users');
  const rows = bancoFalso(t);
  let padrao = null;
  t.mock.method(Users, 'setDefaultFacebookPageId', async (_u, id) => { padrao = id; });
  t.mock.method(service, 'diagnosticarConta', async () => ({
    ok: true,
    primary: { refId: 'r1', title: 'Primary', facebookConnected: true, facebookPageName: 'JM Notícia', facebookPageId: '555' },
  }));
  const { result, error } = await chamarAddPage({ primary: true });
  assert.equal(error, undefined);
  assert.equal(result.page.page_name, 'JM Notícia');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].page_id, '555');
  assert.equal(rows[0].ayrshare_profile_key, null);
  assert.equal(padrao, rows[0].id);
  assert.match(result.aviso, /sem Profile Key/);
});

test('página que tinha Profile Key da conta antiga passa a usar o Primary Profile', async (t) => {
  const Users = require('../src/models/Users');
  const rows = bancoFalso(t, { paginas: [{ id: 3, page_id: '555', page_name: 'JM', ayrshare_profile_key: 'CHAVE-ANTIGA' }] });
  t.mock.method(Users, 'setDefaultFacebookPageId', async () => {});
  t.mock.method(service, 'diagnosticarConta', async () => ({
    ok: true,
    primary: { refId: 'r1', facebookConnected: true, facebookPageName: 'JM Notícia', facebookPageId: '555' },
  }));
  const { result } = await chamarAddPage({ primary: true });
  assert.equal(result.page.existing, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ayrshare_profile_key, null);
});

test('Primary Profile sem Facebook ou API Key do servidor velha: mensagens claras e nada gravado', async (t) => {
  const rows = bancoFalso(t);
  const diag = t.mock.method(service, 'diagnosticarConta', async () => ({ ok: true, primary: { facebookConnected: false } }));
  let r = await chamarAddPage({ primary: true });
  assert.equal(r.error.status, 422);
  assert.match(r.error.message, /Social Accounts/);
  diag.mock.mockImplementation(async () => ({ ok: false, status: 401, motivo: 'API Key not valid' }));
  r = await chamarAddPage({ primary: true });
  assert.match(r.error.message, /AYRSHARE_API_KEY no \.env/);
  assert.equal(rows.length, 0);
});

test('Profile Key recusado: explica se é a chave do servidor, uma API Key colada ou chave errada', async (t) => {
  bancoFalso(t);
  t.mock.method(service, 'isAyrshareApiKey', () => false);
  t.mock.method(service, 'fetchProfileByKey', async () => { throw Object.assign(new Error('401'), { response: { status: 401 } }); });
  const diag = t.mock.method(service, 'diagnosticarConta', async () => ({ ok: false, status: 401 }));
  const comoApiKey = t.mock.method(service, 'valeComoApiKey', async () => true);

  let r = await chamarAddPage({ profile_key: 'AAAA1111-BBBB2222-CCCC3333-DDDD4444' });
  assert.match(r.error.message, /AYRSHARE_API_KEY no \.env do servidor/);

  diag.mock.mockImplementation(async () => ({ ok: true, primary: {} }));
  r = await chamarAddPage({ profile_key: 'AAAA1111-BBBB2222-CCCC3333-DDDD4444' });
  assert.match(r.error.message, /Isso é a API Key de uma conta Ayrshare/);

  comoApiKey.mock.mockImplementation(async () => false);
  r = await chamarAddPage({ profile_key: 'AAAA1111-BBBB2222-CCCC3333-DDDD4444' });
  assert.match(r.error.message, /Primary Profile/);
  assert.equal(r.error.status, 422);
});

test('RefId colado aponta para o botão do Primary Profile', async () => {
  const r = await chamarAddPage({ profile_key: '1aec54c9efc13d155f4910ea45a3fb1fd0f45fd2' });
  assert.equal(r.error.status, 400);
  assert.match(r.error.message, /RefId/);
  assert.match(r.error.message, /Primary Profile/);
});

test('buscar perfis: plano sem User Profiles ainda mostra o Primary Profile; chave velha dá erro claro', async (t) => {
  t.mock.method(service, 'diagnosticarConta', async () => ({
    ok: true,
    primary: { title: 'Primary', facebookConnected: true, facebookPageName: 'JM Notícia' },
  }));
  t.mock.method(service, 'listProfiles', async () => { throw new Error('plan'); });
  t.mock.method(service, 'finalDaApiKey', () => '73EE');
  let dados, erro;
  const res = { set() {}, json: (d) => { dados = d; } };
  await controller.listProfiles({ query: {} }, res, (e) => { erro = e; });
  assert.equal(erro, undefined);
  assert.deepEqual(dados.profiles, []);
  assert.equal(dados.primary.facebook_page_name, 'JM Notícia');
  assert.equal(dados.api_key_final, '73EE');
  assert.match(dados.aviso, /Primary Profile/);
  assert.ok(!JSON.stringify(dados).includes('apiKey'));

  service.diagnosticarConta.mock.mockImplementation(async () => ({ ok: false, status: 401 }));
  await controller.listProfiles({ query: {} }, res, (e) => { erro = e; });
  assert.equal(erro.status, 502);
  assert.match(erro.message, /AYRSHARE_API_KEY/);
});
