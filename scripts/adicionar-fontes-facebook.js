/**
 * Cadastra na Biblioteca as páginas do Facebook que o Furos do dia monitora.
 *
 * Os posts coletados dessas páginas entram como pauta tanto no piloto
 * automático quanto na busca manual de furos — quem decide o que vira matéria
 * continua sendo a IA, pela mesma nota de sempre. Post curto demais (uma ou
 * duas linhas, sem vídeo) é descartado antes, em furosSociais.
 *
 * Idempotente: a Biblioteca tem índice único por (user_id, url), então rodar
 * de novo não duplica — só relata o que já existia.
 *
 * Uso:
 *   node scripts/adicionar-fontes-facebook.js --user=2
 *   node scripts/adicionar-fontes-facebook.js --user=2 --intervalo=30
 *   node scripts/adicionar-fontes-facebook.js --user=2 --dry-run
 */
const db = require('../src/config/db');
const bibliotecaService = require('../src/services/bibliotecaService');

/**
 * `nome` só é informado para as páginas sem vanity URL (/profile.php?id=N),
 * onde não dá para deduzir um nome legível da própria URL.
 */
const PAGINAS = [
  { url: 'https://www.facebook.com/investibr' },
  { url: 'https://www.facebook.com/therealcoachjosiah1' },
  { url: 'https://www.facebook.com/Vaibrasil' },
  { url: 'https://www.facebook.com/LuizBacci' },
  { url: 'https://www.facebook.com/louvordaalmaoficial' },
  { url: 'https://www.facebook.com/DavidJHarrisJr' },
  { url: 'https://www.facebook.com/ChristDailyu' },
  { url: 'https://www.facebook.com/folhadesp' },
  { url: 'https://www.facebook.com/profile.php?id=61584195047523', nome: 'Página FB 61584195047523' },
  { url: 'https://www.facebook.com/profile.php?id=61552089960643', nome: 'Página FB 61552089960643' },
  { url: 'https://www.facebook.com/UOLNoticias' },
  { url: 'https://www.facebook.com/FilhosdeDeus01' },
  { url: 'https://www.facebook.com/FollowJesus153' },
  { url: 'https://www.facebook.com/kingdomboiz' },
  { url: 'https://www.facebook.com/profile.php?id=61578864073994', nome: 'Página FB 61578864073994' },
  { url: 'https://www.facebook.com/jayalvarrezofficial' },
  { url: 'https://www.facebook.com/christianvideo.kenosis' },
  { url: 'https://www.facebook.com/kgospelmusic1' },
  { url: 'https://www.facebook.com/profile.php?id=61572968384582', nome: 'Página FB 61572968384582' },
  { url: 'https://www.facebook.com/allenbaileyministries' },
  { url: 'https://www.facebook.com/fuerteenelcorazon' },
  { url: 'https://www.facebook.com/VT' },
  { url: 'https://www.facebook.com/plenonews' },
  { url: 'https://www.facebook.com/metropolesdf' },
  { url: 'https://www.facebook.com/Poder360' },
  { url: 'https://www.facebook.com/jovempannews' },
];

function arg(nome, padrao = null) {
  const achado = process.argv.find((a) => a.startsWith(`--${nome}=`));
  if (achado) return achado.split('=').slice(1).join('=');
  return process.argv.includes(`--${nome}`) ? true : padrao;
}

async function main() {
  const userId = Number(arg('user'));
  const intervalo = Number(arg('intervalo', 60));
  const simular = Boolean(arg('dry-run'));

  if (!Number.isInteger(userId) || userId <= 0) {
    console.error('Informe a conta: node scripts/adicionar-fontes-facebook.js --user=2');
    process.exit(1);
  }
  const usuario = await db('users').where({ id: userId }).first('id', 'email');
  if (!usuario) {
    console.error(`Usuário ${userId} não existe.`);
    process.exit(1);
  }

  console.log(`Conta: #${usuario.id} ${usuario.email || ''}`);
  console.log(`Páginas: ${PAGINAS.length} · intervalo de varredura: ${intervalo} min${simular ? ' · SIMULAÇÃO' : ''}\n`);

  const jaExistiam = [];
  const criadas = [];
  const falharam = [];

  for (const pagina of PAGINAS) {
    const rotulo = pagina.url.replace('https://www.facebook.com/', '');
    const existente = await db('biblioteca_fontes')
      .where({ user_id: userId })
      .andWhere('url', 'like', `%${pagina.url.replace('https://www.', '').replace(/[%_]/g, '')}%`)
      .first('id', 'nome', 'monitorar');

    if (existente) {
      // Já cadastrada: garante só que está monitorando.
      if (!existente.monitorar && !simular) {
        await db('biblioteca_fontes').where({ id: existente.id }).update({ monitorar: true });
        console.log(`  ~ ${rotulo} — já existia, monitoramento LIGADO`);
      } else {
        console.log(`  = ${rotulo} — já existia`);
      }
      jaExistiam.push(rotulo);
      continue;
    }

    if (simular) {
      console.log(`  + ${rotulo} — seria criada`);
      criadas.push(rotulo);
      continue;
    }

    try {
      await bibliotecaService.criarFonte({
        userId,
        url: pagina.url,
        nome: pagina.nome || undefined,
        monitorar: true,
        intervaloMinutos: intervalo,
      });
      console.log(`  + ${rotulo} — criada`);
      criadas.push(rotulo);
    } catch (err) {
      console.error(`  ! ${rotulo} — ${err.message}`);
      falharam.push(`${rotulo}: ${err.message}`);
    }
  }

  console.log(`\nCriadas: ${criadas.length} · já existiam: ${jaExistiam.length} · falharam: ${falharam.length}`);
  if (falharam.length) {
    console.log('\nFalhas:');
    for (const f of falharam) console.log(`  ${f}`);
  }
  if (!simular && criadas.length) {
    console.log('\nA primeira varredura roda no próximo tick da Biblioteca.');
    console.log('Para puxar agora: Biblioteca › a fonte › "Escanear agora".');
  }
}

main()
  .then(() => db.destroy())
  .catch(async (err) => {
    console.error('Erro:', err.message);
    await db.destroy();
    process.exit(1);
  });
