const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

/** Carrega um módulo do projeto com dependências trocadas, sem mexer no cache global. */
function carregarCom(relativo, mocks) {
  const filename = path.resolve(__dirname, '..', relativo);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, console, setTimeout, clearTimeout, setImmediate, Date, URL,
    require: (id) => (Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id)),
  }, { filename });
  return module.exports;
}

/** Banco mínimo: where/first/select/update por tabela. */
function criarDb(tabelas) {
  const db = (tabela) => {
    let filtro = () => true;
    const q = {
      where(cond) { filtro = (r) => Object.entries(cond).every(([k, v]) => r[k] === v); return q; },
      select() { return q; },
      async first() { const r = (tabelas[tabela] || []).find(filtro); return r ? { ...r } : undefined; },
      then(ok, falha) { return Promise.resolve((tabelas[tabela] || []).filter(filtro).map((r) => ({ ...r }))).then(ok, falha); },
      async update(dados) {
        const alvo = (tabelas[tabela] || []).filter(filtro);
        for (const r of alvo) for (const [k, v] of Object.entries(dados)) if (k !== 'updated_at') r[k] = v;
        return alvo.length;
      },
    };
    return q;
  };
  db.fn = { now: () => new Date() };
  return db;
}

const PRIMARY = { refId: 'r1', facebookConnected: true, facebookPageName: 'JM Notícia', facebookPageId: '555' };
const erroChaveInvalida = () => Object.assign(new Error('The Profile Key is invalid. Please verify correct Profile Key is being used.'), {
  response: { status: 400, data: { code: 144, status: 'error' } },
});

function carregarConta({ paginas, conta = { ok: true, primary: PRIMARY }, perfis = {} }) {
  const tabelas = { facebook_pages: paginas };
  const chamadas = { user: 0 };
  const ayrshare = {
    isConfigured: () => true,
    apiErrorMessage: (err) => err.message,
    diagnosticarConta: async () => conta,
    fetchProfileByKey: async (chave) => {
      chamadas.user += 1;
      if (perfis[chave]) return perfis[chave];
      throw erroChaveInvalida();
    },
  };
  const servico = carregarCom('src/services/ayrshareContaService.js', {
    '../config/db': criarDb(tabelas),
    '../config/env': { env: { postpulse: { publishProvider: 'ayrshare' } } },
    './ayrshareService': ayrshare,
  });
  return { servico, tabelas, chamadas };
}

test('Profile Key da conta antiga na página do Primary Profile: apaga a chave e a página continua', async () => {
  const { servico, tabelas } = carregarConta({
    paginas: [{ id: 17, page_id: 'ayrshare:antigo', page_name: 'JM Notícia', ayrshare_profile_key: 'CHAVE-VELHA' }],
  });
  const r = await servico.verificarPagina(tabelas.facebook_pages[0]);
  assert.equal(r.estado, 'ok');
  assert.equal(r.curada, true);
  assert.equal(tabelas.facebook_pages[0].ayrshare_profile_key, null);
  assert.equal(tabelas.facebook_pages[0].ayrshare_fora_da_conta, false);
  assert.ok(tabelas.facebook_pages[0].ayrshare_verificada_at);
});

test('página que não existe na conta atual fica marcada fora da conta, com o motivo', async () => {
  const { servico, tabelas } = carregarConta({
    paginas: [
      { id: 3, page_id: '111', page_name: 'Apocalipse Gospel', ayrshare_profile_key: 'CHAVE-VELHA' },
      { id: 4, page_id: '222', page_name: 'Gospel Geral', ayrshare_profile_key: null },
      { id: 5, page_id: '555', page_name: 'Outro nome', ayrshare_profile_key: null },
      { id: 6, page_id: '777', page_name: 'Página Gospell', ayrshare_profile_key: 'CHAVE-BOA' },
    ],
    perfis: { 'CHAVE-BOA': { facebookConnected: true } },
  });
  const resumo = await servico.sincronizarPaginas(tabelas.facebook_pages);
  const porId = Object.fromEntries(tabelas.facebook_pages.map((p) => [p.id, p]));
  assert.equal(porId[3].ayrshare_fora_da_conta, true);
  assert.match(porId[3].ayrshare_motivo, /outra conta Ayrshare/);
  assert.equal(porId[4].ayrshare_fora_da_conta, true, 'sem chave e não é a página do Primary');
  assert.equal(porId[5].ayrshare_fora_da_conta, false, 'mesmo id do Facebook do Primary');
  assert.equal(porId[6].ayrshare_fora_da_conta, false, 'User Profile válido na conta atual');
  assert.equal(resumo.fora.map((p) => p.id).sort().join(','), '3,4');
});

