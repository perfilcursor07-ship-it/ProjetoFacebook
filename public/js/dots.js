(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    nome: $('dot-nome'),
    objetivo: $('dot-objetivo'),
    pagina: $('dot-pagina'),
    provedor: $('dot-provedor'),
    previa: $('dot-previa'),
    criar: $('dot-criar'),
    aviso: $('dot-aviso'),
    previaBox: $('dot-previa-box'),
    form: $('dot-form'),
    recolher: $('dot-recolher'),
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
    lista: $('dots-lista'),
    pulso: $('dots-pulso'),
  };
  if (!el.lista) return;

  /** Log por dot, para a atualização de 3s não piscar a timeline. */
  const logs = new Map();
  /** Comandos em edição (id → texto). Enquanto houver, a lista não se redesenha. */
  const editando = new Map();
  /** Detalhe completo por dot (números, posts, matérias) e quando chegou. */
  const detalhes = new Map();
  /** Aba aberta e filtro dos posts, por dot. */
  const abas = new Map();
  const filtrosPosts = new Map();
  const DETALHE_VALIDO_MS = 30000;
  /** Última lista recebida, para redesenhar um cartão sem ir ao servidor. */
  let ultimaLista = [];

  function redesenharCartao(id) {
    const dot = ultimaLista.find((d) => String(d.id) === String(id));
    const atual = el.lista.querySelector(`[data-dot="${CSS.escape(String(id))}"]`);
    if (!dot || !atual) return;
    const molde = document.createElement('div');
    molde.innerHTML = cartao(dot).trim();
    atual.replaceWith(molde.firstElementChild);
  }

  // ---------------------------------------------------------- configuração
  //
  // Tudo aqui era deduzido pela IA a partir do texto livre e errava direto.
  // Agora é escolha explícita do editor; o texto só diz O QUE fazer.

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

  function opcao(select, valor, texto, selecionado = false) {
    const o = new Option(texto, valor, selecionado, selecionado);
    select.append(o);
  }

  function montarCampos() {
    if (!el.dias) return;

    // Dias: começam todos marcados = trabalha todo dia.
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

    // Horário: "qualquer hora" é o padrão, com 0h–23h disponíveis.
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
      radio.addEventListener('change', ajustarDestino);
    }
    ajustarDestino();
  }

  function destinoEscolhido() {
    return document.querySelector('input[name="dot-destino"]:checked')?.value || 'rascunho';
  }

  function ajustarRotuloSaida() {
    const n = Number(el.saidaQtd.value) || 1;
    el.saidaRotulo.textContent = n === 1 ? 'matéria a cada' : 'matérias a cada';
  }

  /** A explicação de cada destino aparece só quando ele é o escolhido. */
  const AJUDA_DESTINO = {
    rascunho: 'Fica esperando você revisar. Nada sai sozinho.',
    agendar: 'Programa o horário e publica sozinho na hora marcada.',
    publicar: 'Vai direto para a fila, sem revisão.',
  };

  /** Rascunho não tem ritmo de saída: nada sai sozinho. */
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
      // Só vale faixa com as duas pontas escolhidas; uma ponta só não restringe.
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
  /** Plano confirmado pelo editor. Sem ele o "Criar dot" não envia nada. */
  let planoConfirmado = null;
  const abertos = new Set();
  let timer = null;

  const EXEMPLOS = {
    monitorar:
      'Monitore estas páginas e crie matéria do que render, até 10 por dia, salvando como rascunho:\nhttps://www.facebook.com/Poder360\nhttps://www.facebook.com/plenonews',
    acompanhar:
      'Só acompanhe estas páginas e me mostre o que aparecer de novo, sem escrever matéria:\nhttps://www.facebook.com/metropolesdf',
    publicar:
      'Acompanhe estas páginas de hora em hora, escreva e publique direto, no máximo 5 por dia:\nhttps://www.facebook.com/jovempannews',
  };

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
  };

  const icone = (nome) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONES[nome]}</svg>`;

  async function api(url, opcoes = {}) {
    const resp = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opcoes });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(dados.error || dados.message || `Erro ${resp.status}`);
    return dados;
  }

  function avisar(texto, erro = false) {
    el.aviso.textContent = texto || '';
    el.aviso.style.color = erro ? 'var(--d-erro)' : 'var(--d-texto-4)';
  }

  function escapar(texto) {
    const d = document.createElement('div');
    d.textContent = String(texto ?? '');
    return d.innerHTML;
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

  function quando(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const min = Math.round((d.getTime() - Date.now()) / 60000);
    if (min > 0) return `em ${min} min`;
    if (min > -60) return `há ${Math.abs(min)} min`;
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  /** Só as IAs com chave configurada no servidor entram no seletor. */
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
      // A API devolve `page_name`. Ler `nome`/`name` caía no texto de reserva e
      // o editor via "Página 2" em vez do nome real da página.
      for (const p of paginas) {
        const rotulo = p.page_name || `Página ${p.id}`;
        el.pagina.append(new Option(p.is_default ? `${rotulo} (padrão)` : rotulo, p.id));
      }
      // Já vem na padrão do usuário, como nos outros seletores de publicação.
      const padrao = paginas.find((p) => p.is_default);
      if (padrao) el.pagina.value = String(padrao.id);
    } catch {
      el.pagina.innerHTML = '';
      el.pagina.append(new Option('Não consegui carregar as páginas', ''));
    }
  }

  // --------------------------------------------------------------- partes

  function pill(dot) {
    if (dot.trabalhando) {
      return '<span class="d-pill d-pill--trabalhando"><span class="d-luz d-luz--pulsa"></span>Trabalhando</span>';
    }
    if (dot.estado !== 'ativo') {
      return '<span class="d-pill d-pill--pausado"><span class="d-luz"></span>Pausado</span>';
    }
    if (dot.ultimo_erro) {
      return '<span class="d-pill d-pill--erro"><span class="d-luz"></span>Com erro</span>';
    }
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
        ${
          // Sem mostrar o destino, matéria na página errada só aparecia depois
          // de publicada. Sem página escolhida, ela cai na padrão da conta.
          dot.pagina
            ? `<span class="d-stat" title="Página de destino das matérias">${icone('paginas')}em <b>${escapar(dot.pagina)}</b></span>`
            : `<span class="d-stat d-stat--aviso" title="Nenhuma página foi escolhida: a matéria vai para a página padrão da sua conta">${icone('paginas')}sem página definida</span>`
        }
        <label class="d-stat gap-1">
          ${icone('cpu')}
          <select data-provedor class="d-escolha" aria-label="IA que escreve">
            ${provedoresCache
              .map(
                (p) =>
                  `<option value="${p.id}"${p.id === (dot.provedor || 'auto') ? ' selected' : ''}>${escapar(p.nome)}</option>`
              )
              .join('')}
          </select>
        </label>
      </div>
      <div class="d-barra ${pct >= 100 ? 'd-barra--cheia' : ''} mt-2.5"><span style="width:${pct}%"></span></div>`;
  }

  function agora(dot) {
    if (!dot.trabalhando || !dot.atividade) return '';
    return `
      <div class="d-agora mt-3">
        <span class="d-luz d-luz--pulsa mt-1.5"></span>
        <span><span class="d-reticencias">${escapar(dot.atividade)}</span>
          <span class="d-quando">${haQuanto(dot.atividade_em)}</span></span>
      </div>`;
  }

  function agendado(dot) {
    if (dot.estado !== 'ativo') {
      return '<p class="d-linha"><span class="d-linha-marca">‖</span><span>Pausado. Retome para voltar a trabalhar.</span></p>';
    }
    if (dot.trabalhando) {
      return `<p class="d-linha"><span class="d-linha-marca">○</span><span>A próxima volta é marcada quando esta terminar · a cada ${dot.intervalo_minutos} min</span></p>`;
    }
    const resta = Math.max(0, dot.limite_dia - dot.feitas_hoje);
    return `<p class="d-linha"><span class="d-linha-marca">○</span><span>Próxima volta ${quando(dot.proxima_execucao_at)} · ${
      resta
        ? `faltam <b style="color:var(--d-texto-2)">${resta}</b> de ${dot.limite_dia} hoje`
        : `limite de ${dot.limite_dia} atingido hoje`
    }</span></p>`;
  }

  /** Ícone e rótulo de cada passo da atividade, para ler de relance. */
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

  /** Separa "título · palavra-chave: X · foto original · sai 15:47" em partes. */
  function partesDoEscreveu(detalhe) {
    const partes = String(detalhe || '').split(' · ');
    const titulo = partes.shift() || 'Matéria';
    const palavra = (partes.find((p) => /^palavra-chave:/i.test(p)) || '').replace(/^palavra-chave:\s*/i, '');
    const resto = partes.filter((p) => !/^palavra-chave:/i.test(p));
    return { titulo, palavra, imagem: resto.find((p) => /foto|imagem/i.test(p)) || '', saida: resto.find((p) => !/foto|imagem/i.test(p)) || '' };
  }

  // ------------------------------------------------------- painel de gestão

  const SITUACAO_POST = {
    materia: { icone: '✅', texto: 'Virou matéria', classe: 'd-sit--ok' },
    aguardando: { icone: '⏳', texto: 'Na fila do dot', classe: 'd-sit--fila' },
    fora_do_assunto: { icone: '🚫', texto: 'Fora do assunto', classe: 'd-sit--fora' },
    pouco_texto: { icone: '✂️', texto: 'Pouco texto', classe: 'd-sit--fora' },
    descartado: { icone: '—', texto: 'Descartado', classe: 'd-sit--fora' },
  };
  const FILTROS_POST = [
    { id: 'todos', texto: 'Todos', ok: () => true },
    { id: 'assunto', texto: 'No assunto', ok: (p) => p.situacao !== 'fora_do_assunto' },
    { id: 'materia', texto: 'Viraram matéria', ok: (p) => p.situacao === 'materia' },
    { id: 'fila', texto: 'Na fila', ok: (p) => p.situacao === 'aguardando' },
    { id: 'fora', texto: 'Fora do assunto', ok: (p) => p.situacao === 'fora_do_assunto' },
  ];

  function horaCurta(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  /** Números que o editor precisa para decidir: o dot está rendendo ou não? */
  function numeros(dot) {
    const d = detalhes.get(String(dot.id));
    const r = d?.resumo;
    const bloco = (valor, rotulo, dica, classe = '') => `
      <div class="d-kpi ${classe}" title="${escapar(dica)}">
        <span class="d-kpi-valor">${r ? valor : '—'}</span>
        <span class="d-kpi-rotulo">${rotulo}</span>
      </div>`;
    return `
      <div class="d-kpis mt-3">
        ${bloco(r?.lidos, 'Posts lidos', 'Posts que o dot leu das páginas nos últimos 7 dias')}
        ${bloco(r?.no_assunto, 'No assunto', 'Posts que citam as palavras-chave do comando')}
        ${bloco(r?.escritas, 'Matérias', 'Matérias que este dot escreveu')}
        ${bloco(r?.agendadas, 'Agendadas', 'Matérias esperando o horário para sair', r?.agendadas ? 'd-kpi--alerta' : '')}
        ${bloco(r?.publicadas, 'Publicadas', 'Matérias que já saíram', r?.publicadas ? 'd-kpi--ok' : '')}
        ${bloco(r?.problemas_24h, 'Problemas 24h', 'Erros nas últimas 24 horas', r?.problemas_24h ? 'd-kpi--erro' : '')}
      </div>`;
  }

  function abaMaterias(d) {
    const materias = d?.materias || [];
    if (!materias.length) {
      return '<p class="d-vazio-aba">Nenhuma matéria escrita ainda. Quando um post do assunto aparecer, ela surge aqui.</p>';
    }
    const grupo = (titulo, lista, linhaStatus) => {
      if (!lista.length) return '';
      return `
        <div>
          <p class="d-grupo">${titulo} <span>${lista.length}</span></p>
          <div class="d-mats mt-1.5">
            ${lista.map((m) => `
              <a class="d-mat" href="/materias-ia/${m.id}" target="_blank" rel="noopener">
                ${m.imagem ? `<img src="${escapar(m.imagem)}" alt="" loading="lazy" class="d-mat-capa" />` : '<span class="d-mat-capa d-mat-capa--vazia">sem capa</span>'}
                <span class="d-mat-corpo">
                  <span class="d-mat-titulo">${escapar(m.titulo || 'Matéria')}</span>
                  <span class="d-mat-chips">${linhaStatus(m)}</span>
                </span>
              </a>`).join('')}
          </div>
        </div>`;
    };
    const agendadas = materias
      .filter((m) => m.status === 'agendado')
      .sort((a, b) => new Date(a.agendada_para || 0) - new Date(b.agendada_para || 0));
    const publicadas = materias.filter((m) => m.status === 'publicado');
    const outras = materias.filter((m) => !['agendado', 'publicado'].includes(m.status));
    return `<div class="space-y-3">
      ${grupo('📅 Agendadas', agendadas, (m) => `<span class="d-chip">Sai ${horaCurta(m.agendada_para)}</span>`)}
      ${grupo('✅ Publicadas', publicadas, (m) => (m.link
        ? `<span class="d-chip d-chip--palavra">Publicada</span><span class="d-chip" data-link="${escapar(m.link)}">ver post ↗</span>`
        : '<span class="d-chip d-chip--palavra">Publicada</span>'))}
      ${grupo('📝 Rascunhos e outras', outras, (m) => `<span class="d-chip">${m.status === 'erro' ? '⚠️ erro ao publicar' : 'rascunho — revisar'}</span>`)}
    </div>`;
  }

  function abaPosts(dotId, d) {
    const posts = d?.posts || [];
    if (!posts.length) {
      return '<p class="d-vazio-aba">Nenhum post lido nos últimos 7 dias. Confira se as páginas do comando estão certas.</p>';
    }
    const filtroId = filtrosPosts.get(String(dotId)) || 'todos';
    const filtro = FILTROS_POST.find((f) => f.id === filtroId) || FILTROS_POST[0];
    const visiveis = posts.filter(filtro.ok);
    const botoes = FILTROS_POST.map((f) => {
      const n = posts.filter(f.ok).length;
      return `<button type="button" data-acao="filtro-posts" data-filtro="${f.id}" class="d-filtro ${f.id === filtro.id ? 'is-on' : ''}">${f.texto} <span>${n}</span></button>`;
    }).join('');
    const linhas = visiveis.slice(0, 30).map((p) => {
      const sit = SITUACAO_POST[p.situacao] || SITUACAO_POST.descartado;
      const destino = p.matter_id ? `/materias-ia/${p.matter_id}` : p.url;
      return `
        <a class="d-post" href="${escapar(destino)}" target="_blank" rel="noopener">
          ${p.thumbnail ? `<img src="${escapar(p.thumbnail)}" alt="" loading="lazy" class="d-post-capa" />` : '<span class="d-post-capa d-mat-capa--vazia">—</span>'}
          <span class="d-post-corpo">
            <span class="d-post-titulo">${escapar(p.titulo || '(sem texto)')}</span>
            <span class="d-post-meta">${escapar(p.fonte || '')} · ${haQuanto(p.lido_em)}</span>
          </span>
          <span class="d-post-lado">
            <span class="d-sit ${sit.classe}">${sit.icone} ${sit.texto}</span>
            ${p.palavra ? `<span class="d-chip d-chip--palavra">🔎 ${escapar(p.palavra)}</span>` : ''}
          </span>
        </a>`;
    }).join('');
    return `
      <div class="d-filtros">${botoes}</div>
      <div class="d-posts mt-2">${linhas || '<p class="d-vazio-aba">Nada neste filtro.</p>'}</div>`;
  }

  /** Histórico curto: junta linhas repetidas seguidas ("× 3") para não poluir. */
  function abaHistorico(dotId) {
    const linhas = logs.get(String(dotId)) || [];
    if (!linhas.length) return '<p class="d-vazio-aba">Ainda não há histórico.</p>';
    const agrupadas = [];
    for (const e of linhas.slice(0, 40)) {
      const ultima = agrupadas[agrupadas.length - 1];
      if (ultima && ultima.acao === e.acao && ultima.detalhe === e.detalhe) {
        ultima.vezes += 1;
        continue;
      }
      agrupadas.push({ ...e, vezes: 1 });
    }
    return `<ol class="d-passos">${agrupadas.slice(0, 15).map((e) => {
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

  function painelAbas(dot) {
    const id = String(dot.id);
    const d = detalhes.get(id);
    const aba = abas.get(id) || 'materias';
    const total = (lista) => (Array.isArray(lista) ? lista.length : 0);
    const botao = (chave, texto, n) =>
      `<button type="button" role="tab" data-acao="aba" data-aba="${chave}" aria-selected="${aba === chave}" class="d-aba ${aba === chave ? 'is-on' : ''}">${texto}${n !== null ? ` <span>${n}</span>` : ''}</button>`;
    const conteudo = !d
      ? '<p class="d-vazio-aba">Carregando…</p>'
      : aba === 'posts'
        ? abaPosts(id, d)
        : aba === 'historico'
          ? abaHistorico(id)
          : abaMaterias(d);
    return `
      <div class="mt-4">
        <div class="d-abas" role="tablist">
          ${botao('materias', '📰 Matérias', d ? total(d.materias) : null)}
          ${botao('posts', '🔎 Posts encontrados', d ? total(d.posts) : null)}
          ${botao('historico', '🧭 Histórico', null)}
        </div>
        <div class="d-aba-corpo mt-3">${conteudo}</div>
      </div>`;
  }

  /** O que o dot entendeu do comando + edição no próprio cartão. */
  function comando(dot) {
    const id = String(dot.id);
    const plano = dot.plano || {};
    if (editando.has(id)) {
      return `
        <div class="d-comando d-comando--editando mt-3" data-comando-edicao>
          <label class="d-rotulo-min" for="dot-cmd-${id}">O que ele deve fazer</label>
          <textarea id="dot-cmd-${id}" data-comando-texto rows="6">${escapar(editando.get(id))}</textarea>
          <p class="d-ajuda">Mude o assunto, as palavras-chave ou o estilo (ex.: “deixe o título mais polêmico”). Links novos viram páginas monitoradas.</p>
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
          <p class="d-comando-texto" title="${escapar(dot.objetivo || '')}">${escapar(dot.objetivo || 'Sem comando.')}</p>
          <button type="button" data-acao="editar-comando" class="d-btn d-btn--fantasma shrink-0">✏️ Editar comando</button>
        </div>
        <div class="d-mat-chips mt-1.5">
          ${palavras.length ? `<span class="d-chip d-chip--palavra">🔎 ${escapar(palavras.join(', '))}</span>` : '<span class="d-chip">🔎 qualquer assunto</span>'}
          ${plano.estilo ? `<span class="d-chip">🎯 ${escapar(plano.estilo)}</span>` : ''}
          <span class="d-chip">📡 ${dot.fontes} ${dot.fontes === 1 ? 'página' : 'páginas'}</span>
        </div>
      </div>`;
  }

  function cartao(dot) {
    const ativo = dot.estado === 'ativo';
    const classe = dot.trabalhando ? 'd-card--trabalhando' : dot.ultimo_erro ? 'd-card--erro' : '';
    return `
      <article class="d-card ${classe} p-4 sm:p-5" data-dot="${dot.id}">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <input class="d-nome truncate" data-nome value="${escapar(dot.nome)}" maxlength="160" aria-label="Nome do dot" />
              ${pill(dot)}
            </div>
            ${stats(dot)}
          </div>
          <div class="flex items-center gap-1">
            <button type="button" data-acao="rodar" class="d-btn d-btn--neutro">Trabalhar agora</button>
            <button type="button" data-acao="${ativo ? 'pausar' : 'retomar'}" class="d-btn d-btn--fantasma">${ativo ? 'Pausar' : 'Retomar'}</button>
            <button type="button" data-acao="excluir" class="d-btn d-btn--fantasma d-btn--perigo" title="Excluir">✕</button>
          </div>
        </div>

        ${comando(dot)}
        ${agora(dot)}
        ${dot.ultimo_erro ? `<p class="d-linha d-linha--erro mt-2"><span class="d-linha-marca">!</span><span>${escapar(dot.ultimo_erro)}</span></p>` : ''}

        ${numeros(dot)}
        <div class="d-proxima mt-2">${agendado(dot)}</div>
        ${painelAbas(dot)}
      </article>`;
  }

  function vazio() {
    return `
      <div class="d-vazio">
        <span class="d-vazio-icone"><i></i><i></i><i></i></span>
        <p class="text-sm" style="color: var(--d-texto-2)">Nenhum dot ainda.</p>
        <p class="mt-1 text-xs">Escreva acima o que você quer que ele faça — ou toque num exemplo.</p>
      </div>`;
  }

  // ------------------------------------------------------------- ciclo UI

  async function carregarLog(dotId) {
    try {
      const dados = await api(`/api/dots/${dotId}`);
      logs.set(String(dotId), dados.execucoes || []);
      detalhes.set(String(dotId), { ...dados, em: Date.now() });
    } catch {
      logs.set(String(dotId), []);
    }
  }

  async function carregar() {
    // Redesenhar a lista apagaria o que o editor está digitando no comando.
    if (editando.size) return reagendar(5000);
    try {
      const resposta = await api('/api/dots');
      // Resposta inesperada não pode quebrar a tela inteira.
      const dots = Array.isArray(resposta) ? resposta : [];
      await Promise.all(
        dots
          .filter((d) => d.trabalhando || !detalhes.has(String(d.id)) || Date.now() - detalhes.get(String(d.id)).em > DETALHE_VALIDO_MS)
          .map((d) => carregarLog(d.id))
      );

      ultimaLista = dots;
      el.lista.innerHTML = dots.length ? dots.map(cartao).join('') : vazio();

      const trabalhando = dots.filter((d) => d.trabalhando).length;
      const ativos = dots.filter((d) => d.estado === 'ativo').length;
      el.pulso.innerHTML = trabalhando
        ? `<span class="d-luz d-luz--pulsa" style="color: var(--d-acento)"></span> ${trabalhando} trabalhando agora`
        : ativos
          ? `${ativos} ativo(s)`
          : '';

      reagendar(trabalhando ? 3000 : 15000);
    } catch (err) {
      el.lista.innerHTML = `<p class="d-linha d-linha--erro"><span class="d-linha-marca">!</span><span>${escapar(err.message)}</span></p>`;
      reagendar(15000);
    }
  }

  function reagendar(ms) {
    clearTimeout(timer);
    timer = setTimeout(carregar, ms);
  }

  // ---------------------------------------------------------------- ações

  for (const botao of document.querySelectorAll('[data-exemplo]')) {
    botao.addEventListener('click', () => {
      el.objetivo.value = EXEMPLOS[botao.dataset.exemplo] || '';
      el.objetivo.focus();
      avisar('Troque os links pelos seus e ajuste o texto à vontade.');
    });
  }

  // Mexeu no pedido, a confirmação anterior não vale mais.
  el.objetivo.addEventListener('input', () => {
    if (!planoConfirmado) return;
    planoConfirmado = null;
    el.previaBox.className = 'hidden';
  });

  el.recolher.addEventListener('click', () => {
    const escondido = el.form.hasAttribute('hidden');
    if (escondido) el.form.removeAttribute('hidden');
    else el.form.setAttribute('hidden', '');
    el.recolher.textContent = escondido ? 'Recolher' : 'Abrir';
    el.recolher.setAttribute('aria-expanded', String(escondido));
  });

  el.previa.addEventListener('click', async () => {
    const objetivo = el.objetivo.value.trim();
    if (!objetivo) return avisar('Escreva o que o dot deve fazer.', true);
    avisar('Lendo o pedido…');
    try {
      const { plano, urls, resumo } = await api('/api/dots/previa', {
        method: 'POST',
        body: JSON.stringify({ objetivo, ...configuracaoDaTela() }),
      });
      if (!el.nome.value.trim()) el.nome.value = plano.nome;
      planoConfirmado = null;

      el.previaBox.className = 'd-card mt-1 p-4';
      el.previaBox.style.background = 'var(--d-surface-2)';
      el.previaBox.innerHTML = `
        <p class="d-secao">Confira antes de criar</p>
        <p class="mt-2 text-sm font-semibold" style="color: var(--d-texto)">${escapar(plano.nome)}</p>
        <p class="mt-1 text-xs" style="color: var(--d-texto-2)">${escapar(plano.criterio)}</p>
        <div class="mt-3 space-y-1">
          ${(resumo || []).map((linha) => `<p class="d-linha"><span class="d-linha-marca">›</span><span>${escapar(linha)}</span></p>`).join('')}
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" id="dot-confirmar" class="d-btn d-btn--principal">É isso, pode criar</button>
          <button type="button" id="dot-ajustar" class="d-btn d-btn--fantasma">Quero mudar</button>
        </div>`;

      document.getElementById('dot-confirmar').addEventListener('click', () => {
        planoConfirmado = { plano, urls };
        criarDot();
      });
      document.getElementById('dot-ajustar').addEventListener('click', () => {
        el.previaBox.className = 'hidden';
        planoConfirmado = null;
        el.objetivo.focus();
        avisar('Ajuste o texto e peça para eu ler de novo.');
      });

      avisar('');
    } catch (err) {
      avisar(err.message, true);
    }
  });

  /** Só cria depois que o editor confirmou o plano na tela. */
  async function criarDot() {
    const objetivo = el.objetivo.value.trim();
    if (!objetivo) return avisar('Escreva o que o dot deve fazer.', true);
    if (!planoConfirmado) {
      avisar('Clique em "Ver o que eu entendi" e confirme o plano antes de criar.', true);
      return el.previa.click();
    }
    el.criar.disabled = true;
    avisar('Criando e cadastrando as páginas… leva alguns segundos.');
    try {
      const r = await api('/api/dots', {
        method: 'POST',
        body: JSON.stringify({
          objetivo,
          nome: el.nome.value.trim() || null,
          provedor: el.provedor?.value || 'auto',
          facebook_page_id: el.pagina.value || null,
          ...configuracaoDaTela(),
        }),
      });
      el.objetivo.value = '';
      el.nome.value = '';
      el.previaBox.className = 'hidden';
      planoConfirmado = null;
      // "1 link(s) não entraram" não dizia qual nem por quê, e o dot nascia
      // inútil sem o editor entender. O motivo vem no `problemas`.
      const falhas = Array.isArray(r.problemas) ? r.problemas : [];
      const base = `dot criado com ${r.fontes} página(s)`;
      if (falhas.length) {
        avisar(`${base}. Não entraram: ${falhas.slice(0, 3).join(' | ')}`, r.fontes === 0);
      } else {
        avisar(`Pronto: ${base}.`);
      }
      await carregar();
    } catch (err) {
      avisar(err.message, true);
    } finally {
      el.criar.disabled = false;
    }
  }

  el.criar.addEventListener('click', criarDot);

  el.lista.addEventListener('click', async (e) => {
    const botao = e.target.closest('[data-acao]');
    if (!botao) return;
    const id = botao.closest('[data-dot]')?.dataset.dot;
    if (!id) return;
    const acao = botao.dataset.acao;

    if (acao === 'aba') {
      abas.set(String(id), botao.dataset.aba);
      redesenharCartao(id);
      return;
    }
    if (acao === 'filtro-posts') {
      filtrosPosts.set(String(id), botao.dataset.filtro);
      redesenharCartao(id);
      return;
    }

    // Edição do comando no próprio cartão.
    if (acao === 'editar-comando') {
      const dot = (ultimaLista || []).find((d) => String(d.id) === String(id));
      editando.set(String(id), dot?.objetivo || '');
      redesenharCartao(id);
      botao.closest('[data-dot]')?.querySelector('[data-comando-texto]')?.focus();
      return;
    }
    if (acao === 'cancelar-comando') {
      editando.delete(String(id));
      redesenharCartao(id);
      return;
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
        avisar(
          r.fontes !== undefined
            ? `Comando atualizado: ${r.fontes} página(s) monitorada(s)${falhas.length ? `. Não entraram: ${falhas.slice(0, 2).join(' | ')}` : '.'}`
            : 'Comando atualizado.'
        );
        await carregar();
      } catch (err) {
        avisar(err.message, true);
        botao.disabled = false;
        botao.textContent = 'Salvar comando';
      }
      return;
    }

    if (acao === 'excluir' && !confirm('Excluir este dot? As páginas continuam na Biblioteca.')) return;

    botao.disabled = true;
    try {
      if (acao === 'excluir') {
        await api(`/api/dots/${id}`, { method: 'DELETE' });
        abertos.delete(String(id));
        logs.delete(String(id));
      } else {
        await api(`/api/dots/${id}/${acao}`, { method: 'POST' });
      }
      await carregar();
    } catch (err) {
      avisar(err.message, true);
      botao.disabled = false;
    }
  });

  async function salvarNome(campo) {
    const id = campo.closest('[data-dot]')?.dataset.dot;
    const nome = campo.value.trim();
    if (!id || !nome || nome === campo.defaultValue) return;
    try {
      await api(`/api/dots/${id}`, { method: 'PATCH', body: JSON.stringify({ nome }) });
      campo.defaultValue = nome;
      avisar('Nome salvo.');
    } catch (err) {
      campo.value = campo.defaultValue;
      avisar(err.message, true);
    }
  }

  el.lista.addEventListener('change', async (e) => {
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

  // Guarda o texto do comando a cada tecla (sobrevive a um redesenho do cartão).
  el.lista.addEventListener('input', (e) => {
    if (!e.target.matches('[data-comando-texto]')) return;
    const id = e.target.closest('[data-dot]')?.dataset.dot;
    if (id) editando.set(String(id), e.target.value);
  });

  el.lista.addEventListener('blur', (e) => {
    if (e.target.matches('[data-nome]')) salvarNome(e.target);
  }, true);

  el.lista.addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-nome]')) return;
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape') { e.target.value = e.target.defaultValue; e.target.blur(); }
  });

  el.lista.addEventListener('toggle', async (e) => {
    const det = e.target;
    if (!det.matches('[data-atividade]')) return;
    const id = det.closest('[data-dot]')?.dataset.dot;
    if (!id) return;
    if (det.open) {
      abertos.add(String(id));
      if (!logs.has(String(id))) { await carregarLog(id); await carregar(); }
    } else {
      abertos.delete(String(id));
    }
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else carregar();
  });

  montarCampos();
  carregarProvedores();
  carregarPaginas();
  carregar();
})();
