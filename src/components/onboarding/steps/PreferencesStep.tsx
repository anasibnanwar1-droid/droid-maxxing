import { useEffect, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';

import type { OnboardingController } from '../../../hooks/useOnboarding';
import {
  EDITOR_OPTIONS,
  getDefaultEditor,
  normalizeEditorId,
  setDefaultEditor,
  type EditorId,
} from '../../../lib/editorOpen';
import { listEditors } from '../../../lib/desktop';
import { EditorIcon } from '../../EditorIcon';
import { BackButton, Panel, PrimaryButton, StepLabel, StepTitle, ToggleRow } from '../kit';

export function PreferencesStep({
  controller,
  onNext,
  onBack,
}: {
  controller: OnboardingController;
  onNext: () => void;
  onBack: () => void;
}) {
  const [editors, setEditors] = useState<EditorId[]>([]);
  // Prefer onboarding state, then any previously saved default editor, so a
  // returning user's Cursor/Finder/Terminal choice isn't reset to VS Code.
  const [editor, setEditor] = useState<EditorId>(
    controller.onboarding?.defaultEditor === undefined
      ? getDefaultEditor()
      : normalizeEditorId(controller.onboarding.defaultEditor),
  );
  const [cliAuto, setCliAuto] = useState(controller.onboarding?.cliAutoUpdate ?? true);
  const [appAuto, setAppAuto] = useState(controller.onboarding?.appAutoUpdate ?? true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void listEditors().then((ids) => {
      setEditors(ids);
      if (ids.length && !ids.includes(editor)) setEditor(ids[0]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editorOptions = EDITOR_OPTIONS.filter((o) => editors.includes(o.id));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await controller.patch({
        defaultEditor: editor,
        cliAutoUpdate: cliAuto,
        appAutoUpdate: appAuto,
      });
      setDefaultEditor(editor);
      onNext();
    } catch {
      setSaveError("Couldn't save your preferences. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full max-w-[520px] mx-auto">
      <StepLabel>Preferences</StepLabel>
      <StepTitle
        title="Make it yours."
        sub="Set your defaults. Existing Droid settings are imported automatically, and all of this can change later."
      />

      <Panel className="mb-7">
        <div className="px-4 py-3.5">
          <div className="text-[13.5px] text-droid-text mb-2.5">Default editor</div>
          <div className="flex flex-wrap gap-2">
            {editorOptions.length === 0 && (
              <span className="text-[12px] text-droid-text-muted">No editors detected.</span>
            )}
            {editorOptions.map((o) => (
              <button
                key={o.id}
                disabled={saving}
                onClick={() => {
                  setEditor(o.id);
                }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  editor === o.id
                    ? 'border-droid-border-hover bg-droid-elevated text-droid-text'
                    : 'border-droid-border text-droid-text-secondary hover:border-droid-border-hover'
                }`}
              >
                <EditorIcon editor={o.id} size={15} />
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <ToggleRow
          label="Keep the Droid CLI up to date"
          sub="Updates silently on launch."
          checked={cliAuto}
          onChange={setCliAuto}
          disabled={saving}
        />
        <ToggleRow
          label="Check for DROIDEX updates"
          sub="Checks for new app builds on launch."
          checked={appAuto}
          onChange={setAppAuto}
          disabled={saving}
        />
      </Panel>

      {saveError && <p className="text-[12px] text-droid-red mb-3">{saveError}</p>}

      <div className="flex items-center gap-2">
        <BackButton onClick={onBack} disabled={saving} />
        <div className="flex-1">
          <PrimaryButton
            onClick={() => {
              void save();
            }}
            disabled={saving}
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Saving…
              </>
            ) : (
              <>
                Continue <ArrowRight className="w-4 h-4" />
              </>
            )}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