test('API Key do servidor recusada: não marca nenhuma página', async () => {
  const { servico, tabelas } = carregarConta({
    paginas: [{ id: 3, page_id: '111', page_name: 'Apocalipse Gospel', ayrshare_profile_key: 'CHAVE' }],
    conta: { ok: false, status: 401 },
  });
  const r = await servico.verificarPagina(tabelas.facebook_pages[0]);
  assert.equal(r.estado, 'desconhecido');
  assert.equal(tabelas.facebook_pages[0].ayrshare_fora_da_conta, undefined);
});

test('conferida há pouco: usa o resultado gravado sem chamar a Ayrshare', async () => {
  const { servico, tabelas, chamadas } = carregarConta({
    paginas: [{ id: 3, page_id: '111', page_name: 'X', ayrshare_profile_key: 'CHAVE', ayrshare_fora_da_conta: true, ayrshare_verificada_at: new Date() }],
  });
  const r = await servico.verificarPagina(tabelas.facebook_pages[0]);
  assert.equal(r.estado, 'fora');
  assert.equal(chamadas.user, 0);
});

test('listas escondem páginas fora da conta e não repetem a mesma Página do Facebook', async () => {
  const proprias = [
    { id: 1, page_id: '555', page_name: 'JM Notícia', facebook_account_id: 10 },
    { id: 2, page_id: '111', page_name: 'Apocalipse Gospel', facebook_account_id: 10, ayrshare_fora_da_conta: 1 },
  ];
  const concedidas = { 17: { id: 17, page_id: '555', page_name: 'JM Notícia', facebook_account_id: 99 }, 18: { id: 18, page_id: '888', page_name: 'Gospel Geral', facebook_account_id: 99 } };
  const resolver = carregarCom('src/services/facebookPageResolver.js', {
    '../config/db': criarDb({ user_facebook_pages: [{ user_id: 7, facebook_page_id: 17 }, { user_id: 7, facebook_page_id: 18 }] }),
    '../models/FacebookAccounts': { findByUser: async () => ({ id: 10 }) },
    '../models/FacebookPages': { findByAccount: async () => proprias, findById: async (id) => concedidas[id] || null },
    '../models/Users': { getDefaultFacebookPageId: async () => null, setDefaultFacebookPageId: async () => {} },
  });
  const visiveis = await resolver.pagesForUser(7);
  assert.equal(visiveis.map((p) => p.id).join(','), '1,18');
  const todas = await resolver.pagesForUser(7, { incluirForaDaConta: true });
  assert.equal(todas.map((p) => p.id).join(','), '1,2,17,18');
});

test('publicação: "Profile Key is invalid" corrige a página do Primary e publica de novo, sem chave', async (t) => {
  const { env } = require('../src/config/env');
  const ayrshareService = require('../src/services/ayrshareService');
  const pageResolver = require('../src/services/facebookPageResolver');
  const contaAyrshare = require('../src/services/ayrshareContaService');
  const publishDispatch = require('../src/services/publishDispatch');
  const anterior = env.postpulse.publishProvider;
  env.postpulse.publishProvider = 'ayrshare';
  t.after(() => { env.postpulse.publishProvider = anterior; });
  t.mock.method(ayrshareService, 'isConfigured', () => true);
  t.mock.method(pageResolver, 'resolvePageForUser', async () => ({ id: 17, page_id: 'x', page_name: 'JM Notícia', ayrshare_profile_key: 'CHAVE-VELHA' }));
  const verificar = t.mock.method(contaAyrshare, 'verificarPagina', async () => ({ estado: 'ok', curada: true }));
  const envios = [];
  t.mock.method(ayrshareService, 'publishToFacebook', async (payload) => {
    envios.push(payload);
    if (envios.length === 1) throw erroChaveInvalida();
    return { post_id: 'ayrshare:ok' };
  });

  const result = await publishDispatch.publishContent({
    userId: 7,
    page: { id: 17, page_id: 'x', page_name: 'JM Notícia' },
    tipo: 'foto',
    filePath: __filename,
    texto: 'Matéria',
    publicarFacebook: true,
  });
  assert.equal(envios.length, 2);
  assert.equal(envios[0].profileKey, 'CHAVE-VELHA');
  assert.equal(envios[1].profileKey, null);
  assert.equal(result.post_id, 'ayrshare:ok');
  assert.equal(verificar.mock.callCount(), 1);

  // Página que não é a do Primary: erro claro, sem nova tentativa.
  envios.length = 0;
  verificar.mock.mockImplementation(async () => ({ estado: 'fora', curada: false, motivo: 'Profile Key de outra conta' }));
  await assert.rejects(
    publishDispatch.publishContent({ userId: 7, page: { id: 17 }, tipo: 'foto', filePath: __filename, texto: 'x', publicarFacebook: true }),
    (err) => err.code === 'AYRSHARE_PROFILE_KEY_DA_CONTA_ANTIGA' && /conta Ayrshare atual/.test(err.message)
  );
  assert.equal(envios.length, 1);
});
