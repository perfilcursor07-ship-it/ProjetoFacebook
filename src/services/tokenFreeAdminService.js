const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const gatewayClient = require('./tokenFreeGatewayService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TOOL_DIR = path.resolve(
  process.env.TOKEN_FREE_GATEWAY_SOURCE_DIR || path.join(PROJECT_ROOT, '.tools/token-free-gateway')
);
const ENTRY_FILE = path.join(TOOL_DIR, 'index.ts');
const CHROME_LINUX_CANDIDATES = [
  '/opt/google/chrome/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function localizarBun() {
  const configurado = String(process.env.BUN_PATH || '').trim();
  if (configurado) return configurado;

  const candidatos = process.platform === 'win32'
    ? [
        path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
        path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
      ]
    : [path.join(os.homedir(), '.bun', 'bin', 'bun')];
  return candidatos.find((candidato) => candidato && fs.existsSync(candidato)) || 'bun';
}

const BUN_PATH = localizarBun();
const DATA_DIR = path.join(os.homedir(), '.token-free-gateway');
const AUTH_FILE = process.env.TFG_STORE_PATH || path.join(DATA_DIR, 'auth-profiles.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOG_FILE = path.join(DATA_DIR, 'gateway.log');
const CLEAR_SESSION_SCRIPT = path.join(PROJECT_ROOT, 'scripts/token-free-clear-claude-session.ts');

const AUTH_TIMEOUT_MS = 6 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 45 * 1000;
const CHROME_START_TIMEOUT_MS = 45 * 1000;
const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_NOVNC_PORT = 6080;

let authJob = {
  status: 'idle',
  message: 'Nenhuma autorização em andamento.',
  provider: null,
  startedAt: null,
  finishedAt: null,
};
let activeAuthChild = null;
let activeAuthTimer = null;

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function lerJsonSeguro(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function authMetadata(providerId = 'claude-web') {
  const store = await lerJsonSeguro(AUTH_FILE, { profiles: {} });
  const profile = store?.profiles?.[providerId];
  return {
    autorizada: Boolean(
      profile?.credentials?.sessionKey || profile?.credentials?.cookie || profile?.credentials?.accessToken
    ),
    atualizadaEm: isoDate(profile?.updatedAt),
  };
}

async function configMetadata() {
  const config = await lerJsonSeguro(CONFIG_FILE, {});
  return {
    porta: Number(config.port) || 3456,
    cdpUrl: String(config.cdpUrl || 'http://127.0.0.1:9222'),
    apiKeyProtegida: Boolean(String(process.env.TFG_API_KEY || config.apiKey || '').trim()),
    timeoutSegundos: Number(config.requestTimeoutSec) || 300,
  };
}

function authJobPublico() {
  return {
    status: authJob.status,
    message: authJob.message,
    provider: authJob.provider,
    startedAt: authJob.startedAt,
    finishedAt: authJob.finishedAt,
  };
}

function estaDentroDaPasta(pasta, arquivo) {
  const relativo = path.relative(path.resolve(pasta), path.resolve(arquivo));
  return relativo === '' || (!relativo.startsWith('..') && !path.isAbsolute(relativo));
}

function portaLocalAberta(porta, timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: porta });
    let concluido = false;
    const finalizar = (online) => {
      if (concluido) return;
      concluido = true;
      socket.destroy();
      resolve(online);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finalizar(true));
    socket.once('timeout', () => finalizar(false));
    socket.once('error', () => finalizar(false));
  });
}

function destinoSshDesktop() {
  const configurado = String(process.env.CLAUDE_SSH_TARGET || '').trim();
  if (configurado) return configurado;
  let host = 'SEU-SERVIDOR';
  try {
    host = new URL(process.env.APP_PUBLIC_URL || '').hostname || host;
  } catch {
    // Mantém o texto genérico quando APP_PUBLIC_URL não for uma URL válida.
  }
  return `${os.userInfo().username}@${host}`;
}

async function desktopMetadata() {
  const portaConfigurada = Number(process.env.CLAUDE_NOVNC_PORT);
  const porta = Number.isInteger(portaConfigurada) && portaConfigurada > 0
    ? portaConfigurada
    : DEFAULT_NOVNC_PORT;
  const online = process.platform === 'linux' ? await portaLocalAberta(porta) : false;
  return {
    necessario: process.platform === 'linux',
    configurado: process.platform !== 'linux' || Boolean(process.env.DISPLAY),
    online,
    display: String(process.env.DISPLAY || ''),
    porta,
    urlLocal: `http://127.0.0.1:${porta}/vnc.html?autoconnect=1&resize=remote&reconnect=1`,
    comandoSsh: `ssh -N -L ${porta}:127.0.0.1:${porta} ${destinoSshDesktop()}`,
  };
}

