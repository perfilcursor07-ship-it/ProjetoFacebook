const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const IA = fs.readFileSync('src/services/materiaIaService.js', 'utf8');
const SERVER = fs.readFileSync('src/server.js', 'utf8');
const AGENDA = fs.readFileSync('src/services/bibliotecaAgendaService.js', 'utf8');
const DOTS = fs.readFileSync('src/services/dotsService.js', 'utf8');

// ── A fila não pode ficar atrás da varredura ────────────────────────────────

test('cada etapa do tick tem o seu próprio try, e a fila vem primeiro', () => {
  // tickMonitores e tickFilaJobs dividiam o mesmo try e a mesma espera:
  // monitor lento (varredura + IA) ou que estourasse levava embora a
  // publicação das agendadas daquele minuto, sem erro algum na matéria.
  assert.match(SERVER, /const etapas = \[/);
  const etapas = SERVER.slice(SERVER.indexOf('const etapas = ['), SERVER.indexOf('const tick = async'));
  const nomes = [...etapas.matchAll(/\['([a-z-]+)',/g)].map((m) => m[1]);
  assert.equal(nomes[0], 'fila-agendadas', 'publicar na hora marcada vem antes de tudo');
  assert.ok(nomes.includes('monitores'));
  assert.ok(nomes.includes('dots'));
  assert.ok(nomes.indexOf('monitores') > nomes.indexOf('fila-agendadas'));

  assert.match(
    SERVER,
    /for \(const \[nome, executar\] of etapas\) \{\s*\n\s*try \{\s*\n\s*await executar\(\);\s*\n\s*\} catch \(err\) \{/,
    'uma etapa que falha não pode derrubar as seguintes'
  );
  assert.doesNotMatch(
    SERVER,
    /await materiaIaService\.tickMonitores\(\);\s*\n\s*await materiaIaService\.tickFilaJobs\(\);/,
    'as duas no mesmo try era o problema'
  );
});

// ── Foto sem imagem não derruba mais a agendada ─────────────────────────────

test('matéria foto sem capa tenta recuperar antes de desistir', () => {
  assert.match(IA, /async function recuperarCapaParaPublicar\(userId, matter\)/);
  // Primeiro a foto de origem que a matéria já tem; depois a foto do link.
  assert.match(IA, /montar\(fonte, 'foto de origem'\)/);
  assert.match(IA, /montar\(foto, 'foto do link da notícia'\)/);
  assert.match(IA, /extrairMetadadosImagemArtigo\(link\)/);
  // Arte montada não serve de foto de origem (sairia a arte dentro da arte).
  assert.match(IA, /const ehArte = \(v\) => \/\\\/media\\\/artes\\\/\/i\.test/);
});

test('sem capa nenhuma a matéria publica como texto, não volta a rascunho', () => {
  // Era a queda silenciosa: status virava 'rascunho' e o editor só via o
  // agendamento desaparecer. "Tem que publicar".
  assert.doesNotMatch(
    IA,
    /error_message: 'Foto sem imagem — salva como rascunho'/,
    'esse caminho derrubava toda agendada sem capa'
  );
  assert.match(IA, /tipo = 'texto';/);
  assert.match(IA, /sem capa e sem foto para recuperar — publicando como texto/);
  assert.match(IA, /error_message: 'Sem foto disponível: publicada como texto\.'/);
});

test('a capa é resolvida antes de montar a mensagem', () => {
  // Virar texto depois de montar deixaria o post sem o título: em foto o
  // título vai na arte e `incluirTitulo` é false.
  const corte = IA.indexOf('const mensagem = montarMensagem({');
  const recupera = IA.indexOf('const recuperada = await recuperarCapaParaPublicar(');
  assert.ok(recupera > 0 && recupera < corte, 'a recuperação tem de vir antes de montarMensagem');
  assert.match(IA, /let tipo =\s*\n?\s*matter\.tipo_publicacao === 'reel'/, 'tipo precisa poder mudar');
});

test('Reel continua barrado sem vídeo (não virou texto por engano)', () => {
  assert.match(IA, /if \(tipo === 'reel' && !matter\.video_path && !matter\.video_clip_id\)/);
  assert.match(IA, /Vídeo do Reel ainda não está pronto/);
});

// ── Pré-agenda da Biblioteca não desmarca o que já foi agendado ─────────────

test('confirmar pré-agenda alcança a proposta ligada só pelo post', () => {
  // Proposta com matter_id nulo passava batida: ao sincronizar, ela recebia o
  // matter_id ainda 'pendente' e derrubava a agendada para 'pronto'.
  assert.match(IA, /const temPosts = await db\.schema\.hasTable\('biblioteca_posts'\)/);
  assert.match(IA, /orWhereIn\('post_id', db\('biblioteca_posts'\)\.where\(\{ matter_id: matterId \}\)/);
  assert.match(IA, /matter_id: matterId,\s*\n\s*status: 'confirmado',/);
  // Sem a tabela da Biblioteca, confirma só pelo matter_id em vez de quebrar.
  assert.match(IA, /if \(temPosts\) \{/);
});

test('proposta que adota matéria já agendada confirma em vez de desmarcar', () => {
  assert.match(AGENDA, /let adotouAgora = false;/);
  assert.match(AGENDA, /adotouAgora = true;/);
  assert.match(
    AGENDA,
    /if \(matterSt === 'agendado' && agendaSt === 'pendente' && adotouAgora\) \{/,
    'quem acabou de adotar a matéria não foi quem a agendou'
  );
  // A regra original continua valendo para a proposta que já era da matéria.
  assert.match(AGENDA, /\} else if \(matterSt === 'agendado' && agendaSt === 'pendente'\) \{/);
  assert.match(AGENDA, /Agenda pré-agendada — só agenda ao Confirmar/);
});

test('desmarcar deixa rastro no log', () => {
  // Antes era mudo: a matéria saía do agendado e não havia o que procurar.
  assert.match(AGENDA, /DESMARCADA — proposta #\$\{row\.id\} da Biblioteca está pendente/);
});

// ── Dots ────────────────────────────────────────────────────────────────────

test('dot em "publica sem imagem" marca a matéria como texto', () => {
  // A matéria nasce 'foto' no chat; sem imagem ela era recusada na publicação.
  const trecho = DOTS.slice(DOTS.indexOf('async function resolverCapa'));
  assert.match(trecho.slice(0, 800), /if \(modo === 'sem_imagem'\) \{/);
  assert.match(trecho.slice(0, 800), /tipo_publicacao: 'texto'/);
});

test('o dot continua criando o job da fila ao agendar', () => {
  // Só mexer em ai_matters não publica nada.
  const trecho = DOTS.slice(DOTS.indexOf('async function agendarSaida'));
  assert.match(trecho.slice(0, 2000), /status: 'agendado',/);
  assert.match(trecho.slice(0, 2000), /db\('ai_fila_jobs'\)\.where\(\{ matter_id: matterId, status: 'pendente' \}\)/);
  assert.match(trecho.slice(0, 2000), /sincronizarAgendamentoDaMateria\(dot\.user_id, matterId, quando\)/);
});
