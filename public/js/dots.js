/* Dots no formato de chat: a lateral lista os dots como conversas; o pedido do
   dot é a mensagem do editor e o que ele lê, escreve e publica são as
   respostas. Ajustar um dot é mandar uma mensagem para ele. */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    shell: $('dc-shell'),
    lateral: $('dc-lateral'),
    fundoLateral: $('dc-fundo-lateral'),
    abrirLateral: $('dc-abrir-lateral'),
    fecharLateral: $('dc-fechar-lateral'),
    buscar: $('dc-buscar'),
    busca: $('dc-busca'),
    novo: $('dc-novo'),
    lista: $('dots-lista'),
    pulso: $('dots-pulso'),
    para: $('dc-para'),
    paraBusca: $('dc-para-busca'),
    paraMenu: $('dc-para-menu'),
    topo: $('dc-topo'),
    titulo: $('dc-titulo'),
    acoes: $('dc-acoes'),
    mensagens: $('dc-mensagens'),
    composer: $('dc-composer'),
    objetivo: $('dot-objetivo'),
    enviar: $('dc-enviar'),
    mais: $('dc-mais'),
    ajustes: $('dc-ajustes'),
    ajustesFechar: $('dc-ajustes-fechar'),
    resumoAjustes: $('dc-resumo-ajustes'),
    aviso: $('dot-aviso'),
    painel: $('dc-painel'),
    painelFundo: $('dc-painel-fundo'),
    painelTitulo: $('dc-painel-titulo'),
    painelCorpo: $('dc-painel-corpo'),
    painelFechar: $('dc-painel-fechar'),
    // Campos dos ajustes do dot novo (mesmos ids da tela antiga).
    nome: $('dot-nome'),
    pagina: $('dot-pagina'),
    provedor: $('dot-provedor'),
    dias: $('dot-dias'),
    horaInicio: $('dot-hora-inicio'),
    horaFim: $('dot-hora-fim'),
    scan: $('dot-scan'),
    ritmo: $('dot-ritmo'),
    destinoAjuda: $('dot-destino-ajuda'),
    saidaQtd: $('dot-saida-qtd'),
    saidaMin: $('dot-saida-min'),
    saidaRotulo: $('dot-saida-rotulo'),
    limite: $('dot-limite'),
    imagemAjuda: $('dot-imagem-ajuda'),
  };
  if (!el.shell || !el.lista) return;

  const SELECIONADO_KEY = 'ViralizeAI.dotSelecionado';
  const DETALHE_VALIDO_MS = 30000;

  /** Log por dot (execuções) e detalhe completo (números, posts, matérias). */
  const logs = new Map();
  const detalhes = new Map();
  /** Comandos em edição no painel (id → texto). */
  const editando = new Map();
  /** Aba aberta do painel e filtro dos posts, por dot. */
  const abas = new Map();
  const filtrosPosts = new Map();
  let ultimaLista = [];
  let timer = null;
  /** 'novo' ou o id do dot aberto. */
  let selecionado = 'novo';
  try {
    selecionado = localStorage.getItem(SELECIONADO_KEY) || 'novo';
  } catch {
    // sem localStorage: começa no dot novo
  }
  /** Conversa do dot novo, antes de ele existir. */
  let conversaNova = [];
  let pedidoNovo = '';
  /** Plano confirmado pelo editor. Sem ele o dot não é criado. */
  let planoConfirmado = null;
  /** Mensagem do editor enviada a um dot, até o servidor responder. */
  const pendentes = new Map();
  let ultimoHtmlConversa = '';
  let ultimaConversaDesenhada = '';

  // ---------------------------------------------------------- configuração

  const DIAS_SEMANA = [
    { id: 1, curto: 'Seg' },
    { id: 2, curto: 'Ter' },
    { id: 3, curto: 'Qua' },
    { id: 4, curto: 'Qui' },
    { id: 5, curto: 'Sex' },
    { id: 6, curto: 'Sáb' },
    { id: 7, curto: 'Dom' },
  ];
  const INTERVALOS = [
    { v: 10, t: '10 min' },
    { v: 15, t: '15 min' },
    { v: 30, t: '30 min' },
    { v: 60, t: '1 hora' },
    { v: 120, t: '2 horas' },
    { v: 180, t: '3 horas' },
    { v: 360, t: '6 horas' },
    { v: 720, t: '12 horas' },
    { v: 1440, t: '1 dia' },
  ];

  function opcao(select, valor, texto, selecionadoAgora = false) {
    select.append(new Option(texto, valor, selecionadoAgora, selecionadoAgora));
  }

  function montarCampos() {
    if (!el.dias) return;
    el.dias.replaceChildren();
    for (const dia of DIAS_SEMANA) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'd-dia is-on';
      b.dataset.dia = String(dia.id);
      b.textContent = dia.curto;
      b.setAttribute('aria-pressed', 'true');
      b.addEventListener('click', () => {
        const ligado = b.classList.toggle('is-on');
        b.setAttribute('aria-pressed', String(ligado));
      });
      el.dias.append(b);
    }
    for (const select of [el.horaInicio, el.horaFim]) {
      select.replaceChildren();
      opcao(select, '', 'qualquer hora', true);
      for (let h = 0; h <= 23; h += 1) opcao(select, String(h), `${String(h).padStart(2, '0')}h`);
    }
    el.scan.replaceChildren();
    for (const i of INTERVALOS) opcao(el.scan, String(i.v), i.t, i.v === 60);
    el.saidaQtd.replaceChildren();
    for (let n = 1; n <= 10; n += 1) opcao(el.saidaQtd, String(n), String(n), n === 1);
    el.saidaMin.replaceChildren();
    for (const i of INTERVALOS) opcao(el.saidaMin, String(i.v), i.t, i.v === 15);
    el.saidaQtd.addEventListener('change', ajustarRotuloSaida);
    for (const radio of document.querySelectorAll('input[name="dot-destino"]')) {
      radio.addEventListener('change', () => {
        ajustarDestino();
        atualizarResumoAjustes();
      });
    }
    el.pagina.addEventListener('change', atualizarResumoAjustes);
    for (const radio of document.querySelectorAll('input[name="dot-imagem"]')) {
      radio.addEventListener('change', ajustarImagem);
    }
    ajustarDestino();
    ajustarImagem();
  }

  const AJUDA_IMAGEM = {
    original: 'Usa a foto da notícia. Sem foto, gera uma com IA.',
    ia_todas: 'Cria uma imagem nova com IA para cada matéria.',
    ia_com_texto: 'Usa a foto da notícia; se ela tiver texto escrito, a IA limpa o texto e mantém a foto.',
  };

  function imagemEscolhida() {
    return document.querySelector('input[name="dot-imagem"]:checked')?.value || 'original';
  }

  function ajustarImagem() {
    if (el.imagemAjuda) el.imagemAjuda.textContent = AJUDA_IMAGEM[imagemEscolhida()] || '';
  }

  function destinoEscolhido() {
    return document.querySelector('input[name="dot-destino"]:checked')?.value || 'rascunho';
  }

  function ajustarRotuloSaida() {
    const n = Number(el.saidaQtd.value) || 1;
    el.saidaRotulo.textContent = n === 1 ? 'matéria a cada' : 'matérias a cada';
  }

  const AJUDA_DESTINO = {
    rascunho: 'Fica esperando você revisar. Nada sai sozinho.',
    agendar: 'Programa o horário e publica sozinho na hora marcada.',
    publicar: 'Vai direto para a fila, sem revisão.',
  };
  const ROTULO_DESTINO = { rascunho: 'Rascunho', agendar: 'Agendar', publicar: 'Publicar' };

  function ajustarDestino() {
    const destino = destinoEscolhido();
    el.ritmo.classList.toggle('hidden', destino === 'rascunho');
    if (el.destinoAjuda) el.destinoAjuda.textContent = AJUDA_DESTINO[destino] || '';
    ajustarRotuloSaida();
  }

  /** O que a tela manda para a prévia e para a criação — os dois iguais. */
  function configuracaoDaTela() {
    const marcados = [...el.dias.querySelectorAll('.d-dia.is-on')].map((b) => Number(b.dataset.dia));
    const inicio = el.horaInicio.value === '' ? null : Number(el.horaInicio.value);
    const fim = el.horaFim.value === '' ? null : Number(el.horaFim.value);
    return {
      dias_semana: marcados,
      hora_inicio: inicio !== null && fim !== null ? inicio : null,
      hora_fim: inicio !== null && fim !== null ? fim : null,
      scan_minutos: Number(el.scan.value) || 60,
      destino: destinoEscolhido(),
      saida_quantidade: Number(el.saidaQtd.value) || 1,
      saida_minutos: Number(el.saidaMin.value) || 15,
      limite_dia: Number(el.limite.value) || 20,
      modo_imagem: imagemEscolhida(),
    };
  }

  /** "Rascunho · Apocalipse Gospel ⚙" acima da caixa, para o dot novo. */
  function atualizarResumoAjustes() {
    if (!el.resumoAjustes) return;
    const novo = selecionado === 'novo';
    el.resumoAjustes.hidden = !novo || !el.ajustes.hidden;
    if (!novo) return;
    const pagina = el.pagina.selectedOptions?.[0]?.textContent || 'sem página';
    el.resumoAjustes.textContent = `${ROTULO_DESTINO[destinoEscolhido()]} · ${pagina.replace(' (padrão)', '')} · ajustes`;
  }

  // -------------------------------------------------------------- utilidades

  const ROTULO_IMAGEM = {
    original: 'foto original',
    ia_todas: 'imagem IA',
    ia_com_texto: 'IA se tiver texto',
    sem_imagem: 'sem imagem',
  };

  const ICONES = {
    paginas: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    relogio: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    folha: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    raio: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    imagem: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    play: '<path d="m7 4 13 8-13 8z"/>',
    pausa: '<path d="M8 5v14M16 5v14"/>',
    painel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    mais: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    lixo: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>',
    lapis: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    jornal: '<path d="M4 4h13v16H6a2 2 0 0 1-2-2zM17 8h3v10a2 2 0 0 1-2 2"/><path d="M8 8h5M8 12h5M8 16h3"/>',
    lista: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    engrenagem: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    abrir: '<path d="M7 17 17 7M9 7h8v8"/>',
    busca: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    site: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    facebook: '<path d="M15 3h-2.5A4.5 4.5 0 0 0 8 7.5V10H5.5v4H8v7h4v-7h3l.8-4H12V7.8c0-.6.4-.8.9-.8H15z"/>',
    instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/>',
    youtube: '<rect x="2.5" y="5" width="19" height="14" rx="4"/><path d="m10 9 5 3-5 3z"/>',
    tiktok: '<path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 3c.6 2.6 2.4 4.4 5 5"/>',
    enviar: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    calendario: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    desagendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M10 14l4 4M14 14l-4 4"/>',
    varinha: '<path d="m4 20 10-10M14 4v3M17.5 5.5l-2 2M20 10h-3M12 7l3 3"/>',
    fechar: '<path d="M18 6 6 18M6 6l12 12"/>',
    radar: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/>',
  };

  const icone = (nome) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[nome]}</svg>`;

  const NOME_PLATAFORMA = {
    busca: 'Pesquisa no Google Notícias',
    site: 'Site',
    facebook: 'Facebook',
    instagram: 'Instagram',
    youtube: 'YouTube',
    tiktok: 'TikTok',
    outro: 'Link',
  };

  /** Ícone colorido da plataforma da fonte (pesquisa, site, Facebook…). */
  function seloPlataforma(tipo, extra = '') {
    const t = ['busca', 'site', 'facebook', 'instagram', 'youtube', 'tiktok'].includes(tipo) ? tipo : 'site';
    return `<span class="d-plat d-plat--${t} ${extra}" title="${escapar(NOME_PLATAFORMA[tipo] || 'Fonte')}" aria-hidden="true">${icone(t)}</span>`;
  }

  /** "AAAA-MM-DDTHH:mm" no horário do editor (Araguaína = Brasília). */
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

  /** Avisos do plano calculados na tela, depois que o editor tira algo. */
  function avisosDoPlano(plano) {
    const fontes = Array.isArray(plano?.fontes) ? plano.fontes : [];
    const avisos = fontes.filter((f) => !f.url || !f.verificado).map((f) => f.motivo || `Confira o link de “${f.nome}”.`);
    if (!fontes.some((f) => f.url) && !(plano?.pesquisas || []).length) {
      avisos.unshift('Não tenho onde procurar. Cole o link de uma página ou diga o assunto para eu pesquisar.');
    }
    return avisos;
  }

  /**
   * O que o dot entendeu: onde vai procurar (pesquisas e páginas, com o
   * endereço achado e se foi conferido), o recorte e o estilo. `editavel`
   * põe um × em cada fonte para o editor tirar antes de salvar.
   */
  function htmlDoPlano(plano, { editavel = false, resumo = [] } = {}) {
    const fontes = Array.isArray(plano?.fontes) ? plano.fontes : [];
    const pesquisas = Array.isArray(plano?.pesquisas) ? plano.pesquisas : [];
    const tirar = (tipo, i, nome) => (editavel
      ? `<button type="button" class="dm-tirar" data-tirar="${tipo}" data-indice="${i}" title="Tirar" aria-label="Tirar ${escapar(nome)}">${icone('fechar')}</button>`
      : '');
    const itensPesquisa = pesquisas.map((p, i) => `
      <li class="dm-fonte">
        ${seloPlataforma('busca')}
        <span class="dm-fonte-texto"><b>${escapar(p)}</b><small>Pesquisa no Google Notícias</small></span>
        <span class="dm-fonte-estado is-ok">Pesquisa</span>${tirar('pesquisa', i, p)}
      </li>`).join('');
    const itensFonte = fontes.map((f, i) => {
      const estado = !f.url
        ? '<span class="dm-fonte-estado is-erro">Não achei</span>'
        : f.verificado
          ? `<span class="dm-fonte-estado is-ok" title="${f.via === 'link' ? 'Link colado no pedido' : 'Endereço conferido'}">${f.via === 'link' ? 'Link' : 'Conferida'}</span>`
          : '<span class="dm-fonte-estado is-alerta">Confira</span>';
      const sub = f.url
        ? `<a href="${escapar(f.url)}" target="_blank" rel="noopener">${escapar(String(f.url).replace(/^https?:\/\/(www\.)?/i, ''))}</a>`
        : escapar(f.motivo || 'Cole o link desta fonte no pedido.');
      return `
      <li class="dm-fonte${f.url ? '' : ' is-sem'}">
        ${seloPlataforma(f.tipo)}
        <span class="dm-fonte-texto"><b>${escapar(f.nome || NOME_PLATAFORMA[f.tipo] || 'Fonte')}</b><small>${sub}</small></span>
        ${estado}${tirar('fonte', i, f.nome || '')}
      </li>`;
    }).join('');

    const palavras = Array.isArray(plano?.palavras) ? plano.palavras : [];
    const chips = [
      ...palavras.map((p) => `<span class="d-chip d-chip--palavra">${icone('busca')} só se citar ${escapar(p)}</span>`),
      plano?.recorte ? `<span class="d-chip d-chip--palavra">${icone('radar')} só ${escapar(plano.recorte)}</span>` : '',
      plano?.estilo ? `<span class="d-chip">🎯 ${escapar(plano.estilo)}</span>` : '',
    ].filter(Boolean).join('');
    const avisos = avisosDoPlano(plano);
    // As linhas de "onde procura" já estão na lista acima.
    const linhas = (resumo || []).filter((l) => !/^(Pesquisa no Google Notícias|Acompanha \d)/.test(l));

    return `
      ${plano?.nome ? `<p class="dm-previa-titulo">${escapar(plano.nome)}</p>` : ''}
      <p class="dm-previa-secao">Onde vou procurar</p>
      <ul class="dm-fontes">${itensPesquisa}${itensFonte}</ul>
      ${chips ? `<div class="d-mat-chips dm-previa-chips">${chips}</div>` : ''}
      ${avisos.length ? `<ul class="dm-avisos">${avisos.map((a) => `<li>${escapar(a)}</li>`).join('')}</ul>` : ''}
      ${linhas.length ? `<ul class="dm-resumo">${linhas.map((l) => `<li>${escapar(l)}</li>`).join('')}</ul>` : ''}`;
  }

  async function api(url, opcoes = {}) {
    const resp = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opcoes });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(dados.error || dados.message || `Erro ${resp.status}`);
      err.code = dados.code || null;
      err.dados = dados.dados || null;
      throw err;
    }
    return dados;
  }

  /** Avisos curtos no canto da tela, como num app. */
  function avisar(texto, erro = false) {
    el.aviso.textContent = '';
    if (!texto) return;
    let pilha = document.getElementById('dc-toasts');
    if (!pilha) {
      pilha = document.createElement('div');
      pilha.id = 'dc-toasts';
      pilha.className = 'dc-toasts';
      pilha.setAttribute('aria-live', 'polite');
      document.body.append(pilha);
    }
    const toast = document.createElement('div');
    toast.className = `dc-toast${erro ? ' dc-toast--erro' : ''}`;
    toast.textContent = texto;
    pilha.append(toast);
    requestAnimationFrame(() => toast.classList.add('is-on'));
    setTimeout(() => {
      toast.classList.remove('is-on');
      setTimeout(() => toast.remove(), 300);
    }, erro ? 6500 : 3500);
  }

  // -------------------------------------------------- menu e diálogos

  let menuAberto = null;

  function fecharMenu() {
    if (!menuAberto) return;
    menuAberto.remove();
    menuAberto = null;
  }

  /**
   * Menu flutuante (⋯ / botão direito). `itens`: { icone, texto, acao, perigo }
   * ou 'separador'. Posiciona junto do botão ou do ponto clicado.
   */
  function abrirMenu(ancora, itens, aoEscolher, ponto = null) {
    fecharMenu();
    const menu = document.createElement('div');
    menu.className = 'dc-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = itens
      .map((item) => item === 'separador'
        ? '<div class="dc-menu-sep" role="separator"></div>'
        : `<button type="button" role="menuitem" class="dc-menu-item${item.perigo ? ' dc-menu-item--perigo' : ''}" data-menu-acao="${item.acao}">${icone(item.icone)}<span>${escapar(item.texto)}</span></button>`)
      .join('');
    document.body.append(menu);
    const caixa = ancora?.getBoundingClientRect();
    const x = ponto ? ponto.x : caixa.right - menu.offsetWidth;
    const y = ponto ? ponto.y : caixa.bottom + 6;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-menu-acao]');
      if (!item) return;
      fecharMenu();
      aoEscolher(item.dataset.menuAcao);
    });
    menu.addEventListener('keydown', (e) => {
      const botoes = [...menu.querySelectorAll('button')];
      const atual = botoes.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const passo = e.key === 'ArrowDown' ? 1 : -1;
        botoes[(atual + passo + botoes.length) % botoes.length]?.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        fecharMenu();
      }
    });
    menuAberto = menu;
    requestAnimationFrame(() => menu.classList.add('is-on'));
    menu.querySelector('button')?.focus();
  }

  document.addEventListener('mousedown', (e) => {
    if (menuAberto && !menuAberto.contains(e.target)) fecharMenu();
  });
  window.addEventListener('resize', fecharMenu);

  /** Janela de confirmação/entrada no lugar do confirm()/prompt() do navegador. */
  function dialogo({ titulo, texto = '', confirmar = 'Confirmar', perigo = false, campo = null }) {
    return new Promise((resolve) => {
      const fundo = document.createElement('div');
      fundo.className = 'dc-dialogo-fundo';
      fundo.innerHTML = `
        <div class="dc-dialogo" role="dialog" aria-modal="true" aria-labelledby="dc-dialogo-titulo">
          <h3 id="dc-dialogo-titulo">${escapar(titulo)}</h3>
          ${texto ? `<p>${escapar(texto)}</p>` : ''}
          ${campo ? `<input type="text" class="dc-dialogo-campo" maxlength="160" value="${escapar(campo.valor || '')}" aria-label="${escapar(campo.rotulo || titulo)}" />` : ''}
          <div class="dc-dialogo-acoes">
            <button type="button" class="dc-botao" data-resposta="nao">Cancelar</button>
            <button type="button" class="dc-botao ${perigo ? 'dc-botao--perigo' : 'dc-botao--principal'}" data-resposta="sim">${escapar(confirmar)}</button>
          </div>
        </div>`;
      document.body.append(fundo);
      const entrada = fundo.querySelector('.dc-dialogo-campo');
      const fechar = (sim) => {
        fundo.classList.remove('is-on');
        setTimeout(() => fundo.remove(), 180);
        document.removeEventListener('keydown', teclas, true);
        resolve(sim ? (entrada ? entrada.value.trim() : true) : entrada ? null : false);
      };
      const teclas = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          fechar(false);
        } else if (e.key === 'Enter' && entrada) {
          e.preventDefault();
          fechar(true);
        }
      };
      document.addEventListener('keydown', teclas, true);
      fundo.addEventListener('click', (e) => {
        if (e.target === fundo) return fechar(false);
        const botao = e.target.closest('[data-resposta]');
        if (botao) fechar(botao.dataset.resposta === 'sim');
      });
      requestAnimationFrame(() => fundo.classList.add('is-on'));
      if (entrada) {
        entrada.focus();
        entrada.select();
      } else {
        // Ação perigosa começa no "Cancelar": Enter sem querer não exclui.
        fundo.querySelector(`[data-resposta="${perigo ? 'nao' : 'sim'}"]`)?.focus();
      }
    });
  }

  function escapar(texto) {
    const d = document.createElement('div');
    d.textContent = String(texto ?? '');
    return d.innerHTML;
  }

  /** Texto com quebras de linha e links clicáveis, já escapado. */
  function textoRico(texto) {
    return escapar(texto)
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/\n/g, '<br>');
  }

  function haQuanto(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return `há ${Math.max(1, s)}s`;
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    if (s < 86400) return `há ${Math.round(s / 3600)}h`;
    return `há ${Math.round(s / 86400)}d`;
  }

  function horaCurta(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function diaHora(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  let provedoresCache = [];
  async function carregarProvedores() {
    try {
      const dados = await api('/api/dots/provedores');
      provedoresCache = Array.isArray(dados.provedores) ? dados.provedores : [];
    } catch {
      provedoresCache = [{ id: 'auto', nome: 'Automático', detalhe: '' }];
    }
    if (!el.provedor) return;
    el.provedor.innerHTML = '';
    for (const p of provedoresCache) {
      el.provedor.append(new Option(p.detalhe ? `${p.nome} — ${p.detalhe}` : p.nome, p.id));
    }
  }

  /** Páginas do editor (para os diálogos de publicar e agendar). */
  let paginasCache = [];

  async function carregarPaginas() {
    try {
      const dados = await api('/api/facebook/pages');
      const paginas = Array.isArray(dados.pages) ? dados.pages : [];
      paginasCache = paginas;
      el.pagina.innerHTML = '';
      el.pagina.append(new Option('Sem página (só rascunho)', ''));
      for (const p of paginas) {
        const rotulo = p.page_name || `Página ${p.id}`;
        el.pagina.append(new Option(p.is_default ? `${rotulo} (padrão)` : rotulo, p.id));
      }
      const padrao = paginas.find((p) => p.is_default);
      if (padrao) el.pagina.value = String(padrao.id);
    } catch {
      el.pagina.innerHTML = '';
      el.pagina.append(new Option('Não consegui carregar as páginas', ''));
    }
    atualizarResumoAjustes();
  }

  // ------------------------------------------------------------- lateral

  function estadoDoDot(dot) {
    if (dot.trabalhando) return 'trabalhando';
    if (dot.estado !== 'ativo') return 'pausado';
    if (dot.ultimo_erro) return 'erro';
    return 'ativo';
  }

  /** Cor fixa por dot (mesmo dot, mesma cor), para reconhecer na lista. */
  function matiz(dot) {
    let h = 0;
    for (const c of String(dot.id ?? dot.nome ?? '')) h = (h * 31 + c.charCodeAt(0)) % 360;
    return (h * 47) % 360;
  }

  function avatar(dot, extra = '') {
    const inicial = escapar(String(dot.nome || '?').trim().charAt(0).toUpperCase() || '?');
    return `<span class="dc-avatar dc-avatar--${estadoDoDot(dot)} ${extra}" style="--dc-hue:${matiz(dot)}" aria-hidden="true">${inicial}<i></i></span>`;
  }

  /** Subtítulo da conversa: o que ele está fazendo ou a última coisa que fez. */
  function subtitulo(dot) {
    if (dot.trabalhando) return dot.atividade || 'Trabalhando…';
    if (dot.estado !== 'ativo') return 'Pausado';
    if (dot.ultimo_erro) return `Problema: ${dot.ultimo_erro}`;
    const ultimo = (logs.get(String(dot.id)) || [])[0];
    if (ultimo?.acao === 'escreveu') return `Escreveu: ${partesDoEscreveu(ultimo.detalhe).titulo}`;
    if (ultimo?.detalhe) return ultimo.detalhe;
    return dot.ultimo_resumo || `${dot.feitas_hoje}/${dot.limite_dia} hoje`;
  }

  function renderLateral() {
    const filtro = String(el.busca.value || '').trim().toLowerCase();
    const dots = ultimaLista.filter((d) => !filtro || `${d.nome} ${d.objetivo}`.toLowerCase().includes(filtro));
    if (!ultimaLista.length) {
      el.lista.innerHTML = '<p class="dc-lateral-vazio">Nenhum dot ainda.<br>Escreva ao lado o que ele deve fazer.</p>';
      return;
    }
    if (!dots.length) {
      el.lista.innerHTML = '<p class="dc-lateral-vazio">Nenhum dot encontrado.</p>';
      return;
    }
    el.lista.innerHTML = dots
      .map((dot) => `
        <div class="dc-item ${String(dot.id) === selecionado ? 'is-on' : ''}" data-abrir="${dot.id}" role="button" tabindex="0">
          ${avatar(dot)}
          <span class="dc-item-texto">
            <span class="dc-item-nome">${escapar(dot.nome)}</span>
            <span class="dc-item-sub">${escapar(subtitulo(dot))}</span>
          </span>
          <button type="button" class="dc-item-mais" data-menu-dot="${dot.id}" title="Opções" aria-label="Opções de ${escapar(dot.nome)}">${icone('mais')}</button>
        </div>`)
      .join('');
  }

  // --------------------------------------------------------------- partes

  function pill(dot) {
    if (dot.trabalhando) return '<span class="d-pill d-pill--trabalhando"><span class="d-luz d-luz--pulsa"></span>Trabalhando</span>';
    if (dot.estado !== 'ativo') return '<span class="d-pill d-pill--pausado"><span class="d-luz"></span>Pausado</span>';
    if (dot.ultimo_erro) return '<span class="d-pill d-pill--erro"><span class="d-luz"></span>Com erro</span>';
    return '<span class="d-pill d-pill--ativo"><span class="d-luz"></span>Agendado</span>';
  }

  function stats(dot) {
    const pct = dot.limite_dia ? Math.min(100, Math.round((dot.feitas_hoje / dot.limite_dia) * 100)) : 0;
    return `
      <div class="d-stats mt-2">
        <span class="d-stat">${icone('radar')}<b>${dot.fontes}</b> ${dot.fontes === 1 ? 'fonte' : 'fontes'}</span>
        <span class="d-stat">${icone('relogio')}<b>${dot.materias_por_volta || 1}</b> a cada <b>${dot.intervalo_minutos}</b> min</span>
        <span class="d-stat">${icone('imagem')}${ROTULO_IMAGEM[dot.modo_imagem] || 'foto original'}</span>
        <span class="d-stat">${icone('folha')}<b>${dot.feitas_hoje}</b>/${dot.limite_dia} hoje</span>
        <span class="d-stat">${icone('raio')}${dot.destino === 'agendar' ? `agenda a cada ${dot.agendar_minutos || dot.intervalo_minutos} min` : dot.destino === 'publicar' ? 'publica' : 'rascunho'}</span>
        ${dot.pagina
          ? `<span class="d-stat" title="Página de destino das matérias">${icone('paginas')}em <b>${escapar(dot.pagina)}</b></span>`
          : `<span class="d-stat d-stat--aviso" title="Nenhuma página foi escolhida: a matéria vai para a página padrão da sua conta">${icone('paginas')}sem página definida</span>`}
        <label class="d-stat gap-1">
          ${icone('cpu')}
          <select data-provedor class="d-escolha" aria-label="IA que escreve">
            ${provedoresCache.map((p) => `<option value="${p.id}"${p.id === (dot.provedor || 'auto') ? ' selected' : ''}>${escapar(p.nome)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="d-barra ${pct >= 100 ? 'd-barra--cheia' : ''} mt-2.5"><span style="width:${pct}%"></span></div>`;
  }

  function passoDe(e) {
    const texto = String(e.detalhe || '');
    if (e.acao === 'escreveu') return { icone: '✍️', rotulo: 'Escreveu a matéria', classe: 'd-passo--ok' };
    if (e.acao === 'erro') return { icone: '⚠️', rotulo: 'Problema', classe: 'd-passo--erro' };
    if (e.acao === 'criou_fonte') return { icone: '📡', rotulo: 'Fontes', classe: '' };
    if (/fora das palavras/i.test(texto)) return { icone: '🔎', rotulo: 'Filtrou pelas palavras-chave', classe: '' };
    if (/foto|imagem|ilustra/i.test(texto)) return { icone: '🖼️', rotulo: 'Imagem', classe: '' };
    if (/repetid|já publicad|duplicad/i.test(texto)) return { icone: '♻️', rotulo: 'Evitou repetir', classe: '' };
    return { icone: '•', rotulo: 'Passo', classe: '' };
  }

  function partesDoEscreveu(detalhe) {
    const partes = String(detalhe || '').split(' · ');
    const titulo = partes.shift() || 'Matéria';
    const palavra = (partes.find((p) => /^palavra-chave:/i.test(p)) || '').replace(/^palavra-chave:\s*/i, '');
    const resto = partes.filter((p) => !/^palavra-chave:/i.test(p));
    return { titulo, palavra, imagem: resto.find((p) => /foto|imagem/i.test(p)) || '', saida: resto.find((p) => !/foto|imagem/i.test(p)) || '' };
  }

  const SITUACAO_POST = {
    proximo: { icone: '⏳', texto: 'Sai na próxima volta', classe: 'd-sit--fila', pode: true },
    repetido: { icone: '♻️', texto: 'Igual a uma matéria já publicada', classe: 'd-sit--fora', pode: true },
    falhou: { icone: '⚠️', texto: 'A IA falhou', classe: 'd-sit--erro', pode: true },
    materia: { icone: '✅', texto: 'Virou matéria', classe: 'd-sit--ok', pode: false },
    fora_do_assunto: { icone: '🚫', texto: 'Fora do assunto', classe: 'd-sit--fora', pode: false },
    pouco_texto: { icone: '✂️', texto: 'Sem texto suficiente', classe: 'd-sit--fora', pode: false },
    descartado: { icone: '—', texto: 'Descartado', classe: 'd-sit--fora', pode: false },
    escrevendo: { icone: '✍️', texto: 'Escrevendo agora…', classe: 'd-sit--fila', pode: false },
  };
  const FILTROS_POST = [
    { id: 'todos', texto: 'Todos', ok: () => true },
    { id: 'assunto', texto: 'Do assunto', ok: (p) => p.situacao !== 'fora_do_assunto' },
    { id: 'materia', texto: 'Viraram matéria', ok: (p) => p.situacao === 'materia' },
    { id: 'fora', texto: 'Fora do assunto', ok: (p) => p.situacao === 'fora_do_assunto' },
  ];
  const PROXIMAS = ['proximo', 'repetido', 'falhou'];

  function miniatura(url, fonte, classe) {
    if (url) return `<img src="${escapar(url)}" alt="" loading="lazy" class="${classe}" />`;
    const letra = escapar(String(fonte || '?').replace(/^www\./i, '').trim().charAt(0).toUpperCase() || '?');
    return `<span class="${classe} d-sem-imagem" aria-hidden="true">${letra}</span>`;
  }

  function frase(dot) {
    const plano = dot.plano || {};
    const lista = detalhes.get(String(dot.id))?.fontes_lista;
    const pesquisas = lista
      ? lista.filter((f) => f.plataforma === 'busca').map((f) => f.termo || f.nome)
      : (Array.isArray(dot.pesquisas) ? dot.pesquisas : []);
    const paginas = lista ? lista.filter((f) => f.plataforma !== 'busca').length : Math.max(0, dot.fontes - pesquisas.length);
    const onde = [
      pesquisas.length ? `pesquiso ${pesquisas.map((p) => `<b>“${escapar(p)}”</b>`).join(', ')} no Google Notícias` : '',
      paginas ? `leio ${paginas} ${paginas === 1 ? 'página' : 'páginas'}` : '',
    ].filter(Boolean).join(' e ') || `leio ${dot.fontes} ${dot.fontes === 1 ? 'fonte' : 'fontes'}`;
    const palavras = Array.isArray(plano.palavras) ? plano.palavras : [];
    const recorte = palavras.length
      ? `, só o que citar <b>${escapar(palavras.join(', '))}</b>`
      : plano.recorte ? `, só <b>${escapar(plano.recorte)}</b>` : '';
    const destino = dot.destino === 'agendar'
      ? `agendo 1 a cada ${dot.agendar_minutos || dot.intervalo_minutos} min`
      : dot.destino === 'publicar' ? 'publico na hora' : 'deixo em rascunho';
    const pagina = dot.pagina ? ` em <b>${escapar(dot.pagina)}</b>` : ' <span class="d-aviso-mini">(sem página definida)</span>';
    return `${onde.charAt(0).toUpperCase()}${onde.slice(1)}${recorte} e ${destino}${pagina}.`;
  }

  function banner(dot) {
    const r = detalhes.get(String(dot.id))?.resumo || {};
    if (dot.trabalhando) {
      return `<div class="d-banner d-banner--trabalhando"><span class="d-luz d-luz--pulsa"></span>
        <span><b>Trabalhando agora</b> — ${escapar(dot.atividade || 'começando…')}</span></div>`;
    }
    if (dot.estado !== 'ativo') {
      return '<div class="d-banner d-banner--pausado">⏸️ <span><b>Pausado.</b> Clique em “Retomar” para eu voltar a trabalhar.</span></div>';
    }
    if (dot.ultimo_erro) {
      const trocarIa = /IA que escreve/i.test(dot.ultimo_erro)
        ? ' <button type="button" class="d-acao d-banner-acao" data-acao="painel" data-aba="config">Trocar a IA</button>'
        : '';
      return `<div class="d-banner d-banner--erro">⚠️ <span><b>Precisa de atenção:</b> ${escapar(dot.ultimo_erro)}${trocarIa}</span></div>`;
    }
    const resta = Math.max(0, dot.limite_dia - dot.feitas_hoje);
    const quandoVolta = dot.proxima_execucao_at ? `às ${horaCurta(dot.proxima_execucao_at)}` : 'em breve';
    if (!resta) return `<div class="d-banner">✋ <span>Limite de <b>${dot.limite_dia}</b> matérias hoje atingido. Volto amanhã.</span></div>`;
    if (r.proximos) {
      return `<div class="d-banner d-banner--ok">⏳ <span><b>${r.proximos} ${r.proximos === 1 ? 'post do assunto pronto' : 'posts do assunto prontos'}</b> — sai na próxima volta (${quandoVolta}).</span></div>`;
    }
    return `<div class="d-banner">🔎 <span><b>Procurando.</b> Nenhum post novo do assunto ainda — releio as fontes ${quandoVolta}.</span></div>`;
  }

  function funil(dot) {
    const r = detalhes.get(String(dot.id))?.resumo;
    const etapa = (valor, rotulo, classe = '') => `<div class="d-etapa ${classe}"><b>${r ? Number(valor) || 0 : '—'}</b><span>${rotulo}</span></div>`;
    const seta = '<span class="d-seta" aria-hidden="true">›</span>';
    return `
      <div class="d-funil mt-3">
        ${etapa(r?.lidos, 'lidos')}${seta}
        ${etapa(r?.no_assunto, 'do assunto')}${seta}
        ${etapa(r?.proximos, 'prontos', r?.proximos ? 'd-etapa--alerta' : '')}${seta}
        ${etapa(r?.escritas, 'matérias')}${seta}
        ${etapa(r?.publicadas, 'publicadas', r?.publicadas ? 'd-etapa--ok' : '')}
      </div>
      ${r?.agendadas || r?.problemas_24h ? `<p class="d-funil-extra">${r.agendadas ? `📅 ${r.agendadas} agendada(s)` : ''}${r.agendadas && r.problemas_24h ? ' · ' : ''}${r.problemas_24h ? `<span class="d-txt-erro">⚠️ ${r.problemas_24h} problema(s) nas últimas 24 h</span>` : ''}</p>` : ''}`;
  }

  function linhaPost(p) {
    const sit = SITUACAO_POST[p.situacao] || SITUACAO_POST.descartado;
    const detalheSit = p.situacao === 'falhou' && p.volta_em ? `${sit.texto} · tenta de novo às ${horaCurta(p.volta_em)}` : sit.texto;
    const abrir = p.matter_id ? `/materias-ia/${p.matter_id}` : p.url;
    const acao = p.matter_id
      ? `<a class="d-btn d-btn--neutro" href="/materias-ia/${p.matter_id}" target="_blank" rel="noopener">Ver matéria</a>`
      : sit.pode
        ? `<button type="button" class="d-btn d-btn--principal" data-acao="escrever-post" data-post="${p.id}">✍️ Escrever agora</button>`
        : '';
    return `
      <div class="d-post">
        <a href="${escapar(abrir)}" target="_blank" rel="noopener" class="shrink-0">${miniatura(p.thumbnail, p.fonte, 'd-post-capa')}</a>
        <div class="d-post-corpo">
          <a href="${escapar(abrir)}" target="_blank" rel="noopener" class="d-post-titulo">${escapar(p.titulo || '(sem título)')}</a>
          <span class="d-post-meta">${seloPlataforma(p.plataforma, 'd-plat--mini')}${escapar(p.fonte || '')} · ${haQuanto(p.publicado_em || p.lido_em)}${p.palavra ? ` · <span class="d-txt-acento">🔎 ${escapar(p.palavra)}</span>` : ''}</span>
          <span class="d-sit ${sit.classe}">${sit.icone} ${escapar(detalheSit)}</span>
        </div>
        <div class="d-post-acao">${acao}</div>
      </div>`;
  }

  function seloMateria(m) {
    if (m.status === 'publicado') return '<span class="d-selo d-selo--ok">✅ Publicada</span>';
    if (m.status === 'agendado') return `<span class="d-selo d-selo--alerta">📅 ${diaHora(m.agendada_para)}</span>`;
    if (m.status === 'erro') return `<span class="d-selo d-selo--erro" title="${escapar(m.erro || '')}">⚠️ Erro ao publicar</span>`;
    // Rascunho com motivo: a fila recusou (notícia repetida, sem foto…).
    if (m.erro) return `<span class="d-selo d-selo--erro" title="${escapar(m.erro)}">⚠️ Não saiu — ${escapar(m.erro.slice(0, 80))}</span>`;
    return '<span class="d-selo">📝 Rascunho</span>';
  }

  /** Botões de cada matéria: publicar, agendar e o resto no "⋯". */
  function acoesDaMateria(m) {
    if (m.status === 'publicado') {
      return m.link
        ? `<a class="d-acao" href="${escapar(m.link)}" target="_blank" rel="noopener">${icone('abrir')}Ver no Facebook</a>`
        : `<a class="d-acao" href="/materias-ia/${m.id}" target="_blank" rel="noopener">${icone('abrir')}Abrir matéria</a>`;
    }
    return `
      <button type="button" class="d-acao d-acao--principal" data-acao="publicar-materia" title="Publicar agora">${icone('enviar')}<span>Publicar</span></button>
      <button type="button" class="d-acao" data-acao="agendar-materia" title="${m.status === 'agendado' ? 'Mudar o horário' : 'Escolher dia e hora'}">${icone('calendario')}<span>${m.status === 'agendado' ? 'Reagendar' : 'Agendar'}</span></button>
      <button type="button" class="d-acao d-acao--icone" data-acao="mais-materia" title="Mais ações" aria-label="Mais ações da matéria">${icone('mais')}</button>`;
  }

  function cartaoMateria(m) {
    const abrir = `/materias-ia/${m.id}`;
    return `
      <article class="d-arte d-arte--acoes" data-materia="${m.id}">
        <a class="d-arte-img" href="${abrir}" target="_blank" rel="noopener" title="Abrir a matéria">
          ${m.imagem ? `<img src="${escapar(m.imagem)}" alt="" loading="lazy" />` : '<span class="d-sem-imagem">📰</span>'}
          ${seloMateria(m)}
          ${m.gerando_imagem ? '<span class="d-arte-gerando"><i></i>Gerando imagem…</span>' : ''}
        </a>
        <a class="d-arte-titulo" href="${abrir}" target="_blank" rel="noopener">${escapar(m.titulo || 'Matéria')}</a>
        ${m.pagina ? `<span class="d-arte-pagina">${icone('facebook')}<span>${escapar(m.pagina)}</span></span>` : ''}
        <div class="d-arte-acoes">${acoesDaMateria(m)}</div>
      </article>`;
  }

  // ------------------------------------------------------------ painel

  function abaProximas(d) {
    const lista = (d?.posts || []).filter((p) => PROXIMAS.includes(p.situacao));
    if (!lista.length) return '<div class="d-vazio-aba">🔎 Nenhum post do assunto esperando.</div>';
    const ordem = { proximo: 0, falhou: 1, repetido: 2 };
    return `<div class="d-posts">${lista.sort((a, b) => ordem[a.situacao] - ordem[b.situacao]).map(linhaPost).join('')}</div>`;
  }

  /** Matérias separadas pelo que falta fazer: revisar, já agendadas, publicadas. */
  function abaMaterias(d) {
    const materias = d?.materias || [];
    if (!materias.length) {
      return '<div class="d-vazio-aba">📰 Nenhuma matéria ainda. Use “Trabalhar agora” ou “Escrever agora” num post da aba Próximas.</div>';
    }
    const grupos = [
      { titulo: 'Para revisar', ajuda: 'Rascunhos: publique, agende ou edite.', lista: materias.filter((m) => !['agendado', 'publicado'].includes(m.status)) },
      {
        titulo: 'Agendadas',
        ajuda: 'Saem sozinhas no horário marcado.',
        lista: materias
          .filter((m) => m.status === 'agendado')
          .sort((a, b) => new Date(a.agendada_para) - new Date(b.agendada_para)),
      },
      { titulo: 'Publicadas', ajuda: '', lista: materias.filter((m) => m.status === 'publicado') },
    ].filter((g) => g.lista.length);
    return grupos.map((g) => `
      <section class="d-grupo-materias">
        <p class="d-grupo-titulo">${g.titulo} <span>${g.lista.length}</span>${g.ajuda ? `<small>${g.ajuda}</small>` : ''}</p>
        <div class="d-grade">${g.lista.map(cartaoMateria).join('')}</div>
      </section>`).join('');
  }

  const DICA_FONTE_NOVA = {
    busca: 'Ex.: preço da gasolina',
    site: 'Ex.: g1, Folha ou https://site.com.br',
    facebook: 'Ex.: Metrópoles ou o link da página',
    instagram: 'Ex.: Nikolas Ferreira ou o link do perfil',
    youtube: 'Ex.: Jovem Pan News ou o link do canal',
    tiktok: 'Ex.: Poder360 ou o link do perfil',
  };

  /** Onde o dot procura: cada fonte com o estado, e o formulário para acrescentar. */
  function abaFontes(dot, d) {
    const lista = d?.fontes_lista || [];
    const faltam = d?.fontes_nao_achadas || [];
    const itens = lista.map((f) => {
      const titulo = f.plataforma === 'busca' ? `“${f.termo || f.nome}”` : f.nome;
      const lida = f.ultimo_scan ? `lida ${haQuanto(f.ultimo_scan)}` : 'ainda não lida';
      return `
        <li class="d-fonte">
          ${seloPlataforma(f.plataforma)}
          <span class="d-fonte-texto">
            <b>${escapar(titulo)}</b>
            <small>${f.plataforma === 'busca' ? 'Pesquisa no Google Notícias' : `<a href="${escapar(f.url)}" target="_blank" rel="noopener">${escapar(String(f.url).replace(/^https?:\/\/(www\.)?/i, ''))}</a>`}</small>
            <small>${f.posts_7d} ${f.posts_7d === 1 ? 'post' : 'posts'} em 7 dias · ${lida}</small>
            ${f.ultimo_erro ? `<small class="d-txt-erro">⚠️ ${escapar(f.ultimo_erro)}</small>` : ''}
          </span>
          <button type="button" class="d-acao d-acao--icone d-acao--perigo" data-acao="remover-fonte" data-fonte="${f.id}" title="Tirar desta lista" aria-label="Tirar ${escapar(titulo)}">${icone('fechar')}</button>
        </li>`;
    }).join('');
    const naoAchadas = faltam.map((f) => `
      <li class="d-fonte is-sem">
        ${seloPlataforma(f.tipo)}
        <span class="d-fonte-texto"><b>${escapar(f.nome)}</b><small class="d-txt-erro">${escapar(f.motivo || 'Não achei. Acrescente pelo link.')}</small></span>
      </li>`).join('');
    return `
      <p class="d-fontes-ajuda">Onde ${escapar(dot.nome)} procura notícias. Cada fonte é relida a cada volta.</p>
      <ul class="d-fontes">${itens || '<li class="d-vazio-aba">Nenhuma fonte.</li>'}${naoAchadas}</ul>
      <form class="d-fonte-nova" data-form="adicionar-fonte">
        <p class="d-rotulo-min">Acrescentar fonte</p>
        <div class="d-fonte-nova-linha">
          <select name="tipo" class="d-escolha" aria-label="Tipo de fonte">
            <option value="busca">Pesquisar assunto</option>
            <option value="site">Site</option>
            <option value="facebook">Página do Facebook</option>
            <option value="instagram">Perfil do Instagram</option>
            <option value="youtube">Canal do YouTube</option>
            <option value="tiktok">TikTok</option>
          </select>
          <input name="texto" class="d-fonte-nova-campo" type="text" maxlength="300" placeholder="${DICA_FONTE_NOVA.busca}" aria-label="Assunto, nome ou link" required />
          <button type="submit" class="d-btn d-btn--principal">Acrescentar</button>
        </div>
        <p class="d-ajuda">Escreva o nome que eu procuro e confiro o endereço, ou cole o link.</p>
      </form>`;
  }

  function abaTodos(dotId, d) {
    const posts = d?.posts || [];
    if (!posts.length) return '<div class="d-vazio-aba">Nenhum post lido nos últimos 7 dias. Confira se o link da página no comando está certo.</div>';
    const filtroId = filtrosPosts.get(String(dotId)) || 'todos';
    const filtro = FILTROS_POST.find((f) => f.id === filtroId) || FILTROS_POST[0];
    const visiveis = posts.filter(filtro.ok);
    const botoes = FILTROS_POST.map((f) => `<button type="button" data-acao="filtro-posts" data-filtro="${f.id}" class="d-filtro ${f.id === filtro.id ? 'is-on' : ''}">${f.texto} <span>${posts.filter(f.ok).length}</span></button>`).join('');
    return `
      <div class="d-filtros">${botoes}</div>
      <div class="d-posts mt-2">${visiveis.slice(0, 40).map(linhaPost).join('') || '<div class="d-vazio-aba">Nada neste filtro.</div>'}</div>`;
  }

  /** Junta linhas repetidas seguidas ("× 3"). Recebe do mais novo ao mais velho. */
  function agrupar(linhas) {
    const agrupadas = [];
    for (const e of linhas) {
      const ultima = agrupadas[agrupadas.length - 1];
      if (ultima && ultima.acao === e.acao && ultima.detalhe === e.detalhe) {
        ultima.vezes += 1;
        continue;
      }
      agrupadas.push({ ...e, vezes: 1 });
    }
    return agrupadas;
  }

  function abaHistorico(dotId) {
    const linhas = logs.get(String(dotId)) || [];
    if (!linhas.length) return '<div class="d-vazio-aba">Ainda não há histórico.</div>';
    return `<ol class="d-passos">${agrupar(linhas.slice(0, 60)).slice(0, 30).map((e) => {
      const passo = passoDe(e);
      const texto = e.acao === 'escreveu' ? partesDoEscreveu(e.detalhe).titulo : e.detalhe || e.acao;
      return `<li class="d-passo ${passo.classe}">
        <span class="d-passo-icone" aria-hidden="true">${passo.icone}</span>
        <span class="d-passo-corpo">
          <span class="d-passo-rotulo">${passo.rotulo}${e.vezes > 1 ? ` <b class="d-vezes">× ${e.vezes}</b>` : ''}</span>
          <span>${escapar(texto)}</span>
          <span class="d-quando">${haQuanto(e.created_at)}</span>
        </span>
      </li>`;
    }).join('')}</ol>`;
  }

  function comando(dot) {
    const id = String(dot.id);
    const plano = dot.plano || {};
    if (editando.has(id)) {
      return `
        <div class="d-comando d-comando--editando mt-3">
          <label class="d-rotulo-min" for="dot-cmd-${id}">O que ele deve fazer</label>
          <textarea id="dot-cmd-${id}" data-comando-texto rows="7">${escapar(editando.get(id))}</textarea>
          <p class="d-ajuda">Links novos viram páginas monitoradas; links apagados deixam de ser lidos.</p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button type="button" data-acao="salvar-comando" class="d-btn d-btn--principal">Salvar comando</button>
            <button type="button" data-acao="cancelar-comando" class="d-btn d-btn--fantasma">Cancelar</button>
          </div>
        </div>`;
    }
    const palavras = Array.isArray(plano.palavras) ? plano.palavras : [];
    return `
      <div class="d-comando mt-3">
        <div class="flex items-start justify-between gap-2">
          <p class="d-comando-texto">${textoRico(dot.objetivo || 'Sem comando.')}</p>
          <button type="button" data-acao="editar-comando" class="d-btn d-btn--fantasma shrink-0">✏️ Editar</button>
        </div>
        <div class="d-mat-chips mt-1.5">
          ${(Array.isArray(dot.pesquisas) ? dot.pesquisas : []).map((p) => `<span class="d-chip d-chip--fonte">${seloPlataforma('busca', 'd-plat--mini')}“${escapar(p)}”</span>`).join('')}
          ${palavras.length ? `<span class="d-chip d-chip--palavra">🔎 só se citar ${escapar(palavras.join(', '))}</span>` : ''}
          ${plano.recorte ? `<span class="d-chip d-chip--palavra">${icone('radar')} só ${escapar(plano.recorte)}</span>` : ''}
          ${!palavras.length && !plano.recorte && !(dot.pesquisas || []).length ? '<span class="d-chip">🔎 qualquer assunto</span>' : ''}
          ${plano.estilo ? `<span class="d-chip">🎯 ${escapar(plano.estilo)}</span>` : ''}
          <button type="button" class="d-chip" data-acao="aba" data-aba="fontes">📡 ${dot.fontes} ${dot.fontes === 1 ? 'fonte' : 'fontes'}</button>
        </div>
      </div>`;
  }

  function abaConfig(dot) {
    return `
      <div class="dc-config">
        <label class="d-rotulo-min" for="dc-nome-${dot.id}">Nome</label>
        <input id="dc-nome-${dot.id}" class="d-nome dc-config-nome" data-nome value="${escapar(dot.nome)}" maxlength="160" />
        ${stats(dot)}
        ${comando(dot)}
        <button type="button" data-acao="excluir" class="d-btn d-btn--fantasma d-btn--perigo mt-4">Excluir este dot</button>
      </div>`;
  }

  const ABAS = [
    { id: 'proximas', texto: '⏳ Próximas' },
    { id: 'materias', texto: '📰 Matérias' },
    { id: 'fontes', texto: '📡 Fontes' },
    { id: 'todos', texto: '🗂️ Todos os posts' },
    { id: 'historico', texto: '🧭 Histórico' },
    { id: 'config', texto: '⚙️ Configuração' },
  ];

  function renderPainel() {
    if (el.painel.hidden) return;
    const dot = dotAtual();
    if (!dot) return fecharPainel();
    const id = String(dot.id);
    const d = detalhes.get(id);
    const aba = abas.get(id) || 'proximas';
    const posts = d?.posts || [];
    const contagem = {
      proximas: d ? posts.filter((p) => PROXIMAS.includes(p.situacao)).length : null,
      materias: d ? (d.materias || []).length : null,
      fontes: d ? (d.fontes_lista || []).length : null,
      todos: d ? posts.length : null,
    };
    // O formulário de fonte nova não pode perder o que está sendo digitado.
    const digitando = el.painelCorpo.querySelector('.d-fonte-nova-campo');
    if (aba === 'fontes' && digitando && document.activeElement === digitando) return;
    const conteudo = aba === 'config'
      ? abaConfig(dot)
      : !d
        ? '<div class="d-vazio-aba">Carregando…</div>'
        : aba === 'materias'
          ? abaMaterias(d)
          : aba === 'fontes'
            ? abaFontes(dot, d)
            : aba === 'todos'
              ? abaTodos(id, d)
              : aba === 'historico'
                ? abaHistorico(id)
                : abaProximas(d);
    el.painelTitulo.textContent = dot.nome;
    el.painelCorpo.innerHTML = `
      <div data-dot="${dot.id}">
        <div class="d-abas" role="tablist">
          ${ABAS.map((a) => `<button type="button" role="tab" data-acao="aba" data-aba="${a.id}" aria-selected="${aba === a.id}" class="d-aba ${aba === a.id ? 'is-on' : ''}">${a.texto}${contagem[a.id] !== null && contagem[a.id] !== undefined ? ` <span>${contagem[a.id]}</span>` : ''}</button>`).join('')}
        </div>
        <div class="d-aba-corpo mt-3">${conteudo}</div>
      </div>`;
  }

  function abrirPainel(aba) {
    const dot = dotAtual();
    if (!dot) return;
    if (aba) abas.set(String(dot.id), aba);
    el.painel.hidden = false;
    el.painelFundo.hidden = false;
    renderPainel();
  }

  function fecharPainel() {
    if (editando.size) editando.clear();
    el.painel.hidden = true;
    el.painelFundo.hidden = true;
  }

  // ------------------------------------------------------------ conversa

  function dotAtual() {
    return ultimaLista.find((d) => String(d.id) === selecionado) || null;
  }

  const msgEditor = (html, extra = '') => `<div class="dc-msg dc-msg--editor ${extra}"><div class="dc-bolha">${html}</div></div>`;
  const msgDot = (html, extra = '') => `<div class="dc-msg dc-msg--dot ${extra}"><div class="dc-bolha">${html}</div></div>`;

  const EXEMPLOS = [
    {
      rotulo: 'Pesquisar assunto',
      texto: 'Pesquise notícias sobre reforma tributária e escreva matérias com título forte.',
    },
    {
      rotulo: 'Acompanhar páginas',
      texto: 'Monitore o g1 e a página do Metrópoles no Facebook e escreva matéria do que render.',
    },
    {
      rotulo: 'Só um tema',
      texto: 'Acompanhe o Instagram do Nikolas Ferreira e o canal da Jovem Pan News no YouTube. Só o que for de política.',
    },
  ];

  function conversaDoNovo() {
    const boasVindas = msgDot(`
      <p><b>Diga o que você quer, do seu jeito.</b></p>
      <p>Eu pesquiso o assunto, acompanho as páginas, separo o que tem conteúdo e escrevo a matéria — no servidor, mesmo com a aba fechada.</p>
      <p class="dc-dica">Diga o <b>assunto</b> e <b>onde procurar</b>: nome ou link de site, página do Facebook, perfil do Instagram, canal do YouTube. Sem fonte, eu pesquiso no Google Notícias. No <b>+</b> você escolhe rascunho, agendar ou publicar, a página e a imagem.</p>
      <div class="dc-chips">${EXEMPLOS.map((e, i) => `<button type="button" class="dc-chip" data-acao="exemplo" data-exemplo="${i}">${escapar(e.rotulo)}</button>`).join('')}</div>`);
    return boasVindas + conversaNova.map((m) => (m.autor === 'editor' ? msgEditor(m.html) : msgDot(m.html, m.extra || ''))).join('');
  }

  /** O comando vira a 1ª mensagem; cada "Ajuste:" mandado depois, uma nova. */
  function mensagensDoComando(objetivo) {
    return String(objetivo || '')
      .split(/\n\nAjuste:\s*/)
      .map((parte) => parte.trim())
      .filter(Boolean);
  }

  function conversaDoDot(dot) {
    const id = String(dot.id);
    const d = detalhes.get(id);
    const plano = dot.plano || {};
    const partes = [];

    for (const texto of mensagensDoComando(dot.objetivo)) partes.push(msgEditor(textoRico(texto)));
    const palavras = Array.isArray(plano.palavras) ? plano.palavras : [];
    const fontesDoDot = d?.fontes_lista || [];
    const naoAchadas = d?.fontes_nao_achadas || [];
    partes.push(msgDot(`
      <p>Entendi. ${frase(dot)}</p>
      ${fontesDoDot.length ? `<div class="d-mat-chips mt-1.5">${fontesDoDot.slice(0, 6).map((f) => `<span class="d-chip d-chip--fonte">${seloPlataforma(f.plataforma, 'd-plat--mini')}${escapar(f.plataforma === 'busca' ? `“${f.termo || f.nome}”` : f.nome)}</span>`).join('')}${fontesDoDot.length > 6 ? `<span class="d-chip">+${fontesDoDot.length - 6}</span>` : ''}</div>` : ''}
      ${naoAchadas.length ? `<p class="dc-dica d-txt-erro">⚠️ ${naoAchadas.map((f) => escapar(f.motivo || `Não achei ${f.nome}.`)).join(' ')}</p>` : ''}
      <div class="d-mat-chips mt-1.5">
        ${palavras.length ? `<span class="d-chip d-chip--palavra">🔎 só se citar ${escapar(palavras.join(', '))}</span>` : ''}
        ${plano.recorte ? `<span class="d-chip d-chip--palavra">${icone('radar')} só ${escapar(plano.recorte)}</span>` : ''}
        ${plano.estilo ? `<span class="d-chip">🎯 ${escapar(plano.estilo)}</span>` : ''}
      </div>`));

    // Histórico do mais velho ao mais novo, como numa conversa.
    const porId = new Map((d?.materias || []).map((m) => [Number(m.id), m]));
    const historico = agrupar((logs.get(id) || []).slice(0, 60)).slice(0, 20).reverse();
    for (const e of historico) {
      const passo = passoDe(e);
      if (e.acao === 'escreveu') {
        const partesEscreveu = partesDoEscreveu(e.detalhe);
        const m = porId.get(Number(e.matter_id));
        partes.push(msgDot(`
          <p class="dc-passo-topo">✍️ <b>Escrevi uma matéria</b> <span class="d-quando">${haQuanto(e.created_at)}</span></p>
          ${m ? `<div class="dc-materia">${cartaoMateria(m)}</div>` : `<p>${escapar(partesEscreveu.titulo)}</p>`}
          ${partesEscreveu.palavra ? `<p class="dc-dica">🔎 ${escapar(partesEscreveu.palavra)}${partesEscreveu.saida ? ` · ${escapar(partesEscreveu.saida)}` : ''}</p>` : ''}`, 'dc-msg--passo'));
        continue;
      }
      partes.push(msgDot(`
        <p class="dc-passo-topo">${passo.icone} <b>${passo.rotulo}</b>${e.vezes > 1 ? ` <b class="d-vezes">× ${e.vezes}</b>` : ''} <span class="d-quando">${haQuanto(e.created_at)}</span></p>
        <p>${escapar(e.detalhe || e.acao)}</p>`, `dc-msg--passo ${passo.classe === 'd-passo--erro' ? 'dc-msg--erro' : ''}`));
    }

    // Mensagens que o editor acabou de mandar e o servidor ainda processa.
    for (const p of pendentes.get(id) || []) {
      partes.push(msgEditor(textoRico(p)));
      partes.push(msgDot('<p class="dc-digitando"><i></i><i></i><i></i> Lendo o novo pedido…</p>'));
    }

    const proximas = (d?.posts || []).filter((p) => PROXIMAS.includes(p.situacao));
    if (proximas.length) {
      partes.push(msgDot(`
        <p><b>${proximas.length} ${proximas.length === 1 ? 'post do assunto esperando' : 'posts do assunto esperando'}.</b> Quer algum agora?</p>
        <div class="d-posts mt-2">${proximas.slice(0, 4).map(linhaPost).join('')}</div>
        ${proximas.length > 4 ? '<button type="button" class="dc-chip mt-2" data-acao="painel" data-aba="proximas">Ver todos</button>' : ''}`));
    }

    partes.push(msgDot(`${banner(dot)}${funil(dot)}`, 'dc-msg--status'));
    partes.push(`
      <div class="dc-chips dc-chips--acoes">
        <button type="button" class="dc-chip" data-acao="rodar" ${dot.trabalhando ? 'disabled' : ''}>${icone('play')}Trabalhar agora</button>
        <button type="button" class="dc-chip" data-acao="${dot.estado === 'ativo' ? 'pausar' : 'retomar'}">${icone(dot.estado === 'ativo' ? 'pausa' : 'play')}${dot.estado === 'ativo' ? 'Pausar' : 'Retomar'}</button>
        <button type="button" class="dc-chip" data-acao="painel" data-aba="materias">${icone('jornal')}Matérias${d ? ` <b>${(d.materias || []).length}</b>` : ''}</button>
        <button type="button" class="dc-chip" data-acao="painel" data-aba="fontes">${icone('radar')}Fontes${d ? ` <b>${(d.fontes_lista || []).length}</b>` : ''}</button>
        <button type="button" class="dc-chip" data-acao="painel" data-aba="todos">${icone('lista')}Todos os posts</button>
        <button type="button" class="dc-chip" data-acao="painel" data-aba="config">${icone('engrenagem')}Configuração</button>
      </div>`);
    return `<div data-dot="${dot.id}" class="dc-fio">${partes.join('')}</div>`;
  }

  function renderTopo() {
    const dot = dotAtual();
    if (!dot) {
      const nome = String(el.nome?.value || '').trim() || 'Novo dot';
      el.titulo.innerHTML = `<span class="dc-avatar dc-avatar--novo" aria-hidden="true">+</span><span class="dc-titulo-nome">${escapar(nome)}</span>`;
      el.acoes.innerHTML = '';
      return;
    }
    el.titulo.innerHTML = `${avatar(dot)}<span class="dc-titulo-nome">${escapar(dot.nome)}</span>${pill(dot)}`;
    el.acoes.innerHTML = `
      <div data-dot="${dot.id}" class="dc-acoes-grupo">
        <button type="button" class="dc-botao dc-botao--principal" data-acao="rodar" title="Ler as páginas e escrever agora" ${dot.trabalhando ? 'disabled' : ''}>${icone('play')}<span>${dot.trabalhando ? 'Trabalhando…' : 'Trabalhar agora'}</span></button>
        <button type="button" class="dc-icone" data-acao="painel" title="Painel do dot" aria-label="Abrir painel do dot">${icone('painel')}</button>
        <button type="button" class="dc-icone" data-acao="menu-topo" title="Mais opções" aria-label="Mais opções do dot" aria-haspopup="menu">${icone('mais')}</button>
      </div>`;
  }

  function renderConversa({ rolar = false } = {}) {
    const dot = dotAtual();
    if (selecionado !== 'novo' && !dot && ultimaLista.length) selecionado = 'novo';
    const html = dot ? conversaDoDot(dot) : conversaDoNovo();
    const chave = dot ? String(dot.id) : 'novo';
    const trocou = chave !== ultimaConversaDesenhada;
    renderTopo();
    el.objetivo.placeholder = dot
      ? `Mensagem para ${dot.nome}`
      : 'Diga o assunto e onde procurar…';
    el.mais.hidden = Boolean(dot);
    if (dot && !editandoId) fecharAjustes();
    atualizarResumoAjustes();
    if (!trocou && html === ultimoHtmlConversa) return;
    // Só desce sozinho quando o editor já estava no fim (ou trocou de conversa).
    const perto = el.mensagens.scrollHeight - el.mensagens.scrollTop - el.mensagens.clientHeight < 120;
    el.mensagens.innerHTML = html;
    ultimoHtmlConversa = html;
    ultimaConversaDesenhada = chave;
    if (trocou || rolar || perto) el.mensagens.scrollTop = el.mensagens.scrollHeight;
  }

  function selecionar(id) {
    selecionado = String(id || 'novo');
    try {
      localStorage.setItem(SELECIONADO_KEY, selecionado);
    } catch {
      // ignora
    }
    fecharLateral();
    fecharPainel();
    avisar('');
    renderLateral();
    renderConversa({ rolar: true });
    if (selecionado !== 'novo' && !detalhes.has(selecionado)) {
      carregarLog(selecionado).then(() => {
        renderLateral();
        renderConversa();
      });
    }
    el.objetivo.focus();
  }

  // ------------------------------------------------------------- ciclo

  async function carregarLog(dotId) {
    try {
      const dados = await api(`/api/dots/${dotId}`);
      logs.set(String(dotId), dados.execucoes || []);
      detalhes.set(String(dotId), { ...dados, em: Date.now() });
    } catch {
      logs.set(String(dotId), logs.get(String(dotId)) || []);
    }
  }

  async function carregar() {
    try {
      const resposta = await api('/api/dots');
      const dots = Array.isArray(resposta) ? resposta : [];
      const precisa = (d) =>
        d.trabalhando ||
        String(d.id) === selecionado ||
        !detalhes.has(String(d.id)) ||
        Date.now() - detalhes.get(String(d.id)).em > DETALHE_VALIDO_MS;
      await Promise.all(dots.filter(precisa).slice(0, 8).map((d) => carregarLog(d.id)));

      ultimaLista = dots;
      if (selecionado !== 'novo' && !dots.some((d) => String(d.id) === selecionado)) selecionado = 'novo';
      renderLateral();
      renderConversa();
      // Painel com comando em edição não se redesenha (perderia o texto).
      if (!editando.size) renderPainel();

      const trabalhando = dots.filter((d) => d.trabalhando).length;
      const ativos = dots.filter((d) => d.estado === 'ativo').length;
      el.pulso.innerHTML = trabalhando
        ? `<span class="d-luz d-luz--pulsa"></span>${trabalhando}`
        : ativos
          ? `${ativos} ativo${ativos > 1 ? 's' : ''}`
          : '';
      reagendar(trabalhando ? 3000 : 15000);
    } catch (err) {
      avisar(err.message, true);
      reagendar(15000);
    }
  }

  function reagendar(ms) {
    clearTimeout(timer);
    timer = setTimeout(carregar, ms);
  }

  // ------------------------------------------------------------ envio

  function ajustarAltura() {
    el.objetivo.style.height = 'auto';
    el.objetivo.style.height = `${Math.min(el.objetivo.scrollHeight, 220)}px`;
    // Barra de rolagem só quando passar do limite de altura.
    el.objetivo.style.overflowY = el.objetivo.scrollHeight > 220 ? 'auto' : 'hidden';
  }

  function pushNova(autor, html, extra = '') {
    conversaNova.push({ autor, html, extra });
    renderConversa({ rolar: true });
  }

  /** Dot novo: lê o pedido e mostra o que entendeu antes de criar. */
  async function enviarNovo(texto) {
    pedidoNovo = texto;
    planoConfirmado = null;
    // Pedido novo substitui a prévia anterior que ainda esperava confirmação.
    conversaNova = conversaNova.filter((m) => !m.previa);
    pushNova('editor', textoRico(texto));
    conversaNova.push({ autor: 'dot', html: '<p class="dc-digitando"><i></i><i></i><i></i> Lendo o pedido e procurando as fontes…</p>', previa: true });
    renderConversa({ rolar: true });
    try {
      const { plano, urls, resumo } = await api('/api/dots/previa', {
        method: 'POST',
        body: JSON.stringify({ objetivo: texto, ...configuracaoDaTela() }),
      });
      if (!el.nome.value.trim()) el.nome.value = plano.nome;
      planoConfirmado = { plano, urls, pendente: true };
      const temOnde = (plano.fontes || []).some((f) => f.url) || (plano.pesquisas || []).length;
      conversaNova = conversaNova.filter((m) => !m.previa);
      conversaNova.push({
        autor: 'dot',
        previa: true,
        html: `
          <div class="dc-plano">${htmlDoPlano(plano, { resumo })}</div>
          <div class="dc-chips">
            ${temOnde ? '<button type="button" class="dc-chip dc-chip--principal" data-acao="confirmar-novo">É isso, pode criar</button>' : ''}
            <button type="button" class="dc-chip" data-acao="ajustar-novo">Quero mudar</button>
            <button type="button" class="dc-chip" data-acao="abrir-ajustes">Ajustes (destino, página, imagem…)</button>
          </div>`,
      });
      renderConversa({ rolar: true });
    } catch (err) {
      conversaNova = conversaNova.filter((m) => !m.previa);
      pushNova('dot', `<p>⚠️ ${escapar(err.message)}</p>`, 'dc-msg--erro');
    }
  }

  async function criarDot() {
    if (!pedidoNovo || !planoConfirmado) return;
    const destino = destinoEscolhido();
    if (destino !== 'rascunho' && !el.pagina.value) {
      pushNova('dot', `<p>⚠️ Para ${destino === 'agendar' ? 'agendar' : 'publicar'}, escolha a página no <b>+</b> (Publicar em).</p>`, 'dc-msg--erro');
      return abrirAjustes();
    }
    conversaNova = conversaNova.filter((m) => !m.previa);
    pushNova('dot', '<p class="dc-digitando"><i></i><i></i><i></i> Criando e cadastrando as fontes…</p>');
    try {
      const r = await api('/api/dots', {
        method: 'POST',
        body: JSON.stringify({
          objetivo: pedidoNovo,
          nome: el.nome.value.trim() || null,
          provedor: el.provedor?.value || 'auto',
          facebook_page_id: el.pagina.value || null,
          // O mesmo plano que o editor viu: a IA pode responder diferente na 2ª vez.
          plano: planoConfirmado.plano,
          ...configuracaoDaTela(),
        }),
      });
      const falhas = Array.isArray(r.problemas) ? r.problemas : [];
      conversaNova = [];
      pedidoNovo = '';
      planoConfirmado = null;
      el.nome.value = '';
      avisar(falhas.length ? `Não entraram: ${falhas.slice(0, 3).join(' | ')}` : '', r.fontes === 0);
      await carregar();
      if (r.id) selecionar(r.id);
    } catch (err) {
      conversaNova.pop();
      pushNova('dot', `<p>⚠️ ${escapar(err.message)}</p>`, 'dc-msg--erro');
    }
  }

  /** Mensagem para um dot existente: vira um "Ajuste:" no comando dele. */
  async function enviarParaDot(dot, texto) {
    const id = String(dot.id);
    pendentes.set(id, [...(pendentes.get(id) || []), texto]);
    renderConversa({ rolar: true });
    try {
      const novoObjetivo = `${String(dot.objetivo || '').trim()}\n\nAjuste: ${texto}`;
      const r = await api(`/api/dots/${id}`, { method: 'PATCH', body: JSON.stringify({ objetivo: novoObjetivo }) });
      const falhas = Array.isArray(r.problemas) ? r.problemas : [];
      avisar(falhas.length ? `Não entraram: ${falhas.slice(0, 2).join(' | ')}` : '', false);
      detalhes.delete(id);
    } catch (err) {
      avisar(err.message, true);
      el.objetivo.value = texto;
      ajustarAltura();
    } finally {
      pendentes.set(id, (pendentes.get(id) || []).filter((p) => p !== texto));
      await carregar();
    }
  }

  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const texto = el.objetivo.value.trim();
    if (!texto) return;
    el.objetivo.value = '';
    ajustarAltura();
    avisar('');
    const dot = dotAtual();
    if (dot) enviarParaDot(dot, texto);
    else enviarNovo(texto);
  });

  el.objetivo.addEventListener('input', ajustarAltura);
  el.objetivo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el.composer.requestSubmit();
    }
  });

  // ---------------------------------------------------------- ajustes

  // ------------------------------------------------- modal "Novo dot"
  //
  // O "+" abre um modal com tudo do dot novo e o botão Salvar. O foco fica
  // preso no modal e volta para quem o abriu ao fechar.

  const modal = {
    caixa: el.ajustes?.querySelector('.dm-modal'),
    pedido: $('dm-pedido'),
    salvar: $('dm-salvar'),
    ver: $('dm-ver'),
    cancelar: $('dm-cancelar'),
    previa: $('dm-previa'),
    erro: $('dm-erro'),
  };
  let focoAntesDoModal = null;
  /** Id do dot sendo editado no modal; null = modal de dot novo. */
  let editandoId = null;

  function erroNoModal(texto) {
    modal.erro.textContent = texto || '';
    modal.erro.hidden = !texto;
  }

  function abrirAjustes() {
    focoAntesDoModal = document.activeElement;
    // O que já foi digitado na caixa do chat vira o pedido do dot novo.
    if (selecionado === 'novo' && !modal.pedido.value.trim() && el.objetivo.value.trim()) {
      modal.pedido.value = el.objetivo.value.trim();
    }
    erroNoModal('');
    el.ajustes.hidden = false;
    document.body.classList.add('dm-aberto');
    el.mais.setAttribute('aria-expanded', 'true');
    atualizarResumoAjustes();
    requestAnimationFrame(() => (modal.pedido.value.trim() ? el.nome : modal.pedido).focus());
  }
  function fecharAjustes() {
    if (editandoId) sairDaEdicao();
    el.ajustes.hidden = true;
    document.body.classList.remove('dm-aberto');
    el.mais.setAttribute('aria-expanded', 'false');
    atualizarResumoAjustes();
    if (focoAntesDoModal && document.contains(focoAntesDoModal)) focoAntesDoModal.focus();
  }

  /**
   * Prévia que o editor está vendo no modal: { texto, plano, resumo }. Salvar
   * manda ESTE plano (com o que ele tirou), não uma nova interpretação.
   */
  let previaModal = null;

  function desenharPreviaModal() {
    if (!previaModal) return;
    modal.previa.hidden = false;
    modal.previa.innerHTML = htmlDoPlano(previaModal.plano, { editavel: true, resumo: previaModal.resumo });
  }

  /** Prévia dentro do modal: o que o dot entendeu e onde vai procurar. */
  async function verPreviaNoModal() {
    const objetivo = modal.pedido.value.trim();
    if (!objetivo) {
      erroNoModal('Escreva o que o dot deve fazer.');
      return modal.pedido.focus();
    }
    erroNoModal('');
    modal.ver.disabled = true;
    modal.previa.hidden = false;
    modal.previa.innerHTML = '<p class="dc-digitando"><i></i><i></i><i></i> Lendo o pedido e procurando as fontes…</p>';
    try {
      const { plano, resumo } = await api('/api/dots/previa', {
        method: 'POST',
        body: JSON.stringify({ objetivo, ...configuracaoDaTela() }),
      });
      if (!el.nome.value.trim()) el.nome.value = plano.nome;
      previaModal = { texto: objetivo, plano, resumo };
      desenharPreviaModal();
      renderTopo();
    } catch (err) {
      previaModal = null;
      modal.previa.hidden = true;
      erroNoModal(err.message);
    } finally {
      modal.ver.disabled = false;
    }
  }

  /** Tira uma fonte ou pesquisa da prévia antes de salvar. */
  modal.previa.addEventListener('click', (e) => {
    const botao = e.target.closest('[data-tirar]');
    if (!botao || !previaModal) return;
    const i = Number(botao.dataset.indice);
    const lista = botao.dataset.tirar === 'pesquisa' ? previaModal.plano.pesquisas : previaModal.plano.fontes;
    if (Array.isArray(lista) && i >= 0 && i < lista.length) lista.splice(i, 1);
    desenharPreviaModal();
  });

  // Pedido mudou depois da prévia: a prévia deixa de valer (salvar interpreta de novo).
  modal.pedido.addEventListener('input', () => {
    if (previaModal && modal.pedido.value.trim() !== previaModal.texto) {
      previaModal = null;
      modal.previa.hidden = false;
      modal.previa.innerHTML = '<p class="dm-previa-velha">O pedido mudou. Clique em “Ver o que eu entendi” para conferir as fontes de novo — ou salve direto.</p>';
    }
  });

  // Exemplos de pedido, um clique.
  el.ajustes.addEventListener('click', (e) => {
    const exemplo = e.target.closest('[data-exemplo-modal]');
    if (!exemplo) return;
    modal.pedido.value = EXEMPLOS[Number(exemplo.dataset.exemploModal)]?.texto || '';
    modal.pedido.dispatchEvent(new Event('input'));
    modal.pedido.focus();
  });

  /** Salvar: cria o dot, fecha o modal e abre a conversa dele. */
  async function salvarDoModal() {
    if (editandoId) return salvarEdicao();
    const objetivo = modal.pedido.value.trim();
    if (!objetivo) {
      erroNoModal('Escreva o que o dot deve fazer.');
      return modal.pedido.focus();
    }
    const destino = destinoEscolhido();
    if (destino !== 'rascunho' && !el.pagina.value) {
      erroNoModal(`Para ${destino === 'agendar' ? 'agendar' : 'publicar'}, escolha a página em “Publicar em”.`);
      return el.pagina.focus();
    }
    const plano = previaModal && previaModal.texto === objetivo ? previaModal.plano : null;
    if (plano && !(plano.fontes || []).some((f) => f.url) && !(plano.pesquisas || []).length) {
      erroNoModal('Sobrou nenhuma fonte. Cole um link ou diga o assunto para eu pesquisar.');
      return modal.pedido.focus();
    }
    erroNoModal('');
    modal.salvar.disabled = true;
    modal.salvar.classList.add('is-carregando');
    modal.salvar.querySelector('span').textContent = plano ? 'Salvando…' : 'Procurando as fontes…';
    try {
      const r = await api('/api/dots', {
        method: 'POST',
        body: JSON.stringify({
          objetivo,
          nome: el.nome.value.trim() || null,
          provedor: el.provedor?.value || 'auto',
          facebook_page_id: el.pagina.value || null,
          plano,
          ...configuracaoDaTela(),
        }),
      });
      const falhas = Array.isArray(r.problemas) ? r.problemas : [];
      previaModal = null;
      modal.pedido.value = '';
      modal.previa.hidden = true;
      modal.previa.innerHTML = '';
      el.nome.value = '';
      el.objetivo.value = '';
      ajustarAltura();
      conversaNova = [];
      pedidoNovo = '';
      planoConfirmado = null;
      fecharAjustes();
      avisar(
        falhas.length
          ? `Dot criado, mas não entraram: ${falhas.slice(0, 3).join(' | ')}`
          : `Dot criado com ${r.fontes ?? 0} ${r.fontes === 1 ? 'fonte' : 'fontes'}. Já vou começar a ler.`,
        r.fontes === 0
      );
      await carregar();
      if (r.id) selecionar(r.id);
    } catch (err) {
      erroNoModal(err.message);
    } finally {
      modal.salvar.disabled = false;
      modal.salvar.classList.remove('is-carregando');
      modal.salvar.querySelector('span').textContent = 'Salvar';
    }
  }

  // ------------------------------------------------- modal "Editar dot"
  //
  // O mesmo modal do dot novo, preenchido com o que o dot usa hoje. Salvar
  // manda só um PATCH: o histórico e a contagem do dia continuam.

  const tituloModal = $('dm-titulo');
  const exemplosModal = el.ajustes?.querySelector('.dm-exemplos');

  function marcarRadio(nome, valor) {
    const radio = document.querySelector(`input[name="${nome}"][value="${valor}"]`);
    if (radio) radio.checked = true;
  }

  /** Põe o valor no select; se a opção não existir (valor antigo), cria. */
  function escolherNoSelect(select, valor, texto) {
    if (!select) return;
    const v = valor === null || valor === undefined ? '' : String(valor);
    if (![...select.options].some((o) => o.value === v)) select.append(new Option(texto || v, v));
    select.value = v;
  }

  function preencherCampos(dot) {
    el.nome.value = dot.nome || '';
    modal.pedido.value = dot.objetivo || '';
    marcarRadio('dot-destino', dot.destino || 'rascunho');
    marcarRadio('dot-imagem', dot.modo_imagem || 'original');
    escolherNoSelect(el.saidaQtd, dot.saida_quantidade || 1);
    escolherNoSelect(el.saidaMin, dot.saida_minutos || 15, `${dot.saida_minutos} min`);
    escolherNoSelect(el.pagina, dot.facebook_page_id || '', dot.pagina || `Página ${dot.facebook_page_id}`);
    const dias = String(dot.dias_semana || '').split(',').map(Number).filter(Boolean);
    for (const b of el.dias.querySelectorAll('.d-dia')) {
      const ligado = !dias.length || dias.includes(Number(b.dataset.dia));
      b.classList.toggle('is-on', ligado);
      b.setAttribute('aria-pressed', String(ligado));
    }
    escolherNoSelect(el.horaInicio, dot.hora_inicio ?? '');
    escolherNoSelect(el.horaFim, dot.hora_fim ?? '');
    escolherNoSelect(el.scan, dot.scan_minutos || 60, `${dot.scan_minutos} min`);
    el.limite.value = String(dot.limite_dia || 20);
    if (el.provedor) escolherNoSelect(el.provedor, dot.provedor || 'auto');
    ajustarDestino();
    ajustarImagem();
  }

  /** Volta os campos ao padrão do dot novo. */
  function restaurarPadroes() {
    el.nome.value = '';
    modal.pedido.value = '';
    marcarRadio('dot-destino', 'rascunho');
    marcarRadio('dot-imagem', 'original');
    el.saidaQtd.value = '1';
    el.saidaMin.value = '15';
    for (const b of el.dias.querySelectorAll('.d-dia')) {
      b.classList.add('is-on');
      b.setAttribute('aria-pressed', 'true');
    }
    el.horaInicio.value = '';
    el.horaFim.value = '';
    el.scan.value = '60';
    el.limite.value = '20';
    if (el.provedor) el.provedor.value = 'auto';
    const padrao = paginasCache.find((p) => p.is_default);
    el.pagina.value = padrao ? String(padrao.id) : '';
    ajustarDestino();
    ajustarImagem();
  }

  function abrirEdicao(dot) {
    editandoId = String(dot.id);
    previaModal = null;
    modal.previa.hidden = true;
    modal.previa.innerHTML = '';
    tituloModal.textContent = `Editar “${dot.nome}”`;
    modal.ver.hidden = true;
    if (exemplosModal) exemplosModal.hidden = true;
    preencherCampos(dot);
    abrirAjustes();
  }

  function sairDaEdicao() {
    editandoId = null;
    tituloModal.textContent = 'Novo dot';
    modal.ver.hidden = false;
    if (exemplosModal) exemplosModal.hidden = false;
    restaurarPadroes();
  }

  async function salvarEdicao() {
    const id = editandoId;
    const dot = ultimaLista.find((d) => String(d.id) === id);
    const objetivo = modal.pedido.value.trim();
    const nome = el.nome.value.trim();
    if (!nome) {
      erroNoModal('Dê um nome ao dot.');
      return el.nome.focus();
    }
    if (!objetivo) {
      erroNoModal('Escreva o que o dot deve fazer.');
      return modal.pedido.focus();
    }
    const destino = destinoEscolhido();
    if (destino !== 'rascunho' && !el.pagina.value) {
      erroNoModal(`Para ${destino === 'agendar' ? 'agendar' : 'publicar'}, escolha a página em “Publicar em”.`);
      return el.pagina.focus();
    }
    const mudouPedido = objetivo !== String(dot?.objetivo || '').trim();
    erroNoModal('');
    modal.salvar.disabled = true;
    modal.salvar.classList.add('is-carregando');
    modal.salvar.querySelector('span').textContent = mudouPedido ? 'Procurando as fontes…' : 'Salvando…';
    try {
      const r = await api(`/api/dots/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          nome,
          objetivo,
          provedor: el.provedor?.value || 'auto',
          facebook_page_id: el.pagina.value || null,
          ...configuracaoDaTela(),
        }),
      });
      const falhas = Array.isArray(r.problemas) ? r.problemas : [];
      detalhes.delete(id);
      fecharAjustes();
      avisar(
        falhas.length
          ? `Dot atualizado, mas não entraram: ${falhas.slice(0, 3).join(' | ')}`
          : 'Dot atualizado. Vale a partir da próxima matéria.',
        falhas.length > 0
      );
      await carregar();
    } catch (err) {
      erroNoModal(err.message);
    } finally {
      modal.salvar.disabled = false;
      modal.salvar.classList.remove('is-carregando');
      modal.salvar.querySelector('span').textContent = 'Salvar';
    }
  }

  // Foco preso no modal (Tab/Shift+Tab giram dentro dele).
  el.ajustes.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focaveis = [...modal.caixa.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
      .filter((n) => !n.disabled && n.offsetParent !== null);
    if (!focaveis.length) return;
    const primeiro = focaveis[0];
    const ultimo = focaveis[focaveis.length - 1];
    if (e.shiftKey && document.activeElement === primeiro) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && document.activeElement === ultimo) {
      e.preventDefault();
      primeiro.focus();
    }
  });
  // Ctrl+Enter salva de qualquer campo.
  el.ajustes.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      salvarDoModal();
    }
  });
  // Clique fora do modal fecha.
  el.ajustes.addEventListener('mousedown', (e) => {
    if (e.target === el.ajustes) fecharAjustes();
  });

  el.mais.addEventListener('click', () => comecarNovo());
  el.ajustesFechar.addEventListener('click', fecharAjustes);
  modal.cancelar.addEventListener('click', fecharAjustes);
  modal.salvar.addEventListener('click', salvarDoModal);
  modal.ver.addEventListener('click', verPreviaNoModal);
  el.resumoAjustes.addEventListener('click', abrirAjustes);

  // ---------------------------------------------------------- lateral

  function abrirLateral() {
    el.lateral.classList.add('is-aberta');
    el.fundoLateral.hidden = false;
  }
  function fecharLateral() {
    el.lateral.classList.remove('is-aberta');
    el.fundoLateral.hidden = true;
  }
  el.abrirLateral.addEventListener('click', abrirLateral);
  el.fecharLateral.addEventListener('click', fecharLateral);
  el.fundoLateral.addEventListener('click', fecharLateral);
  // ------------------------------------------- "+": Para: (como no Grok)

  let destaquePara = 0;

  function opcoesPara() {
    const termo = String(el.paraBusca.value || '').trim();
    const filtro = termo.toLowerCase();
    const dots = ultimaLista.filter((d) => !filtro || String(d.nome || '').toLowerCase().includes(filtro));
    return [{ id: 'novo', termo }, ...dots.map((d) => ({ id: String(d.id), dot: d }))];
  }

  function renderMenuPara() {
    const opcoes = opcoesPara();
    // Digitou algo que bate com um dot: ele vem destacado; senão, "Criar novo".
    if (destaquePara >= opcoes.length) destaquePara = 0;
    el.paraMenu.innerHTML = opcoes
      .map((o, i) => {
        const ativo = i === destaquePara ? ' is-on' : '';
        if (o.id === 'novo') {
          return `<button type="button" role="option" class="dc-para-item${ativo}" data-para="novo" aria-selected="${Boolean(ativo)}">
            <span class="dc-para-icone" aria-hidden="true">+</span>
            <span>Criar novo dot${o.termo ? ` “${escapar(o.termo)}”` : ''}</span>
          </button>`;
        }
        return `<button type="button" role="option" class="dc-para-item${ativo}" data-para="${o.id}" aria-selected="${Boolean(ativo)}">
          ${avatar(o.dot, 'dc-avatar--mini')}
          <span>${escapar(o.dot.nome)}</span>
        </button>`;
      })
      .join('');
  }

  function mostrarPara() {
    fecharLateral();
    fecharPainel();
    el.para.hidden = false;
    el.topo.hidden = true;
    el.paraBusca.value = '';
    destaquePara = 0;
    renderMenuPara();
    el.paraBusca.focus();
  }

  function esconderPara() {
    if (el.para.hidden) return;
    el.para.hidden = true;
    el.topo.hidden = false;
  }

  /** "Criar novo dot": abre o modal com o nome, o pedido e os ajustes. */
  function comecarNovo(nomeInicial) {
    esconderPara();
    selecionar('novo');
    if (nomeInicial) el.nome.value = nomeInicial;
    abrirAjustes();
    renderTopo();
  }

  function escolherPara(id) {
    if (id === 'novo') return comecarNovo(String(el.paraBusca.value || '').trim());
    esconderPara();
    selecionar(id);
  }

  // "+" da lateral: abre o modal do dot novo.
  el.novo.addEventListener('click', (e) => {
    e.stopPropagation();
    comecarNovo();
  });
  el.paraBusca.addEventListener('input', () => {
    const opcoes = opcoesPara();
    // Com texto, o 1º dot que bate fica destacado; sem dot, "Criar novo".
    destaquePara = el.paraBusca.value.trim() && opcoes.length > 1 ? 1 : 0;
    renderMenuPara();
  });
  el.paraBusca.addEventListener('keydown', (e) => {
    const total = opcoesPara().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      destaquePara = (destaquePara + (e.key === 'ArrowDown' ? 1 : -1) + total) % total;
      renderMenuPara();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      escolherPara(opcoesPara()[destaquePara]?.id || 'novo');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      esconderPara();
    }
  });
  el.paraMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-para]');
    if (item) escolherPara(item.dataset.para);
  });
  document.addEventListener('click', (e) => {
    if (!el.para.hidden && !el.para.contains(e.target)) esconderPara();
  });
  el.nome.addEventListener('input', renderTopo);
  el.buscar.addEventListener('click', () => {
    el.busca.hidden = !el.busca.hidden;
    el.buscar.setAttribute('aria-expanded', String(!el.busca.hidden));
    if (!el.busca.hidden) el.busca.focus();
    else {
      el.busca.value = '';
      renderLateral();
    }
  });
  el.busca.addEventListener('input', renderLateral);
  el.lista.addEventListener('click', (e) => {
    const mais = e.target.closest('[data-menu-dot]');
    if (mais) {
      e.stopPropagation();
      return abrirMenuDot(mais.dataset.menuDot, mais);
    }
    const item = e.target.closest('[data-abrir]');
    if (item) selecionar(item.dataset.abrir);
  });
  el.lista.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('[data-abrir]');
    if (!item) return;
    e.preventDefault();
    abrirMenuDot(item.dataset.abrir, item, { x: e.clientX, y: e.clientY });
  });
  el.lista.addEventListener('scroll', fecharMenu);
  el.lista.addEventListener('keydown', (e) => {
    const item = e.target.closest('[data-abrir]');
    if (!item || e.target.closest('[data-menu-dot]')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selecionar(item.dataset.abrir);
    }
  });

  el.painelFechar.addEventListener('click', fecharPainel);
  el.painelFundo.addEventListener('click', fecharPainel);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.painel.hidden) fecharPainel();
    else if (!el.ajustes.hidden) fecharAjustes();
  });

  // ------------------------------------------------- ações nas matérias

  function materiaDoDot(dotId, matterId) {
    const d = detalhes.get(String(dotId));
    return (d?.materias || []).find((m) => Number(m.id) === Number(matterId))
      || (d?.execucoes || []).map((e) => e.materia).find((m) => m && Number(m.id) === Number(matterId))
      || null;
  }

  /** Página onde a matéria vai sair: a dela, a do dot ou a padrão da conta. */
  function paginaInicial(m, dot) {
    const padrao = paginasCache.find((p) => p.is_default) || paginasCache[0];
    return String(m.facebook_page_id || dot.facebook_page_id || padrao?.id || '');
  }

  function seletorDePagina(id, selecionada) {
    if (!paginasCache.length) {
      return '<p class="dc-ag-erro">Nenhuma página do Facebook ligada à sua conta. Conecte uma em Páginas.</p>';
    }
    return `
      <label class="dc-ag-rotulo" for="${id}">Publicar em</label>
      <select id="${id}" class="dc-dialogo-campo dc-dialogo-select" data-pagina-escolhida>
        ${paginasCache.map((p) => `<option value="${p.id}"${String(p.id) === String(selecionada) ? ' selected' : ''}>${escapar(p.page_name || `Página ${p.id}`)}${p.is_default ? ' (padrão)' : ''}</option>`).join('')}
      </select>`;
  }

  /**
   * Diálogo com campos próprios (publicar, agendar). `ler(fundo)` devolve o
   * resultado — ou null para manter o diálogo aberto (ex.: horário inválido).
   */
  function dialogoComCampos(html, ler) {
    return new Promise((resolve) => {
      const fundo = document.createElement('div');
      fundo.className = 'dc-dialogo-fundo';
      fundo.innerHTML = html;
      document.body.append(fundo);
      const fechar = (valor) => {
        fundo.classList.remove('is-on');
        setTimeout(() => fundo.remove(), 180);
        document.removeEventListener('keydown', teclas, true);
        resolve(valor);
      };
      const confirmar = () => {
        const valor = ler(fundo);
        if (valor) fechar(valor);
      };
      const teclas = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          fechar(null);
        } else if (e.key === 'Enter' && e.target?.tagName !== 'SELECT') {
          e.preventDefault();
          confirmar();
        }
      };
      document.addEventListener('keydown', teclas, true);
      fundo.addEventListener('click', (e) => {
        if (e.target === fundo) return fechar(null);
        const atalho = e.target.closest('[data-ag]');
        if (atalho) {
          const campo = fundo.querySelector('#dc-ag-quando');
          const v = atalho.dataset.ag;
          campo.value = v === 'amanha'
            ? `${dataLocal(Date.now() + 86_400_000).slice(0, 10)}T08:00`
            : dataLocal(Date.now() + Number(v) * 60_000);
          fundo.querySelector('.dc-ag-erro').hidden = true;
          return;
        }
        const botao = e.target.closest('[data-resposta]');
        if (botao && !botao.disabled) {
          if (botao.dataset.resposta === 'sim') confirmar();
          else fechar(null);
        }
      });
      requestAnimationFrame(() => fundo.classList.add('is-on'));
      (fundo.querySelector('#dc-ag-quando') || fundo.querySelector('[data-resposta="sim"]'))?.focus();
    });
  }

  /** Confirma a publicação e deixa escolher a página. Devolve { paginaId } ou null. */
  function dialogoPublicar(m, dot) {
    return dialogoComCampos(`
      <div class="dc-dialogo dc-dialogo--agendar" role="dialog" aria-modal="true" aria-labelledby="dc-pub-titulo">
        <h3 id="dc-pub-titulo">Publicar agora?</h3>
        <p class="dc-ag-materia">${escapar(m.titulo || 'Matéria')}<small>Vai ao ar assim que você confirmar.</small></p>
        ${seletorDePagina('dc-pub-pagina', paginaInicial(m, dot))}
        <div class="dc-dialogo-acoes">
          <button type="button" class="dc-botao" data-resposta="nao">Cancelar</button>
          <button type="button" class="dc-botao dc-botao--principal" data-resposta="sim"${paginasCache.length ? '' : ' disabled'}>${icone('enviar')}<span>Publicar agora</span></button>
        </div>
      </div>`, (fundo) => {
      const paginaId = fundo.querySelector('[data-pagina-escolhida]')?.value;
      return paginaId ? { paginaId } : null;
    });
  }

  /**
   * Dia, hora e página para agendar, com atalhos. Começa no próximo horário
   * livre da agenda (o mesmo do /materia-manual) ou no horário atual, se já
   * agendada. Devolve { quando: "AAAA-MM-DDTHH:mm" (Brasília), paginaId } ou null.
   */
  async function dialogoAgendar(m, dot) {
    let inicial = null;
    if (m.status === 'agendado' && m.agendada_para) {
      inicial = dataLocal(new Date(m.agendada_para).getTime());
    } else {
      try {
        inicial = (await api('/api/materias-ia/agenda/proximo-slot'))?.proximoSlotLocal || null;
      } catch {
        inicial = null;
      }
    }
    const minimo = dataLocal(Date.now() + 2 * 60_000);
    if (!inicial || inicial < minimo) inicial = dataLocal(Date.now() + 30 * 60_000);

    return dialogoComCampos(`
      <div class="dc-dialogo dc-dialogo--agendar" role="dialog" aria-modal="true" aria-labelledby="dc-ag-titulo">
        <h3 id="dc-ag-titulo">${m.status === 'agendado' ? 'Mudar o horário' : 'Agendar publicação'}</h3>
        <p class="dc-ag-materia">${escapar(m.titulo || 'Matéria')}</p>
        <label class="dc-ag-rotulo" for="dc-ag-quando">Dia e hora (horário de Brasília)</label>
        <input id="dc-ag-quando" type="datetime-local" class="dc-dialogo-campo" value="${inicial}" min="${minimo}" step="300" />
        <div class="dc-ag-atalhos" role="group" aria-label="Atalhos de horário">
          <button type="button" data-ag="30">+30 min</button>
          <button type="button" data-ag="60">+1 hora</button>
          <button type="button" data-ag="180">+3 horas</button>
          <button type="button" data-ag="amanha">Amanhã 8h</button>
        </div>
        ${seletorDePagina('dc-ag-pagina', paginaInicial(m, dot))}
        <p class="dc-ag-erro" role="alert" hidden></p>
        <div class="dc-dialogo-acoes">
          <button type="button" class="dc-botao" data-resposta="nao">Cancelar</button>
          <button type="button" class="dc-botao dc-botao--principal" data-resposta="sim"${paginasCache.length ? '' : ' disabled'}>${icone('calendario')}<span>Agendar</span></button>
        </div>
      </div>`, (fundo) => {
      const campo = fundo.querySelector('#dc-ag-quando');
      const erroAg = fundo.querySelector('.dc-ag-erro');
      const quando = campo.value;
      if (!quando || quando < dataLocal(Date.now() + 60_000)) {
        erroAg.hidden = false;
        erroAg.textContent = 'Escolha um dia e hora no futuro.';
        campo.focus();
        return null;
      }
      const paginaId = fundo.querySelector('[data-pagina-escolhida]')?.value;
      return paginaId ? { quando, paginaId } : null;
    });
  }

  /** Grava a página escolhida na matéria, se mudou. */
  async function garantirPagina(m, paginaId) {
    if (!paginaId || String(paginaId) === String(m.facebook_page_id || '')) return;
    await api(`/api/materias-ia/matters/${m.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ facebook_page_id: Number(paginaId) }),
    });
  }

  /** Publicar, agendar, desagendar, imagem com IA e editar uma matéria do dot. */
  async function executarNaMateria(dot, m, acao, botao = null) {
    const original = botao?.innerHTML;
    const travar = (texto) => {
      if (!botao) return;
      botao.disabled = true;
      botao.innerHTML = `<span>${texto}</span>`;
    };
    try {
      if (acao === 'editar') {
        window.open(`/materias-ia/${m.id}`, '_blank', 'noopener');
        return;
      }
      if (acao === 'publicar') {
        const escolha = await dialogoPublicar(m, dot);
        if (!escolha) return;
        travar('Publicando…');
        await garantirPagina(m, escolha.paginaId);
        const publicar = (confirmarRepetida = false) => api(`/api/materias-ia/matters/${m.id}/publicar`, {
          method: 'POST',
          body: JSON.stringify({ facebook_page_id: Number(escolha.paginaId), tipo_publicacao: 'auto', confirmarRepetida }),
        });
        let r;
        try {
          r = await publicar();
        } catch (err) {
          // A página já tem a mesma notícia: pergunta em vez de virar rascunho.
          if (err.code !== 'NOTICIA_REPETIDA') throw err;
          const mesmoAssim = await dialogo({ titulo: 'Notícia repetida', texto: err.message, confirmar: 'Publicar mesmo assim' });
          if (!mesmoAssim) {
            if (botao) {
              botao.disabled = false;
              botao.innerHTML = original;
            }
            return;
          }
          r = await publicar(true);
        }
        avisar(r.queued ? 'Na fila de publicação — sai em instantes.' : 'Publicada ✓');
      } else if (acao === 'agendar') {
        const escolha = await dialogoAgendar(m, dot);
        if (!escolha) return;
        travar('Agendando…');
        await garantirPagina(m, escolha.paginaId);
        const r = await api(`/api/materias-ia/matters/${m.id}/agendar`, {
          method: 'POST',
          body: JSON.stringify({ run_at: escolha.quando }),
        });
        avisar(`Agendada para ${diaHora(r.runAt || escolha.quando)} ✓`);
      } else if (acao === 'desagendar') {
        const ok = await dialogo({
          titulo: 'Desagendar?',
          texto: `“${m.titulo || 'Matéria'}” volta a rascunho e não sai mais no horário marcado.`,
          confirmar: 'Desagendar',
          perigo: true,
        });
        if (!ok) return;
        await api(`/api/materias-ia/matters/${m.id}/desagendar`, { method: 'POST' });
        avisar('Desagendada. Voltou para rascunho.');
      } else if (acao === 'imagem' || acao === 'limpar') {
        if (m.gerando_imagem) return avisar('A imagem desta matéria já está sendo gerada.');
        await api(`/api/dots/${dot.id}/materias/${m.id}/imagem`, {
          method: 'POST',
          body: JSON.stringify({ modo: acao === 'limpar' ? 'limpar_texto' : 'recriar' }),
        });
        avisar('Gerando a imagem com IA. Leva alguns minutos — a nova arte aparece aqui.');
      }
      detalhes.delete(String(dot.id));
      await carregar();
    } catch (err) {
      avisar(err.message, true);
      if (botao?.isConnected) {
        botao.disabled = false;
        botao.innerHTML = original;
      }
    }
  }

  function acaoNaMateria(dotId, matterId, acao, botao) {
    const dot = ultimaLista.find((d) => String(d.id) === String(dotId));
    const m = materiaDoDot(dotId, matterId);
    if (!dot || !m) return avisar('Não achei esta matéria. Atualize a página.', true);
    if (acao === 'mais-materia') {
      const itens = [
        { icone: 'abrir', texto: 'Abrir e editar a matéria', acao: 'editar' },
        'separador',
        { icone: 'varinha', texto: m.gerando_imagem ? 'Gerando imagem…' : 'Gerar imagem nova com IA', acao: 'imagem' },
        { icone: 'imagem', texto: 'Limpar texto da imagem com IA', acao: 'limpar' },
      ];
      if (m.status === 'agendado') {
        itens.push('separador', { icone: 'desagendar', texto: 'Desagendar (volta a rascunho)', acao: 'desagendar', perigo: true });
      }
      return abrirMenu(botao, itens, (escolha) => executarNaMateria(dot, m, escolha));
    }
    return executarNaMateria(dot, m, acao === 'publicar-materia' ? 'publicar' : 'agendar', botao);
  }

  // --------------------------------------------------- fontes do dot

  async function removerFonteDoDot(dotId, fonteId, botao) {
    const d = detalhes.get(String(dotId));
    const f = (d?.fontes_lista || []).find((x) => Number(x.id) === Number(fonteId));
    const nome = f ? (f.plataforma === 'busca' ? `a pesquisa “${f.termo || f.nome}”` : f.nome) : 'esta fonte';
    const ok = await dialogo({
      titulo: 'Tirar esta fonte?',
      texto: `O dot deixa de ler ${nome}. Ela continua na sua Biblioteca.`,
      confirmar: 'Tirar',
      perigo: true,
    });
    if (!ok) return;
    botao.disabled = true;
    try {
      await api(`/api/dots/${dotId}/fontes/${fonteId}`, { method: 'DELETE' });
      avisar('Fonte retirada.');
      detalhes.delete(String(dotId));
      await carregar();
    } catch (err) {
      avisar(err.message, true);
      if (botao.isConnected) botao.disabled = false;
    }
  }

  el.painelCorpo.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-form="adicionar-fonte"]');
    if (!form) return;
    e.preventDefault();
    const id = form.closest('[data-dot]')?.dataset.dot;
    const tipo = form.elements.tipo.value;
    const texto = form.elements.texto.value.trim();
    if (!id || !texto) return;
    const botao = form.querySelector('button[type="submit"]');
    botao.disabled = true;
    botao.textContent = tipo === 'busca' || /^https?:\/\//i.test(texto) ? 'Acrescentando…' : 'Procurando…';
    try {
      const r = await api(`/api/dots/${id}/fontes`, { method: 'POST', body: JSON.stringify({ tipo, texto }) });
      avisar(r.adicionada?.pesquisa
        ? `Pesquisa “${r.adicionada.pesquisa}” acrescentada. Vou ler agora.`
        : `Fonte acrescentada: ${r.adicionada?.nome || texto}. Vou ler agora.`);
      form.elements.texto.value = '';
      form.elements.texto.blur();
      detalhes.delete(String(id));
      await carregar();
    } catch (err) {
      avisar(err.message, true);
    } finally {
      if (botao.isConnected) {
        botao.disabled = false;
        botao.textContent = 'Acrescentar';
      }
    }
  });

  el.painelCorpo.addEventListener('change', (e) => {
    if (!e.target.matches('.d-fonte-nova select[name="tipo"]')) return;
    const campo = e.target.form?.elements?.texto;
    if (campo) campo.placeholder = DICA_FONTE_NOVA[e.target.value] || '';
  });

  // ------------------------------------------------------------ ações

  el.shell.addEventListener('click', async (e) => {
    const botao = e.target.closest('[data-acao]');
    if (!botao || botao.disabled) return;
    const acao = botao.dataset.acao;

    if (acao === 'exemplo') {
      el.objetivo.value = EXEMPLOS[Number(botao.dataset.exemplo)]?.texto || '';
      ajustarAltura();
      el.objetivo.focus();
      return;
    }
    if (acao === 'confirmar-novo') {
      botao.disabled = true;
      return criarDot();
    }
    if (acao === 'ajustar-novo') {
      conversaNova = conversaNova.filter((m) => !m.previa);
      planoConfirmado = null;
      el.objetivo.value = pedidoNovo;
      ajustarAltura();
      renderConversa();
      el.objetivo.focus();
      return;
    }
    if (acao === 'abrir-ajustes') return abrirAjustes();

    const id = botao.closest('[data-dot]')?.dataset.dot;
    if (!id) return;

    if (['publicar-materia', 'agendar-materia', 'mais-materia'].includes(acao)) {
      const cartao = botao.closest('[data-materia]');
      if (cartao) acaoNaMateria(id, Number(cartao.dataset.materia), acao, botao);
      return;
    }
    if (acao === 'remover-fonte') return removerFonteDoDot(id, Number(botao.dataset.fonte), botao);
    if (acao === 'painel') return abrirPainel(botao.dataset.aba);
    if (acao === 'aba') {
      abas.set(String(id), botao.dataset.aba);
      if (botao.dataset.aba !== 'config') editando.clear();
      return renderPainel();
    }
    if (acao === 'filtro-posts') {
      filtrosPosts.set(String(id), botao.dataset.filtro);
      return renderPainel();
    }
    if (acao === 'escrever-post') {
      botao.disabled = true;
      botao.textContent = 'Escrevendo…';
      try {
        await api(`/api/dots/${id}/posts/${botao.dataset.post}/escrever`, { method: 'POST' });
        avisar('Escrevendo este post agora. A matéria aparece aqui assim que ficar pronta.');
        detalhes.delete(String(id));
        await carregar();
      } catch (err) {
        avisar(err.message, true);
        botao.disabled = false;
        botao.textContent = '✍️ Escrever agora';
      }
      return;
    }
    if (acao === 'editar-comando') {
      const dot = ultimaLista.find((d) => String(d.id) === String(id));
      editando.set(String(id), dot?.objetivo || '');
      renderPainel();
      el.painelCorpo.querySelector('[data-comando-texto]')?.focus();
      return;
    }
    if (acao === 'cancelar-comando') {
      editando.delete(String(id));
      return renderPainel();
    }
    if (acao === 'salvar-comando') {
      const texto = String(editando.get(String(id)) || '').trim();
      if (!texto) return avisar('Escreva o que o dot deve fazer.', true);
      botao.disabled = true;
      botao.textContent = 'Lendo o novo comando…';
      try {
        const r = await api(`/api/dots/${id}`, { method: 'PATCH', body: JSON.stringify({ objetivo: texto }) });
        editando.delete(String(id));
        const falhas = Array.isArray(r.problemas) ? r.problemas : [];
        avisar(falhas.length ? `Não entraram: ${falhas.slice(0, 2).join(' | ')}` : 'Comando atualizado.');
        detalhes.delete(String(id));
        await carregar();
      } catch (err) {
        avisar(err.message, true);
        botao.disabled = false;
        botao.textContent = 'Salvar comando';
      }
      return;
    }
    if (acao === 'menu-topo') return abrirMenuDot(id, botao);
    if (!['rodar', 'pausar', 'retomar', 'excluir'].includes(acao)) return;
    botao.disabled = true;
    const feito = await executarAcao(id, acao);
    if (!feito && botao.isConnected) botao.disabled = false;
  });

  function itensDoMenu(dot) {
    return [
      { icone: 'abrir', texto: 'Abrir conversa', acao: 'abrir' },
      { icone: 'play', texto: 'Trabalhar agora', acao: 'rodar' },
      dot.estado === 'ativo'
        ? { icone: 'pausa', texto: 'Pausar', acao: 'pausar' }
        : { icone: 'play', texto: 'Retomar', acao: 'retomar' },
      'separador',
      { icone: 'lapis', texto: 'Editar dot', acao: 'editar' },
      { icone: 'engrenagem', texto: 'Configuração', acao: 'configuracao' },
      'separador',
      { icone: 'lixo', texto: 'Excluir dot', acao: 'excluir', perigo: true },
    ];
  }

  function abrirMenuDot(id, ancora, ponto = null) {
    const dot = ultimaLista.find((d) => String(d.id) === String(id));
    if (!dot) return;
    abrirMenu(ancora, itensDoMenu(dot), (acao) => executarAcao(id, acao), ponto);
  }

  /** Executa uma ação do dot. Devolve true quando deu certo. */
  async function executarAcao(id, acao) {
    const dot = ultimaLista.find((d) => String(d.id) === String(id));
    if (!dot) return false;
    if (acao === 'abrir') {
      selecionar(id);
      return true;
    }
    if (acao === 'editar') {
      abrirEdicao(dot);
      return true;
    }
    if (acao === 'configuracao') {
      if (selecionado !== String(id)) selecionar(id);
      abrirPainel('config');
      return true;
    }
    if (acao === 'excluir') {
      const ok = await dialogo({
        titulo: `Excluir “${dot.nome}”?`,
        texto: 'O dot para de trabalhar e some da lista. As matérias já escritas e as páginas na Biblioteca continuam.',
        confirmar: 'Excluir',
        perigo: true,
      });
      if (!ok) return false;
    }
    try {
      if (acao === 'excluir') {
        await api(`/api/dots/${id}`, { method: 'DELETE' });
        logs.delete(String(id));
        detalhes.delete(String(id));
        fecharPainel();
        if (selecionado === String(id)) selecionado = 'novo';
        avisar(`“${dot.nome}” excluído.`);
      } else {
        await api(`/api/dots/${id}/${acao}`, { method: 'POST' });
        avisar(acao === 'rodar' ? 'Começando agora…' : acao === 'pausar' ? 'Dot pausado.' : 'Dot retomado.');
      }
      await carregar();
      return true;
    } catch (err) {
      avisar(err.message, true);
      return false;
    }
  }

  el.painelCorpo.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-provedor]')) return;
    const id = e.target.closest('[data-dot]')?.dataset.dot;
    if (!id) return;
    try {
      await api(`/api/dots/${id}`, { method: 'PATCH', body: JSON.stringify({ provedor: e.target.value }) });
      avisar('IA do dot atualizada.');
    } catch (err) {
      avisar(err.message, true);
    }
  });

  el.painelCorpo.addEventListener('input', (e) => {
    if (!e.target.matches('[data-comando-texto]')) return;
    const id = e.target.closest('[data-dot]')?.dataset.dot;
    if (id) editando.set(String(id), e.target.value);
  });

  async function salvarNome(campo) {
    const id = campo.closest('[data-dot]')?.dataset.dot;
    const nome = campo.value.trim();
    if (!id || !nome || nome === campo.defaultValue) return;
    try {
      await api(`/api/dots/${id}`, { method: 'PATCH', body: JSON.stringify({ nome }) });
      campo.defaultValue = nome;
      avisar('Nome salvo.');
      await carregar();
    } catch (err) {
      campo.value = campo.defaultValue;
      avisar(err.message, true);
    }
  }

  el.painelCorpo.addEventListener('blur', (e) => {
    if (e.target.matches('[data-nome]')) salvarNome(e.target);
  }, true);
  el.painelCorpo.addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-nome]')) return;
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape') { e.target.value = e.target.defaultValue; e.target.blur(); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else carregar();
  });

  montarCampos();
  carregarProvedores();
  carregarPaginas();
  renderConversa({ rolar: true });
  carregar();
})();