async function chromeMetadata(cdpUrl) {
  try {
    const base = String(cdpUrl || 'http://127.0.0.1:9222').replace(/\/$/, '');
    const response = await axios.get(`${base}/json/version`, { timeout: 1_500 });
    return {
      conectado: response.status === 200,
      navegador: String(response.data?.Browser || '').trim() || null,
      erro: null,
    };
  } catch (err) {
    return {
      conectado: false,
      navegador: null,
      erro: err.code === 'ECONNREFUSED' ? 'Porta CDP sem resposta.' : err.message,
    };
  }
}

async function status() {
  const [auth, chatgptAuth, config, desktop] = await Promise.all([
    authMetadata('claude-web'),
    authMetadata('chatgpt-web'),
    configMetadata(),
    desktopMetadata(),
  ]);
  const chromeDireto = await chromeMetadata(config.cdpUrl);
  let health = null;
  let healthError = null;
  let modelos = [];

  try {
    health = await gatewayClient.verificarSaude({ timeout: 3_500 });
    try {
      modelos = await gatewayClient.listarModelos({ timeout: 3_500 });
    } catch {
      modelos = [];
    }
  } catch (err) {
    healthError = err.message;
  }

  const sessao = health?.sessions?.['claude-web'];
  const sessaoChatgpt = health?.sessions?.['chatgpt-web'];
  const modeloConfigurado = gatewayClient.MODELO;
  const modeloDisponivel = modelos.some((item) => String(item?.id || '') === modeloConfigurado);

  return {
    gateway: {
      online: Boolean(health),
      status: health?.status || 'offline',
      erro: healthError,
      url: gatewayClient.BASE_URL,
      cliDisponivel: fs.existsSync(ENTRY_FILE),
      plataforma: process.platform,
    },
    chrome: {
      conectado: chromeDireto.conectado || health?.browser === 'connected',
      cdpUrl: config.cdpUrl,
      navegador: chromeDireto.navegador,
      erro: chromeDireto.erro,
    },
    desktop,
    claude: {
      autorizada: auth.autorizada,
      atualizadaEm: auth.atualizadaEm,
      valida: sessao?.valid === true ? true : sessao?.valid === false ? false : null,
      motivo: sessao?.reason || null,
      modelo: modeloConfigurado,
      modeloDisponivel,
    },
    chatgpt: {
      autorizada: chatgptAuth.autorizada,
      atualizadaEm: chatgptAuth.atualizadaEm,
      valida: sessaoChatgpt?.valid === true ? true : sessaoChatgpt?.valid === false ? false : null,
      motivo: sessaoChatgpt?.reason || null,
      modelo: 'gpt-5.6',
      modeloDisponivel: modelos.some((item) => String(item?.id || '') === 'gpt-5.6'),
    },
    seguranca: {
      apiKeyProtegida: config.apiKeyProtegida,
      credencialForaDoPublico: !estaDentroDaPasta(path.join(PROJECT_ROOT, 'public'), AUTH_FILE),
    },
    autorizacao: authJobPublico(),
  };
}

