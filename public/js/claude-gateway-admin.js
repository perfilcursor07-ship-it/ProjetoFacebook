(function () {
  const initialEl = document.getElementById('claude-initial-status');
  if (!initialEl) return;

  const $ = (id) => document.getElementById(id);
  const buttons = Array.from(document.querySelectorAll('[data-action]'));
  const feedback = $('claude-feedback');
  const progress = $('claude-auth-progress');
  const loginDone = $('claude-login-done');
  let busy = false;
  let currentStatus = {};

  try {
    currentStatus = JSON.parse(initialEl.textContent || '{}');
  } catch {
    currentStatus = {};
  }

  const toneClasses = {
    good: ['border-emerald-500/30', 'bg-emerald-500/10', 'text-emerald-300'],
    warn: ['border-amber-500/30', 'bg-amber-500/10', 'text-amber-300'],
    bad: ['border-rose-500/30', 'bg-rose-500/10', 'text-rose-300'],
    neutral: ['border-slate-700', 'bg-slate-800/60', 'text-slate-400'],
  };
  const allToneClasses = Object.values(toneClasses).flat();

  function setBadge(id, label, tone) {
    const el = $(id);
    if (!el) return;
    el.textContent = label;
    el.classList.remove(...allToneClasses);
    el.classList.add(...(toneClasses[tone] || toneClasses.neutral));
  }

  function formatDate(value) {
    if (!value) return 'sem data registrada';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'sem data registrada';
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function setFeedback(message, tone) {
    if (!feedback) return;
    if (!message) {
      feedback.classList.add('hidden');
      return;
    }
    feedback.textContent = message;
    feedback.className = 'mt-4 rounded-lg border px-3 py-2 text-xs';
    feedback.classList.add(...(toneClasses[tone] || toneClasses.neutral));
  }

  function syncButtons() {
    const authStatus = currentStatus?.autorizacao?.status;
    const authActive = ['running', 'waiting_login', 'waiting_browser_login'].includes(authStatus);
    buttons.forEach((button) => {
      const action = button.dataset.action;
      button.disabled = busy || (authActive && action !== 'continue');
    });
    if (loginDone) {
      loginDone.classList.toggle('hidden', authStatus !== 'waiting_login');
      loginDone.disabled = busy || authStatus !== 'waiting_login';
    }
  }

  function render(status) {
    currentStatus = status || {};
    const gateway = currentStatus.gateway || {};
    const chrome = currentStatus.chrome || {};
    const claude = currentStatus.claude || {};
    const chatgpt = currentStatus.chatgpt || {};
    const security = currentStatus.seguranca || {};
    const auth = currentStatus.autorizacao || {};
    const desktop = currentStatus.desktop || {};

    setBadge('gateway-badge', gateway.online ? 'Online' : 'Offline', gateway.online ? 'good' : 'bad');
    $('gateway-title').textContent = gateway.online ? 'Serviço respondendo' : 'Serviço indisponível';
    $('gateway-detail').textContent = gateway.online
      ? `${gateway.url || 'Gateway local'} · ${gateway.status || 'ok'}`
      : gateway.erro || (gateway.cliDisponivel ? 'Pronto para iniciar.' : 'Código-fonte do gateway não encontrado.');

    setBadge('chrome-badge', chrome.conectado ? 'Conectado' : 'Desconectado', chrome.conectado ? 'good' : 'warn');
    $('chrome-title').textContent = chrome.conectado ? 'Navegador disponível' : 'Aguardando navegador';
    $('chrome-detail').textContent = chrome.conectado
      ? `${chrome.cdpUrl || 'CDP local'}${chrome.navegador ? ` · ${chrome.navegador}` : ''}`
      : `${chrome.cdpUrl || 'CDP local não informado'}${chrome.erro ? ` · ${chrome.erro}` : ''}`;

    let claudeTone = 'bad';
    let claudeBadge = 'Não autorizada';
    let claudeTitle = 'Faça o login no Claude';
    if (claude.valida === true) {
      claudeTone = 'good';
      claudeBadge = 'Válida';
      claudeTitle = 'Sessão pronta para uso';
    } else if (claude.valida === false) {
      claudeTone = 'bad';
      claudeBadge = 'Expirada';
      claudeTitle = 'É necessário entrar novamente';
    } else if (claude.autorizada) {
      claudeTone = 'warn';
      claudeBadge = 'Salva';
      claudeTitle = 'Sessão salva, ainda não validada';
    }
    setBadge('claude-badge', claudeBadge, claudeTone);
    $('claude-title').textContent = claudeTitle;
    $('claude-detail').textContent = claude.motivo || `Atualizada em ${formatDate(claude.atualizadaEm)}`;

    let chatgptTone = 'bad';
    let chatgptBadge = 'Não autorizada';
    let chatgptTitle = 'Faça o login no ChatGPT';
    if (chatgpt.valida === true) {
      chatgptTone = 'good';
      chatgptBadge = 'Válida';
      chatgptTitle = 'Sessão pronta para imagens';
    } else if (chatgpt.valida === false) {
      chatgptTone = 'bad';
      chatgptBadge = 'Expirada';
      chatgptTitle = 'É necessário entrar novamente';
    } else if (chatgpt.autorizada) {
      chatgptTone = 'warn';
      chatgptBadge = 'Salva';
      chatgptTitle = 'Sessão salva, ainda não validada';
    }
    setBadge('chatgpt-badge', chatgptBadge, chatgptTone);
    $('chatgpt-title').textContent = chatgptTitle;
    $('chatgpt-detail').textContent = chatgpt.motivo || `Atualizada em ${formatDate(chatgpt.atualizadaEm)}`;

    setBadge('model-badge', claude.modeloDisponivel ? 'Disponível' : 'Indisponível', claude.modeloDisponivel ? 'good' : 'warn');
    $('model-title').textContent = claude.modelo || 'claude-sonnet-5';
    $('model-detail').textContent = claude.modeloDisponivel
      ? 'Modelo listado pelo gateway.'
      : 'Inicie e autorize o gateway para confirmar o modelo.';

    const desktopSection = $('claude-server-desktop');
    desktopSection?.classList.toggle('hidden', !desktop.necessario);
    if (desktop.necessario) {
      setBadge(
        'desktop-badge',
        desktop.online ? 'Online' : desktop.configurado ? 'Offline' : 'Não instalado',
        desktop.online ? 'good' : 'warn'
      );
      if ($('desktop-detail')) {
        $('desktop-detail').textContent = desktop.online
          ? `Desktop privado disponível em 127.0.0.1:${desktop.porta}.`
          : desktop.configurado
            ? 'Inicie os processos claude-xvfb, claude-vnc e claude-novnc no PM2.'
            : 'Execute o instalador do desktop privado e recarregue o PM2.';
      }
      if ($('desktop-ssh-command')) $('desktop-ssh-command').textContent = desktop.comandoSsh || '';
      if ($('desktop-open')) $('desktop-open').href = desktop.urlLocal || '#';
    }

    const authVisible = ['running', 'waiting_login', 'waiting_browser_login', 'success', 'error'].includes(auth.status);
    progress?.classList.toggle('hidden', !authVisible);
    if ($('claude-auth-label')) {
      const providerLabel = auth.provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
      $('claude-auth-label').textContent = auth.status === 'error' ? 'Falha na autorização' : `Autorização do ${providerLabel}`;
    }
    if ($('claude-auth-message')) $('claude-auth-message').textContent = auth.message || '';

    const securityParts = [
      security.credencialForaDoPublico
        ? 'Credencial fora da pasta pública.'
        : 'Atenção: revise o local da credencial.',
      security.apiKeyProtegida
        ? 'Gateway protegido por Bearer token.'
        : 'Gateway sem Bearer token: mantenha a porta 3456 acessível somente localmente.',
    ];
    $('claude-security-status').textContent = securityParts.join(' ');
    syncButtons();
  }

  async function request(path, options) {
    const response = await fetch(`/api/admin/claude-gateway${path}`, {
      method: options?.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Falha HTTP ${response.status}`);
    return data;
  }

  async function refresh(silent) {
    try {
      // Silencioso = polling, que usa o status guardado no servidor.
      const data = await request(silent ? '/status' : '/status?fresco=1');
      render(data);
      if (!silent) setFeedback('Status atualizado.', 'good');
    } catch (err) {
      if (!silent) setFeedback(err.message, 'bad');
    }
  }

  // Depois de uma ação o status precisa vir novo, mas sem sobrescrever a
  // mensagem da ação com "Status atualizado.".
  async function refreshAposAcao() {
    try {
      render(await request('/status?fresco=1'));
    } catch {
      // O próximo polling mostra o estado.
    }
    // Um login recém-iniciado passa a ser acompanhado a cada 4 s.
    agendarPoll();
  }

  async function runAction(action) {
    if (busy) return;
    let path;
    let body;
    let pendingMessage;

    if (action === 'start') {
      path = '/start';
      pendingMessage = 'Iniciando o gateway…';
    } else if (action === 'restart') {
      path = '/restart';
      pendingMessage = 'Reiniciando o gateway…';
    } else if (action === 'test') {
      path = '/test';
      pendingMessage = 'Testando o Sonnet 5…';
    } else if (action === 'authorize') {
      path = '/authorize';
      body = { trocarConta: false, provider: 'claude' };
      pendingMessage = 'Abrindo o Chrome para entrar no Claude…';
    } else if (action === 'authorize-chatgpt') {
      path = '/authorize';
      body = { trocarConta: false, provider: 'chatgpt' };
      pendingMessage = 'Abrindo o Chrome para entrar no ChatGPT…';
    } else if (action === 'switch') {
      const confirmed = window.confirm(
        'Trocar a conta do Claude? Isso apagará somente a sessão do Claude no Chrome isolado e abrirá uma nova tela de login.'
      );
      if (!confirmed) return;
      path = '/authorize';
      body = { trocarConta: true };
      pendingMessage = 'Removendo a sessão atual e abrindo o Chrome…';
    } else if (action === 'continue') {
      path = '/authorize/continue';
      pendingMessage = `Confirmando o login do ${currentStatus?.autorizacao?.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'}…`;
    } else {
      return;
    }

    busy = true;
    syncButtons();
    setFeedback(pendingMessage, 'neutral');
    try {
      const data = await request(path, { method: 'POST', body });
      const answer = data.resposta ? `${data.message} Resposta: ${data.resposta}` : data.message;
      setFeedback(answer || 'Operação iniciada.', 'good');
      await refreshAposAcao();
    } catch (err) {
      setFeedback(err.message, 'bad');
      await refreshAposAcao();
    } finally {
      busy = false;
      syncButtons();
    }
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => runAction(button.dataset.action));
  });
  $('claude-refresh')?.addEventListener('click', () => refresh(false));
  $('desktop-copy')?.addEventListener('click', async () => {
    const command = $('desktop-ssh-command')?.textContent || '';
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setFeedback('Comando do túnel SSH copiado.', 'good');
    } catch {
      setFeedback('Não foi possível copiar automaticamente. Selecione o comando e copie.', 'warn');
    }
  });

  /**
   * Cada consulta faz o Chrome do servidor validar as sessões do Claude e do
   * ChatGPT. A cada 5 s (por aba, mesmo escondida) isso sobrecarregava o
   * servidor. Agora: 60 s com a aba visível, nada com ela escondida, e 4 s só
   * enquanto um login está em andamento (a tela acompanha o passo a passo).
   */
  const POLL_NORMAL_MS = 60000;
  const POLL_LOGIN_MS = 4000;
  let pollTimer = null;

  function loginEmAndamento() {
    return ['running', 'waiting_login', 'waiting_browser_login'].includes(currentStatus?.autorizacao?.status);
  }

  function agendarPoll() {
    window.clearTimeout(pollTimer);
    if (document.hidden) return;
    pollTimer = window.setTimeout(async () => {
      if (!busy) await refresh(true);
      agendarPoll();
    }, loginEmAndamento() ? POLL_LOGIN_MS : POLL_NORMAL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      window.clearTimeout(pollTimer);
      return;
    }
    refresh(true).finally(agendarPoll);
  });

  render(currentStatus);
  agendarPoll();
})();
