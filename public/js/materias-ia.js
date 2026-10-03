(function initMateriasIa() {
  let miaTopicos = [];
  const statusMia = document.getElementById('mia-status');
  const listEl = document.getElementById('mia-topicos');
  const generatingEl = document.getElementById('mia-generating');
  const generatingText = document.getElementById('mia-generating-text');
  // A Página de destino vem da página padrão da conta logada (definida em /paginas).
  if (!statusMia && !listEl) return;

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function limparTextoUi(texto) {
    if (texto != null && typeof texto === 'object') {
      texto = texto.name || texto.title || texto.username || '';
    }
    return String(texto || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?[^>]+>/g, ' ')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function setGenerating(on, message) {
    if (!generatingEl) return;
    if (message && generatingText) generatingText.textContent = message;
    generatingEl.classList.toggle('hidden', !on);
    document.body.style.overflow = on ? 'hidden' : '';
  }

  document.querySelectorAll('.mia-modo-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mia-modo-btn').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('bg-emerald-500', on);
        b.classList.toggle('text-slate-950', on);
        b.classList.toggle('font-semibold', on);
        b.classList.toggle('text-slate-300', !on);
      });
      const modo = btn.dataset.miaModo;
      document.getElementById('mia-buscar')?.classList.toggle('hidden', modo !== 'buscar');
      document.getElementById('mia-alta')?.classList.toggle('hidden', modo !== 'alta');
    });
  });

  document.querySelectorAll('.mia-tag').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('mia-keywords');
      const tag = btn.dataset.tag;
      const cur = input.value.trim();
      input.value = cur ? (cur.includes(tag) ? cur : cur + ', ' + tag) : tag;
    });
  });

  function renderTopicos(alvo, topicos) {
    miaTopicos = topicos;
    const countEl = document.getElementById('mia-topicos-count');
    if (countEl && alvo.id === 'mia-topicos') {
      countEl.textContent = topicos.length ? topicos.length + ' pauta(s)' : '';
    }
    alvo.innerHTML =
      topicos
        .map((t, i) => {
          const titulo = limparTextoUi(t.titulo);
          const resumo = limparTextoUi(t.resumo);
          const fonte = limparTextoUi(t.veiculo || t.fonte || '');
          const engajamento = [
            t.publicadoEmLabel ? 'em ' + t.publicadoEmLabel : '',
            t.idadeDias != null ? t.idadeDias + 'd' : '',
            t.likes != null ? t.likes + ' curtidas' : '',
            t.comments != null ? t.comments + ' comentários' : '',
            t.shares != null ? t.shares + ' shares' : '',
            t.scoreEngajamento != null
              ? 'score ' + t.scoreEngajamento
              : t.score != null
                ? 'score ' + t.score
                : '',
            t.termoTrends ? 'Trends: ' + limparTextoUi(t.termoTrends) : '',
            Array.isArray(t.hashtags) && t.hashtags.length
              ? t.hashtags.slice(0, 5).join(' ')
              : '',
          ]
            .filter(Boolean)
            .join(' · ');
          const meta = [
            fonte,
            t.calor ? 'calor ' + t.calor : '',
            t.contagemFontes ? t.contagemFontes + ' fontes' : '',
            engajamento,
            t.jaPublicado ? 'já usado nesta Página' : '',
          ]
            .filter(Boolean)
            .join(' · ');
          const border = t.jaPublicado ? 'border-amber-500/40 opacity-70' : 'border-slate-800 hover:border-emerald-500/40';
          return `
          <label class="flex gap-3 rounded-xl border ${border} bg-slate-950/50 p-4 cursor-pointer">
            <input type="checkbox" class="mia-check mt-1 accent-emerald-500" data-idx="${i}" ${t.jaPublicado ? 'title="Já usado"' : ''} />
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium text-white">${escapeHtml(titulo)}${t.jaPublicado ? ' <span class="text-amber-300 text-xs font-normal">(já publicado)</span>' : ''}</span>
              <span class="mt-1 block text-xs text-slate-500">${escapeHtml(meta)}</span>
              ${resumo ? `<span class="mt-1 block text-xs text-slate-400">${escapeHtml(resumo.slice(0, 180))}${resumo.length > 180 ? '…' : ''}</span>` : ''}
              ${t.link ? `<a href="${escapeHtml(t.link)}" target="_blank" rel="noopener" class="mt-2 inline-block text-xs text-sky-400 hover:text-sky-300">Abrir fonte →</a>` : ''}
            </span>
          </label>`;
        })
        .join('') ||
      '<p class="rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">Nenhum assunto encontrado. Tente outras palavras-chave.</p>';
  }

  function selecionados() {
    const panel = document.querySelector('.mia-panel:not(.hidden)') || document;
    return [...panel.querySelectorAll('.mia-check:checked')]
      .map((c) => miaTopicos[Number(c.dataset.idx)])
      .filter(Boolean);
  }

  function irParaLote(topicos, statusEl) {
    const tipoEl = document.getElementById('mia-tipo');
    const payload = {
      topicos: topicos.slice(0, 8),
      tipoPublicacao: tipoEl ? tipoEl.value : 'foto',
    };
    try {
      sessionStorage.setItem('mia_lote_v1', JSON.stringify(payload));
    } catch {
      statusEl.textContent = 'Não foi possível abrir o lote neste navegador';
      return;
    }
    statusEl.textContent = `Abrindo lote com ${payload.topicos.length} pauta(s)…`;
    window.location.href = '/materias-ia/lote';
  }

  function abrirMateriaEmNovaAba(url) {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        ctrlKey: true,
        metaKey: true,
      })
    );
  }

  async function gerarSelecionado(statusEl) {
    const sel = selecionados();
    if (!sel.length) {
      statusEl.textContent = 'Marque ao menos 1 assunto na lista';
      return;
    }

    if (sel.length > 1) {
      irParaLote(sel, statusEl);
      return;
    }

    const tipoEl = document.getElementById('mia-tipo');
    setGenerating(
      true,
      'Apurando fontes, escrevendo o texto e montando a arte. Em seguida a matéria abre em nova aba.'
    );
    statusEl.textContent = 'Gerando matéria…';

    try {
      const res = await fetch('/api/materias-ia/gerar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topico: sel[0],
          tipoPublicacao: tipoEl ? tipoEl.value : 'foto',
          status: 'rascunho',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar');

      const matterId = data.matter?.id;
      const editUrl =
        data.redirect || (matterId ? '/materias-ia/' + matterId : null);
      if (!editUrl) throw new Error('Matéria gerada, mas sem ID para abrir');

      setGenerating(false);
      abrirMateriaEmNovaAba(editUrl);
      statusEl.replaceChildren();
      const msg = document.createElement('span');
      msg.textContent = 'Matéria pronta. ';
      statusEl.appendChild(msg);
      const a = document.createElement('a');
      a.href = editUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'text-emerald-400 underline hover:text-emerald-300';
      a.textContent = 'Abrir matéria';
      statusEl.appendChild(a);
      statusEl.appendChild(document.createTextNode(' · você continua em Pautas com IA.'));
    } catch (err) {
      setGenerating(false);
      statusEl.textContent = err.message;
    }
  }

  document.getElementById('mia-btn-buscar')?.addEventListener('click', async () => {
    const palavrasChave = document.getElementById('mia-keywords').value.trim();
    if (!palavrasChave) {
      statusMia.textContent = 'Informe palavras-chave';
      return;
    }
    const onde = document.getElementById('mia-onde').value;
    const periodo = document.getElementById('mia-periodo').value;
    const diasPorPeriodo = { '24h': 1, '3d': 3, '7d': 7, '30d': 30, '90d': 90, '180d': 180 };
    const diasRecentes = diasPorPeriodo[periodo] || 7;
    statusMia.textContent = 'Buscando assuntos…';
    try {
      const res = await fetch('/api/materias-ia/pesquisar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          palavrasChave,
          quantidadePorNicho: Number(document.getElementById('mia-qtd').value || 8),
          diasRecentes,
          periodo,
          incluirRedes: onde === 'tudo',
          somenteRedes: onde === 'redes',
          filtrarPeriodo: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha na busca');
      renderTopicos(listEl, data.topicos || []);
      const usados = (data.topicos || []).filter((t) => t.jaPublicado).length;
      statusMia.textContent =
        (data.topicos || []).length +
        ' assunto(s)' +
        (usados ? ' · ' + usados + ' já usados nesta Página' : '');
    } catch (err) {
      statusMia.textContent = err.message;
    }
  });

  document.getElementById('mia-btn-alta')?.addEventListener('click', async () => {
    const st = document.getElementById('mia-alta-status');
    st.textContent = 'Varrendo radar…';
    try {
      const res = await fetch('/api/materias-ia/em-alta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          palavrasExtras: document.getElementById('mia-alta-extras').value,
          horas: 24,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha no radar');
      renderTopicos(document.getElementById('mia-alta-topicos'), data.topicos || []);
      st.textContent =
        (data.topicos || []).length + ' em alta · analisados ' + (data.totalAnalisado || 0);
    } catch (err) {
      st.textContent = err.message;
    }
  });

  async function analisarRadarFace(force) {
    const st = document.getElementById('mia-radar-status');
    const url = String(document.getElementById('mia-radar-url')?.value || '').trim();
    st.textContent = force
      ? 'Analisando (forçado)…' + (url ? ' Lendo o link + Trends/Apify…' : ' Trends + Facebook via Apify…')
      : url
        ? 'Lendo o link e buscando o que está em alta no tema…'
        : 'Analisando Trends + Facebook via Apify…';
    try {
      const res = await fetch('/api/materias-ia/radar-face', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          palavrasExtras: document.getElementById('mia-radar-extras')?.value || '',
          url,
          force: !!force,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const avisos = (data.avisos || []).join(' ');
        throw new Error((data.error || 'Falha no Radar Face') + (avisos ? ' — ' + avisos : ''));
      }
      renderTopicos(document.getElementById('mia-radar-topicos'), data.topicos || []);
      const origem = data.origemLink;
      const parts = [
        (data.topicos || []).length + ' sinal(is)',
        origem?.tipo === 'post'
          ? 'a partir do post'
          : origem?.tipo === 'pagina'
            ? 'a partir da página'
            : origem
              ? 'a partir do link'
              : '',
        origem?.tema ? 'tema “' + origem.tema + '”' : '',
        data.queryApify ? 'query “' + data.queryApify + '”' : '',
        data.totalPosts != null ? data.totalPosts + ' post(s) FB' : '',
        data.fromCache ? 'cache' : '',
        data.apifyConfigured === false ? 'Apify não configurado' : '',
      ].filter(Boolean);
      const avisos = (data.avisos || []).filter(Boolean);
      st.textContent = parts.join(' · ') + (avisos.length ? ' — ' + avisos.join(' ') : '');
    } catch (err) {
      st.textContent = err.message;
    }
  }

  document.getElementById('mia-btn-radar')?.addEventListener('click', () => analisarRadarFace(false));
  document.getElementById('mia-btn-radar-force')?.addEventListener('click', () => analisarRadarFace(true));
  document.getElementById('mia-btn-preview-radar')?.addEventListener('click', () => {
    const st = document.getElementById('mia-radar-status');
    gerarSelecionado(st || statusMia);
  });

  function limparFormLink({ keepStatus = false } = {}) {
    const urlEl = document.getElementById('mia-link-url');
    const textoEl = document.getElementById('mia-link-texto');
    const imagemEl = document.getElementById('mia-link-imagem');
    const tipoEl = document.getElementById('mia-link-tipo');
    const st = document.getElementById('mia-link-status');
    const details = document.querySelector('#mia-link details');
    if (urlEl) urlEl.value = '';
    if (textoEl) textoEl.value = '';
    if (imagemEl) imagemEl.value = '';
    if (tipoEl) tipoEl.value = 'auto';
    if (details) details.removeAttribute('open');
    if (!keepStatus && st) st.textContent = '';
    urlEl?.focus();
  }

  document.getElementById('mia-btn-link-limpar')?.addEventListener('click', () => {
    limparFormLink();
    setGenerating(false);
  });

  document.getElementById('mia-btn-link')?.addEventListener('click', async () => {
    const st = document.getElementById('mia-link-status');
    const urlEl = document.getElementById('mia-link-url');
    const tipoEl = document.getElementById('mia-link-tipo');
    const url = (urlEl?.value || '').trim();
    if (!url) {
      st.textContent = 'Cole o link da notícia, Facebook ou Instagram';
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      st.textContent = 'O link precisa começar com http:// ou https://';
      return;
    }

    const looksReel =
      /\/reel\//i.test(url) ||
      /\/reels\//i.test(url) ||
      /\/videos\//i.test(url) ||
      /fb\.watch/i.test(url) ||
      /instagram\.com\/(reel|reels|tv)\//i.test(url);

    const looksPhotoPost =
      !looksReel &&
      (/facebook\.com|fb\.com|instagram\.com/i.test(url) &&
        (/\/photo/i.test(url) ||
          /\/photos\//i.test(url) ||
          /[?&]fbid=/i.test(url) ||
          /pfbid/i.test(url) ||
          /\/posts\//i.test(url) ||
          /\/permalink/i.test(url) ||
          /instagram\.com\/p\//i.test(url)));

    let tipo = tipoEl?.value || 'foto';
    if (tipo === 'auto') tipo = looksReel ? 'reel' : 'foto';

    const isReel = tipo === 'reel' || looksReel;

    setGenerating(
      true,
      isReel
        ? 'Baixando o Reel, transcrevendo a fala e gerando a legenda…'
        : looksPhotoPost
          ? 'Extraindo texto e imagem do post, reescrevendo com IA… Depois você pode trocar a foto por outra sugerida.'
          : 'Lendo o link (texto + imagem), montando o furo e reescrevendo. Em seguida você revisa a matéria.'
    );
    st.textContent = isReel
      ? 'Enfileirando Reel (download → fala → matéria → capa)…'
      : looksPhotoPost
        ? 'Lendo post (legenda + foto) e gerando matéria…'
        : 'Extraindo conteúdo do link e gerando matéria…';

    try {
      const textoManual = String(document.getElementById('mia-link-texto')?.value || '').trim();
      const imagemManual = String(document.getElementById('mia-link-imagem')?.value || '').trim();

      const res = await fetch('/api/materias-ia/reescrever-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          tipoPublicacao: tipo,
          status: 'rascunho',
          textoManual: textoManual || undefined,
          imagemManual: imagemManual || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error && /cole a legenda|texto da postagem|bloqueou/i.test(data.error)) {
          document.querySelector('#mia-link details')?.setAttribute('open', '');
        }
        throw new Error(data.error || 'Falha ao processar o link');
      }

      const matterId = data.matter?.id;
      const editUrl =
        data.redirect || (matterId ? '/materias-ia/' + matterId : null);

      setGenerating(false);
      limparFormLink({ keepStatus: true });

      if (editUrl) {
        abrirMateriaEmNovaAba(editUrl);
      }

      st.replaceChildren();
      const msg = document.createElement('span');
      if (data.modo === 'reel') {
        msg.textContent = (data.aviso || 'Reel enfileirado.') + ' ';
      } else {
        if (!matterId) throw new Error('Matéria gerada, mas sem ID para abrir');
        msg.textContent = 'Matéria pronta. ';
      }
      st.appendChild(msg);
      if (editUrl) {
        const a = document.createElement('a');
        a.href = editUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'text-emerald-400 underline hover:text-emerald-300';
        a.textContent = 'Abrir matéria';
        st.appendChild(a);
        st.appendChild(document.createTextNode(' · formulário limpo — cole o próximo link.'));
      } else {
        st.appendChild(document.createTextNode('Formulário limpo — cole o próximo link.'));
      }
    } catch (err) {
      setGenerating(false);
      st.textContent = err.message;
    }
  });

  document.getElementById('mia-link-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('mia-btn-link')?.click();
    }
  });

  document
    .getElementById('mia-btn-preview')
    ?.addEventListener('click', () => gerarSelecionado(statusMia));
  document.getElementById('mia-btn-preview-alta')?.addEventListener('click', () => {
    const st = document.getElementById('mia-alta-status');
    gerarSelecionado(st || statusMia);
  });

  document.getElementById('mia-btn-lote')?.addEventListener('click', () => {
    const sel = selecionados();
    if (!sel.length) {
      statusMia.textContent = 'Marque ao menos 1 assunto';
      return;
    }
    if (sel.length === 1) {
      gerarSelecionado(statusMia);
      return;
    }
    irParaLote(sel, statusMia);
  });

  async function loadMonitores() {
    const box = document.getElementById('mia-monitores');
    try {
      const res = await fetch('/api/materias-ia/monitor');
      const data = await res.json();
      const list = data.monitores || [];
      box.innerHTML =
        list
          .map(
            (m) => `
            <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-sm">
              <div>
                <div class="font-medium text-white">${escapeHtml(m.palavras_chave)}</div>
                <div class="text-xs text-slate-500">a cada ${m.intervalo_minutos} min · ${m.posts_por_ciclo}/ciclo · ${m.ativo ? 'ativo' : 'pausado'} · publicados ${m.total_publicados || 0}</div>
                ${m.ultimo_erro ? `<div class="text-xs text-rose-300">${escapeHtml(m.ultimo_erro)}</div>` : ''}
              </div>
              <button type="button" class="mia-mon-toggle rounded border border-slate-600 px-3 py-1 text-xs text-slate-300" data-id="${m.id}" data-ativo="${m.ativo ? '1' : '0'}">${m.ativo ? 'Pausar' : 'Retomar'}</button>
            </div>`
          )
          .join('') || '<p class="text-sm text-slate-400">Nenhuma automação ainda.</p>';
    } catch (err) {
      box.innerHTML = `<p class="text-sm text-rose-300">${escapeHtml(err.message)}</p>`;
    }
  }

  document.getElementById('mia-btn-auto')?.addEventListener('click', async () => {
    const st = document.getElementById('mia-auto-status');
    st.textContent = 'Criando…';
    try {
      const res = await fetch('/api/materias-ia/monitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          palavrasChave: document.getElementById('mia-auto-kw').value,
          intervaloMinutos: Number(document.getElementById('mia-auto-intervalo').value || 30),
          postsPorCiclo: Number(document.getElementById('mia-auto-qtd').value || 1),
          tipoPublicacao: document.getElementById('mia-auto-tipo').value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha');
      st.textContent = 'Automação criada ✓';
      loadMonitores();
    } catch (err) {
      st.textContent = err.message;
    }
  });

  const manualPesquisarEl = document.getElementById('mia-manual-pesquisar');
  const manualCamposEl = document.getElementById('mia-manual-pesquisa-campos');

  function toggleCamposPesquisaManual() {
    if (!manualCamposEl) return;
    manualCamposEl.classList.toggle('hidden', !manualPesquisarEl?.checked);
  }
  manualPesquisarEl?.addEventListener('change', toggleCamposPesquisaManual);
  toggleCamposPesquisaManual();

  function renderFontesManual(pesquisa) {
    const box = document.getElementById('mia-manual-fontes');
    if (!box) return;
    box.replaceChildren();
    const fontes = pesquisa?.fontes || [];
    if (!fontes.length) {
      box.classList.add('hidden');
      return;
    }
    const titulo = document.createElement('p');
    titulo.className = 'font-semibold text-emerald-300';
    titulo.textContent = 'Fontes usadas na pesquisa';
    box.appendChild(titulo);

    const lista = document.createElement('ul');
    lista.className = 'mt-2 space-y-1';
    for (const f of fontes) {
      const li = document.createElement('li');
      const nome = f.veiculo || 'Web';
      if (f.url) {
        const a = document.createElement('a');
        a.href = f.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'text-emerald-400 underline hover:text-emerald-300';
        a.textContent = nome;
        li.appendChild(a);
        li.appendChild(document.createTextNode(' — ' + (f.titulo || '')));
      } else {
        li.textContent = nome + ' — ' + (f.titulo || '');
      }
      lista.appendChild(li);
    }
    box.appendChild(lista);
    box.classList.remove('hidden');
  }

  document.getElementById('mia-btn-manual')?.addEventListener('click', async () => {
    const st = document.getElementById('mia-manual-status');
    const info = String(document.getElementById('mia-manual-info')?.value || '').trim();
    if (info.length < 20) {
      st.textContent = 'Descreva as informações da matéria (mín. ~20 caracteres)';
      return;
    }

    const pesquisar = Boolean(manualPesquisarEl?.checked);
    const fd = new FormData();
    fd.append('informacoes', info);
    fd.append('pesquisarWeb', pesquisar ? '1' : '0');
    if (pesquisar) {
      const kw = String(document.getElementById('mia-manual-keywords')?.value || '').trim();
      if (kw) fd.append('palavrasChave', kw);
      fd.append('periodo', document.getElementById('mia-manual-periodo')?.value || '30d');
    }
    const tom = String(document.getElementById('mia-manual-tom')?.value || 'natural').trim();
    if (tom) fd.append('tom', tom);
    const angulo = String(document.getElementById('mia-manual-angulo')?.value || '').trim();
    if (angulo) fd.append('angulo', angulo);
    const credito = String(document.getElementById('mia-manual-credito')?.value || '').trim();
    if (credito) fd.append('creditoImagem', credito);
    const imagemUrl = String(document.getElementById('mia-manual-imagem-url')?.value || '').trim();
    if (imagemUrl) fd.append('imagemUrl', imagemUrl);
    const file = document.getElementById('mia-manual-file')?.files?.[0];
    if (file) fd.append('imagem', file);

    setGenerating(
      true,
      pesquisar
        ? 'Pesquisando na internet, lendo as reportagens e escrevendo a matéria…'
        : file || imagemUrl
          ? 'Escrevendo título e matéria e montando a capa com a Minha marca…'
          : 'Escrevendo título e matéria com as informações que você passou…'
    );
    st.textContent = pesquisar ? 'Pesquisando na web e gerando matéria…' : 'Gerando matéria…';
    document.getElementById('mia-manual-fontes')?.classList.add('hidden');

    try {
      const res = await fetch('/api/materias-ia/gerar-manual', {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar');

      const matterId = data.matter?.id;
      const dest =
        data.redirect || (matterId ? '/materias-ia/' + matterId : null);
      if (!dest) throw new Error('Matéria gerada, mas sem ID para abrir');

      setGenerating(false);
      // Abre a matéria em nova aba e permanece em Pautas com IA.
      abrirMateriaEmNovaAba(dest);
      renderFontesManual(data.pesquisa);
      st.replaceChildren();
      const nFontes = data.pesquisa?.fontes?.length || 0;
      const msg = document.createElement('span');
      msg.textContent = nFontes
        ? 'Matéria pronta com ' + nFontes + ' fonte(s) da web. '
        : 'Matéria pronta. ';
      st.appendChild(msg);
      const a = document.createElement('a');
      a.href = dest;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'text-emerald-400 underline hover:text-emerald-300';
      a.textContent = 'Abrir matéria';
      st.appendChild(a);
      st.appendChild(document.createTextNode(' · você continua em Pautas com IA.'));
      const avisos = (data.avisos || []).filter(Boolean);
      if (avisos.length) {
        const p = document.createElement('span');
        p.className = 'block text-xs text-amber-300';
        p.textContent = avisos.join(' ');
        st.appendChild(p);
      }
    } catch (err) {
      setGenerating(false);
      st.textContent = err.message;
    }
  });

  document.getElementById('mia-monitores')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.mia-mon-toggle');
    if (!btn) return;
    const ativo = btn.dataset.ativo === '1';
    const url = '/api/materias-ia/monitor/' + btn.dataset.id + (ativo ? '/pausar' : '/retomar');
    await fetch(url, { method: 'POST' });
    loadMonitores();
  });

  let miaLinksCache = [];

  function rotuloTipoLink(tipo) {
    const map = {
      pagina: 'página',
      post: 'post',
      reel: 'reel',
      noticia: 'notícia',
      outro: 'link',
    };
    return map[tipo] || 'link';
  }

  function renderLinksSalvos() {
    const lists = document.querySelectorAll('.mia-links-list');
    lists.forEach((list) => {
      if (!miaLinksCache.length) {
        list.innerHTML =
          '<p class="px-1 py-2 text-xs text-slate-500">Nenhum link salvo ainda. Cole um URL e clique em “Salvar link na lista”.</p>';
        return;
      }
      list.innerHTML = miaLinksCache
        .map((l) => {
          const nome = escapeHtml(l.nome || 'Link');
          const tipo = escapeHtml(rotuloTipoLink(l.tipo));
          const url = escapeHtml(l.url || '');
          return `
          <div class="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-2 py-1.5 hover:border-emerald-500/30">
            <button type="button" class="mia-link-pick min-w-0 flex-1 text-left" data-url="${url}" title="${url}">
              <span class="block truncate text-xs font-medium text-slate-100">${nome}</span>
              <span class="block truncate text-[10px] text-slate-500">${tipo} · ${url}</span>
            </button>
            <button type="button" class="mia-link-del shrink-0 rounded px-1.5 py-0.5 text-[10px] text-rose-300 hover:bg-rose-500/10" data-id="${l.id}" title="Remover">✕</button>
          </div>`;
        })
        .join('');
    });
  }

  async function loadLinksSalvos() {
    try {
      const res = await fetch('/api/materias-ia/links');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao carregar links');
      miaLinksCache = data.links || [];
      renderLinksSalvos();
    } catch (err) {
      document.querySelectorAll('.mia-links-list').forEach((list) => {
        list.innerHTML = `<p class="px-1 py-2 text-xs text-rose-300">${escapeHtml(err.message)}</p>`;
      });
    }
  }

  async function salvarLinkAtual({ urlEl, nomeEl, statusEl }) {
    const url = String(urlEl?.value || '').trim();
    if (!url) {
      if (statusEl) statusEl.textContent = 'Cole o link no campo acima antes de salvar.';
      return;
    }
    try {
      const res = await fetch('/api/materias-ia/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          nome: String(nomeEl?.value || '').trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível salvar');
      if (nomeEl) nomeEl.value = '';
      if (statusEl) statusEl.textContent = 'Link salvo: ' + (data.link?.nome || url);
      await loadLinksSalvos();
    } catch (err) {
      if (statusEl) statusEl.textContent = err.message;
    }
  }

  document.getElementById('mia-btn-radar-salvar-link')?.addEventListener('click', () => {
    salvarLinkAtual({
      urlEl: document.getElementById('mia-radar-url'),
      nomeEl: document.getElementById('mia-radar-link-nome'),
      statusEl: document.getElementById('mia-radar-status'),
    });
  });

  document.getElementById('mia-btn-link-salvar-link')?.addEventListener('click', () => {
    salvarLinkAtual({
      urlEl: document.getElementById('mia-link-url'),
      nomeEl: document.getElementById('mia-link-save-nome'),
      statusEl: document.getElementById('mia-link-status'),
    });
  });

  document.querySelectorAll('.mia-btn-refresh-links').forEach((btn) => {
    btn.addEventListener('click', () => loadLinksSalvos());
  });

  document.querySelectorAll('.mia-links-list').forEach((list) => {
    list.addEventListener('click', async (e) => {
      const pick = e.target.closest('.mia-link-pick');
      if (pick) {
        const targetId = list.dataset.target;
        const input = targetId ? document.getElementById(targetId) : null;
        if (input) {
          input.value = pick.dataset.url || '';
          input.focus();
        }
        return;
      }
      const del = e.target.closest('.mia-link-del');
      if (!del) return;
      const id = del.dataset.id;
      if (!id || !confirm('Remover este link da lista?')) return;
      try {
        const res = await fetch('/api/materias-ia/links/' + id, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao remover');
        await loadLinksSalvos();
      } catch (err) {
        alert(err.message);
      }
    });
  });
})();