function executar(executavel, args, { cwd = PROJECT_ROOT, timeout = COMMAND_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executavel, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: false,
    });
    let output = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      const err = new Error(`Operação excedeu ${Math.round(timeout / 1000)} segundos.`);
      err.status = 504;
      reject(err);
    }, timeout);

    const guardar = (atual, chunk) => `${atual}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_CHARS);
    child.stdout?.on('data', (chunk) => {
      output = guardar(output, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = guardar(stderr, chunk);
    });
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) return resolve({ output, stderr });
      const detalhe = String(stderr || output || `código ${code}`).replace(/\s+/g, ' ').trim();
      const err = new Error(`Comando do gateway falhou: ${detalhe.slice(0, 500)}`);
      err.status = 502;
      reject(err);
    });
  });
}

function assertCli() {
  if (fs.existsSync(ENTRY_FILE)) return;
  const err = new Error(
    'Código-fonte do token-free-gateway não encontrado em .tools/token-free-gateway.'
  );
  err.status = 503;
  throw err;
}

async function aguardarChromeCdp(timeout = 20_000) {
  const limite = Date.now() + timeout;
  while (Date.now() < limite) {
    try {
      const response = await axios.get('http://127.0.0.1:9222/json/version', { timeout: 1_000 });
      if (response.status === 200) return true;
    } catch {
      // O Chrome ainda está iniciando.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function pastaPerfilChrome() {
  return path.join(os.homedir(), '.config', 'chrome-tfg-debug');
}

async function ultimasLinhasArquivo(filePath, limite = 3500) {
  try {
    const conteudo = await fsp.readFile(filePath, 'utf8');
    return conteudo.slice(-limite).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Remove somente os marcadores efêmeros que o Chrome deixa quando encerra
 * abruptamente. Cookies, Local Storage e as contas autenticadas permanecem.
 * Só deve ser chamada depois de confirmar que o CDP não está respondendo.
 */
async function limparTravasTemporariasChrome() {
  if (await aguardarChromeCdp(900)) return [];
  const perfil = pastaPerfilChrome();
  const removidos = [];
  for (const nome of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const alvo = path.join(perfil, nome);
    try {
      await fsp.rm(alvo, { force: true });
      removidos.push(nome);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[claude-chrome] não foi possível remover ${nome}:`, err.message);
      }
    }
  }
  return removidos;
}

async function iniciarChromeVisualServidor(startUrl = 'https://claude.ai/new') {
  if (await aguardarChromeCdp(1_200)) return { iniciado: false, jaEstavaOnline: true };
  const chromePath = CHROME_LINUX_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!chromePath) {
    const err = new Error('Google Chrome/Chromium não encontrado no servidor.');
    err.status = 503;
    throw err;
  }

  const userDataDir = pastaPerfilChrome();
  fs.mkdirSync(userDataDir, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const chromeLog = path.join(DATA_DIR, 'chrome.log');
  const logFd = fs.openSync(chromeLog, 'a');
  const flags = [
    '--remote-debugging-port=9222',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--password-store=basic',
    '--remote-allow-origins=*',
    '--window-size=1440,1000',
    startUrl,
  ];

  try {
    const chrome = spawn(chromePath, flags, {
      cwd: os.homedir(),
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    chrome.unref();
  } finally {
    fs.closeSync(logFd);
  }

  if (!(await aguardarChromeCdp(CHROME_START_TIMEOUT_MS))) {
    const detalhe = await ultimasLinhasArquivo(chromeLog);
    const err = new Error(
      `Chrome visual não iniciou no DISPLAY ${process.env.DISPLAY || '(não definido)'}.` +
        (detalhe ? ` Último registro: ${detalhe.slice(-900)}` : ` Consulte ${chromeLog}.`)
    );
    err.status = 502;
    throw err;
  }
  return { iniciado: true, jaEstavaOnline: false };
}

async function comandoGateway(command) {
  assertCli();
  return executar(BUN_PATH, [ENTRY_FILE, command], { cwd: TOOL_DIR });
}

async function prepararChromeParaGateway() {
  if (process.platform !== 'linux') return { preparado: false, motivo: 'plataforma local' };
  if (!process.env.DISPLAY) {
    const err = new Error(
      'O desktop privado está sem DISPLAY. Reinicie os processos claude-xvfb/openbox e recarregue o ViralizeAI.'
    );
    err.status = 503;
    throw err;
  }
  if (await aguardarChromeCdp(1_500)) {
    return { preparado: true, chromeJaOnline: true, travasRemovidas: [] };
  }

  // Uma inicialização interrompida pode deixar processo/lock sem abrir o CDP.
  // O comando é tolerante: gateway offline também pode responder com erro.
  try {
    await comandoGateway('chrome stop');
  } catch {
    // Continua com a recuperação visual abaixo.
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  const travasRemovidas = await limparTravasTemporariasChrome();
  await iniciarChromeVisualServidor();
  return { preparado: true, chromeJaOnline: false, travasRemovidas };
}

async function iniciar() {
  const chrome = await prepararChromeParaGateway();
  await comandoGateway('start');
  return {
    ok: true,
    message: chrome.chromeJaOnline
      ? 'Gateway iniciado com o Chrome existente.'
      : 'Chrome recuperado e gateway iniciado.',
  };
}

async function reiniciar() {
  // Reinício limpo evita que um processo parcial do gateway tente reutilizar
  // um Chrome morto e falhe novamente no timeout interno de 15 segundos.
  try {
    await comandoGateway('stop');
  } catch {
    // Se já estava offline, seguimos normalmente.
  }
  const chrome = await prepararChromeParaGateway();
  await comandoGateway('start');
  return {
    ok: true,
    message: chrome.chromeJaOnline
      ? 'Gateway reiniciado e conectado ao Chrome.'
      : 'Chrome recuperado e gateway reiniciado.',
  };
}

/**
 * Depois de um reload, o Chrome isolado normalmente continua autenticado, mas
 * o gateway pode ter sido reiniciado antes de reler o perfil. Reexecutamos o
 * webauth de forma não interativa: ele apenas captura a sessão já existente,
 * sem apagar cookies nem abrir fluxo de troca de conta.
 */
async function recapturarClaudeDoChrome() {
  const auth = await authMetadata();
  if (!auth.autorizada) return { ok: false, skipped: true, reason: 'sem credencial salva' };
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    return { ok: false, skipped: true, reason: 'desktop privado indisponível' };
  }

  if (!(await aguardarChromeCdp(1_500))) {
    await iniciarChromeVisualServidor();
  }

  const resultado = await new Promise((resolve, reject) => {
    const child = spawn(BUN_PATH, [ENTRY_FILE, 'webauth'], {
      cwd: TOOL_DIR,
      env: process.env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let selectionSent = false;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error('A recaptura automática passou de 75 segundos.'));
    }, 75_000);
    const analisar = (chunk) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_CHARS);
      if (!selectionSent && /Enter selection:/i.test(output)) {
        // O menu é montado pelo próprio gateway; obtém o número do Claude em
        // vez de assumir que ele sempre será a primeira opção.
        const match = output.match(/^\s*(\d+)\.\s+Claude(?:\s|$)/im);
        if (match?.[1]) {
          selectionSent = true;
          child.stdin?.write(`${match[1]}\n`);
        }
      }
    };
    child.stdout.on('data', analisar);
    child.stderr.on('data', analisar);
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (code === 0 && /Claude Web authorization succeeded/i.test(output)) {
        return finish(resolve, { output });
      }
      return finish(reject, new Error(output.replace(/\s+/g, ' ').slice(-600) || `webauth encerrou (${code})`));
    });
  });

  await reiniciar();
  return { ok: true, message: 'Sessão do Claude recapturada do Chrome.', output: resultado.output };
}

