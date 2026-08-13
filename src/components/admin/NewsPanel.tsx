import React, { useState } from 'react';
import { Trash, X } from 'lucide-react';
import type { NewsPost, PublishableContentTable } from '../../types';
import { businessTodayISO } from '../../lib/businessDate';
import { createClientId } from '../../lib/clientId';
import { useSingleFlight } from '../../hooks/useSingleFlight';
import { PublicationBadge, PublishButton } from './PublicationControls';

interface NewsPanelProps {
  posts: NewsPost[];
  staffDataStatus: 'idle' | 'loading' | 'live' | 'error';
  canPublish: boolean;
  publicationBusyAction: string | null;
  publishPosts: (next: NewsPost[] | ((previous: NewsPost[]) => NewsPost[])) => Promise<boolean>;
  onTogglePublication: (table: PublishableContentTable, id: string, publish: boolean, label: string) => Promise<void>;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  logAction: (module: string, action: string) => void;
}

const freshNewsDraft = (): Partial<NewsPost> => ({ title: '', content: '', category: 'Announcement', status: 'draft', image: '' });

/** News draft state is local; publication remains on the authoritative RPC path. */
export const NewsPanel = React.memo(function NewsPanel({
  posts,
  staffDataStatus,
  canPublish,
  publicationBusyAction,
  publishPosts,
  onTogglePublication,
  addToast,
  logAction,
}: NewsPanelProps) {
  const [draft, setDraft] = useState<Partial<NewsPost>>(freshNewsDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const mutation = useSingleFlight();
  const busy = mutation.isBusy || publicationBusyAction !== null;

  const closeEditor = (): void => {
    if (busy) return;
    setEditorOpen(false);
    setEditingId(null);
    setDraft(freshNewsDraft());
  };
  const openEditor = (post?: NewsPost): void => {
    setEditingId(post?.id || null);
    setDraft(post ? { ...post } : freshNewsDraft());
    setEditorOpen(true);
  };

  const savePost = async (): Promise<void> => mutation.run('news-save', async () => {
    const title = String(draft.title || '').trim();
    const content = String(draft.content || '').trim();
    if (!title || !content) {
      addToast('Enter a real news title and article text before saving.', 'error');
      return;
    }
    const existing = editingId ? posts.find((post) => post.id === editingId) : undefined;
    const nextPost: NewsPost = {
      id: editingId || createClientId('news'),
      title,
      content,
      category: (draft.category || 'Announcement') as NewsPost['category'],
      date: existing?.date || businessTodayISO(),
      status: existing?.status || 'draft',
      image: String(draft.image || '').trim(),
      ...(existing?.tagColor ? { tagColor: existing.tagColor } : {}),
      ...(existing?.slug ? { slug: existing.slug } : {}),
    };
    const saved = await publishPosts((previous) => editingId
      ? previous.map((post) => post.id === editingId ? nextPost : post)
      : [nextPost, ...previous]);
    if (!saved) return;
    logAction('News Pressroom', `${editingId ? 'Updated' : 'Created'} news draft "${title}"`);
    addToast(`News post "${title}" saved${existing?.status === 'published' ? ' and remains live' : ' as a draft'}.`, 'success');
    setEditorOpen(false);
    setEditingId(null);
    setDraft(freshNewsDraft());
  });

  const deletePost = async (post: NewsPost): Promise<void> => mutation.run(`news-delete:${post.id}`, async () => {
    if (post.status === 'published') {
      addToast(`"${post.title}" is live — unpublish it before deleting.`, 'error');
      return;
    }
    if (!window.confirm(`Delete news draft "${post.title}"?`)) return;
    const saved = await publishPosts((previous) => previous.filter((item) => item.id !== post.id));
    if (!saved) return;
    logAction('News Pressroom', `Purged company updates block "${post.title}"`);
    addToast('News post deleted.', 'warning');
    if (editingId === post.id) {
      setEditorOpen(false);
      setEditingId(null);
      setDraft(freshNewsDraft());
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div><h1 className="font-display font-black text-2xl">Company News CMS Pressroom</h1><p className="text-2xs text-[#2E2A26]/70">Publish public update releases, Grand Opening updates, and internal store huddle notifications.</p></div>
        <button type="button" onClick={() => openEditor()} disabled={busy || staffDataStatus !== 'live'} className="px-4 py-2 bg-[#A46832] disabled:opacity-50 text-white rounded-full text-2xs font-black uppercase tracking-wider">New Announcement</button>
      </div>

      {editorOpen && (
        <div className="bg-white border border-[#EBDECE] rounded-2xl p-5 space-y-4 text-xs">
          <div className="flex items-center justify-between gap-3"><div><h2 className="font-black text-base">{editingId ? 'Edit news post' : 'Create news draft'}</h2><p className="text-[10px] text-stone-500">Saving creates or updates the record. Use Publish on the card when it is ready for customers.</p></div><button type="button" onClick={closeEditor} disabled={busy} className="p-2 rounded-full hover:bg-stone-100 disabled:opacity-50" aria-label="Close news editor"><X className="h-4 w-4" /></button></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="space-y-1 md:col-span-2"><span className="font-bold">Title *</span><input value={draft.title || ''} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} className="w-full border rounded-lg p-2" /></label>
            <label className="space-y-1"><span className="font-bold">Category</span><select value={draft.category || 'Announcement'} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value as NewsPost['category'] }))} className="w-full border rounded-lg p-2 bg-white">{(['Store Opening', 'New Product', 'Team Story', 'Announcement', 'Promotion'] as NewsPost['category'][]).map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
            <label className="space-y-1"><span className="font-bold">Image URL (optional)</span><input value={draft.image || ''} onChange={(event) => setDraft((current) => ({ ...current, image: event.target.value }))} className="w-full border rounded-lg p-2" /></label>
            <label className="space-y-1 md:col-span-2"><span className="font-bold">Article text *</span><textarea value={draft.content || ''} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} rows={6} className="w-full border rounded-lg p-2" /></label>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={closeEditor} disabled={busy} className="px-4 py-2 rounded-full border font-bold disabled:opacity-50">Cancel</button><button type="button" onClick={() => { void savePost(); }} disabled={busy || staffDataStatus !== 'live'} className="px-4 py-2 rounded-full bg-[#A46832] text-white font-black disabled:opacity-50">{mutation.activeKey === 'news-save' ? 'Saving…' : 'Save draft'}</button></div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-2xs font-sans">
        {posts.map((post) => (
          <div key={post.id} className="p-5 bg-white rounded-2xl border border-[#EBDECE]/50 space-y-2.5">
            <div className="flex justify-between items-center pb-1.5 border-b"><span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded ${post.tagColor || 'bg-[#7CC0C7]/40 text-sky-850'}`}>{post.category}</span><span className="text-[10px] text-gray-400 font-mono">{post.date}</span></div>
            <h3 className="font-extrabold text-sm text-[#2E2A26]">{post.title}</h3><p className="text-stone-500 font-medium leading-relaxed">{post.content}</p>
            <div className="pt-2 border-t flex justify-between items-center text-[10px]">
              <div className="flex items-center gap-1.5"><PublicationBadge live={post.status === 'published'} /><PublishButton table="news_posts" canPublish={canPublish} busyAction={publicationBusyAction} onToggle={onTogglePublication} id={post.id} live={post.status === 'published'} label={`"${post.title}"`} /></div>
              <button type="button" onClick={() => openEditor(post)} disabled={busy} className="text-[#A46832] font-black hover:underline disabled:opacity-50">Edit</button>
              <button type="button" aria-label={`Delete news post ${post.title}`} onClick={() => { void deletePost(post); }} disabled={busy} className="text-red-500 hover:bg-red-50 min-h-11 min-w-11 rounded-full grid place-items-center cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"><Trash className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        ))}
        {posts.length === 0 && <div className="md:col-span-2 rounded-2xl border border-dashed border-[#EBDECE] bg-white p-8 text-center text-sm text-[#2E2A26]/60">No news drafts or published posts.</div>}
      </div>
    </div>
  );
});
