import React, { useMemo, useState } from 'react';

/**
 * DRAG & DROP (gap-fill) question renderer.
 *
 * The authoring format lives on TrainingQuestion: `dragTemplate` is a sentence
 * where every gap is written inline as [[answer]]; `dragDistractors` are extra
 * wrong words mixed into the word bank. A question is correct when every gap
 * holds its exact word (compared case-insensitively, trimmed).
 *
 * Interaction is TAP-FIRST so it works identically on the iOS till and on
 * desktop: tap a word chip to pick it up, tap a gap to drop it in, tap a
 * filled gap to send the word back to the bank. HTML5 drag-and-drop is layered
 * on top for pointer users — both paths drive the same state.
 *
 * The component owns nothing about grading UI flow: the parent passes
 * `checked` to flip into reveal mode and reads placements via onChange.
 */

export interface DragTemplateParts {
  /** Text segments around the gaps: segments.length === answers.length + 1. */
  segments: string[];
  /** The correct word for each gap, in order. */
  answers: string[];
}

/** Parse "Keep milk at [[8]] °C" into segments + answers. */
export function parseDragTemplate(template: string): DragTemplateParts {
  const segments: string[] = [];
  const answers: string[] = [];
  const re = /\[\[(.+?)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    segments.push(template.slice(last, m.index));
    answers.push((m[1] ?? '').trim());
    last = m.index + m[0].length;
  }
  segments.push(template.slice(last));
  return { segments, answers };
}

const norm = (s: string) => s.trim().toLowerCase();

/** True when every gap holds its exact word (case-insensitive, trimmed). */
export function isDragAnswerCorrect(answers: string[], placedWords: (string | null)[]): boolean {
  if (answers.length === 0) return false;
  return answers.every((a, i) => placedWords[i] !== null && norm(placedWords[i] as string) === norm(a));
}

interface BankChip {
  id: string;     // stable per-instance id, so duplicate words stay distinct
  word: string;
}

/** Deterministic shuffle keyed on the template so re-renders never reshuffle. */
function seededShuffle<T>(items: T[], seedText: string): T[] {
  let seed = 0;
  for (let i = 0; i < seedText.length; i++) seed = (seed * 31 + seedText.charCodeAt(i)) >>> 0;
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const a = arr[i];
    const b = arr[j];
    if (a !== undefined && b !== undefined) { arr[i] = b; arr[j] = a; }
  }
  return arr;
}

interface DragDropQuestionProps {
  template: string;
  distractors?: string[] | undefined;
  /** FIX-9 (TRN-002): when the server redacts the template (gaps blanked to
   *  [[⋯]]), the draggable words arrive separately — this bank replaces the
   *  template-derived one. */
  wordBank?: string[] | undefined;
  /** Placed chip ids per gap (null = empty). Parent owns this state. */
  value: (string | null)[];
  onChange: (next: (string | null)[]) => void;
  /** Reveal mode: colours each gap and shows the expected word under misses. */
  checked: boolean;
}

