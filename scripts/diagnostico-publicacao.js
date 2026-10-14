#!/usr/bin/env node
/**
 * Dá para publicar? O que falta em cada página e em cada canal.
 *
 * "Resolver a questão da página/do canal para começarmos a postar" é uma
 * conversa que trava por não existir uma lista do que está faltando. Este
 * script faz essa lista, sem publicar nada e sem alterar nada.
 *
 * Confere, por página: credencial, provedor de envio, Instagram, página
 * padrão e se já saiu publicação por ali. E, por canal/fonte monitorada: se a
 * última leitura funcionou.
 *
 *   node scripts/diagnostico-publicacao.js
 */
require('dotenv').config();

const db = require('../src/config/db');

const OK = '  ok ';
const FALTA = 'FALTA';
const AVISO = 'aviso';

function linha(estado, texto) {
  console.log(`   [${estado}] ${texto}`);
}

async function existeTabela(nome) {
  try {
    return await db.schema.hasTable(nome);
  } catch {
    return false;
  }
}

async function paginas() {
  console.log('\n=== PÁGINAS (para onde a matéria vai) ===');
  if (!(await existeTabela('facebook_pages'))) {
    console.log('   tabela facebook_pages não existe.');
    return;
  }

  const temAyrshare = await db.schema.hasColumn('facebook_pages', 'ayrshare_profile_key').catch(() => false);
  const colunas = ['id', 'page_id', 'page_name', 'page_access_token'];
  if (temAyrshare) colunas.push('ayrshare_profile_key');

  const lista = await db('facebook_pages').select(colunas).orderBy('id', 'asc').limit(50);
  if (!lista.length) {
    console.log('   Nenhuma página cadastrada. Conecte uma em /paginas.');
    return;
  }

  const provedor = String(process.env.PUBLISH_PROVIDER || 'graph').toLowerCase();
  console.log(`   Provedor de envio configurado: ${provedor}\n`);

  for (const p of lista) {
    console.log(`  #${p.id} ${p.page_name} (page_id ${p.page_id})`);

    const token = String(p.page_access_token || '').trim();
    linha(token ? OK : FALTA, token ? 'token da Página gravado' : 'sem token da Página — reconecte em /paginas');

    if (temAyrshare) {
      const chave = String(p.ayrshare_profile_key || '').trim();
      if (provedor === 'ayrshare') {
        linha(chave ? OK : FALTA, chave ? 'Profile Key do Ayrshare' : 'sem Profile Key — o envio por Ayrshare falha');
      } else {
        linha(chave ? OK : AVISO, chave ? 'Profile Key do Ayrshare' : 'sem Profile Key (só faz falta se trocar o provedor)');
      }
    }

    const [{ total: publicadas = 0 } = {}] = await db('ai_matters')
      .where({ facebook_page_id: p.id, status: 'publicado' })
      .count({ total: '*' })
      .catch(() => [{ total: 0 }]);
    linha(
      Number(publicadas) > 0 ? OK : AVISO,
      `${publicadas} matéria(s) já publicada(s) por esta página`
    );

    const [{ total: agendadas = 0 } = {}] = await db('ai_matters')
      .where({ facebook_page_id: p.id, status: 'agendado' })
      .count({ total: '*' })
      .catch(() => [{ total: 0 }]);
    if (Number(agendadas)) linha(OK, `${agendadas} agendada(s) esperando a hora`);

    const ultimoErro = await db('ai_matters')
      .where({ facebook_page_id: p.id })
      .whereNotNull('error_message')
      .orderBy('updated_at', 'desc')
      .first('id', 'error_message')
      .catch(() => null);
    if (ultimoErro) {
      linha(AVISO, `último erro (matéria #${ultimoErro.id}): ${String(ultimoErro.error_message).slice(0, 110)}`);
    }
    console.log('');
  }
}

async function canais() {
  console.log('\n=== CANAIS E FONTES (de onde a matéria vem) ===');
  if (!(await existeTabela('biblioteca_fontes'))) {
    console.log('   tabela biblioteca_fontes não existe.');
    return;
  }

  const lista = await db('biblioteca_fontes')
    .where({ monitorar: true })
    .select('id', 'nome', 'plataforma', 'url', 'ultimo_scan', 'ultimo_erro')
    .orderBy('plataforma', 'asc')
    .limit(200);

  if (!lista.length) {
    console.log('   Nenhuma fonte monitorada.');
    return;
  }

  const porPlataforma = new Map();
  for (const f of lista) {
    const chave = f.plataforma || 'outro';
    if (!porPlataforma.has(chave)) porPlataforma.set(chave, { total: 0, comErro: 0, exemplos: [] });
    const g = porPlataforma.get(chave);
    g.total += 1;
    if (f.ultimo_erro) {
      g.comErro += 1;
      if (g.exemplos.length < 2) g.exemplos.push(`${f.nome}: ${String(f.ultimo_erro).slice(0, 90)}`);
    }
  }

  for (const [plataforma, g] of [...porPlataforma.entries()].sort()) {
    const saudavel = g.total - g.comErro;
    const estado = g.comErro === 0 ? OK : g.comErro === g.total ? FALTA : AVISO;
    linha(estado, `${plataforma}: ${saudavel}/${g.total} lendo bem`);
    for (const ex of g.exemplos) console.log(`          ${ex}`);
  }

  const mortas = [...porPlataforma.entries()].filter(([, g]) => g.comErro === g.total);
  if (mortas.length) {
    console.log(
      `\n   ${mortas.map(([p]) => p).join(', ')}: TODAS as fontes falhando.` +
        '\n   Em Facebook e Instagram isso quase sempre é a sessão expirada —' +
        '\n   reexporte os cookies em /cookies.'
    );
  }
}

async function main() {
  await paginas();
  await canais();
  console.log('\nNada foi publicado nem alterado por este script.\n');
  await db.destroy();
}

main().catch(async (err) => {
  console.error('Falhou:', err.message);
  try {
    await db.destroy();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
