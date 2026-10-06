const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const dots = require('../src/services/dotsService');
const fontesService = require('../src/services/dotsFontesService');
const deepseek = require('../src/services/deepseekService');
const newsResearch = require('../src/services/newsResearch');
const biblioteca = require('../src/services/bibliotecaService');

/** Troca a resposta da IA que interpreta o pedido, só durante `fn`. */
async function comIa(resposta, fn) {
  const original = deepseek.chatCompletion;
  deepseek.chatCompletion = async () => {
    if (resposta instanceof Error) throw resposta;
    return JSON.stringify(resposta);
  };
  try {
    return await fn();
  } finally {
    deepseek.chatCompletion = original;
  }
}

/** Troca quem procura as fontes citadas pelo nome (sem ir à rede). */
async function comResolvedor(resolver, fn) {
  const original = fontesService.resolverFontes;
  fontesService.resolverFontes = resolver;
  try {
    return await fn();
  } finally {
    fontesService.resolverFontes = original;
  }
}

const PLANO_IA = {
  nome: 'Teste',
  acao: 'monitorar_e_escrever',
  criterio: 'Fato novo.',
  palavras: [],
  recorte: null,
  estilo: null,
  pesquisas: [],
  fontes: [],
};

// ------------------------------------------------------------ o pedido

test('pedido só com o assunto vira pesquisa no Google Notícias', async () => {
  await comIa({ ...PLANO_IA, pesquisas: ['reforma tributária'] }, async () => {
    const plano = await dots.montarPlano('Pesquise notícias sobre reforma tributária e escreva matérias');
    assert.deepEqual(plano.pesquisas, ['reforma tributária']);
    assert.equal(plano.fontes.length, 0);
    assert.deepEqual(dots.avisosDoPlano(plano), [], 'tem onde procurar: sem aviso');
  });
});

test('sem a IA, o assunto do pedido vira a pesquisa (o dot não nasce sem nada para ler)', async () => {
  await comIa(new Error('IA fora'), async () => {
    const plano = await dots.montarPlano('Pesquise notícias sobre reforma tributária e escreva matérias');
    assert.deepEqual(plano.pesquisas, ['reforma tributária']);
  });
});

test('o assunto de reserva sai do texto do pedido', () => {
  assert.equal(dots.termoDeReserva('Pesquise notícias sobre reforma tributária e escreva matérias'), 'reforma tributária');
  assert.equal(dots.termoDeReserva('Notícias do Flávio Bolsonaro com título polêmico'), 'Flávio Bolsonaro');
  assert.equal(dots.termoDeReserva('Quero matérias de política nacional'), 'política nacional');
  assert.equal(dots.termoDeReserva('https://g1.globo.com'), null);
});

test('fonte citada pelo nome é procurada e entra com o endereço conferido', async () => {
  const pedidas = [];
  await comResolvedor(async (lista) => {
    pedidas.push(...lista);
    return lista.map((f) => ({ ...f, url: 'https://www.facebook.com/metropolesdf', verificado: true, via: 'busca', motivo: null }));
  }, () => comIa({ ...PLANO_IA, fontes: [{ tipo: 'facebook', nome: 'Metrópoles', url: null }] }, async () => {
    const plano = await dots.montarPlano('Monitore a página do Metrópoles no Facebook');
    assert.deepEqual(pedidas.map((f) => [f.tipo, f.nome]), [['facebook', 'Metrópoles']]);
    assert.equal(plano.fontes[0].url, 'https://www.facebook.com/metropolesdf');
    assert.equal(plano.fontes[0].verificado, true);
    assert.deepEqual(plano.pesquisas, [], 'com fonte, não inventa pesquisa');
  }));
});

test('fonte não achada aparece no aviso e não vira pesquisa inventada', async () => {
  await comResolvedor(
    async (lista) => lista.map((f) => ({ ...f, url: null, verificado: false, motivo: `Não achei "${f.nome}" no Facebook. Cole o link da página.` })),
    () => comIa({ ...PLANO_IA, fontes: [{ tipo: 'facebook', nome: 'Página Qualquer', url: null }] }, async () => {
      const plano = await dots.montarPlano('Monitore a Página Qualquer no Facebook');
      assert.deepEqual(plano.pesquisas, []);
      const avisos = dots.avisosDoPlano(plano).join(' | ');
      assert.match(avisos, /Não achei onde procurar/);
      assert.match(avisos, /Cole o link da página/);
    })
  );
});

