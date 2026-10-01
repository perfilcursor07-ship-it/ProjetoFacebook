const test = require('node:test');
const assert = require('node:assert/strict');

const limiter = require('../src/services/googleNewsLimiter');

test('HTTP 503 pausa as consultas e barra as próximas sem chamar o Google', async () => {
  limiter.reiniciar();
  let chamadas = 0;
  await limiter.executar(async () => {
    chamadas += 1;
  });
  assert.equal(chamadas, 1);
  assert.equal(limiter.emPausa(), false);

  // É assim que o axios reporta o 503 que o Google News devolve na rajada.
  const erro503 = Object.assign(new Error('Request failed with status code 503'), {
    response: { status: 503 },
  });
  assert.equal(limiter.registrarFalha(erro503), true);
  assert.equal(limiter.emPausa(), true);

  await assert.rejects(
    limiter.executar(async () => {
      chamadas += 1;
    }),
    (err) => err.code === 'GOOGLE_NEWS_EM_PAUSA' && /em pausa até/.test(err.message)
  );
  assert.equal(chamadas, 1, 'a tarefa não deve rodar durante a pausa');

  // A própria mensagem de pausa não conta como novo bloqueio.
  assert.equal(limiter.tipoDeBloqueio(limiter.erroDePausa()), null);
  limiter.reiniciar();
});

test('o 503 vindo da tarefa pausa sozinho, sem precisar de registrarFalha', async () => {
  limiter.reiniciar();
  const erro503 = Object.assign(new Error('Request failed with status code 503'), {
    response: { status: 503 },
  });

  await assert.rejects(limiter.executar(async () => {
    throw erro503;
  }));
  assert.equal(limiter.emPausa(), true);
  assert.equal(limiter.estado().motivo, 'HTTP 503, requisições demais');
  limiter.reiniciar();
});

test('erros comuns não são tratados como bloqueio', () => {
  limiter.reiniciar();
  assert.equal(limiter.tipoDeBloqueio(new Error('timeout of 15000ms exceeded')), null);
  assert.equal(limiter.tipoDeBloqueio(new Error('getaddrinfo ENOTFOUND')), null);
  assert.equal(limiter.tipoDeBloqueio(new Error('Request failed with status code 404')), null);
  assert.equal(limiter.tipoDeBloqueio(new Error('Request failed with status code 503')), '503');
  assert.equal(limiter.tipoDeBloqueio(new Error('Request failed with status code 429')), '429');
  assert.equal(limiter.registrarFalha(new Error('timeout')), false);
  assert.equal(limiter.emPausa(), false);
});

test('respeita o teto de chamadas simultâneas em vez de disparar a rajada toda', async () => {
  limiter.reiniciar();
  const teto = limiter.LIMITE_PARALELO;
  let emVoo = 0;
  let pico = 0;

  // 48 é a rajada que o radar monta: 12 temas x 2 consultas x 2 coletores.
  const tarefas = Array.from({ length: 48 }, () =>
    limiter.executar(async () => {
      emVoo += 1;
      pico = Math.max(pico, emVoo);
      await new Promise((resolve) => setTimeout(resolve, 5));
      emVoo -= 1;
    })
  );

  await Promise.all(tarefas);
  assert.equal(pico <= teto, true, `pico ${pico} passou do teto ${teto}`);
  assert.equal(limiter.estado().ativos, 0, 'nenhuma vaga deve ficar presa');
  assert.equal(limiter.estado().naFila, 0);
  limiter.reiniciar();
});

test('a rajada inteira falhando não escala a pausa para o teto', async () => {
  limiter.reiniciar();
  const erro503 = () =>
    Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } });

  // As 48 falhas chegam quase juntas. Se cada uma dobrasse a pausa, o primeiro
  // tropeço já jogaria o servidor nos 30 min de teto.
  assert.equal(limiter.registrarFalha(erro503()), true);
  const primeiraPausa = new Date(limiter.estado().ate).getTime();

  for (let i = 0; i < 47; i += 1) {
    assert.equal(limiter.registrarFalha(erro503()), true);
  }
  const depoisDaRajada = new Date(limiter.estado().ate).getTime();

  assert.equal(depoisDaRajada, primeiraPausa, 'as falhas seguintes não devem esticar a pausa');
  const minutos = Math.round((depoisDaRajada - Date.now()) / 60_000);
  assert.ok(minutos <= 6, `pausa de ${minutos} min deveria ficar na base de 5 min`);
  limiter.reiniciar();
});

