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

  function concluido(dotId) {
    const linhas = logs.get(String(dotId));
    if (!linhas) return '<p class="d-linha"><span class="d-linha-marca">·</span><span>Carregando…</span></p>';
    if (!linhas.length) return '<p class="d-linha"><span class="d-linha-marca">·</span><span>Ainda não concluiu nada.</span></p>';
    return linhas
      .slice(0, 12)
      .map((e) => {
        const marca = { escreveu: '✓', ignorou: '·', erro: '!', criou_fonte: '+' }[e.acao] || '·';
        const classe = e.acao === 'escreveu' ? 'd-linha--ok' : e.acao === 'erro' ? 'd-linha--erro' : '';
        const link = e.matter_id
          ? ` <a href="/materias-ia/${e.matter_id}" style="color:var(--d-acento)" class="hover:underline">ver matéria</a>`
          : '';
        return `<p class="d-linha ${classe}"><span class="d-linha-marca">${marca}</span>
          <span>${escapar(e.detalhe || e.acao)}${link} <span class="d-quando">${haQuanto(e.created_at)}</span></span></p>`;
      })
      .join('');
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

        ${agora(dot)}
        ${dot.ultimo_erro ? `<p class="d-linha d-linha--erro mt-2"><span class="d-linha-marca">!</span><span>${escapar(dot.ultimo_erro)}</span></p>` : ''}

        <details class="d-detalhes mt-3" data-atividade ${abertos.has(String(dot.id)) ? 'open' : ''}>
          <summary>Atividade</summary>
          <div class="mt-2 space-y-3">
            <div>
              <p class="d-secao">Agendado</p>
              <div class="mt-1">${agendado(dot)}</div>
            </div>
            <div>
              <p class="d-secao">Concluído</p>
              <div class="mt-1">${concluido(dot.id)}</div>
            </div>
          </div>
        </details>
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
    } catch {
      logs.set(String(dotId), []);
    }
  }

  async function carregar() {
    try {
      const resposta = await api('/api/dots');
      // Resposta inesperada não pode quebrar a tela inteira.
      const dots = Array.isArray(resposta) ? resposta : [];
      await Promise.all([...abertos].filter((id) => dots.some((d) => String(d.id) === id)).map(carregarLog));

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
