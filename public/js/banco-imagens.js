/**
 * Minhas imagens — banco de fotos limpas (sem título nem marca) para usar
 * como capa sem gerar de novo. Usado no /materia-manual e no rascunho.
 *
 *   BancoImagens.abrir({ onEscolher })        → janela com todas as imagens
 *   BancoImagens.grade(el, { onEscolher })    → grade compacta (últimas)
 *
 * `onEscolher(item)` recebe { id, url, miniatura, origem, titulo, credito }.
 * Envio por botão, arrastar e soltar ou Ctrl+V (colar a imagem copiada do
 * ChatGPT/Grok).
 */
(function () {
  const API = '/api/banco-imagens';
  const ORIGENS = [
    ['', 'Todas'],
    ['ia', 'Geradas com IA'],
    ['upload', 'Enviadas'],
    ['sistema', 'Usadas em matérias'],
  ];
  const ROTULO_ORIGEM = {
    ia: 'IA',
    chatgpt: 'ChatGPT',
    grok: 'Grok',
    upload: 'Enviada',
    sistema: 'Matéria',
  };
  let importouSistema = false;

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: {
        Accept: 'application/json',
        ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Não foi possível concluir.');
    return data;
  }

  function h(tag, attrs = {}, ...filhos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const f of filhos.flat()) if (f != null) el.append(f);
    return el;
  }

  const ICONES = {
    fechar: '<path d="M18 6 6 18M6 6l12 12"/>',
    enviar: '<path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    lixo: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    importar: '<path d="M12 4v12m-5-5 5 5 5-5"/><path d="M4 20h16"/>',
    busca: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    imagens: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/><path d="m3 15 4-4 4 4 2-2 4 4"/>',
  };
  function icone(nome) {
    const span = document.createElement('span');
    span.className = 'bi-ico';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONES[nome]}</svg>`;
    return span;
  }

  function dataCurta(valor) {
    const d = new Date(valor);
    return Number.isNaN(d.getTime())
      ? 'Sem título'
      : `Adicionada em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })}`;
  }

  function cartao(item, { onEscolher, onRemover, compacto = false }) {
    const usar = h('button', {
      type: 'button',
      class: 'bi-card-usar',
      title: item.titulo ? `Usar: ${item.titulo}` : 'Usar esta imagem na capa',
      onclick: () => onEscolher?.(item),
    });
    const img = h('img', { src: item.miniatura, alt: item.titulo || 'Imagem do banco', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => card.remove(), { once: true });
    usar.append(img, h('span', { class: `bi-badge bi-badge--${item.origem}`, text: ROTULO_ORIGEM[item.origem] || item.origem }));
    if (!compacto) {
      usar.append(h('span', { class: 'bi-card-hover', text: 'Usar na capa' }));
    }
    const card = h('div', { class: 'bi-card' }, usar);
    if (!compacto) {
      const legenda = h('p', { class: 'bi-card-legenda', text: item.titulo || dataCurta(item.criadaEm) });
      if (item.usos) legenda.append(h('small', { text: ` · usada ${item.usos}×` }));
      const apagar = h('button', {
        type: 'button',
        class: 'bi-card-apagar',
        title: 'Apagar do banco',
        'aria-label': 'Apagar imagem do banco',
        onclick: async (e) => {
          e.stopPropagation();
          if (!window.confirm('Apagar esta imagem do seu banco? As matérias que já usam a imagem não mudam.')) return;
          apagar.disabled = true;
          try {
            await api(`${API}/${item.id}`, { method: 'DELETE' });
            card.remove();
            onRemover?.(item);
          } catch (err) {
            apagar.disabled = false;
            window.alert(err.message);
          }
        },
      }, icone('lixo'));
      card.append(legenda, apagar);
    }
    return card;
  }

  async function enviarArquivos(arquivos) {
    const lista = [...(arquivos || [])].filter((f) => /^image\/(png|jpe?g|webp)$/i.test(f.type));
    if (!lista.length) throw new Error('Escolha imagens PNG, JPG ou WebP.');
    const form = new FormData();
    lista.slice(0, 30).forEach((f, i) => form.append('imagens', f, f.name || `colada-${i + 1}.png`));
    return api(`${API}/upload`, { method: 'POST', body: form });
  }

  function marcarUso(item) {
    api(`${API}/usar`, { method: 'POST', body: JSON.stringify({ url: item.url }) }).catch(() => {});
  }

  /** Janela completa: filtros, busca, envio, importação e grade paginada. */
  function abrir({ onEscolher, titulo = 'Minhas imagens' } = {}) {
    const anterior = document.activeElement;
    let origem = '';
    let pagina = 1;
    let busca = '';
    let carregando = false;

    const status = h('p', { class: 'bi-status', 'aria-live': 'polite' });
    const grade = h('div', { class: 'bi-grade' });
    const mais = h('button', { type: 'button', class: 'bi-btn bi-btn--ghost bi-mais', hidden: true, text: 'Carregar mais' });
    const filtros = h('div', { class: 'bi-filtros', role: 'tablist', 'aria-label': 'Origem das imagens' });
    const botoesFiltro = ORIGENS.map(([valor, rotulo]) => {
      const b = h('button', {
        type: 'button',
        role: 'tab',
        class: 'bi-filtro',
        'aria-selected': valor === origem ? 'true' : 'false',
        'data-origem': valor,
        onclick: () => {
          origem = valor;
          botoesFiltro.forEach((x) => x.setAttribute('aria-selected', x === b ? 'true' : 'false'));
          carregar(true);
        },
      }, h('span', { text: rotulo }), h('small', { class: 'bi-filtro-n' }));
      filtros.append(b);
      return b;
    });

    const campoBusca = h('input', { type: 'search', placeholder: 'Buscar pelo assunto…', 'aria-label': 'Buscar imagens', maxlength: '80' });
    let timerBusca = null;
    campoBusca.addEventListener('input', () => {
      clearTimeout(timerBusca);
      timerBusca = setTimeout(() => {
        busca = campoBusca.value.trim();
        carregar(true);
      }, 300);
    });

    const arquivo = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, class: 'bi-sr' });
    const botaoEnviar = h('button', { type: 'button', class: 'bi-btn bi-btn--primary', onclick: () => arquivo.click() }, icone('enviar'), 'Enviar imagens');
    arquivo.addEventListener('change', () => {
      enviar(arquivo.files);
      arquivo.value = '';
    });

    const menuImportar = h('details', { class: 'bi-menu' });
    const itemMenu = (rotulo, dica, acao) =>
      h('button', { type: 'button', role: 'menuitem', onclick: () => { menuImportar.open = false; acao(); } },
        h('strong', { text: rotulo }), h('small', { text: dica }));
    menuImportar.append(
      h('summary', { class: 'bi-btn bi-btn--ghost' }, icone('importar'), 'Importar'),
      h('div', { class: 'bi-menu-lista', role: 'menu' },
        itemMenu('Da biblioteca do ChatGPT', 'Imagens já criadas na conta conectada em /claude', () => importar('chatgpt')),
        itemMenu('Do Grok', 'Imagens salvas na conta do Grok conectada em /claude', () => importar('grok')),
        itemMenu('Imagens antigas do sistema', 'Fotos limpas que já viraram capa por aqui', () => importarSistema(true)),
      )
    );

    const fechar = () => {
      document.removeEventListener('keydown', teclas);
      document.removeEventListener('paste', colar);
      fundo.remove();
      document.body.style.overflow = overflowAntes;
      anterior?.focus?.();
    };
    const janela = h('div', { class: 'bi-janela', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bi-titulo' },
      h('header', { class: 'bi-topo' },
        h('div', {},
          h('h2', { id: 'bi-titulo', text: titulo }),
          h('p', { text: 'Imagens limpas, sem título nem marca — geradas com IA, enviadas por você ou importadas. Clique para usar como capa.' })
        ),
        h('button', { type: 'button', class: 'bi-fechar', 'aria-label': 'Fechar', onclick: fechar }, icone('fechar'))
      ),
      h('div', { class: 'bi-barra' },
        h('label', { class: 'bi-busca' }, icone('busca'), campoBusca),
        h('div', { class: 'bi-barra-acoes' }, menuImportar, botaoEnviar, arquivo)
      ),
      filtros,
      h('div', { class: 'bi-corpo' }, grade, mais, status),
      h('p', { class: 'bi-dica', text: 'Dica: arraste imagens para cá ou copie a imagem no ChatGPT/Grok e cole aqui com Ctrl+V.' })
    );
    const fundo = h('div', { class: 'bi-fundo', onclick: (e) => { if (e.target === fundo) fechar(); } }, janela);

    // Arrastar e soltar em qualquer ponto da janela.
    janela.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      janela.classList.add('is-soltando');
    });
    janela.addEventListener('dragleave', (e) => {
      if (!janela.contains(e.relatedTarget)) janela.classList.remove('is-soltando');
    });
    janela.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      janela.classList.remove('is-soltando');
      enviar(e.dataTransfer.files);
    });
    function colar(e) {
      const imagens = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!imagens.length) return;
      e.preventDefault();
      enviar(imagens);
    }
    function teclas(e) {
      if (e.key === 'Escape' && !menuImportar.open) fechar();
    }

    function setStatus(texto, tom = '') {
      status.textContent = texto || '';
      status.dataset.tom = tom;
    }

    function escolher(item) {
      marcarUso(item);
      fechar();
      onEscolher?.(item);
    }

    function atualizarContagem(contagem = {}) {
      const total = Object.values(contagem).reduce((a, b) => a + b, 0);
      const ia = (contagem.ia || 0) + (contagem.chatgpt || 0) + (contagem.grok || 0);
      const valores = { '': total, ia, upload: contagem.upload || 0, sistema: contagem.sistema || 0 };
      botoesFiltro.forEach((b) => {
        const n = valores[b.dataset.origem] || 0;
        b.querySelector('.bi-filtro-n').textContent = n ? String(n) : '';
      });
      return total;
    }

    async function carregar(reiniciar = false) {
      if (carregando) return;
      carregando = true;
      if (reiniciar) {
        pagina = 1;
        grade.replaceChildren(...Array.from({ length: 8 }, () => h('div', { class: 'bi-card bi-card--esqueleto' })));
      }
      mais.hidden = true;
      setStatus(reiniciar ? '' : 'Carregando…');
      try {
        const qs = new URLSearchParams({ pagina: String(pagina), limite: '48' });
        if (origem) qs.set('origem', origem);
        if (busca) qs.set('q', busca);
        const data = await api(`${API}?${qs}`);
        if (reiniciar) grade.replaceChildren();
        const total = atualizarContagem(data.contagem);
        // Primeira vez com o banco vazio: traz as imagens que o sistema já tinha.
        if (!total && !importouSistema && !origem && !busca) {
          carregando = false;
          await importarSistema(false);
          return;
        }
        for (const item of data.itens || []) grade.append(cartao(item, { onEscolher: escolher, onRemover: () => carregar(true) }));
        mais.hidden = !data.temMais;
        if (!grade.children.length) {
          grade.append(h('div', { class: 'bi-vazio' },
            icone('imagens'),
            h('strong', { text: busca || origem ? 'Nenhuma imagem neste filtro.' : 'Seu banco ainda está vazio.' }),
            h('span', { text: 'As capas geradas com IA entram aqui sozinhas. Você também pode enviar, arrastar ou colar imagens.' })
          ));
        }
        setStatus('');
      } catch (err) {
        if (reiniciar) grade.replaceChildren();
        setStatus(err.message, 'erro');
      } finally {
        carregando = false;
      }
    }

    async function enviar(arquivos) {
      setStatus('Enviando…');
      botaoEnviar.disabled = true;
      try {
        const data = await enviarArquivos(arquivos);
        const n = data.itens?.length || 0;
        setStatus(`${n} imagem${n === 1 ? '' : 'ns'} no banco ✓${data.erros?.length ? ` · ${data.erros.length} recusada(s)` : ''}`, 'ok');
        origem = '';
        botoesFiltro.forEach((b) => b.setAttribute('aria-selected', b.dataset.origem === '' ? 'true' : 'false'));
        await carregar(true);
      } catch (err) {
        setStatus(err.message, 'erro');
      } finally {
        botaoEnviar.disabled = false;
      }
    }

    async function importarSistema(manual) {
      importouSistema = true;
      setStatus('Procurando imagens que o sistema já tinha…');
      try {
        const r = await api(`${API}/importar-sistema`, { method: 'POST' });
        setStatus(
          r.importadas
            ? `${r.importadas} imagem(ns) antigas adicionadas ✓`
            : manual ? 'Nenhuma imagem antiga nova para adicionar.' : '',
          r.importadas ? 'ok' : ''
        );
      } catch (err) {
        setStatus(err.message, 'erro');
      }
      await carregar(true);
    }

    async function importar(gerador) {
      const nome = gerador === 'grok' ? 'Grok' : 'ChatGPT';
      setStatus(`Abrindo a conta do ${nome} no Chrome do servidor e copiando as imagens… (até 1 minuto)`);
      menuImportar.querySelector('summary').classList.add('is-ocupado');
      try {
        const r = await api(`${API}/importar/${gerador}`, { method: 'POST', body: JSON.stringify({ limite: 30 }) });
        setStatus(`${nome}: ${r.importadas} nova(s), ${r.repetidas} já estavam no banco${r.falhas ? `, ${r.falhas} falharam` : ''}.`, 'ok');
        await carregar(true);
      } catch (err) {
        setStatus(err.message, 'erro');
      } finally {
        menuImportar.querySelector('summary').classList.remove('is-ocupado');
      }
    }

    mais.addEventListener('click', () => {
      pagina += 1;
      carregar(false);
    });

    const overflowAntes = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.append(fundo);
    document.addEventListener('keydown', teclas);
    document.addEventListener('paste', colar);
    campoBusca.focus();
    carregar(true);
    return { fechar };
  }

  /**
   * Grade compacta (as imagens mais recentes) com um bloco "Ver todas" que
   * abre a janela completa. Carrega só quando o elemento aparece na tela.
   */
  function grade(container, { onEscolher, limite = 9 } = {}) {
    const wrap = h('div', { class: 'bi-mini' });
    const lista = h('div', { class: 'bi-mini-grade' });
    const aviso = h('p', { class: 'bi-mini-aviso' });
    wrap.append(lista, aviso);
    container.append(wrap);

    const escolher = (item) => {
      marcarUso(item);
      onEscolher?.(item);
      lista.querySelectorAll('.bi-card').forEach((c) => c.classList.toggle('is-escolhida', c.dataset.id === String(item.id)));
    };
    const abrirTudo = () => abrir({ onEscolher: (item) => { onEscolher?.(item); carregar(); } });

    async function carregar() {
      lista.replaceChildren(...Array.from({ length: 5 }, () => h('div', { class: 'bi-card bi-card--esqueleto' })));
      aviso.textContent = '';
      try {
        let data = await api(`${API}?limite=${limite}`);
        const total = Object.values(data.contagem || {}).reduce((a, b) => a + b, 0);
        if (!total && !importouSistema) {
          importouSistema = true;
          await api(`${API}/importar-sistema`, { method: 'POST' }).catch(() => {});
          data = await api(`${API}?limite=${limite}`);
        }
        lista.replaceChildren();
        for (const item of data.itens || []) {
          const c = cartao(item, { onEscolher: escolher, compacto: true });
          c.dataset.id = String(item.id);
          lista.append(c);
        }
        const totalAgora = Object.values(data.contagem || {}).reduce((a, b) => a + b, 0);
        lista.append(h('button', { type: 'button', class: 'bi-mini-tudo', onclick: abrirTudo },
          icone(totalAgora ? 'imagens' : 'enviar'),
          h('span', { text: totalAgora ? `Ver todas (${totalAgora})` : 'Enviar imagens' })
        ));
        aviso.textContent = totalAgora
          ? 'Imagens limpas já geradas ou enviadas. Clique para usar como capa.'
          : 'Ainda não há imagens. As capas geradas com IA entram aqui sozinhas.';
      } catch (err) {
        lista.replaceChildren();
        aviso.textContent = err.message;
      }
    }

    if ('IntersectionObserver' in window) {
      const obs = new IntersectionObserver((entradas) => {
        if (entradas.some((e) => e.isIntersecting)) {
          obs.disconnect();
          carregar();
        }
      });
      obs.observe(wrap);
    } else {
      carregar();
    }
    return { recarregar: carregar, abrirTudo };
  }

  window.BancoImagens = { abrir, grade, enviarArquivos };
})();
