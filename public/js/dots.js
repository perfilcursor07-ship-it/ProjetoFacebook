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
    imagemTexto: $('dot-imagem-texto'),
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
    ajustarDestino();
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
      gerar_imagem_com_texto: Boolean(el.imagemTexto.checked),
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
  };

  const icone = (nome) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[nome]}</svg>`;

  async function api(url, opcoes = {}) {
    const resp = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opcoes });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(dados.error || dados.message || `Erro ${resp.status}`);
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

  async function carregarPaginas() {
    try {
      const dados = await api('/api/facebook/pages');
      const paginas = Array.isArray(dados.pages) ? dados.pages : [];
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
        <span class="d-stat">${icone('paginas')}<b>${dot.fontes}</b> páginas</span>
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
    if (e.acao === 'criou_fonte') return { icone: '📡', rotulo: 'Páginas monitoradas', classe: '' };
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
    const palavras = Array.isArray(plano.palavras) && plano.palavras.length
      ? `procuro <b>${escapar(plano.palavras.join(', '))}</b>`
      : 'pego <b>qualquer assunto</b>';
    const destino = dot.destino === 'agendar'
      ? `agendo 1 a cada ${dot.agendar_minutos || dot.intervalo_minutos} min`
      : dot.destino === 'publicar' ? 'publico na hora' : 'deixo em rascunho';
    const pagina = dot.pagina ? ` em <b>${escapar(dot.pagina)}</b>` : ' <span class="d-aviso-mini">(sem página definida)</span>';
    return `Leio ${dot.fontes} ${dot.fontes === 1 ? 'página' : 'páginas'}, ${palavras} e ${destino}${pagina}.`;
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
      return `<div class="d-banner d-banner--erro">⚠️ <span><b>Precisa de atenção:</b> ${escapar(dot.ultimo_erro)}</span></div>`;
    }
    const resta = Math.max(0, dot.limite_dia - dot.feitas_hoje);
    const quandoVolta = dot.proxima_execucao_at ? `às ${horaCurta(dot.proxima_execucao_at)}` : 'em breve';
    if (!resta) return `<div class="d-banner">✋ <span>Limite de <b>${dot.limite_dia}</b> matérias hoje atingido. Volto amanhã.</span></div>`;
    if (r.proximos) {
      return `<div class="d-banner d-banner--ok">⏳ <span><b>${r.proximos} ${r.proximos === 1 ? 'post do assunto pronto' : 'posts do assunto prontos'}</b> — sai na próxima volta (${quandoVolta}).</span></div>`;
    }
    return `<div class="d-banner">🔎 <span><b>Procurando.</b> Nenhum post novo do assunto ainda — releio as páginas ${quandoVolta}.</span></div>`;
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
          <span class="d-post-meta">${escapar(p.fonte || '')} · ${haQuanto(p.lido_em)}${p.palavra ? ` · <span class="d-txt-acento">🔎 ${escapar(p.palavra)}</span>` : ''}</span>
          <span class="d-sit ${sit.classe}">${sit.icone} ${escapar(detalheSit)}</span>
        </div>
        <div class="d-post-acao">${acao}</div>
      </div>`;
  }

  function seloMateria(m) {
    if (m.status === 'publicado') return '<span class="d-selo d-selo--ok">✅ Publicada</span>';
    if (m.status === 'agendado') return `<span class="d-selo d-selo--alerta">📅 ${diaHora(m.agendada_para)}</span>`;
    if (m.status === 'erro') return '<span class="d-selo d-selo--erro">⚠️ Erro ao publicar</span>';
    return '<span class="d-selo">📝 Rascunho</span>';
  }

  function cartaoMateria(m) {
    return `
      <a class="d-arte" href="/materias-ia/${m.id}" target="_blank" rel="noopener">
        <span class="d-arte-img">
          ${m.imagem ? `<img src="${escapar(m.imagem)}" alt="" loading="lazy" />` : '<span class="d-sem-imagem">📰</span>'}
          ${seloMateria(m)}
        </span>
        <span class="d-arte-titulo">${escapar(m.titulo || 'Matéria')}</span>
      </a>`;
  }

  // ------------------------------------------------------------ painel

  function abaProximas(d) {
    const lista = (d?.posts || []).filter((p) => PROXIMAS.includes(p.situacao));
    if (!lista.length) return '<div class="d-vazio-aba">🔎 Nenhum post do assunto esperando.</div>';
    const ordem = { proximo: 0, falhou: 1, repetido: 2 };
    return `<div class="d-posts">${lista.sort((a, b) => ordem[a.situacao] - ordem[b.situacao]).map(linhaPost).join('')}</div>`;
  }

  function abaMaterias(d) {
    const materias = d?.materias || [];
    if (!materias.length) return '<div class="d-vazio-aba">📰 Nenhuma matéria ainda.</div>';
    const ordem = { agendado: 0, publicado: 1 };
    const lista = [...materias].sort((a, b) => (ordem[a.status] ?? 2) - (ordem[b.status] ?? 2));
    return `<div class="d-grade">${lista.map(cartaoMateria).join('')}</div>`;
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
          ${palavras.length ? `<span class="d-chip d-chip--palavra">🔎 ${escapar(palavras.join(', '))}</span>` : '<span class="d-chip">🔎 qualquer assunto</span>'}
          ${plano.estilo ? `<span class="d-chip">🎯 ${escapar(plano.estilo)}</span>` : ''}
          <span class="d-chip">📡 ${dot.fontes} ${dot.fontes === 1 ? 'página' : 'páginas'}</span>
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
      todos: d ? posts.length : null,
    };
    const conteudo = aba === 'config'
      ? abaConfig(dot)
      : !d
        ? '<div class="d-vazio-aba">Carregando…</div>'
        : aba === 'materias'
          ? abaMaterias(d)
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
      rotulo: 'Monitorar páginas',
      texto: 'Monitore estas páginas e crie matéria do que render, com título forte:\nhttps://www.facebook.com/Poder360\nhttps://www.facebook.com/plenonews',
    },
    {
      rotulo: 'Só um assunto',
      texto: 'Só o que citar Flávio Bolsonaro ou Lula, com título mais polêmico:\nhttps://www.facebook.com/jovempannews',
    },
    {
      rotulo: 'Site de notícias',
      texto: 'Acompanhe este portal e escreva matéria das notícias de política:\nhttps://portaldenoticias.com.br',
    },
  ];

  function conversaDoNovo() {
    const boasVindas = msgDot(`
      <p><b>Diga o que você quer, do seu jeito.</b></p>
      <p>Eu acompanho as páginas, separo o que tem conteúdo e escrevo a matéria — no servidor, mesmo com a aba fechada.</p>
      <p class="dc-dica">Diga o assunto, o recorte e o estilo e cole os links (Facebook, Instagram, YouTube ou site de notícias). No <b>+</b> da caixa você escolhe rascunho, agendar ou publicar e a página.</p>
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
    partes.push(msgDot(`
      <p>Entendi. ${frase(dot)}</p>
      <div class="d-mat-chips mt-1.5">
        ${palavras.length ? `<span class="d-chip d-chip--palavra">🔎 ${escapar(palavras.join(', '))}</span>` : ''}
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
      : 'Diga o que o dot deve fazer e cole os links…';
    el.mais.hidden = Boolean(dot);
    if (dot) fecharAjustes();
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
    conversaNova.push({ autor: 'dot', html: '<p class="dc-digitando"><i></i><i></i><i></i> Lendo o pedido…</p>', previa: true });
    renderConversa({ rolar: true });
    try {
      const { plano, urls, resumo } = await api('/api/dots/previa', {
        method: 'POST',
        body: JSON.stringify({ objetivo: texto, ...configuracaoDaTela() }),
      });
      if (!el.nome.value.trim()) el.nome.value = plano.nome;
      planoConfirmado = { plano, urls, pendente: true };
      conversaNova = conversaNova.filter((m) => !m.previa);
      conversaNova.push({
        autor: 'dot',
        previa: true,
        html: `
          <p><b>${escapar(plano.nome)}</b></p>
          <p class="dc-dica">${escapar(plano.criterio || '')}</p>
          <ul class="dc-lista">${(resumo || []).map((linha) => `<li>${escapar(linha)}</li>`).join('')}</ul>
          <div class="dc-chips">
            <button type="button" class="dc-chip dc-chip--principal" data-acao="confirmar-novo">É isso, pode criar</button>
            <button type="button" class="dc-chip" data-acao="ajustar-novo">Quero mudar</button>
            <button type="button" class="dc-chip" data-acao="abrir-ajustes">Ajustes (destino, página…)</button>
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
    conversaNova = conversaNova.filter((m) => !m.previa);
    pushNova('dot', '<p class="dc-digitando"><i></i><i></i><i></i> Criando e cadastrando as páginas…</p>');
    try {
      const r = await api('/api/dots', {
        method: 'POST',
        body: JSON.stringify({
          objetivo: pedidoNovo,
          nome: el.nome.value.trim() || null,
          provedor: el.provedor?.value || 'auto',
          facebook_page_id: el.pagina.value || null,
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

  function abrirAjustes() {
    el.ajustes.hidden = false;
    el.mais.setAttribute('aria-expanded', 'true');
    atualizarResumoAjustes();
  }
  function fecharAjustes() {
    el.ajustes.hidden = true;
    el.mais.setAttribute('aria-expanded', 'false');
    atualizarResumoAjustes();
  }
  el.mais.addEventListener('click', () => (el.ajustes.hidden ? abrirAjustes() : fecharAjustes()));
  el.ajustesFechar.addEventListener('click', fecharAjustes);
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

  /** "Criar novo dot": abre o nome e os ajustes; o pedido vai na caixa de baixo. */
  function comecarNovo(nomeInicial) {
    esconderPara();
    selecionar('novo');
    if (nomeInicial) el.nome.value = nomeInicial;
    abrirAjustes();
    renderTopo();
    el.nome.focus();
    if (nomeInicial) el.nome.setSelectionRange(nomeInicial.length, nomeInicial.length);
  }

  function escolherPara(id) {
    if (id === 'novo') return comecarNovo(String(el.paraBusca.value || '').trim());
    esconderPara();
    selecionar(id);
  }

  el.novo.addEventListener('click', (e) => {
    e.stopPropagation();
    mostrarPara();
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
      { icone: 'lapis', texto: 'Renomear', acao: 'renomear' },
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
    if (acao === 'configuracao') {
      if (selecionado !== String(id)) selecionar(id);
      abrirPainel('config');
      return true;
    }
    if (acao === 'renomear') {
      const nome = await dialogo({ titulo: 'Renomear dot', confirmar: 'Salvar', campo: { valor: dot.nome, rotulo: 'Novo nome' } });
      if (!nome || nome === dot.nome) return false;
      try {
        await api(`/api/dots/${id}`, { method: 'PATCH', body: JSON.stringify({ nome }) });
        avisar('Nome salvo.');
        await carregar();
        return true;
      } catch (err) {
        avisar(err.message, true);
        return false;
      }
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
