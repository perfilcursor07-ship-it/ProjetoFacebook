(function () {
  const secao = document.getElementById('modelos-materia');
  if (!secao) return;

  const API = '/api/admin/claude-gateway/modelos-materia';
  const lista = document.getElementById('modelos-materia-lista');
  const statusEl = document.getElementById('modelos-materia-status');
  const gatewayEl = document.getElementById('modelos-materia-gateway');
  const salvarBtn = document.getElementById('modelos-materia-salvar');
  const provedores = {
    claude: { rotulo: 'Claude', classe: 'border-orange-400/30 bg-orange-400/10 text-orange-200' },
    chatgpt: { rotulo: 'ChatGPT', classe: 'border-sky-400/30 bg-sky-400/10 text-sky-200' },
  };
  let modelos = [];

  function setStatus(texto, erro) {
    statusEl.textContent = texto || '';
    statusEl.className = `text-[11px] ${erro ? 'text-rose-300' : 'text-slate-500'}`;
  }

  function setGateway(online) {
    gatewayEl.textContent = online ? 'Gateway online' : 'Gateway offline';
    gatewayEl.className = online
      ? 'rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300'
      : 'rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300';
  }

  function textoDisponibilidade(modelo) {
    if (modelo.disponivel === true) return 'Disponível no gateway';
    if (modelo.disponivel === false) return 'Não anunciado pelo gateway — faça login nesta conta';
    return 'Disponibilidade não verificada';
  }

  function sincronizarPadrao() {
    // O padrão precisa estar habilitado; se o admin desmarcar, o primeiro marcado assume.
    const marcados = modelos.filter((m) => m.habilitado);
    if (marcados.length && !marcados.some((m) => m.padrao)) {
      modelos.forEach((m) => { m.padrao = false; });
      marcados[0].padrao = true;
    }
    modelos.forEach((m) => { if (!m.habilitado) m.padrao = false; });
  }

  function render() {
    lista.replaceChildren();
    if (!modelos.length) {
      const p = document.createElement('p');
      p.className = 'text-xs text-slate-500';
      p.textContent = 'Nenhum modelo encontrado.';
      lista.appendChild(p);
      return;
    }

    for (const modelo of modelos) {
      const card = document.createElement('div');
      card.className = `claude-model-card ${modelo.habilitado ? 'is-enabled' : ''}`;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.id = `modelo-${modelo.id}`;
      check.checked = modelo.habilitado;
      check.className = 'mt-0.5 h-4 w-4 shrink-0 accent-emerald-500';
      check.addEventListener('change', () => {
        modelo.habilitado = check.checked;
        sincronizarPadrao();
        render();
      });

      const corpo = document.createElement('div');
      corpo.className = 'min-w-0 flex-1';

      const topo = document.createElement('label');
      topo.htmlFor = check.id;
      topo.className = 'flex cursor-pointer flex-wrap items-center gap-2';
      const nome = document.createElement('span');
      nome.className = 'claude-model-title';
      nome.textContent = modelo.nome;
      topo.appendChild(nome);
      const prov = provedores[modelo.provedor];
      if (prov) {
        const badge = document.createElement('span');
        badge.className = `rounded-full border px-1.5 py-px text-[10px] font-medium ${prov.classe}`;
        badge.textContent = prov.rotulo;
        topo.appendChild(badge);
      }

      const id = document.createElement('p');
      id.className = 'claude-model-meta break-all font-mono';
      id.textContent = modelo.id;

      const disp = document.createElement('p');
      disp.className = `claude-model-note ${modelo.disponivel === false ? 'text-amber-300/80' : ''}`;
      disp.textContent = textoDisponibilidade(modelo);

      corpo.append(topo, id, disp);

      const padrao = document.createElement('label');
      padrao.className = `flex shrink-0 items-center gap-1.5 text-[11px] ${
        modelo.habilitado ? 'cursor-pointer text-slate-300' : 'cursor-not-allowed text-slate-600'
      }`;
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'modelo-padrao';
      radio.checked = modelo.padrao;
      radio.disabled = !modelo.habilitado;
      radio.className = 'h-3.5 w-3.5 accent-emerald-500';
      radio.setAttribute('aria-label', `Usar ${modelo.nome} como modelo padrão`);
      radio.addEventListener('change', () => {
        modelos.forEach((m) => { m.padrao = m === modelo; });
        render();
      });
      padrao.append(radio, document.createTextNode('Padrão'));

      card.append(check, corpo, padrao);
      lista.appendChild(card);
    }
  }

  async function pedir(opcoes) {
    const res = await fetch(API, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...opcoes,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Falha na requisição (${res.status})`);
    return data;
  }

  function aplicar(data) {
    modelos = Array.isArray(data.modelos) ? data.modelos : [];
    setGateway(Boolean(data.gatewayOnline));
    render();
  }

  async function carregar() {
    try {
      aplicar(await pedir({ method: 'GET' }));
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  salvarBtn.addEventListener('click', async () => {
    const habilitados = modelos.filter((m) => m.habilitado).map((m) => m.id);
    if (!habilitados.length) {
      setStatus('Marque pelo menos um modelo.', true);
      return;
    }
    salvarBtn.disabled = true;
    setStatus('Salvando…');
    try {
      aplicar(await pedir({
        method: 'PUT',
        body: JSON.stringify({ habilitados, padrao: modelos.find((m) => m.padrao)?.id || null }),
      }));
      setStatus('Modelos salvos. Os editores já podem escolher em Criar matéria.');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      salvarBtn.disabled = false;
    }
  });

  carregar();
})();
