const test = require('node:test');
const assert = require('node:assert/strict');

const modulos = require('../src/services/modulosMateriaService');
const Users = require('../src/models/Users');

const TODOS = modulos.MODULOS.map((m) => m.id);

test('lista vazia salva é respeitada, não vira "tudo liberado"', () => {
  // `sanear` grava "[]" quando o admin desmarca tudo. Se isso fosse confundido
  // com "nunca configurado", o usuário voltaria a ver todos os módulos.
  const vazio = modulos.sanear([]);
  assert.equal(vazio, '[]');

  const semNada = { nivel_acesso: 'usuario', modulos_materia: vazio };
  assert.deepEqual(modulos.permitidos(semNada), []);
  assert.equal(modulos.podeAcessar(semNada, 'chat-materia'), false);
});

test('coluna nunca configurada libera tudo (não tira acesso de quem já usava)', () => {
  for (const bruto of [null, undefined, '']) {
    assert.deepEqual(
      modulos.permitidos({ nivel_acesso: 'usuario', modulos_materia: bruto }),
      TODOS,
      `valor ${JSON.stringify(bruto)} deveria liberar tudo`
    );
  }
});

test('subconjunto salvo volta exatamente igual', () => {
  const salvo = modulos.sanear(['furos', 'dots', 'inexistente']);
  const usuario = { nivel_acesso: 'usuario', modulos_materia: salvo };
  assert.deepEqual(modulos.permitidos(usuario), ['furos', 'dots']);
  assert.equal(modulos.podeAcessar(usuario, 'furos'), true);
  assert.equal(modulos.podeAcessar(usuario, 'piloto'), false);
});

test('administrador acessa tudo mesmo com lista vazia salva', () => {
  const admin = { nivel_acesso: 'administrador', modulos_materia: '[]' };
  assert.deepEqual(modulos.permitidos(admin), TODOS);
  assert.equal(modulos.podeAcessar(admin, 'piloto'), true);
});

test('Users.list() seleciona modulos_materia', () => {
  // Esta era a causa do bug: a tela de permissões lia o usuário por `list()`,
  // que não trazia a coluna. Sem o campo, `permitidos()` entendia "nunca
  // configurado" e remarcava todos os checkboxes a cada salvamento.
  const sql = Users.list().toSQL().sql;
  assert.match(sql, /modulos_materia/, 'a coluna não pode sair do select de novo');
});

test('Users.list() também traz a página padrão usada na tela de permissões', () => {
  const sql = Users.list().toSQL().sql;
  assert.match(sql, /default_facebook_page_id/);
});
