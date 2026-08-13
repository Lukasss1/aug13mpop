/**
 * @file seoRebuild.ts
 * @description Client side of the OPT-02-C1.2 SEO rebuild pipeline.
 *
 * After a server-CONFIRMED write to a public-content domain (menu, stores,
 * vacancies, news, site content, site settings) the app asks the
 * `request-seo-rebuild` Edge Function to record that the protected website
 * release should refresh the static crawler snapshot. The function deliberately
 * does not call a hosting build hook, so content publishing cannot bypass the
 * signed production release pipeline.
 *
 * The DB write and the rebuild request are SEPARATE operations: a failed
 * rebuild never rolls back a valid write, but it must be visible and retryable
 * (see afterPublishRebuild + the Admin SEO status panel).
 *
 * The live-content hash the Admin panel compares against /seo-manifest.json is
 * computed here with the SAME canonical hash the build uses, so "SEO synced"
 * can only appear when the static snapshot truly matches the live data.
 */
import { getSupabaseConfig } from './supabase';
import {
  buildPublicContentSnapshot,
  canonicalContentHash,
  snapshotCounts,
} from './publicContentSnapshot';
import type {
  SnapshotStore,
  SnapshotVacancy,
  SnapshotNews,
} from './publicContentSnapshot';
import type { SiteSettings, MenuItem } from '../types';
import type { SiteContent } from '../siteContent';
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from './requestTimeout';

export const SEO_REBUILD_AREAS = [
  'site-content',
  'site-settings',
  'menu',
  'stores',
  'vacancies',
  'news',
  'manual',
] as const;
export type SeoRebuildArea = (typeof SEO_REBUILD_AREAS)[number];

export type SeoRebuildResult =
  | { ok: true; queued: true }
  | { ok: true; queued: false; deferred: true }
  | { ok: false; code: 'not_configured'; message: string }
  | { ok: false; code: 'unauthorized'; message: string }
  | { ok: false; code: 'failed'; message: string };

/** UI-facing rebuild status shared by App (auto rebuilds) and the SEO panel. */
export type SeoRebuildUiState = 'idle' | 'queued' | 'deferred' | 'failed' | 'not_configured';
export interface SeoRebuildStatus {
  state: SeoRebuildUiState;
  area?: SeoRebuildArea;
  at?: string;
}

/**
 * Ask the Edge Function to record that the static SEO snapshot needs a future
 * protected release. Requires a live session token. No hosting deploy is
 * initiated by this client or by the Edge Function.
 */
export async function requestSeoRebuild(area: SeoRebuildArea, token: string): Promise<SeoRebuildResult> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, code: 'not_configured', message: 'No database is configured.' };
  let res: Response;
  try {
    res = await fetchWithTimeout(`${cfg.url.replace(/\/$/, '')}/functions/v1/request-seo-rebuild`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ area }),
    }, REQUEST_TIMEOUT_MS.action);
  } catch {
    return { ok: false, code: 'failed', message: 'The server did not confirm whether the SEO refresh handoff was recorded. Check the status before retrying.' };
  }
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; queued?: boolean; code?: string; error?: string }
    | null;

  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: 'unauthorized', message: (body?.error as string) || 'Not permitted to rebuild SEO.' };
  }
  if (body?.ok && body.queued) return { ok: true, queued: true };
  if (body?.ok && body?.code === 'SEO_REFRESH_PROTECTED_RELEASE') {
    return { ok: true, queued: false, deferred: true };
  }
  return { ok: false, code: 'failed', message: 'The SEO refresh handoff could not be recorded.' };
}

/* ------------------------------------------------------------------ */
/*  Pure after-publish decision (unit-tested in seo-publishers.test)   */
/* ------------------------------------------------------------------ */

export type PublishRebuildOutcome =
  | { requested: false; reason: 'write-failed' | 'no-op' }
  | { requested: true; result: SeoRebuildResult };

/**
 * Decide whether to request a rebuild after a publish attempt, and do it.
 *   • the DB write failed        → do NOT rebuild (nothing changed live);
 *   • nothing actually changed    → do NOT rebuild (no-op);
 *   • otherwise                   → request the rebuild and return its result.
 * Never throws; a rebuild failure is returned, not raised, so the caller can
 * show a persistent warning without touching the (valid) database write.
 */
export async function afterPublishRebuild(
  area: SeoRebuildArea,
  wrote: boolean,
  requestRebuild: (area: SeoRebuildArea) => Promise<SeoRebuildResult>,
  opts?: { changed?: boolean },
): Promise<PublishRebuildOutcome> {
  if (!wrote) return { requested: false, reason: 'write-failed' };
  if (opts && opts.changed === false) return { requested: false, reason: 'no-op' };
  const result = await requestRebuild(area);
  return { requested: true, result };
}

/* ------------------------------------------------------------------ */
/*  Live-content hash for the Admin SEO status panel                   */
/* ------------------------------------------------------------------ */

export interface LiveSeoSummary {
  contentHash: string;
  counts: {
    menuItems: number;
    stores: number;
    vacancies: number;
    publishedNewsPosts: number;
  };
}

export interface LiveSeoInput {
  siteSettings: SiteSettings;
  /** The hydrated SiteContent the app renders. */
  siteContent: SiteContent;
  menuItems: MenuItem[];
  stores: SnapshotStore[];
  vacancies: SnapshotVacancy[];
  newsPosts: SnapshotNews[];
}

/** Hash the CURRENT public content exactly as the build would, so the Admin
 *  panel can compare it to /seo-manifest.json's contentHash. */
export function buildLiveSeoSummary(input: LiveSeoInput): LiveSeoSummary {
  const snapshot = buildPublicContentSnapshot(input);
  return { contentHash: canonicalContentHash(snapshot), counts: snapshotCounts(snapshot) };
}

/** The client's deployment mode (baked-in Vite var), for panel messaging. */
export function clientDeploymentMode(): string {
  const env = ((import.meta as unknown as { env?: Record<string, unknown> }).env || {}) as Record<string, unknown>;
  return String(env.VITE_DEPLOYMENT_MODE || 'development').trim() || 'development';
}
