/**
 * Página "Piloto automático": acompanha o piloto do Furos do dia, que roda no
 * servidor, e permite pausar, retomar ou forçar uma varredura.
 */
(function () {
  const API = '/api/materias-ia/chat-extras/furos/auto';
  const $ = (id) => document.getElementById(id);
  const el = {
    luz: $('piloto-luz'),
    titulo: $('piloto-titulo'),
    sub: $('piloto-sub'),
    pausar: $('piloto-pausar'),
    retomar: $('piloto-retomar'),
    varrer: $('piloto-varrer'),
    cancelarFila: $('piloto-cancelar-fila'),
    aviso: $('piloto-aviso'),
    itens: $('piloto-itens'),
    vazio: $('piloto-vazio'),
    atualizado: $('piloto-atualizado'),
    varredura: $('piloto-varredura'),
    fora: $('piloto-fora'),
    foraN: $('piloto-fora-n'),
    foraItens: $('piloto-fora-itens'),
  };
  if (!el.itens) return;

  const ETAPAS = {
    na_fila: ['Na fila', 'bg-slate-500/20 text-slate-300'],
    escrevendo: ['Escrevendo', 'bg-sky-500/15 text-sky-300'],
    aguardando_imagem: ['Aguardando imagem', 'bg-slate-500/20 text-slate-300'],
    gerando_imagem: ['Gerando imagem com IA', 'bg-sky-500/15 text-sky-300'],
    pronta: ['Pronta para agendar', 'bg-amber-500/15 text-amber-300'],
    agendada: ['Agendada', 'bg-amber-500/15 text-amber-300'],
    publicando: ['Publicando', 'bg-sky-500/15 text-sky-300'],
    publicada: ['Publicada', 'bg-emerald-500/15 text-emerald-300'],
    erro: ['Não publicada', 'bg-rose-500/15 text-rose-300'],
  };
  const CANAL = { noticias: 'Notícia', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };

  async function api(url, opts = {}) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Falha na requisição (${res.status})`);
    return data;
  }

  function quando(valor, { comDia = false } = {}) {
    if (!valor) return '';
    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return '';
    const hoje = new Date().toDateString() === d.toDateString();
    return d.toLocaleString('pt-BR', hoje && !comDia
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function aviso(texto, tipo = 'erro') {
    el.aviso.textContent = texto || '';
    el.aviso.classList.toggle('hidden', !texto);
    el.aviso.className = `mt-3 rounded-lg border px-3 py-2 text-sm ${texto ? '' : 'hidden'} ${
      tipo === 'ok' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
        : tipo === 'aviso' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          : 'border-rose-500/40 bg-rose-500/10 text-rose-300'}`;
  }

  function botao(texto, titulo, aoClicar, estilo = 'border-slate-700 text-slate-300 hover:border-emerald-500 hover:text-emerald-300') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `shrink-0 rounded-md border px-2 py-1 text-xs ${estilo}`;
    b.title = titulo;
    b.textContent = texto;
    b.addEventListener('click', () => aoClicar(b));
    return b;
  }

  function renderForaDaFila(lista) {
    el.fora.classList.toggle('hidden', !lista.length);
    el.foraN.textContent = lista.length ? `(${lista.length})` : '';
    el.foraItens.replaceChildren();
    for (const item of lista) {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3';
      const corpo = document.createElement('div');
      corpo.className = 'min-w-0 flex-1';
      const link = document.createElement('a');
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'block truncate text-sm text-slate-200 hover:underline';
      link.textContent = item.titulo || item.url;
      const meta = document.createElement('p');
      meta.className = 'mt-0.5 truncate text-xs text-slate-500';
      meta.textContent = [
        CANAL[item.canal] || item.canal,
        item.nota_ia != null ? `nota ${item.nota_ia}` : null,
        item.erro,
        item.motivo,
      ].filter(Boolean).join(' · ');
      meta.title = meta.textContent;
      corpo.append(link, meta);
      li.append(corpo, botao('Publicar mesmo assim', 'Coloca esta pauta na fila do piloto',
        (b) => acao(`${API}/itens/${item.id}/refazer`, b)));
      el.foraItens.append(li);
    }
  }

  function render(s) {
    const { config, contagens = {}, publicadasHoje = 0 } = s;
    const ligado = config.ativo;
    el.luz.className = `inline-block h-3 w-3 rounded-full ${ligado ? 'bg-emerald-400 animate-pulse' : config.existe ? 'bg-amber-400' : 'bg-slate-500'}`;
    const filaManual = Number(s.filaManual) || 0;
    const agenda = s.agenda || {};
    const foraDoHorario = ligado && agenda.dentro === false;
    el.titulo.textContent = ligado
      ? foraDoHorario ? 'Ligado · aguardando o horário' : 'Ligado'
      : filaManual
        ? 'Publicando a fila escolhida'
        : config.existe ? 'Pausado' : 'Ainda não configurado';
    el.sub.textContent = ligado
      ? [
          `Publica a cada ${config.intervalo_minutos} min (até ${config.limite_dia} por dia)`,
          agenda.modo && agenda.modo !== 'sempre' ? `agenda: ${agenda.regra} — ${agenda.frase}` : null,
          s.modeloNome ? `escreve com ${s.modeloNome}` : null,
          config.proxima_postagem_at && new Date(config.proxima_postagem_at) > new Date()
            ? `próximo horário livre às ${quando(config.proxima_postagem_at)}`
            : 'agenda a próxima assim que ficar pronta',
          s.escaneandoAgora ? 'procurando pautas agora…' : s.proximoScan ? `próxima varredura às ${quando(s.proximoScan)}` : 'varrendo em instantes',
        ].filter(Boolean).join(' · ')
      : filaManual
        ? `${filaManual} matéria(s) escolhida(s) por você no Furos do dia · publica 1 a cada ${config.intervalo_minutos} min${config.proxima_postagem_at && new Date(config.proxima_postagem_at) > new Date() ? ` · próxima às ${quando(config.proxima_postagem_at)}` : ''}. A varredura automática está pausada.`
        : config.existe
        ? `Pausado${config.pausado_at ? ` desde ${quando(config.pausado_at, { comDia: true })}` : ''}. A fila e a configuração estão guardadas; nada é publicado até retomar.`
        : 'Ligue o “Automatizar” no Furos do dia para configurar nichos, fontes, intervalo e página.';
    el.pausar.hidden = !ligado;
    el.retomar.hidden = ligado || !config.existe;
    el.varrer.hidden = !ligado;
    el.cancelarFila.hidden = !filaManual;
    if (!ligado && filaManual) el.luz.className = 'inline-block h-3 w-3 rounded-full bg-sky-400 animate-pulse';
    if (foraDoHorario && !filaManual) el.luz.className = 'inline-block h-3 w-3 rounded-full bg-sky-400';
    el.varredura.classList.toggle('hidden', !config.ultimo_scan_resumo);
    el.varredura.textContent = config.ultimo_scan_resumo
      ? `Última varredura${config.ultimo_scan_at ? ` (${quando(config.ultimo_scan_at)})` : ''}: ${config.ultimo_scan_resumo}`
      : '';
    renderForaDaFila(s.foraDaFila || []);
    if (config.ultimo_erro) aviso(`Último problema: ${config.ultimo_erro}`, 'aviso');
    else if (el.aviso.dataset.fixo !== '1') aviso('');

    const imagens = contagens.gerando_imagem || 0;
    $('piloto-n-fila').textContent = contagens.na_fila || 0;
    $('piloto-n-escrevendo').textContent = contagens.escrevendo || 0;
    $('piloto-n-imagem').textContent = `${imagens}/${s.maxImagens || 2}${contagens.aguardando_imagem ? ` +${contagens.aguardando_imagem}` : ''}`;
    $('piloto-n-prontas').textContent = `${contagens.agendada || 0}${contagens.pronta ? ` +${contagens.pronta}` : ''}`;
    $('piloto-n-hoje').textContent = config.existe ? `${publicadasHoje}/${config.limite_dia}` : publicadasHoje;

    el.itens.replaceChildren();
    el.vazio.classList.toggle('hidden', (s.itens || []).length > 0);
    for (const item of s.itens || []) {
      const [rotulo, cor] = ETAPAS[item.status] || [item.status, 'bg-slate-500/20 text-slate-300'];
      const li = document.createElement('li');
      li.className = 'flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3';

      const corpo = document.createElement('div');
      corpo.className = 'min-w-0 flex-1';
      const link = document.createElement('a');
      link.href = item.matter_id ? `/materias-ia/${item.matter_id}` : item.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'block truncate text-sm text-white hover:underline';
      link.textContent = String(item.materia_titulo || item.titulo || item.url).replace(/\[\[|\]\]|\*\*/g, '');
      const meta = document.createElement('p');
      meta.className = 'mt-0.5 truncate text-xs text-slate-400';
      meta.textContent = [
        CANAL[item.canal] || item.canal,
        item.origem === 'manual' ? 'escolhida por você' : null,
        item.nota_ia != null ? `nota ${item.nota_ia}` : null,
        item.status === 'publicada' && item.publicado_at
          ? `publicada ${quando(item.publicado_at)}`
          : item.status === 'agendada' && item.agendado_para
            ? `sai ${quando(item.agendado_para, { comDia: true })}`
            : quando(item.updated_at),
        ['pronta', 'publicada'].includes(item.status) ? (item.imagem_ia ? 'imagem IA' : 'foto original') : null,
        item.erro || item.motivo,
      ].filter(Boolean).join(' · ');
      meta.title = meta.textContent;
      corpo.append(link, meta);

      const selo = document.createElement('span');
      selo.className = `shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${cor}`;
      selo.textContent = rotulo;
      li.append(corpo, selo);

      if (item.status === 'erro') {
        li.append(botao('Tentar de novo', 'Volta para a etapa em que parou', (b) => acao(`${API}/itens/${item.id}/refazer`, b)));
      }
      if (['na_fila', 'aguardando_imagem', 'pronta', 'agendada', 'erro'].includes(item.status)) {
        const tirar = document.createElement('button');
        tirar.type = 'button';
        tirar.className = 'shrink-0 rounded-md border border-slate-700 px-2 text-slate-400 hover:border-rose-500 hover:text-rose-300';
        tirar.title = 'Tirar da fila (não publica)';
        tirar.setAttribute('aria-label', 'Tirar da fila');
        tirar.textContent = '×';
        tirar.addEventListener('click', () => acao(`${API}/itens/${item.id}/descartar`, tirar));
        li.append(tirar);
      }
      el.itens.append(li);
    }
    el.atualizado.textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }

  async function atualizar() {
    try {
      render(await api(API));
    } catch (err) {
      aviso(err.message);
    }
  }

  async function acao(url, botao, confirmar = null) {
    if (confirmar && !confirm(confirmar)) return;
    if (botao) botao.disabled = true;
    try {
      render(await api(url, { method: 'POST' }));
    } catch (err) {
      aviso(err.message);
    } finally {
      if (botao) botao.disabled = false;
    }
  }

  el.pausar.addEventListener('click', () =>
    acao(`${API}/pausar`, el.pausar, 'Pausar o piloto?\n\nNada novo será publicado até você retomar. O que já está sendo escrito ou gerando imagem termina e fica na fila.'));
  el.retomar.addEventListener('click', () =>
    acao(`${API}/retomar`, el.retomar, 'Retomar o piloto?\n\nEle volta a procurar pautas e a PUBLICAR sozinho na página.'));
  el.varrer.addEventListener('click', () => acao(`${API}/escanear`, el.varrer));
  el.cancelarFila.addEventListener('click', () =>
    acao(`${API}/fila/cancelar`, el.cancelarFila, 'Cancelar a fila escolhida?\n\nAs matérias que ainda não foram publicadas saem da fila (as já publicadas continuam na página).'));

  atualizar();
  setInterval(() => {
    if (!document.hidden) atualizar();
  }, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) atualizar();
  });
})();
