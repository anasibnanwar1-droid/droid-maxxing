function errorMessage(error) {
  if (typeof error === 'string') return error.trim();
  if (error && typeof error.message === 'string') return error.message.trim();
  return '';
}

function showDesktopNotification(NotificationClass, payload, dependencies = {}) {
  if (typeof NotificationClass?.isSupported === 'function' && !NotificationClass.isSupported()) {
    return Promise.resolve({ shown: false, reason: 'unsupported' });
  }

  const setTimer = dependencies.setTimer || setTimeout;
  const clearTimer = dependencies.clearTimer || clearTimeout;

  return new Promise((resolve) => {
    let note;
    let settled = false;
    let activated = false;
    let timer;

    const activate = () => {
      if (activated) return;
      activated = true;
      payload.onActivate?.();
    };
    const cleanupSettlementListeners = () => {
      if (!note) return;
      note.removeListener('show', onShow);
      note.removeListener('failed', onFailed);
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      cleanupSettlementListeners();
      resolve(result);
    };
    const onShow = () => settle({ shown: true });
    const onFailed = (_event, error) => {
      const message = errorMessage(error);
      settle({
        shown: false,
        reason: 'failed',
        ...(message ? { message } : {}),
      });
    };

    try {
      note = new NotificationClass({
        title: payload.title,
        body: payload.body,
        silent: payload.silent === true,
        ...(payload.icon ? { icon: payload.icon } : {}),
      });
      note.on('show', onShow);
      note.on('failed', onFailed);
      note.on('click', activate);
      note.on('action', activate);
      timer = setTimer(
        () => settle({ shown: false, reason: 'timeout' }),
        payload.timeoutMs || 5_000,
      );
      note.show();
    } catch (error) {
      const message = errorMessage(error);
      settle({
        shown: false,
        reason: 'failed',
        ...(message ? { message } : {}),
      });
    }
  });
}

module.exports = { showDesktopNotification };
