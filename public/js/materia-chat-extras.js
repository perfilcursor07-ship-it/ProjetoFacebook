/**
 * Extras do chat de matérias (/materia-manual), carregado depois do
 * materia-chat.js. Não altera o chat existente: injeta os controles novos e
 * usa os elementos que já estão na página.
 *
 *  1. Botão "Em alta" ao lado de Escrever/Pautas — ao clicar já lista os
 *     assuntos do momento (política, igreja evangélica, polêmica gospel) e
 *     permite buscar outro tema. Clicar em um manda a IA escrever a matéria.
 *  2. Anexar PDF — o texto do arquivo entra no pedido enviado à IA.
 *  3. Anexar imagem — OCR identifica o texto do print e o transforma em pauta.
 */
(() => {
  const API = '/api/materias-ia/chat-extras';
  const MAX_PDF_NO_PEDIDO = 12000;
  const MAX_TOPICOS_LOTE = 8;
  /** Limite da fila do servidor (furosAutopilotService.MAX_ESCOLHIDAS). */
  const MAX_AGENDAR = 20;
  const INTERVALOS_AGENDA = [5, 10, 15, 20, 30, 60];
  const INTERVALO_KEY = 'ViralizeAI.radarIntervalo';
  /** Quantos esqueletos aparecem enquanto o radar carrega. */
  const ESQUELETOS = 6;

  const el = {
    seg: document.querySelector('.mia-chat-seg'),
    tools: document.querySelector('.mia-chat-tools'),
    // Atalhos de pauta e anexos moram no menu "+". Sem os contêineres novos
    // (view antiga em cache), voltam para onde ficavam antes.
    descobrir: document.getElementById('chat-menu-descobrir'),
    anexos: document.getElementById('chat-menu-anexos'),
    ferramentas: document.getElementById('chat-ferramentas'),
    composer: document.getElementById('chat-composer'),
    input: document.getElementById('chat-input'),
    enviar: document.getElementById('chat-enviar'),
    mensagens: document.getElementById('chat-mensagens'),
    vazio: document.getElementById('chat-vazio'),
    status: document.getElementById('chat-status'),
    periodo: document.getElementById('chat-periodo'),
  };

  if (!el.seg || !el.tools || !el.input || !el.enviar || !el.mensagens) return;

  const alvoDescobrir = el.descobrir || el.seg;
  const alvoAnexos = el.anexos || el.tools;
  /** No menu os itens são chips de largura cheia; na faixa antiga, segmentos. */
  const classeDescobrir = el.descobrir ? 'mia-chat-chip' : 'mia-chat-seg-btn';

  /** Um atalho escolhido já mostra o resultado no chat: o menu não precisa ficar aberto. */
  function fecharFerramentas() {
    if (el.ferramentas) el.ferramentas.open = false;
  }

  let anexo = null;
  let anexoImagem = null;
  let altaAtiva = false;
  let carregandoAlta = false;
  let publicoAtivo = false;
  let carregandoPublico = false;
  let paginaFacebookAtiva = false;
  let carregandoPaginaFacebook = false;
  let carregandoMaisLidas = false;

  /* ------------------------------ estilos ------------------------------ */

  const estilos = document.createElement('style');
  estilos.textContent = `
    .mia-x-anexo-btn, .mia-x-imagem-btn, .mia-x-alta-btn, .mia-x-publico-btn, .mia-x-facebook-btn { cursor: pointer; }
    .mia-x-chip {
      display: inline-flex; align-items: center; gap: .4rem;
      max-width: 100%; margin: .5rem 0 0; padding: .35rem .5rem .35rem .6rem;
      border: 1px solid rgba(16,185,129,.35); border-radius: .6rem;
      background: rgba(16,185,129,.1); color: #a7f3d0;
      font-size: .75rem; line-height: 1.3;
    }
    .mia-x-chip-nome { max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mia-x-chip-meta { color: #6ee7b7; opacity: .75; }
    .mia-x-chip-x {
      display: flex; align-items: center; justify-content: center;
      width: 1.1rem; height: 1.1rem; border: none; border-radius: .3rem;
      background: transparent; color: #6ee7b7; cursor: pointer; font-size: .9rem; line-height: 1;
    }
    .mia-x-chip-x:hover { background: rgba(244,63,94,.2); color: #fecdd3; }

    .mia-x-alta { border: 1px solid #1e293b; border-radius: .9rem; background: rgba(2,6,23,.4); padding: .75rem; }
    .mia-x-alta-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; }
    .mia-x-alta-title { margin: 0; font-size: .7rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #64748b; }
    .mia-x-temas { display: flex; flex-wrap: wrap; gap: .3rem; margin: .5rem 0 .1rem; }
    .mia-x-tema {
      border: 1px solid rgba(16,185,129,.2); border-radius: .35rem; padding: .18rem .45rem;
      background: rgba(16,185,129,.12); color: #6ee7b7;
      font-size: .65rem; font-weight: 500; cursor: pointer;
    }
    .mia-x-tema:hover { border-color: rgba(16,185,129,.7); color: #d1fae5; }
    .mia-x-google-trends {
      margin: .65rem 0 .15rem; padding: .65rem;
      border: 1px solid rgba(52,211,153,.2); border-radius: .7rem;
      background: rgba(16,185,129,.055);
    }
    .mia-x-google-trends-title {
      margin: 0 0 .45rem; color: #a7f3d0; font-size: .68rem; font-weight: 650;
    }
    .mia-x-google-trends-list { display: flex; flex-wrap: wrap; gap: .35rem; }
    .mia-x-google-trend {
      border: 1px solid #3f5149; border-radius: 999px; background: #29332f;
      padding: .28rem .55rem; color: #d6d3ca; font-size: .68rem; line-height: 1.2;
      cursor: pointer;
    }
    .mia-x-google-trend:hover { border-color: #10b981; color: #fff; background: #244137; }
    .mia-x-source-filter {
      display: flex; flex-wrap: wrap; gap: .35rem; margin: .65rem 0 .55rem;
      padding-bottom: .55rem; border-bottom: 1px solid #1e293b;
    }
    .mia-x-source-filter button {
      display: inline-flex; align-items: center; gap: .35rem;
      border: 1px solid #334155; border-radius: .5rem; background: rgba(15,23,42,.55);
      padding: .3rem .55rem; color: #94a3b8; font-size: .68rem; font-weight: 600;
      cursor: pointer; transition: border-color .15s, color .15s, background .15s;
    }
    .mia-x-source-filter button:hover { border-color: rgba(16,185,129,.55); color: #e2e8f0; }
    .mia-x-source-filter button.is-active {
      border-color: rgba(16,185,129,.75); background: rgba(16,185,129,.12); color: #a7f3d0;
    }
    .mia-x-source-filter-count {
      min-width: 1.15rem; border-radius: 999px; background: rgba(100,116,139,.2);
      padding: .05rem .3rem; text-align: center; color: #cbd5e1; font-size: .62rem;
    }
    .mia-x-source-filter button.is-active .mia-x-source-filter-count {
      background: rgba(16,185,129,.22); color: #d1fae5;
    }
    .mia-x-bases {
      margin: .55rem 0 .7rem; padding: .55rem .65rem;
      border-left: 2px solid rgba(244,63,94,.65); background: rgba(136,19,55,.08);
    }
    .mia-x-bases-title { margin: 0 0 .35rem; color: #fda4af; font-size: .68rem; font-weight: 600; }
    .mia-x-base { display: block; margin-top: .25rem; color: #cbd5e1; font-size: .68rem; line-height: 1.35; }
    .mia-x-base.hidden { display: none; }
    .mia-x-base-meta { color: #64748b; }
    .mia-x-result-note { margin: .3rem 0 0; color: #64748b; font-size: .68rem; line-height: 1.35; }
    .mia-x-result-note.is-warning { color: #fcd34d; }
    .mia-x-busca { display: flex; gap: .4rem; margin: .6rem 0; }
    .mia-x-busca input {
      flex: 1; min-width: 0; border: 1px solid #334155; border-radius: .5rem;
      background: #020617; padding: .35rem .55rem; color: #e2e8f0; font-size: .75rem; outline: none;
    }
    .mia-x-busca input:focus { border-color: #10b981; }
    .mia-x-busca button {
      flex-shrink: 0; border: none; border-radius: .5rem; background: #10b981; color: #022c22;
      padding: .35rem .7rem; font-size: .7rem; font-weight: 600; cursor: pointer;
    }
    .mia-x-busca button:hover { background: #34d399; }
    .mia-x-busca button:disabled { opacity: .55; cursor: default; }

    .mia-x-lote {
      display: flex; flex-wrap: wrap; align-items: center; gap: .4rem;
      margin: .45rem 0 .65rem;
    }
    .mia-x-lote button {
      border-radius: .5rem; padding: .35rem .65rem;
      font-size: .7rem; font-weight: 600; cursor: pointer;
    }
    .mia-x-lote-select {
      border: 1px solid #334155; background: transparent; color: #cbd5e1;
    }
    .mia-x-lote-select:hover { border-color: rgba(16,185,129,.6); color: #fff; }
    .mia-x-lote-gerar {
      border: none; background: #10b981; color: #022c22;
    }
    .mia-x-lote-gerar:hover { background: #34d399; }
    .mia-x-lote-gerar:disabled { opacity: .55; cursor: default; }
    .mia-x-lote-save {
      border: none; background: #10b981; color: #022c22;
    }
    .mia-x-lote-save:hover { background: #34d399; }
    .mia-x-lote-save:disabled { opacity: .55; cursor: default; }

    .mia-x-alta-list { display: flex; flex-direction: column; gap: .5rem; }
    .mia-x-source-group { display: flex; flex-direction: column; gap: .5rem; }
    .mia-x-source-group + .mia-x-source-group { margin-top: .55rem; }
    .mia-x-source-group[hidden] { display: none; }
    .mia-x-source-head {
      display: flex; align-items: center; justify-content: space-between; gap: .75rem;
      margin: 0; padding: .55rem .1rem .25rem; color: #e2e8f0;
      font-size: .75rem; font-weight: 700;
    }
    .mia-x-source-head-count { color: #64748b; font-size: .65rem; font-weight: 500; }
    .mia-x-card {
      display: flex; gap: .6rem; width: 100%; text-align: left;
      border: 1px solid #1e293b; border-radius: .75rem; background: rgba(15,23,42,.55);
      padding: .6rem .7rem; cursor: pointer; transition: border-color .15s, background .15s;
    }
    .mia-x-card:hover { border-color: rgba(16,185,129,.55); background: rgba(15,23,42,.9); }
    .mia-x-card.is-selected { border-color: rgba(16,185,129,.65); background: rgba(16,185,129,.08); }
    .mia-x-card-check {
      flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      width: 1.2rem; height: 1.4rem;
    }
    .mia-x-card-check input { width: 1rem; height: 1rem; accent-color: #10b981; cursor: pointer; }
    .mia-x-card-pos {
      flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      width: 1.4rem; height: 1.4rem; border-radius: .4rem;
      background: rgba(16,185,129,.12); color: #6ee7b7;
      font-size: .68rem; font-weight: 700; font-variant-numeric: tabular-nums;
    }
    .mia-x-card-txt { min-width: 0; flex: 1; }
    .mia-x-card-thumb {
      flex: 0 0 4.5rem; width: 4.5rem; height: 4.5rem; border-radius: .55rem;
      object-fit: cover; background: #020617; border: 1px solid #1e293b;
    }
    .mia-x-card-thumb.is-carregando {
      background: linear-gradient(90deg, #0f172a, #1e293b, #0f172a);
      background-size: 200% 100%; animation: mia-x-brilho 1.3s linear infinite;
    }
    .mia-x-card-thumb.is-sem-imagem { display: none; }
    @keyframes mia-x-brilho { to { background-position: -200% 0; } }
    .mia-x-card.is-agendada { border-color: rgba(52,211,153,.45); background: rgba(16,185,129,.06); }
    .mia-x-agenda {
      display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; margin: -.1rem 0 .6rem;
      font-size: .72rem; color: #94a3b8;
    }
    .mia-x-agenda-select {
      color-scheme: dark; background: #0b1220; color: #e2e8f0; border: 1px solid #334155;
      border-radius: .45rem; padding: .3rem .45rem; font-size: .72rem;
    }
    .mia-x-agenda-select option { background: #0f172a; color: #e2e8f0; }
    .mia-x-lote-agendar {
      border: 0; border-radius: .45rem; padding: .35rem .8rem; cursor: pointer;
      background: linear-gradient(135deg, #fdba74, #fb923c); color: #431407; font-size: .72rem; font-weight: 700;
    }
    .mia-x-lote-agendar:hover:not(:disabled) { filter: brightness(1.08); }
    .mia-x-lote-agendar:disabled { opacity: .5; cursor: default; }
    .mia-x-card-tit { display: block; font-size: .8125rem; font-weight: 500; line-height: 1.35; color: #e2e8f0; }
    .mia-x-card-meta { display: block; margin-top: .2rem; font-size: .65rem; color: #64748b; }
    .mia-x-card-res { display: block; margin-top: .25rem; font-size: .7rem; line-height: 1.4; color: #94a3b8; }
    .mia-x-card-actions { flex-shrink: 0; display: flex; align-items: flex-start; gap: .35rem; }
    .mia-x-card-gerar {
      border: 1px solid rgba(16,185,129,.45); border-radius: .5rem;
      background: rgba(16,185,129,.12); color: #a7f3d0;
      padding: .25rem .5rem; font-size: .68rem; font-weight: 600; cursor: pointer;
    }
    .mia-x-card-gerar:hover { border-color: rgba(16,185,129,.8); color: #fff; }
    .mia-x-card-gerar:disabled { opacity: .6; cursor: default; }
    .mia-x-card-publicar {
      border: 0; border-radius: .5rem; padding: .25rem .55rem; cursor: pointer;
      background: linear-gradient(135deg, #fdba74, #fb923c); color: #431407; font-size: .68rem; font-weight: 700;
    }
    .mia-x-card-publicar:hover:not(:disabled) { filter: brightness(1.08); }
    .mia-x-card-publicar:disabled { opacity: .55; cursor: default; }
    .mia-x-card-fila { display: block; margin-top: .3rem; font-size: .68rem; font-weight: 600; color: #fdba74; }
    .mia-x-card-fila[data-estado="ok"] { color: #6ee7b7; }
    .mia-x-card-fila[data-estado="erro"] { color: #fda4af; }
    .mia-x-card-fila a { margin-left: .35rem; color: #6ee7b7; text-decoration: underline; text-underline-offset: 2px; }
    .mia-x-card.is-publicada { border-color: rgba(52,211,153,.55); background: rgba(16,185,129,.07); }
    .mia-x-card-fonte {
      border: 1px solid #334155; border-radius: .5rem; background: transparent; color: #cbd5e1;
      padding: .25rem .5rem; font-size: .68rem; font-weight: 600; text-decoration: none;
    }
    .mia-x-card-fonte:hover { border-color: #64748b; color: #fff; }
    @media (max-width: 560px) {
      .mia-x-card { flex-wrap: wrap; }
      .mia-x-card-thumb { flex-basis: 4rem; width: 4rem; height: 4rem; }
      .mia-x-card-txt { flex-basis: calc(100% - 4rem); }
      .mia-x-card-actions { width: 100%; justify-content: flex-end; }
    }

    .mia-x-carregando {
      display: flex; align-items: center; gap: .5rem; margin: 0;
      color: #cbd5e1; font-size: .8125rem; line-height: 1.4;
    }
    .mia-x-spin {
      flex-shrink: 0; width: .9rem; height: .9rem; border-radius: 50%;
      border: 2px solid rgba(148,163,184,.3); border-top-color: #10b981;
      animation: mia-x-rodar .7s linear infinite;
    }
    @keyframes mia-x-rodar { to { transform: rotate(360deg); } }
    .mia-x-skel {
      height: 3.4rem; border-radius: .75rem; border: 1px solid #1e293b;
      background-image: linear-gradient(90deg, rgba(15,23,42,.55) 25%, rgba(30,41,59,.8) 37%, rgba(15,23,42,.55) 63%);
      background-size: 400% 100%;
      animation: mia-x-brilho 1.4s ease infinite;
    }
    @keyframes mia-x-brilho { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
    .mia-x-erro {
      border: 1px solid rgba(244,63,94,.35); border-radius: .75rem;
      background: rgba(244,63,94,.08); padding: .6rem .7rem;
      color: #fecdd3; font-size: .75rem; line-height: 1.45;
    }
    @media (prefers-reduced-motion: reduce) {
      .mia-x-spin, .mia-x-skel { animation: none; }
    }
  `;
  document.head.appendChild(estilos);

  /* ------------------------------ helpers ------------------------------ */

  function setStatus(texto) {
    if (el.status) el.status.textContent = texto || '';
  }

  function formatarDataPauta(topico) {
    const ts = Number(topico?.dataTimestamp) || Date.parse(String(topico?.data || ''));
    if (!Number.isFinite(ts) || ts <= 0) return '';
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(ts));
  }

  async function apiJson(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const bruto = await res.text();
    let data = null;
    try {
      data = bruto ? JSON.parse(bruto) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new Error(data?.error || `Falha na requisição (${res.status})`);
    return data;
  }

  function botaoModo(nome) {
    return document.querySelector(`.chat-modo-btn[data-chat-modo="${nome}"]`);
  }

  /** Bloco do radar na thread: sempre marcado para ser substituído depois. */
  function novoBlocoAlta() {
    const wrap = document.createElement('div');
    wrap.className = 'mia-msg-ai';
    wrap.dataset.miaAlta = '1';
    return wrap;
  }

  function mostrarBloco(wrap) {
    el.mensagens.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* --------------------------- botão "Em alta" -------------------------- */

  const ICONE_ALTA =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><path d="M13 2L4.5 12.5a1 1 0 0 0 .8 1.6H11l-1 7.9 8.5-10.5a1 1 0 0 0-.8-1.6H12z"/></svg>';
  const ICONE_PUBLICO =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>';
  const ICONE_FACEBOOK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>';
  const ICONE_MAIS_LIDAS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/><path d="M9 7h7M9 11h7"/><path d="m14 15 2 2 4-4"/></svg>';

  function criarBotaoDescobrir(classe, rotulo, dica, icone) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `${classeDescobrir} ${classe}`;
    b.setAttribute('aria-pressed', 'false');
    b.title = dica;
    b.innerHTML = el.descobrir ? `${icone}<span>${rotulo}</span>` : rotulo;
    alvoDescobrir.appendChild(b);
    return b;
  }


  const btnAlta = criarBotaoDescobrir(
    'mia-x-alta-btn',
    'Em alta',
    'Mostra os assuntos em alta agora para você escolher',
    ICONE_ALTA
  );

  const btnPublico = criarBotaoDescobrir(
    'mia-x-publico-btn',
    'Meu público',
    'Sugere pautas novas com base no que viralizou na sua página',
    ICONE_PUBLICO
  );

  const btnPaginaFacebook = criarBotaoDescobrir(
    'mia-x-facebook-btn',
    'Página do Facebook',
    'Cole uma página do Facebook, escolha os posts e crie rascunhos',
    ICONE_FACEBOOK
  );

  const atalhosRadar = {
    alta: document.getElementById('chat-radar-alta'),
    publico: document.getElementById('chat-radar-publico'),
  };

  function ligarAtalhoRadar(botao, acao) {
    if (!botao) return;
    botao.addEventListener('click', acao);
  }

  function rotuloJanelaRadar(horas) {
    const n = Number(horas) || 48;
    if (n === 24) return 'nas últimas 24 horas';
    if (n === 48) return 'nas últimas 48 horas';
    if (n === 72) return 'nos últimos 3 dias';
    if (n === 168) return 'nos últimos 7 dias';
    return `nas últimas ${n} horas`;
  }

  function desativarPaginaFacebook() {
    paginaFacebookAtiva = false;
    btnPaginaFacebook.setAttribute('aria-pressed', 'false');
    btnPaginaFacebook.classList.remove('is-active');
  }

  function desativarMaisLidas() {
    maisLidasAtiva = false;
  }

  function marcarMaisLidas(ativa) {
    maisLidasAtiva = ativa;
    if (!ativa) return;
    desativarPaginaFacebook();
    altaAtiva = false;
    publicoAtivo = false;
    btnAlta.setAttribute('aria-pressed', 'false');
    btnAlta.classList.remove('is-active');
    btnPublico.setAttribute('aria-pressed', 'false');
    btnPublico.classList.remove('is-active');
    document.querySelectorAll('.chat-modo-btn').forEach((b) => {
      b.classList.remove('is-active');
      b.setAttribute('aria-pressed', 'false');
    });
  }

  function marcarPublico(ativa) {
    publicoAtivo = ativa;
    btnPublico.setAttribute('aria-pressed', ativa ? 'true' : 'false');
    btnPublico.classList.toggle('is-active', ativa);
    if (!ativa) return;
    desativarMaisLidas();
    desativarPaginaFacebook();
    altaAtiva = false;
    btnAlta.setAttribute('aria-pressed', 'false');
    btnAlta.classList.remove('is-active');
    document.querySelectorAll('.chat-modo-btn').forEach((b) => {
      b.classList.remove('is-active');
      b.setAttribute('aria-pressed', 'false');
    });
  }

  function marcarAlta(ativa) {
    altaAtiva = ativa;
    btnAlta.setAttribute('aria-pressed', ativa ? 'true' : 'false');
    btnAlta.classList.toggle('is-active', ativa);
    if (!ativa) return;
    desativarMaisLidas();
    desativarPaginaFacebook();
    publicoAtivo = false;
    btnPublico.setAttribute('aria-pressed', 'false');
    btnPublico.classList.remove('is-active');
    // Os dois modos nativos saem do estado ativo enquanto o radar manda.
    document.querySelectorAll('.chat-modo-btn').forEach((b) => {
      b.classList.remove('is-active');
      b.setAttribute('aria-pressed', 'false');
    });
  }

  // Voltar para Escrever/Pautas desliga o radar.
  document.querySelectorAll('.chat-modo-btn').forEach((b) => {
    b.addEventListener('click', () => {
      marcarAlta(false);
      marcarPublico(false);
      desativarPaginaFacebook();
      desativarMaisLidas();
    });
  });

  function limparBlocosAlta() {
    el.mensagens.querySelectorAll('[data-mia-alta="1"]').forEach((n) => n.remove());
  }

  function textoPedidoTopicosSelecionados(topicos = []) {
    const lista = (Array.isArray(topicos) ? topicos : []).filter(Boolean);
    const regras = [
      'Use somente fatos presentes na apuração; nunca complete pela memória.',
      'Reescreva com estrutura e palavras próprias, sem copiar a fonte.',
      'Com a pesquisa ligada, cruze no mínimo duas fontes independentes e acrescente um elemento factual adicional.',
      'Produza de 3 a 6 parágrafos, sem enrolação, e inclua contexto factual verificável.',
      'Não encerre com opinião, lição moral, oração ou pergunta de engajamento.',
      'Não use muletas como “é importante destacar” ou “reacendeu o debate”.',
      'O texto completo deve respeitar o limite de 2.200 caracteres.',
    ];
    if (lista.length <= 1) {
      const topico = lista[0] || {};
      return [
        'Escreva uma matéria jornalística sobre este assunto que está em alta agora:',
        `Título: ${topico.titulo || ''}`,
        `Veículo: ${topico.veiculo || ''}`,
        `Link: ${topico.url || ''}`,
        '',
        ...regras,
      ].join('\n');
    }

    const blocos = lista.map((topico, indice) =>
      [
        `### ASSUNTO ${indice + 1}`,
        `Título: ${topico.titulo || ''}`,
        `Veículo: ${topico.veiculo || ''}`,
        `Link: ${topico.url || ''}`,
        topico.resumo ? `Resumo: ${topico.resumo}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    );

    return [
      `Escreva ${lista.length} matérias jornalísticas, uma para cada assunto selecionado em alta agora.`,
      `Limite obrigatório: escreva exatamente ${lista.length} matérias e pare na MATERIA ${lista.length}. Não crie assunto extra, variação, resumo adicional nem continuação.`,
      'Entregue tudo na mesma resposta. Separe cada texto com "### MATERIA n", seguido do título, corpo e hashtags daquela matéria.',
      'Não misture os fatos: cada matéria deve usar o assunto/link correspondente como base principal.',
      ...regras,
      '',
      ...blocos,
    ].join('\n');
  }

  function pedirMateriaDosTopicos(topicos) {
    const lista = (Array.isArray(topicos) ? topicos : []).filter(Boolean);
    if (!lista.length) return;
    marcarAlta(false);
    desativarMaisLidas();
    desativarPaginaFacebook();
    botaoModo('escrever')?.click();
    el.input.value = textoPedidoTopicosSelecionados(lista);
    el.input.dispatchEvent(new Event('input', { bubbles: true }));
    el.enviar.click();
  }

  function pedirMateriaDoTopico(topico) {
    pedirMateriaDosTopicos([topico]);
  }

  let paginasFacebookPromise = null;

  /** Preenche o seletor de página com as páginas da conta (padrão marcada). */
  async function carregarPaginasFacebook(select) {
    if (!paginasFacebookPromise) {
      paginasFacebookPromise = apiJson('/api/facebook/pages').catch(() => null);
    }
    const data = await paginasFacebookPromise;
    const paginas = Array.isArray(data?.pages) ? data.pages : [];
    if (!paginas.length || !select.isConnected) return;
    select.replaceChildren(...paginas.map((p) => {
      const opcao = new Option(p.page_name || p.name || `Página ${p.id}`, String(p.id));
      opcao.selected = Number(p.id) === Number(data.default_facebook_page_id);
      return opcao;
    }));
  }

  /**
   * Completa as fotos das pautas que chegaram sem imagem, 6 por vez, para a
   * lista aparecer na hora e as miniaturas irem surgindo. O link direto da
   * matéria (no lugar do link do Google) passa a valer para salvar e agendar.
   */
  async function buscarImagensDoRadar(itens) {
    // Chamada durante a montagem da lista: espera o bloco entrar na página,
    // senão a checagem isConnected abaixo descartaria todos os cartões.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pendentes = itens.filter((item) => !item.topico.imagem && item.topico.url);
    for (let i = 0; i < pendentes.length; i += 6) {
      const grupo = pendentes.slice(i, i + 6).filter((item) => item.card.isConnected);
      if (!grupo.length) return;
      let imagens = [];
      try {
        const data = await apiJson(`${API}/radar/imagens`, {
          method: 'POST',
          body: JSON.stringify({
            pautas: grupo.map(({ topico }) => ({ url: topico.url, titulo: topico.titulo, veiculo: topico.veiculo })),
          }),
        });
        imagens = data?.imagens || [];
      } catch {
        imagens = [];
      }
      grupo.forEach((item, indice) => {
        const achado = imagens[indice];
        if (achado?.url && achado.url !== item.topico.url) {
          item.topico.url = achado.url;
          if (achado.veiculo) item.topico.veiculo = achado.veiculo;
          const fonte = item.card.querySelector('.mia-x-card-fonte');
          if (fonte) fonte.href = achado.url;
        }
        if (achado?.imagem) {
          item.topico.imagem = achado.imagem;
          item.thumb.src = achado.imagem;
          item.thumb.classList.remove('is-carregando');
        } else {
          item.thumb.classList.add('is-sem-imagem');
        }
      });
    }
  }

  /* ------------------- publicar direto do card (fila do servidor) ------------------- */

  // Mesma fila do Furos do dia: a matéria é escrita, ganha imagem com IA e é
  // publicada sozinha no servidor. O card mostra cada etapa até publicar.
  const ETAPA_PUBLICACAO = {
    na_fila: 'Na fila para escrever…',
    escrevendo: 'Escrevendo a matéria…',
    aguardando_imagem: 'Esperando a vez da imagem…',
    gerando_imagem: 'Gerando a imagem com IA…',
    pronta: 'Pronta, agendando…',
    publicando: 'Publicando…',
  };
  const publicacoesAcompanhadas = new Map(); // itemId -> { card, botao, linha }
  let timerPublicacoes = null;

  function horaCurta(valor) {
    const d = valor ? new Date(valor) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  }

  function pautaParaFila(topico) {
    return {
      titulo: topico.titulo,
      url: topico.url,
      veiculo: topico.pagina ? `Facebook · ${topico.pagina}` : topico.veiculo || 'Web',
      resumo: topico.resumo || '',
      imagem: topico.imagem || null,
      data: topico.data || null,
      dataTimestamp: Number(topico.dataTimestamp) || null,
      nicho: topico.tema || null,
      canal: 'noticias',
      score: Number(topico.calor) || 0,
    };
  }

  function mostrarEtapaNoCard(alvo, texto, estado = '', matterId = null) {
    alvo.linha.textContent = texto;
    alvo.linha.dataset.estado = estado;
    if (matterId && estado === 'ok') {
      const ver = document.createElement('a');
      ver.href = `/materias-ia/${matterId}`;
      ver.target = '_blank';
      ver.rel = 'noopener';
      ver.textContent = 'Ver matéria';
      alvo.linha.append(ver);
    }
  }

  async function acompanharPublicacoes() {
    clearTimeout(timerPublicacoes);
    if (!publicacoesAcompanhadas.size) return;
    try {
      const status = await apiJson(`${API}/furos/auto`);
      const porId = new Map([...(status.itens || []), ...(status.foraDaFila || [])].map((i) => [Number(i.id), i]));
      for (const [itemId, alvo] of publicacoesAcompanhadas) {
        if (!alvo.card.isConnected) {
          publicacoesAcompanhadas.delete(itemId);
          continue;
        }
        const item = porId.get(itemId);
        if (!item) continue;
        if (item.status === 'publicada') {
          mostrarEtapaNoCard(alvo, `Publicada às ${horaCurta(item.publicado_at)}`, 'ok', item.matter_id);
          alvo.card.classList.add('is-publicada');
          alvo.botao.textContent = 'Publicada';
          publicacoesAcompanhadas.delete(itemId);
        } else if (item.status === 'erro' || item.status === 'descartada') {
          mostrarEtapaNoCard(alvo, `Não publicada: ${item.erro || item.motivo || 'falhou'}`, 'erro');
          alvo.botao.disabled = false;
          alvo.botao.textContent = 'Publicar de novo';
          publicacoesAcompanhadas.delete(itemId);
        } else if (item.status === 'agendada') {
          mostrarEtapaNoCard(alvo, `Agendada para ${horaCurta(item.agendado_para)} (publica sozinha)`);
        } else {
          mostrarEtapaNoCard(alvo, ETAPA_PUBLICACAO[item.status] || 'Na fila…');
        }
      }
    } catch {
      // tenta de novo na próxima volta
    }
    if (publicacoesAcompanhadas.size) timerPublicacoes = setTimeout(acompanharPublicacoes, 10_000);
  }

  function acompanharPublicacao(itemId, card, botao) {
    if (!itemId) return;
    let linha = card.querySelector('.mia-x-card-fila');
    if (!linha) {
      linha = document.createElement('span');
      linha.className = 'mia-x-card-fila';
      (card.querySelector('.mia-x-card-txt') || card).appendChild(linha);
    }
    const alvo = { card, botao, linha };
    mostrarEtapaNoCard(alvo, ETAPA_PUBLICACAO.na_fila);
    publicacoesAcompanhadas.set(Number(itemId), alvo);
    clearTimeout(timerPublicacoes);
    timerPublicacoes = setTimeout(acompanharPublicacoes, 4_000);
  }

  async function salvarTopicosComoRascunhos(topicos) {
    const pautas = (Array.isArray(topicos) ? topicos : [])
      .filter(Boolean)
      .map((topico) => ({
        titulo: topico.titulo || '',
        url: topico.url || '',
        veiculo: topico.pagina ? `Facebook · ${topico.pagina}` : topico.veiculo || 'Web',
        resumo: topico.resumo || '',
        data: topico.data || '',
        dataTimestamp: Number(topico.dataTimestamp) || null,
        imagemUrl: topico.imagem || topico.imagemUrl || null,
        creditoImagem: topico.pagina
          ? `Reprodução/Facebook · ${topico.pagina}`
          : topico.veiculo || 'Reprodução',
      }));
    if (!pautas.length) throw new Error('Selecione ao menos uma pauta.');
    const salvas = [];
    const erros = [];
    for (let inicio = 0; inicio < pautas.length; inicio += MAX_TOPICOS_LOTE) {
      const lote = pautas.slice(inicio, inicio + MAX_TOPICOS_LOTE);
      try {
        const data = await apiJson('/api/materias-ia/chat/pautas/rascunhos', {
          method: 'POST',
          body: JSON.stringify({
            pautas: lote,
            pesquisarWeb: true,
            periodo: el.periodo?.value || '30d',
          }),
        });
        for (const item of data.salvas || []) salvas.push({ ...item, indice: inicio + Number(item.indice) });
        for (const item of data.erros || []) erros.push({ ...item, indice: inicio + Number(item.indice) });
      } catch (err) {
        lote.forEach((pauta, i) => erros.push({ indice: inicio + i + 1, titulo: pauta.titulo, error: err.message }));
      }
    }
    if (!salvas.length) throw new Error(erros[0]?.error || 'Não foi possível criar os rascunhos.');
    return {
      salvas,
      erros,
      mensagem: `${salvas.length} rascunho(s) criado(s)${erros.length ? ` · ${erros.length} falha(s)` : ''}.`,
    };
  }

  function marcarPaginaFacebook(ativa) {
    paginaFacebookAtiva = ativa;
    btnPaginaFacebook.setAttribute('aria-pressed', ativa ? 'true' : 'false');
    btnPaginaFacebook.classList.toggle('is-active', ativa);
    if (!ativa) return;
    desativarMaisLidas();
    altaAtiva = false;
    publicoAtivo = false;
    btnAlta.setAttribute('aria-pressed', 'false');
    btnAlta.classList.remove('is-active');
    btnPublico.setAttribute('aria-pressed', 'false');
    btnPublico.classList.remove('is-active');
    document.querySelectorAll('.chat-modo-btn').forEach((b) => {
      b.classList.remove('is-active');
      b.setAttribute('aria-pressed', 'false');
    });
  }

  /**
   * Aviso de carregando com esqueletos. Entra na hora do clique para o usuário
   * não olhar uma área vazia achando que nada aconteceu.
   */
  function renderCarregando(termo, paraPublico = false, paginaFacebook = false, maisLidas = false) {
    limparBlocosAlta();
    el.vazio?.classList.add('hidden');

    const wrap = novoBlocoAlta();

    const corpo = document.createElement('div');
    corpo.className = 'mia-msg-ai-body';
    const linha = document.createElement('p');
    linha.className = 'mia-x-carregando';
    linha.setAttribute('role', 'status');
    linha.setAttribute('aria-live', 'polite');
    const spin = document.createElement('span');
    spin.className = 'mia-x-spin';
    linha.appendChild(spin);
    const txt = document.createElement('span');
    txt.textContent = maisLidas
      ? 'Extraindo as listas de mais lidas dos sites cadastrados e removendo pautas repetidas...'
      : paginaFacebook
      ? 'Abrindo a página do Facebook e extraindo os posts...'
      : paraPublico
        ? 'Analisando o que viralizou e procurando pautas novas para o seu público...'
      : termo
        ? `Carregando matérias em alta sobre “${termo}”… aguarde.`
        : 'Carregando as matérias em alta agora… aguarde alguns segundos.';
    linha.appendChild(txt);
    corpo.appendChild(linha);
    wrap.appendChild(corpo);

    const box = document.createElement('div');
    box.className = 'mia-x-alta';
    const lista = document.createElement('div');
    lista.className = 'mia-x-alta-list';
    for (let i = 0; i < ESQUELETOS; i += 1) {
      const skel = document.createElement('div');
      skel.className = 'mia-x-skel';
      lista.appendChild(skel);
    }
    box.appendChild(lista);
    wrap.appendChild(box);

    mostrarBloco(wrap);
  }

  function renderErro(mensagem, termo, paraPublico = false, maisLidas = false) {
    limparBlocosAlta();
    const wrap = novoBlocoAlta();

    const box = document.createElement('div');
    box.className = 'mia-x-alta';

    const erro = document.createElement('p');
    erro.className = 'mia-x-erro';
    erro.textContent = mensagem || 'Não consegui carregar as matérias em alta.';
    box.appendChild(erro);

    const acoes = document.createElement('div');
    acoes.className = 'mia-x-busca';
    const tentar = document.createElement('button');
    tentar.type = 'button';
    tentar.textContent = 'Tentar de novo';
    tentar.addEventListener('click', () => {
      if (paraPublico) carregarParaPublico();
      else carregarAlta(termo || '');
    });
    acoes.appendChild(tentar);
    if (maisLidas) {
      const configurar = document.createElement('a');
      configurar.href = '/configuracoes/descobrir-pautas';
      configurar.className = 'mia-chat-ghost-btn';
      configurar.textContent = 'Configurar sites';
      acoes.appendChild(configurar);
    }
    box.appendChild(acoes);

    wrap.appendChild(box);
    mostrarBloco(wrap);
  }

  function renderPaginaFacebookEntrada(url = '', mensagemErro = '') {
    limparBlocosAlta();
    el.vazio?.classList.add('hidden');
    const wrap = novoBlocoAlta();
    const corpo = document.createElement('div');
    corpo.className = 'mia-msg-ai-body';
    const texto = document.createElement('p');
    texto.textContent =
      'Cole o link de uma página ou perfil público do Facebook. Vou listar os posts para você escolher quais devem virar matérias em rascunho.';
    corpo.appendChild(texto);
    wrap.appendChild(corpo);

    const box = document.createElement('div');
    box.className = 'mia-x-alta';
    const titulo = document.createElement('p');
    titulo.className = 'mia-x-alta-title';
    titulo.textContent = 'Página Facebook';
    box.appendChild(titulo);
    if (mensagemErro) {
      const erro = document.createElement('p');
      erro.className = 'mia-x-erro';
      erro.textContent = mensagemErro;
      box.appendChild(erro);
    }
    const busca = document.createElement('div');
    busca.className = 'mia-x-busca';
    const campo = document.createElement('input');
    campo.type = 'url';
    campo.placeholder = 'https://www.facebook.com/NomeDaPagina';
    campo.value = String(url || '');
    campo.setAttribute('aria-label', 'URL da página do Facebook');
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = 'Listar posts';
    const disparar = () => carregarPaginaFacebook(campo.value);
    botao.addEventListener('click', disparar);
    campo.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      disparar();
    });
    busca.appendChild(campo);
    busca.appendChild(botao);
    box.appendChild(busca);
    const ajuda = document.createElement('p');
    ajuda.className = 'mia-x-result-note';
    ajuda.textContent = 'A leitura usa primeiro a sessão gratuita configurada no servidor; nenhuma publicação é feita automaticamente.';
    box.appendChild(ajuda);
    wrap.appendChild(box);
    mostrarBloco(wrap);
    setTimeout(() => campo.focus(), 0);
  }

  function renderAlta(data) {
    const topicos = data.topicos || [];
    const temas = data.temas || [];
    const horas = data.horas || 24;
    const janela = rotuloJanelaRadar(horas);
    const paraPublico = data.origem === 'viralizadas';
    const paginaFacebook = data.origem === 'pagina-facebook';
    // "Mais lidas" foi removido; o modo fica desligado para o renderizador
  // compartilhado seguir servindo Em alta, Para meu público e Página.
  const maisLidas = false;
    const podeSalvarRascunho =
      paraPublico || paginaFacebook || maisLidas || data.origem === 'em-alta';
    const basesVirais = Array.isArray(data.basesVirais) ? data.basesVirais : [];
    const tendenciasGoogle = Array.isArray(data.tendenciasGoogle)
      ? data.tendenciasGoogle.filter((item) => item?.termo)
      : [];
    const avisosPagina = Array.isArray(data.avisos) ? data.avisos.filter(Boolean) : [];

    limparBlocosAlta();
    el.vazio?.classList.add('hidden');

    const wrap = novoBlocoAlta();

    const corpo = document.createElement('div');
    corpo.className = 'mia-msg-ai-body';
    const p = document.createElement('p');
    p.textContent = maisLidas
      ? topicos.length
        ? `${topicos.length} pauta(s) disponível(is) nos rankings dos sites cadastrados. As que já existem no sistema foram ocultadas.`
        : 'Nenhuma pauta nova nos rankings agora. As matérias encontradas já existem no sistema ou os portais ainda não atualizaram suas listas.'
      : paginaFacebook
      ? `${topicos.length} post(s) encontrados em ${data.pagina || 'Facebook'}. Selecione um ou mais para criar as matérias como rascunho.`
      : paraPublico
        ? `${topicos.length} pauta(s) nova(s) encontradas a partir do que mais engajou na sua página. Selecione uma ou mais para salvar como rascunho.`
      : topicos.length
        ? `${topicos.length} assunto(s) em alta ${janela} (${data.totalAnalisado || 0} analisados). Marque um ou mais para criar no chat ou salvar direto como rascunho.`
        : Number(data.totalOcultado) > 0
          ? `As pautas encontradas ${janela} já viraram matéria nesta conta. Busque outro tema ou atualize mais tarde para ver novidades.`
          : data.googleEmPausa
            // "Tente de novo em alguns minutos" era mentira durante a pausa: o
            // aviso logo abaixo diz a hora em que as consultas voltam.
            ? `Não consegui consultar o Google News agora.`
            : `Não achei nada em alta ${janela} nesses temas. Tente de novo em alguns minutos ou busque outro tema abaixo.`;
    corpo.appendChild(p);
    if (avisosPagina.length) {
      const aviso = document.createElement('p');
      aviso.className = 'mia-x-result-note is-warning';
      aviso.textContent = avisosPagina.slice(0, 2).join(' ');
      corpo.appendChild(aviso);
    }
    if (paraPublico && Number(data.totalOcultado) > 0) {
      const ocultadas = document.createElement('p');
      ocultadas.className = 'mia-x-result-note';
      ocultadas.textContent = `${Number(data.totalOcultado)} pauta(s) que já existem no sistema ou na Página foram ocultadas.`;
      corpo.appendChild(ocultadas);
    }
    if (maisLidas && Number(data.totalOcultado) > 0) {
      const ocultadas = document.createElement('p');
      ocultadas.className = 'mia-x-result-note';
      ocultadas.textContent = `${Number(data.totalOcultado)} pauta(s) já transformada(s) em matéria foram ocultadas para evitar repetição.`;
      corpo.appendChild(ocultadas);
    }
    if (!maisLidas && !paraPublico && !paginaFacebook && Number(data.totalOcultado) > 0) {
      const ocultadas = document.createElement('p');
      ocultadas.className = 'mia-x-result-note';
      ocultadas.textContent = `${Number(data.totalOcultado)} pauta(s) já gerada(s), agendada(s) ou publicada(s) foram ocultadas.`;
      corpo.appendChild(ocultadas);
    }
    if (maisLidas && Array.isArray(data.erros) && data.erros.length) {
      const falhas = document.createElement('p');
      falhas.className = 'mia-x-result-note is-warning';
      falhas.textContent = data.erros.slice(0, 3).map((item) => `${item.fonte}: ${item.error}`).join(' · ');
      corpo.appendChild(falhas);
    }
    if (paraPublico && topicos.length < 20) {
      const limite = document.createElement('p');
      limite.className = 'mia-x-result-note is-warning';
      limite.textContent = 'A lista ficou menor porque só entram pautas realmente novas e publicadas nos últimos 7 dias.';
      corpo.appendChild(limite);
    }
    wrap.appendChild(corpo);

    const box = document.createElement('div');
    box.className = 'mia-x-alta';

    const head = document.createElement('div');
    head.className = 'mia-x-alta-head';
    const titulo = document.createElement('p');
    titulo.className = 'mia-x-alta-title';
    titulo.textContent = maisLidas
      ? 'Mais lidas nos seus sites'
      : paginaFacebook
      ? `Posts de ${data.pagina || 'Facebook'}`
      : paraPublico
        ? 'Sugestões para o seu público'
      : data.padrao
        ? 'Em alta agora'
        : 'Em alta — sua busca';
    head.appendChild(titulo);
    const recarregar = document.createElement('button');
    recarregar.type = 'button';
    recarregar.className = 'mia-chat-ghost-btn';
    recarregar.textContent = 'Atualizar';
    recarregar.addEventListener('click', () => {
      if (paginaFacebook) carregarPaginaFacebook(data.paginaUrl);
      else if (paraPublico) carregarParaPublico();
      else carregarAlta(data.padrao ? '' : temas.join(', '));
    });
    head.appendChild(recarregar);
    box.appendChild(head);

    if (!maisLidas && !paraPublico && !paginaFacebook && tendenciasGoogle.length) {
      const trends = document.createElement('section');
      trends.className = 'mia-x-google-trends';
      const trendsTitle = document.createElement('p');
      trendsTitle.className = 'mia-x-google-trends-title';
      trendsTitle.textContent = 'Buscas crescendo no Google Brasil';
      const trendsList = document.createElement('div');
      trendsList.className = 'mia-x-google-trends-list';
      tendenciasGoogle.slice(0, 12).forEach((item) => {
        const trend = document.createElement('button');
        trend.type = 'button';
        trend.className = 'mia-x-google-trend';
        trend.textContent = item.termo;
        trend.title = `Pesquisar notícias e posts sobre ${item.termo}`;
        trend.addEventListener('click', () => carregarAlta(item.termo));
        trendsList.appendChild(trend);
      });
      trends.append(trendsTitle, trendsList);
      box.appendChild(trends);
    }

    if (paraPublico && basesVirais.length) {
      const bases = document.createElement('div');
      bases.className = 'mia-x-bases';
      const basesTitulo = document.createElement('p');
      basesTitulo.className = 'mia-x-bases-title';
      basesTitulo.textContent = `Baseado em ${basesVirais.length} matéria(s) que engajaram`;
      bases.appendChild(basesTitulo);
      basesVirais.slice(0, 4).forEach((base) => {
        const item = document.createElement('span');
        item.className = 'mia-x-base';
        item.textContent = base.titulo || 'Matéria publicada';
        const metaBase = document.createElement('span');
        metaBase.className = 'mia-x-base-meta';
        metaBase.textContent = ` · ${base.likes || 0} curtidas · ${base.comments || 0} comentários`;
        item.appendChild(metaBase);
        bases.appendChild(item);
      });
      box.appendChild(bases);
    }

    if (!maisLidas && !paraPublico && !paginaFacebook && temas.length) {
      const chips = document.createElement('div');
      chips.className = 'mia-x-temas';
      temas.forEach((t) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'mia-x-tema';
        chip.textContent = t;
        chip.title = `Aprofundar a pesquisa em ${t}`;
        chip.addEventListener('click', () => carregarAlta(t));
        chips.appendChild(chip);
      });
      box.appendChild(chips);
    }

    // Busca fica dentro do painel: não disputa o campo de mensagem do chat.
    const busca = document.createElement('div');
    busca.className = 'mia-x-busca';
    const campo = document.createElement('input');
    campo.type = 'search';
    campo.placeholder = paginaFacebook
      ? 'https://www.facebook.com/NomeDaPagina'
      : 'Buscar outro tema. Ex.: Malafaia, política evangélica';
    campo.setAttribute('aria-label', paginaFacebook ? 'URL da página do Facebook' : 'Buscar tema em alta');
    if (paginaFacebook) campo.value = data.paginaUrl || '';
    else if (!data.padrao) campo.value = temas.join(', ');
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = paginaFacebook ? 'Listar posts' : 'Buscar';
    const disparar = () =>
      paginaFacebook ? carregarPaginaFacebook(campo.value) : carregarAlta(campo.value);
    botao.addEventListener('click', disparar);
    campo.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      disparar();
    });
    busca.appendChild(campo);
    busca.appendChild(botao);
    if (!paraPublico && !maisLidas) box.appendChild(busca);

    if (topicos.length) {
      const selecionados = new Map();
      const itens = [];
      // Agendar aceita até MAX_AGENDAR; "Criar no chat" continua em
      // MAX_TOPICOS_LOTE porque escreve todas numa resposta só.
      const limiteSelecao = paginaFacebook ? topicos.length : Math.min(MAX_AGENDAR, topicos.length);
      const nomeFonte = (topico) => String(topico?.veiculo || topico?.fonteNome || 'Web').trim() || 'Web';
      const contagemPorFonte = new Map();
      const gruposFonte = new Map();
      let ordemFontes = [];
      let fonteAtiva = '*';
      const botoesFonte = [];

      if (maisLidas) {
        topicos.forEach((topico) => {
          const nome = nomeFonte(topico);
          contagemPorFonte.set(nome, (contagemPorFonte.get(nome) || 0) + 1);
        });

        const ordemConfigurada = (Array.isArray(data.fontes) ? data.fontes : [])
          .map((fonte) => String(fonte?.nome || '').trim())
          .filter((nome, indice, nomes) => nome && contagemPorFonte.has(nome) && nomes.indexOf(nome) === indice);
        const ordemRestante = [...contagemPorFonte.keys()].filter((nome) => !ordemConfigurada.includes(nome));
        ordemFontes = [...ordemConfigurada, ...ordemRestante];
        const filtros = document.createElement('div');
        filtros.className = 'mia-x-source-filter';
        filtros.setAttribute('aria-label', 'Filtrar matérias mais lidas por fonte');

        const criarFiltro = (valor, rotulo, total) => {
          const botaoFonte = document.createElement('button');
          botaoFonte.type = 'button';
          botaoFonte.dataset.fonte = valor;
          botaoFonte.setAttribute('aria-pressed', valor === '*' ? 'true' : 'false');
          const texto = document.createElement('span');
          texto.textContent = rotulo;
          const contador = document.createElement('span');
          contador.className = 'mia-x-source-filter-count';
          contador.textContent = String(total);
          botaoFonte.append(texto, contador);
          botaoFonte.addEventListener('click', () => aplicarFiltroFonte(valor));
          botoesFonte.push(botaoFonte);
          filtros.appendChild(botaoFonte);
        };

        criarFiltro('*', 'Todas as fontes', topicos.length);
        ordemFontes.forEach((nome) => criarFiltro(nome, nome, contagemPorFonte.get(nome) || 0));
        box.appendChild(filtros);
      }

      const lote = document.createElement('div');
      lote.className = 'mia-x-lote';
      const selecionar = document.createElement('button');
      selecionar.type = 'button';
      selecionar.className = 'mia-x-lote-select';
      selecionar.textContent = paginaFacebook
        ? `Selecionar todos (${topicos.length})`
        : `Selecionar até ${limiteSelecao}`;
      const salvar = document.createElement('button');
      salvar.type = 'button';
      salvar.className = 'mia-x-lote-save';
      salvar.textContent = 'Salvar rascunhos';
      salvar.disabled = true;
      const gerar = document.createElement('button');
      gerar.type = 'button';
      gerar.className = 'mia-x-lote-gerar';
      gerar.textContent = podeSalvarRascunho ? 'Criar no chat' : 'Criar selecionadas';
      gerar.disabled = true;
      lote.appendChild(selecionar);
      if (podeSalvarRascunho) lote.appendChild(salvar);
      if (!paginaFacebook) lote.appendChild(gerar);
      box.appendChild(lote);

      // Agendar: cada selecionada é escrita, ganha imagem com IA e publica
      // sozinha, uma a cada N minutos (mesma fila do Furos do dia).
      const agenda = document.createElement('div');
      agenda.className = 'mia-x-agenda';
      const rotuloAgenda = document.createElement('span');
      rotuloAgenda.textContent = 'Agendar selecionadas:';
      const intervalo = document.createElement('select');
      intervalo.className = 'mia-x-agenda-select';
      intervalo.setAttribute('aria-label', 'Intervalo entre as publicações');
      let intervaloSalvo = 10;
      try { intervaloSalvo = Number(localStorage.getItem(INTERVALO_KEY)) || 10; } catch { /* ignore */ }
      INTERVALOS_AGENDA.forEach((min) => {
        const opcao = new Option(min === 60 ? '1 por hora' : `1 a cada ${min} min`, String(min));
        opcao.selected = min === intervaloSalvo;
        intervalo.add(opcao);
      });
      intervalo.addEventListener('change', () => {
        try { localStorage.setItem(INTERVALO_KEY, intervalo.value); } catch { /* ignore */ }
      });
      const pagina = document.createElement('select');
      pagina.className = 'mia-x-agenda-select';
      pagina.setAttribute('aria-label', 'Página onde publicar');
      pagina.add(new Option('Página padrão', ''));
      carregarPaginasFacebook(pagina);
      const agendar = document.createElement('button');
      agendar.type = 'button';
      agendar.className = 'mia-x-lote-agendar';
      agendar.textContent = 'Agendar';
      agendar.disabled = true;
      agenda.append(rotuloAgenda, intervalo, pagina, agendar);
      if (podeSalvarRascunho) box.appendChild(agenda);

      const resultadoLote = document.createElement('p');
      resultadoLote.className = 'mia-x-base hidden';
      box.appendChild(resultadoLote);

      let salvando = false;

      function itensVisiveis() {
        if (!maisLidas || fonteAtiva === '*') return itens;
        return itens.filter((item) => item.fonte === fonteAtiva);
      }

      function limparSelecaoAtual() {
        selecionados.clear();
        itens.forEach((item) => {
          item.input.checked = false;
          item.card.classList.remove('is-selected');
        });
      }

      function aplicarFiltroFonte(fonte) {
        if (!maisLidas) return;
        fonteAtiva = fonte || '*';
        gruposFonte.forEach((grupo, nome) => {
          grupo.hidden = fonteAtiva !== '*' && nome !== fonteAtiva;
        });
        botoesFonte.forEach((botaoFonte) => {
          const ativo = botaoFonte.dataset.fonte === fonteAtiva;
          botaoFonte.classList.toggle('is-active', ativo);
          botaoFonte.setAttribute('aria-pressed', ativo ? 'true' : 'false');
        });
        limparSelecaoAtual();
        atualizarLote();
      }

      function atualizarLote() {
        const total = selecionados.size;
        const totalVisivel = itensVisiveis().length;
        const limiteVisivel = paginaFacebook ? totalVisivel : Math.min(MAX_TOPICOS_LOTE, totalVisivel);
        const complementoFonte = maisLidas && fonteAtiva !== '*' ? ` de ${fonteAtiva}` : '';
        agendar.disabled = total === 0 || salvando;
        agendar.textContent = salvando ? 'Agendando...' : total ? `Agendar ${total}` : 'Agendar';
        salvar.disabled = total === 0 || salvando;
        salvar.textContent = salvando
          ? 'Criando rascunhos...'
          : total
            ? `Salvar ${total} rascunho(s)`
            : 'Salvar rascunhos';
        gerar.disabled = total === 0 || salvando;
        gerar.textContent = total
          ? paraPublico
            ? `Criar ${total} no chat`
            : `Criar ${total} matéria(s)`
          : paraPublico
            ? 'Criar no chat'
            : podeSalvarRascunho
              ? 'Criar no chat'
              : 'Criar selecionadas';
        selecionar.textContent = total
          ? 'Limpar seleção'
          : paginaFacebook
            ? `Selecionar todos (${topicos.length})`
            : `Selecionar até ${limiteVisivel}${complementoFonte}`;
      }

      selecionar.addEventListener('click', () => {
        if (selecionados.size) {
          selecionados.clear();
          itens.forEach((item) => {
            item.input.checked = false;
            item.card.classList.remove('is-selected');
          });
          atualizarLote();
          return;
        }

        const visiveis = itensVisiveis();
        const limiteVisivel = paginaFacebook ? visiveis.length : Math.min(MAX_TOPICOS_LOTE, visiveis.length);
        visiveis.forEach((item, indice) => {
          const marcar = indice < limiteVisivel;
          item.input.checked = marcar;
          item.card.classList.toggle('is-selected', marcar);
          if (marcar) selecionados.set(item.key, item.topico);
        });
        if (!paginaFacebook && visiveis.length > limiteVisivel) {
          setStatus(`Selecionei os ${MAX_TOPICOS_LOTE} primeiros assuntos. Gere esse lote e depois escolha mais.`);
        }
        atualizarLote();
      });

      gerar.addEventListener('click', () => {
        const alvos = [...selecionados.values()];
        if (!alvos.length) {
          setStatus('Marque ao menos um assunto.');
          return;
        }
        if (alvos.length > MAX_TOPICOS_LOTE) {
          setStatus(`No chat cabem até ${MAX_TOPICOS_LOTE} matérias por vez. Para mais, use "Salvar rascunhos" ou "Agendar".`);
          return;
        }
        pedirMateriaDosTopicos(alvos);
      });

      agendar.addEventListener('click', async () => {
        const alvos = [...selecionados.values()];
        if (!alvos.length || salvando) return;
        const nomePagina = pagina.selectedOptions[0]?.textContent || 'página padrão';
        const minutos = Number(intervalo.value) || 10;
        if (!confirm(`Agendar ${alvos.length} matéria(s) em ${nomePagina}?\n\nCada uma é escrita, ganha imagem com IA e é publicada sozinha, uma a cada ${minutos === 60 ? 'hora' : `${minutos} min`}.`)) return;
        salvando = true;
        atualizarLote();
        setStatus(`Colocando ${alvos.length} matéria(s) na fila de publicação...`);
        try {
          const data = await apiJson(`${API}/furos/auto/fila`, {
            method: 'POST',
            body: JSON.stringify({
              pautas: alvos.map(pautaParaFila),
              intervalo_minutos: minutos,
              facebook_page_id: pagina.value || null,
              foto_original_se_falhar: true,
            }),
          });
          const entraram = (data.adicionadas || []).length;
          const recusadas = data.ignoradas || [];
          resultadoLote.classList.remove('hidden');
          resultadoLote.textContent = entraram
            ? `${entraram} matéria(s) na fila: cada uma é escrita, ganha imagem e publica uma a cada ${minutos === 60 ? 'hora' : `${minutos} min`} em ${nomePagina}. Pode fechar o navegador.${recusadas.length ? ` ${recusadas.length} não entrou(aram): ${recusadas.map((r) => r.motivo).join('; ')}.` : ''}`
            : `Nenhuma entrou na fila: ${recusadas.map((r) => r.motivo).join('; ') || 'pautas inválidas'}.`;
          const acompanhar = document.createElement('a');
          acompanhar.href = '/piloto-automatico';
          acompanhar.className = 'mia-chat-ghost-btn';
          acompanhar.textContent = 'Acompanhar';
          resultadoLote.append(' ', acompanhar);
          setStatus(entraram ? `${entraram} matéria(s) agendada(s).` : 'Nenhuma matéria entrou na fila.');
          if (entraram) {
            const adicionadas = new Map((data.adicionadas || []).map((a) => [a.url, a]));
            itens.forEach((item) => {
              const adicionada = adicionadas.get(item.topico.url);
              if (!adicionada) return;
              item.card.classList.add('is-agendada');
              const botaoCard = item.card.querySelector('.mia-x-card-publicar') || item.card.querySelector('.mia-x-card-gerar');
              if (botaoCard) {
                botaoCard.disabled = true;
                botaoCard.textContent = 'Na fila';
              }
              acompanharPublicacao(adicionada.id, item.card, botaoCard || document.createElement('button'));
            });
            limparSelecaoAtual();
          }
        } catch (err) {
          resultadoLote.classList.remove('hidden');
          resultadoLote.textContent = err.message || 'Não foi possível agendar.';
          setStatus(resultadoLote.textContent);
        } finally {
          salvando = false;
          atualizarLote();
        }
      });

      salvar.addEventListener('click', async () => {
        const alvos = [...selecionados.values()];
        if (!alvos.length || salvando) return;
        salvando = true;
        atualizarLote();
        setStatus(
          `Criando ${alvos.length} rascunho(s)${
            paginaFacebook
              ? ' dos posts selecionados'
              : maisLidas
                ? ' das matérias mais lidas'
                : ' para o seu público'
          }...`
        );
        try {
          const result = await salvarTopicosComoRascunhos(alvos);
          resultadoLote.classList.remove('hidden');
          resultadoLote.textContent = result.mensagem || `${result.salvas?.length || 0} rascunho(s) criado(s).`;
          const abrir = document.createElement('a');
          abrir.href = '/minhas-materias?status=rascunho';
          abrir.className = 'mia-chat-ghost-btn';
          abrir.textContent = 'Abrir rascunhos';
          resultadoLote.appendChild(document.createTextNode(' '));
          resultadoLote.appendChild(abrir);
          setStatus(result.mensagem || 'Rascunhos criados.');
        } catch (err) {
          resultadoLote.classList.remove('hidden');
          resultadoLote.textContent = err.message || 'Não foi possível criar os rascunhos.';
          setStatus(resultadoLote.textContent);
        } finally {
          salvando = false;
          atualizarLote();
        }
      });

      const lista = document.createElement('div');
      lista.className = 'mia-x-alta-list';

      if (maisLidas) {
        ordemFontes.forEach((nome) => {
          const grupo = document.createElement('section');
          grupo.className = 'mia-x-source-group';
          grupo.dataset.fonte = nome;
          const cabecalho = document.createElement('h3');
          cabecalho.className = 'mia-x-source-head';
          const rotulo = document.createElement('span');
          rotulo.textContent = nome;
          const contador = document.createElement('span');
          contador.className = 'mia-x-source-head-count';
          contador.textContent = `${contagemPorFonte.get(nome) || 0} pauta(s)`;
          cabecalho.append(rotulo, contador);
          const itensGrupo = document.createElement('div');
          itensGrupo.className = 'mia-x-alta-list';
          grupo.append(cabecalho, itensGrupo);
          gruposFonte.set(nome, grupo);
          grupo._itens = itensGrupo;
          lista.appendChild(grupo);
        });
      }

      topicos.forEach((t, i) => {
        const fonteDoTopico = nomeFonte(t);
        const key = t.url || `${i}:${t.titulo || ''}:${t.veiculo || ''}`;
        const card = document.createElement('article');
        card.className = 'mia-x-card';

        const checkWrap = document.createElement('label');
        checkWrap.className = 'mia-x-card-check';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.setAttribute('aria-label', `Selecionar assunto ${i + 1}`);
        checkWrap.appendChild(check);
        card.appendChild(checkWrap);

        const pos = document.createElement('span');
        pos.className = 'mia-x-card-pos';
        pos.textContent = String(maisLidas && t.posicao ? t.posicao : i + 1);
        card.appendChild(pos);

        // Sem foto ainda: o quadro fica "carregando" até buscarImagensDoRadar
        // achar a imagem da matéria (ou some, se não houver nenhuma).
        const thumb = document.createElement('img');
        thumb.className = `mia-x-card-thumb${t.imagem ? '' : ' is-carregando'}`;
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.referrerPolicy = 'no-referrer';
        if (t.imagem) thumb.src = t.imagem;
        thumb.addEventListener('error', () => thumb.classList.add('is-sem-imagem'));
        card.appendChild(thumb);

        const txt = document.createElement('span');
        txt.className = 'mia-x-card-txt';

        const tit = document.createElement('span');
        tit.className = 'mia-x-card-tit';
        tit.textContent = t.titulo;
        txt.appendChild(tit);

        const meta = document.createElement('span');
        meta.className = 'mia-x-card-meta';
        meta.textContent = [
          t.tema ? t.tema : '',
          maisLidas && t.posicao ? `#${t.posicao} nas mais lidas` : '',
          paraPublico && t.afinidadePublico ? `${t.afinidadePublico}% de afinidade` : '',
          paraPublico && t.potencialPublico ? `${t.potencialPublico}% potencial` : '',
          paginaFacebook && t.pagina ? t.pagina : '',
          t.veiculo || 'Web',
          formatarDataPauta(t),
          paginaFacebook && t.mediaType === 'video' ? 'Vídeo' : '',
          t.sinalGoogleNews ? 'Google News' : '',
          t.sinalRedes ? 'Redes sociais' : '',
          t.contagemFontes > 1 ? `${t.contagemFontes} fontes` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        if (paraPublico && t.motivoAfinidade) meta.title = t.motivoAfinidade;
        txt.appendChild(meta);

        if (t.resumo) {
          const res = document.createElement('span');
          res.className = 'mia-x-card-res';
          res.textContent = t.resumo.length > 170 ? `${t.resumo.slice(0, 170)}…` : t.resumo;
          txt.appendChild(res);
        }

        card.appendChild(txt);

        const acoes = document.createElement('span');
        acoes.className = 'mia-x-card-actions';
        if (t.url) {
          const fonte = document.createElement('a');
          fonte.href = t.url;
          fonte.target = '_blank';
          fonte.rel = 'noopener';
          fonte.className = 'mia-x-card-fonte';
          fonte.textContent = 'Fonte ↗';
          fonte.title = `Abrir matéria original em ${t.veiculo || 'nova aba'}`;
          acoes.appendChild(fonte);
        }
        const gerarUm = document.createElement('button');
        gerarUm.type = 'button';
        gerarUm.className = 'mia-x-card-gerar';
        gerarUm.textContent = podeSalvarRascunho ? 'Salvar rascunho' : 'Criar matéria';
        gerarUm.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!podeSalvarRascunho) {
            pedirMateriaDoTopico(t);
            return;
          }
          gerarUm.disabled = true;
          gerarUm.textContent = 'Salvando...';
          try {
            const result = await salvarTopicosComoRascunhos([t]);
            gerarUm.textContent = 'Rascunho salvo';
            setStatus(result.mensagem || 'Rascunho criado.');
          } catch (err) {
            gerarUm.disabled = false;
            gerarUm.textContent = 'Tentar salvar';
            setStatus(err.message || 'Não foi possível criar o rascunho.');
          }
        });
        acoes.appendChild(gerarUm);

        if (podeSalvarRascunho && t.url) {
          const publicarUm = document.createElement('button');
          publicarUm.type = 'button';
          publicarUm.className = 'mia-x-card-publicar';
          publicarUm.textContent = 'Publicar';
          publicarUm.title = 'Escreve, gera a imagem com IA e publica na página escolhida acima, sozinha no servidor';
          publicarUm.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const nomePagina = pagina.selectedOptions[0]?.textContent || 'página padrão';
            const minutos = Number(intervalo.value) || 10;
            if (!confirm(`Publicar em ${nomePagina}?\n\n“${t.titulo}”\n\nA matéria é escrita, ganha imagem com IA e publica sozinha assim que ficar pronta (leva alguns minutos). Se já houver outras na fila, sai ${minutos === 60 ? '1 hora' : `${minutos} min`} depois da anterior.`)) return;
            publicarUm.disabled = true;
            publicarUm.textContent = 'Enviando…';
            try {
              const data = await apiJson(`${API}/furos/auto/fila`, {
                method: 'POST',
                body: JSON.stringify({
                  pautas: [pautaParaFila(t)],
                  intervalo_minutos: minutos,
                  facebook_page_id: pagina.value || null,
                  foto_original_se_falhar: true,
                }),
              });
              const adicionada = (data.adicionadas || [])[0];
              if (!adicionada) throw new Error(`Não entrou na fila: ${(data.ignoradas || [])[0]?.motivo || 'pauta inválida'}`);
              publicarUm.textContent = 'Na fila';
              card.classList.add('is-agendada');
              acompanharPublicacao(adicionada.id, card, publicarUm);
              setStatus(`Publicando em ${nomePagina}: acompanhe no card ou em Piloto automático.`);
            } catch (err) {
              publicarUm.disabled = false;
              publicarUm.textContent = 'Publicar';
              setStatus(err.message || 'Não foi possível publicar.');
            }
          });
          acoes.appendChild(publicarUm);
        }
        card.appendChild(acoes);

        checkWrap.addEventListener('click', (ev) => ev.stopPropagation());
        check.addEventListener('change', () => {
          if (check.checked && !selecionados.has(key) && selecionados.size >= limiteSelecao) {
            check.checked = false;
            setStatus(`Selecione no máximo ${limiteSelecao} assuntos por vez.`);
            return;
          }
          if (check.checked) selecionados.set(key, t);
          else selecionados.delete(key);
          card.classList.toggle('is-selected', check.checked);
          atualizarLote();
        });
        card.addEventListener('click', (ev) => {
          if (ev.target.closest('button,a,input,label')) return;
          check.checked = !check.checked;
          check.dispatchEvent(new Event('change', { bubbles: true }));
        });

        itens.push({ input: check, card, key, topico: t, fonte: fonteDoTopico, thumb });
        const grupo = maisLidas ? gruposFonte.get(fonteDoTopico) : null;
        (grupo?._itens || lista).appendChild(card);
      });

      if (maisLidas) aplicarFiltroFonte('*');
      else atualizarLote();
      box.appendChild(lista);
      buscarImagensDoRadar(itens);
    }

    wrap.appendChild(box);
    mostrarBloco(wrap);
  }


  async function carregarAlta(busca = '') {
    if (carregandoAlta) return;
    carregandoAlta = true;
    btnAlta.disabled = true;

    const horasPorPeriodo = {
      '24h': 24,
      '3d': 72,
      '7d': 168,
    };
    // Para “Em alta”, períodos editoriais longos são limitados a 7 dias:
    // mantém novidade sem zerar a pesquisa quando 30/60/90 dias estiver selecionado.
    const horas = horasPorPeriodo[el.periodo?.value] || 168;
    const termo = String(busca || '').replace(/\s+/g, ' ').trim();

    setStatus(
      termo ? `Carregando matérias em alta sobre “${termo}”…` : 'Carregando matérias em alta…'
    );
    renderCarregando(termo);

    try {
      const data = await apiJson(`${API}/em-alta`, {
        method: 'POST',
        body: JSON.stringify({ busca: termo, horas }),
      });
      renderAlta(data);
      setStatus(`${(data.topicos || []).length} assunto(s) em alta`);
    } catch (err) {
      const mensagem = err.message || 'Falha ao buscar o radar';
      setStatus(mensagem);
      renderErro(mensagem, termo);
    } finally {
      carregandoAlta = false;
      btnAlta.disabled = false;
    }
  }

  btnAlta.addEventListener('click', () => {
    fecharFerramentas();
    marcarAlta(true);
    carregarAlta('');
  });

  ligarAtalhoRadar(atalhosRadar.alta, () => btnAlta.click());
  ligarAtalhoRadar(atalhosRadar.publico, () => btnPublico.click());

  async function carregarParaPublico() {
    if (carregandoPublico) return;
    carregandoPublico = true;
    btnPublico.disabled = true;
    setStatus('Analisando as matérias que viralizaram na sua página...');
    renderCarregando('', true);

    try {
      const data = await apiJson(`${API}/para-meu-publico`, {
        method: 'POST',
        body: JSON.stringify({ limit: 30 }),
      });
      renderAlta(data);
      setStatus(`${(data.topicos || []).length} pauta(s) sugerida(s) para o seu público`);
    } catch (err) {
      const mensagem = err.message || 'Falha ao sugerir pautas para o seu público';
      setStatus(mensagem);
      renderErro(mensagem, '', true);
    } finally {
      carregandoPublico = false;
      btnPublico.disabled = false;
    }
  }

  btnPublico.addEventListener('click', () => {
    fecharFerramentas();
    marcarPublico(true);
    carregarParaPublico();
  });

  async function carregarPaginaFacebook(url) {
    if (carregandoPaginaFacebook) return;
    const paginaUrl = String(url || '').trim();
    if (!/^https?:\/\/(?:[^/]+\.)?(?:facebook\.com|fb\.com)\//i.test(paginaUrl)) {
      setStatus('Cole uma URL válida de página do Facebook.');
      renderPaginaFacebookEntrada(paginaUrl, 'O link precisa ser de uma página ou perfil do Facebook.');
      return;
    }
    carregandoPaginaFacebook = true;
    btnPaginaFacebook.disabled = true;
    setStatus('Extraindo posts da página do Facebook...');
    renderCarregando(paginaUrl, false, true);
    try {
      const data = await apiJson(`${API}/pagina-facebook/posts`, {
        method: 'POST',
        body: JSON.stringify({ url: paginaUrl, limit: 40 }),
      });
      renderAlta(data);
      setStatus(`${(data.topicos || []).length} post(s) encontrados em ${data.pagina || 'Facebook'}`);
    } catch (err) {
      const mensagem = err.message || 'Não consegui extrair os posts dessa página.';
      setStatus(mensagem);
      renderPaginaFacebookEntrada(paginaUrl, mensagem);
    } finally {
      carregandoPaginaFacebook = false;
      btnPaginaFacebook.disabled = false;
    }
  }

  btnPaginaFacebook.addEventListener('click', () => {
    fecharFerramentas();
    marcarPaginaFacebook(true);
    renderPaginaFacebookEntrada();
  });

  /* ---------------------------- anexo em PDF ---------------------------- */

  const inputArquivo = document.createElement('input');
  inputArquivo.type = 'file';
  inputArquivo.accept = 'application/pdf,.pdf';
  inputArquivo.hidden = true;
  document.body.appendChild(inputArquivo);

  const btnAnexo = document.createElement('button');
  btnAnexo.type = 'button';
  btnAnexo.className = 'mia-chat-chip mia-x-anexo-btn';
  btnAnexo.title = 'Anexar um PDF para a IA escrever a matéria com base nele';
  btnAnexo.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> PDF';
  alvoAnexos.appendChild(btnAnexo);

  const inputImagem = document.createElement('input');
  inputImagem.type = 'file';
  inputImagem.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
  inputImagem.hidden = true;
  document.body.appendChild(inputImagem);

  const btnImagem = document.createElement('button');
  btnImagem.type = 'button';
  btnImagem.className = 'mia-chat-chip mia-x-imagem-btn';
  btnImagem.title = 'Enviar uma imagem ou print; a IA lê o texto e cria a matéria';
  btnImagem.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg> Imagem';
  alvoAnexos.appendChild(btnImagem);

  // O chip fica logo abaixo do campo de texto, fora da barra de ferramentas.
  const chipWrap = document.createElement('div');
  if (el.composer) el.composer.insertBefore(chipWrap, el.input.nextSibling);
  else el.tools.parentElement?.appendChild(chipWrap);

  function renderChip() {
    chipWrap.replaceChildren();

    const criarChip = (dados, tipo) => {
      if (!dados) return;
      const chip = document.createElement('span');
      chip.className = 'mia-x-chip';

      const nome = document.createElement('span');
      nome.className = 'mia-x-chip-nome';
      nome.textContent = dados.nome;
      chip.appendChild(nome);

      const meta = document.createElement('span');
      meta.className = 'mia-x-chip-meta';
      meta.textContent = (tipo === 'imagem'
        ? [
            dados.palavras ? `${dados.palavras} palavras` : '',
            Number.isFinite(Number(dados.confianca)) ? `OCR ${dados.confianca}%` : '',
          ]
        : [dados.paginas ? `${dados.paginas} pág.` : '', dados.truncado ? 'texto cortado' : '']
      )
        .filter(Boolean)
        .join(' · ');
      chip.appendChild(meta);

      const fechar = document.createElement('button');
      fechar.type = 'button';
      fechar.className = 'mia-x-chip-x';
      fechar.setAttribute('aria-label', `Remover ${dados.nome}`);
      fechar.textContent = '×';
      fechar.addEventListener('click', () => {
        if (tipo === 'imagem') anexoImagem = null;
        else anexo = null;
        renderChip();
        setStatus(`${tipo === 'imagem' ? 'Imagem' : 'PDF'} removido.`);
      });
      chip.appendChild(fechar);
      chipWrap.appendChild(chip);
    };

    criarChip(anexo, 'pdf');
    criarChip(anexoImagem, 'imagem');
  }

  btnAnexo.addEventListener('click', () => inputArquivo.click());
  btnImagem.addEventListener('click', () => inputImagem.click());

  inputArquivo.addEventListener('change', async () => {
    const arquivo = inputArquivo.files?.[0];
    inputArquivo.value = '';
    if (!arquivo) return;

    btnAnexo.disabled = true;
    setStatus(`Lendo ${arquivo.name}…`);
    try {
      const dados = new FormData();
      dados.append('arquivo', arquivo);
      const res = await fetch(`${API}/anexos`, { method: 'POST', body: dados });
      const bruto = await res.text();
      let data = null;
      try {
        data = bruto ? JSON.parse(bruto) : null;
      } catch {
        data = null;
      }
      if (!res.ok) throw new Error(data?.error || `Falha ao enviar o PDF (${res.status})`);

      anexo = data.anexo;
      renderChip();
      setStatus(
        `PDF pronto: ${anexo.nome}. Escreva o que quer e envie — a matéria sai com base nele.`
      );
      el.input.focus();
    } catch (err) {
      anexo = null;
      renderChip();
      setStatus(err.message || 'Falha ao ler o PDF');
    } finally {
      btnAnexo.disabled = false;
    }
  });

  inputImagem.addEventListener('change', async () => {
    const arquivo = inputImagem.files?.[0];
    inputImagem.value = '';
    if (!arquivo) return;

    btnImagem.disabled = true;
    setStatus(`Procurando texto em ${arquivo.name}…`);
    try {
      const dados = new FormData();
      dados.append('imagem', arquivo);
      const res = await fetch(`${API}/anexos-imagem`, { method: 'POST', body: dados });
      const bruto = await res.text();
      let data = null;
      try {
        data = bruto ? JSON.parse(bruto) : null;
      } catch {
        data = null;
      }
      if (!res.ok) throw new Error(data?.error || `Falha ao analisar a imagem (${res.status})`);

      anexoImagem = data.anexo;
      renderChip();
      setStatus(
        `Texto encontrado em ${anexoImagem.nome}: ${anexoImagem.palavras} palavra(s). Escreva o que quer e envie.`
      );
      el.input.focus();
    } catch (err) {
      anexoImagem = null;
      renderChip();
      setStatus(err.message || 'Não consegui ler o texto da imagem');
    } finally {
      btnImagem.disabled = false;
    }
  });

  /**
   * Injeta o conteúdo do PDF no pedido pouco antes do chat enviar.
   * Roda na fase de captura, então acontece antes do handler do materia-chat.js.
   */
  function injetarAnexoNoPedido() {
    if ((!anexo && !anexoImagem) || el.enviar.disabled) return;
    const base =
      String(el.input.value || '').replace(/\s+$/g, '').trim() ||
      (anexoImagem
        ? `Faça uma matéria com base no texto desta imagem: ${anexoImagem.nome}`
        : `Faça uma matéria com base no PDF ${anexo.nome}`);
    const partes = [base];
    if (anexo) {
      partes.push(
        '',
        `--- Conteúdo do PDF anexado (${anexo.nome}) ---`,
        String(anexo.texto || '').slice(0, MAX_PDF_NO_PEDIDO),
        '--- fim do PDF ---'
      );
    }
    if (anexoImagem) {
      partes.push(
        '',
        `--- Texto detectado por OCR na imagem (${anexoImagem.nome}) ---`,
        String(anexoImagem.texto || '').slice(0, MAX_PDF_NO_PEDIDO),
        '--- fim do texto da imagem ---'
      );
    }
    partes.push(
      '',
      'Use o conteúdo anexado como pista factual. Pesquise na web para confirmar nomes, datas e contexto antes de escrever. Não invente dados e não copie o texto literalmente.'
    );
    el.input.value = partes.join('\n');
    anexo = null;
    anexoImagem = null;
    renderChip();
  }

  el.enviar.addEventListener('click', injetarAnexoNoPedido, true);
  el.input.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) injetarAnexoNoPedido();
    },
    true
  );
})();
