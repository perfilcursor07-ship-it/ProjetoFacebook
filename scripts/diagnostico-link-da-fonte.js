#!/usr/bin/env node
/**
 * Por que a caixa "Link da fonte" está sem link?
 *
 * Mostra, para uma matéria, quais dos campos têm endereço e o que o extrator
 * consegue achar. Serve para separar duas coisas bem diferentes:
 *
 *   - o endereço existe mas não era lido  → já corrigido, o link volta;
 *   - o endereço não existe em lugar nenhum → a matéria foi salva sem fonte,
 *     e aí o problema é mais atrás, na hora de salvar.
 *
 *   node scripts/diagnostico-link-da-fonte.js 5061
 *   node scripts/diagnostico-link-da-fonte.js            (as 15 mais recentes)
 */
require('dotenv').config();

const db = require('../src/config/db');
const { extractMatterSourceLinks } = require('../src/services/matterSourceLinks');

const ID = Number(process.argv[2]) || null;
const TEM_URL = /https?:\/\//;

function marca(valor) {
  if (valor == null || String(valor).trim() === '') return 'vazio';
  return TEM_URL.test(String(valor)) ? 'TEM endereço' : 'sem endereço';
}

async function main() {
  const colunas = ['id', 'titulo', 'fonte_titulo', 'fonte_url', 'fonte_credito', 'contexto_apuracao', 'materia'];
  const materias = ID
    ? await db('ai_matters').where({ id: ID }).select(colunas)
    : await db('ai_matters').orderBy('id', 'desc').limit(15).select(colunas);

  if (!materias.length) {
    console.log(ID ? `\nMatéria #${ID} não encontrada.\n` : '\nNenhuma matéria.\n');
    await db.destroy();
    return;
  }

  let semNada = 0;
  for (const m of materias) {
    const links = extractMatterSourceLinks(m);
    console.log(`\n#${m.id} ${String(m.titulo || '').slice(0, 70)}`);
    console.log(`    fonte_titulo      ${String(m.fonte_titulo || '—').slice(0, 60)}`);
    console.log(`    fonte_url         ${marca(m.fonte_url)}`);
    console.log(`    fonte_credito     ${marca(m.fonte_credito)}`);
    console.log(`    contexto_apuracao ${marca(m.contexto_apuracao)}`);
    console.log(`    corpo da matéria  ${marca(m.materia)}`);
    if (links.length) {
      for (const l of links) console.log(`    → link: ${l.label} = ${l.url}`);
    } else {
      semNada += 1;
      console.log('    → NENHUM link. A matéria foi salva sem o endereço da fonte.');
    }
  }

  if (semNada) {
    console.log(
      `\n${semNada} de ${materias.length} sem endereço em campo nenhum.` +
        '\nNessas, o link não some na tela: ele nunca foi gravado. O ponto a' +
        '\nolhar é o salvamento (as fontes da pesquisa não chegaram à matéria).\n'
    );
  } else {
    console.log('\nTodas com link.\n');
  }

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
