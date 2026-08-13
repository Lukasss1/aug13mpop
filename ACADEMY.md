# Milk Pop Training Academy

The Academy turns the old read-only course cards into a full training system:
owners build modules (with videos and interactive exams), assign them with
deadlines, and staff who pass are automatically e-mailed a certificate.

---

## What's in the box

### 1. Academy Studio (Admin Panel → Academy Studio)
Owner/manager suite with three desks:

- **Modules** — full builder for training modules:
  - Metadata: title, category, description, **pass mark %**, reward points,
    badge, **default deadline (days)**, **mandatory** flag, learning objectives.
  - **Lesson slides** — text or **video** slides, reorderable. Video slides
    accept a YouTube link, a direct `.mp4` URL, **or a file upload** (≤ 60 MB,
    `.mp4` / `.m4v` / `.webm`) that lands in the **private** `training-media`
    bucket and streams to staff via short-lived signed URLs.
  - **"Can't be skipped"** toggle per video: staff must watch to the end
    before "Next" unlocks (seek-forward is snapped back, playback rate capped
    at 1×). YouTube embeds can't be locked — the builder warns and the player
    shows an honour-system notice.
  - **Exam questions** — multiple choice, true/false, and **drag-the-words**:
    write a sentence with `[[gaps]]`, add decoy words, and staff drag chips
    into the right places. Live gap-count feedback while authoring.
- **Assignments** — pick a module + team members + a due date (pre-filled
  from the module's default). Duplicate open assignments are skipped. The
  table tracks **Assigned / In progress / Completed / Overdue** with scores.
- **Certificates** — the register of issued certificates, with score, issue
  date and whether the e-mail went out.

The dashboard "Course Completion Rates" chart now shows real
certified-staff counts per module.

### 2. Staff player (Staff Portal → Academy)
- Cards show **MANDATORY** tags, **due-date pills** (red when overdue) and a
  certified state driven by real certificates. Opening an assigned module
  stamps it **in progress**.
- Video slides play inline; skip-locked videos gate the "Next Slide" button
  with a watched-progress bar.
- The exam renders all three question types; drag questions use the same
  chip components staff have already answered with.
- Pass mark comes from the module's `passingScore` (no more hard-coded
  16/20). On a pass:
  1. open assignments are completed (with score + timestamp),
  2. points/badge are granted as before,
  3. a certificate `MP-XXXXXX-…` is issued **once** per module, and
  4. the certificate is **e-mailed automatically** via the `send-email`
     function (`training_certificate` template). Success stamps `emailedAt`;
     failures keep the certificate and show a warning toast.
- A "My certificates" strip appears above the course grid.

### 3. Four new UK food-safety modules (`src/trainingFoodSafety.ts`)
Aligned with FSA England guidance (8 °C chilled / −18 °C frozen / 63 °C hot
holding / 75 °C core / 4-hour rule / Natasha's Law / 14 allergens):

| ID  | Module | Pass | Due | Mandatory |
|-----|--------|------|-----|-----------|
| fs1 | Food Hygiene Essentials (Level 1) | 80 % | 7 d | ✔ |
| fs2 | Temperature Control & Safe Storage | 80 % | 7 d | ✔ |
| fs3 | Allergen Awareness & Natasha's Law | 85 % | 5 d | ✔ |
| fs4 | Cleaning, Cross-Contamination & Waste | 80 % | 10 d | ✔ |

41 questions total, including 9 drag-the-words exercises.

---

## Data & sync

- New registries `milkpop_training_assignments` and
  `milkpop_training_certificates` live in App state and sync through
  `cloudSync` to the `training_assignments` / `training_certificates` tables
  (both `private` scope, per-role RLS: staff read/insert their own rows,
  managers see everything).
- Uploaded videos are **not** public: the `training-media` bucket is only
  reachable through the `training-media` Edge Function (managers upload,
  any signed-in staff member gets a 2-hour signed URL to stream).

## Deploying

1. **Database** — run `supabase/migration_training_academy.sql` in the SQL
   editor (adds `due_days` / `mandatory` columns, the two new tables + RLS,
   and the private `training-media` storage bucket).
2. **Edge Functions** — deploy `training-media` (new) and redeploy
   `send-email` (its `templates.ts` gained the `training_certificate`
   template). E-mail sending itself follows `supabase/EMAIL_SETUP.md` as
   before — nothing new to configure if e-mail already works.
3. **Headers** — `public/_headers` now includes
   `media-src 'self' blob: https://*.supabase.co` (signed video streaming)
   and YouTube in `frame-src`. Ships automatically with the site deploy.

No breaking changes: existing module `a1`, courses, points and badges keep
working; the exam simply grades against each module's own pass mark now.
