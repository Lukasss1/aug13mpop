import React, { useEffect, useRef, useState } from 'react';
import { fetchTrainingVideoSignedUrl } from '../lib/supabase';
import { getAccessToken } from '../lib/auth';

/**
 * LESSON VIDEO PLAYER — renders a TrainingSlide of type 'video'.
 *
 * Sources it understands:
 *   - storage://training-media/<key>  → resolved to a short-lived signed URL
 *     via the training-media Edge Function (private bucket, per-viewer).
 *   - Direct https .mp4/.m4v/.webm    → played as-is.
 *   - YouTube watch/short/embed links → privacy-enhanced iframe embed.
 *
 * NO-SKIP ENFORCEMENT (direct files only):
 *   While `noSkip` is set and the video hasn't been finished once, the player
 *   tracks the furthest point genuinely watched and snaps any forward seek
 *   back to it; fast playback rates are reset to 1×. When playback reaches
 *   the end, `onCompleted` fires and the lock is lifted for re-watching.
 *   YouTube iframes cannot be locked (documented on TrainingSlide.noSkip):
 *   they report completion immediately and show a small notice instead.
 */

const STORAGE_REF_RE = /^storage:\/\/training-media\//i;

/** Extract a YouTube video id from the common link shapes, or null. */
export function youTubeIdFrom(url: string): string | null {
  const m = url.match(
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/,
  );
  return m?.[1] ?? null;
}

interface LessonVideoProps {
  videoUrl: string;
  noSkip?: boolean;
  /** True once this slide's video was finished (parent-owned, per course run). */
  completed: boolean;
  onCompleted: () => void;
}

export const LessonVideo: React.FC<LessonVideoProps> = ({ videoUrl, noSkip = false, completed, onCompleted }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [resolving, setResolving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [progressPct, setProgressPct] = useState<number>(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** Furthest second genuinely watched — the seek fence while locked. */
  const maxWatchedRef = useRef<number>(0);
  const completedRef = useRef<boolean>(completed);
  completedRef.current = completed;

  const ytId = youTubeIdFrom(videoUrl);
  const isStorageRef = STORAGE_REF_RE.test(videoUrl.trim());

  /* Resolve the playable source. Signed URLs last 2 h — comfortably longer
     than a lesson — and can be re-minted with the Retry button on error. */
  const resolveSource = async () => {
    setError(null);
    if (ytId) { setSrc(null); return; }
    if (!isStorageRef) { setSrc(videoUrl); return; }
    setResolving(true);
    try {
      const token = await getAccessToken();
      if (!token) { setError('Your session has expired — please sign in again to watch this lesson.'); return; }
      const url = await fetchTrainingVideoSignedUrl(videoUrl.trim(), token);
      if (url) setSrc(url);
      else setError('This lesson video could not be opened right now.');
    } finally {
      setResolving(false);
    }
  };

  useEffect(() => {
    maxWatchedRef.current = 0;
    setProgressPct(0);
    void resolveSource();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl]);

  /* YouTube embeds can't be gated — unlock immediately, note the limitation. */
  useEffect(() => {
    if (ytId && !completedRef.current) onCompleted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytId, videoUrl]);

  const snapBackIfSkipping = () => {
    const v = videoRef.current;
    if (!v || !noSkip || completedRef.current) return;
    if (v.currentTime > maxWatchedRef.current + 0.9) {
      v.currentTime = maxWatchedRef.current;
    }
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    if (noSkip && !completedRef.current && v.currentTime > maxWatchedRef.current + 0.9) {
      v.currentTime = maxWatchedRef.current;
      return;
    }
    maxWatchedRef.current = Math.max(maxWatchedRef.current, v.currentTime);
    if (v.duration && isFinite(v.duration)) {
      setProgressPct(Math.min(100, Math.round((maxWatchedRef.current / v.duration) * 100)));
      // Resilience: some encodes never fire `ended` cleanly.
      if (!completedRef.current && v.duration - v.currentTime < 0.4) onCompleted();
    }
  };

  const handleRateChange = () => {
    const v = videoRef.current;
    if (v && noSkip && !completedRef.current && v.playbackRate > 1) v.playbackRate = 1;
  };

  if (ytId) {
    return (
      <div className="space-y-2">
        <div className="relative w-full overflow-hidden rounded-2xl border border-neutral-200 bg-black" style={{ paddingTop: '56.25%' }}>
          <iframe
            title="Lesson video"
            src={`https://www.youtube-nocookie.com/embed/${ytId}?rel=0&modestbranding=1`}
            className="absolute inset-0 h-full w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
        {noSkip && (
          <p className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Heads up: skip-protection can't be enforced on YouTube links, so this one is on the honour system — please watch it in full.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {resolving ? (
        <div className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 flex items-center justify-center" style={{ minHeight: 220 }}>
          <p className="text-2xs font-black uppercase tracking-widest text-neutral-400 animate-pulse">Opening lesson video…</p>
        </div>
      ) : error ? (
        <div className="w-full rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center space-y-3" style={{ minHeight: 160 }}>
          <p className="text-xs font-bold text-rose-700">{error}</p>
          <button
            type="button"
            onClick={() => void resolveSource()}
            className="px-5 py-2 bg-[#2E2A26] hover:bg-[#A46832] text-white rounded-full text-2xs uppercase tracking-widest font-extrabold border-0 cursor-pointer"
          >
            Retry
          </button>
        </div>
      ) : src ? (
        <video
          ref={videoRef}
          src={src}
          controls
          playsInline
          preload="metadata"
          controlsList="nodownload"
          onSeeking={snapBackIfSkipping}
          onTimeUpdate={handleTimeUpdate}
          onRateChange={handleRateChange}
          onEnded={() => { if (!completedRef.current) onCompleted(); }}
          onError={() => setError('Playback stopped — the video link may have expired.')}
          className="w-full rounded-2xl border border-neutral-200 bg-black"
          style={{ maxHeight: 420 }}
        />
      ) : null}

      {noSkip && src && !error && !resolving && (
        completed ? (
          <p className="text-[10px] font-black uppercase tracking-widest text-[#5FA777]">
            ✓ Watched in full — you can now continue (and re-watch freely).
          </p>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-neutral-400">
              <span>🔒 Skip-protected lesson — watch to the end to unlock “Next”</span>
              <span className="font-mono text-[#A46832]">{progressPct}%</span>
            </div>
            <div className="h-1.5 w-full bg-neutral-100 rounded-full overflow-hidden">
              <div className="h-full bg-[#A46832] transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )
      )}
    </div>
  );
};
