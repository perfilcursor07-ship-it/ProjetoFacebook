(function () {
  const secao = document.getElementById('modelos-tarefa');
  if (!secao) return;

  const API = '/api/admin/claude-gateway/modelos-tarefa';
  const lista = document.getElementById('modelos-tarefa-lista');
  const statusEl = document.getElementById('modelos-tarefa-status');
  const salvarBtn = document.getElementById('modelos-tarefa-salvar');
  let estado = { tarefas: [], escolhas: {}, modelos: [] };

  function setStatus(texto, erro) {
    statusEl.textContent = texto || '';
    statusEl.className = `text-[11px] ${erro ? 'text-rose-300' : 'text-slate-500'}`;
  }

  function render() {
    lista.replaceChildren();
    for (const tarefa of estado.tarefas) {
      const campo = document.createElement('div');
      campo.className = 'claude-task-field';
      const rotulo = document.createElement('label');
      rotulo.htmlFor = `modelo-tarefa-${tarefa.id}`;
      rotulo.textContent = tarefa.nome;

      const select = document.createElement('select');
      select.id = `modelo-tarefa-${tarefa.id}`;
      select.dataset.tarefa = tarefa.id;

      const padrao = document.createElement('option');
      padrao.value = '';
      padrao.textContent = 'Seguir o editor (sem modelo fixo)';
      select.appendChild(padrao);

      const atual = estado.escolhas[tarefa.id] || '';
      for (const modelo of estado.modelos) {
        const opcao = document.createElement('option');
        opcao.value = modelo.id;
        opcao.textContent = modelo.disponivel === false ? `${modelo.nome} (sem login no gateway)` : modelo.nome;
        select.appendChild(opcao);
      }
      // Modelo salvo que saiu do catálogo continua visível até o admin trocar.
      if (atual && !estado.modelos.some((m) => m.id === atual)) {
        const opcao = document.createElement('option');
        opcao.value = atual;
        opcao.textContent = `${atual} (fora do catálogo)`;
        select.appendChild(opcao);
      }
      select.value = atual;

      campo.append(rotulo, select);
      lista.appendChild(campo);
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
    estado = {
      tarefas: Array.isArray(data.tarefas) ? data.tarefas : [],
      escolhas: data.escolhas || {},
      modelos: Array.isArray(data.modelos) ? data.modelos : [],
    };
    render();
  }

  salvarBtn.addEventListener('click', async () => {
    const escolhas = {};
    lista.querySelectorAll('select[data-tarefa]').forEach((select) => {
      escolhas[select.dataset.tarefa] = select.value || null;
    });
    salvarBtn.disabled = true;
    setStatus('Salvando…');
    try {
      aplicar(await pedir({ method: 'PUT', body: JSON.stringify({ escolhas }) }));
      setStatus('Salvo. Vale em até 15 segundos para todo o sistema.');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      salvarBtn.disabled = false;
    }
  });

  pedir({ method: 'GET' })
    .then(aplicar)
    .catch((err) => setStatus(err.message, true));
})();
