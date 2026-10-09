const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const FONTE = fs.readFileSync('src/services/materiaIaService.js', 'utf8');

test('agendar pela tela confirma a pré-agenda', () => {
  // A fila recusa publicar com proposta `pendente` ("só publica depois de
  // Confirmar"). O botão Agendar não mexia nessa linha, então uma proposta
  // antiga esquecida derrubava o agendamento feito à mão.
  assert.match(FONTE, /async function confirmarPreAgenda\(matterId, quando\)/);
  assert.match(FONTE, /status: 'confirmado',/);
  assert.match(
    FONTE,
    /whereNotIn\('status', \['cancelado', 'publicado'\]\)/,
    'não reabre o que já saiu nem o que foi cancelado'
  );
});

test('os dois caminhos de agendamento confirmam', () => {
  // Agendar uma matéria e agendar em lote passam por códigos diferentes;
  // corrigir só um deixaria metade do problema de pé.
  const chamadas = (FONTE.match(/await confirmarPreAgenda\(/g) || []).length;
  assert.equal(chamadas, 2, `esperava 2 chamadas, achei ${chamadas}`);
  assert.match(FONTE, /scheduled_at: slotLivre \}\);\s*\n\s*await confirmarPreAgenda\(matter\.id, slotLivre\)/);
  assert.match(FONTE, /scheduled_at: quando \}\);\s*\n\s*await confirmarPreAgenda\(id, quando\)/);
});

test('falha passageira adia em vez de desmarcar', () => {
  // Antes, qualquer erro de banco na checagem virava bloqueio definitivo:
  // status 'pronto', scheduled_at nulo e job cancelado.
  assert.match(FONTE, /adiar: true, motivo: `falha ao checar agenda/);
  assert.match(
    FONTE,
    /if \(!check\.ok && check\.adiar\) \{[\s\S]{0,180}status: 'pendente'/,
    'o job volta para pendente e tenta no próximo tick'
  );
  assert.match(
    FONTE,
    /if \(!check\.adiar\) await bloquearPreAgendada/,
    'o fallback também não pode desmarcar por falha passageira'
  );
});

test('a recusa definitiva continua recusando', () => {
  // A guarda existe por um motivo: proposta que a Biblioteca criou sozinha
  // não pode publicar sem o editor confirmar.
  assert.match(FONTE, /só publica depois de Confirmar/);
  assert.match(FONTE, /await bloquearPreAgendada\(matter, check\.motivo\)/);
});

test('o bloqueio registra o motivo para a tela poder mostrar', () => {
  assert.match(FONTE, /\[fila\] BLOQUEADO matéria #\$\{matter\.id\}/);
  assert.match(FONTE, /erro: String\(motivo\)\.slice\(0, 500\)/);
});
