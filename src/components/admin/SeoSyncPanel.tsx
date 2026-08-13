/**
 * @file SeoSyncPanel.tsx
 * @description Admin "Website → SEO" status panel (OPT-02-C1.2). Proves to the
 * owner that the static crawler pages and build-bound, hash-verified public fallback snapshot match the live public database.
 *
 * It fetches /seo-manifest.json and compares its `contentHash` to a hash of the
 * CURRENTLY hydrated public content (computed with the same canonical hash the
 * build uses). "SEO synced" can appear ONLY when the two hashes match — a
 * successful database save alone never turns the light green, because the
 * manifest changes only after a real rebuild/redeploy. The deploy-hook URL is
 * never exposed here (the browser doesn't hold it).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { SearchCheck, RefreshCw, CheckCircle2, AlertTriangle, Clock, HelpCircle } from 'lucide-react';
import type { LiveSeoSummary, SeoRebuildStatus } from '../../lib/seoRebuild';
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from '../../lib/requestTimeout';

interface Manifest {
  contentHash?: string;
  source?: string;
  generatedAt?: string;
  counts?: Record<string, number>;
}

interface SeoSyncPanelProps {
  live: LiveSeoSummary;
  deploymentMode: string;
  rebuildStatus: SeoRebuildStatus;
  canRebuild: boolean;
  /** Trigger a manual rebuild (area 'manual'); resolves when the request settles. */
  onRebuild: () => Promise<void> | void;
}

type Verdict = 'synced' | 'queued' | 'deferred' | 'out_of_date' | 'failed' | 'unavailable' | 'loading';

const SHORT = (h?: string) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : '—');

export const SeoSyncPanel: React.FC<SeoSyncPanelProps> = ({
  live, deploymentMode, rebuildStatus, canRebuild, onRebuild,
}) => {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestError, setManifestError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);

  const loadManifest = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout('/seo-manifest.json', { cache: 'no-store' }, REQUEST_TIMEOUT_MS.read);
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as Manifest;
      setManifest(json);
      setManifestError(false);
    } catch {
      setManifest(null);
      setManifestError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload the manifest on mount and whenever a rebuild attempt changes state
  // (a freshly-deployed manifest may now match).
  useEffect(() => { void loadManifest(); }, [loadManifest, rebuildStatus.at]);

  const matches = Boolean(manifest?.contentHash && manifest.contentHash === live.contentHash);

  const verdict: Verdict = (() => {
    if (loading && !manifest && !manifestError) return 'loading';
    if (manifestError || !manifest) return 'unavailable';
    if (matches) return 'synced';
    if (rebuildStatus.state === 'failed' || rebuildStatus.state === 'not_configured') return 'failed';
    if (rebuildStatus.state === 'queued') return 'queued';
    if (rebuildStatus.state === 'deferred') return 'deferred';
    return 'out_of_date';
  })();

  const META: Record<Verdict, { label: string; note: string; className: string; Icon: typeof SearchCheck }> = {
    synced: {
      label: 'SEO synced',
      note: 'Static crawler pages and the opening fallback snapshot match the live public data.',
      className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      Icon: CheckCircle2,
    },
    queued: {
      label: 'SEO refresh queued',
      note: 'A legacy queued refresh is still pending. New production refreshes use the protected release path.',
      className: 'bg-sky-50 text-sky-700 border-sky-200',
      Icon: Clock,
    },
    deferred: {
      label: 'SEO refresh pending protected release',
      note: 'Public content is live now. Static crawler pages refresh with the next signed website release.',
      className: 'bg-amber-50 text-amber-800 border-amber-200',
      Icon: Clock,
    },
    out_of_date: {
      label: 'SEO out of date',
      note: 'The live public content has changed since the last static build. Record the refresh need; crawler pages and the opening fallback update with the next protected release.',
      className: 'bg-amber-50 text-amber-800 border-amber-200',
      Icon: AlertTriangle,
    },
    failed: {
      label: rebuildStatus.state === 'not_configured' ? 'SEO status not configured' : 'SEO refresh handoff failed',
      note: rebuildStatus.state === 'not_configured'
        ? 'Static SEO configuration is unavailable.'
        : 'Content is live, but the refresh handoff was not recorded. Retry the status action.',
      className: 'bg-red-50 text-red-700 border-red-200',
      Icon: AlertTriangle,
    },
    unavailable: {
      label: 'SEO status unavailable',
      note: 'No /seo-manifest.json was found. It is produced by the build; deploy once to populate it.',
      className: 'bg-gray-50 text-gray-600 border-gray-200',
      Icon: HelpCircle,
    },
    loading: {
      label: 'Checking SEO…',
      note: 'Reading the deployed manifest.',
      className: 'bg-gray-50 text-gray-500 border-gray-200',
      Icon: RefreshCw,
    },
  };

  const meta = META[verdict];
  const Icon = meta.Icon;

  const handleRebuild = async () => {
    if (rebuilding) return;
    setRebuilding(true);
    try {
      await onRebuild();
      await loadManifest();
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 mb-5">
      <div className="flex items-center gap-2 mb-3">
        <SearchCheck className="w-4 h-4 text-[#3E7B80]" />
        <h4 className="text-sm font-bold text-gray-800">Public website synchronisation</h4>
      </div>

      <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${meta.className}`}>
        <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${verdict === 'loading' || rebuilding ? 'animate-spin' : ''}`} />
        <div>
          <div className="text-xs font-bold uppercase tracking-wide">{meta.label}</div>
          <div className="text-[11px] leading-snug opacity-90">{meta.note}</div>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3 text-[11px] text-gray-600">
        <div className="flex justify-between"><dt>Live hash</dt><dd className="font-mono">{SHORT(live.contentHash)}</dd></div>
        <div className="flex justify-between"><dt>Static hash</dt><dd className="font-mono">{SHORT(manifest?.contentHash)}</dd></div>
        <div className="flex justify-between"><dt>Static source</dt><dd>{manifest?.source ?? '—'}</dd></div>
        <div className="flex justify-between"><dt>Mode</dt><dd>{deploymentMode}</dd></div>
        <div className="flex justify-between"><dt>Stores</dt><dd>{live.counts.stores}</dd></div>
        <div className="flex justify-between"><dt>Vacancies</dt><dd>{live.counts.vacancies}</dd></div>
        <div className="flex justify-between"><dt>Published news</dt><dd>{live.counts.publishedNewsPosts}</dd></div>
        <div className="flex justify-between"><dt>Menu items</dt><dd>{live.counts.menuItems}</dd></div>
      </dl>

      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          onClick={handleRebuild}
          disabled={!canRebuild || rebuilding}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#3E7B80] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#33686c] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${rebuilding ? 'animate-spin' : ''}`} />
          Record SEO refresh
        </button>
        <button
          type="button"
          onClick={() => void loadManifest()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
        >
          Recheck
        </button>
        {!canRebuild && (
          <span className="text-[10px] text-gray-400">Owners &amp; managers only</span>
        )}
      </div>
    </div>
  );
};
