(function initConteudoLote() {
  const STORAGE_KEY = 'mia_lote_v1';
  const listEl = document.getElementById('lote-list');
  const emptyEl = document.getElementById('lote-empty');
  const progressEl = document.getElementById('lote-progress');
  const hintEl = document.getElementById('lote-hint');
  if (!listEl) return;

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function loadPayload() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!Array.isArray(data?.topicos) || !data.topicos.length) return null;
      return {
        topicos: data.topicos.slice(0, 8),
        tipoPublicacao: data.tipoPublicacao === 'texto' ? 'texto' : 'foto',
        progresso: Array.isArray(data.progresso) ? data.progresso : [],
      };
    } catch {
      return null;
    }
  }

  function persistProgress() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      const base = raw ? JSON.parse(raw) : {};
      base.progresso = items.map((item) => ({
        status: item.status === 'gerando' ? 'pendente' : item.status,
        matterId: item.matterId || null,
        error: item.error || null,
        titulo: item.titulo,
      }));
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(base));
    } catch {
      /* ignore quota */
    }
  }

  const payload = loadPayload();
  if (!payload) {
    emptyEl?.classList.remove('hidden');
    if (progressEl) progressEl.textContent = '';
    return;
  }

  /** @type {{ topico: object, status: string, matterId?: number|null, error?: string|null, titulo?: string }[]} */
  const items = payload.topicos.map((topico, idx) => {
    const prev = payload.progresso[idx] || {};
    const restoredOk = prev.status === 'pronta' && prev.matterId;
    return {
      topico,
      status: restoredOk ? 'pronta' : prev.status === 'erro' ? 'erro' : 'pendente',
      matterId: restoredOk ? prev.matterId : null,
      error: prev.status === 'erro' ? prev.error || 'Erro ao gerar' : null,
      titulo: String(prev.titulo || topico?.titulo || 'Sem título').trim(),
    };
  });

  let authLost = false;

  function counts() {
    const prontas = items.filter((i) => i.status === 'pronta').length;
    const erros = items.filter((i) => i.status === 'erro').length;
    const gerando = items.some((i) => i.status === 'gerando');
    return { prontas, erros, gerando, total: items.length };
  }

  function updateProgress() {
    const { prontas, erros, gerando, total } = counts();
    if (progressEl) progressEl.textContent = `${prontas}/${total} prontas`;
    if (hintEl) {
      if (authLost) {
        hintEl.innerHTML =
          'Sessão expirou. <a class="text-sky-400 hover:underline" href="/login?next=' +
          encodeURIComponent('/materias-ia/lote') +
          '">Entrar de novo</a> para continuar o lote.';
      } else if (gerando) {
        hintEl.textContent = 'Gerando a próxima…';
      } else if (prontas + erros >= total) {
        hintEl.textContent = erros
          ? `${erros} com erro — use Tentar de novo`
          : 'Todas prontas — clique para editar';
      } else {
        hintEl.textContent = 'Você já pode abrir as prontas';
      }
    }
  }

  function statusBadge(item) {
    if (item.status === 'gerando') {
      return `<span class="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-medium text-amber-200">
        <span class="h-2.5 w-2.5 animate-spin rounded-full border border-amber-300/40 border-t-amber-200"></span>
        Gerando…
      </span>`;
    }
    if (item.status === 'pronta') {
      return `<span class="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">Pronta</span>`;
    }
    if (item.status === 'erro') {
      return `<span class="rounded-full bg-rose-500/15 px-2.5 py-0.5 text-[11px] font-medium text-rose-300">Erro</span>`;
    }
    return `<span class="rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] font-medium text-slate-400">Na fila</span>`;
  }

  function render() {
    updateProgress();
    persistProgress();
    listEl.innerHTML = items
      .map((item, idx) => {
        const canOpen = item.status === 'pronta' && item.matterId;
        const title = escapeHtml(item.titulo);
        const inner = `
          <div class="flex min-w-0 flex-1 items-start gap-3">
            <span class="mt-0.5 inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded-lg bg-violet-500/15 px-2 text-xs font-bold text-violet-300">${idx + 1}</span>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-white ${canOpen ? 'group-hover:text-emerald-200' : ''}">${title}</p>
              ${item.error ? `<p class="mt-1 text-xs text-rose-300">${escapeHtml(item.error)}</p>` : ''}
              ${canOpen ? `<p class="mt-1 text-xs text-emerald-400/80">Clique para editar →</p>` : ''}
            </div>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            ${statusBadge(item)}
            ${
              item.status === 'erro' && !authLost
                ? `<button type="button" data-retry="${idx}" class="rounded-lg border border-amber-500/40 px-2.5 py-1 text-[11px] font-medium text-amber-100 hover:bg-amber-500/15">Tentar de novo</button>`
                : ''
            }
          </div>`;

        if (canOpen) {
          return `<a href="/materias-ia/${item.matterId}" class="group flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 transition hover:border-emerald-400/50 hover:bg-emerald-500/10">${inner}</a>`;
        }
        return `<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3" data-lote-idx="${idx}">${inner}</div>`;
      })
      .join('');
  }

  async function gerarItem(idx) {
    const item = items[idx];
    if (!item || item.status === 'pronta' || item.status === 'gerando' || authLost) return;
    item.status = 'gerando';
    item.error = null;
    render();

    try {
      const res = await fetch('/api/materias-ia/gerar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          topico: item.topico,
          tipoPublicacao: payload.tipoPublicacao,
          status: 'rascunho',
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        authLost = true;
        item.status = 'pendente';
        item.error = null;
        render();
        return;
      }

      if (!res.ok) throw new Error(data.error || 'Falha ao gerar matéria');
      const matterId = data.matter?.id;
      if (!matterId) throw new Error('Matéria gerada sem ID');

      item.status = 'pronta';
      item.matterId = matterId;
      if (data.matter?.titulo || data.artigo?.titulo || data.preview?.titulo) {
        item.titulo = String(data.matter?.titulo || data.artigo?.titulo || data.preview?.titulo);
      }
    } catch (err) {
      item.status = 'erro';
      item.error = err.message || 'Erro ao gerar';
    }
    render();
  }

  let queueRunning = false;
  const retryQueue = [];

  async function runQueue() {
    if (queueRunning || authLost) return;
    queueRunning = true;
    try {
      for (let i = 0; i < items.length; i += 1) {
        if (authLost) break;
        if (items[i].status === 'pendente') {
          await gerarItem(i);
        }
      }
      while (!authLost && retryQueue.length) {
        const idx = retryQueue.shift();
        if (items[idx]?.status === 'erro' || items[idx]?.status === 'pendente') {
          items[idx].status = 'pendente';
          await gerarItem(idx);
        }
      }
    } finally {
      queueRunning = false;
      if (!authLost && retryQueue.length) runQueue();
    }
  }

  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-retry]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (authLost) return;
    const idx = Number(btn.dataset.retry);
    if (!Number.isFinite(idx) || !items[idx]) return;
    items[idx].status = 'pendente';
    items[idx].error = null;
    retryQueue.push(idx);
    render();
    runQueue();
  });

  render();
  runQueue();
})();
