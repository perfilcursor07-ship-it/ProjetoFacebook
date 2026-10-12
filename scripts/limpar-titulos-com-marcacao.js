#!/usr/bin/env node
/**
 * Tira a marcação de bloco do Claude dos títulos já gravados.
 *
 * Saíram matérias publicadas com o título assim:
 *   <WritingBlock id="63928" variant="document">Pastor itinerante é preso…
 *
 * O post no Facebook não dá para consertar daqui (a arte e a legenda já
 * foram), mas o título no banco dá — e é ele que a tela mostra, que entra na
 * comparação de notícia repetida e que vai para a arte se alguém republicar.
 *
 *   node scripts/limpar-titulos-com-marcacao.js            (só mostra)
 *   node scripts/limpar-titulos-com-marcacao.js --aplicar  (grava)
 */
require('dotenv').config();

const db = require('../src/config/db');
const { removerBlocosDoClaude } = require('../src/services/chatgptMarkup');

const APLICAR = process.argv.includes('--aplicar');
const COLUNAS = ['titulo', 'titulo_ia', 'fonte_titulo'];

function limpo(valor) {
  if (valor == null) return null;
  return removerBlocosDoClaude(String(valor)).replace(/\s+/g, ' ').trim();
}

async function main() {
  const suspeitas = await db('ai_matters')
    .where(function comMarcacao() {
      for (const coluna of COLUNAS) {
        this.orWhere(coluna, 'like', '%<%Block%')
          .orWhere(coluna, 'like', '%:::%')
          .orWhere(coluna, 'like', '%<Artifact%');
      }
    })
    .select('id', 'status', ...COLUNAS)
    .orderBy('id', 'desc')
    .limit(500);

  const aCorrigir = [];
  for (const m of suspeitas) {
    const patch = {};
    for (const coluna of COLUNAS) {
      const novo = limpo(m[coluna]);
      if (novo != null && novo !== String(m[coluna] ?? '').trim()) patch[coluna] = novo;
    }
    if (Object.keys(patch).length) aCorrigir.push({ id: m.id, status: m.status, antes: m.titulo, patch });
  }

  console.log(
    `\n${suspeitas.length} matéria(s) com sinal de marcação; ${aCorrigir.length} realmente para corrigir.\n`
  );
  for (const item of aCorrigir.slice(0, 40)) {
    console.log(`  #${item.id} [${item.status}]`);
    console.log(`    antes:  ${String(item.antes || '').slice(0, 110)}`);
    console.log(`    depois: ${String(item.patch.titulo ?? item.antes ?? '').slice(0, 110)}`);
  }
  if (aCorrigir.length > 40) console.log(`  … e mais ${aCorrigir.length - 40}.`);

  if (!APLICAR) {
    console.log('\nNada gravado. Rode com --aplicar para gravar.\n');
  } else {
    let feitas = 0;
    for (const item of aCorrigir) {
      // Direto na tabela: passar pelo modelo faria a limpeza duas vezes sem
      // necessidade e mexeria em updated_at de matéria publicada.
      await db('ai_matters').where({ id: item.id }).update(item.patch);
      feitas += 1;
    }
    console.log(`\n${feitas} matéria(s) corrigida(s).\n`);
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
