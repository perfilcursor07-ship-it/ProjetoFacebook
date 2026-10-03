(function initMinhasMaterias() {
  const list = document.getElementById('mia-matters-list');
  if (!list) return;
  const params = new URLSearchParams(window.location.search || '');
  const st = params.get('status') || 'all';

  function formatNum(n) {
    // Number(null) === 0 — não tratar null/undefined/'' como zero
    if (n == null || n === '') return null;
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return null;
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + ' mi';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + ' mil';
    return String(Math.round(v));
  }

  function viralInfo(likes, comments, shares, views) {
    const l = Number(likes) || 0;
    const c = Number(comments) || 0;
    const s = Number(shares) || 0;
    const v = Number(views) || 0;
    const score = l + c * 3 + s * 5 + Math.min(v, 5000) / 50;
    if (score >= 180 || l >= 80 || c >= 25) {
      return { label: 'Viralizou', score, cls: 'bg-rose-500/20 text-rose-200 ring-rose-500/30' };
    }
    if (score >= 80 || l >= 40 || c >= 10) {
      return { label: 'Bom', score, cls: 'bg-amber-500/15 text-amber-200 ring-amber-500/25' };
    }
    if (l > 0 || c > 0 || s > 0 || v > 0) {
      return { label: 'Baixo', score, cls: 'bg-slate-700/40 text-slate-400 ring-slate-600/40' };
    }
    return null;
  }

  function atualizarBadgeViral(row, likes, comments, shares, views) {
    if (!row) return;
    let badge = row.querySelector('.mia-viral-badge');
    const scoreEl = row.querySelector('.mia-viral-score');
    const info = viralInfo(likes, comments, shares, views);
    if (!info) {
      if (badge) badge.remove();
      if (scoreEl) scoreEl.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className =
        'mia-viral-badge shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ring-1';
      const status = row.querySelector('.mia-matter-status');
      if (status && status.parentNode) {
        status.insertAdjacentElement('afterend', badge);
      } else {
        row.querySelector('.min-w-0')?.prepend(badge);
      }
    }
    badge.className =
      'mia-viral-badge shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ring-1 ' +
      info.cls;
    badge.textContent = info.label;
    if (scoreEl) scoreEl.textContent = 'score ' + Math.round(info.score);
  }

  /**
   * Atualiza engajamento de um botão .mia-matter-views.
   * @param {HTMLElement} viewsBtn
   * @param {{ force?: boolean, silent?: boolean }} opts
   */
  async function fetchEngajamento(viewsBtn, { force = false, silent = false } = {}) {
    const id = viewsBtn?.dataset?.id;
    if (!id) return null;

    const likesEl = viewsBtn.querySelector('.mia-likes-label');
    const commentsEl = viewsBtn.querySelector('.mia-comments-label');
    const sharesEl = viewsBtn.querySelector('.mia-shares-label');
    const viewsEl = viewsBtn.querySelector('.mia-views-label');
    const prev = {
      likes: likesEl?.textContent,
      comments: commentsEl?.textContent,
      shares: sharesEl?.textContent,
      views: viewsEl?.textContent,
    };

    if (likesEl) likesEl.textContent = '…';
    if (commentsEl) commentsEl.textContent = '…';
    if (sharesEl) sharesEl.textContent = '…';
    if (viewsEl) viewsEl.textContent = '…';
    viewsBtn.disabled = true;

    try {
      const qs = force ? '?force=1' : '';
      const res = await fetch('/api/materias-ia/matters/' + id + '/views' + qs, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao buscar engajamento');

      const semDado =
        data.likes == null && data.comments == null && data.shares == null && data.views == null;

      if (likesEl) {
        likesEl.textContent =
          data.likes != null
            ? formatNum(data.likes) + ' curtidas'
            : semDado
              ? '— curtidas'
              : prev.likes || 'curtidas';
      }
      if (commentsEl) {
        commentsEl.textContent =
          data.comments != null
            ? formatNum(data.comments) + ' coment.'
            : semDado
              ? '— coment.'
              : prev.comments || 'coment.';
      }
      if (sharesEl) {
        sharesEl.textContent =
          data.shares != null
            ? formatNum(data.shares) + ' compart.'
            : semDado
              ? '— compart.'
              : prev.shares || 'compart.';
      }
      if (viewsEl) {
        viewsEl.textContent =
          data.views != null
            ? formatNum(data.views) + ' views'
            : semDado
              ? '— views'
              : prev.views || 'views';
      }

      const row = viewsBtn.closest('.mia-matter-row');
      atualizarBadgeViral(row, data.likes, data.comments, data.shares, data.views);

      const aviso = Array.isArray(data.avisos) && data.avisos.length ? data.avisos[0] : '';
      if (data.viral?.label) {
        viewsBtn.title =
          data.viral.label +
          (data.fonte ? ' · via ' + data.fonte : '') +
          (data.cached ? ' · em cache' : '') +
          (data.message ? ' — ' + data.message : '') +
          (aviso ? ' — ' + aviso : '');
      } else if (data.message || aviso) {
        viewsBtn.title = data.message || aviso;
      } else if (semDado) {
        viewsBtn.title =
          'Sem engajamento ainda. Confira o Profile Key Ayrshare em /paginas e clique em ↻.';
      }
      return data;
    } catch (err) {
      if (likesEl) likesEl.textContent = prev.likes || 'curtidas';
      if (commentsEl) commentsEl.textContent = prev.comments || 'coment.';
      if (sharesEl) sharesEl.textContent = prev.shares || 'compart.';
      if (viewsEl) viewsEl.textContent = prev.views || 'views';
      if (!silent) alert(err.message || 'Erro ao buscar engajamento');
      return null;
    } finally {
      viewsBtn.disabled = false;
    }
  }

  /** Ao abrir a página: atualiza os itens visíveis com até três chamadas simultâneas. */
  async function autoAtualizarEngajamento() {
    const buttons = Array.from(list.querySelectorAll('.mia-matter-views'));
    if (!buttons.length) return;

    let cursor = 0;
    async function worker() {
      while (cursor < buttons.length) {
        const btn = buttons[cursor++];
        await fetchEngajamento(btn, { force: false, silent: true });
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(3, buttons.length) }, () => worker())
    );
  }

  function closeAllMenus(except) {
    list.querySelectorAll('.mia-matter-actions.is-open').forEach((wrap) => {
      if (except && wrap === except) return;
      wrap.classList.remove('is-open', 'is-up');
      const btn = wrap.querySelector('.mia-matter-menu-btn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleMenu(wrap) {
    const willOpen = !wrap.classList.contains('is-open');
    closeAllMenus();
    if (!willOpen) return;
    wrap.classList.add('is-open');
    const btn = wrap.querySelector('.mia-matter-menu-btn');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    const spaceBelow = window.innerHeight - wrap.getBoundingClientRect().bottom;
    wrap.classList.toggle('is-up', spaceBelow < 180);
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.mia-matter-actions')) closeAllMenus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllMenus();
  });

  list.addEventListener('click', async (e) => {
    const menuBtn = e.target.closest('.mia-matter-menu-btn');
    if (menuBtn) {
      e.preventDefault();
      e.stopPropagation();
      const wrap = menuBtn.closest('.mia-matter-actions');
      if (wrap) toggleMenu(wrap);
      return;
    }

    const removeBtn = e.target.closest('.mia-matter-remove');
    const variacaoBtn = e.target.closest('.mia-matter-variacao');
    const reelBtn = e.target.closest('.mia-matter-reel');
    const viewsBtn = e.target.closest('.mia-matter-views');

    if (reelBtn) {
      e.preventDefault();
      const id = reelBtn.dataset.id;
      const titulo = reelBtn.dataset.titulo || 'esta matéria';
      if (!id) return;
      const regenerar = reelBtn.dataset.hasVideo === '1';
      const msg = regenerar
        ? 'Regenerar o Reel narrado de "' +
          titulo +
          '"?\n\nResumo até 60s + voz + música (sem legenda no vídeo).'
        : 'Gerar Reel narrado de "' +
          titulo +
          '"?\n\nResume a matéria em até 60 segundos (voz + trilha).';
      if (!confirm(msg)) return;

      reelBtn.disabled = true;
      const old = reelBtn.textContent;
      reelBtn.textContent = '…';
      try {
        const res = await fetch('/api/materias-ia/matters/' + id + '/gerar-reel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao gerar Reel');
        const dest =
          data.redirect || (data.matter?.id ? '/materias-ia/' + data.matter.id : null);
        if (dest) {
          window.location.href = dest;
          return;
        }
        alert('Reel gerado.');
        window.location.reload();
      } catch (err) {
        alert(err.message || 'Erro ao gerar Reel');
      } finally {
        reelBtn.disabled = false;
        reelBtn.textContent = old;
      }
      return;
    }

    if (viewsBtn) {
      e.preventDefault();
      await fetchEngajamento(viewsBtn, { force: true, silent: false });
      return;
    }

    if (variacaoBtn) {
      e.preventDefault();
      const id = variacaoBtn.dataset.id;
      const titulo = variacaoBtn.dataset.titulo || 'esta matéria';
      if (!id) return;
      if (
        !confirm(
          'Criar uma NOVA matéria no tema de "' +
            titulo +
            '"?\n\nA IA busca infos novas (Brave) e reescreve sem plagiar o texto atual.'
        )
      ) {
        return;
      }
      variacaoBtn.disabled = true;
      const old = variacaoBtn.textContent;
      variacaoBtn.textContent = '…';
      try {
        const res = await fetch('/api/materias-ia/matters/' + id + '/variacao', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao gerar variação');
        const dest =
          data.redirect || (data.matter?.id ? '/materias-ia/' + data.matter.id : null);
        if (dest) {
          window.location.href = dest;
          return;
        }
        alert('Matéria gerada, mas sem redirecionamento.');
      } catch (err) {
        alert(err.message || 'Erro ao gerar nova matéria');
      } finally {
        variacaoBtn.disabled = false;
        variacaoBtn.textContent = old;
      }
      return;
    }

    if (!removeBtn) return;
    e.preventDefault();
    const id = removeBtn.dataset.id;
    const titulo = removeBtn.dataset.titulo || 'esta matéria';
    if (!id) return;
    if (!confirm('Remover "' + titulo + '"? Essa ação não pode ser desfeita.')) return;

    removeBtn.disabled = true;
    removeBtn.textContent = '…';
    try {
      const res = await fetch('/api/materias-ia/matters/' + id, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao remover');
      window.location.reload();
    } catch (err) {
      removeBtn.disabled = false;
      removeBtn.textContent = '×';
      alert(err.message || 'Erro ao remover');
    }
  });

  // Dispara após o paint — não bloqueia a lista. Ao terminar a página visível,
  // o lote continua por publicações ainda não verificadas para alimentar Viralizou.
  function sincronizarProximoLote() {
    if (st === 'viralizou') return;
    fetch('/api/materias-ia/matters/sincronizar-engajamento', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 20 }),
    }).catch(() => {});
  }

  function iniciarAtualizacao() {
    autoAtualizarEngajamento().finally(() => {
      setTimeout(sincronizarProximoLote, 500);
    });
  }

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      setTimeout(iniciarAtualizacao, 50);
    });
  } else {
    setTimeout(iniciarAtualizacao, 100);
  }

  /** Seleção em lote — só na aba Rascunhos */
  (function initBulkRascunhos() {
    if (st !== 'rascunho') return;
    const selectAll = document.getElementById('mia-select-all');
    const bulkDelete = document.getElementById('mia-bulk-delete');
    const bulkDeleteAll = document.getElementById('mia-bulk-delete-all');
    const selectedCountEl = document.getElementById('mia-selected-count');
    if (!list || !selectAll || !bulkDelete) return;

    function checks() {
      return Array.from(list.querySelectorAll('.mia-matter-check'));
    }

    function selectedIds() {
      return checks()
        .filter((c) => c.checked)
        .map((c) => Number(c.dataset.id || c.value))
        .filter((id) => Number.isInteger(id) && id > 0);
    }

    function syncBulkUi() {
      const all = checks();
      const ids = selectedIds();
      if (selectedCountEl) {
        selectedCountEl.textContent = ids.length + ' selecionada(s)';
      }
      bulkDelete.disabled = ids.length === 0;
      if (all.length) {
        selectAll.checked = ids.length === all.length;
        selectAll.indeterminate = ids.length > 0 && ids.length < all.length;
      } else {
        selectAll.checked = false;
        selectAll.indeterminate = false;
      }
    }

    selectAll.addEventListener('change', () => {
      const on = selectAll.checked;
      checks().forEach((c) => {
        c.checked = on;
      });
      syncBulkUi();
    });

    list.addEventListener('change', (e) => {
      if (e.target && e.target.classList.contains('mia-matter-check')) syncBulkUi();
    });

    async function postExcluir(body) {
      const res = await fetch('/api/materias-ia/matters/excluir-lote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao excluir');
      return data;
    }

    bulkDelete.addEventListener('click', async () => {
      const ids = selectedIds();
      if (!ids.length) return;
      if (
        !confirm(
          'Excluir ' +
            ids.length +
            ' rascunho(s) selecionado(s)?\n\nEssa ação não pode ser desfeita.'
        )
      ) {
        return;
      }
      bulkDelete.disabled = true;
      const old = bulkDelete.textContent;
      bulkDelete.textContent = 'Excluindo…';
      try {
        const data = await postExcluir({ ids });
        if (!data.deleted) {
          alert('Nenhum rascunho foi excluído.');
          bulkDelete.textContent = old;
          syncBulkUi();
          return;
        }
        window.location.reload();
      } catch (err) {
        alert(err.message || 'Erro ao excluir');
        bulkDelete.textContent = old;
        syncBulkUi();
      }
    });

    if (bulkDeleteAll) {
      bulkDeleteAll.addEventListener('click', async () => {
        const total = Number(bulkDeleteAll.dataset.total) || 0;
        if (
          !confirm(
            'Excluir TODOS os ' +
              total +
              ' rascunhos?\n\nInclui as outras páginas. Essa ação não pode ser desfeita.'
          )
        ) {
          return;
        }
        if (!confirm('Confirma mesmo? Todos os rascunhos serão apagados.')) return;
        bulkDeleteAll.disabled = true;
        const old = bulkDeleteAll.textContent;
        bulkDeleteAll.textContent = 'Excluindo…';
        try {
          await postExcluir({ allDrafts: true });
          window.location.href = '/minhas-materias?status=rascunho';
        } catch (err) {
          alert(err.message || 'Erro ao excluir');
          bulkDeleteAll.disabled = false;
          bulkDeleteAll.textContent = old;
        }
      });
    }

    syncBulkUi();
  })();
})();