test('link colado entra como fonte e não é procurado de novo', async () => {
  let chamadas = 0;
  await comResolvedor(async (lista) => {
    chamadas += lista.length;
    return [];
  }, () => comIa({ ...PLANO_IA, fontes: [{ tipo: 'instagram', nome: 'Poder360', url: 'https://www.instagram.com/poder360/' }] }, async () => {
    const plano = await dots.montarPlano('Acompanhe https://www.instagram.com/poder360/');
    assert.equal(chamadas, 0, 'quem veio com link não é procurado');
    assert.equal(plano.fontes.length, 1);
    assert.equal(plano.fontes[0].via, 'link');
    assert.equal(plano.fontes[0].tipo, 'instagram');
    assert.equal(plano.fontes[0].nome, '@poder360');
  }));
});

test('o que o editor tirou ou acrescentou pelo painel continua valendo ao editar o pedido', async () => {
  const anterior = {
    removidas: ['url|instagram.com/poder360'],
    manuais: {
      fontes: [{ tipo: 'site', nome: 'g1.globo.com', url: 'https://g1.globo.com', verificado: true, via: 'link' }],
      pesquisas: ['eleições'],
    },
  };
  await comIa({ ...PLANO_IA }, async () => {
    const plano = await dots.montarPlano('Acompanhe https://www.instagram.com/poder360/\n\nAjuste: título forte', { anterior });
    assert.deepEqual(plano.fontes.map((f) => f.url), ['https://g1.globo.com']);
    assert.deepEqual(plano.pesquisas, ['eleições']);
    assert.deepEqual(plano.removidas, ['url|instagram.com/poder360'], 'a remoção continua anotada');
  });
});

test('o plano da prévia volta do navegador limpo (o editor pode ter tirado fontes)', () => {
  assert.equal(dots.planoDaTela(null), null);
  assert.equal(dots.planoDaTela({ nome: 'x' }), null, 'sem lista de fontes não é plano da prévia');
  const plano = dots.planoDaTela({
    nome: 'Teste',
    acao: 'qualquer',
    pesquisas: ['  reforma tributária ', 'Reforma Tributária', ''],
    fontes: [
      { tipo: 'facebook', nome: 'Metrópoles', url: 'https://www.facebook.com/metropolesdf', verificado: true },
      { tipo: 'invalido', nome: 'g1', url: 'javascript:alert(1)' },
    ],
  });
  assert.equal(plano.acao, 'monitorar_e_escrever');
  assert.deepEqual(plano.pesquisas, ['reforma tributária'], 'repetida e vazia saem');
  assert.equal(plano.fontes[1].url, null, 'só http(s) vira fonte');
  assert.equal(plano.fontes[1].tipo, 'site');
});

test('o resumo diz onde o dot procura', () => {
  const linhas = dots.resumoDoPlano(
    { acao: 'monitorar_e_escrever', pesquisas: ['reforma tributária'], fontes: [{ url: 'https://g1.globo.com' }], recorte: 'política brasileira' },
    [],
    { destino: 'rascunho', limite_dia: 20, scan_minutos: 60, modo_imagem: 'ia_todas' }
  ).join(' | ');
  assert.match(linhas, /Pesquisa no Google Notícias: “reforma tributária”/);
  assert.match(linhas, /Acompanha 1 página/);
  assert.match(linhas, /gera uma imagem nova com IA/);
  assert.match(linhas, /Só escreve o que for de política brasileira/);
});

test('imagem: foto da notícia, sempre IA, ou limpar o texto da foto', () => {
  assert.equal(dots.normalizarJornada({ modo_imagem: 'ia_todas' }).modo_imagem, 'ia_todas');
  assert.equal(dots.normalizarJornada({ modo_imagem: 'ia_com_texto' }).modo_imagem, 'ia_com_texto');
  assert.equal(dots.normalizarJornada({ modo_imagem: 'qualquer' }).modo_imagem, 'original');
  assert.equal(dots.normalizarJornada({ gerar_imagem_com_texto: true }).modo_imagem, 'ia_com_texto', 'a caixa antiga continua valendo');
});

