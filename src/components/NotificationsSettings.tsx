import { useState } from 'react';
import {
  notify,
  requestNotificationPermission,
  type NotificationPermissionResult,
  type NotifyResult,
} from '../lib/desktop';
import {
  FINISH_NOTIFICATION_TEST_ACTION,
  FINISH_NOTIFICATION_TOGGLES,
} from '../lib/finishNotificationControls';
import {
  loadFinishNotificationSettings,
  saveFinishNotificationSettings,
  type FinishNotificationSettings,
} from '../lib/finishNotifications';
import { toast } from '../lib/toast';
import { Switch } from './Switch';

// Settings → Notifications. Desktop turn-finished banners.

type SettingKey = keyof FinishNotificationSettings;

function rowMatches(label: string, description: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return `${label} ${description}`.toLowerCase().includes(q);
}

function notificationFailureMessage(result: Exclude<NotifyResult, { shown: true }>): string {
  if (result.reason === 'permission_denied') {
    return 'Notifications are disabled for DROIDEX. Enable them in macOS System Settings.';
  }
  if (result.reason === 'unsupported') {
    return 'Desktop notifications are unavailable in this DROIDEX environment.';
  }
  if (result.reason === 'timeout') {
    return 'DROIDEX could not confirm the notification. Check macOS notification settings.';
  }
  return result.message ?? 'macOS could not show the notification. Check notification settings.';
}

function notificationPermissionFailureMessage(
  permission: Exclude<NotificationPermissionResult, 'granted'>,
): string {
  if (permission === 'denied') {
    return 'Notifications are disabled for DROIDEX. Enable them in macOS System Settings.';
  }
  if (permission === 'default') {
    return 'Notification permission was not granted. Try again when you are ready.';
  }
  return 'Desktop notifications are unavailable in this DROIDEX environment.';
}

export function NotificationsSettings({ highlightQuery = '' }: { highlightQuery?: string }) {
  const [settings, setSettings] = useState<FinishNotificationSettings>(() =>
    loadFinishNotificationSettings(),
  );
  const [testing, setTesting] = useState(false);

  const update = (key: SettingKey, value: boolean) => {
    setSettings((prev) => saveFinishNotificationSettings({ ...prev, [key]: value }));
  };

  const enableNotifications = async () => {
    const permission = await requestNotificationPermission();
    if (permission !== 'granted') {
      toast.error(notificationPermissionFailureMessage(permission));
      return;
    }
    update('enabled', true);
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const permission = await requestNotificationPermission();
      if (permission !== 'granted') {
        toast.error(notificationPermissionFailureMessage(permission));
        return;
      }
      const result = await notify(
        'DROIDEX',
        'Test notification — turn finished snippet looks like this.',
        {
          silent: !settings.playSound,
        },
      );
      if (result.shown) {
        toast.info('Test notification shown.');
      } else {
        toast.error(notificationFailureMessage(result));
      }
    } catch {
      toast.error(
        'Could not show a notification. Check system notification permissions for Electron/DROIDEX.',
      );
    } finally {
      setTesting(false);
    }
  };

  const testHighlighted = rowMatches(
    FINISH_NOTIFICATION_TEST_ACTION.label,
    FINISH_NOTIFICATION_TEST_ACTION.description,
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
        {FINISH_NOTIFICATION_TOGGLES.map(({ key, label, description, needsMaster }, index) => {
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
                disabled={needsMaster && !settings.enabled}
                onChange={(value) => {
                  if (key === 'enabled' && value) {
                    void enableNotifications();
                  } else {
                    update(key, value);
                  }
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
            <div className="text-[13px] tracking-tight text-droid-text">
              {FINISH_NOTIFICATION_TEST_ACTION.label}
            </div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-droid-text-muted">
              {FINISH_NOTIFICATION_TEST_ACTION.description}
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
