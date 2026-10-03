(function () {
  const secao = document.getElementById('pausa-ia');
  if (!secao) return;

  const API = '/api/admin/claude-gateway/pausa';
  const $ = (id) => document.getElementById(id);
  const el = {
    badge: $('pausa-ia-badge'),
    geral: $('pausa-ia-geral'),
    modelos: $('pausa-ia-modelos'),
    status: $('pausa-ia-status'),
    mensagem: $('pausa-ia-mensagem'),
  };
  let estado = { geral: false, modelos: [], catalogo: [] };
  let salvando = false;

  function setStatus(texto, erro) {
    el.status.textContent = texto || '';
    el.status.className = `mt-3 text-[11px] ${erro ? 'text-rose-300' : 'text-slate-500'}`;
  }

  function render() {
    const pausados = new Set(estado.modelos);
    const algum = estado.geral || pausados.size > 0;
    el.badge.textContent = estado.geral ? 'IA parada' : pausados.size ? `${pausados.size} modelo(s) parado(s)` : 'IA funcionando';
    el.badge.className = `rounded-full border px-2 py-0.5 text-[10px] font-medium ${
      estado.geral
        ? 'border-rose-500/40 bg-rose-500/15 text-rose-200'
        : algum
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    }`;
    el.geral.textContent = estado.geral ? 'Retomar a IA' : 'Parar toda a IA';
    el.geral.className = `d-btn disabled:cursor-not-allowed disabled:opacity-50 ${
      estado.geral ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400' : 'bg-rose-500 text-white hover:bg-rose-400'
    }`;
    el.geral.disabled = salvando;
    if (estado.mensagem) el.mensagem.textContent = `“${estado.mensagem}”`;

    el.modelos.replaceChildren();
    for (const modelo of estado.catalogo) {
      const parado = estado.geral || pausados.has(modelo.id);
      const card = document.createElement('div');
      card.className = `claude-model-card ${parado ? 'is-danger' : ''}`;
      const info = document.createElement('div');
      info.className = 'min-w-0';
      const nome = document.createElement('p');
      nome.className = 'claude-model-title';
      nome.textContent = modelo.nome;
      const detalhe = document.createElement('p');
      detalhe.className = 'claude-model-meta';
      detalhe.textContent = `${modelo.id} · ${modelo.uso}`;
      info.append(nome, detalhe);

      const botao = document.createElement('button');
      botao.type = 'button';
      botao.disabled = salvando || estado.geral;
      botao.className = `shrink-0 rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
        pausados.has(modelo.id)
          ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
          : 'border-rose-500/40 text-rose-300 hover:bg-rose-500/10'
      }`;
      botao.textContent = estado.geral ? 'Parado (geral)' : pausados.has(modelo.id) ? 'Retomar' : 'Pausar';
      botao.setAttribute('aria-pressed', String(pausados.has(modelo.id)));
      botao.setAttribute('aria-label', `${pausados.has(modelo.id) ? 'Retomar' : 'Pausar'} ${modelo.nome}`);
      botao.addEventListener('click', () => {
        const lista = new Set(estado.modelos);
        if (lista.has(modelo.id)) lista.delete(modelo.id);
        else lista.add(modelo.id);
        salvar({ geral: false, modelos: [...lista] }, `${modelo.nome} ${lista.has(modelo.id) ? 'pausado' : 'liberado'}.`);
      });

      card.append(info, botao);
      el.modelos.appendChild(card);
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

  async function salvar(novo, mensagemOk) {
    salvando = true;
    render();
    setStatus('Salvando…');
    try {
      estado = await pedir({ method: 'PUT', body: JSON.stringify(novo) });
      setStatus(`${mensagemOk} Vale em até 10 segundos para todo o sistema.`);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      salvando = false;
      render();
    }
  }

  el.geral.addEventListener('click', () => {
    if (estado.geral) {
      salvar({ geral: false, modelos: estado.modelos }, 'IA retomada.');
      return;
    }
    if (!confirm('Parar TODA a IA?\n\nChat, editor, piloto automático e imagens vão mostrar “Créditos acabaram, por favor compre mais crédito na API.” até você retomar.')) return;
    salvar({ geral: true, modelos: estado.modelos }, 'Toda a IA foi parada.');
  });

  pedir({ method: 'GET' })
    .then((data) => {
      estado = data;
      render();
    })
    .catch((err) => setStatus(err.message, true));
})();
