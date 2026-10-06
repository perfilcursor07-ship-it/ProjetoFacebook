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

  /**
   * Seleção em lote — nas abas com matéria que ainda pode sair (Rascunhos,
   * Prontas, Erros): publicar agora ou agendar várias de uma vez. Excluir
   * continua só nos Rascunhos.
   */
  (function initBulk() {
    if (!['rascunho', 'pronto', 'erro'].includes(st)) return;
    const selectAll = document.getElementById('mia-select-all');
    const bulkDelete = document.getElementById('mia-bulk-delete');
    const bulkDeleteAll = document.getElementById('mia-bulk-delete-all');
    const bulkPublicar = document.getElementById('mia-bulk-publicar');
    const bulkAgendar = document.getElementById('mia-bulk-agendar');
    const bulkTitulo = document.getElementById('mia-bulk-titulo');
    const selectedCountEl = document.getElementById('mia-selected-count');
    if (!list || !selectAll) return;

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
      if (bulkDelete) bulkDelete.disabled = ids.length === 0;
      if (bulkPublicar) bulkPublicar.disabled = ids.length === 0;
      if (bulkAgendar) bulkAgendar.disabled = ids.length === 0;
      if (bulkTitulo) bulkTitulo.disabled = ids.length === 0;
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

    if (bulkDelete) bulkDelete.addEventListener('click', async () => {
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

    // ------------------------------------- publicar agora / agendar em lote

    const fundo = document.getElementById('mm-lote');
    const el = {
      titulo: document.getElementById('mm-lote-titulo'),
      resumo: document.getElementById('mm-lote-resumo'),
      pagina: document.getElementById('mm-lote-pagina'),
      inicioBloco: document.getElementById('mm-lote-inicio-bloco'),
      inicio: document.getElementById('mm-lote-inicio'),
      intervalo: document.getElementById('mm-lote-intervalo'),
      intervaloRotulo: document.getElementById('mm-lote-intervalo-rotulo'),
      horarios: document.getElementById('mm-lote-horarios'),
      erro: document.getElementById('mm-lote-erro'),
      confirmar: document.getElementById('mm-lote-confirmar'),
    };
    let acaoLote = 'agendar';
    let idsLote = [];
    let paginasCarregadas = false;
    let recarregarAoFecharLote = false;

    const INTERVALOS = {
      agendar: [[15, '15 min'], [30, '30 min'], [60, '1 hora'], [120, '2 horas'], [180, '3 horas'], [360, '6 horas']],
      publicar: [[1, '1 min (uma atrás da outra)'], [5, '5 min'], [15, '15 min'], [30, '30 min']],
    };

    /** "AAAA-MM-DDTHH:mm" no horário de Brasília (Araguaína). */
    function dataLocal(ms) {
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'America/Araguaina',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(ms)).replace(' ', 'T').slice(0, 16);
    }

    /** Converte "AAAA-MM-DDTHH:mm" de Brasília (UTC-3) em milissegundos. */
    function msDeLocal(valor) {
      const t = Date.parse(String(valor || '') + ':00-03:00');
      return Number.isNaN(t) ? NaN : t;
    }

    function rotuloHora(ms) {
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Araguaina',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(ms));
    }

    function tituloDa(id) {
      const row = list.querySelector('.mia-matter-row[data-id="' + id + '"]');
      return row?.querySelector('.mia-matter-title')?.textContent.trim() || 'Matéria #' + id;
    }

    function mostrarErro(texto) {
      el.erro.textContent = texto || '';
      el.erro.hidden = !texto;
    }

    /** Mostra antes de confirmar o horário em que cada matéria vai sair. */
    function desenharHorarios() {
      const passo = Number(el.intervalo.value) || 30;
      const base = acaoLote === 'publicar' ? Date.now() : msDeLocal(el.inicio.value);
      if (Number.isNaN(base)) {
        el.horarios.innerHTML = '';
        return;
      }
      el.horarios.replaceChildren(
        ...idsLote.map((id, i) => {
          const li = document.createElement('li');
          const quando = document.createElement('b');
          quando.textContent = acaoLote === 'publicar' && i === 0 ? 'agora' : rotuloHora(base + i * passo * 60_000);
          const titulo = document.createElement('span');
          titulo.textContent = tituloDa(id);
          li.append(quando, titulo);
          return li;
        })
      );
    }

    async function carregarPaginas() {
      if (paginasCarregadas) return;
      try {
        const res = await fetch('/api/facebook/pages');
        const data = await res.json().catch(() => ({}));
        const paginas = Array.isArray(data.pages) ? data.pages : [];
        el.pagina.replaceChildren();
        if (!paginas.length) {
          el.pagina.append(new Option('Nenhuma página ligada à sua conta', ''));
        } else {
          el.pagina.append(new Option('Página de cada matéria (ou a padrão)', ''));
          for (const p of paginas) {
            el.pagina.append(new Option((p.page_name || 'Página ' + p.id) + (p.is_default ? ' (padrão)' : ''), p.id));
          }
        }
        paginasCarregadas = true;
      } catch {
        el.pagina.replaceChildren(new Option('Não consegui carregar as páginas', ''));
      }
    }

    /** @param {number[]} [ids] já escolhidas (vindas do "Alterar título"); sem isso, as marcadas. */
    async function abrirLote(acao, ids) {
      idsLote = ids && ids.length ? ids : selectedIds();
      if (!idsLote.length) return;
      acaoLote = acao;
      const n = idsLote.length;
      const publicar = acao === 'publicar';
      el.titulo.textContent = publicar ? 'Publicar agora' : 'Agendar';
      el.resumo.textContent = publicar
        ? n + (n === 1 ? ' matéria vai ao ar agora.' : ' matérias: a 1ª vai ao ar agora e as outras em sequência.')
        : n + (n === 1 ? ' matéria será agendada.' : ' matérias serão agendadas, uma depois da outra.');
      el.confirmar.textContent = publicar ? 'Publicar ' + n : 'Agendar ' + n;
      el.inicioBloco.hidden = publicar;
      el.intervaloRotulo.textContent = publicar ? 'Espaço entre uma e outra' : 'Uma a cada';
      el.intervaloRotulo.hidden = n < 2;
      el.intervalo.hidden = n < 2;
      el.intervalo.replaceChildren(...INTERVALOS[acao].map(([v, t]) => new Option(t, v)));
      el.intervalo.value = publicar ? '5' : '30';
      mostrarErro('');

      if (!publicar) {
        // Começa hoje, 15 min depois de agora (horário de Brasília).
        el.inicio.min = dataLocal(Date.now() + 5 * 60_000);
        el.inicio.value = dataLocal(Date.now() + 15 * 60_000);
      }

      fundo.hidden = false;
      desenharHorarios();
      await carregarPaginas();
      (publicar ? el.pagina : el.inicio).focus();
    }

    function fecharLote() {
      fundo.hidden = true;
      // Títulos já foram trocados antes de abrir: recarrega para mostrar as artes novas.
      if (recarregarAoFecharLote) window.location.reload();
    }

    async function confirmarLote() {
      if (acaoLote === 'agendar') {
        const base = msDeLocal(el.inicio.value);
        if (Number.isNaN(base) || base <= Date.now() + 60_000) {
          mostrarErro('Escolha um dia e hora no futuro.');
          return el.inicio.focus();
        }
      }
      if (paginasCarregadas && el.pagina.options.length === 1 && !el.pagina.value) {
        mostrarErro('Conecte uma página do Facebook antes de publicar ou agendar.');
        return;
      }
      el.confirmar.disabled = true;
      const textoBotao = el.confirmar.textContent;
      el.confirmar.textContent = acaoLote === 'publicar' ? 'Enviando…' : 'Agendando…';
      mostrarErro('');
      try {
        const res = await fetch('/api/materias-ia/matters/lote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            acao: acaoLote,
            ids: idsLote,
            facebook_page_id: el.pagina.value || null,
            inicio: acaoLote === 'agendar' ? el.inicio.value : null,
            intervalo_minutos: Number(el.intervalo.value) || 30,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao ' + (acaoLote === 'publicar' ? 'publicar' : 'agendar'));
        const falhas = Array.isArray(data.falhas) ? data.falhas : [];
        if (falhas.length) {
          alert(
            data.feitas + ' de ' + idsLote.length + ' na fila.\n\nFicaram de fora:\n' +
              falhas.map((f) => '• ' + tituloDa(f.id) + ': ' + f.motivo).join('\n')
          );
        }
        // As que entraram na fila agora estão na aba Agendadas.
        window.location.href = data.feitas ? '/minhas-materias?status=agendado' : window.location.href;
      } catch (err) {
        mostrarErro(err.message || 'Erro');
        el.confirmar.disabled = false;
        el.confirmar.textContent = textoBotao;
      }
    }

    if (fundo) {
      bulkPublicar?.addEventListener('click', () => abrirLote('publicar'));
      bulkAgendar?.addEventListener('click', () => abrirLote('agendar'));
      el.inicio.addEventListener('input', desenharHorarios);
      el.intervalo.addEventListener('change', desenharHorarios);
      fundo.addEventListener('click', (e) => {
        if (e.target === fundo || e.target.closest('[data-lote="cancelar"]')) return fecharLote();
        if (e.target.closest('[data-lote="confirmar"]')) confirmarLote();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !fundo.hidden) fecharLote();
      });
    }

    // ------------------------------------------------ alterar título em lote

    (function initTitulos() {
      const caixa = document.getElementById('mm-tit');
      if (!caixa || !bulkTitulo) return;
      const t = {
        resumo: document.getElementById('mm-tit-resumo'),
        passo1: document.getElementById('mm-tit-passo1'),
        passo2: document.getElementById('mm-tit-passo2'),
        blocoTom: document.getElementById('mm-tit-bloco-tom'),
        blocoDigitar: document.getElementById('mm-tit-bloco-digitar'),
        digitar: document.getElementById('mm-tit-digitar'),
        previa: document.getElementById('mm-tit-previa'),
        erro: document.getElementById('mm-tit-erro'),
        gerar: caixa.querySelector('[data-tit="gerar"]'),
        aplicar: Array.from(caixa.querySelectorAll('[data-tit="aplicar"]')),
        voltar: caixa.querySelector('[data-tit="voltar"]'),
        refazer: caixa.querySelector('[data-tit="refazer"]'),
      };
      let ids = [];
      let modo = 'tom';
      let tom = 'polemico';
      let ocupado = false;

      function erro(texto) {
        t.erro.textContent = texto || '';
        t.erro.hidden = !texto;
      }

      function marcar(seletor, attr, valor) {
        caixa.querySelectorAll(seletor).forEach((b) => {
          const on = b.dataset[attr] === valor;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
      }

      function passo(n) {
        t.passo1.hidden = n !== 1;
        t.passo2.hidden = n !== 2;
        t.gerar.hidden = n !== 1;
        t.aplicar.forEach((b) => {
          b.hidden = n !== 2;
        });
        t.voltar.hidden = n !== 2;
        t.refazer.hidden = n !== 2 || modo !== 'tom';
      }

      function trocarModo(novo) {
        modo = novo;
        marcar('.mm-tit-modo', 'modo', modo);
        t.blocoTom.hidden = modo !== 'tom';
        t.blocoDigitar.hidden = modo !== 'corrigir';
        t.gerar.textContent = modo === 'tom' ? 'Gerar títulos' : 'Corrigir português';
      }

      function campoTitulo(valor) {
        const area = document.createElement('textarea');
        area.rows = 2;
        area.maxLength = 300;
        area.value = valor || '';
        return area;
      }

      /** Modo "Eu digito": um campo por matéria, já com o título atual para editar. */
      function desenharDigitar() {
        t.digitar.replaceChildren(
          ...ids.map((id) => {
            const li = document.createElement('li');
            li.className = 'mm-tit-item';
            li.dataset.id = id;
            const antes = document.createElement('div');
            antes.className = 'mm-tit-antes';
            antes.textContent = 'Atual: ' + tituloDa(id);
            li.append(antes, campoTitulo(tituloDa(id)));
            return li;
          })
        );
      }

      /** Prévia: título antigo, novo (editável) e se entra no salvar. */
      function desenharPrevia(itens) {
        t.previa.replaceChildren(
          ...itens.map((it) => {
            const li = document.createElement('li');
            li.className = 'mm-tit-item';
            li.dataset.id = it.id;
            const antes = document.createElement('label');
            antes.className = 'mm-tit-antes';
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.className = 'mm-tit-usar h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-emerald-500';
            check.checked = Boolean(it.titulo) && !it.erro && it.alterado !== false;
            check.disabled = !it.titulo;
            const rotulo = document.createElement('span');
            rotulo.textContent = 'Antes: ' + (it.atual || tituloDa(it.id));
            antes.append(check, rotulo);
            li.append(antes);
            if (it.titulo) li.append(campoTitulo(it.titulo));
            const nota = it.erro || it.aviso || (it.titulo && !it.alterado ? 'Ficou igual ao atual.' : '');
            if (nota) {
              const p = document.createElement('p');
              p.className = 'mm-tit-nota' + (it.erro ? ' is-erro' : '');
              p.textContent = nota;
              li.append(p);
            }
            li.classList.toggle('is-off', !check.checked);
            return li;
          })
        );
        contarAplicar();
      }

      function itensParaAplicar() {
        return Array.from(t.previa.querySelectorAll('.mm-tit-item'))
          .filter((li) => li.querySelector('.mm-tit-usar')?.checked)
          .map((li) => ({ id: Number(li.dataset.id), titulo: li.querySelector('textarea')?.value.trim() || '' }));
      }

      function contarAplicar() {
        const n = itensParaAplicar().length;
        t.aplicar.forEach((b) => {
          b.disabled = n === 0;
        });
        t.aplicar[0].textContent = n === 1 ? 'Só salvar' : 'Só salvar (' + n + ')';
      }

      function travar(botao, texto) {
        ocupado = Boolean(texto);
        caixa.querySelectorAll('.mm-lote-acoes .d-btn').forEach((b) => {
          if (b.dataset.tit !== 'cancelar') b.disabled = ocupado;
        });
        if (texto) {
          botao.dataset.textoAntes = botao.textContent;
          botao.textContent = texto;
        } else if (botao.dataset.textoAntes) {
          botao.textContent = botao.dataset.textoAntes;
        }
      }

      async function postJson(url, body) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha na requisição');
        return data;
      }

      async function gerar(botao) {
        erro('');
        const body = { ids, modo, tom };
        if (modo === 'corrigir') {
          body.titulos = {};
          for (const li of t.digitar.querySelectorAll('.mm-tit-item')) {
            const area = li.querySelector('textarea');
            const texto = area.value.trim();
            if (texto.length < 8) {
              erro('Cada título precisa ter pelo menos 8 caracteres.');
              return area.focus();
            }
            body.titulos[li.dataset.id] = texto;
          }
        }
        travar(botao, modo === 'tom' ? 'Gerando ' + ids.length + '…' : 'Corrigindo…');
        try {
          const data = await postJson('/api/materias-ia/matters/titulos-lote/sugerir', body);
          travar(botao, '');
          const itens = Array.isArray(data.itens) ? data.itens : [];
          // Mesmo erro em todas (IA fora do ar, sem chave…): avisa uma vez e fica no passo atual.
          const erros = new Set(itens.map((it) => it.erro));
          if (itens.length && erros.size === 1 && itens[0].erro) return erro(itens[0].erro);
          desenharPrevia(itens);
          passo(2);
        } catch (err) {
          travar(botao, '');
          erro(err.message || 'Erro ao gerar títulos');
        }
      }

      /** @param {HTMLButtonElement} botao destino: só salvar, ou salvar e abrir agendar/publicar */
      async function aplicar(botao) {
        const destino = botao.dataset.destino || 'salvar';
        const itens = itensParaAplicar();
        if (!itens.length) return;
        if (itens.some((it) => it.titulo.length < 8)) {
          return erro('Algum título ficou vazio ou curto demais.');
        }
        erro('');
        travar(botao, 'Salvando e refazendo artes…');
        try {
          const data = await postJson('/api/materias-ia/matters/titulos-lote/aplicar', { itens, origem: modo });
          const falhas = (data.resultados || []).filter((r) => !r.ok);
          if (falhas.length) {
            alert(
              data.feitas + ' de ' + itens.length + ' títulos salvos.\n\nNão salvaram:\n' +
                falhas.map((f) => '• ' + tituloDa(f.id) + ': ' + f.erro).join('\n')
            );
          }
          const salvas = (data.resultados || []).filter((r) => r.ok);
          if (destino === 'salvar' || !salvas.length) {
            // Recarrega para mostrar títulos e artes novas.
            return window.location.reload();
          }
          // Já mostra o título novo na lista (e na janela de agendar/publicar).
          for (const r of salvas) {
            const el = list.querySelector('.mia-matter-row[data-id="' + r.id + '"] .mia-matter-title');
            if (el && r.titulo) el.textContent = r.titulo;
          }
          travar(botao, '');
          caixa.hidden = true;
          recarregarAoFecharLote = true;
          abrirLote(destino, salvas.map((r) => r.id));
        } catch (err) {
          travar(botao, '');
          contarAplicar();
          erro(err.message || 'Erro ao salvar títulos');
        }
      }

      function abrir() {
        ids = selectedIds();
        if (!ids.length) return;
        t.resumo.textContent =
          ids.length === 1 ? '1 matéria selecionada.' : ids.length + ' matérias selecionadas.';
        erro('');
        desenharDigitar();
        trocarModo(modo);
        passo(1);
        caixa.hidden = false;
      }

      function fechar() {
        if (ocupado && !confirm('A IA ainda está trabalhando. Fechar mesmo assim?')) return;
        caixa.hidden = true;
      }

      bulkTitulo.addEventListener('click', abrir);
      t.previa.addEventListener('input', contarAplicar);
      t.previa.addEventListener('change', (e) => {
        const li = e.target.closest('.mm-tit-item');
        if (li && e.target.classList.contains('mm-tit-usar')) {
          li.classList.toggle('is-off', !e.target.checked);
        }
        contarAplicar();
      });
      caixa.addEventListener('click', (e) => {
        if (e.target === caixa || e.target.closest('[data-tit="cancelar"]')) return fechar();
        if (ocupado) return;
        const modoBtn = e.target.closest('.mm-tit-modo');
        if (modoBtn) return trocarModo(modoBtn.dataset.modo);
        const tomBtn = e.target.closest('.mm-tit-tom');
        if (tomBtn) {
          tom = tomBtn.dataset.tom;
          return marcar('.mm-tit-tom', 'tom', tom);
        }
        if (e.target.closest('[data-tit="gerar"]')) return gerar(t.gerar);
        if (e.target.closest('[data-tit="refazer"]')) return gerar(t.refazer);
        if (e.target.closest('[data-tit="voltar"]')) {
          erro('');
          return passo(1);
        }
        const aplicarBtn = e.target.closest('[data-tit="aplicar"]');
        if (aplicarBtn) aplicar(aplicarBtn);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !caixa.hidden) fechar();
      });
    })();

    syncBulkUi();
  })();
})();