test('ehBloqueio reconhece tanto a pausa quanto o 503 cru', () => {
  limiter.reiniciar();
  assert.equal(limiter.ehBloqueio(new Error('Request failed with status code 503')), true);
  assert.equal(limiter.ehBloqueio(new Error('Request failed with status code 429')), true);
  assert.equal(limiter.ehBloqueio(new Error('timeout')), false);

  limiter.registrarFalha(Object.assign(new Error('503'), { response: { status: 503 } }));
  assert.equal(limiter.ehBloqueio(limiter.erroDePausa()), true);
  limiter.reiniciar();
});

/** Avança o relógio para a pausa parecer vencida, sem esperar os 5 min. */
function comRelogioAdiantado(minutos, fn) {
  const real = Date.now;
  Date.now = () => real() + minutos * 60_000;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test('pausa vencida libera UMA sonda, não a rajada inteira', async () => {
  limiter.reiniciar();
  limiter.registrarFalha(
    Object.assign(new Error('503'), { response: { status: 503 } })
  );
  assert.equal(limiter.emPausa(), true);

  await comRelogioAdiantado(10, async () => {
    assert.equal(limiter.emPausa(), false, 'a pausa deve ter vencido');

    let chamadasAoGoogle = 0;
    let recusadas = 0;
    // A sonda segura o Google por um instante, então as outras 47 chegam
    // enquanto ela está em voo — que é o caso real da rajada.
    const tarefas = Array.from({ length: 48 }, () =>
      limiter
        .executar(async () => {
          chamadasAoGoogle += 1;
          await new Promise((r) => setTimeout(r, 20));
          return 'ok';
        })
        .catch((err) => {
          recusadas += 1;
          return err.code;
        })
    );

    const saida = await Promise.all(tarefas);
    assert.equal(chamadasAoGoogle, 1, 'só a sonda deve falar com o Google');
    assert.equal(recusadas, 47);
    assert.equal(
      saida.filter((s) => s === 'GOOGLE_NEWS_EM_SONDAGEM').length,
      47,
      'as demais devem ser recusadas como sondagem em andamento'
    );
    // A sonda passou: o circuito fecha e o radar volta ao normal.
    assert.equal(limiter.estado().testando, false);
    assert.equal(limiter.estado().pausado, false);
  });
  limiter.reiniciar();
});

test('sonda que falha repausa e não deixa o resto da rajada escapar', async () => {
  limiter.reiniciar();
  limiter.registrarFalha(
    Object.assign(new Error('503'), { response: { status: 503 } })
  );

  await comRelogioAdiantado(10, async () => {
    let chamadasAoGoogle = 0;
    const tarefas = Array.from({ length: 48 }, () =>
      limiter
        .executar(async () => {
          chamadasAoGoogle += 1;
          await new Promise((r) => setTimeout(r, 20));
          throw Object.assign(new Error('Request failed with status code 503'), {
            response: { status: 503 },
          });
        })
        .catch((err) => err.code || 'erro')
    );

    await Promise.all(tarefas);
    assert.equal(chamadasAoGoogle, 1, 'uma sonda por ciclo, mesmo falhando');
    assert.equal(limiter.emPausa(), true, 'a sonda falhou: volta para a pausa');
  });
  limiter.reiniciar();
});

test('a sondagem não conta como bloqueio novo, mas é bloqueio para quem chama', () => {
  limiter.reiniciar();
  const erro = limiter.erroDeSondagem();
  assert.equal(limiter.tipoDeBloqueio(erro), null, 'não deve escalar a pausa');
  assert.equal(limiter.ehBloqueio(erro), true, 'deve impedir a cascata do Python');
  assert.equal(limiter.registrarFalha(erro), false);
  limiter.reiniciar();
});
