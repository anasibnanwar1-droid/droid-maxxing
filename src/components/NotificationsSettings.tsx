import { useState } from 'react';
import { notify } from '../lib/desktop';
import {
  loadFinishNotificationSettings,
  saveFinishNotificationSettings,
  type FinishNotificationSettings,
} from '../lib/finishNotifications';
import { toast } from '../lib/toast';
import { Switch } from './Switch';

// Settings → Notifications. Desktop turn-finished banners live here (not under
// General or Personalization) so OS notification prefs stay easy to find.

type SettingKey = keyof FinishNotificationSettings;

const TOGGLES: {
  key: SettingKey;
  label: string;
  description: string;
  /** When true, the row is disabled if the master switch is off. */
  needsMaster?: boolean;
}[] = [
  {
    key: 'enabled',
    label: 'When a turn finishes',
    description: 'Show a desktop banner with a short snippet of the model reply.',
  },
  {
    key: 'suppressWhenFocused',
    label: 'Only when DROIDEX is in the background',
    description: 'Skip the banner while this window is visible and focused.',
    needsMaster: true,
  },
  {
    key: 'playSound',
    label: 'Play notification sound',
    description: 'Use the system notification sound with the banner.',
    needsMaster: true,
  },
  {
    key: 'notifyActiveSession',
    label: 'Notify for the open chat',
    description: 'Also notify when the chat you are looking at finishes. Off = only other chats.',
    needsMaster: true,
  },
];

function rowMatches(label: string, description: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return `${label} ${description}`.toLowerCase().includes(q);
}

export function NotificationsSettings({ highlightQuery = '' }: { highlightQuery?: string }) {
  const [settings, setSettings] = useState<FinishNotificationSettings>(() =>
    loadFinishNotificationSettings(),
  );
  const [testing, setTesting] = useState(false);

  const update = (key: SettingKey, value: boolean) => {
    setSettings((prev) => saveFinishNotificationSettings({ ...prev, [key]: value }));
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      // Always show, even in the foreground, so OS permission can be verified.
      await notify('DROIDEX', 'Test notification — turn finished snippet looks like this.', {
        silent: !settings.playSound,
        suppressWhenFocused: false,
      });
      toast.info('Test notification sent. Check Notification Center if you missed it.');
    } catch {
      toast.error(
        'Could not show a notification. Check system notification permissions for Electron/DROIDEX.',
      );
    } finally {
      setTesting(false);
    }
  };

  const testHighlighted = rowMatches(
    'Send test notification',
    'Verify system permission and sound',
    highlightQuery,
  );

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-7">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-droid-text">
          Notifications
        </h1>
        <p className="mt-1.5 max-w-xl text-[12px] leading-5 text-droid-text-muted">
          Desktop banners when a model turn finishes. Click a banner to jump back to that chat.
        </p>
      </div>

      <div className="mb-3 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
        Finish alerts
      </div>
      <div className="mb-6 overflow-hidden rounded-2xl border border-droid-border/80 bg-droid-surface">
        {TOGGLES.map(({ key, label, description, needsMaster }, index) => {
          const highlighted = rowMatches(label, description, highlightQuery);
          return (
            <div
              key={key}
              className={`flex items-center justify-between gap-4 px-4 py-3.5 transition-colors ${
                index > 0 ? 'border-t border-droid-border/50' : ''
              } ${highlighted ? 'bg-droid-accent/[0.07]' : ''}`}
            >
              <div className="min-w-0">
                <div className="text-[13px] tracking-tight text-droid-text">{label}</div>
                <div className="mt-0.5 text-[11.5px] leading-snug text-droid-text-muted">
                  {description}
                </div>
              </div>
              <Switch
                label={label}
                checked={settings[key]}
                disabled={Boolean(needsMaster && !settings.enabled)}
                onChange={(value) => {
                  update(key, value);
                }}
              />
            </div>
          );
        })}
        <div
          className={`flex items-center justify-between gap-4 border-t border-droid-border/50 px-4 py-3.5 transition-colors ${
            testHighlighted ? 'bg-droid-accent/[0.07]' : ''
          }`}
        >
          <div className="min-w-0">
            <div className="text-[13px] tracking-tight text-droid-text">Send test notification</div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-droid-text-muted">
              Verify system permission and sound. Always shows, even in the foreground.
            </div>
          </div>
          <button
            type="button"
            disabled={testing}
            onClick={() => {
              void sendTest();
            }}
            className="shrink-0 rounded-xl bg-droid-elevated/80 px-3 py-1.5 text-[12px] font-medium text-droid-text transition-colors hover:bg-droid-elevated disabled:opacity-60"
          >
            {testing ? 'Sending…' : 'Test'}
          </button>
        </div>
      </div>
    </div>
  );
}