export const DragDropQuestion: React.FC<DragDropQuestionProps> = ({
  template, distractors = [], wordBank, value, onChange, checked,
}) => {
  const { segments, answers } = useMemo(() => parseDragTemplate(template), [template]);

  const chips: BankChip[] = useMemo(() => {
    const source = wordBank && wordBank.length ? wordBank : answers;
    const all = [...source, ...distractors].map((word, i) => ({ id: `w${i}`, word }));
    return seededShuffle(all, template);
  }, [template, answers, distractors, wordBank]);

  const chipById = useMemo(() => new Map(chips.map((c) => [c.id, c])), [chips]);
  const [selectedChip, setSelectedChip] = useState<string | null>(null);

  const placedIds = value;
  const placedSet = new Set(placedIds.filter(Boolean) as string[]);
  const bankChips = chips.filter((c) => !placedSet.has(c.id));

  const wordAt = (gapIdx: number): string | null => {
    const id = placedIds[gapIdx];
    return id ? (chipById.get(id)?.word ?? null) : null;
  };

  const placeChip = (gapIdx: number, chipId: string) => {
    const next = [...placedIds];
    // If the chip currently sits in another gap, vacate that gap first.
    const from = next.indexOf(chipId);
    if (from !== -1) next[from] = null;
    next[gapIdx] = chipId; // any chip already here returns to the bank implicitly
    onChange(next);
    setSelectedChip(null);
  };

  const clearGap = (gapIdx: number) => {
    if (checked) return;
    const next = [...placedIds];
    next[gapIdx] = null;
    onChange(next);
  };

  const handleGapTap = (gapIdx: number) => {
    if (checked) return;
    if (selectedChip) placeChip(gapIdx, selectedChip);
    else if (placedIds[gapIdx]) clearGap(gapIdx);
  };

  const gapCorrect = (gapIdx: number): boolean => {
    const w = wordAt(gapIdx);
    return w !== null && norm(w) === norm(answers[gapIdx] ?? '');
  };

  return (
    <div className="space-y-4">
      {/* --- The sentence with interactive gaps ------------------------- */}
      <div className="text-xs leading-[2.6] text-[#2E2A26] font-medium">
        {segments.map((seg, i) => (
          <React.Fragment key={i}>
            <span className="whitespace-pre-wrap">{seg}</span>
            {i < answers.length && (
              <span className="inline-block align-middle mx-0.5">
                <button
                  type="button"
                  onClick={() => handleGapTap(i)}
                  onDragOver={(e) => { if (!checked) e.preventDefault(); }}
                  onDrop={(e) => {
                    if (checked) return;
                    e.preventDefault();
                    const chipId = e.dataTransfer.getData('text/plain');
                    if (chipId && chipById.has(chipId)) placeChip(i, chipId);
                  }}
                  className={`min-w-[72px] px-3 py-1 rounded-lg border-2 border-dashed text-2xs font-extrabold text-center transition-all cursor-pointer align-middle ${
                    checked
                      ? gapCorrect(i)
                        ? 'bg-emerald-50 border-[#5FA777] text-emerald-800 border-solid'
                        : 'bg-rose-50 border-rose-300 text-rose-700 border-solid'
                      : placedIds[i]
                        ? 'bg-[#2E2A26] border-[#2E2A26] text-white border-solid'
                        : selectedChip
                          ? 'bg-[#A46832]/10 border-[#A46832] text-[#A46832] animate-pulse'
                          : 'bg-[#FBFBFC] border-neutral-300 text-neutral-400'
                  }`}
                >
                  {wordAt(i) ?? '· · ·'}
                </button>
                {checked && !gapCorrect(i) && (
                  <span className="block text-[9px] text-[#5FA777] font-black text-center mt-0.5">
                    ✓ {answers[i]}
                  </span>
                )}
              </span>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* --- The word bank ------------------------------------------------ */}
      {!checked && (
        <div className="bg-[#FBFBFC] border border-neutral-200 rounded-xl p-3 space-y-2">
          <p className="text-[9px] uppercase tracking-widest font-black text-neutral-400">
            Word bank — tap a word, then tap a gap (or drag it in)
          </p>
          <div className="flex flex-wrap gap-2">
            {bankChips.length === 0 ? (
              <span className="text-[10px] text-neutral-400 italic">All words placed — tap a gap to take one back.</span>
            ) : bankChips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', chip.id)}
                onClick={() => setSelectedChip((cur) => (cur === chip.id ? null : chip.id))}
                className={`px-3 py-1.5 rounded-full border text-2xs font-extrabold cursor-grab active:cursor-grabbing transition-all select-none ${
                  selectedChip === chip.id
                    ? 'bg-[#A46832] border-[#A46832] text-white shadow-md scale-105'
                    : 'bg-white border-[#EBDECE] text-[#2E2A26] hover:border-[#A46832] hover:text-[#A46832]'
                }`}
              >
                {chip.word}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
