const facebookService = require('./facebookService');
const postpulseService = require('./postpulseService');
const postsyncerService = require('./postsyncerService');
const ayrshareService = require('./ayrshareService');
const PostpulseConnections = require('../models/PostpulseConnections');
const { env } = require('../config/env');
const fs = require('fs');
const path = require('path');
const { storageAbsolutePath } = require('./downloadService');
const { resolveArtworkPath } = require('./matterArtworkService');

/**
 * Decide o provedor de publicação.
 * provider: auto | ayrshare | postsyncer | postpulse | facebook
 */
async function resolveProvider(userId, page) {
  const mode = env.postpulse.publishProvider || 'auto';
  if (mode === 'facebook') return 'facebook';

  const canAyrshare = ayrshareService.isConfigured();

  if (mode === 'ayrshare') {
    if (!canAyrshare) {
      const err = new Error(
        'Publicação via Ayrshare exigida, mas AYRSHARE_API_KEY não está configurada no .env.'
      );
      err.status = 400;
      throw err;
    }
    return 'ayrshare';
  }

  const canPostsyncer =
    postsyncerService.isConfigured() && Boolean(page?.postsyncer_account_id);

  if (mode === 'postsyncer') {
    if (!canPostsyncer) {
      const err = new Error(
        'Publicação via PostSyncer exigida, mas a página não está vinculada. Em /paginas sincronize o PostSyncer.'
      );
      err.status = 400;
      throw err;
    }
    return 'postsyncer';
  }

  const conn = await PostpulseConnections.findByUser(userId);
  const canPostpulse =
    postpulseService.isConfigured() && Boolean(conn?.access_token) && Boolean(page?.postpulse_account_id);

  if (mode === 'postpulse') {
    if (!canPostpulse) {
      const err = new Error(
        'Publicação via PostPulse exigida, mas a página não está vinculada. Conecte o PostPulse em /paginas e sincronize.'
      );
      err.status = 400;
      throw err;
    }
    return 'postpulse';
  }

  // auto: Ayrshare → PostSyncer → PostPulse → Graph
  if (canAyrshare) return 'ayrshare';
  if (canPostsyncer) return 'postsyncer';
  return canPostpulse ? 'postpulse' : 'facebook';
}

function buildFbPostUrl(page, postId) {
  if (!postId) return null;
  const id = String(postId);
  if (
    id.startsWith('postpulse:') ||
    id.startsWith('postsyncer:') ||
    id.startsWith('ayrshare:')
  ) {
    return null;
  }
  if (id.includes('_')) return `https://www.facebook.com/${id}`;
  return `https://www.facebook.com/${page.page_id}/posts/${id}`;
}

/**
 * Converte imagem da matéria em arquivo local (PostPulse/PostSyncer exigem upload ou https).
 * Aceita imagem_path (artes/…) ou URL /media/….
 */
function resolveLocalImageFile({ imagemPath, imageUrl }) {
  const fromArtwork = resolveArtworkPath(imagemPath);
  if (fromArtwork) return fromArtwork;

  const url = String(imageUrl || '').trim();
  if (!url) return null;

  if (url.startsWith('/media/')) {
    const relative = url.slice('/media/'.length).replace(/\//g, path.sep);
    const absolute = storageAbsolutePath(relative);
    if (fs.existsSync(absolute)) return absolute;
  }

  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/media/')) {
      const relative = parsed.pathname.slice('/media/'.length).replace(/\//g, path.sep);
      const absolute = storageAbsolutePath(relative);
      if (fs.existsSync(absolute)) return absolute;
    }
  } catch {
    /* ignore */
  }

  return null;
}

/**
 * Publica foto/vídeo/reel/texto na página (Ayrshare, PostSyncer, PostPulse ou Graph API).
 */
