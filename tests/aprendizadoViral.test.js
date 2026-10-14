const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const viral = require('../src/services/aprendizadoViralService');

const DOTS = fs.readFileSync('src/services/dotsService.js', 'utf8');
const ROTA = fs.readFileSync('src/routes/dots.js', 'utf8');
const TELA = fs.readFileSync('public/js/dots.js', 'utf8');
const VIEW = fs.readFileSync('public/views/dots.ejs', 'utf8');
const MIG = fs.readFileSync('src/migrations/20261013100000_aprendizado_viral.js', 'utf8');

test('a receita descreve forma, nunca assunto', () => {
  // Receita que fixa tema faria o dot reescrever a mesma notícia para sempre.
  const fonte = fs.readFileSync('src/services/aprendizadoViralService.js', 'utf8');
  const sistema = fonte.slice(fonte.indexOf('const SISTEMA = ['), fonte.indexOf('function montarMensagens'));
  assert.match(sistema, /FORMA/);
  assert.match(sistema, /Nada de assunto/);
  assert.match(sistema, /aplicável a QUALQUER pauta/);
  assert.match(sistema, /devolva regras: \[\]/, 'sem padrão, não inventa regra');
});

test('o trecho do prompt avisa que a regra não vence a fonte', () => {
  const texto = viral.receitaParaPrompt({ regras: ['Use número no título.'] });
  assert.match(texto, /aprendido do desempenho real/);
  assert.match(texto, /- Use número no título\./);
  assert.match(texto, /não autorizam inventar fato/);
  assert.match(texto, /seja fiel/);
});

test('sem regra, nada entra no prompt', () => {
  assert.equal(viral.receitaParaPrompt(null), null);
  assert.equal(viral.receitaParaPrompt({ regras: [] }), null);
  assert.equal(viral.receitaParaPrompt({}), null);
});

test('a resposta da IA é lida com desconfiança', () => {
  const { regras, resumo } = viral.lerRegras(
    JSON.stringify({
      regras: ['- Use nome próprio no título', 'x', '  ', 'Abra com o fato concreto', 1, null],
      resumo: 'direto ao ponto',
    })
  );
  assert.deepEqual(regras, ['Use nome próprio no título', 'Abra com o fato concreto'], 'marcador e lixo saem');
  assert.equal(resumo, 'direto ao ponto');

  // Resposta que não é JSON não pode derrubar a escrita.
  assert.deepEqual(viral.lerRegras('isto não é json'), { regras: [], resumo: '' });
  assert.deepEqual(viral.lerRegras(''), { regras: [], resumo: '' });
  assert.deepEqual(viral.lerRegras(null), { regras: [], resumo: '' });
});

test('no máximo 6 regras — receita longa ninguém segue', () => {
  const muitas = Array.from({ length: 20 }, (_, i) => `Regra número ${i} bem comprida aqui`);
  assert.equal(viral.lerRegras(JSON.stringify({ regras: muitas })).regras.length, 6);
});

test('a abertura usada na análise é o 1º parágrafo, não o título', () => {
  const materia = 'Pastor é preso em SP\n\nO pastor foi detido na manhã desta terça-feira após denúncia da vizinhança.\n\nSegundo a polícia…';
  assert.match(viral.aberturaDaMateria(materia, 'Pastor é preso em SP'), /^O pastor foi detido/);
  // Sem corpo, não quebra.
  assert.equal(viral.aberturaDaMateria('', 'T'), '');
  assert.equal(viral.aberturaDaMateria(null, null), '');
});

test('a validade tem piso e a amostra tem mínimo', () => {
  // Abaixo do mínimo não há padrão, há coincidência.
  assert.ok(viral.MINIMO_MATERIAS >= 3, 'mínimo razoável');
  assert.ok(viral.DIAS_PADRAO >= 7 && viral.DIAS_PADRAO <= 180);
  assert.ok(viral.VALIDADE_MS >= 3_600_000);

  assert.equal(viral.receitaVencida(null), true);
  assert.equal(viral.receitaVencida({ geradoEm: null }), true);
  assert.equal(viral.receitaVencida({ geradoEm: 'não é data' }), true);
  assert.equal(viral.receitaVencida({ geradoEm: new Date() }), false);
  assert.equal(viral.receitaVencida({ geradoEm: new Date(Date.now() - viral.VALIDADE_MS - 1000) }), true);
});

test('o score é o mesmo do resto do sistema', () => {
  // "Bombou" tem de querer dizer a mesma coisa aqui e na aba Viralizou.
  const fonte = fs.readFileSync('src/services/aprendizadoViralService.js', 'utf8');
  const modelo = fs.readFileSync('src/models/AiMatters.js', 'utf8');
  for (const parte of ['fb_comments, 0) * 3', 'fb_shares, 0) * 5', 'fb_views, 0), 5000) / 50']) {
    assert.ok(fonte.includes(parte), `score: ${parte}`);
    assert.ok(modelo.includes(parte), `modelo: ${parte}`);
  }
});

