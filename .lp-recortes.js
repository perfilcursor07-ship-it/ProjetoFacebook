/**
 * Script temporário: fatia os screenshots em pedaços legíveis.
 * Não faz parte do projeto — é removido depois da conferência.
 */
const path = require('path');
const sharp = require('sharp');

const dir = path.join(__dirname, '.lp-shots');

async function fatiar(nome, alturaFatia) {
  const origem = path.join(dir, nome);
  const meta = await sharp(origem).metadata();
  console.log(nome + ': ' + meta.width + 'x' + meta.height);

  let i = 0;
  for (let top = 0; top < meta.height; top += alturaFatia) {
    const altura = Math.min(alturaFatia, meta.height - top);
    if (altura < 60) break;
    i += 1;
    const saida = path.join(dir, nome.replace(/\.png$/, '') + '-p' + i + '.png');
    await sharp(origem)
      .extract({ left: 0, top, width: meta.width, height: altura })
      .png()
      .toFile(saida);
    console.log('  -> ' + path.basename(saida) + ' ' + meta.width + 'x' + altura);
  }
}

(async () => {
  await fatiar('desktop.png', 1350);
  await fatiar('mobile.png', 2600);
})().catch((err) => {
  console.error('ERRO: ' + err.message);
  process.exit(1);
});
