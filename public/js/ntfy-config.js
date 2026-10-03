(function () {
  const API = '/api/admin/notificacoes/ntfy';
  const $ = (id) => document.getElementById(id);
  const el = {
    form: $('ntfy-form'),
    estado: $('ntfy-estado'),
    topico: $('ntfy-topico'),
    servidor: $('ntfy-servidor'),
    token: $('ntfy-token'),
    publicada: $('ntfy-publicada'),
    falha: $('ntfy-falha'),
    salvar: $('ntfy-salvar'),
    testar: $('ntfy-testar'),
    gerar: $('ntfy-gerar'),
    copiar: $('ntfy-copiar'),
    msg: $('ntfy-msg'),
  };
  if (!el.form) return;

  let salvo = null;

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Falha na requisição (${res.status})`);
    return data;
  }

  function mensagem(texto, tipo = '') {
    el.msg.textContent = texto || '';
    el.msg.className = `text-sm ${tipo === 'erro' ? 'text-rose-300' : tipo === 'ok' ? 'text-emerald-300' : 'text-slate-400'}`;
  }

  function render(config = {}) {
    salvo = config;
    const ligado = Boolean(config.topico) && (config.publicada || config.falha);
    el.estado.textContent = ligado ? `Ligadas · ${config.topico}` : 'Desligadas';
    el.estado.className = `rounded-full px-2.5 py-1 text-xs font-semibold ${ligado ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/20 text-slate-300'}`;
    el.testar.disabled = !config.topico;
    el.topico.value = config.topico || '';
    el.servidor.value = config.servidor || '';
    el.token.value = '';
    el.token.placeholder = config.token_definido ? '•••••• salvo (deixe vazio para manter)' : 'tk_...';
    el.publicada.checked = config.publicada !== false;
    el.falha.checked = config.falha !== false;
  }

  function topicoAleatorio() {
    const letras = 'abcdefghijkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return `viralizeai-${[...bytes].map((b) => letras[b % letras.length]).join('')}`;
  }

  el.gerar.addEventListener('click', () => {
    if (el.topico.value.trim() && !confirm('Trocar o tópico? O celular precisa assinar o novo nome.')) return;
    el.topico.value = topicoAleatorio();
    mensagem('Tópico gerado. Assine este nome no app e clique em Salvar.');
  });

  el.copiar.addEventListener('click', async () => {
    const valor = el.topico.value.trim();
    if (!valor) return;
    try {
      await navigator.clipboard.writeText(valor);
      mensagem('Tópico copiado.', 'ok');
    } catch {
      el.topico.select();
      mensagem('Selecionei o tópico: copie com Ctrl+C.');
    }
  });

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.salvar.disabled = true;
    mensagem('Salvando...');
    try {
      const data = await api(API, {
        method: 'PUT',
        body: JSON.stringify({
          topico: el.topico.value.trim(),
          servidor: el.servidor.value.trim(),
          token: el.token.value.trim(),
          publicada: el.publicada.checked,
          falha: el.falha.checked,
        }),
      });
      render(data.ntfy || {});
      mensagem(data.ntfy?.topico ? 'Salvo. Agora clique em Enviar teste.' : 'Notificações desligadas.', 'ok');
    } catch (err) {
      mensagem(err.message, 'erro');
    } finally {
      el.salvar.disabled = false;
    }
  });

  el.testar.addEventListener('click', async () => {
    if (salvo && el.topico.value.trim() !== (salvo.topico || '')) {
      mensagem('Salve o tópico antes de testar.', 'erro');
      return;
    }
    el.testar.disabled = true;
    mensagem('Enviando...');
    try {
      await api(`${API}/teste`, { method: 'POST' });
      mensagem('Teste enviado. Chegou no celular?', 'ok');
    } catch (err) {
      mensagem(err.message, 'erro');
    } finally {
      el.testar.disabled = !salvo?.topico;
    }
  });

  api(API)
    .then((data) => render(data.ntfy || {}))
    .catch((err) => mensagem(err.message, 'erro'));
})();
