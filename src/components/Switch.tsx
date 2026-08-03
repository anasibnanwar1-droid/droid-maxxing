interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function Switch({ label, checked, onChange }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => {
        onChange(!checked);
      }}
      className={`w-10 h-6 rounded-full transition-colors shrink-0 flex items-center p-0.5 ${checked ? 'bg-droid-accent' : 'bg-droid-border'}`}
    >
      <span
        className={`w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}
      />
    </button>
  );
}
