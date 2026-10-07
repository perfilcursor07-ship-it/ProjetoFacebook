(function initMatterEdit() {
  const cfg = window.__MATTER_EDIT__;
  if (!cfg?.id) return;

  const statusEl = document.getElementById('matter-status');
  const tituloEl = document.getElementById('matter-titulo');
  const materiaEl = document.getElementById('matter-materia');
  const fonteCreditoEl = document.getElementById('matter-fonte-credito');
  const tipoEl = document.getElementById('matter-tipo');
  const imgEl = document.getElementById('matter-img');
  const imgWrap = document.getElementById('matter-img-wrap');
  const btnBaixarArte = document.getElementById('btn-baixar-arte');
  const btnCopiarLegenda = document.getElementById('btn-copiar-legenda');

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className =
      'mb-2 text-sm ' +
      (msg ? '' : 'hidden ') +
      (isError ? 'text-rose-300' : 'text-slate-400');
  }

  function syncDownloadArtLink(url) {
    if (!btnBaixarArte) return;
    if (!url) {
      btnBaixarArte.classList.add('hidden');
      btnBaixarArte.removeAttribute('href');
      return;
    }
    btnBaixarArte.href = url;
    btnBaixarArte.setAttribute('download', 'arte-materia-' + cfg.id + '.jpg');
    btnBaixarArte.classList.remove('hidden');
  }

  function setArtImage(url, opts = {}) {
    if (!imgEl || !url) return;
    const withCache = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    imgEl.src = withCache;
    if (imgWrap) imgWrap.classList.remove('hidden');
    syncDownloadArtLink(withCache);
    if (opts.imagemFonteUrl) setFontePreviewUrl(opts.imagemFonteUrl);
    else if (opts.matter?.imagem_fonte_url) setFontePreviewUrl(opts.matter.imagem_fonte_url);
    else if (opts.imagemFonte) setFontePreviewUrl(opts.imagemFonte);
    // Após regenerar no servidor, volta a mostrar a arte com marca (sem zoom na marca).
    if (opts.resetFrame !== false) {
      if (artZoom) artZoom.value = '100';
      if (artOffsetX) artOffsetX.value = '50';
      if (artOffsetY) artOffsetY.value = '50';
      showBrandedArtPreview();
      if (artZoomValor) artZoomValor.textContent = '100%';
      if (artOffsetXValor) artOffsetXValor.textContent = '50%';
      if (artOffsetYValor) artOffsetYValor.textContent = '50%';
    }
  }

  /* —— Enquadramento: zoom só na FOTO de origem; marca entra ao aplicar —— */
  const artZoom = document.getElementById('art-zoom');
  const artOffsetX = document.getElementById('art-offset-x');
  const artOffsetY = document.getElementById('art-offset-y');
  const artZoomValor = document.getElementById('art-zoom-valor');
  const artOffsetXValor = document.getElementById('art-offset-x-valor');
  const artOffsetYValor = document.getElementById('art-offset-y-valor');
  const btnArtEnquadrar = document.getElementById('btn-art-enquadrar');
  const btnAbrirRecorte = document.getElementById('btn-abrir-recorte');
  const artFramePreview = document.getElementById('matter-img-frame-preview');

  function getFonteBackgroundEl() {
    let el = document.getElementById('matter-img-fonte-bg');
    if (!el && artFramePreview && cfg.imagemFonteUrl) {
      el = document.createElement('img');
      el.id = 'matter-img-fonte-bg';
      el.alt = '';
      el.setAttribute('aria-hidden', 'true');
      el.className =
        'pointer-events-none absolute inset-0 z-0 hidden h-full w-full object-cover';
      el.style.filter = 'blur(24px)';
      el.style.opacity = '.4';
      el.style.transform = 'scale(1.1)';
      artFramePreview.prepend(el);
    }
    return el;
  }

  function getFontePreviewEl() {
    let el = document.getElementById('matter-img-fonte');
    if (!el && artFramePreview && cfg.imagemFonteUrl) {
      el = document.createElement('img');
      el.id = 'matter-img-fonte';
      el.alt = 'Foto de origem';
      el.className =
        'pointer-events-none absolute inset-0 z-10 hidden h-full w-full object-cover';
      artFramePreview.appendChild(el);
    }
    return el;
  }

  function setFontePreviewUrl(url) {
    if (!url) return;
    cfg.imagemFonteUrl = url;
    btnAbrirRecorte?.classList.remove('hidden');
    const el = getFontePreviewEl();
    if (el) {
      el.src = url + (String(url).includes('?') ? '&' : '?') + 't=' + Date.now();
    }
    const bgEl = getFonteBackgroundEl();
    if (bgEl) bgEl.src = url + (String(url).includes('?') ? '&' : '?') + 't=' + Date.now();
  }
  function readArtFrame() {
    return {
      zoom: Math.min(160, Math.max(80, Number(artZoom?.value ?? 100) || 100)),
      offsetX: Math.min(100, Math.max(0, Number(artOffsetX?.value ?? 50) || 50)),
      offsetY: Math.min(100, Math.max(0, Number(artOffsetY?.value ?? 50) || 50)),
    };
  }

  function clearMediaPreviewStyles(el) {
    if (!el) return;
    el.style.objectFit = '';
    el.style.objectPosition = '';
    el.style.transform = '';
    el.style.transformOrigin = '';
    el.style.width = '';
    el.style.height = '';
    el.style.position = '';
    el.style.left = '';
    el.style.top = '';
    el.style.maxWidth = '';
    el.style.inset = '';
  }

  function applyMediaPreviewStyles(el, zoom, offsetX, offsetY) {
    if (!el) return;
    const z = zoom / 100;
    // Abaixo de 100%, replica a arte final: a foto inteira cabe no canvas 4:5.
    // Em 100% ou mais, cover permite aproximar e reposicionar normalmente.
    el.style.objectFit = z < 1 ? 'contain' : 'cover';
    el.style.objectPosition = offsetX + '% ' + offsetY + '%';
    el.style.position = 'absolute';
    el.style.maxWidth = 'none';
    el.style.inset = 'auto';
    if (z >= 1) {
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.left = '0';
      el.style.top = '0';
      el.style.transform = z > 1.001 ? 'scale(' + z + ')' : 'none';
      el.style.transformOrigin = offsetX + '% ' + offsetY + '%';
    } else {
      const w = z * 100;
      const h = z * 100;
      el.style.width = w + '%';
      el.style.height = h + '%';
      el.style.left = ((100 - w) * offsetX) / 100 + '%';
      el.style.top = ((100 - h) * offsetY) / 100 + '%';
      el.style.transform = 'none';
    }
  }

  function getMarcaOverlayEl() {
    return document.getElementById('matter-img-marca');
  }

  let marcaOverlayLoading = null;
  let marcaOverlayTitle = '';

  function marcaOverlayUrl(titulo) {
    const q = new URLSearchParams({
      titulo: String(titulo || tituloEl?.value || '').trim(),
      t: String(Date.now()),
    });
    return '/api/materias-ia/matters/' + cfg.id + '/arte/marca-overlay?' + q.toString();
  }

  async function ensureMarcaOverlay() {
    const el = getMarcaOverlayEl();
    if (!el) return null;
    const titulo = String(tituloEl?.value || '').trim();
    if (el.dataset.ready === '1' && marcaOverlayTitle === titulo && el.getAttribute('src')) {
      return el;
    }
    if (marcaOverlayLoading) return marcaOverlayLoading;
    marcaOverlayTitle = titulo;
    marcaOverlayLoading = new Promise((resolve) => {
      const url = marcaOverlayUrl(titulo);
      const onDone = () => {
        el.dataset.ready = '1';
        marcaOverlayLoading = null;
        resolve(el);
      };
      el.onload = onDone;
      el.onerror = () => {
        el.dataset.ready = '';
        marcaOverlayLoading = null;
        resolve(null);
      };
      el.src = url;
    });
    return marcaOverlayLoading;
  }

  function showBrandedArtPreview() {
    const imgFonteEl = getFontePreviewEl();
    const imgFonteBgEl = getFonteBackgroundEl();
    const imgMarcaEl = getMarcaOverlayEl();
    clearMediaPreviewStyles(imgEl);
    clearMediaPreviewStyles(imgFonteEl);
    if (imgEl) {
      imgEl.classList.remove('hidden');
      imgEl.style.position = 'relative';
      imgEl.style.zIndex = '10';
      imgEl.style.width = '100%';
      imgEl.style.height = 'auto';
      imgEl.style.objectFit = 'cover';
    }
    if (imgFonteEl) imgFonteEl.classList.add('hidden');
    if (imgFonteBgEl) imgFonteBgEl.classList.add('hidden');
    if (imgMarcaEl) imgMarcaEl.classList.add('hidden');
    if (artFramePreview) artFramePreview.style.aspectRatio = '';
  }

  async function applyArtFramePreview() {
    const { zoom, offsetX, offsetY } = readArtFrame();
    if (artZoomValor) artZoomValor.textContent = zoom + '%';
    if (artOffsetXValor) artOffsetXValor.textContent = offsetX + '%';
    if (artOffsetYValor) artOffsetYValor.textContent = offsetY + '%';

    const fonteUrl = String(cfg.imagemFonteUrl || '').trim();
    const framingActive = zoom !== 100 || offsetX !== 50 || offsetY !== 50;
    const imgFonteEl = getFontePreviewEl();
    const imgFonteBgEl = getFonteBackgroundEl();
    const imgMarcaEl = getMarcaOverlayEl();

    if (!framingActive) {
      showBrandedArtPreview();
      return;
    }

    if (!fonteUrl || !imgFonteEl) {
      setStatus('Foto de origem indisponível para enquadrar.', true);
      showBrandedArtPreview();
      return;
    }

    // Prévia em camadas: foto com zoom embaixo + Minha marca fixa em cima.
    if (artFramePreview) artFramePreview.style.aspectRatio = '4 / 5';
    if (imgEl) imgEl.classList.add('hidden');
    imgFonteEl.classList.remove('hidden');
    const bare = fonteUrl.split('?')[0];
    if (!String(imgFonteEl.src || '').includes(bare)) {
      imgFonteEl.src = fonteUrl;
    }
    applyMediaPreviewStyles(imgFonteEl, zoom, offsetX, offsetY);
    if (imgFonteBgEl) {
      imgFonteBgEl.classList.toggle('hidden', zoom >= 100);
    }

    const marca = await ensureMarcaOverlay();
    if (marca) {
      clearMediaPreviewStyles(marca);
      marca.classList.remove('hidden');
      marca.style.position = 'absolute';
      marca.style.inset = '0';
      marca.style.width = '100%';
      marca.style.height = '100%';
      marca.style.objectFit = 'fill';
      marca.style.zIndex = '20';
      marca.style.transform = 'none';
    } else if (imgMarcaEl) {
      imgMarcaEl.classList.add('hidden');
    }
  }

  [artZoom, artOffsetX, artOffsetY].forEach((el) => {
    el?.addEventListener('input', () => {
      applyArtFramePreview();
    });
  });

  btnArtEnquadrar?.addEventListener('click', async () => {
    const frame = readArtFrame();
    if (!cfg.imagemFonteUrl) {
      setStatus('Não há foto de origem. Escolha outra imagem antes de enquadrar.', true);
      return;
    }
    const original = btnArtEnquadrar.textContent;
    btnArtEnquadrar.disabled = true;
    btnArtEnquadrar.textContent = 'Aplicando…';
    setStatus('Enquadrando só a foto e reaplicando Minha marca…');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/arte/enquadrar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zoom: frame.zoom,
          offsetX: frame.offsetX,
          offsetY: frame.offsetY,
          titulo: tituloEl?.value || '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao enquadrar a arte');
      if (data.imagemUrl) {
        setArtImage(data.imagemUrl, {
          imagemFonteUrl: data.imagemFonteUrl || cfg.imagemFonteUrl,
        });
        imgWrap?.classList.remove('hidden');
      }
      setStatus('Foto enquadrada — marca reaplicada por cima ✓');
    } catch (err) {
      setStatus(err.message || 'Erro ao enquadrar', true);
    } finally {
      btnArtEnquadrar.disabled = false;
      btnArtEnquadrar.textContent = original || 'Aplicar enquadramento';
    }
  });

  /* —— Recorte livre da foto de origem —— */
  const cropModal = document.getElementById('matter-crop-modal');
  const cropClose = document.getElementById('matter-crop-close');
  const cropCancel = document.getElementById('matter-crop-cancel');
  const cropSave = document.getElementById('matter-crop-save');
  const cropStage = document.getElementById('matter-crop-stage');
  const cropImage = document.getElementById('matter-crop-image');
  const cropSelection = document.getElementById('matter-crop-selection');
  const cropWidth = document.getElementById('matter-crop-width');
  const cropHeight = document.getElementById('matter-crop-height');
  const cropX = document.getElementById('matter-crop-x');
  const cropY = document.getElementById('matter-crop-y');
  const cropWidthValue = document.getElementById('matter-crop-width-value');
  const cropHeightValue = document.getElementById('matter-crop-height-value');
  const cropXValue = document.getElementById('matter-crop-x-value');
  const cropYValue = document.getElementById('matter-crop-y-value');
  const chatgptImagePrompt = document.getElementById('matter-chatgpt-image-prompt');
  const chatgptImageGenerate = document.getElementById('matter-chatgpt-image-generate');
  const chatgptImageSymbolic = document.getElementById('matter-chatgpt-image-symbolic');
  const chatgptImageRecover = document.getElementById('matter-chatgpt-image-recover');
  const chatgptImageStatus = document.getElementById('matter-chatgpt-image-status');
  const chatgptImageJobs = document.getElementById('matter-chatgpt-image-jobs');
  let cropInteraction = null;
  let cropBox = { left: 0.05, top: 0.05, width: 0.9, height: 0.9 };
  let cropSourceUrl = '';
  let bodyOverflowBeforeCrop = '';
  // Gerador escolhido em /claude (ChatGPT, Grok ou Google Gemini).
  let geradorImagemNome = 'ChatGPT';
  function carregarGeradorImagem() {
    fetch('/api/materias-ia/arte/gerador-imagem', { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.nome) return;
        geradorImagemNome = data.nome;
        const titulo = document.getElementById('matter-image-generator-title');
        const descricao = document.getElementById('matter-image-generator-desc');
        if (titulo) titulo.textContent = 'Criar nova versão com ' + data.nome;
        if (descricao) descricao.textContent = descricao.textContent.replace(/ChatGPT|Grok|Google Gemini/g, data.nome);
      })
      .catch(() => {});
  }
  let chatgptImageJobSeq = 0;
  let chatgptImageActiveJobs = 0;
  let chatgptImageLastAppliedSeq = 0;

  function clampCropValue(value, min = 0, max = 100) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function cropGeometry() {
    if (!cropImage?.complete || !cropImage.naturalWidth || !cropImage.clientWidth) return null;
    const imageWidth = cropImage.clientWidth;
    const imageHeight = cropImage.clientHeight;
    const width = Math.max(1, Math.min(imageWidth, cropBox.width * imageWidth));
    const height = Math.max(1, Math.min(imageHeight, cropBox.height * imageHeight));
    const left = Math.max(0, Math.min(imageWidth - width, cropBox.left * imageWidth));
    const top = Math.max(0, Math.min(imageHeight - height, cropBox.top * imageHeight));
    const xPct = imageWidth > width ? (left / (imageWidth - width)) * 100 : 50;
    const yPct = imageHeight > height ? (top / (imageHeight - height)) * 100 : 50;
    return { imageWidth, imageHeight, width, height, left, top, xPct, yPct };
  }

  function setCropBoxPixels(left, top, width, height, baseGeometry = null) {
    const geometry = baseGeometry || cropGeometry();
    if (!geometry) return null;
    const minWidth = Math.min(1, geometry.imageWidth);
    const minHeight = Math.min(1, geometry.imageHeight);
    const safeWidth = Math.max(minWidth, Math.min(geometry.imageWidth, width));
    const safeHeight = Math.max(minHeight, Math.min(geometry.imageHeight, height));
    const safeLeft = Math.max(0, Math.min(geometry.imageWidth - safeWidth, left));
    const safeTop = Math.max(0, Math.min(geometry.imageHeight - safeHeight, top));
    cropBox = {
      left: safeLeft / geometry.imageWidth,
      top: safeTop / geometry.imageHeight,
      width: safeWidth / geometry.imageWidth,
      height: safeHeight / geometry.imageHeight,
    };
    return updateCropSelection();
  }

  function updateCropSelection() {
    const geometry = cropGeometry();
    if (!geometry || !cropSelection) return null;
    cropSelection.style.left = geometry.left + 'px';
    cropSelection.style.top = geometry.top + 'px';
    cropSelection.style.width = geometry.width + 'px';
    cropSelection.style.height = geometry.height + 'px';
    if (cropWidth) cropWidth.value = String(Math.round((geometry.width / geometry.imageWidth) * 100));
    if (cropHeight) cropHeight.value = String(Math.round((geometry.height / geometry.imageHeight) * 100));
    if (cropX) cropX.value = String(Math.round(geometry.xPct));
    if (cropY) cropY.value = String(Math.round(geometry.yPct));
    if (cropWidthValue) cropWidthValue.textContent = Math.round((geometry.width / geometry.imageWidth) * 100) + '%';
    if (cropHeightValue) cropHeightValue.textContent = Math.round((geometry.height / geometry.imageHeight) * 100) + '%';
    if (cropXValue) cropXValue.textContent = Math.round(geometry.xPct) + '%';
    if (cropYValue) cropYValue.textContent = Math.round(geometry.yPct) + '%';
    return geometry;
  }

  function closeCropModal() {
    if (chatgptImageActiveJobs > 0) {
      setChatgptStatus(
        'Aguarde a geração terminar antes de fechar esta janela.',
        'running'
      );
      return false;
    }
    cropInteraction = null;
    cropModal?.classList.add('hidden');
    document.body.style.overflow = bodyOverflowBeforeCrop;
    return true;
  }

  function openCropModal() {
    const sourceUrl = String(cfg.imagemFonteUrl || '').trim();
    if (!sourceUrl || !cropModal || !cropImage) {
      setStatus('A foto original não está disponível para recortar.', true);
      return;
    }
    cropBox = { left: 0.05, top: 0.05, width: 0.9, height: 0.9 };
    cropSourceUrl = sourceUrl;
    carregarGeradorImagem();
    if (chatgptImagePrompt && !chatgptImagePrompt.value.trim()) {
      chatgptImagePrompt.value = [
        'Crie uma NOVA imagem editorial fotorrealista inspirada na imagem de referência enviada.',
        'Mantenha o assunto, as pessoas e a atmosfera reconhecíveis, mas reconstrua a cena de forma original e natural.',
        'Não inclua texto, letras, legendas, placas legíveis, logotipos, marcas d’água, molduras ou elementos gráficos.',
        'Composição vertical exata 4:5 (1080 × 1350 pixels), em alta qualidade, adequada como imagem destacada de uma notícia no feed do Facebook. Não gere imagem quadrada ou horizontal.',
        'Contexto da matéria: ' + String(tituloEl?.value || '').trim(),
      ].join('\n\n');
    }
    bodyOverflowBeforeCrop = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cropModal.classList.remove('hidden');
    cropImage.onload = () => requestAnimationFrame(updateCropSelection);
    cropImage.onerror = () => setStatus('Não foi possível abrir a foto original para recorte.', true);
    cropImage.src = sourceUrl.startsWith('/media/')
      ? sourceUrl + (sourceUrl.includes('?') ? '&' : '?') + 'crop=' + Date.now()
      : sourceUrl;
    requestAnimationFrame(updateCropSelection);
  }

  function showChatgptImage(data, recovered = false) {
    cropSourceUrl = String(data?.imagemFonteUrl || '').trim();
    if (!cropSourceUrl) throw new Error(`O ${geradorImagemNome} respondeu sem uma imagem utilizável.`);
    cropBox = { left: 0, top: 0, width: 1, height: 1 };
    cropImage.onload = () => requestAnimationFrame(updateCropSelection);
    cropImage.src = cropSourceUrl + '?chatgpt=' + Date.now();
    if (chatgptImageStatus) {
      chatgptImageStatus.className = 'min-w-0 flex-1 text-[10px] text-emerald-300';
      chatgptImageStatus.textContent = recovered
        ? 'Imagem recuperada da conversa. Ajuste o recorte e clique em “Recortar e salvar”.'
        : 'Nova imagem pronta. Ajuste o recorte abaixo e clique em “Recortar e salvar”.';
    }
  }

  function setChatgptStatus(text, tone = 'muted') {
    if (!chatgptImageStatus) return;
    const tones = {
      muted: 'text-slate-500',
      running: 'text-emerald-200',
      ok: 'text-emerald-300',
      info: 'text-sky-200',
      error: 'text-rose-300',
    };
    chatgptImageStatus.className = 'min-w-0 flex-1 text-[10px] ' + (tones[tone] || tones.muted);
    chatgptImageStatus.textContent = text;
  }

  function updateChatgptGenerateLabel() {
    const gerando = chatgptImageActiveJobs > 0;
    if (chatgptImageGenerate) {
      chatgptImageGenerate.disabled = false;
      chatgptImageGenerate.textContent = gerando
        ? 'Gerar outra versão'
        : 'Gerar imagem sem texto';
    }
    [cropClose, cropCancel].forEach((button) => {
      if (!button) return;
      button.disabled = gerando;
      button.title = gerando ? 'Aguarde a geração da imagem terminar' : '';
    });
  }

  function createChatgptJobRow(jobId, prompt) {
    if (!chatgptImageJobs) return null;
    const row = document.createElement('div');
    row.className = 'rounded-lg border border-slate-700 bg-slate-950/60 px-2.5 py-2 text-[10px] text-slate-300';

    const head = document.createElement('div');
    head.className = 'flex flex-wrap items-center justify-between gap-2';

    const label = document.createElement('span');
    label.className = 'font-semibold text-emerald-200';
    label.textContent = 'Versão ' + jobId;
    head.appendChild(label);

    const state = document.createElement('span');
    state.className = 'text-slate-500';
    state.textContent = 'gerando...';
    head.appendChild(state);
    row.appendChild(head);

    const preview = document.createElement('p');
    preview.className = 'mt-1 line-clamp-2 text-slate-500';
    preview.textContent = prompt;
    row.appendChild(preview);

    const actions = document.createElement('div');
    actions.className = 'mt-2 hidden flex-wrap items-center gap-2';
    row.appendChild(actions);

    chatgptImageJobs.prepend(row);
    return { row, state, actions };
  }

  function finishChatgptJob(job, data, jobId, recovered = false) {
    job.state.className = 'text-emerald-300';
    job.state.textContent = recovered ? 'recuperada' : 'pronta';
    job.actions.classList.remove('hidden');
    job.actions.classList.add('flex');

    const useButton = document.createElement('button');
    useButton.type = 'button';
    useButton.className = 'rounded-md border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 font-semibold text-emerald-100 hover:bg-emerald-500/20';
    useButton.textContent = 'Usar no recorte';
    useButton.addEventListener('click', () => {
      showChatgptImage(data, recovered);
      chatgptImageLastAppliedSeq = Math.max(chatgptImageLastAppliedSeq, jobId);
    });
    job.actions.appendChild(useButton);
  }

  function failChatgptJob(job, message) {
    job.state.className = 'text-rose-300';
    job.state.textContent = message || 'falhou';
  }

  async function waitChatgptImageJob(initial, job) {
    if (!initial?.jobId || initial.status === 'ready') return initial;
    const deadline = Date.now() + (7 * 60 * 1000);
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const res = await fetch(
        '/api/materias-ia/matters/' + cfg.id + '/arte/gerar-chatgpt/' + encodeURIComponent(initial.jobId),
        { headers: { Accept: 'application/json' } }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        throw new Error(data.error || 'Não foi possível acompanhar a geração da imagem.');
      }
      if (data.status === 'error') {
        const error = new Error(data.error || `O ${geradorImagemNome} não conseguiu gerar a imagem.`);
        error.code = data.errorCode;
        throw error;
      }
      if (data.status === 'ready') return data;
      if (job) job.state.textContent = 'gerando em conversa separada...';
    }
    throw new Error(`A geração continua no ${geradorImagemNome}. Use “Pegar imagem nova gerada” dentro de alguns minutos.`);
  }

  async function startChatgptImageJob(modo = 'referencia') {
    const prompt = String(chatgptImagePrompt?.value || '').trim();
    if (modo === 'referencia' && prompt.length < 20) {
      setChatgptStatus('Descreva a imagem com pelo menos 20 caracteres.', 'error');
      chatgptImagePrompt?.focus();
      return;
    }
    const jobId = ++chatgptImageJobSeq;
    const job = createChatgptJobRow(jobId, modo === 'simbolica'
      ? 'Ilustração simbólica de fé e esperança, sem pessoas e sem a foto original.'
      : prompt);
    chatgptImageActiveJobs += 1;
    updateChatgptGenerateLabel();
    setChatgptStatus(
      'Versão ' + jobId + ' enviada. Você pode gerar outra enquanto ela fica pronta.',
      'running'
    );
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/arte/gerar-chatgpt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, titulo: tituloEl?.value || '', modo }),
      });
      let data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `O ${geradorImagemNome} não conseguiu gerar a imagem.`);
      data = await waitChatgptImageJob(data, job);
      if (job) finishChatgptJob(job, data, jobId);
      if (jobId >= chatgptImageLastAppliedSeq) {
        showChatgptImage(data);
        chatgptImageLastAppliedSeq = jobId;
      }
      setChatgptStatus('Versão ' + jobId + ' pronta. Ajuste o recorte ou escolha outra versão da lista.', 'ok');
    } catch (err) {
      if (job) failChatgptJob(job, err.message || 'Falha ao gerar imagem');
      setChatgptStatus(err.message || `Falha ao gerar imagem com o ${geradorImagemNome}.`, 'error');
      if (err.code === 'image_safety_refusal') chatgptImageSymbolic?.focus();
    } finally {
      chatgptImageActiveJobs = Math.max(0, chatgptImageActiveJobs - 1);
      updateChatgptGenerateLabel();
    }
  }

  chatgptImageGenerate?.addEventListener('click', () => startChatgptImageJob());
  chatgptImageSymbolic?.addEventListener('click', () => startChatgptImageJob('simbolica'));

  chatgptImageRecover?.addEventListener('click', async () => {
    const original = chatgptImageRecover.textContent;
    chatgptImageRecover.disabled = true;
    chatgptImageRecover.textContent = 'Buscando…';
    setChatgptStatus(`Buscando a última imagem gerada na conversa do ${geradorImagemNome}…`, 'info');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/arte/recuperar-chatgpt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Não foi possível recuperar a imagem do ${geradorImagemNome}.`);
      showChatgptImage(data, true);
      const jobId = ++chatgptImageJobSeq;
      const job = createChatgptJobRow(jobId, `Imagem recuperada da conversa recente do ${geradorImagemNome}.`);
      if (job) finishChatgptJob(job, data, jobId, true);
      chatgptImageLastAppliedSeq = Math.max(chatgptImageLastAppliedSeq, jobId);
    } catch (err) {
      setChatgptStatus(err.message || `Não foi possível recuperar a imagem do ${geradorImagemNome}.`, 'error');
    } finally {
      chatgptImageRecover.disabled = false;
      chatgptImageRecover.textContent = original || 'Pegar imagem nova gerada';
      updateChatgptGenerateLabel();
    }
  });

  function applyCropControls() {
    const geometry = cropGeometry();
    if (!geometry) return;
    const width = geometry.imageWidth * (clampCropValue(cropWidth?.value ?? 100, 0.1, 100) / 100);
    const height = geometry.imageHeight * (clampCropValue(cropHeight?.value ?? 100, 0.1, 100) / 100);
    const left = Math.max(0, geometry.imageWidth - width) * (clampCropValue(cropX?.value ?? 50) / 100);
    const top = Math.max(0, geometry.imageHeight - height) * (clampCropValue(cropY?.value ?? 50) / 100);
    setCropBoxPixels(left, top, width, height, geometry);
  }

  function moveCropInteraction(event) {
    if (!cropInteraction) return;
    const geometry = cropGeometry();
    const stageRect = cropStage?.getBoundingClientRect();
    if (!geometry || !stageRect) return;
    const pointerX = event.clientX - stageRect.left;
    const pointerY = event.clientY - stageRect.top;

    if (cropInteraction.type === 'move') {
      setCropBoxPixels(
        pointerX - cropInteraction.grabX,
        pointerY - cropInteraction.grabY,
        geometry.width,
        geometry.height,
        geometry
      );
      return;
    }

    const start = cropInteraction.startGeometry;
    const handle = cropInteraction.handle;
    const deltaX = event.clientX - cropInteraction.startClientX;
    const deltaY = event.clientY - cropInteraction.startClientY;
    let left = start.left;
    let right = start.left + start.width;
    let top = start.top;
    let bottom = start.top + start.height;
    const minWidth = Math.min(1, start.imageWidth);
    const minHeight = Math.min(1, start.imageHeight);

    if (handle.includes('w')) left = Math.max(0, Math.min(right - minWidth, start.left + deltaX));
    if (handle.includes('e')) right = Math.min(start.imageWidth, Math.max(left + minWidth, start.left + start.width + deltaX));
    if (handle.includes('n')) top = Math.max(0, Math.min(bottom - minHeight, start.top + deltaY));
    if (handle.includes('s')) bottom = Math.min(start.imageHeight, Math.max(top + minHeight, start.top + start.height + deltaY));
    setCropBoxPixels(left, top, right - left, bottom - top, start);
  }

  [cropWidth, cropHeight, cropX, cropY].forEach((el) => el?.addEventListener('input', applyCropControls));
  btnAbrirRecorte?.addEventListener('click', openCropModal);
  cropClose?.addEventListener('click', closeCropModal);
  cropCancel?.addEventListener('click', closeCropModal);
  cropStage?.addEventListener('pointerdown', (event) => {
    const geometry = cropGeometry();
    const stageRect = cropStage.getBoundingClientRect();
    if (!geometry || !stageRect) return;
    event.preventDefault();
    const handle = event.target.closest?.('[data-crop-handle]')?.dataset?.cropHandle;
    const pointerX = event.clientX - stageRect.left;
    const pointerY = event.clientY - stageRect.top;
    if (handle) {
      cropInteraction = {
        type: 'resize',
        handle,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startGeometry: geometry,
      };
    } else if (cropSelection?.contains(event.target)) {
      cropInteraction = {
        type: 'move',
        grabX: pointerX - geometry.left,
        grabY: pointerY - geometry.top,
      };
    } else {
      cropInteraction = {
        type: 'move',
        grabX: geometry.width / 2,
        grabY: geometry.height / 2,
      };
      moveCropInteraction(event);
    }
    cropStage.setPointerCapture?.(event.pointerId);
  });
  cropStage?.addEventListener('pointermove', (event) => {
    if (cropInteraction) {
      event.preventDefault();
      moveCropInteraction(event);
    }
  });
  cropStage?.addEventListener('pointerup', (event) => {
    cropInteraction = null;
    cropStage.releasePointerCapture?.(event.pointerId);
  });
  cropStage?.addEventListener('pointercancel', () => {
    cropInteraction = null;
  });
  window.addEventListener('resize', () => {
    if (cropModal && !cropModal.classList.contains('hidden')) updateCropSelection();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && cropModal && !cropModal.classList.contains('hidden')) {
      closeCropModal();
    }
  });

  cropSave?.addEventListener('click', async () => {
    const geometry = updateCropSelection();
    if (!geometry) {
      setStatus('Aguarde a foto carregar para salvar o recorte.', true);
      return;
    }

    const originalLabel = cropSave.textContent;
    cropSave.disabled = true;
    cropSave.textContent = 'Recortando…';
    setStatus('Recortando a foto e atualizando a imagem destacada…');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/arte/recortar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          left: geometry.left / geometry.imageWidth,
          top: geometry.top / geometry.imageHeight,
          width: geometry.width / geometry.imageWidth,
          height: geometry.height / geometry.imageHeight,
          titulo: tituloEl?.value || '',
          sourceUrl: cropSourceUrl || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao recortar a foto');
      if (data.imagemUrl) {
        setArtImage(data.imagemUrl, {
          matter: data.matter,
          imagemFonteUrl: data.imagemFonteUrl,
        });
      }
      closeCropModal();
      setStatus('Foto recortada e salva como imagem destacada ✓');
    } catch (err) {
      setStatus(err.message || 'Erro ao recortar a foto', true);
    } finally {
      cropSave.disabled = false;
      cropSave.textContent = originalLabel || 'Recortar e salvar';
    }
  });

  function montarLegendaCompleta() {
    const titulo = String(tituloEl?.value || '').trim();
    const materia = String(materiaEl?.value || '').trim();
    const credito = String(fonteCreditoEl?.value || '').trim();
    const tags = String(document.getElementById('matter-hashtags-line')?.textContent || '').trim();
    const parts = [];
    if (titulo) parts.push(titulo);
    if (materia) {
      // Evita duplicar o título no início do corpo
      let body = materia;
      if (titulo && body.toLowerCase().startsWith(titulo.toLowerCase())) {
        body = body.slice(titulo.length).replace(/^[\s:—\-–.]+/, '').trim();
      }
      if (body) parts.push(body);
    }
    // Só anexa Fonte/crédito se ainda não estiver no corpo da matéria
    const jaTemCredito =
      /Por\s+.+\s*[—\-–]\s*Site\s*:/i.test(materia) ||
      /Fontes:\s*\n/i.test(materia) ||
      /^Fonte:\s.+/m.test(materia) ||
      /\(Foto:\s*[^)]+\)/i.test(materia);
    if (credito && !jaTemCredito) parts.push(credito);
    if (tags) parts.push(tags);
    return parts.join('\n\n').trim();
  }

  async function copiarLegenda() {
    const texto = montarLegendaCompleta();
    if (!texto) {
      setStatus('Não há legenda para copiar.', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(texto);
      const prev = btnCopiarLegenda?.textContent;
      if (btnCopiarLegenda) btnCopiarLegenda.textContent = 'Copiado ✓';
      setStatus('Legenda completa copiada (com fonte) ✓');
      setTimeout(() => {
        if (btnCopiarLegenda && prev) btnCopiarLegenda.textContent = prev;
      }, 1600);
    } catch {
      // fallback
      materiaEl.focus();
      materiaEl.select();
      try {
        document.execCommand('copy');
        setStatus('Legenda copiada ✓');
      } catch {
        setStatus('Não foi possível copiar. Selecione o texto manualmente.', true);
      }
    }
  }

  async function baixarArte(e) {
    if (e) e.preventDefault();
    const url = imgEl?.currentSrc || imgEl?.src || btnBaixarArte?.getAttribute('href');
    if (!url || url === '#' || url.endsWith('/#')) {
      setStatus('Nenhuma arte disponível para baixar.', true);
      return;
    }
    try {
      setStatus('Preparando download da arte…');
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Falha ao baixar (' + res.status + ')');
      const blob = await res.blob();
      const ext = (blob.type || '').includes('png') ? 'png' : 'jpg';
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = 'arte-materia-' + cfg.id + '.' + ext;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
      setStatus('Download da arte iniciado ✓');
    } catch (err) {
      // fallback: abre em nova aba
      window.open(url, '_blank', 'noopener');
      setStatus(err.message || 'Abra a imagem e salve manualmente.', true);
    }
  }

  btnCopiarLegenda?.addEventListener('click', (e) => {
    e.preventDefault();
    copiarLegenda();
  });
  btnBaixarArte?.addEventListener('click', baixarArte);
  if (imgEl?.src) syncDownloadArtLink(imgEl.src);

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Redes extras: a caixa só existe quando a Página está ativada em /paginas.
  // Sem a caixa na tela devolve null para o servidor manter a preferência já
  // salva na matéria — mandar "false" desligaria o Instagram sem o editor pedir.
  const instagramEl = document.getElementById('matter-publicar-instagram');
  const xEl = document.getElementById('matter-publicar-x');
  const facebookEl = document.getElementById('matter-publicar-facebook');
  const xEditorModal = document.getElementById('x-editor-modal');
  const xEditorBtn = document.getElementById('btn-editar-x');
  const xTextoEl = document.getElementById('matter-texto-x');
  const xTextoCount = document.getElementById('matter-texto-x-count');
  const xTextoStatus = document.getElementById('matter-texto-x-status');
  const xImagemUrlEl = document.getElementById('matter-imagem-x-url');
  const xImagemPreview = document.getElementById('matter-imagem-x-preview');
  const xImagemVazia = document.getElementById('matter-imagem-x-vazia');

  function xCodePointWeight(char) {
    const cp = char.codePointAt(0);
    return (
      (cp >= 0x0000 && cp <= 0x10ff) ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037)
    ) ? 1 : 2;
  }

  function pesoTextoX(value) {
    const texto = String(value || '');
    const urlRegex = /https?:\/\/[^\s]+/giu;
    let total = 0;
    let cursor = 0;
    let match;
    const somar = (trecho) => {
      for (const char of trecho) total += xCodePointWeight(char);
    };
    while ((match = urlRegex.exec(texto)) !== null) {
      somar(texto.slice(cursor, match.index));
      total += 23;
      cursor = match.index + match[0].length;
    }
    somar(texto.slice(cursor));
    return total;
  }

  function atualizarContadorX() {
    if (!xTextoCount) return 0;
    const peso = pesoTextoX(xTextoEl?.value);
    xTextoCount.textContent = peso + ' / 280';
    xTextoCount.classList.toggle('text-rose-300', peso > 280);
    xTextoCount.classList.toggle('text-emerald-300', peso <= 280);
    return peso;
  }

  function imagemAtualDoEditor() {
    return String(imgEl?.src || cfg.imagemAtual || '').trim();
  }

  function atualizarPreviewX() {
    if (!xImagemPreview) return;
    const url = String(xImagemUrlEl?.value || '').trim() || imagemAtualDoEditor();
    if (url) {
      xImagemPreview.src = url;
      xImagemPreview.classList.remove('hidden');
      xImagemVazia?.classList.add('hidden');
    } else {
      xImagemPreview.removeAttribute('src');
      xImagemPreview.classList.add('hidden');
      xImagemVazia?.classList.remove('hidden');
    }
  }

  async function gerarTextoParaX() {
    if (!xTextoEl) return false;
    const btn = document.getElementById('btn-gerar-texto-x');
    if (btn) btn.disabled = true;
    if (xTextoStatus) xTextoStatus.textContent = 'Claude está resumindo a matéria…';
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/texto-x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titulo: tituloEl.value, materia: materiaEl.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível gerar o texto do X.');
      xTextoEl.value = data.texto || '';
      atualizarContadorX();
      if (xTextoStatus) xTextoStatus.textContent = 'Versão criada com Claude. Você pode editar antes de publicar.';
      return true;
    } catch (err) {
      if (xTextoStatus) xTextoStatus.textContent = err.message;
      return false;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function abrirEditorX({ gerarSeVazio = false } = {}) {
    if (!xEditorModal) return;
    xEditorModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    atualizarContadorX();
    atualizarPreviewX();
    if (gerarSeVazio && !String(xTextoEl?.value || '').trim()) gerarTextoParaX();
  }

  function fecharEditorX() {
    xEditorModal?.classList.add('hidden');
    document.body.style.overflow = '';
  }

  async function salvarVersaoX({ fechar = true } = {}) {
    const texto = String(xTextoEl?.value || '').trim();
    if (!texto) {
      if (xTextoStatus) xTextoStatus.textContent = 'Gere ou escreva o texto do X.';
      return false;
    }
    if (atualizarContadorX() > 280) {
      if (xTextoStatus) xTextoStatus.textContent = 'Reduza o texto até o contador ficar em 280 ou menos.';
      return false;
    }
    const res = await fetch('/api/materias-ia/matters/' + cfg.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicarX: true,
        textoX: texto,
        imagemXUrl: String(xImagemUrlEl?.value || '').trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (xTextoStatus) xTextoStatus.textContent = data.error || 'Falha ao salvar a versão do X.';
      return false;
    }
    if (xTextoStatus) xTextoStatus.textContent = 'Versão exclusiva do X salva ✓';
    if (fechar) fecharEditorX();
    return true;
  }
  function facebookMarcado() {
    // Facebook segue como destino padrão, inclusive em matérias criadas antes
    // deste seletor.
    return !facebookEl || Boolean(facebookEl.checked);
  }
  function instagramMarcado() {
    if (!cfg.instagramAtivo || !instagramEl) return null;
    return Boolean(instagramEl.checked);
  }
  function xMarcado() {
    if (!cfg.xAtivo || !xEl) return null;
    return Boolean(xEl.checked);
  }

  async function salvar() {
    const res = await fetch('/api/materias-ia/matters/' + cfg.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        titulo: tituloEl.value,
        materia: materiaEl.value,
        fonteCredito: fonteCreditoEl ? fonteCreditoEl.value : undefined,
        tipoPublicacao: tipoEl.value,
        publicarInstagram: instagramMarcado(),
        publicarX: xMarcado(),
        textoX: xTextoEl ? xTextoEl.value : undefined,
        imagemXUrl: xImagemUrlEl ? xImagemUrlEl.value : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao salvar');
    if (data.imagemUrl && imgEl) {
      setArtImage(data.imagemUrl, { matter: data.matter, imagemFonteUrl: data.imagemFonteUrl || data.imagemFonte });
      imgWrap?.classList.remove('hidden');
    }
    if (data.aviso) setStatus(data.aviso);
    else setStatus('Alterações salvas ✓');
    return data;
  }

  window.saveMatterForDistribution = () => cfg.canEdit ? salvar() : Promise.resolve();

  document.getElementById('btn-salvar')?.addEventListener('click', async () => {
    setStatus('Salvando…');
    try {
      await salvar();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  xTextoEl?.addEventListener('input', atualizarContadorX);
  xImagemUrlEl?.addEventListener('input', atualizarPreviewX);
  document.getElementById('btn-gerar-texto-x')?.addEventListener('click', gerarTextoParaX);
  document.getElementById('btn-x-usar-imagem-atual')?.addEventListener('click', () => {
    if (xImagemUrlEl) xImagemUrlEl.value = '';
    atualizarPreviewX();
  });
  xEditorBtn?.addEventListener('click', () => abrirEditorX());
  document.getElementById('x-editor-fechar')?.addEventListener('click', fecharEditorX);
  document.getElementById('x-editor-cancelar')?.addEventListener('click', fecharEditorX);
  document.getElementById('x-editor-salvar')?.addEventListener('click', () => salvarVersaoX());
  xEditorModal?.addEventListener('click', (event) => {
    if (event.target === xEditorModal) fecharEditorX();
  });
  xEl?.addEventListener('change', () => {
    xEditorBtn?.classList.toggle('hidden', !xEl.checked);
    if (xEl.checked) abrirEditorX({ gerarSeVazio: true });
  });
  xEditorBtn?.classList.toggle('hidden', !xEl?.checked);
  atualizarContadorX();
  atualizarPreviewX();

  // 3 títulos alternativos ao principal: gerados com a matéria e trocáveis aqui.
  const altLista = document.getElementById('matter-titulos-alt');
  const altBtn = document.getElementById('btn-titulos-alt');
  const altDica = document.getElementById('matter-titulos-alt-dica');
  const altPedido = document.getElementById('matter-titulos-alt-pedido');

  function aplicarTituloAlternativo(novo) {
    if (!novo || !tituloEl) return;
    const anterior = String(tituloEl.value || '').trim();
    tituloEl.value = novo;
    setStatus('Aplicando título escolhido…');
    salvar()
      .then(() => setStatus('Título alternativo aplicado ✓'))
      .catch((err) => {
        tituloEl.value = anterior;
        setStatus(err.message, true);
      });
  }

  function renderTitulosAlternativos(titulos) {
    if (!altLista) return;
    altLista.replaceChildren();
    for (const t of titulos || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.tituloAlt = t;
      btn.className =
        'w-full rounded-md border border-slate-700 px-2.5 py-1.5 text-left text-xs leading-snug text-slate-300 transition hover:border-emerald-500/60 hover:text-white';
      btn.textContent = t;
      altLista.appendChild(btn);
    }
    altDica?.classList.toggle('hidden', !(titulos || []).length);
    if (altBtn) {
      altBtn.textContent = (titulos || []).length
        ? 'Gerar outros 3 com Claude'
        : 'Gerar 3 com Claude';
    }
  }

  altLista?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-titulo-alt]');
    if (!btn || !cfg.canEdit) return;
    aplicarTituloAlternativo(btn.dataset.tituloAlt);
  });

  altBtn?.addEventListener('click', async () => {
    altBtn.disabled = true;
    const rotulo = altBtn.textContent;
    altBtn.textContent = 'Gerando…';
    setStatus('Claude está gerando 3 títulos alternativos…');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/titulos-alternativos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tituloAtual: String(tituloEl?.value || '').trim(),
          materia: String(materiaEl?.value || '').trim(),
          orientacao: String(altPedido?.value || '').trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar títulos alternativos');
      renderTitulosAlternativos(data.titulos || []);
      setStatus('3 títulos alternativos prontos — clique em um para aplicar.');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      altBtn.disabled = false;
      altBtn.textContent = rotulo || 'Gerar outros 3 com Claude';
    }
  });

  const tituloSugestoes = [];
    const tomEl = document.getElementById('matter-titulo-tom');
  const manualWrap = document.getElementById('matter-titulo-manual-wrap');
  const manualEl = document.getElementById('matter-titulo-manual');
  const btnSugerirTitulo = document.getElementById('btn-sugerir-titulo');

  function syncTituloTomUi() {
    const isManual = tomEl?.value === 'manual';
    manualWrap?.classList.toggle('hidden', !isManual);
    if (btnSugerirTitulo && !btnSugerirTitulo.disabled) {
      btnSugerirTitulo.textContent = isManual ? 'Reescrever título' : 'Sugerir título';
    }
  }
  tomEl?.addEventListener('change', () => {
    syncTituloTomUi();
    if (tomEl.value === 'manual') {
      if (manualEl && !String(manualEl.value || '').trim() && tituloEl?.value) {
        manualEl.value = String(tituloEl.value || '').trim();
      }
      manualEl?.focus();
    }
  });
  syncTituloTomUi();

  btnSugerirTitulo?.addEventListener('click', async () => {
    const btn = btnSugerirTitulo;
    const tom = tomEl?.value || 'natural';
    const rascunhoManual = String(manualEl?.value || '').trim();
    if (tom === 'manual' && rascunhoManual.length < 8) {
      setStatus('No tom Manual, escreva o rascunho do título no campo abaixo.', true);
      manualEl?.focus();
      return;
    }
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = tom === 'manual' ? 'Reescrevendo…' : 'Gerando título…';
    }
    setStatus(
      tom === 'manual'
        ? 'A IA está reescrevendo o seu rascunho…'
        : 'A IA está sugerindo outro título…'
    );
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/sugerir-titulo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tom,
          evitar: tituloSugestoes.slice(-8),
          tituloAtual: String(tituloEl?.value || '').trim(),
          materia: String(materiaEl?.value || '').trim(),
          rascunhoManual: tom === 'manual' ? rascunhoManual : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao sugerir título');

      if (data.titulo && tituloEl) {
        tituloEl.value = data.titulo;
        tituloSugestoes.push(data.titulo);
      }
      if (data.imagemUrl && imgEl) {
        setArtImage(data.imagemUrl, { matter: data.matter, imagemFonteUrl: data.imagemFonteUrl || data.imagemFonte });
        imgWrap?.classList.remove('hidden');
      }
      const reelVideo = document.getElementById('matter-reel-video');
      if (data.videoUrl && reelVideo) {
        reelVideo.src = data.videoUrl + (data.videoUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        reelVideo.load();
      }
      setStatus(
        data.aviso ||
          (data.videoUrl
            ? 'Novo título aplicado e capa do Reel atualizada ✓'
            : data.imagemUrl
              ? 'Novo título aplicado e arte atualizada ✓'
              : tom === 'manual'
                ? 'Título reescrito a partir do seu rascunho ✓'
              : 'Novo título aplicado ✓')
      );
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = tom === 'manual' ? 'Reescrever título' : original || 'Sugerir título';
      }
    }
  });

  document.getElementById('btn-revisar-texto-manual')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-revisar-texto-manual');
    const materiaAtual = String(materiaEl?.value || '').trim();
    if (materiaAtual.length < 40) {
      setStatus('Escreva o texto da matéria antes de pedir correção.', true);
      materiaEl?.focus();
      return;
    }
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Corrigindo...';
    }
    setStatus('A IA está corrigindo gramática, clareza e ritmo sem acrescentar fatos...');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/revisar-texto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          titulo: tituloEl?.value || '',
          materia: materiaAtual,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao revisar o texto');

      if (data.titulo && tituloEl) tituloEl.value = data.titulo;
      if (data.materia && materiaEl) {
        materiaEl.value = data.materia;
        materiaEl.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const tagsLine = document.getElementById('matter-hashtags-line');
      const tagsWrap = document.getElementById('matter-hashtags-wrap');
      if (Array.isArray(data.hashtags) && data.hashtags.length && tagsLine) {
        tagsLine.textContent = data.hashtags
          .map((h) => '#' + String(h).replace(/^#/, ''))
          .join(' ');
        tagsWrap?.classList.remove('hidden');
        tagsLine.parentElement?.classList.remove('hidden');
      }
      setStatus('Texto corrigido com IA ✓');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Corrigir texto com IA';
      }
    }
  });

  document.getElementById('btn-reescrever-info')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-reescrever-info');
    const infoEl = document.getElementById('matter-info-extra');
    const infoExtra = String(infoEl?.value || '').trim();
    if (!infoExtra) {
      setStatus('Cole as informações extras no campo antes de reescrever.', true);
      infoEl?.focus();
      return;
    }
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Reescrevendo…';
    }
    setStatus('A IA está reforçando o texto com as informações incluídas…');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/reescrever-com-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          infoExtra,
          titulo: tituloEl?.value || '',
          materia: materiaEl?.value || '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao reescrever o texto');

      if (data.titulo && tituloEl) tituloEl.value = data.titulo;
      if (data.materia && materiaEl) materiaEl.value = data.materia;

      const tagsLine = document.getElementById('matter-hashtags-line');
      const tagsWrap = document.getElementById('matter-hashtags-wrap');
      if (Array.isArray(data.hashtags) && data.hashtags.length && tagsLine) {
        tagsLine.textContent = data.hashtags
          .map((h) => '#' + String(h).replace(/^#/, ''))
          .join(' ');
        tagsWrap?.classList.remove('hidden');
        tagsLine.parentElement?.classList.remove('hidden');
      }

      if (data.imagemUrl && imgEl) {
        imgEl.src = data.imagemUrl + (data.imagemUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        imgWrap?.classList.remove('hidden');
      }
      const reelVideo = document.getElementById('matter-reel-video');
      if (data.videoUrl && reelVideo) {
        reelVideo.src = data.videoUrl + (data.videoUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        reelVideo.load();
      }

      setStatus(data.aviso || 'Texto reescrito com as informações incluídas ✓');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Reescrever texto com informações incluídas';
      }
    }
  });

  document.getElementById('btn-enriquecer-fontes')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-enriquecer-fontes');
    const box = document.getElementById('matter-fontes-enriquecimento');
    const kwEl = document.getElementById('matter-enriquecer-keywords');
    const periodoEl = document.getElementById('matter-enriquecer-periodo');
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Buscando…';
    }
    const keywords = String(kwEl?.value || '').trim() || String(tituloEl?.value || '').trim();
    setStatus('Buscando reportagens (Google News + Brave), como em Pautas com IA…');
    if (box) {
      box.classList.remove('hidden');
      box.innerHTML =
        '<span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-emerald-400/30 border-t-emerald-300 align-middle"></span> ' +
        'Consultando notícias com: <strong class="text-slate-300">' +
        keywords.replace(/</g, '&lt;') +
        '</strong>';
    }
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/enriquecer-fontes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          titulo: tituloEl?.value || '',
          materia: materiaEl?.value || '',
          palavrasChave: keywords,
          periodo: periodoEl?.value || '180d',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao enriquecer a matéria');

      if (data.titulo && tituloEl) tituloEl.value = data.titulo;
      if (data.materia && materiaEl) {
        materiaEl.value = data.materia;
        materiaEl.dispatchEvent(new Event('input'));
      }

      const tagsLine = document.getElementById('matter-hashtags-line');
      const tagsWrap = document.getElementById('matter-hashtags-wrap');
      if (Array.isArray(data.hashtags) && data.hashtags.length && tagsLine) {
        tagsLine.textContent = data.hashtags
          .map((h) => '#' + String(h).replace(/^#/, ''))
          .join(' ');
        tagsWrap?.classList.remove('hidden');
        tagsLine.parentElement?.classList.remove('hidden');
      }

      if (data.imagemUrl && imgEl) {
        imgEl.src = data.imagemUrl + (data.imagemUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        imgWrap?.classList.remove('hidden');
      }
      const reelVideo = document.getElementById('matter-reel-video');
      if (data.videoUrl && reelVideo) {
        reelVideo.src = data.videoUrl + (data.videoUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        reelVideo.load();
      }

      if (box) {
        const fontes = Array.isArray(data.fontes) ? data.fontes : [];
        const fatos = Array.isArray(data.fatosUsados) ? data.fatosUsados : [];
        const linhas = [];
        if (data.queryUsada) {
          linhas.push(
            '<span class="text-slate-500">Busca:</span> <span class="text-slate-300">' +
              String(data.queryUsada).replace(/</g, '&lt;') +
              '</span>'
          );
        }
        if (fontes.length) {
          linhas.push(
            '<span class="font-semibold text-slate-300">Fontes:</span> ' +
              fontes
                .map((f) => {
                  const nome = (f.veiculo || 'Web') + (f.titulo ? ' — ' + String(f.titulo).slice(0, 60) : '');
                  return f.url
                    ? '<a class="text-sky-400 hover:text-sky-300" href="' +
                        f.url +
                        '" target="_blank" rel="noopener">' +
                        String(nome).replace(/</g, '&lt;') +
                        '</a>'
                    : String(nome).replace(/</g, '&lt;');
                })
                .join('<br/>')
          );
        }
        if (fatos.length) {
          linhas.push(
            '<span class="font-semibold text-slate-300">Fatos usados:</span> ' +
              fatos.map((f) => String(f).replace(/</g, '&lt;')).join(' · ')
          );
        }
        box.innerHTML = linhas.join('<br/>') || 'Enriquecimento concluído.';
        box.classList.remove('hidden');
      }

      setStatus(data.aviso || 'Matéria enriquecida com fatos de outras fontes ✓');
    } catch (err) {
      setStatus(err.message, true);
      if (box) {
        box.textContent = err.message;
        box.classList.remove('hidden');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Buscar e enriquecer';
      }
    }
  });

  document.getElementById('btn-publicar')?.addEventListener('click', async () => {
    try {
      if (window.pageDistribution && await window.pageDistribution.handlePublish()) return;
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    // A Página de destino é sempre a padrão da conta logada, definida em /paginas.
    const publishBtn = document.getElementById('btn-publicar');
    const isRepublish = Boolean(cfg.canRepublish || publishBtn?.dataset.republicar === '1');
    if (isRepublish) {
      const ok = window.confirm(
        'Republicar esta matéria? Será criado um novo post na Página (o post antigo permanece).'
      );
      if (!ok) return;
    }

    if (!facebookMarcado() && !instagramMarcado() && !xMarcado()) {
      setStatus('Selecione Facebook, Instagram, X.com ou mais de uma rede para publicar.', true);
      return;
    }

    if (xMarcado()) {
      if (!String(xTextoEl?.value || '').trim()) {
        setStatus('Preparando a versão curta para o X.com…');
        const gerado = await gerarTextoParaX();
        if (!gerado) {
          abrirEditorX();
          setStatus('Revise a versão do X.com antes de publicar.', true);
          return;
        }
      }
      if (atualizarContadorX() > 280) {
        abrirEditorX();
        if (xTextoStatus) {
          xTextoStatus.textContent = 'O texto ultrapassa o limite ponderado de 280. Reduza-o antes de publicar.';
        }
        setStatus('O texto exclusivo do X.com precisa ter no máximo 280.', true);
        return;
      }
    }

    if (publishBtn) publishBtn.disabled = true;

    showPublishModal('publishing');
    setStatus(
      cfg.isReel
        ? 'Publicando Reel (upload do vídeo pode levar 1–3 min)…'
        : isRepublish
          ? 'Republicando…'
          : 'Salvando e publicando…'
    );

    try {
      if (cfg.canEdit) await salvar();
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/publicar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipoPublicacao: cfg.isReel ? 'reel' : tipoEl.value,
          titulo: tituloEl.value,
          materia: materiaEl.value,
          publicarFacebook: facebookMarcado(),
          publicarInstagram: instagramMarcado(),
          publicarX: xMarcado(),
          textoX: xMarcado() ? String(xTextoEl?.value || '').trim() : null,
          imagemXUrl: xMarcado() ? String(xImagemUrlEl?.value || '').trim() : null,
          sync: true,
          forcar: true,
          republicar: isRepublish,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao publicar');

      if (data.imagemUrl && imgEl) {
        setArtImage(data.imagemUrl, { matter: data.matter, imagemFonteUrl: data.imagemFonteUrl || data.imagemFonte });
        imgWrap?.classList.remove('hidden');
      }

      showPublishModal('success', data.link || null);
      const publicouFacebook = data.facebookPublicado !== false;
      const publicouInstagram = Boolean(data.instagramPublicado);
      const publicouX = Boolean(data.xPublicado);
      const avisos = [
        data.instagramErro ? 'Instagram: ' + data.instagramErro : null,
        data.xErro ? 'X.com: ' + data.xErro : null,
      ].filter(Boolean);
      const redes = [
        publicouFacebook ? 'Facebook' : null,
        publicouInstagram ? 'Instagram' : null,
        publicouX ? 'X.com' : null,
      ].filter(Boolean);
      if (avisos.length) {
        setStatus(
          (redes.length ? 'Publicado no ' + redes.join(', ') + ' ✓ — ' : '') + avisos.join(' · '),
          true
        );
      } else {
        setStatus(
          (isRepublish ? 'Republicada' : 'Publicado') +
            (redes.length ? ' no ' + redes.join(', ') + ' ✓' : ' ✓')
        );
      }
      // A requisição terminou com sucesso e pelo menos um destino aceitou a
      // publicação. Avisos parciais do Instagram não podem prender o editor
      // neste modal; damos apenas mais tempo para ele ler a mensagem.
      const redirectDelay = avisos.length ? 4200 : 1800;
      setTimeout(() => {
        window.location.assign(cfg.listUrl || '/minhas-materias');
      }, redirectDelay);
    } catch (err) {
      hidePublishModal();
      setStatus(err.message, true);
      if (publishBtn) publishBtn.disabled = false;
    }
  });

  function showPublishModal(state, link) {
    const modal = document.getElementById('publish-modal');
    const spin = document.getElementById('publish-modal-spin');
    const ok = document.getElementById('publish-modal-ok');
    const title = document.getElementById('publish-modal-title');
    const text = document.getElementById('publish-modal-text');
    const linkEl = document.getElementById('publish-modal-link');
    if (!modal) return;

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    if (state === 'success') {
      spin?.classList.add('hidden');
      ok?.classList.remove('hidden');
      ok?.classList.add('flex');
      if (title) title.textContent = cfg.canRepublish ? 'Republicada com sucesso' : 'Publicado com sucesso';
      if (text) {
        text.textContent = cfg.canRepublish
          ? 'Uma nova publicação foi enviada para as redes selecionadas. Voltando para a lista…'
          : 'A matéria foi enviada para as redes selecionadas. Voltando para a lista…';
      }
      if (linkEl && link) {
        linkEl.href = link;
        linkEl.classList.remove('hidden');
      } else if (linkEl) {
        linkEl.classList.add('hidden');
      }
      return;
    }

    spin?.classList.remove('hidden');
    ok?.classList.add('hidden');
    ok?.classList.remove('flex');
    if (title) title.textContent = cfg.isReel ? 'Publicando Reel…' : 'Publicando…';
    if (text) {
      text.textContent = cfg.isReel
        ? 'Enviando o vídeo + capa e aguardando confirmação do Facebook. Pode levar até 3–4 minutos — não feche a página.'
        : 'Enviando a matéria para as redes selecionadas.';
    }
    if (linkEl) linkEl.classList.add('hidden');
  }

  function hidePublishModal() {
    const modal = document.getElementById('publish-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  /** datetime-local: agora em Araguaína + 30 min (YYYY-MM-DDTHH:mm) */
  function defaultScheduleAraguainaPlus30() {
    const target = new Date(Date.now() + 30 * 60 * 1000);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Araguaina',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(target);
    const get = (type) => parts.find((p) => p.type === type)?.value || '00';
    let hour = get('hour');
    if (hour === '24') hour = '00';
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
  }

  const scheduleInput = document.getElementById('matter-schedule');
  if (scheduleInput) {
    // Prioridade: horário já agendado / pré-agenda da Biblioteca → +30 → agora+30.
    if (!scheduleInput.value) {
      if (cfg.horarioAtualAgendado?.local) {
        scheduleInput.value = cfg.horarioAtualAgendado.local;
      } else if (cfg.agendaBiblioteca?.horario?.local) {
        scheduleInput.value = cfg.agendaBiblioteca.horario.local;
      } else if (cfg.agendaBiblioteca?.proposed_at_local) {
        scheduleInput.value = String(cfg.agendaBiblioteca.proposed_at_local).slice(0, 16);
      } else {
        scheduleInput.value = cfg.proximoSlotLocal || defaultScheduleAraguainaPlus30();
      }
    }
  }

  document.getElementById('btn-agendar-mais-30')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-agendar-mais-30');
    const slot = btn?.dataset?.slot || cfg.proximoSlotLocal;
    if (!slot || !scheduleInput) {
      setStatus('Não há matéria agendada para calcular +30 min.', true);
      return;
    }
    scheduleInput.value = slot;
    setStatus('Horário preenchido: 30 min após a última matéria agendada');
    scheduleInput.focus();
  });

  document.getElementById('btn-agendar')?.addEventListener('click', async () => {
    const runAt = document.getElementById('matter-schedule')?.value;
    if (!runAt) {
      setStatus('Escolha data e hora', true);
      return;
    }
    setStatus('Salvando e agendando…');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/agendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_at: runAt,
          titulo: tituloEl.value,
          materia: materiaEl.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao agendar');
      setStatus(
        cfg.agendaBiblioteca
          ? 'Agendada e confirmada na Biblioteca ✓'
          : cfg.horarioAtualAgendado
            ? 'Remarcada ✓ (horário de Araguaína)'
            : 'Agendada ✓ (horário de Araguaína)'
      );
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  const imageInput = document.getElementById('matter-image-input');
  const imagePreviewWrap = document.getElementById('matter-image-preview-wrap');
  const imagePreview = document.getElementById('matter-image-preview');
  const confirmImageButton = document.getElementById('btn-confirmar-imagem');
  const cancelImageButton = document.getElementById('btn-cancelar-imagem');
  let previewObjectUrl = null;

  function releaseImagePreview() {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }

  function clearImageSelection() {
    releaseImagePreview();
    if (imageInput) imageInput.value = '';
    if (imagePreview) imagePreview.removeAttribute('src');
    imagePreviewWrap?.classList.add('hidden');
  }

  imageInput?.addEventListener('change', () => {
    releaseImagePreview();
    const file = imageInput.files?.[0];
    if (!file) {
      clearImageSelection();
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      clearImageSelection();
      setStatus('Escolha uma imagem PNG, JPG ou WebP', true);
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      clearImageSelection();
      setStatus('A imagem deve ter no máximo 12 MB', true);
      return;
    }

    previewObjectUrl = URL.createObjectURL(file);
    imagePreview.src = previewObjectUrl;
    imagePreviewWrap?.classList.remove('hidden');
    setStatus('Confira a imagem e confirme para aplicar sua marca.');
  });

  cancelImageButton?.addEventListener('click', () => {
    clearImageSelection();
    setStatus('Troca de imagem cancelada.');
  });

  confirmImageButton?.addEventListener('click', async () => {
    const file = imageInput?.files?.[0];
    if (!file) {
      setStatus('Escolha uma imagem para continuar', true);
      return;
    }

    const originalLabel = confirmImageButton.textContent;
    confirmImageButton.disabled = true;
    confirmImageButton.textContent = 'Aplicando marca…';
    setStatus('Gerando a nova arte com sua marca…');

    try {
      const formData = new FormData();
      formData.append('imagem', file);
      formData.append('titulo', tituloEl.value);
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/arte', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao trocar a imagem');

      if (data.imagemUrl && imgEl) {
        setArtImage(data.imagemUrl, { matter: data.matter, imagemFonteUrl: data.imagemFonteUrl || data.imagemFonte });
        imgWrap?.classList.remove('hidden');
      }
      if (fonteCreditoEl && data.matter && 'fonte_credito' in data.matter) {
        fonteCreditoEl.value = data.matter.fonte_credito || '';
      }
      clearImageSelection();
      setStatus(
        data.hasLogo
          ? 'Nova imagem confirmada e marca aplicada ✓'
          : 'Nova imagem confirmada com sua identidade visual (sem logomarca cadastrada) ✓'
      );
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      confirmImageButton.disabled = false;
      confirmImageButton.textContent = originalLabel;
    }
  });

  const reloadBrandButton = document.getElementById('btn-recarregar-marca');
  reloadBrandButton?.addEventListener('click', async () => {
    const originalLabel = reloadBrandButton.textContent;
    reloadBrandButton.disabled = true;
    reloadBrandButton.textContent = 'Recarregando modelo…';
    setStatus('Aplicando o modelo atual da sua marca…');

    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/arte/regenerar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelo: cfg.arteModelo || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao recarregar o modelo da marca');

      if (data.imagemUrl && imgEl) {
        setArtImage(data.imagemUrl, { matter: data.matter, imagemFonteUrl: data.imagemFonteUrl || data.imagemFonte });
        imgWrap?.classList.remove('hidden');
      }
      if (data.arteModelo) cfg.arteModelo = data.arteModelo;
      if (data.titulo) {
        const tituloEl = document.getElementById('matter-titulo');
        if (tituloEl) tituloEl.value = data.titulo;
      }
      setStatus('Modelo, logo e cores atuais aplicados à arte ✓');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      reloadBrandButton.disabled = false;
      reloadBrandButton.textContent = originalLabel;
    }
  });

  async function aplicarModeloArte(modelId) {
    if (!modelId) return;
    setStatus('Aplicando modelo “' + modelId + '”…');
    document.querySelectorAll('.js-matter-art-model').forEach((b) => {
      b.disabled = true;
    });
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/arte/regenerar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelo: modelId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao trocar o modelo');

      cfg.arteModelo = data.arteModelo || modelId;
      document.querySelectorAll('.js-matter-art-model').forEach((b) => {
        const on = b.dataset.model === cfg.arteModelo;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.classList.toggle('border-emerald-400', on);
        b.classList.toggle('ring-1', on);
        b.classList.toggle('ring-emerald-400/30', on);
        b.classList.toggle('border-slate-700', !on);
      });
      if (data.imagemUrl && imgEl) {
        setArtImage(data.imagemUrl, { matter: data.matter, imagemFonteUrl: data.imagemFonteUrl || data.imagemFonte });
        imgWrap?.classList.remove('hidden');
      }
      if (data.titulo) {
        const tituloEl = document.getElementById('matter-titulo');
        if (tituloEl) tituloEl.value = data.titulo;
      }
      setStatus('Modelo aplicado à imagem destacada ✓');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      document.querySelectorAll('.js-matter-art-model').forEach((b) => {
        b.disabled = false;
      });
    }
  }

  document.querySelectorAll('.js-matter-art-model').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modelId = btn.dataset.model;
      if (!modelId || modelId === cfg.arteModelo) return;
      aplicarModeloArte(modelId);
    });
  });

  function setSuggestLoading(on) {
    const box = document.getElementById('matter-img-suggest-loading');
    const strip = document.getElementById('matter-img-suggest-strip');
    const wrap = document.getElementById('matter-img-wrap');
    if (box) {
      box.classList.toggle('hidden', !on);
      box.classList.toggle('flex', on);
    }
    if (strip) {
      strip.style.opacity = on ? '0.45' : '';
      strip.style.pointerEvents = on ? 'none' : '';
    }
    if (wrap) {
      wrap.style.opacity = on ? '0.55' : '';
    }
  }

  /* —— Colagem com 2 imagens —— */
  window.__COLAGEM_MODE__ = false;
  window.__COLAGEM__ = { a: null, b: null, layout: 'lado', fit: 'preservar', zoom: 92 };

  const colagemZoom = document.getElementById('colagem-zoom');
  const colagemZoomValor = document.getElementById('colagem-zoom-valor');
  colagemZoom?.addEventListener('input', () => {
    const z = Math.min(150, Math.max(80, Number(colagemZoom.value) || 92));
    window.__COLAGEM__.zoom = z;
    if (colagemZoomValor) colagemZoomValor.textContent = z + '%';
  });

  function renderColagemSlots() {
    const slotA = document.getElementById('colagem-slot-a');
    const slotB = document.getElementById('colagem-slot-b');
    const btnGerar = document.getElementById('btn-colagem-gerar');
    const fill = (el, item, label) => {
      if (!el) return;
      if (item?.url) {
        const thumb = String(item.thumbnail || item.url).replace(/"/g, '&quot;');
        const fit = window.__COLAGEM__.fit === 'preencher' ? 'object-cover' : 'object-contain';
        el.innerHTML = `<img src="${thumb}" alt="" class="h-full w-full ${fit}" />`;
        el.classList.remove('border-dashed', 'text-slate-500');
        el.classList.add('border-amber-500/50');
      } else {
        el.textContent = label;
        el.classList.add('border-dashed', 'text-slate-500');
        el.classList.remove('border-amber-500/50');
      }
    };
    fill(slotA, window.__COLAGEM__.a, '1ª foto');
    fill(slotB, window.__COLAGEM__.b, '2ª foto');
    if (btnGerar) btnGerar.disabled = !(window.__COLAGEM__.a?.url && window.__COLAGEM__.b?.url);
  }

  function selecionarParaColagem(chosen) {
    if (!chosen?.url) return;
    if (!window.__COLAGEM__.a) {
      window.__COLAGEM__.a = chosen;
      setStatus('1ª foto ok — escolha a 2ª miniatura');
    } else if (!window.__COLAGEM__.b) {
      if (chosen.url === window.__COLAGEM__.a.url) {
        setStatus('Escolha uma foto diferente da primeira.', true);
        return;
      }
      window.__COLAGEM__.b = chosen;
      setStatus('2 fotos prontas — clique em “Gerar arte com as 2 fotos”');
    } else {
      window.__COLAGEM__.a = chosen;
      window.__COLAGEM__.b = null;
      setStatus('Nova 1ª foto — escolha a 2ª');
    }
    renderColagemSlots();
  }

  function setColagemMode(on) {
    window.__COLAGEM_MODE__ = Boolean(on);
    const body = document.getElementById('matter-colagem-body');
    const btn = document.getElementById('btn-colagem-toggle');
    const strip = document.getElementById('matter-img-suggest-strip');
    if (body) body.classList.toggle('hidden', !on);
    if (btn) btn.textContent = on ? 'Desativar' : 'Ativar';
    if (strip) {
      strip.classList.toggle('ring-1', on);
      strip.classList.toggle('ring-amber-500/40', on);
    }
    if (on) setStatus('Modo 2 imagens: clique em duas miniaturas');
  }

  document.getElementById('btn-colagem-toggle')?.addEventListener('click', () => {
    setColagemMode(!window.__COLAGEM_MODE__);
  });

  document.querySelectorAll('.colagem-layout-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const layout = btn.getAttribute('data-colagem-layout') === 'cima' ? 'cima' : 'lado';
      window.__COLAGEM__.layout = layout;
      document.querySelectorAll('.colagem-layout-btn').forEach((b) => {
        const active = b.getAttribute('data-colagem-layout') === layout;
        b.classList.toggle('border-amber-500/50', active);
        b.classList.toggle('bg-amber-500/15', active);
        b.classList.toggle('text-amber-100', active);
        b.classList.toggle('border-slate-600', !active);
        b.classList.toggle('text-slate-300', !active);
      });
    });
  });

  document.querySelectorAll('.colagem-fit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fit = btn.getAttribute('data-colagem-fit') === 'preencher' ? 'preencher' : 'preservar';
      window.__COLAGEM__.fit = fit;
      document.querySelectorAll('.colagem-fit-btn').forEach((b) => {
        const active = b.getAttribute('data-colagem-fit') === fit;
        b.classList.toggle('border-amber-500/50', active);
        b.classList.toggle('bg-amber-500/15', active);
        b.classList.toggle('text-amber-100', active);
        b.classList.toggle('border-slate-600', !active);
        b.classList.toggle('text-slate-300', !active);
      });
      renderColagemSlots();
    });
  });

  document.getElementById('btn-colagem-limpar')?.addEventListener('click', () => {
    window.__COLAGEM__.a = null;
    window.__COLAGEM__.b = null;
    renderColagemSlots();
    setStatus('Slots limpos — escolha 2 miniaturas');
  });

  document.getElementById('btn-colagem-gerar')?.addEventListener('click', async () => {
    const a = window.__COLAGEM__.a;
    const b = window.__COLAGEM__.b;
    if (!a?.url || !b?.url) {
      setStatus('Escolha 2 miniaturas antes de gerar.', true);
      return;
    }
    const btn = document.getElementById('btn-colagem-gerar');
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Gerando…';
    }
    setSuggestLoading(true);
    setStatus('Montando as 2 fotos e aplicando Minha marca…');
    try {
      const r = await fetch('/api/materias-ia/matters/' + cfg.id + '/arte/colagem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrlA: a.url,
          imageUrlB: b.url,
          thumbnailA: a.thumbnail || a.url || null,
          thumbnailB: b.thumbnail || b.url || null,
          layout: window.__COLAGEM__.layout || 'lado',
          fit: window.__COLAGEM__.fit || 'preservar',
          zoom: Number(colagemZoom?.value ?? window.__COLAGEM__.zoom ?? 92),
          offsetX: Number(artOffsetX?.value ?? 50),
          offsetY: Number(artOffsetY?.value ?? 50),
          titulo: tituloEl?.value || '',
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Falha ao montar colagem');
      if (j.imagemUrl && imgEl) {
        setArtImage(j.imagemUrl, { matter: j.matter, imagemFonteUrl: j.imagemFonteUrl || j.imagemFonte });
        imgWrap?.classList.remove('hidden');
      }
      setStatus('Arte com 2 imagens pronta.');
      setColagemMode(false);
      window.__COLAGEM__.a = null;
      window.__COLAGEM__.b = null;
      renderColagemSlots();
    } catch (err) {
      setStatus(err.message || 'Erro na colagem', true);
    } finally {
      setSuggestLoading(false);
      if (btn) {
        btn.disabled = !(window.__COLAGEM__.a?.url && window.__COLAGEM__.b?.url);
        btn.textContent = original || 'Gerar arte com as 2 fotos';
      }
    }
  });

  async function aplicarImagemSugerida(chosen, el) {
    if (!chosen?.url) return;

    if (window.__COLAGEM_MODE__) {
      selecionarParaColagem(chosen);
      return;
    }

    if (el) el.disabled = true;
    setSuggestLoading(true);
    setStatus('Aguarde, alterando a arte…');
    try {
      const r = await fetch('/api/materias-ia/matters/' + cfg.id + '/aplicar-imagem-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: chosen.url,
          titulo: tituloEl?.value || '',
          autor: chosen.autor || null,
          fonte: chosen.fonte || null,
          imagemTitulo: chosen.titulo || null,
          origem: chosen.origem || null,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Falha ao aplicar imagem');
      if (j.imagemUrl && imgEl) {
        setArtImage(j.imagemUrl, { matter: j.matter, imagemFonteUrl: j.imagemFonteUrl || j.imagemFonte });
        imgWrap?.classList.remove('hidden');
      }
      // O texto da matéria fica como o editor deixou (inclusive edições ainda
      // não salvas); trocar a imagem só atualiza a arte e o crédito.
      if (fonteCreditoEl && j.matter && 'fonte_credito' in j.matter) {
        fonteCreditoEl.value = j.matter.fonte_credito || '';
      }
      // Marca a miniatura escolhida como "Atual" sem buscar de novo na API
      const list = window.__IMG_SUGESTOES__ || [];
      const idx = Number(el?.dataset?.suggestIdx);
      list.forEach((img, i) => {
        if (img.origem === 'fonte') img.origem = img._origemAntes || 'google';
        if (i === idx) {
          img._origemAntes = img.origem;
          img.origem = 'fonte';
        }
      });
      if (window.__IMG_SUGESTOES_CACHE__) {
        window.__IMG_SUGESTOES_CACHE__.imagens = list;
        saveSuggestCache(window.__IMG_SUGESTOES_CACHE__);
      }
      renderSuggestStrip(window.__IMG_SUGESTOES_CACHE__ || { imagens: list });
      setStatus('Arte atualizada ✓');
    } catch (err) {
      setStatus(err.message, true);
      if (el) el.disabled = false;
    } finally {
      setSuggestLoading(false);
    }
  }

  // Nova chave evita reaproveitar a lista antiga, menor e de um único provedor.
  const SUGGEST_CACHE_KEY = 'matter-img-suggest:v2:' + cfg.id;

  function saveSuggestCache(data) {
    try {
      sessionStorage.setItem(
        SUGGEST_CACHE_KEY,
        JSON.stringify({
          aviso: data.aviso || null,
          pessoa: data.pessoa || null,
          motivo: data.motivo || null,
          imagens: data.imagens || [],
        })
      );
    } catch {
      /* ignore quota */
    }
  }

  function loadSuggestCache() {
    try {
      const raw = sessionStorage.getItem(SUGGEST_CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data?.imagens?.length) return null;
      return data;
    } catch {
      return null;
    }
  }

  function renderSuggestStrip(data) {
    const strip = document.getElementById('matter-img-suggest-strip');
    const meta = document.getElementById('matter-img-suggest-meta');
    const imgs = data.imagens || [];
    window.__IMG_SUGESTOES__ = imgs;
    window.__IMG_SUGESTOES_CACHE__ = data;

    if (meta) {
      const parts = [];
      if (data.aviso) parts.push(data.aviso);
      if (data.pessoa) parts.push(data.pessoa);
      parts.push('Clique numa miniatura para trocar a arte');
      meta.textContent = parts.join(' · ');
    }

    if (!strip) return;
    if (!imgs.length) {
      strip.innerHTML = '<p class="text-[11px] text-slate-500">Nenhuma sugestão encontrada.</p>';
      return;
    }

    strip.innerHTML = imgs
      .map((img, i) => {
        const thumb = String(img.thumbnail || img.url || '').replace(/"/g, '&quot;');
        const isAtual = img.origem === 'fonte';
        const label =
          isAtual
            ? 'Post'
            : img.origem === 'serpapi'
              ? 'Google'
            : img.origem === 'brave'
              ? 'Brave'
              : img.origem === 'bing' || img.origem === 'python-bing'
                ? 'Bing'
                : img.origem === 'google-news'
                  ? 'Notícia'
                  : img.origem === 'google-chrome'
                    ? 'Google'
                  : img.origem === 'google'
                  ? 'Serper'
                  : img.origem || '';
        const border = isAtual ? 'border-emerald-400' : 'border-slate-700 hover:border-violet-400';
        return `<button type="button" data-suggest-idx="${i}" title="${String(img.titulo || '').replace(/"/g, '&quot;')}"
          class="relative shrink-0 overflow-hidden rounded-md border bg-slate-950 focus:outline-none focus:ring-1 focus:ring-violet-400 ${border}"
          style="width:56px;height:72px;padding:0;flex:0 0 56px">
          <img src="${thumb}" alt="" loading="lazy" decoding="async"
            style="width:100%;height:100%;object-fit:cover;display:block" />
          <span class="absolute bottom-0 left-0 right-0 bg-black/75 py-px text-center text-[8px] leading-tight text-slate-200">${label}</span>
        </button>`;
      })
      .join('');

    strip.querySelectorAll('[data-suggest-idx]').forEach((el) => {
      el.addEventListener('click', () => {
        const chosen = (window.__IMG_SUGESTOES__ || [])[Number(el.dataset.suggestIdx)];
        aplicarImagemSugerida(chosen, el);
      });
    });
  }

  async function carregarSugestoesImagem({ silent, force, consulta } = {}) {
    const meta = document.getElementById('matter-img-suggest-meta');
    const strip = document.getElementById('matter-img-suggest-strip');
    if (!cfg.canEdit || !strip) return;

    const q = String(consulta || '').trim();

    if (!force && !q) {
      const cached = loadSuggestCache();
      if (cached) {
        renderSuggestStrip(cached);
        if (!silent) setStatus('Sugestões em cache — clique em “Buscar novas” para atualizar');
        return;
      }
    }

    if (!silent) {
      setStatus(q ? 'Buscando fotos de “' + q + '”…' : 'Buscando fotos relacionadas à matéria…');
    }
    if (meta) {
      meta.textContent = q ? 'Buscando “' + q + '”…' : 'Buscando fotos relacionadas…';
    }
    try {
      const body = q ? { q, limite: 24 } : { limite: 24 };
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/sugerir-imagens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao sugerir imagens');
      saveSuggestCache(data);
      renderSuggestStrip(data);
      if (!silent) {
        setStatus((data.imagens || []).length + ' sugestões — clique numa miniatura para trocar');
      }
    } catch (err) {
      if (meta) meta.textContent = err.message;
      if (strip) {
        strip.innerHTML = `<p class="text-[11px] text-rose-300">${String(err.message || '').replace(/</g, '')}</p>`;
      }
      if (!silent) setStatus(err.message, true);
    }
  }

  // Minhas imagens: reaproveita uma foto limpa já gerada/enviada como capa.
  document.getElementById('btn-banco-imagens')?.addEventListener('click', () => {
    if (!window.BancoImagens) return setStatus('Recarregue a página para abrir Minhas imagens.', true);
    window.BancoImagens.abrir({
      titulo: 'Escolher imagem para a capa',
      onEscolher: async (item) => {
        setSuggestLoading(true);
        setStatus('Aguarde, aplicando a imagem…');
        try {
          const r = await fetch('/api/materias-ia/matters/' + cfg.id + '/aplicar-imagem-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageUrl: item.url, titulo: tituloEl?.value || '', creditoFixo: item.credito }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || 'Falha ao aplicar imagem');
          if (j.imagemUrl && imgEl) {
            setArtImage(j.imagemUrl, { matter: j.matter, imagemFonteUrl: j.imagemFonteUrl || j.imagemFonte });
            imgWrap?.classList.remove('hidden');
          }
          if (fonteCreditoEl && j.matter && 'fonte_credito' in j.matter) {
            fonteCreditoEl.value = j.matter.fonte_credito || '';
          }
          setStatus('Imagem de Minhas imagens aplicada ✓');
        } catch (err) {
          setStatus(err.message, true);
        } finally {
          setSuggestLoading(false);
        }
      },
    });
  });

  document.getElementById('btn-sugerir-imagens')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sugerir-imagens');
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Buscando…';
    }
    try {
      await carregarSugestoesImagem({ silent: false, force: true });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Buscar novas sugestões';
      }
    }
  });

  async function buscarPorPalavraDigitada() {
    const input = document.getElementById('matter-img-busca-q');
    const btn = document.getElementById('btn-buscar-img-palavra');
    const q = String(input?.value || '').trim();
    if (q.length < 2) {
      setStatus('Digite pelo menos 2 caracteres para buscar a imagem.', true);
      input?.focus();
      return;
    }
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '…';
    }
    if (input) input.disabled = true;
    try {
      await carregarSugestoesImagem({ silent: false, force: true, consulta: q });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Buscar';
      }
      if (input) input.disabled = false;
    }
  }

  document.getElementById('btn-buscar-img-palavra')?.addEventListener('click', () => {
    buscarPorPalavraDigitada();
  });
  document.getElementById('matter-img-busca-q')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      buscarPorPalavraDigitada();
    }
  });

  // Carrega miniaturas automaticamente ao abrir a edição (só foto)
  if (cfg.canEdit && !cfg.isReel) {
    carregarSugestoesImagem({ silent: true, force: false });
  }

  // Reel em processamento: atualiza a página quando vídeo/legenda ficarem prontos
  if (cfg.isReel && cfg.reelProcessing) {
    setStatus('Processando Reel (download → fala → legenda → capa)…');
    let tries = 0;
    const poll = async () => {
      tries += 1;
      if (tries > 90) {
        setStatus('Ainda processando. Atualize a página em instantes.', true);
        return;
      }
      try {
        const res = await fetch('/api/materias-ia/matters/' + cfg.id);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao consultar matéria');
        const m = data.matter;
        const ready =
          m?.video_path && m?.materia && !String(m.materia).startsWith('⏳');
        if (ready || (m?.video_path && tries > 3)) {
          window.location.reload();
          return;
        }
        if (m?.error_message && m?.status === 'erro' && !m.video_path) {
          setStatus(m.error_message, true);
          return;
        }
      } catch (err) {
        console.warn(err);
      }
      setTimeout(poll, 4000);
    };
    setTimeout(poll, 3000);
  }

  document.getElementById('btn-buscar-imagem-fonte')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-buscar-imagem-fonte');
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Buscando na fonte…';
    }
    setStatus('Buscando a foto de capa na página da notícia…');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/buscar-imagem-fonte', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Não foi possível buscar a imagem da fonte');

      if (data.imagemUrl && imgEl) {
        setArtImage(data.imagemUrl, { matter: data.matter, imagemFonteUrl: data.imagemFonteUrl || data.imagemFonte });
        imgWrap?.classList.remove('hidden');
      }
      setStatus(data.aviso || 'Imagem da fonte aplicada e arte gerada ✓');
      // Recarrega para mostrar botão "Aplicar marca" e preview corretos
      setTimeout(() => window.location.reload(), 700);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Buscar imagem da fonte';
      }
    }
  });

  // Limpar → começar outra matéria pelo link sem sair da tela
  const novaLinkPanel = document.getElementById('matter-nova-link');
  const editAtual = document.getElementById('matter-edit-atual');
  const novaLinkUrl = document.getElementById('matter-nova-link-url');
  const novaLinkStatus = document.getElementById('matter-nova-link-status');

  function mostrarModoNovaLink() {
    if (editAtual) editAtual.classList.add('hidden');
    if (novaLinkPanel) novaLinkPanel.classList.remove('hidden');
    document.querySelector('aside')?.classList.add('opacity-40', 'pointer-events-none');
    if (novaLinkUrl) {
      novaLinkUrl.value = '';
      novaLinkUrl.focus();
    }
    const texto = document.getElementById('matter-nova-link-texto');
    const imagem = document.getElementById('matter-nova-link-imagem');
    const tipo = document.getElementById('matter-nova-link-tipo');
    if (texto) texto.value = '';
    if (imagem) imagem.value = '';
    if (tipo) tipo.value = 'auto';
    if (novaLinkStatus) {
      novaLinkStatus.textContent = 'Cole o link e gere a próxima matéria.';
      novaLinkStatus.className = 'text-sm text-slate-400';
    }
    setStatus('');
  }

  function mostrarModoEdicaoAtual() {
    if (novaLinkPanel) novaLinkPanel.classList.add('hidden');
    if (editAtual) editAtual.classList.remove('hidden');
    document.querySelector('aside')?.classList.remove('opacity-40', 'pointer-events-none');
    if (novaLinkStatus) novaLinkStatus.textContent = '';
  }

  document.getElementById('btn-limpar-nova-materia')?.addEventListener('click', () => {
    mostrarModoNovaLink();
  });

  document.getElementById('btn-cancelar-nova-link')?.addEventListener('click', () => {
    mostrarModoEdicaoAtual();
  });

  document.getElementById('btn-gerar-nova-link')?.addEventListener('click', async () => {
    const url = String(novaLinkUrl?.value || '').trim();
    const tipoEl = document.getElementById('matter-nova-link-tipo');
    const st = novaLinkStatus;
    const btn = document.getElementById('btn-gerar-nova-link');

    if (!url) {
      if (st) {
        st.textContent = 'Cole o link da notícia, Facebook ou Instagram';
        st.className = 'text-sm text-rose-300';
      }
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      if (st) {
        st.textContent = 'O link precisa começar com http:// ou https://';
        st.className = 'text-sm text-rose-300';
      }
      return;
    }

    const looksReel =
      /\/reel\//i.test(url) ||
      /\/reels\//i.test(url) ||
      /\/videos\//i.test(url) ||
      /fb\.watch/i.test(url) ||
      /instagram\.com\/(reel|reels|tv)\//i.test(url);

    let tipo = tipoEl?.value || 'auto';
    if (tipo === 'auto') tipo = looksReel ? 'reel' : 'foto';

    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = looksReel || tipo === 'reel' ? 'Enfileirando Reel…' : 'Gerando matéria…';
    }
    if (st) {
      st.textContent =
        looksReel || tipo === 'reel'
          ? 'Baixando Reel, legenda e capa…'
          : 'Lendo o link e montando a minimatéria…';
      st.className = 'text-sm text-slate-400';
    }

    try {
      const textoManual = String(document.getElementById('matter-nova-link-texto')?.value || '').trim();
      const imagemManual = String(document.getElementById('matter-nova-link-imagem')?.value || '').trim();
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error && /cole a legenda|texto da postagem|bloqueou/i.test(data.error)) {
          document.querySelector('#matter-nova-link details')?.setAttribute('open', '');
        }
        throw new Error(data.error || 'Falha ao processar o link');
      }

      const matterId = data.matter?.id;
      const dest = data.redirect || (matterId ? '/materias-ia/' + matterId : null);
      if (!dest) throw new Error('Matéria gerada, mas sem ID para abrir');

      if (st) st.textContent = 'Pronta — abrindo a nova matéria…';
      window.location.href = dest;
    } catch (err) {
      if (st) {
        st.textContent = err.message;
        st.className = 'text-sm text-rose-300';
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Gerar a partir do link';
      }
    }
  });

  novaLinkUrl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('btn-gerar-nova-link')?.click();
    }
  });

  document.getElementById('btn-variacao-tema')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-variacao-tema');
    if (!confirm('Gerar uma NOVA matéria neste tema?\n\nA IA busca informações novas e reescreve sem plagiar.')) {
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Gerando…';
    }
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/variacao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipoPublicacao: tipoEl?.value || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar');
      const dest = data.redirect || (data.matter?.id ? '/materias-ia/' + data.matter.id : null);
      if (dest) window.location.href = dest;
      else alert('Matéria gerada.');
    } catch (err) {
      alert(err.message || 'Erro');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Nova matéria neste tema';
      }
    }
  });

  document.getElementById('btn-gerar-reel')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-gerar-reel');
    const regenerar = btn?.dataset?.hasVideo === '1';
    const msg = regenerar
      ? 'Regenerar o Reel narrado?\n\nResumo até 60s + voz + música (sem legenda no vídeo).'
      : 'Gerar Reel narrado?\n\nResume a matéria em até 60 segundos, com voz e trilha.';
    if (!confirm(msg)) return;

    const statusEl = document.getElementById('matter-status');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Montando Reel…';
    }
    if (statusEl) {
      statusEl.classList.remove('hidden');
      statusEl.textContent = 'Narrando (suspense) e animando a imagem da matéria…';
    }
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/gerar-reel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar Reel');
      if (statusEl) {
        statusEl.textContent =
          'Reel pronto' +
          (data.duracao ? ' (~' + Math.round(data.duracao) + 's)' : '') +
          '. Recarregando…';
      }
      window.location.reload();
    } catch (err) {
      alert(err.message || 'Erro ao gerar Reel');
      if (btn) {
        btn.disabled = false;
        btn.textContent = regenerar ? 'Regenerar Reel narrado' : 'Gerar Reel narrado';
      }
      if (statusEl) {
        statusEl.textContent = '';
        statusEl.classList.add('hidden');
      }
    }
  });

  document.getElementById('btn-matter-views')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-matter-views');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Buscando…';
    }
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/views?force=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha');

      function fmt(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return null;
        if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + ' mi';
        if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + ' mil';
        return String(Math.round(v));
      }

      const parts = [];
      if (data.likes != null) parts.push(fmt(data.likes) + ' curtidas');
      if (data.comments != null) parts.push(fmt(data.comments) + ' comentários');
      if (data.shares != null) parts.push(fmt(data.shares) + ' shares');
      if (data.views != null) parts.push(fmt(data.views) + ' views');
      const viral = data.viral?.label ? '\n\n' + data.viral.label : '';
      if (parts.length) {
        alert(parts.join(' · ') + viral);
      } else {
        alert(data.message || 'Sem dado de engajamento ainda.');
      }
    } catch (err) {
      alert(err.message || 'Erro ao buscar engajamento');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Atualizar engajamento';
      }
    }
  });

  window.addEventListener('beforeunload', releaseImagePreview);
})();
