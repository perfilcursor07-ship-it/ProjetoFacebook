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