/** Não bloqueia a inicialização do site e nunca exige login interativo. */
async function recuperarClaudeAposReload() {
  if (String(process.env.TFG_AUTO_RECAPTURE || 'true').toLowerCase() === 'false') return;
  try {
    const atual = await status();
    if (atual.claude.valida === true || !atual.claude.autorizada) return;
    const resultado = await recapturarClaudeDoChrome();
    if (resultado.ok) console.info('[claude-reload] sessão recapturada automaticamente do Chrome.');
    else console.info(`[claude-reload] recaptura ignorada: ${resultado.reason}.`);
  } catch (err) {
    // O site segue de pé. Se o próprio login do Claude expirou, o painel
    // continua mostrando a ação manual como último recurso.
    console.warn('[claude-reload] não foi possível recapturar a sessão:', err.message);
  }
}

async function removerCredencialClaude() {
  const store = await lerJsonSeguro(AUTH_FILE, { profiles: {} });
  if (!store.profiles || typeof store.profiles !== 'object') store.profiles = {};
  if (!store.profiles['claude-web']) return false;
  delete store.profiles['claude-web'];
  await fsp.mkdir(path.dirname(AUTH_FILE), { recursive: true });
  const tempPath = `${AUTH_FILE}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await fsp.rename(tempPath, AUTH_FILE);
  return true;
}

async function limparSessaoClaudeDoChrome() {
  assertCli();
  if (!fs.existsSync(CLEAR_SESSION_SCRIPT)) {
    const err = new Error('Script seguro para troca da conta do Claude não foi encontrado.');
    err.status = 500;
    throw err;
  }

  // Garante que o Chrome isolado/CDP esteja aberto antes de apagar os cookies.
  await executar(BUN_PATH, [ENTRY_FILE, 'chrome', 'start'], {
    cwd: TOOL_DIR,
    timeout: COMMAND_TIMEOUT_MS,
  });
  await executar(BUN_PATH, [CLEAR_SESSION_SCRIPT], {
    cwd: PROJECT_ROOT,
    timeout: COMMAND_TIMEOUT_MS,
    env: { TOKEN_FREE_GATEWAY_SOURCE_DIR: TOOL_DIR },
  });
  await removerCredencialClaude();
}

function iniciarAutorizacao({ trocarConta = false, provider = 'claude' } = {}) {
  const providerKey = provider === 'chatgpt' ? 'chatgpt' : 'claude';
  const providerLabel = providerKey === 'chatgpt' ? 'ChatGPT' : 'Claude';
  assertCli();
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    const err = new Error(
      `Desktop do ${providerLabel} não configurado. Instale o desktop privado e recarregue o PM2 antes de entrar novamente.`
    );
    err.status = 409;
    throw err;
  }
  if (['running', 'waiting_login', 'waiting_browser_login'].includes(authJob.status)) {
    const err = new Error('Já existe uma autorização de IA em andamento.');
    err.status = 409;
    throw err;
  }

  authJob = {
    status: 'running',
    provider: providerKey,
    message: trocarConta
      ? 'Preparando o Chrome para entrar em outra conta…'
      : `Abrindo o Chrome do servidor para autorizar o ${providerLabel}…`,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  // O endpoint responde imediatamente. A tela acompanha este trabalho por polling.
  void (async () => {
    try {
      if (trocarConta && providerKey === 'claude') await limparSessaoClaudeDoChrome();

      // Faz o webauth abrir uma janela nova e aguardar a confirmação manual.
      // Sem isso, um Chrome já aberto tentaria capturar a sessão imediatamente.
      await executar(BUN_PATH, [ENTRY_FILE, 'chrome', 'stop'], {
        cwd: TOOL_DIR,
        timeout: COMMAND_TIMEOUT_MS,
      });

      // Em produção, abre o Chrome no Xvfb antes do webauth. Assim o wizard
      // encontra o CDP pronto, pula a confirmação genérica de terminal e
      // aguarda diretamente o login do Claude no desktop privado.
      if (process.platform === 'linux' && process.env.DISPLAY) {
        authJob = {
          ...authJob,
          message: 'Iniciando o Chrome no desktop privado…',
        };
        await iniciarChromeVisualServidor(
          providerKey === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/new'
        );
      }

      const child = spawn(BUN_PATH, [ENTRY_FILE, 'webauth'], {
        cwd: TOOL_DIR,
        env: process.env,
        windowsHide: true,
        shell: false,
      });
      activeAuthChild = child;
      let buffer = '';
      let detectouPromptInicial = false;
      let detectouPromptProvider = false;
      let enviouProvider = false;
      let concluida = false;

      activeAuthTimer = setTimeout(() => {
        child.kill();
        activeAuthChild = null;
        activeAuthTimer = null;
        authJob = {
          ...authJob,
          status: 'error',
          message: 'O login não foi concluído em 6 minutos. Tente novamente.',
          finishedAt: new Date().toISOString(),
        };
      }, AUTH_TIMEOUT_MS);

      const analisar = (chunk) => {
        buffer = `${buffer}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_CHARS);
        if (!detectouPromptInicial && /Please log in[\s\S]*press Enter to continue/i.test(buffer)) {
          detectouPromptInicial = true;
          authJob = {
            ...authJob,
            status: 'waiting_login',
            message: `Chrome aberto no desktop privado. Entre no ${providerLabel} e depois clique em “Já entrei, concluir”.`,
          };
        }
        const providerPrompt = providerKey === 'chatgpt'
          ? /Please log(?:in| in) to ChatGPT/i
          : /Please log(?:in| in) to Claude/i;
        if (!detectouPromptProvider && providerPrompt.test(buffer)) {
          detectouPromptProvider = true;
          authJob = {
            ...authJob,
            status: 'waiting_browser_login',
            message: `Aguardando o ${providerLabel} confirmar a sessão no Chrome…`,
          };
        }
        if (!enviouProvider && /Enter selection:/i.test(buffer)) {
          const nomeMenu = providerKey === 'chatgpt' ? 'ChatGPT Web' : 'Claude';
          const match = buffer.match(new RegExp(`^\\s*(\\d+)\\.\\s+${nomeMenu}(?:\\s|$)`, 'im'));
          if (!match?.[1]) return;
          enviouProvider = true;
          child.stdin?.write(`${match[1]}\n`);
          authJob = {
            ...authJob,
            status: 'running',
            message: `Capturando a nova sessão do ${providerLabel}…`,
          };
        }
        const sucesso = providerKey === 'chatgpt'
          ? /ChatGPT Web authorization succeeded/i
          : /Claude Web authorization succeeded/i;
        if (sucesso.test(buffer)) concluida = true;
      };

      child.stdout.on('data', analisar);
      child.stderr.on('data', analisar);
      child.on('error', (err) => {
        if (activeAuthTimer) clearTimeout(activeAuthTimer);
        activeAuthTimer = null;
        activeAuthChild = null;
        authJob = {
          ...authJob,
          status: 'error',
          message: `Não foi possível abrir a autorização: ${err.message}`,
          finishedAt: new Date().toISOString(),
        };
      });
      child.on('close', async () => {
        if (activeAuthTimer) clearTimeout(activeAuthTimer);
        activeAuthTimer = null;
        activeAuthChild = null;
        if (!['running', 'waiting_login', 'waiting_browser_login'].includes(authJob.status)) return;
        if (!concluida) {
          authJob = {
            ...authJob,
            status: 'error',
            message: `O ${providerLabel} não confirmou a nova sessão. Abra o Chrome e tente novamente.`,
            finishedAt: new Date().toISOString(),
          };
          return;
        }

        authJob = {
          ...authJob,
          message: 'Sessão salva. Reiniciando o gateway…',
        };
        try {
          await reiniciar();
          authJob = {
            ...authJob,
            status: 'success',
            message: `${providerLabel} autorizado e gateway reiniciado com sucesso.`,
            finishedAt: new Date().toISOString(),
          };
        } catch (err) {
          authJob = {
            ...authJob,
            status: 'error',
            message: `Sessão salva, mas o gateway não reiniciou: ${err.message}`,
            finishedAt: new Date().toISOString(),
          };
        }
      });
    } catch (err) {
      authJob = {
        ...authJob,
        status: 'error',
        message: err.message || 'Falha ao iniciar a autorização.',
        finishedAt: new Date().toISOString(),
      };
    }
  })();

  return authJobPublico();
}

