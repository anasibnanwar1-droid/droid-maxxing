function installRendererNavigationGuard(contents, entryUrl, openExternal) {
  contents.on('will-navigate', (event, nextUrl) => {
    if (!isTrustedRendererUrl(nextUrl, entryUrl)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) void openExternal(url);
    return { action: 'deny' };
  });
}

function isTrustedRendererUrl(candidate, entryUrl) {
  try {
    const candidateUrl = new URL(candidate);
    const trustedUrl = new URL(entryUrl);
    if (trustedUrl.protocol === 'file:') {
      return candidateUrl.protocol === 'file:' && candidateUrl.pathname === trustedUrl.pathname;
    }
    return candidateUrl.origin === trustedUrl.origin;
  } catch {
    return false;
  }
}

function isExternalWebUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

module.exports = { installRendererNavigationGuard, isTrustedRendererUrl };
