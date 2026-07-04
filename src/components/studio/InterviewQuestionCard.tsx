import { ImagePlus, X } from 'lucide-react';
import { useRef } from 'react';
import type { Answer } from './designBrief';
import type { InterviewQuestion } from './interviewQuestions';

/** One interview question: pick options, write freely, and (where allowed) paste
 *  or attach reference images. Controlled — the brief owns the answer. */
export default function InterviewQuestionCard({
  question,
  answer,
  onChange,
}: {
  question: InterviewQuestion;
  answer: Answer;
  onChange: (answer: Answer) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  const toggle = (value: string) => {
    if (question.multi) {
      const has = answer.selected.includes(value);
      onChange({
        ...answer,
        selected: has ? answer.selected.filter((v) => v !== value) : [...answer.selected, value],
      });
    } else {
      onChange({ ...answer, selected: answer.selected[0] === value ? [] : [value] });
    }
  };

  const addImages = async (files: FileList | File[]) => {
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
    const urls = await Promise.all(imgs.map(readAsDataUrl));
    onChange({ ...answer, images: [...answer.images, ...urls].slice(0, 8) });
  };

  return (
    <div>
      <h2 className="text-[20px] font-medium tracking-tight text-white/90">{question.title}</h2>
      {question.subtitle && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-white/45">{question.subtitle}</p>
      )}

      {question.options.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {question.options.map((o) => {
            const on = answer.selected.includes(o.value);
            return (
              <button
                key={o.value}
                onClick={() => toggle(o.value)}
                className={`rounded-full border px-3.5 py-1.5 text-[13px] transition-colors ${
                  on
                    ? 'border-[#ee6018]/60 bg-[#ee6018]/15 text-white'
                    : 'border-white/12 text-white/60 hover:border-white/25 hover:text-white/90'
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}

      {question.allowText && (
        <textarea
          value={answer.text}
          onChange={(e) => onChange({ ...answer, text: e.target.value })}
          onPaste={(e) => {
            if (!question.allowImages) return;
            const imgs = Array.from(e.clipboardData.files).filter((f) =>
              f.type.startsWith('image/'),
            );
            if (imgs.length > 0) {
              e.preventDefault();
              void addImages(imgs);
            }
          }}
          rows={question.allowImages ? 3 : 2}
          placeholder={question.placeholder}
          className="mt-4 w-full resize-none rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white/90 placeholder:text-white/30 focus:border-[#ee6018]/40 focus:outline-none"
        />
      )}

      {question.allowImages && (
        <div className="mt-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void addImages(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            {answer.images.map((src, i) => (
              <span key={i} className="group relative">
                <img
                  src={src}
                  alt="reference"
                  className="h-16 w-16 rounded-lg object-cover ring-1 ring-white/10"
                />
                <button
                  onClick={() =>
                    onChange({ ...answer, images: answer.images.filter((_, j) => j !== i) })
                  }
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/85 text-white/70 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              onClick={() => fileRef.current?.click()}
              className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/15 text-white/35 transition-colors hover:border-[#ee6018]/50 hover:text-white/70"
            >
              <ImagePlus className="h-4 w-4" />
              <span className="text-[9px]">paste</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
