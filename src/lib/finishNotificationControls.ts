// Single source of truth for Settings → Notifications rows and search keywords.

export const FINISH_NOTIFICATION_TOGGLES = [
  {
    key: 'enabled' as const,
    label: 'When a turn finishes',
    description: 'Show a desktop banner with a short snippet of the model reply.',
    keywords: ['finish', 'finished', 'banner', 'desktop notification', 'alert', 'notify'],
    needsMaster: false,
  },
  {
    key: 'suppressWhenFocused' as const,
    label: 'Only when DROIDEX is in the background',
    description: 'Skip the banner while this window is visible and focused.',
    keywords: ['background', 'focused', 'foreground', 'suppress', 'interrupt', 'only when'],
    needsMaster: true,
  },
  {
    key: 'playSound' as const,
    label: 'Play notification sound',
    description: 'Use the system notification sound with the banner.',
    keywords: ['play sound', 'sound', 'audio', 'chime', 'silent', 'volume'],
    needsMaster: true,
  },
  {
    key: 'notifyActiveSession' as const,
    label: 'Notify for the open chat',
    description: 'Also notify when the chat you are looking at finishes. Off = only other chats.',
    keywords: ['open chat', 'active chat', 'current session', 'active session'],
    needsMaster: true,
  },
] as const;

export const FINISH_NOTIFICATION_TEST_ACTION = {
  label: 'Send test notification',
  description: 'Verify system permission and sound. Always shows, even in the foreground.',
  keywords: ['test notification', 'test banner', 'permission', 'try notification', 'always shows'],
} as const;