async function publishContent({
  userId,
  page,
  tipo,
  filePath,
  imageUrl,
  texto,
  titulo,
  link,
  imagemPath,
  publicarFacebook = true,
  publicarInstagram = false,
  publicarX = false,
  textoX = null,
  imagemXUrl = null,
}) {
  if (!publicarFacebook && !publicarInstagram && !publicarX) {
    const err = new Error('Selecione Facebook, Instagram, X.com ou mais de uma rede para publicar.');
    err.status = 400;
    throw err;
  }
  const provider = await resolveProvider(userId, page);

  let localFile = filePath || null;
  if (!localFile && (tipo === 'foto' || imageUrl || imagemPath)) {
    localFile = resolveLocalImageFile({ imagemPath, imageUrl });
  }

  const remoteUrl =
    !localFile && imageUrl && /^https?:\/\//i.test(String(imageUrl)) && !String(imageUrl).includes('/media/')
      ? String(imageUrl)
      : null;

  if (provider === 'ayrshare') {
    let content = texto || '';
    if (link) content = content ? `${content}\n\n${link}` : link;

    const imagemXInformada = String(imagemXUrl || '').trim();
    const imagemXValida = Boolean(
      resolveLocalImageFile({ imagemPath: null, imageUrl: imagemXInformada }) ||
        /^https?:\/\//i.test(imagemXInformada)
    );
    const metaPrecisaDaArte = Boolean(publicarFacebook || publicarInstagram);
    if (
      tipo === 'foto' &&
      !localFile &&
      !remoteUrl &&
      (metaPrecisaDaArte || !publicarX || !imagemXValida)
    ) {
      const err = new Error(
        'Imagem da arte não encontrada no servidor. Gere a arte novamente antes de publicar.'
      );
      err.status = 422;
      throw err;
    }

    if (tipo === 'reel' && !localFile) {
      const err = new Error(
        'Vídeo do Reel não encontrado para upload. Aguarde o processamento ou importe o link de novo.'
      );
      err.status = 422;
      throw err;
    }

    console.log('[publish] ayrshare', {
      pageId: page.id,
      tipo,
      hasFile: Boolean(localFile),
      file: localFile ? path.basename(localFile) : null,
    });

    const { resolvePageForUser, pagesForUser, defaultPageIdForUser } = require('./facebookPageResolver');

    // A página precisa pertencer ao usuário logado, senão nem tenta publicar.
    const freshPage = await resolvePageForUser(userId, page.id);
    if (!freshPage) {
      const err = new Error(
        'Esta Página do Facebook não pertence à conta logada. Selecione a página padrão em /paginas.'
      );
      err.status = 403;
      throw err;
    }

    const contaAyrshare = require('./ayrshareContaService');
    // Página marcada fora da conta Ayrshare atual: confere de novo (a conta
    // pode ter voltado) antes de recusar com uma explicação clara.
    if (freshPage.ayrshare_fora_da_conta && freshPage.ayrshare_fora_da_conta !== '0') {
      const conferida = await contaAyrshare.verificarPagina(freshPage, { forcar: true });
      if (conferida.estado === 'fora') {
        const err = new Error(
          `A Página “${freshPage.page_name}” não está na conta Ayrshare atual (${conferida.motivo || 'Profile Key de outra conta'}). ` +
            'Em /paginas, adicione a página da conta nova e marque-a como padrão.'
        );
        err.status = 422;
        err.code = 'AYRSHARE_PAGINA_FORA_DA_CONTA';
        throw err;
      }
      if (conferida.curada) freshPage.ayrshare_profile_key = null;
    }

    let profileKey = String(freshPage.ayrshare_profile_key || '').trim();

    // Sem Profile Key a Ayrshare publica no Primary Profile. Com várias páginas,
    // isso só é seguro quando o editor marcou explicitamente esta como padrão e
    // o Primary Profile confirma ter Facebook conectado. As outras continuam
    // bloqueadas para nunca publicar na página errada.
    if (!profileKey) {
      const paginas = await pagesForUser(userId);
      if (paginas.length > 1) {
        const paginaPadraoId = await defaultPageIdForUser(userId);
        // A própria Página do Primary Profile (mesmo id/nome) é segura mesmo
        // sem ser a padrão: o post vai exatamente para ela.
        const contaAtual = await contaAyrshare.contaAtual().catch(() => ({ ok: false }));
        const ehAPaginaDoPrimary = contaAtual.ok && contaAyrshare.ehDoPrimary(freshPage, contaAtual.primary) === true;
        if (!ehAPaginaDoPrimary && Number(freshPage.id) !== Number(paginaPadraoId)) {
          const err = new Error(
            `A Página “${freshPage.page_name}” está sem Profile Key da Ayrshare. ` +
              'Somente a Página padrão pode usar o Primary Profile; para esta, cole o Profile Key do User Profile em /paginas.'
          );
          err.status = 422;
          err.code = 'AYRSHARE_PROFILE_KEY_MISSING';
          throw err;
        }
        try {
          const primary = await ayrshareService.fetchProfileByKey(null, { permitirPrimary: true });
          if (!primary.facebookConnected) {
            const err = new Error(
              'O Primary Profile da Ayrshare não tem uma Página do Facebook conectada. Conecte-a em Social Accounts ou use o Profile Key de um User Profile.'
            );
            err.status = 422;
            err.code = 'AYRSHARE_PRIMARY_FACEBOOK_MISSING';
            throw err;
          }
          console.info('[publish] usando Primary Profile Ayrshare para a Página padrão', {
            pageId: freshPage.id,
            page: freshPage.page_name,
            facebook: primary.facebookPageName || null,
          });
        } catch (err) {
          if (err.status) throw err;
          const erro = new Error(
            `Não consegui confirmar o Primary Profile da Ayrshare: ${ayrshareService.apiErrorMessage(err)}`
          );
          erro.status = 422;
          erro.code = 'AYRSHARE_PRIMARY_PROFILE_UNAVAILABLE';
          throw erro;
        }
      }
    }

    if (profileKey && ayrshareService.looksLikeRefId(profileKey)) {
      const err = new Error(
        `A Página “${freshPage.page_name}” tem um RefId salvo no lugar do Profile Key. ` +
          'No painel da Ayrshare, o “Manage Profiles” mostra o RefId; o ViralizeAI precisa do Profile Key ' +
          'do User Profile. Corrija em /paginas.'
      );
      err.status = 422;
      err.code = 'AYRSHARE_PROFILE_KEY_INVALID';
      throw err;
    }

    if (profileKey && ayrshareService.isAyrshareApiKey(profileKey)) {
      const err = new Error(
        `A Página “${freshPage.page_name}” tem a API Key geral salva como Profile Key. ` +
          'Remova esse valor em /paginas para usar o Primary Profile ou cole o Profile Key correto de um User Profile.'
      );
      err.status = 422;
      err.code = 'AYRSHARE_API_KEY_AS_PROFILE_KEY';
      throw err;
    }

    console.log('[publish] ayrshare destino', {
      pageId: freshPage.id,
      page: freshPage.page_name,
      hasProfileKey: Boolean(profileKey),
    });

    // Instagram só sai com mídia e só quando a Página está marcada em /paginas.
    const querInstagram = Boolean(publicarInstagram) && Boolean(freshPage.instagram_ativo);
    const querX = Boolean(publicarX) && Boolean(freshPage.x_ativo);
    if (publicarInstagram && !freshPage.instagram_ativo) {
      console.warn(
        '[publish] instagram pedido mas a Página não está marcada em /paginas:',
        freshPage.page_name
      );
    }
    if (querInstagram && tipo === 'texto') {
      const err = new Error(
        'O Instagram não aceita post só de texto. Escolha uma imagem para a matéria ou desmarque o Instagram.'
      );
      err.status = 422;
      throw err;
    }
    if (publicarX && !freshPage.x_ativo) {
      console.warn('[publish] x.com pedido mas a Página não está marcada em /paginas:', freshPage.page_name);
    }
    const erroConfiguracaoX =
      querX && !ayrshareService.isTwitterByoConfigured()
        ? 'Para publicar no X.com, configure AYRSHARE_X_API_KEY e AYRSHARE_X_API_SECRET no .env e reinicie o app.'
        : null;
    if (!publicarFacebook && !querInstagram && !querX) {
      const err = new Error('Instagram e X.com não estão ativos para esta Página. Ative a rede desejada em /paginas.');
      err.status = 422;
      throw err;
    }

    // Facebook/Instagram e X são chamadas independentes. Assim o texto curto
    // e o JPEG preparado para o X nunca substituem a legenda ou a arte que já
    // funcionam nas redes Meta; uma falha do X também vira apenas um aviso.
    let resultMeta = null;
    if (publicarFacebook || querInstagram) {
      const payloadMeta = () => ({
        post: content,
        filePath: localFile || null,
        imageUrl: localFile ? null : remoteUrl || imageUrl || null,
        isReel: tipo === 'reel',
        title: titulo || null,
        profileKey: profileKey || null,
        publicarFacebook,
        publicarInstagram: querInstagram,
        publicarX: false,
      });
      try {
        resultMeta = await ayrshareService.publishToFacebook(payloadMeta());
      } catch (err) {
        // "The Profile Key is invalid": chave da conta Ayrshare antiga. Se a
        // página é a do Primary Profile da conta nova, a chave é apagada e o
        // post sai pelo Primary (uma única nova tentativa).
        if (!profileKey || !contaAyrshare.profileKeyInvalido(err)) throw err;
        const conferida = await contaAyrshare.verificarPagina(freshPage, { forcar: true });
        if (!conferida.curada) {
          const erro = new Error(
            `A Página “${freshPage.page_name}” usa um Profile Key que não existe na conta Ayrshare atual (provavelmente da conta antiga). ` +
              (conferida.estado === 'fora'
                ? 'Ela foi escondida das listas: em /paginas, adicione a página da conta nova e marque-a como padrão.'
                : 'Confira o Profile Key em /paginas.')
          );
          erro.status = 422;
          erro.code = 'AYRSHARE_PROFILE_KEY_DA_CONTA_ANTIGA';
          throw erro;
        }
        console.info('[publish] Profile Key da conta antiga removido; publicando pelo Primary Profile', {
          pageId: freshPage.id,
          page: freshPage.page_name,
        });
        profileKey = '';
        resultMeta = await ayrshareService.publishToFacebook(payloadMeta());
      }
    }

    let resultX = null;
    let erroXSeparado = null;
    if (querX) {
      try {
        if (erroConfiguracaoX) {
          const err = new Error(erroConfiguracaoX);
          err.status = 422;
          throw err;
        }
        const imagemX = String(imagemXUrl || '').trim();
        let localFileX = localFile || null;
        let remoteUrlX = localFile ? null : remoteUrl || imageUrl || null;
        if (imagemX && tipo !== 'reel') {
          localFileX = resolveLocalImageFile({ imagemPath: null, imageUrl: imagemX });
          remoteUrlX = !localFileX && /^https?:\/\//i.test(imagemX) ? imagemX : null;
          if (!localFileX && !remoteUrlX) {
            const err = new Error('A imagem escolhida para o X.com não é uma URL válida.');
            err.status = 422;
            throw err;
          }
        }
        const xPayload = {
          post: String(textoX || content),
          filePath: localFileX,
          imageUrl: localFileX ? null : remoteUrlX,
          isReel: tipo === 'reel',
          title: null,
          profileKey: profileKey || null,
          publicarFacebook: false,
          publicarInstagram: false,
          publicarX: true,
        };
        try {
          resultX = await ayrshareService.publishToFacebook(xPayload);
        } catch (mediaErr) {
          const temImagemX = Boolean(xPayload.filePath || xPayload.imageUrl);
          if (
            !temImagemX ||
            tipo === 'reel' ||
            !ayrshareService.isTwitterMediaUploadError(mediaErr)
          ) {
            throw mediaErr;
          }
          console.warn(
            '[publish] X.com recusou a imagem; tentando uma única vez somente com o texto.'
          );
          try {
            resultX = await ayrshareService.publishToFacebook({
              ...xPayload,
              filePath: null,
              imageUrl: null,
            });
            resultX.x_erro =
              'X.com publicou somente o texto porque a API recusou a imagem preparada.';
          } catch (textErr) {
            textErr.message = `${mediaErr.message} Tentativa somente com texto: ${textErr.message}`;
            throw textErr;
          }
        }
      } catch (err) {
        if (!resultMeta) throw err;
        erroXSeparado = err.message || 'X.com recusou a publicação';
        console.warn('[publish] X.com falhou sem afetar Meta:', erroXSeparado);
      }
    }

    const result = resultMeta || resultX || {};
    if (resultX) {
      result.x_pedido = true;
      result.x_publicado = Boolean(resultX.x_publicado);
      result.x_pendente = Boolean(resultX.x_pendente);
      result.x_post_id = resultX.x_post_id || null;
      result.x_post_url = resultX.x_post_url || null;
      result.x_erro = resultX.x_erro || null;
    } else if (querX) {
      result.x_pedido = true;
      result.x_publicado = false;
      result.x_post_id = null;
      result.x_post_url = null;
      result.x_erro = erroXSeparado;
    }

    const postId = result.post_id || result.id;
    const nativeId = result.fb_native_post_id || null;
    return {
      ...result,
      id: postId,
      post_id: postId,
      fb_native_post_id: nativeId,
      fb_post_url: publicarFacebook
        ? result.postUrl || buildFbPostUrl(page, nativeId || postId)
        : null,
      provider: 'ayrshare',
      instagram_pedido: Boolean(publicarInstagram),
      instagram_publicado: Boolean(result.instagram_publicado),
      instagram_post_id: result.instagram_post_id || null,
      instagram_post_url: result.instagram_post_url || null,
      instagram_erro:
        result.instagram_erro ||
        (publicarInstagram && !freshPage.instagram_ativo
          ? 'Esta Página não tem Instagram ativado em /paginas — publicou só no Facebook.'
          : null),
      x_pedido: Boolean(publicarX),
      x_publicado: Boolean(result.x_publicado),
      x_post_id: result.x_post_id || null,
      x_post_url: result.x_post_url || null,
      x_erro:
        result.x_erro ||
        (publicarX && !freshPage.x_ativo
          ? 'Esta Página não tem X.com ativado em /paginas — publicou só nas outras redes.'
          : null),
    };
  }

  // Só o Ayrshare integra Instagram e X.com hoje; nos outros provedores o pedido
  // seria silenciosamente ignorado.
  if (publicarInstagram || publicarX || !publicarFacebook) {
    const err = new Error(
      `Instagram e X.com só estão disponíveis pela Ayrshare (provedor atual: ${provider}). ` +
        'Ajuste PUBLISH_PROVIDER ou desmarque a opção da outra rede.'
    );
    err.status = 422;
    throw err;
  }

  if (provider === 'postsyncer') {
    let content = texto || '';
    if (link) content = content ? `${content}\n\n${link}` : link;

    if (tipo === 'foto' && !localFile && !remoteUrl) {
      const err = new Error(
        'Imagem da arte não encontrada no servidor. Gere a arte novamente antes de publicar.'
      );
      err.status = 422;
      throw err;
    }

    if (tipo === 'reel' && !localFile) {
      const err = new Error(
        'Vídeo do Reel não encontrado para upload. Aguarde o processamento ou importe o link de novo.'
      );
      err.status = 422;
      throw err;
    }

    const publicationType = tipo === 'reel' ? 'REELS' : 'POST';
    const FacebookPages = require('../models/FacebookPages');
    const freshPage = await FacebookPages.findById(page.id);

    console.log('[publish] postsyncer', {
      pageId: page.id,
      tipo,
      publicationType,
      hasFile: Boolean(localFile),
      file: localFile ? path.basename(localFile) : null,
    });

    const result = await postsyncerService.publishToFacebook({
      accountId: freshPage.postsyncer_account_id || page.postsyncer_account_id,
      content,
      filePath: localFile || null,
      imageUrl: localFile ? null : remoteUrl,
      publicationType,
      // O adapter só usa title como fallback quando content está vazio.
      title: titulo || null,
      link: link || null,
      scheduleType: 'publish_now',
    });

    const postId = result.post_id || result.id;
    return {
      ...result,
      id: postId,
      post_id: postId,
      fb_post_url: buildFbPostUrl(page, postId),
    };
  }

  if (provider === 'postpulse') {
    const conn = await PostpulseConnections.findByUser(userId);
    const publicationType = tipo === 'reel' ? 'REELS' : 'FEED';
    let content = texto || '';
    if (link) content = content ? `${content}\n\n${link}` : link;

    const { ensureChatId } = require('./postpulseSync');
    const chatId = await ensureChatId(userId, page);
    if (!chatId) {
      const err = new Error(
        'PostPulse: Página (chat) não encontrada. Em /paginas clique em Sincronizar páginas. No PostPulse a conta Facebook precisa ter a Page conectada.'
      );
      err.status = 400;
      throw err;
    }

    const FacebookPages = require('../models/FacebookPages');
    const freshPage = await FacebookPages.findById(page.id);

    if (tipo === 'foto' && !localFile && !remoteUrl) {
      const err = new Error(
        'Imagem da arte não encontrada no servidor. Gere a arte novamente antes de publicar.'
      );
      err.status = 422;
      throw err;
    }

    const result = await postpulseService.publishToFacebook({
      accessToken: conn.access_token,
      socialMediaAccountId: freshPage.postpulse_account_id || page.postpulse_account_id,
      chatId: freshPage.postpulse_chat_id || chatId,
      content,
      filePath: localFile || null,
      imageUrl: localFile ? null : remoteUrl,
      publicationType,
    });
    const postId = result.post_id || result.id;
    return {
      ...result,
      id: postId,
      post_id: postId,
      fb_post_url: buildFbPostUrl(page, postId),
    };
  }

  let result;
  if (tipo === 'reel') {
    result = await facebookService.publishReel({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      filePath: localFile || filePath,
      description: texto,
      title: titulo,
    });
  } else if (tipo === 'video') {
    result = await facebookService.publishVideo({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      filePath: localFile || filePath,
      description: texto,
    });
  } else if (tipo === 'foto' && localFile) {
    result = await facebookService.publishPhoto({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      filePath: localFile,
      caption: texto,
    });
  } else if (tipo === 'foto' && remoteUrl) {
    result = await facebookService.publishPhotoFromUrl({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      imageUrl: remoteUrl,
      caption: texto,
    });
  } else {
    result = await facebookService.publishText({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      message: texto,
      link,
    });
  }

  const postId = result.post_id || result.id;
  return {
    ...result,
    id: postId,
    post_id: postId,
    fb_post_url: buildFbPostUrl(page, postId),
    provider: 'facebook',
  };
}

function publishErrorMessage(err) {
  const url = String(err.response?.config?.url || '');
  if (url.includes('ayrshare.com')) return ayrshareService.apiErrorMessage(err);
  if (url.includes('postsyncer.com')) return postsyncerService.apiErrorMessage(err);
  if (url.includes('post-pulse')) return postpulseService.apiErrorMessage(err);
  return (
    facebookService.graphErrorMessage(err) ||
    ayrshareService.apiErrorMessage(err) ||
    postsyncerService.apiErrorMessage(err) ||
    postpulseService.apiErrorMessage(err)
  );
}

module.exports = {
  resolveProvider,
  publishContent,
  publishErrorMessage,
  buildFbPostUrl,
  resolveLocalImageFile,
};
