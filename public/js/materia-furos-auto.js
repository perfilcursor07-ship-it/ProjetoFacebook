/**
 * Furos do dia no piloto automático (/materia-manual).
 *
 * Liga/desliga o piloto e mostra o que ele está fazendo: fila, escrita,
 * imagens em geração, prontas e publicadas. Os nichos, fontes e período vêm
 * dos filtros do próprio painel do Furos (gravados no navegador).
 */
(function () {
  const secao = document.getElementById('furos-auto');
  const dialog = document.getElementById('furos-dialog');
  if (!secao || !dialog) return;

  const API = '/api/materias-ia/chat-extras/furos/auto';
  const $ = (id) => document.getElementById(id);
  const el = {
    ativo: $('furos-auto-ativo'),
    intervalo: $('furos-auto-intervalo'),
    pagina: $('furos-auto-pagina'),
    limite: $('furos-auto-limite'),
    foto: $('furos-auto-foto'),
    modoImagem: $('furos-auto-modo-imagem'),
    fotoLinha: $('furos-auto-foto-linha'),
    salvar: $('furos-auto-salvar'),
    escanear: $('furos-auto-escanear'),
    resumo: $('furos-auto-resumo'),
    itens: $('furos-auto-itens'),
    chip: $('piloto-chip'),
    curto: $('furos-auto-curto'),
    mais: $('furos-auto-mais'),
    agendaModo: $('furos-agenda-modo'),
    agendaInicio: $('furos-agenda-inicio'),
    agendaFim: $('furos-agenda-fim'),
    agendaSoHorario: $('furos-agenda-so-horario'),
    agendaHoraIni: $('furos-agenda-hora-ini'),
    agendaHoraFim: $('furos-agenda-hora-fim'),
    agendaDias: $('furos-agenda-dias'),
    agendaAjuda: $('furos-agenda-ajuda'),
  };

  /* ------------------------------ agenda ------------------------------ */

  const grupoAgenda = (nome) => secao.querySelector(`[data-agenda="${nome}"]`);

  /** "2026-10-01T06:00" no fuso do navegador (o que o campo datetime-local usa). */
  function paraCampoData(valor) {
    const d = valor ? new Date(valor) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }

  function diasMarcados() {
    return [...(el.agendaDias?.querySelectorAll('[data-dia]') || [])]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => Number(b.dataset.dia));
  }

  function mostrarCamposAgenda() {
    if (!el.agendaModo) return;
    const modo = el.agendaModo.value;
    grupoAgenda('periodo').hidden = modo !== 'periodo';
    grupoAgenda('horas').hidden = !(modo === 'diario' || (modo === 'periodo' && el.agendaSoHorario.checked));
    grupoAgenda('dias').hidden = modo !== 'diario';
    if (modo === 'periodo' && !el.agendaInicio.value) {
      // Sugestão: de agora até hoje às 23:00 (ou amanhã, se já passou).
      const agora = new Date();
      const fim = new Date(agora);
      fim.setHours(23, 0, 0, 0);
      if (fim <= agora) fim.setDate(fim.getDate() + 1);
      el.agendaInicio.value = paraCampoData(agora);
      el.agendaFim.value = paraCampoData(fim);
    }
    el.agendaAjuda.textContent = {
      sempre: '',
      diario: 'Liga e desliga sozinho todo dia nesse horário (fim antes do início = atravessa a meia-noite). Não precisa desmarcar o Automatizar.',
      periodo: 'Começa e termina sozinho nas datas escolhidas; no fim do período o Automatizar se desliga.',
    }[modo];
  }

  function lerAgendaDoForm() {
    const modo = el.agendaModo?.value || 'sempre';
    if (modo === 'sempre') return { modo };
    const horas = { horario_inicio: el.agendaHoraIni.value, horario_fim: el.agendaHoraFim.value };
    if (modo === 'diario') return { modo, ...horas, dias: diasMarcados() };
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    return {
      modo,
      inicio_at: iso(el.agendaInicio.value),
      fim_at: iso(el.agendaFim.value),
      ...(el.agendaSoHorario.checked ? horas : {}),
    };
  }

  function preencherAgenda(agenda = {}) {
    if (!el.agendaModo) return;
    el.agendaModo.value = agenda.modo || 'sempre';
    if (agenda.horario_inicio) el.agendaHoraIni.value = agenda.horario_inicio;
    if (agenda.horario_fim) el.agendaHoraFim.value = agenda.horario_fim;
    el.agendaSoHorario.checked = agenda.modo === 'periodo' && Boolean(agenda.horario_inicio);
    el.agendaInicio.value = paraCampoData(agenda.inicio_at);
    el.agendaFim.value = paraCampoData(agenda.fim_at);
    const dias = Array.isArray(agenda.dias) && agenda.dias.length ? agenda.dias : [0, 1, 2, 3, 4, 5, 6];
    el.agendaDias.querySelectorAll('[data-dia]').forEach((b) => b.setAttribute('aria-pressed', String(dias.includes(Number(b.dataset.dia)))));
    mostrarCamposAgenda();
  }

  // No modo "foto original" a IA nem é chamada, então a rede de segurança
  // de "se a imagem da IA falhar" não tem o que fazer: some do formulário.
  function aplicarModoImagem() {
    if (!el.fotoLinha) return;
    el.fotoLinha.hidden = el.modoImagem?.value === 'original';
  }

  el.modoImagem?.addEventListener('change', aplicarModoImagem);
  el.agendaModo?.addEventListener('change', mostrarCamposAgenda);
  el.agendaSoHorario?.addEventListener('change', mostrarCamposAgenda);
  el.agendaDias?.addEventListener('click', (e) => {
    const botao = e.target.closest('[data-dia]');
    if (!botao) return;
    botao.setAttribute('aria-pressed', String(botao.getAttribute('aria-pressed') !== 'true'));
  });

  const ETAPAS = {
    na_fila: ['Na fila', 'is-fila'],
    escrevendo: ['Escrevendo', 'is-andamento'],
    aguardando_imagem: ['Aguardando imagem', 'is-fila'],
    gerando_imagem: ['Gerando imagem com IA', 'is-andamento'],
    pronta: ['Pronta para agendar', 'is-pronta'],
    agendada: ['Agendada', 'is-pronta'],
    publicando: ['Publicando', 'is-andamento'],
    publicada: ['Publicada', 'is-publicada'],
    erro: ['Não publicada', 'is-erro'],
  };
  const CANAL = { noticias: 'Notícia', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };

  let timer = null;
  let paginasCarregadas = false;
  let ultimoStatus = null;
  // Os campos só são preenchidos ao abrir e depois de salvar: a atualização
  // automática a cada 10 s desfazia o que o editor tinha acabado de escolher.
  let formPreenchido = false;

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Falha na requisição (${res.status})`);
    return data;
  }

  function lerSalvo(chave, padrao) {
    try {
      const valor = JSON.parse(localStorage.getItem(chave) || 'null');
      return Array.isArray(valor) && valor.length ? valor : padrao;
    } catch {
      return padrao;
    }
  }

  /** Mesmos filtros que o editor marcou no painel do Furos. */
  function filtrosDoPainel() {
    const horas = Number(dialog.querySelector('[data-furos-horas].is-active')?.dataset.furosHoras) || 24;
    return {
      nichos: lerSalvo('ViralizeAI.furosNichos', ['auto']),
      canais: lerSalvo('ViralizeAI.furosCanais', ['noticias', 'youtube', 'instagram', 'facebook']),
      palavras: document.getElementById('furos-palavras')?.value.trim() || '',
      horas,
    };
  }

  function hora(valor) {
    if (!valor) return '';
    const data = new Date(valor);
    if (Number.isNaN(data.getTime())) return '';
    return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  async function carregarPaginas(selecionada) {
    if (!paginasCarregadas) {
      try {
        const data = await api('/api/facebook/pages');
        const paginas = Array.isArray(data.pages) ? data.pages : [];
        el.pagina.replaceChildren();
        if (!paginas.length) el.pagina.append(new Option('Nenhuma página vinculada', ''));
        for (const p of paginas) {
          const opcao = new Option(p.page_name || p.name || `Página ${p.id}`, String(p.id));
          if (Number(p.id) === Number(data.default_facebook_page_id)) opcao.selected = true;
          el.pagina.append(opcao);
        }
        paginasCarregadas = true;
      } catch {
        // mantém "Página padrão"
      }
    }
    if (selecionada) el.pagina.value = String(selecionada);
  }

  function setResumo(texto, tipo = '') {
    el.resumo.textContent = texto || '';
    el.resumo.dataset.tipo = tipo;
  }

  function renderChip(status) {
    if (!el.chip) return;
    const { config } = status;
    const filaManual = Number(status.filaManual) || 0;
    el.chip.hidden = !config.existe;
    el.chip.classList.toggle('is-ligado', Boolean(config.ativo) || filaManual > 0);
    el.chip.classList.toggle('is-pausado', !config.ativo && !filaManual);
    el.chip.textContent = config.ativo
      ? 'Piloto ligado'
      : filaManual ? `Publicando fila (${filaManual})` : 'Piloto pausado';
    el.chip.title = config.ativo
      ? `Piloto automático ligado${status.modeloNome ? `, escrevendo com ${status.modeloNome}` : ''}: roda no servidor mesmo com o navegador fechado. Clique para acompanhar.`
      : 'Piloto automático pausado. Clique para acompanhar ou retomar.';
  }

  function renderCurto(status) {
    if (!el.curto) return;
    const { config, publicadasHoje = 0 } = status;
    let texto;
    if (config.ativo) {
      const proxima = config.proxima_postagem_at && new Date(config.proxima_postagem_at) > new Date()
        ? `próxima às ${hora(config.proxima_postagem_at)}`
        : 'publica assim que ficar pronta';
      const agenda = status.agenda || {};
      texto = [
        `Ligado · a cada ${config.intervalo_minutos} min`,
        agenda.frase || null,
        agenda.dentro === false ? null : proxima,
        `${publicadasHoje}/${config.limite_dia} hoje`,
        status.modeloNome ? `escreve com ${status.modeloNome}` : null,
      ].filter(Boolean).join(' · ');
    } else if (config.existe) {
      const desde = config.pausado_at
        ? ` desde ${new Date(config.pausado_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
        : '';
      texto = `Pausado${desde} · ${publicadasHoje} publicada(s) hoje`;
    } else {
      texto = 'A IA escolhe, escreve, gera a imagem e publica sozinha.';
    }
    el.curto.textContent = texto;
    el.curto.dataset.tipo = config.ativo ? (config.ultimo_erro ? 'aviso' : 'ok') : config.existe ? 'pausado' : '';
  }

  function render(status, { preencherForm = false } = {}) {
    ultimoStatus = status;
    renderChip(status);
    renderCurto(status);
    const { config, contagens = {}, publicadasHoje = 0 } = status;
    el.ativo.checked = Boolean(config.ativo);
    if (!formPreenchido || preencherForm) {
      if (!formPreenchido && el.mais && !config.existe) el.mais.open = true;
      formPreenchido = true;
      el.intervalo.value = String(config.intervalo_minutos || 10);
      el.limite.value = String(config.limite_dia || 40);
      if (![...el.limite.options].some((o) => o.value === el.limite.value)) {
        el.limite.append(new Option(String(config.limite_dia), String(config.limite_dia)));
        el.limite.value = String(config.limite_dia);
      }
      el.foto.checked = config.foto_original_se_falhar !== false;
      if (el.modoImagem) {
        el.modoImagem.value = config.modo_imagem === 'original' ? 'original' : 'ia';
        aplicarModoImagem();
      }
      preencherAgenda(config.agenda);
      if (config.facebook_page_id) el.pagina.value = String(config.facebook_page_id);
      // Outro navegador/computador: traz as palavras-chave que o piloto usa.
      if ((config.palavras || []).length) {
        document.dispatchEvent(new CustomEvent('furos:palavras-definir', { detail: config.palavras }));
      }
    }
    el.escanear.hidden = !config.ativo;
    secao.classList.toggle('is-ativo', Boolean(config.ativo));

    if (!config.ativo) {
      const desde = config.pausado_at ? ` desde ${new Date(config.pausado_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
      setResumo(config.existe
        ? `Pausado${desde} · ${publicadasHoje} publicada(s) hoje. A fila e a configuração estão guardadas; marque “Automatizar” para retomar.`
        : 'Desligado. Marque “Automatizar” para a IA trabalhar sozinha.', config.existe ? 'aviso' : '');
    } else {
      const imagens = (contagens.gerando_imagem || 0);
      const partes = [
        `Ligado · posta a cada ${config.intervalo_minutos} min`,
        status.agenda && status.agenda.modo !== 'sempre' ? `agenda: ${status.agenda.regra} (${status.agenda.frase})` : null,
        (config.palavras || []).length
          ? `palavras-chave: ${config.palavras.length > 4 ? `${config.palavras.slice(0, 4).join(', ')} +${config.palavras.length - 4}` : config.palavras.join(', ')}`
          : null,
        status.modeloNome ? `escreve com ${status.modeloNome}` : null,
        config.proxima_postagem_at && new Date(config.proxima_postagem_at) > new Date()
          ? `próxima postagem às ${hora(config.proxima_postagem_at)}`
          : 'publica a próxima assim que ficar pronta',
        status.escaneandoAgora ? 'procurando pautas agora…' : status.proximoScan ? `próxima varredura às ${hora(status.proximoScan)}` : 'varrendo em instantes',
        `${publicadasHoje}/${config.limite_dia} hoje`,
        `fila ${contagens.na_fila || 0}`,
        `escrevendo ${contagens.escrevendo || 0}`,
        `imagem ${imagens}/${status.maxImagens || 2} (+${contagens.aguardando_imagem || 0} aguardando)`,
        `agendadas ${contagens.agendada || 0}`,
      ];
      setResumo(
        partes.filter(Boolean).join(' · ') +
          (config.ultimo_scan_resumo ? `\nÚltima varredura: ${config.ultimo_scan_resumo}` : '') +
          (config.ultimo_erro ? `\nÚltimo problema: ${config.ultimo_erro}` : ''),
        config.ultimo_erro ? 'aviso' : 'ok'
      );
    }

    el.itens.replaceChildren();
    for (const item of status.itens || []) {
      const [rotulo, classe] = ETAPAS[item.status] || [item.status, ''];
      const li = document.createElement('li');
      li.className = `mia-furos-auto-item ${classe}`;

      const corpo = document.createElement('div');
      const titulo = document.createElement('a');
      titulo.href = item.matter_id ? `/materias-ia/${item.matter_id}` : item.url;
      titulo.target = '_blank';
      titulo.rel = 'noopener';
      titulo.textContent = String(item.materia_titulo || item.titulo || item.url).replace(/\[\[|\]\]|\*\*/g, '');
      const meta = document.createElement('small');
      meta.textContent = [
        CANAL[item.canal] || item.canal,
        item.nota_ia != null ? `nota ${item.nota_ia}` : null,
        item.status === 'publicada' && item.publicado_at ? `às ${hora(item.publicado_at)}` : null,
        item.status === 'agendada' && item.agendado_para ? `sai às ${hora(item.agendado_para)}` : null,
        item.status === 'pronta' || item.status === 'publicada' ? (item.imagem_ia ? 'imagem IA' : 'foto original') : null,
        item.erro || item.motivo,
      ].filter(Boolean).join(' · ');
      corpo.append(titulo, meta);

      const selo = document.createElement('span');
      selo.className = 'mia-furos-auto-selo';
      selo.textContent = rotulo;
      li.append(corpo, selo);

      if (item.status === 'erro') {
        const refazer = document.createElement('button');
        refazer.type = 'button';
        refazer.className = 'mia-furos-auto-tirar';
        refazer.title = 'Tentar de novo';
        refazer.setAttribute('aria-label', 'Tentar de novo');
        refazer.textContent = '↻';
        refazer.addEventListener('click', async () => {
          refazer.disabled = true;
          try {
            render(await api(`${API}/itens/${item.id}/refazer`, { method: 'POST' }));
          } catch (err) {
            setResumo(err.message, 'erro');
            refazer.disabled = false;
          }
        });
        li.append(refazer);
      }
      if (['na_fila', 'aguardando_imagem', 'pronta', 'erro'].includes(item.status)) {
        const tirar = document.createElement('button');
        tirar.type = 'button';
        tirar.className = 'mia-furos-auto-tirar';
        tirar.title = 'Tirar da fila (não publica)';
        tirar.setAttribute('aria-label', 'Tirar da fila');
        tirar.textContent = '×';
        tirar.addEventListener('click', async () => {
          tirar.disabled = true;
          try {
            render(await api(`${API}/itens/${item.id}/descartar`, { method: 'POST' }));
          } catch (err) {
            setResumo(err.message, 'erro');
            tirar.disabled = false;
          }
        });
        li.append(tirar);
      }
      el.itens.append(li);
    }
  }

  async function atualizar() {
    try {
      const status = await api(API);
      await carregarPaginas(null); // só as opções; o valor vem do formulário
      render(status);
    } catch (err) {
      setResumo(err.message, 'erro');
    }
  }

  async function salvar(ativo) {
    el.salvar.disabled = true;
    el.ativo.disabled = true;
    try {
      const status = await api(API, {
        method: 'PUT',
        body: JSON.stringify({
          ...filtrosDoPainel(),
          ativo,
          intervalo_minutos: Number(el.intervalo.value) || 10,
          limite_dia: Number(el.limite.value) || 40,
          facebook_page_id: el.pagina.value || null,
          foto_original_se_falhar: el.foto.checked,
          modo_imagem: el.modoImagem?.value === 'original' ? 'original' : 'ia',
          agenda: lerAgendaDoForm(),
          modelo: document.getElementById('chat-ai-model')?.dataset.modelo || null,
        }),
      });
      render(status, { preencherForm: true });
      if (ativo) setTimeout(atualizar, 3000);
    } catch (err) {
      el.ativo.checked = Boolean(ultimoStatus?.config?.ativo);
      setResumo(err.message, 'erro');
    } finally {
      el.salvar.disabled = false;
      el.ativo.disabled = false;
    }
  }

  el.ativo.addEventListener('change', () => {
    if (el.ativo.checked && !confirm(
      'Ligar o piloto automático?\n\nA IA vai escolher as pautas, escrever, gerar a imagem e PUBLICAR na página sozinha, ' +
      `uma a cada ${el.intervalo.value} min (até ${el.limite.value} por dia).`
    )) {
      el.ativo.checked = false;
      return;
    }
    if (!el.ativo.checked) {
      pausar();
      return;
    }
    salvar(true);
  });

  async function pausar() {
    if (!confirm('Pausar o piloto?\n\nNada novo será publicado até você retomar. A fila e a configuração ficam guardadas.')) {
      el.ativo.checked = true;
      return;
    }
    el.ativo.disabled = true;
    try {
      render(await api(`${API}/pausar`, { method: 'POST' }));
    } catch (err) {
      el.ativo.checked = true;
      setResumo(err.message, 'erro');
    } finally {
      el.ativo.disabled = false;
    }
  }
  el.salvar.addEventListener('click', () => salvar(el.ativo.checked));
  el.escanear.addEventListener('click', async () => {
    el.escanear.disabled = true;
    try {
      render(await api(`${API}/escanear`, { method: 'POST' }));
      setTimeout(atualizar, 5000);
    } catch (err) {
      setResumo(err.message, 'erro');
    } finally {
      el.escanear.disabled = false;
    }
  });

  let modeloVisto = null;
  document.addEventListener('materia:modelo-alterado', async () => {
    const modelo = document.getElementById('chat-ai-model')?.dataset.modelo || '';
    if (modeloVisto === null) {
      modeloVisto = modelo; // primeiro disparo = carregamento da página
      return;
    }
    if (modelo === modeloVisto) return;
    modeloVisto = modelo;
    if (!ultimoStatus?.config?.existe) return;
    try {
      const status = await api(`${API}/modelo`, { method: 'PUT', body: JSON.stringify({ modelo: modelo || null }) });
      renderChip(status);
      if (!dialog.hidden) render(status);
    } catch (err) {
      if (!dialog.hidden) setResumo(`Não troquei o modelo do piloto: ${err.message}`, 'erro');
    }
  });

  async function atualizarChip() {
    if (!dialog.hidden) return;
    try {
      const status = await api(API);
      ultimoStatus = status;
      renderChip(status);
    } catch {
      // indicador é só informativo
    }
  }
  atualizarChip();
  setInterval(() => {
    if (!document.hidden) atualizarChip();
  }, 60_000);

  // Atualiza enquanto o painel do Furos estiver aberto.
  new MutationObserver(() => {
    clearInterval(timer);
    if (!dialog.hidden) {
      formPreenchido = false;
      atualizar();
      timer = setInterval(atualizar, 10_000);
    }
  }).observe(dialog, { attributes: true, attributeFilter: ['hidden'] });
})();