test('uma receita por página', () => {
  // Públicos diferentes, receitas diferentes: misturar ensina a média de ninguém.
  assert.match(MIG, /table\.unique\(\['user_id', 'facebook_page_id'\], 'aprendizado_viral_user_page_uq'\)/);
  assert.match(MIG, /table\.text\('amostra'\)/, 'a amostra fica guardada para conferência');
});

test('a opção nasce desligada', () => {
  // Ligar sozinho mudaria a voz de páginas já em produção.
  assert.match(MIG, /table\.boolean\('usar_estilo_viral'\)\.notNullable\(\)\.defaultTo\(false\)/);
  assert.match(DOTS, /usar_estilo_viral: Boolean\(entrada\.usar_estilo_viral \?\? entrada\.usarEstiloViral\)/);
});

test('o pedido do editor vem antes da receita', () => {
  // Aprendizado inferido não passa por cima de ordem direta.
  const trecho = DOTS.slice(DOTS.indexOf('async function instrucaoDeEscrita'));
  assert.match(trecho.slice(0, 1200), /if \(!dot\.usar_estilo_viral\) return doEditor \|\| null;/);
  assert.match(trecho.slice(0, 1200), /\[doEditor, trecho\]\.filter\(Boolean\)\.join/);
});

test('falha no aprendizado não derruba a escrita da matéria', () => {
  const trecho = DOTS.slice(DOTS.indexOf('async function instrucaoDeEscrita'));
  assert.match(trecho.slice(0, 1200), /\} catch \(err\) \{/);
  assert.match(trecho.slice(0, 1200), /return doEditor \|\| null;/);
  assert.match(trecho.slice(0, 1200), /receita do que bomba/);
});

test('a instrução é resolvida antes do callback síncrono', () => {
  // `comProvedor(..., () => ...)` não é async: await lá dentro é erro de sintaxe.
  assert.match(DOTS, /const instrucaoEditorial = await instrucaoDeEscrita\(dot\);/);
  assert.match(DOTS, /^\s+instrucaoEditorial,$/m);
});

test('a caixa ausente no PATCH não desmarca a escolha', () => {
  assert.match(ROTA, /if \(campo === 'usar_estilo_viral'\) return body\.usar_estilo_viral !== undefined;/);
  assert.match(ROTA, /usar_estilo_viral: body\.usar_estilo_viral === true,/);
});

test('a tela mostra a receita e deixa refazer', () => {
  assert.match(VIEW, /id="dot-estilo-viral"/);
  assert.match(VIEW, /id="dot-estilo-viral-receita"/);
  assert.match(TELA, /async function mostrarReceitaViral\(dotId\)/);
  assert.match(TELA, /estilo-viral\/refazer/);
  assert.match(TELA, /usar_estilo_viral: Boolean\(el\.estiloViral\?\.checked\)/);
  assert.match(ROTA, /router\.get\('\/:id\/estilo-viral'/);
  assert.match(ROTA, /router\.post\('\/:id\/estilo-viral\/refazer'/);
});

test('ver a receita exige ser o dono do dot', () => {
  const trecho = DOTS.slice(DOTS.indexOf('async function dotDoEditor'));
  assert.match(trecho.slice(0, 400), /where\(\{ id: dotId, user_id: userId \}\)/);
  assert.match(DOTS, /async function estiloViralDoDot\(userId, dotId\) \{\s*\n\s*const dot = await dotDoEditor\(userId, dotId\)/);
  assert.match(DOTS, /async function refazerEstiloViral\(userId, dotId\) \{\s*\n\s*const dot = await dotDoEditor\(userId, dotId\)/);
});

test('tentativa recente sem regra não refaz a análise a cada matéria', () => {
  // Página sem histórico gravava "ainda não há matérias suficientes" com
  // gerado_em. Sem respeitar isso, cada matéria escrita pediria uma análise
  // nova à IA, de graça.
  const fonte = fs.readFileSync('src/services/aprendizadoViralService.js', 'utf8');
  const trecho = fonte.slice(fonte.indexOf('async function receitaParaEscrever'));
  assert.match(trecho.slice(0, 900), /if \(guardada && !receitaVencida\(guardada\)\) \{/);
  assert.match(trecho.slice(0, 900), /return guardada\.regras\.length \? guardada : null;/);
  // E os dois caminhos de "não deu" gravam a data, senão a saída acima nunca
  // seria alcançada.
  const gerar = fonte.slice(fonte.indexOf('async function gerarReceita'));
  const semMaterias = gerar.indexOf('Preciso de ${MINIMO_MATERIAS}');
  const semPadrao = gerar.indexOf('não achou padrão de forma');
  for (const [rotulo, pos] of [['sem matérias', semMaterias], ['sem padrão', semPadrao]]) {
    assert.ok(pos > 0, `${rotulo}: caminho esperado`);
    assert.match(gerar.slice(pos, pos + 320), /gerado_em: new Date\(\)/, rotulo);
  }
});
