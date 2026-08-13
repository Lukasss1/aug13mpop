import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { KnowledgeArticle } from '../../types';
import { businessTodayISO } from '../../lib/businessDate';
import { createClientId } from '../../lib/clientId';
import { useSingleFlight } from '../../hooks/useSingleFlight';

interface KnowledgeBasePanelProps {
  articles: KnowledgeArticle[];
  operatorName: string;
  staffDataStatus: 'idle' | 'loading' | 'live' | 'error';
  publishArticles: (next: KnowledgeArticle[] | ((previous: KnowledgeArticle[]) => KnowledgeArticle[])) => Promise<boolean>;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  logAction: (module: string, action: string) => void;
}

const freshArticleDraft = (): Partial<KnowledgeArticle> => ({
  title: '', category: 'recipes', content: '', readingTime: '', steps: [],
});

/** SOP editor owns its draft and mutation lock; no keystroke reaches AdminPanel. */
export const KnowledgeBasePanel = React.memo(function KnowledgeBasePanel({
  articles,
  operatorName,
  staffDataStatus,
  publishArticles,
  addToast,
  logAction,
}: KnowledgeBasePanelProps) {
  const [draft, setDraft] = useState<Partial<KnowledgeArticle>>(freshArticleDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const mutation = useSingleFlight();

  const closeEditor = (): void => {
    if (mutation.isBusy) return;
    setEditorOpen(false);
    setEditingId(null);
    setDraft(freshArticleDraft());
  };

  const openEditor = (article?: KnowledgeArticle): void => {
    if (!operatorName.trim()) {
      addToast('Your signed-in staff profile needs a real name before publishing an SOP.', 'error');
      return;
    }
    setEditingId(article?.id || null);
    setDraft(article ? { ...article, steps: [...(article.steps || [])] } : freshArticleDraft());
    setEditorOpen(true);
  };

  const saveArticle = async (): Promise<void> => mutation.run('kb-save', async () => {
    const title = String(draft.title || '').trim();
    const content = String(draft.content || '').trim();
    const author = operatorName.trim();
    const suppliedReadingTime = String(draft.readingTime || '').trim();
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const estimatedMinutes = Math.max(1, Math.ceil(wordCount / 200));
    const readingTime = suppliedReadingTime || `${estimatedMinutes} min${estimatedMinutes === 1 ? '' : 's'}`;
    const steps = Array.isArray(draft.steps) ? draft.steps.map((step) => String(step).trim()).filter(Boolean) : [];
    if (!title || !content) {
      addToast('Enter a title and the full SOP content before saving.', 'error');
      return;
    }
    if (!author) {
      addToast('Your signed-in staff profile needs a real name before publishing an SOP.', 'error');
      return;
    }

    const nextArticle: KnowledgeArticle = {
      id: editingId || createClientId('kb'),
      title,
      category: (draft.category || 'recipes') as KnowledgeArticle['category'],
      content,
      steps,
      readingTime,
      author,
      lastUpdated: businessTodayISO(),
    };
    const saved = await publishArticles((previous) => editingId
      ? previous.map((article) => article.id === editingId ? nextArticle : article)
      : [nextArticle, ...previous]);
    if (!saved) return;
    logAction('Knowledge Base', `${editingId ? 'Updated' : 'Created'} SOP "${title}"`);
    addToast(`SOP "${title}" ${editingId ? 'updated' : 'created'}.`, 'success');
    setEditorOpen(false);
    setEditingId(null);
    setDraft(freshArticleDraft());
  });

  const deleteArticle = async (article: KnowledgeArticle): Promise<void> => mutation.run(`kb-delete:${article.id}`, async () => {
    if (!window.confirm(`Delete SOP "${article.title}"? Staff will no longer see it.`)) return;
    const saved = await publishArticles((previous) => previous.filter((item) => item.id !== article.id));
    if (!saved) return;
    logAction('Knowledge Base', `Deleted SOP "${article.title}"`);
    addToast(`SOP "${article.title}" deleted.`, 'warning');
    if (editingId === article.id) {
      setEditorOpen(false);
      setEditingId(null);
      setDraft(freshArticleDraft());
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div>
          <h1 className="font-display font-black text-2xl">Knowledge Base &amp; Standard SOPs</h1>
          <p className="text-2xs text-[#2E2A26]/70">Create and maintain the real instructions staff see in their portal.</p>
        </div>
        <button type="button" onClick={() => openEditor()} disabled={mutation.isBusy || staffDataStatus !== 'live'} className="px-4 py-2 bg-[#A46832] disabled:opacity-50 text-white rounded-full text-2xs font-black uppercase tracking-wider">Create SOP</button>
      </div>

      {editorOpen && (
        <div className="bg-white border border-[#EBDECE] rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div><h2 className="font-black text-base">{editingId ? 'Edit SOP' : 'Create SOP'}</h2><p className="text-[10px] text-stone-500">Only publish instructions that have been reviewed for the store.</p></div>
            <button type="button" onClick={closeEditor} disabled={mutation.isBusy} className="p-2 rounded-full hover:bg-stone-100 disabled:opacity-50" aria-label="Close SOP editor"><X className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <label className="space-y-1"><span className="font-bold">Title *</span><input value={draft.title || ''} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} className="w-full border rounded-lg p-2" /></label>
            <label className="space-y-1"><span className="font-bold">Category</span><select value={draft.category || 'recipes'} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value as KnowledgeArticle['category'] }))} className="w-full border rounded-lg p-2 bg-white">{(['recipes', 'opening', 'closing', 'cleaning', 'service', 'equipment', 'safety', 'policies'] as KnowledgeArticle['category'][]).map((category) => <option key={category} value={category}>{category.replace('_', ' ')}</option>)}</select></label>
            <label className="space-y-1"><span className="font-bold">Reading time</span><input value={draft.readingTime || ''} onChange={(event) => setDraft((current) => ({ ...current, readingTime: event.target.value }))} placeholder="e.g. 5 mins" className="w-full border rounded-lg p-2" /></label>
            <label className="space-y-1 md:col-span-2"><span className="font-bold">Instructions *</span><textarea value={draft.content || ''} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} rows={6} className="w-full border rounded-lg p-2" placeholder="Write the approved procedure in clear language." /></label>
            <label className="space-y-1 md:col-span-2"><span className="font-bold">Optional step list</span><textarea value={(draft.steps || []).join('\n')} onChange={(event) => setDraft((current) => ({ ...current, steps: event.target.value.split('\n') }))} rows={5} className="w-full border rounded-lg p-2" placeholder="One step per line" /></label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeEditor} disabled={mutation.isBusy} className="px-4 py-2 rounded-full border font-bold text-xs disabled:opacity-50">Cancel</button>
            <button type="button" onClick={() => { void saveArticle(); }} disabled={mutation.isBusy || staffDataStatus !== 'live'} className="px-4 py-2 rounded-full bg-[#A46832] text-white font-black text-xs disabled:opacity-50">{mutation.activeKey === 'kb-save' ? 'Saving…' : 'Save SOP'}</button>
          </div>
        </div>
      )}

      {articles.length === 0 ? (
        <div className="p-6 bg-white rounded-2xl border border-dashed border-[#EBDECE] text-sm text-stone-500">No SOPs have been published yet. Create only the procedures your team should actually follow.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {articles.map((article) => (
            <div key={article.id} className="p-5 bg-white rounded-2xl border border-[#EBDECE]/50 space-y-2.5 text-2xs font-sans">
              <div className="flex justify-between items-center pb-1 border-b gap-2"><span className="text-[9px] bg-[#EBDECE] text-zinc-600 px-2 py-0.5 rounded font-bold uppercase tracking-wide">{article.category}</span><span className="text-[10px] text-zinc-400 font-mono">Updated: {article.lastUpdated}</span></div>
              <h3 className="font-extrabold text-[#2E2A26] text-sm">{article.title}</h3>
              <p className="text-stone-500 font-medium leading-relaxed whitespace-pre-wrap">{article.content}</p>
              {!!article.steps?.length && <ol className="list-decimal pl-5 text-stone-600 space-y-1">{article.steps.map((step, index) => <li key={`${article.id}-step-${index}`}>{step}</li>)}</ol>}
              <div className="pt-2 border-t flex items-center justify-between gap-3"><p className="text-[10px] text-stone-500 font-bold">Written by <b>{article.author}</b> · {article.readingTime}</p><div className="flex gap-2"><button type="button" onClick={() => openEditor(article)} disabled={mutation.isBusy} className="text-[#A46832] font-black hover:underline disabled:opacity-50">Edit</button><button type="button" onClick={() => { void deleteArticle(article); }} disabled={mutation.isBusy} className="text-red-500 font-black hover:underline disabled:opacity-50">Delete</button></div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
