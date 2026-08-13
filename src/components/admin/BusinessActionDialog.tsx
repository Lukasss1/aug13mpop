import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export interface BusinessActionField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'textarea';
  value: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  rows?: number;
  help?: string;
}

interface BusinessActionDialogProps {
  open: boolean;
  title: string;
  description?: string | undefined;
  fields: BusinessActionField[];
  submitLabel: string;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => Promise<void> | void;
}

/** A small, accessible replacement for browser prompt() in owner workflows.
 * Values stay in the dialog when submission fails, so an e-mail draft or HR
 * value is never lost merely because the network had a problem. */
export default function BusinessActionDialog({
  open, title, description, fields, submitLabel, busy = false, onClose, onSubmit,
}: BusinessActionDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const firstFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const wasOpenRef = useRef(false);

  // Initialise only on the closed → open transition. Parent re-renders while a
  // request is busy must not erase a message draft after a failed submission.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setValues(Object.fromEntries(fields.map((field) => [field.name, field.value])));
      const id = window.setTimeout(() => firstFieldRef.current?.focus(), 0);
      wasOpenRef.current = true;
      return () => window.clearTimeout(id);
    }
    if (!open) wasOpenRef.current = false;
    return undefined;
  }, [open, fields]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] bg-black/45 p-4 flex items-center justify-center" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="business-action-title"
        onSubmit={(event) => { event.preventDefault(); void onSubmit(values); }}
        className="w-full max-w-lg rounded-3xl bg-white border border-[#EBDECE] shadow-2xl p-6 space-y-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="business-action-title" className="font-display text-xl font-black text-[#2E2A26]">{title}</h2>
            {description && <p className="mt-1 text-sm text-[#2E2A26]/70 leading-relaxed">{description}</p>}
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close dialog" className="min-h-11 min-w-11 rounded-full grid place-items-center hover:bg-stone-100 disabled:opacity-50">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          {fields.map((field, index) => {
            const common = {
              id: `business-action-${field.name}`,
              name: field.name,
              required: field.required,
              value: values[field.name] ?? '',
              onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((prev) => ({ ...prev, [field.name]: event.target.value })),
              className: 'w-full min-h-11 rounded-xl border border-[#D8C8B8] bg-white px-3 py-2 text-base sm:text-sm text-[#2E2A26] focus:outline-none focus:ring-2 focus:ring-[#A46832]/30',
            };
            return (
              <label key={field.name} htmlFor={common.id} className="block space-y-1.5 text-sm font-bold text-[#2E2A26]">
                <span>{field.label}</span>
                {field.type === 'textarea' ? (
                  <textarea
                    {...common}
                    ref={index === 0 ? (node) => { firstFieldRef.current = node; } : undefined}
                    rows={field.rows ?? 8}
                  />
                ) : (
                  <input
                    {...common}
                    ref={index === 0 ? (node) => { firstFieldRef.current = node; } : undefined}
                    type={field.type ?? 'text'}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                  />
                )}
                {field.help && <span className="block text-xs font-normal text-[#2E2A26]/60">{field.help}</span>}
              </label>
            );
          })}
        </div>

        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={busy} className="min-h-11 rounded-full border border-[#D8C8B8] px-5 text-xs font-black uppercase tracking-wider disabled:opacity-50">Cancel</button>
          <button type="submit" disabled={busy} className="min-h-11 rounded-full bg-[#2E2A26] px-6 text-xs font-black uppercase tracking-wider text-white hover:bg-[#A46832] disabled:opacity-50">
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
