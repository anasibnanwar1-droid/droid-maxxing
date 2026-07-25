function attachChildView(entry, host) {
  if (!entry?.view || !isUsableHost(host)) return false;
  if (entry.windowAttached && entry.hostWindow === host) return false;
  detachChildView(entry);
  host.contentView.addChildView(entry.view);
  entry.windowAttached = true;
  entry.hostWindow = host;
  return true;
}

function detachChildView(entry, view = entry?.view) {
  const host = entry?.hostWindow;
  const wasAttached = Boolean(entry?.windowAttached);
  if (wasAttached && view && isUsableHost(host)) {
    try {
      host.contentView.removeChildView(view);
    } catch {
      // The host may already be tearing down.
    }
  }
  if (entry) {
    entry.windowAttached = false;
    entry.hostWindow = null;
  }
  return wasAttached;
}

function isUsableHost(host) {
  return Boolean(host && (typeof host.isDestroyed !== 'function' || !host.isDestroyed()));
}

module.exports = { attachChildView, detachChildView };