function continuarAutorizacao() {
  if (authJob.status !== 'waiting_login' || !activeAuthChild?.stdin) {
    const err = new Error('Não existe um login de IA aguardando confirmação.');
    err.status = 409;
    throw err;
  }

  authJob = {
    ...authJob,
    status: 'running',
    message: `Confirmando o login e capturando a sessão do ${authJob.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'}…`,
  };
  activeAuthChild.stdin.write('\n');
  return authJobPublico();
}

async function testar() {
  const inicio = Date.now();
  try {
    const { data } = await axios.post(
      `${gatewayClient.BASE_URL}/chat/completions`,
      {
        model: gatewayClient.MODELO,
        messages: [{ role: 'user', content: 'Responda somente com OK.' }],
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.TOKEN_FREE_GATEWAY_API_KEY || 'qualquer-coisa'}`,
          'Content-Type': 'application/json',
        },
        timeout: 45_000,
      }
    );
    const resposta = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!resposta) {
      const err = new Error('O Claude respondeu sem conteúdo.');
      err.status = 502;
      throw err;
    }
    return {
      ok: true,
      message: `Claude respondeu em ${((Date.now() - inicio) / 1000).toFixed(1)}s.`,
      resposta: resposta.slice(0, 80),
    };
  } catch (err) {
    if (err.status) throw err;
    const remoto = String(
      err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        err.message ||
        'erro desconhecido'
    )
      .replace(/\s+/g, ' ')
      .trim();
    const falha = new Error(`Teste do Claude falhou: ${remoto.slice(0, 500)}`);
    falha.status = Number(err?.response?.status) || 502;
    throw falha;
  }
}

/**
 * Vigia do gateway e do Chrome do servidor.
 *
 * Os dois não são processos do PM2: quando o servidor reinicia (mudança de
 * plano, manutenção) ou o desktop virtual cai, eles ficam desligados até
 * alguém abrir /claude e clicar em "Iniciar" — e enquanto isso todo pedido ao
 * ChatGPT/Claude falhava com "Não consegui salvar esta resposta".
 *
 * A cada minuto confere os dois. Desligado em duas conferências seguidas (para
 * não reagir a uma oscilação), religa pelo mesmo caminho do botão
 * "Reiniciar". Nunca mexe durante uma autorização em andamento — ela derruba
 * o Chrome de propósito — e espera 5 min entre tentativas que falharam.
 */
const VIGIA_INTERVALO_MS = 60_000;
const VIGIA_ESPERA_ENTRE_TENTATIVAS_MS = 5 * 60_000;
const vigia = {
  timer: null,
  falhasSeguidas: 0,
  ultimaTentativa: 0,
  religando: null,
  // O mesmo caminho do botão "Reiniciar" do /claude; o gateway novo começa
  // sem a sessão do Claude em memória, então ela é recapturada em seguida.
  async religar() {
    const resultado = await reiniciar();
    await recuperarClaudeAposReload();
    return resultado;
  },
};

function vigiaLigado() {
  return (
    process.platform === 'linux' &&
    String(process.env.TFG_VIGIA || 'true').toLowerCase() !== 'false' &&
    require('./tokenFreeGatewayService').isConfigured() &&
    fs.existsSync(ENTRY_FILE)
  );
}

function autorizacaoEmAndamento() {
  return ['running', 'waiting_login', 'waiting_browser_login'].includes(authJob.status);
}

async function gatewayNoAr() {
  try {
    await require('./tokenFreeGatewayService').verificarSaude({ timeout: 4_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Confere e, se preciso, religa. `imediato`: um pedido real acabou de falhar
 * por conexão recusada — não precisa esperar a segunda conferência.
 */
async function vigiarGateway({ imediato = false, agora = Date.now() } = {}) {
  if (vigia.religando) return vigia.religando;
  if (autorizacaoEmAndamento()) {
    vigia.falhasSeguidas = 0;
    return { ok: true, motivo: 'autorizacao' };
  }
  const [gatewayOk, chromeOk] = await Promise.all([gatewayNoAr(), aguardarChromeCdp(1_500)]);
  if (gatewayOk && chromeOk) {
    vigia.falhasSeguidas = 0;
    return { ok: true };
  }
  vigia.falhasSeguidas += 1;
  if (!imediato && vigia.falhasSeguidas < 2) return { ok: false, motivo: 'confirmando' };
  if (agora - vigia.ultimaTentativa < VIGIA_ESPERA_ENTRE_TENTATIVAS_MS) {
    return { ok: false, motivo: 'aguardando' };
  }
  vigia.ultimaTentativa = agora;
  const fora = [!gatewayOk && 'gateway', !chromeOk && 'Chrome'].filter(Boolean).join(' e ');
  console.warn(`[vigia-gateway] ${fora} fora do ar — religando…`);
  vigia.religando = (async () => {
    try {
      const resultado = await vigia.religar();
      vigia.falhasSeguidas = 0;
      console.info(`[vigia-gateway] ${resultado.message}`);
      return { ok: true, religado: true };
    } catch (err) {
      console.warn(`[vigia-gateway] não consegui religar: ${err.message} (nova tentativa em 5 min)`);
      return { ok: false, motivo: 'falhou', erro: err.message };
    } finally {
      vigia.religando = null;
    }
  })();
  return vigia.religando;
}

function iniciarVigia() {
  if (vigia.timer || !vigiaLigado()) return false;
  vigia.timer = setInterval(() => {
    vigiarGateway().catch((err) => console.warn('[vigia-gateway]', err.message));
  }, VIGIA_INTERVALO_MS);
  vigia.timer.unref?.();
  return true;
}

/** Um pedido falhou porque o gateway recusou a conexão: tenta religar já. */
function religarSeCaiu() {
  if (!vigiaLigado()) return;
  vigiarGateway({ imediato: true }).catch((err) => console.warn('[vigia-gateway]', err.message));
}

module.exports = {
  status,
  iniciar,
  reiniciar,
  iniciarVigia,
  religarSeCaiu,
  vigiarGateway,
  // Só para teste.
  _vigia: vigia,
  iniciarAutorizacao,
  continuarAutorizacao,
  testar,
  recuperarClaudeAposReload,
  // Metadados expostos para teste; nunca incluem cookie/sessionKey.
  paths: { TOOL_DIR, AUTH_FILE, CONFIG_FILE, LOG_FILE },
};