// ------------------------------------------------------------ a volta

test('notícia da pesquisa (link do Google) não é descartada por pouco texto', () => {
  assert.equal(dots.postTemMaterial({ url: 'https://news.google.com/rss/articles/CBMiABC?oc=5', titulo: 'Lula', resumo: '' }), true);
});

test('pesquisa não passa pelo filtro de palavra; tema amplo passa pela triagem da IA', () => {
  const fonte = fs.readFileSync('src/services/dotsService.js', 'utf8');
  assert.match(fonte, /p\.fonte_plataforma === 'busca' \|\| filtrarPorPalavras\(\[p\], plano\.palavras\)\.length/);
  assert.match(fonte, /const noRecorte = await triarPeloRecorte\(dot, plano, comPalavra\)/);
});

test('sem tema pedido, a triagem nem consulta a IA', async () => {
  const posts = [{ id: 1, titulo: 'a' }, { id: 2, titulo: 'b' }];
  assert.equal(await dots.triarPeloRecorte({ id: 1 }, {}, posts), posts);
});

test('IA fora do ar não é culpa do post', () => {
  const gateway = new Error('Token-Free Gateway nao esta acessivel em http://127.0.0.1:3456/v1. Execute "token-free-gateway start".');
  assert.equal(dots.falhaDaIa(gateway), true);
  assert.equal(dots.falhaDaIa(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), true);
  assert.equal(dots.falhaDaIa(Object.assign(new Error('Créditos acabaram'), { iaPausada: true })), true);
  assert.equal(dots.falhaDaIa(Object.assign(new Error('limite'), { status: 429 })), true);
  assert.equal(dots.falhaDaIa(new Error('a IA não gerou matéria')), false);
  assert.equal(dots.falhaDaIa(new Error('a escrita passou de 15 min')), false);

  const fonte = fs.readFileSync('src/services/dotsService.js', 'utf8');
  // O post volta para a fila sem url no log (fora da quarentena de 2 h) e a volta para.
  assert.match(fonte, /if \(falhaDaIa\(err\)\) \{/);
  assert.match(fonte, /if \(!err\.infraIa\) throw err;\s+iaForaDoAr = err\.message;\s+break;/);
});

test('servidor reiniciado no meio da volta não deixa dot nem post presos', () => {
  const fonte = fs.readFileSync('src/services/dotsService.js', 'utf8');
  // Só o que é anterior ao início deste processo é sobra.
  assert.match(fonte, /const INICIO_PROCESSO = new Date\(\);/);
  assert.match(fonte, /orWhere\('atividade_em', '<', INICIO_PROCESSO\)/);
  // O post reservado sem matéria volta para a fila.
  assert.match(fonte, /where\(\{ user_id: dot\.user_id, status: 'gerado_texto' \}\)\s+\.whereNull\('matter_id'\)\s+\.update\(\{ status: 'visto' \}\)/);
  // Roda uma vez, na primeira volta do processo.
  assert.match(fonte, /if \(!travasConferidas\) \{\s+travasConferidas = true;\s+await liberarTravasDoProcessoAnterior\(\)/);
});

// ------------------------------------------------------- pesquisa (fonte)

test('a pesquisa tem endereço estável e o assunto sai dele', () => {
  const url = biblioteca.urlDaBusca('  reforma   tributária ');
  assert.equal(url, 'https://news.google.com/rss/search?q=reforma%20tribut%C3%A1ria&hl=pt-BR&gl=BR&ceid=BR:pt-419');
  assert.equal(biblioteca.termoDaFonteBusca({ url }), 'reforma tributária');
  assert.equal(biblioteca.termoDaFonteBusca({ handle: 'Lula', url }), 'Lula', 'o handle guardado manda');
});

test('a pesquisa traz as notícias do Google com o veículo no resumo', async () => {
  const original = newsResearch.buscarGoogleNewsRss;
  const pedidos = [];
  newsResearch.buscarGoogleNewsRss = async (termo, { when }) => {
    pedidos.push(when);
    if (when !== '1d') return [];
    return Array.from({ length: 6 }, (_, i) => ({
      titulo: `Notícia ${i}`,
      link: `https://news.google.com/rss/articles/N${i}`,
      veiculo: 'UOL Notícias',
      resumo: `Notícia ${i}&nbsp;&nbsp;UOL Notícias`,
      dataTimestamp: Date.UTC(2026, 9, 5, 12, i),
    }));
  };
  try {
    const itens = await biblioteca.coletarViaBusca({ handle: 'reforma tributária', plataforma: 'busca' });
    assert.deepEqual(pedidos, ['1d'], 'com 5 ou mais em 24 h não alarga para 7 dias');
    assert.equal(itens.length, 6);
    assert.equal(itens[0].resumo, 'UOL Notícias');
    assert.ok(itens[0].publicadoEm instanceof Date);
  } finally {
    newsResearch.buscarGoogleNewsRss = original;
  }
});

test('pesquisa vazia explica o motivo', async () => {
  const original = newsResearch.buscarGoogleNewsRss;
  newsResearch.buscarGoogleNewsRss = async () => [];
  try {
    await assert.rejects(biblioteca.coletarViaBusca({ handle: 'xyzw', plataforma: 'busca' }), /não trouxe nada sobre "xyzw"/);
  } finally {
    newsResearch.buscarGoogleNewsRss = original;
  }
});

// ---------------------------------------------- reconhecer página pelo nome

test('nome confere com o título real da página', () => {
  assert.equal(fontesService.nomeConfere('Jovem Pan', 'Jovem Pan News'), true);
  assert.equal(fontesService.nomeConfere('g1', 'g1 - O portal de notícias da Globo'), true);
  assert.equal(fontesService.nomeConfere('Folha de S.Paulo', 'Folha de S.Paulo'), true);
  assert.equal(fontesService.nomeConfere('Nikolas Ferreira', 'Nikolas Ferreira (@nikolasferreiradm) • Fotos e vídeos do Instagram'), true);
  // O caso real: facebook.com/metropoles é de outra pessoa.
  assert.equal(fontesService.nomeConfere('Metrópoles', 'Pham Dinh Nguyen'), false);
  assert.equal(fontesService.nomeConfere('Metrópoles', 'K a n e k i k e n'), false);
});

test('só link de perfil serve de fonte (não post, compartilhamento ou busca)', () => {
  const { perfilDaRede } = fontesService;
  assert.equal(perfilDaRede('https://www.facebook.com/Poder360/posts/123', 'facebook'), 'https://www.facebook.com/Poder360');
  assert.equal(perfilDaRede('https://www.facebook.com/sharer/sharer.php?u=x', 'facebook'), null);
  assert.equal(perfilDaRede('https://www.facebook.com/profile.php?id=123', 'facebook'), 'https://www.facebook.com/profile.php?id=123');
  assert.equal(perfilDaRede('https://www.instagram.com/poder360/', 'instagram'), 'https://www.instagram.com/poder360/');
  assert.equal(perfilDaRede('https://www.instagram.com/p/ABC123/', 'instagram'), null);
  assert.equal(perfilDaRede('https://www.youtube.com/@jovempannews/videos', 'youtube'), 'https://www.youtube.com/@jovempannews');
  assert.equal(perfilDaRede('https://www.youtube.com/watch?v=x', 'youtube'), null);
  assert.equal(perfilDaRede('https://www.tiktok.com/@poder360', 'tiktok'), 'https://www.tiktok.com/@poder360');
  assert.equal(perfilDaRede('https://www.instagram.com/poder360/', 'facebook'), null, 'rede errada');
});

test('o link real sai do redirecionador do Bing', () => {
  const real = 'https://www.metropoles.com/';
  const cifrado = Buffer.from(real).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const href = `https://www.bing.com/ck/a?!&&p=abc&ptn=3&u=a1${cifrado}&ntb=1`;
  assert.equal(fontesService.urlDoRedirecionadorBing(href), real);
  assert.equal(fontesService.urlDoRedirecionadorBing('https://g1.globo.com/'), 'https://g1.globo.com/', 'link direto passa');

  const html = `<ol><li class="b_algo"><h2><a href="${href.replace(/&/g, '&amp;')}">Metr&#243;poles | Brasília</a></h2></li>`
    + '<li class="b_algo"><h2><a href="https://www.instagram.com/metropoles/">Metrópoles (@metropoles)</a></h2></li></ol>';
  assert.deepEqual(fontesService.lerResultadosBing(html), [
    { url: real, titulo: 'Metrópoles | Brasília' },
    { url: 'https://www.instagram.com/metropoles/', titulo: 'Metrópoles (@metropoles)' },
  ]);
});

test('lê o nome da página pelo og:title', () => {
  const meta = fontesService.metaDaPagina(
    '<html><head><meta property="og:title" content="Poder360" /><meta property="og:site_name" content="Facebook"><title>Poder360 | Facebook</title></head></html>'
  );
  assert.deepEqual(meta, { ogTitulo: 'Poder360', ogSite: 'Facebook', titulo: 'Poder360 | Facebook' });
});

test('"IA que escreve" escolhida no dot vale mesmo com o gateway como padrão', async () => {
  const tokenFree = require('../src/services/tokenFreeGatewayService');
  const cobre = tokenFree.cobreTarefa;
  tokenFree.cobreTarefa = () => true; // gateway configurado como padrão
  try {
    assert.equal(deepseek.usarTokenFree('conversa'), true, 'sem escolha, o gateway segue padrão');
    await deepseek.comProvedor('deepseek', async () => {
      assert.equal(deepseek.usarTokenFree('conversa'), false, 'o dot em DeepSeek não pode sair pelo gateway');
    });
  } finally {
    tokenFree.cobreTarefa = cobre;
  }
});

test('o painel lê o link do post publicado de publications (ai_matters não tem a coluna)', () => {
  const fonte = fs.readFileSync('src/services/dotsService.js', 'utf8');
  assert.match(fonte, /\.leftJoin\('publications as pub', 'pub\.id', 'm\.publication_id'\)/);
  assert.match(fonte, /'pub\.fb_post_url'/);
  assert.doesNotMatch(fonte, /'m\.fb_post_url'/, 'a coluna não existe e quebrava a consulta');
});

// ------------------------------------------------------- telas e rotas

test('o painel tem rotas para fontes, imagem e desagendar', () => {
  const rotaDots = fs.readFileSync('src/routes/dots.js', 'utf8');
  assert.match(rotaDots, /router\.post\('\/:id\/fontes'/);
  assert.match(rotaDots, /router\.delete\('\/:id\/fontes\/:fonteId'/);
  assert.match(rotaDots, /router\.post\('\/:id\/materias\/:matterId\/imagem'/);
  assert.match(rotaDots, /plano: req\.body\?\.plano \|\| null/, 'a criação usa o plano que o editor viu');

  const rotaMaterias = fs.readFileSync('src/routes/materiasIa.js', 'utf8');
  assert.match(rotaMaterias, /router\.post\('\/matters\/:id\/desagendar', controller\.desagendar\)/);

  const servico = fs.readFileSync('src/services/materiaIaService.js', 'utf8');
  // Desagendar sem cancelar o job deixaria a fila publicar no horário antigo.
  assert.match(servico, /\.where\(\{ matter_id: matter\.id, status: 'pendente' \}\)\s+\.update\(\{ status: 'cancelado'/);
  assert.match(servico, /AiMatters\.update\(matter\.id, \{ status: 'rascunho', scheduled_at: null \}\)/);
});

test('agendar e publicar exigem página; sem página, só rascunho', () => {
  const fonte = fs.readFileSync('src/services/dotsService.js', 'utf8');
  assert.match(fonte, /Escolha a página onde publicar\. Sem página, o dot só pode deixar em rascunho\./);
  assert.match(fonte, /const paginaId = await paginaDoEditor\(userId, facebookPageId, config\.destino\)/);
});
