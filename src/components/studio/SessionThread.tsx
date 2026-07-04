import { Loader2, Wrench } from 'lucide-react';
import type { TranscriptEvent } from '../../types/bridge';

/**
 * Renders a design session's live transcript in the studio thread — user turns,
 * agent text, thinking, tool activity, and errors. Events arrive already coalesced
 * (text deltas merged, tool calls merged by id) from the store.
 */
export default function SessionThread({
  events,
  streaming,
}: {
  events: TranscriptEvent[];
  streaming?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-4">
      {events.map((e) => (
        <Turn key={e.id} e={e} />
      ))}
      {streaming && (
        <div className="flex items-center gap-2 px-1 py-1 text-[12px] text-droid-text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          working…
        </div>
      )}
    </div>
  );
}

function Turn({ e }: { e: TranscriptEvent }) {
  if (e.author === 'user') {
    if (!e.text?.trim()) return null;
    return (
      <div className="self-end max-w-[85%]">
        <div className="rounded-2xl rounded-br-md bg-[#ee6018]/12 px-3.5 py-2 text-[13px] leading-relaxed text-droid-text">
          {clamp(e.text, 600)}
        </div>
      </div>
    );
  }

  switch (e.kind) {
    case 'text':
      return e.text?.trim() ? (
        <div className="max-w-[94%] whitespace-pre-wrap text-[13px] leading-relaxed text-droid-text-secondary">
          {e.text}
        </div>
      ) : null;
    case 'thinking':
      return e.text?.trim() ? (
        <div className="max-w-[94%] border-l-2 border-droid-border pl-2.5 text-[12px] italic leading-relaxed text-droid-text-muted">
          {clamp(e.text, 400)}
        </div>
      ) : null;
    case 'tool_call':
    case 'tool_result':
      return (
        <div className="flex items-center gap-1.5 text-[11.5px] text-droid-text-muted">
          <Wrench className="h-3 w-3 shrink-0 text-[#ee6018]/70" />
          <span className="font-mono">{e.toolName ?? 'tool'}</span>
          {e.kind === 'tool_result' && <span className="text-[#7aa37a]">✓</span>}
        </div>
      );
    case 'error':
      return e.text?.trim() ? (
        <div className="rounded-lg border border-[#c0563a]/30 bg-[#c0563a]/10 px-3 py-1.5 text-[12px] text-[#e0806a]">
          {clamp(e.text, 400)}
        </div>
      ) : null;
    case 'status':
    case 'compaction':
      return e.text?.trim() ? (
        <div className="px-1 text-[11px] text-droid-text-muted/80">{clamp(e.text, 200)}</div>
      ) : null;
    default:
      return null;
  }
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
