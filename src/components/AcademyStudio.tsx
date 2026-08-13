import React, { useMemo, useRef, useState } from 'react';
import {
  Award, BookOpen, CalendarClock, ChevronDown, ChevronUp, ClipboardCheck,
  Film, GraduationCap, Lock, Mail, Plus, Trash, Type, Upload, Users, X,
} from 'lucide-react';
import {
  EmployeeProfile, TrainingAssessment, TrainingAssignment, TrainingCertificate,
  TrainingQuestion, TrainingSlide,
} from '../types';
import { uploadTrainingVideo } from '../lib/supabase';
import { getAccessToken } from '../lib/auth';
import { cloudNotConfiguredMessage } from '../lib/operatorMessages';
import { parseDragTemplate } from './DragDropQuestion';
import { businessTodayISO } from '../lib/businessDate';

/**
 * ACADEMY STUDIO — the owner/manager side of the Training Academy.
 *
 * Three desks in one tab:
 *   1. MODULES      — build complete training modules: metadata (pass mark,
 *                     points, badge, default due-days, mandatory flag),
 *                     lesson slides (text or video — uploaded videos can be
 *                     skip-locked), and an exam mixing multiple-choice,
 *                     true/false and drag-the-word-into-the-gap questions.
 *   2. ASSIGNMENTS  — assign any module to any staff members with a due
 *                     date (pre-filled from the module's due-days), then
 *                     track assigned / in-progress / completed / overdue.
 *   3. CERTIFICATES — the register of automatically issued certificates,
 *                     including whether the certificate e-mail went out.
 *
 * Persistence: everything flows through the registries owned by App.tsx
 * (assessments / assignments / certificates), which sync to Supabase via
 * cloudSync exactly like every other registry.
 */

type StudioTab = 'modules' | 'assignments' | 'certificates';

const CATEGORY_OPTIONS: TrainingAssessment['category'][] = ['brand', 'menu', 'operations', 'safety', 'service'];
const DIFFICULTY_OPTIONS: TrainingQuestion['difficulty'][] = ['easy', 'medium', 'hard'];

const todayStr = () => businessTodayISO();
const addDaysStr = (days: number) => {
  const d = new Date(`${businessTodayISO()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(0, Math.round(days)));
  return d.toISOString().slice(0, 10);
};
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

const blankSlide = (): TrainingSlide => ({ title: '', content: '', type: 'text' });

const blankQuestion = (type: TrainingQuestion['type'] = 'multiple_choice'): TrainingQuestion => ({
  id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  text: '',
  type,
  options: type === 'true_false' ? ['True', 'False'] : type === 'multiple_choice' ? ['', '', '', ''] : [],
  correctAnswer: type === 'true_false' ? 'True' : '',
  explanation: '',
  difficulty: 'medium',
  categoryTag: '',
  ...(type === 'drag_drop' ? { dragTemplate: '', dragDistractors: [] } : {}),
});

const blankModule = (): TrainingAssessment => ({
  id: `mod-${Date.now().toString(36)}`,
  title: '',
  description: '',
  learningObjectives: [],
  passingScore: 80,
  slides: [blankSlide()],
  questions: [blankQuestion()],
  category: 'operations',
  points: 200,
  badge: '',
  dueDays: 7,
  mandatory: false,
});

const inputCls = 'w-full bg-white border border-neutral-200 focus:border-[#A46832] outline-none p-2.5 rounded-xl text-2xs font-semibold text-[#2E2A26] transition-colors';
const labelCls = 'block text-[9px] uppercase tracking-widest font-black text-neutral-400 mb-1.5';
const chipBtnCls = 'px-3 py-1.5 rounded-full text-[9px] uppercase tracking-wider font-black border cursor-pointer transition-all flex items-center gap-1.5';

interface AcademyStudioProps {
  employee: EmployeeProfile | null;
  assessments: TrainingAssessment[];
  publishAssessments: (next: TrainingAssessment[] | ((prev: TrainingAssessment[]) => TrainingAssessment[])) => Promise<boolean>;
  employeesList: EmployeeProfile[];
  assignments: TrainingAssignment[];
  publishAssignments: (next: TrainingAssignment[] | ((prev: TrainingAssignment[]) => TrainingAssignment[])) => Promise<boolean>;
  certificates: TrainingCertificate[];
  addToast: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  logAction: (module: string, action: string) => void;
}

export const AcademyStudio: React.FC<AcademyStudioProps> = ({
  employee, assessments, publishAssessments, employeesList,
  assignments, publishAssignments, certificates, addToast, logAction,
}) => {
  const [tab, setTab] = useState<StudioTab>('modules');

  /* ================================================================ */
  /*  MODULE BUILDER STATE                                            */
  /* ================================================================ */
  const [editing, setEditing] = useState<TrainingAssessment | null>(null);
  const [isNewModule, setIsNewModule] = useState<boolean>(false);
  const [uploadBusySlide, setUploadBusySlide] = useState<number | null>(null);
  const fileInputsRef = useRef<Record<number, HTMLInputElement | null>>({});

  const patchEditing = (patch: Partial<TrainingAssessment>) =>
    setEditing((cur) => (cur ? { ...cur, ...patch } : cur));

  const patchSlide = (idx: number, patch: Partial<TrainingSlide>) =>
    setEditing((cur) => {
      if (!cur) return cur;
      const slides = [...(cur.slides || [])];
      const existingSlide = slides[idx];
      if (!existingSlide) return cur;
      slides[idx] = { ...existingSlide, ...patch };
      return { ...cur, slides };
    });

  const patchQuestion = (idx: number, patch: Partial<TrainingQuestion>) =>
    setEditing((cur) => {
      if (!cur) return cur;
      const questions = [...cur.questions];
      const existingQ = questions[idx];
      if (!existingQ) return cur;
      questions[idx] = { ...existingQ, ...patch };
      return { ...cur, questions };
    });

  const moveItem = <T,>(arr: T[], idx: number, dir: -1 | 1): T[] => {
    const to = idx + dir;
    if (to < 0 || to >= arr.length) return arr;
    const next = [...arr];
    const a = next[idx];
    const b = next[to];
    if (a === undefined || b === undefined) return arr;
    next[idx] = b;
    next[to] = a;
    return next;
  };

  const changeQuestionType = (idx: number, type: TrainingQuestion['type']) =>
    setEditing((cur) => {
      if (!cur) return cur;
      const questions = [...cur.questions];
      const q = questions[idx];
      if (!q) return cur;
      if (type === 'true_false') {
        questions[idx] = { ...q, type, options: ['True', 'False'], correctAnswer: 'True', dragTemplate: undefined, dragDistractors: undefined };
      } else if (type === 'multiple_choice') {
        const opts = q.options && q.options.length >= 2 && q.type === 'multiple_choice' ? q.options : ['', '', '', ''];
        const existing = q.correctAnswer ?? '';
        questions[idx] = { ...q, type, options: opts, correctAnswer: opts.includes(existing) ? existing : '', dragTemplate: undefined, dragDistractors: undefined };
      } else {
        questions[idx] = { ...q, type: 'drag_drop', options: [], correctAnswer: '', dragTemplate: q.dragTemplate || '', dragDistractors: q.dragDistractors || [] };
      }
      return { ...cur, questions };
    });

  const handleVideoFile = async (slideIdx: number, file: File | null) => {
    if (!file) return;
    setUploadBusySlide(slideIdx);
    try {
      const token = await getAccessToken();
      if (!token) { addToast('Your session has expired — sign in again to upload videos.', 'error'); return; }
      const res = await uploadTrainingVideo(file, token);
      if (res.status === 'uploaded') {
        patchSlide(slideIdx, { type: 'video', videoUrl: res.ref });
        addToast('Video uploaded to the private training library. 🎬', 'success');
      } else if (res.status === 'not_configured') {
        addToast(cloudNotConfiguredMessage('Training video uploads'), 'error');
      } else if (res.reason === 'too_large') {
        addToast('That video is over the 60 MB limit — compress it or link a YouTube URL instead.', 'error');
      } else if (res.reason === 'bad_type') {
        addToast('Only .mp4, .m4v and .webm files can be uploaded.', 'error');
      } else if (res.reason === 'forbidden') {
        addToast('Only managers and owners can upload training videos.', 'error');
      } else {
        addToast(res.message || 'Video upload failed — please try again.', 'error');
      }
    } finally {
      setUploadBusySlide(null);
      const el = fileInputsRef.current[slideIdx];
      if (el) el.value = '';
    }
  };

  const validateModule = (m: TrainingAssessment): string | null => {
    if (!m.title.trim()) return 'Give the module a title.';
    if (!m.questions.length) return 'Add at least one exam question.';
    for (let i = 0; i < m.questions.length; i++) {
      const q = m.questions[i];
      if (!q) continue;
      const label = `Question ${i + 1}`;
      if (q.type === 'drag_drop') {
        const gaps = parseDragTemplate(q.dragTemplate || '').answers.length;
        if (!gaps) return `${label}: the drag & drop sentence needs at least one [[gap]].`;
      } else {
        if (!q.text.trim()) return `${label}: write the question text.`;
        const opts = (q.options || []).map((o) => o.trim()).filter(Boolean);
        if (opts.length < 2) return `${label}: needs at least two answer options.`;
        const answer = (q.correctAnswer ?? '').trim();
        if (!answer || !opts.includes(answer)) return `${label}: tick which option is correct.`;
      }
    }
    return null;
  };

  const saveModule = async () => {
    if (!editing) return;
    const cleaned: TrainingAssessment = {
      ...editing,
      title: editing.title.trim(),
      passingScore: Math.min(100, Math.max(1, Math.round(editing.passingScore || 80))),
      dueDays: Math.max(1, Math.round(editing.dueDays || 7)),
      learningObjectives: (editing.learningObjectives || []).map((o) => o.trim()).filter(Boolean),
      slides: (editing.slides || [])
        .map((s) => ({ ...s, title: s.title.trim() }))
        .filter((s) => s.title || s.content.trim() || (s.type === 'video' && s.videoUrl)),
      questions: editing.questions.map((q) =>
        q.type === 'drag_drop'
          ? { ...q, options: [], correctAnswer: '', dragDistractors: (q.dragDistractors || []).map((d) => d.trim()).filter(Boolean) }
          : { ...q, options: (q.options || []).map((o) => o.trim()).filter(Boolean), correctAnswer: (q.correctAnswer ?? '').trim(), dragTemplate: undefined, dragDistractors: undefined },
      ),
    };
    const problem = validateModule(cleaned);
    if (problem) { addToast(problem, 'error'); return; }

    const ok = await publishAssessments((prev) =>
      isNewModule ? [cleaned, ...prev] : prev.map((a) => (a.id === cleaned.id ? cleaned : a)),
    );
    if (!ok) return;
    logAction('Training Academy', `${isNewModule ? 'Published' : 'Updated'} module "${cleaned.title}" (${cleaned.questions.length} questions, pass ${cleaned.passingScore}%)`);
    addToast(`Module "${cleaned.title}" ${isNewModule ? 'published' : 'updated'}. 🎓`, 'success');
    setEditing(null);
  };

  const deleteModule = async (m: TrainingAssessment) => {
    if (!window.confirm(`Delete "${m.title}"? Staff will no longer see it. Past assignments and certificates are kept for the record.`)) return;
    if (!(await publishAssessments((prev) => prev.filter((a) => a.id !== m.id)))) return;
    logAction('Training Academy', `Deleted module "${m.title}"`);
    addToast(`Module "${m.title}" deleted.`, 'warning');
  };

  /* ================================================================ */
  /*  ASSIGNMENT DESK STATE                                           */
  /* ================================================================ */
  const [assignModuleId, setAssignModuleId] = useState<string>('');
  const [assignStaff, setAssignStaff] = useState<Set<string>>(new Set());
  const [assignDue, setAssignDue] = useState<string>(addDaysStr(7));

  const assignModule = assessments.find((a) => a.id === assignModuleId) || null;

  const pickModuleForAssign = (id: string) => {
    setAssignModuleId(id);
    const m = assessments.find((a) => a.id === id);
    setAssignDue(addDaysStr(m?.dueDays ?? 7));
  };

  const toggleStaff = (id: string) =>
    setAssignStaff((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const openAssignmentExists = (assessmentId: string, employeeId: string) =>
    assignments.some((a) => a.assessmentId === assessmentId && a.employeeId === employeeId && a.status !== 'completed');

  const createAssignments = async () => {
    if (!assignModule) { addToast('Pick which module to assign.', 'error'); return; }
    if (!assignStaff.size) { addToast('Tick at least one team member.', 'error'); return; }
    if (!assignDue || assignDue < todayStr()) { addToast('The due date must be today or later.', 'error'); return; }

    const assignerName = String(employee?.name || '').trim();
    if (!assignerName) { addToast('Your staff profile needs a real name before assigning training.', 'error'); return; }
    const nowISO = new Date().toISOString();
    const fresh: TrainingAssignment[] = [];
    let skipped = 0;
    let invalid = 0;
    assignStaff.forEach((empId) => {
      if (openAssignmentExists(assignModule.id, empId)) { skipped++; return; }
      const emp = employeesList.find((candidate) => candidate.id === empId && candidate.status !== 'disabled');
      if (!emp?.name?.trim()) { invalid++; return; }
      fresh.push({
        id: `ta-${Date.now().toString(36)}-${empId}`,
        assessmentId: assignModule.id,
        assessmentTitle: assignModule.title,
        employeeId: empId,
        employeeName: emp.name.trim(),
        assignedBy: assignerName,
        assignedAt: nowISO,
        dueDate: assignDue,
        status: 'assigned',
      });
    });
    if (invalid) {
      addToast(`${invalid} selected staff profile${invalid === 1 ? ' was' : 's were'} no longer valid. Refresh the staff list and select again.`, 'error');
      return;
    }

    if (fresh.length) {
      if (!(await publishAssignments((prev) => [...fresh, ...prev]))) return;
      logAction('Training Academy', `Assigned "${assignModule.title}" to ${fresh.length} staff, due ${assignDue}`);
    }
    addToast(
      fresh.length
        ? `Assigned to ${fresh.length} team member${fresh.length === 1 ? '' : 's'} — due ${fmtDate(assignDue)}.${skipped ? ` ${skipped} already had it open.` : ''}`
        : 'Everyone selected already has this module open.',
      fresh.length ? 'success' : 'warning',
    );
    setAssignStaff(new Set());
  };

  const removeAssignment = async (a: TrainingAssignment) => {
    if (!window.confirm(`Remove the "${a.assessmentTitle}" assignment for ${a.employeeName}?`)) return;
    if (!(await publishAssignments((prev) => prev.filter((x) => x.id !== a.id)))) return;
    logAction('Training Academy', `Removed assignment "${a.assessmentTitle}" for ${a.employeeName}`);
  };

  const isOverdue = (a: TrainingAssignment) => a.status !== 'completed' && a.dueDate < todayStr();

  const sortedAssignments = useMemo(
    () => [...assignments].sort((a, b) => (a.status === 'completed' ? 1 : 0) - (b.status === 'completed' ? 1 : 0) || a.dueDate.localeCompare(b.dueDate)),
    [assignments],
  );
  const overdueCount = useMemo(() => assignments.filter(isOverdue).length, [assignments]);
  const openCount = useMemo(() => assignments.filter((a) => a.status !== 'completed').length, [assignments]);

  const sortedCerts = useMemo(
    () => [...certificates].sort((a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || '')),
    [certificates],
  );

  /* ================================================================ */
  /*  RENDER                                                          */
  /* ================================================================ */
  return (
    <div className="space-y-6 font-sans text-left">
      {/* Header + desk switcher */}
      <div className="flex flex-col lg:flex-row justify-between lg:items-center gap-4">
        <div>
          <h1 className="font-display font-black text-2xl text-[#2E2A26]">Academy Studio</h1>
          <p className="text-2xs text-[#2E2A26]/70">Build modules with videos and interactive exams, assign them with deadlines, and track certificates.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {([
            { id: 'modules', label: 'Modules', icon: BookOpen, count: assessments.length },
            { id: 'assignments', label: 'Assignments', icon: CalendarClock, count: openCount },
            { id: 'certificates', label: 'Certificates', icon: Award, count: certificates.length },
          ] as { id: StudioTab; label: string; icon: React.FC<any>; count: number }[]).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`${chipBtnCls} ${tab === t.id ? 'bg-[#2E2A26] border-[#2E2A26] text-white' : 'bg-white border-[#EBDECE] text-[#2E2A26] hover:border-[#A46832]'}`}
            >
              <t.icon className="h-3 w-3" /> {t.label}
              <span className={`px-1.5 rounded-full ${tab === t.id ? 'bg-white/20' : 'bg-[#EBDECE]/50'}`}>{t.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Pulse row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Live modules', value: assessments.length, icon: GraduationCap },
          { label: 'Open assignments', value: openCount, icon: ClipboardCheck },
          { label: 'Overdue', value: overdueCount, icon: CalendarClock, alert: overdueCount > 0 },
          { label: 'Certificates issued', value: certificates.length, icon: Award },
        ].map((s) => (
          <div key={s.label} className={`bg-white p-4 rounded-2xl border ${s.alert ? 'border-rose-300 bg-rose-50/40' : 'border-[#EBDECE]/50'} flex items-center gap-3`}>
            <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${s.alert ? 'bg-rose-100 text-rose-600' : 'bg-[#EBDECE]/40 text-[#A46832]'}`}>
              <s.icon className="h-4 w-4" />
            </div>
            <div>
              <span className={`block text-lg font-mono font-black leading-none ${s.alert ? 'text-rose-600' : 'text-[#2E2A26]'}`}>{s.value}</span>
              <span className="block text-[9px] uppercase tracking-widest font-black text-neutral-400 mt-1">{s.label}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ============================ MODULES ============================ */}
      {tab === 'modules' && !editing && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => { setEditing(blankModule()); setIsNewModule(true); }}
              className="px-4 py-2 bg-[#A46832] hover:bg-[#A5642B] text-white rounded-full text-2xs tracking-wider uppercase font-black cursor-pointer shadow-xs flex items-center gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" /> New Module
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-2xs">
            {assessments.map((m) => {
              const videoCount = (m.slides || []).filter((s) => s.type === 'video').length;
              const dragCount = m.questions.filter((q) => q.type === 'drag_drop').length;
              const certCount = certificates.filter((c) => c.assessmentId === m.id).length;
              return (
                <div key={m.id} className="bg-white p-5 rounded-2xl border border-[#EBDECE]/50 space-y-3 hover:shadow-xs transition-shadow">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[9px] bg-teal-50 text-teal-700 px-2 py-0.5 rounded font-bold uppercase">{m.category}</span>
                    {m.mandatory && <span className="text-[9px] bg-rose-50 text-rose-600 px-2 py-0.5 rounded font-black uppercase">Mandatory</span>}
                    {m.badge && <span className="text-[9px] bg-amber-50 text-amber-700 px-2 py-0.5 rounded font-bold uppercase">🏅 {m.badge}</span>}
                  </div>
                  <div>
                    <h3 className="font-extrabold text-sm text-[#2E2A26]">{m.title}</h3>
                    <p className="text-stone-550 font-medium leading-relaxed mt-1 line-clamp-2">{m.description}</p>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-neutral-500">
                    <span>📖 {(m.slides || []).length} slides{videoCount ? ` (${videoCount} 🎬)` : ''}</span>
                    <span>❓ {m.questions.length} questions{dragCount ? ` (${dragCount} drag)` : ''}</span>
                    <span>🎯 pass {m.passingScore}%</span>
                    <span>⏰ due in {m.dueDays ?? 7}d</span>
                    <span>🏆 {certCount} completed</span>
                  </div>
                  <div className="pt-2 border-t border-neutral-100 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { setEditing(JSON.parse(JSON.stringify(m))); setIsNewModule(false); }}
                      className="px-3 py-1 bg-amber-50 rounded-full border border-amber-200 text-[#A46832] hover:bg-amber-100 font-bold uppercase text-[9px] cursor-pointer"
                    >
                      Edit module
                    </button>
                    <button
                      type="button"
                      onClick={() => { setTab('assignments'); pickModuleForAssign(m.id); }}
                      className="px-3 py-1 bg-teal-50 rounded-full border border-teal-200 text-teal-700 hover:bg-teal-100 font-bold uppercase text-[9px] cursor-pointer"
                    >
                      Assign
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteModule(m)}
                      className="px-3 py-1 bg-red-50 rounded-full border border-red-200 text-red-500 hover:bg-red-100 font-bold uppercase text-[9px] cursor-pointer flex items-center gap-1"
                    >
                      <Trash className="h-2.5 w-2.5" /> Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ======================= MODULE BUILDER ========================= */}
      {tab === 'modules' && editing && (
        <div className="bg-white rounded-3xl border border-[#EBDECE]/60 p-6 space-y-8">
          <div className="flex justify-between items-center border-b border-neutral-100 pb-4">
            <h2 className="font-display font-black text-lg text-[#2E2A26]">
              {isNewModule ? 'New Training Module' : `Editing: ${editing.title || 'Untitled module'}`}
            </h2>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="px-4 py-1.5 bg-neutral-100 hover:bg-neutral-200 rounded-full text-2xs uppercase font-extrabold cursor-pointer flex items-center gap-1"
            >
              <X className="h-3 w-3" /> Discard
            </button>
          </div>

          {/* --- Meta ----------------------------------------------------- */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-2xs">
            <div className="md:col-span-2">
              <label htmlFor="academy-module-title" className={labelCls}>Module title *</label>
              <input id="academy-module-title" className={inputCls} value={editing.title} onChange={(e) => patchEditing({ title: e.target.value })} placeholder="e.g. Food Hygiene Essentials (Level 1)" />
            </div>
            <div>
              <label htmlFor="academy-module-category" className={labelCls}>Category</label>
              <select id="academy-module-category" className={inputCls} value={editing.category} onChange={(e) => patchEditing({ category: e.target.value as TrainingAssessment['category'] })}>
                {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="md:col-span-3">
              <label htmlFor="academy-module-description" className={labelCls}>Description</label>
              <textarea id="academy-module-description" rows={2} className={inputCls} value={editing.description} onChange={(e) => patchEditing({ description: e.target.value })} placeholder="What will staff learn, and why it matters." />
            </div>
            <div>
              <label htmlFor="academy-module-pass-mark" className={labelCls}>Pass mark (%)</label>
              <input id="academy-module-pass-mark" type="number" min={1} max={100} className={inputCls} value={editing.passingScore} onChange={(e) => patchEditing({ passingScore: parseInt(e.target.value, 10) || 0 })} />
            </div>
            <div>
              <label htmlFor="academy-module-points" className={labelCls}>Reward points</label>
              <input id="academy-module-points" type="number" min={0} className={inputCls} value={editing.points} onChange={(e) => patchEditing({ points: parseInt(e.target.value, 10) || 0 })} />
            </div>
            <div>
              <label htmlFor="academy-module-badge" className={labelCls}>Badge name</label>
              <input id="academy-module-badge" className={inputCls} value={editing.badge} onChange={(e) => patchEditing({ badge: e.target.value })} placeholder="e.g. Hygiene Hero" />
            </div>
            <div>
              <label htmlFor="academy-module-deadline" className={labelCls}>Default deadline (days after assigning)</label>
              <input id="academy-module-deadline" type="number" min={1} className={inputCls} value={editing.dueDays ?? 7} onChange={(e) => patchEditing({ dueDays: parseInt(e.target.value, 10) || 1 })} />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={!!editing.mandatory} onChange={(e) => patchEditing({ mandatory: e.target.checked })} className="h-4 w-4 accent-[#A46832]" />
                <span className="text-2xs font-extrabold text-[#2E2A26]">Mandatory module</span>
              </label>
            </div>
            <div className="md:col-span-3">
              <label htmlFor="academy-module-objectives" className={labelCls}>Learning objectives (one per line)</label>
              <textarea
                id="academy-module-objectives"
                rows={3}
                className={inputCls}
                value={(editing.learningObjectives || []).join('\n')}
                onChange={(e) => patchEditing({ learningObjectives: e.target.value.split('\n') })}
                placeholder={'When and how to wash hands\nThe 8–63 °C danger zone'}
              />
            </div>
          </div>

          {/* --- Slides --------------------------------------------------- */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-neutral-100 pb-2">
              <h3 className="font-display font-black text-sm text-[#2E2A26] uppercase tracking-wide">Lesson slides</h3>
              <button
                type="button"
                onClick={() => patchEditing({ slides: [...(editing.slides || []), blankSlide()] })}
                className={`${chipBtnCls} bg-white border-[#EBDECE] text-[#2E2A26] hover:border-[#A46832]`}
              >
                <Plus className="h-3 w-3" /> Add slide
              </button>
            </div>

            {(editing.slides || []).map((s, i) => (
              <div key={i} className="bg-[#FBFBFC] border border-neutral-200 rounded-2xl p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-black text-neutral-400 font-mono shrink-0">#{i + 1}</span>
                  <input aria-label={`Slide ${i + 1} title`} className={inputCls} value={s.title} onChange={(e) => patchSlide(i, { title: e.target.value })} placeholder="Slide title" />
                  <div className="flex gap-1 shrink-0">
                    <button type="button" title="Text slide" onClick={() => patchSlide(i, { type: 'text' })} className={`p-2 rounded-lg border cursor-pointer ${(s.type ?? 'text') === 'text' ? 'bg-[#2E2A26] border-[#2E2A26] text-white' : 'bg-white border-neutral-200 text-neutral-400 hover:border-[#A46832]'}`}><Type className="h-3.5 w-3.5" /></button>
                    <button type="button" title="Video slide" onClick={() => patchSlide(i, { type: 'video' })} className={`p-2 rounded-lg border cursor-pointer ${s.type === 'video' ? 'bg-[#2E2A26] border-[#2E2A26] text-white' : 'bg-white border-neutral-200 text-neutral-400 hover:border-[#A46832]'}`}><Film className="h-3.5 w-3.5" /></button>
                    <button type="button" title="Move up" disabled={i === 0} onClick={() => patchEditing({ slides: moveItem(editing.slides || [], i, -1) })} className="p-2 rounded-lg border bg-white border-neutral-200 text-neutral-400 hover:border-[#A46832] disabled:opacity-30 cursor-pointer"><ChevronUp className="h-3.5 w-3.5" /></button>
                    <button type="button" title="Move down" disabled={i === (editing.slides || []).length - 1} onClick={() => patchEditing({ slides: moveItem(editing.slides || [], i, 1) })} className="p-2 rounded-lg border bg-white border-neutral-200 text-neutral-400 hover:border-[#A46832] disabled:opacity-30 cursor-pointer"><ChevronDown className="h-3.5 w-3.5" /></button>
                    <button type="button" title="Delete slide" onClick={() => patchEditing({ slides: (editing.slides || []).filter((_, j) => j !== i) })} className="p-2 rounded-lg border bg-red-50 border-red-200 text-red-500 hover:bg-red-100 cursor-pointer"><Trash className="h-3.5 w-3.5" /></button>
                  </div>
                </div>

                {s.type === 'video' ? (
                  <div className="space-y-2">
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        aria-label={`Slide ${i + 1} video URL`}
                        className={inputCls}
                        value={s.videoUrl || ''}
                        onChange={(e) => patchSlide(i, { videoUrl: e.target.value })}
                        placeholder="Paste a YouTube link, a direct .mp4 URL — or upload a file →"
                      />
                      <input
                        aria-label={`Upload video file for slide ${i + 1}`}
                        ref={(el) => { fileInputsRef.current[i] = el; }}
                        type="file"
                        accept=".mp4,.m4v,.webm,video/mp4,video/webm"
                        className="hidden"
                        onChange={(e) => void handleVideoFile(i, e.target.files?.[0] || null)}
                      />
                      <button
                        type="button"
                        disabled={uploadBusySlide !== null}
                        onClick={() => fileInputsRef.current[i]?.click()}
                        className="px-4 py-2 bg-[#2E2A26] hover:bg-[#A46832] disabled:opacity-50 text-white rounded-xl text-[10px] uppercase tracking-wider font-black cursor-pointer shrink-0 flex items-center gap-1.5"
                      >
                        <Upload className="h-3 w-3" />
                        {uploadBusySlide === i ? 'Uploading…' : 'Upload video'}
                      </button>
                    </div>
                    {s.videoUrl?.startsWith('storage://') && (
                      <p className="text-[10px] font-semibold text-[#5FA777]">✓ Stored in the private training library — staff stream it via a personal link.</p>
                    )}
                    <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
                      <input type="checkbox" checked={!!s.noSkip} onChange={(e) => patchSlide(i, { noSkip: e.target.checked })} className="h-4 w-4 accent-[#A46832]" />
                      <span className="text-[10px] font-extrabold text-[#2E2A26] flex items-center gap-1"><Lock className="h-3 w-3 text-[#A46832]" /> Can't be skipped — staff must watch to the end before “Next” unlocks</span>
                    </label>
                    {s.noSkip && s.videoUrl && youTubeLike(s.videoUrl) && (
                      <p className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                        Skip-lock only works on uploaded / direct video files — YouTube players can't be locked. Upload the file to enforce it.
                      </p>
                    )}
                    <textarea aria-label={`Slide ${i + 1} video notes`} rows={2} className={inputCls} value={s.content} onChange={(e) => patchSlide(i, { content: e.target.value })} placeholder="Optional notes shown under the video" />
                  </div>
                ) : (
                  <textarea aria-label={`Slide ${i + 1} content`} rows={5} className={inputCls} value={s.content} onChange={(e) => patchSlide(i, { content: e.target.value })} placeholder="Slide content — plain text, line breaks are kept." />
                )}
              </div>
            ))}
          </div>

          {/* --- Questions ------------------------------------------------ */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-neutral-100 pb-2 flex-wrap gap-2">
              <h3 className="font-display font-black text-sm text-[#2E2A26] uppercase tracking-wide">Exam questions</h3>
              <div className="flex gap-2 flex-wrap">
                <button type="button" onClick={() => patchEditing({ questions: [...editing.questions, blankQuestion('multiple_choice')] })} className={`${chipBtnCls} bg-white border-[#EBDECE] text-[#2E2A26] hover:border-[#A46832]`}><Plus className="h-3 w-3" /> Multiple choice</button>
                <button type="button" onClick={() => patchEditing({ questions: [...editing.questions, blankQuestion('true_false')] })} className={`${chipBtnCls} bg-white border-[#EBDECE] text-[#2E2A26] hover:border-[#A46832]`}><Plus className="h-3 w-3" /> True / False</button>
                <button type="button" onClick={() => patchEditing({ questions: [...editing.questions, blankQuestion('drag_drop')] })} className={`${chipBtnCls} bg-white border-[#EBDECE] text-[#2E2A26] hover:border-[#A46832]`}><Plus className="h-3 w-3" /> Drag the words</button>
              </div>
            </div>

            {editing.questions.map((q, i) => {
              const gapCount = q.type === 'drag_drop' ? parseDragTemplate(q.dragTemplate || '').answers.length : 0;
              return (
                <div key={q.id} className="bg-[#FBFBFC] border border-neutral-200 rounded-2xl p-4 space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[9px] font-black text-neutral-400 font-mono shrink-0">Q{i + 1}</span>
                    <select aria-label={`Question ${i + 1} type`} value={q.type} onChange={(e) => changeQuestionType(i, e.target.value as TrainingQuestion['type'])} className="bg-white border border-neutral-200 rounded-lg p-1.5 text-[10px] font-extrabold cursor-pointer">
                      <option value="multiple_choice">Multiple choice</option>
                      <option value="true_false">True / False</option>
                      <option value="drag_drop">Drag the words</option>
                    </select>
                    <select aria-label={`Question ${i + 1} difficulty`} value={q.difficulty} onChange={(e) => patchQuestion(i, { difficulty: e.target.value as TrainingQuestion['difficulty'] })} className="bg-white border border-neutral-200 rounded-lg p-1.5 text-[10px] font-extrabold cursor-pointer">
                      {DIFFICULTY_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <input aria-label={`Question ${i + 1} topic tag`} className="bg-white border border-neutral-200 rounded-lg p-1.5 text-[10px] font-semibold w-36" value={q.categoryTag} onChange={(e) => patchQuestion(i, { categoryTag: e.target.value })} placeholder="Topic tag" />
                    <div className="ml-auto flex gap-1">
                      <button type="button" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => patchEditing({ questions: moveItem(editing.questions, i, -1) })} className="p-1.5 rounded-lg border bg-white border-neutral-200 text-neutral-400 hover:border-[#A46832] disabled:opacity-30 cursor-pointer"><ChevronUp className="h-3 w-3" /></button>
                      <button type="button" aria-label={`Move question ${i + 1} down`} disabled={i === editing.questions.length - 1} onClick={() => patchEditing({ questions: moveItem(editing.questions, i, 1) })} className="p-1.5 rounded-lg border bg-white border-neutral-200 text-neutral-400 hover:border-[#A46832] disabled:opacity-30 cursor-pointer"><ChevronDown className="h-3 w-3" /></button>
                      <button type="button" aria-label={`Delete question ${i + 1}`} onClick={() => patchEditing({ questions: editing.questions.filter((_, j) => j !== i) })} className="p-1.5 rounded-lg border bg-red-50 border-red-200 text-red-500 hover:bg-red-100 cursor-pointer"><Trash className="h-3 w-3" /></button>
                    </div>
                  </div>

                  {q.type === 'drag_drop' ? (
                    <div className="space-y-2">
                      <input aria-label={`Question ${i + 1} instruction`} className={inputCls} value={q.text} onChange={(e) => patchQuestion(i, { text: e.target.value })} placeholder="Instruction line (optional) — e.g. Complete the temperature rules:" />
                      <div>
                        <label htmlFor={`academy-question-${i}-template`} className={labelCls}>Sentence with gaps — wrap each answer in [[double brackets]]</label>
                        <textarea id={`academy-question-${i}-template`} rows={3} className={inputCls} value={q.dragTemplate || ''} onChange={(e) => patchQuestion(i, { dragTemplate: e.target.value })} placeholder="Chilled food must be kept at [[8]] °C or below; frozen food at [[-18]] °C." />
                        <p className={`text-[10px] font-black mt-1 ${gapCount ? 'text-[#5FA777]' : 'text-rose-500'}`}>
                          {gapCount ? `✓ ${gapCount} gap${gapCount === 1 ? '' : 's'} detected — staff drag the right word into each.` : 'No gaps yet — write answers as [[word]].'}
                        </p>
                      </div>
                      <div>
                        <label htmlFor={`academy-question-${i}-decoys`} className={labelCls}>Decoy words (comma-separated, mixed into the word bank)</label>
                        <input id={`academy-question-${i}-decoys`} className={inputCls} value={(q.dragDistractors || []).join(', ')} onChange={(e) => patchQuestion(i, { dragDistractors: e.target.value.split(',').map((d) => d.trim()) })} placeholder="5, 12, -10" />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <textarea aria-label={`Question ${i + 1} text`} rows={2} className={inputCls} value={q.text} onChange={(e) => patchQuestion(i, { text: e.target.value })} placeholder="Question text *" />
                      <div className="space-y-1.5">
                        {(q.options || []).map((opt, oi) => (
                          <div key={oi} className="flex items-center gap-2">
                            <input
                              aria-label={`Mark option ${oi + 1} as the correct answer for question ${i + 1}`}
                              type="radio"
                              name={`correct-${q.id}`}
                              checked={q.correctAnswer !== '' && q.correctAnswer === opt}
                              onChange={() => patchQuestion(i, { correctAnswer: opt })}
                              className="h-4 w-4 accent-[#5FA777] cursor-pointer shrink-0"
                              title="Mark as the correct answer"
                            />
                            <input
                              aria-label={`Question ${i + 1} option ${oi + 1}`}
                              className={inputCls}
                              value={opt}
                              disabled={q.type === 'true_false'}
                              onChange={(e) => {
                                const options = [...(q.options || [])];
                                const wasCorrect = q.correctAnswer === options[oi];
                                options[oi] = e.target.value;
                                patchQuestion(i, { options, ...(wasCorrect ? { correctAnswer: e.target.value } : {}) });
                              }}
                              placeholder={`Option ${oi + 1}`}
                            />
                            {q.type === 'multiple_choice' && (
                              <button type="button" aria-label={`Delete option ${oi + 1} from question ${i + 1}`} onClick={() => {
                                const options = (q.options || []).filter((_, j) => j !== oi);
                                patchQuestion(i, { options, ...(q.correctAnswer === opt ? { correctAnswer: '' } : {}) });
                              }} className="p-1.5 rounded-lg border bg-white border-neutral-200 text-neutral-400 hover:text-red-500 hover:border-red-300 cursor-pointer shrink-0"><X className="h-3 w-3" /></button>
                            )}
                          </div>
                        ))}
                      </div>
                      {q.type === 'multiple_choice' && (
                        <button type="button" onClick={() => patchQuestion(i, { options: [...(q.options || []), ''] })} className="text-[10px] font-black uppercase tracking-wider text-[#A46832] hover:text-[#A5642B] cursor-pointer">+ Add option</button>
                      )}
                      <p className="text-[10px] font-semibold text-neutral-400">Tick the radio next to the correct answer.</p>
                    </div>
                  )}

                  <textarea aria-label={`Question ${i + 1} explanation`} rows={2} className={inputCls} value={q.explanation} onChange={(e) => patchQuestion(i, { explanation: e.target.value })} placeholder="Explanation shown to staff when they get it wrong" />
                </div>
              );
            })}
          </div>

          <div className="flex justify-end gap-3 border-t border-neutral-100 pt-5">
            <button type="button" onClick={() => setEditing(null)} className="px-5 py-2.5 bg-neutral-100 hover:bg-neutral-200 rounded-xl text-2xs uppercase tracking-widest font-extrabold cursor-pointer">Cancel</button>
            <button type="button" onClick={saveModule} className="px-6 py-2.5 bg-[#5FA777] hover:bg-emerald-700 text-white rounded-xl text-2xs uppercase tracking-widest font-extrabold cursor-pointer shadow-sm">
              {isNewModule ? 'Publish module' : 'Save changes'}
            </button>
          </div>
        </div>
      )}

      {/* ========================= ASSIGNMENTS =========================== */}
      {tab === 'assignments' && (
        <div className="space-y-6">
          <div className="bg-white rounded-3xl border border-[#EBDECE]/60 p-6 space-y-4">
            <h3 className="font-display font-black text-sm text-[#2E2A26] uppercase tracking-wide flex items-center gap-2">
              <Users className="h-4 w-4 text-[#A46832]" /> Assign a module
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-2xs">
              <div>
                <label htmlFor="academy-assignment-module" className={labelCls}>Module</label>
                <select id="academy-assignment-module" className={inputCls} value={assignModuleId} onChange={(e) => pickModuleForAssign(e.target.value)}>
                  <option value="">— pick a module —</option>
                  {assessments.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="academy-assignment-due" className={labelCls}>Due date {assignModule ? `(default: ${assignModule.dueDays ?? 7} days)` : ''}</label>
                <input id="academy-assignment-due" type="date" min={todayStr()} className={inputCls} value={assignDue} onChange={(e) => setAssignDue(e.target.value)} />
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={createAssignments}
                  className="w-full px-4 py-2.5 bg-[#A46832] hover:bg-[#A5642B] text-white rounded-xl text-2xs tracking-widest uppercase font-black cursor-pointer shadow-xs"
                >
                  Assign to {assignStaff.size || 'selected'} staff
                </button>
              </div>
            </div>

            <div>
              <label className={labelCls}>Team members</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1">
                {employeesList.map((e) => {
                  const picked = assignStaff.has(e.id);
                  const already = assignModule ? openAssignmentExists(assignModule.id, e.id) : false;
                  const completed = assignModule ? certificates.some((c) => c.assessmentId === assignModule.id && c.employeeId === e.id) : false;
                  return (
                    <label key={e.id} className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer select-none transition-all ${picked ? 'bg-[#2E2A26] border-[#2E2A26] text-white' : 'bg-[#FBFBFC] border-neutral-200 text-[#2E2A26] hover:border-[#A46832]'}`}>
                      <input type="checkbox" checked={picked} onChange={() => toggleStaff(e.id)} className="h-4 w-4 accent-[#A46832]" />
                      <span className="text-2xs font-extrabold truncate">{e.name}</span>
                      <span className={`ml-auto text-[8px] uppercase font-black tracking-wider shrink-0 ${picked ? 'text-white/60' : 'text-neutral-400'}`}>
                        {already ? 'open' : completed ? 'completed' : e.storeName || e.role}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-[#EBDECE]/60 overflow-hidden">
            <table className="w-full text-2xs text-left">
              <thead>
                <tr className="bg-[#FBFBFC] text-[9px] uppercase tracking-widest font-black text-neutral-400 border-b border-neutral-100">
                  <th className="p-4">Team member</th>
                  <th className="p-4">Module</th>
                  <th className="p-4">Assigned</th>
                  <th className="p-4">Due</th>
                  <th className="p-4">Status</th>
                  <th className="p-4">Score</th>
                  <th className="p-4" />
                </tr>
              </thead>
              <tbody>
                {sortedAssignments.length === 0 && (
                  <tr><td colSpan={7} className="p-8 text-center text-neutral-400 font-semibold">No assignments yet — pick a module and some team members above.</td></tr>
                )}
                {sortedAssignments.map((a) => {
                  const overdue = isOverdue(a);
                  return (
                    <tr key={a.id} className="border-b border-neutral-50 hover:bg-[#FBFBFC]">
                      <td className="p-4 font-extrabold text-[#2E2A26]">{a.employeeName}</td>
                      <td className="p-4 font-semibold">{a.assessmentTitle}{!assessments.some((m) => m.id === a.assessmentId) && <span className="text-neutral-400"> (module removed)</span>}</td>
                      <td className="p-4 font-mono text-neutral-500">{fmtDate(a.assignedAt)}</td>
                      <td className={`p-4 font-mono font-black ${overdue ? 'text-rose-600' : 'text-neutral-500'}`}>{fmtDate(a.dueDate)}</td>
                      <td className="p-4">
                        <span className={`px-2 py-1 rounded-full text-[9px] uppercase font-black tracking-wider ${
                          a.status === 'completed' ? 'bg-emerald-50 text-emerald-700'
                          : overdue ? 'bg-rose-50 text-rose-600'
                          : a.status === 'in_progress' ? 'bg-amber-50 text-amber-700'
                          : 'bg-neutral-100 text-neutral-500'
                        }`}>
                          {a.status === 'completed' ? 'Completed' : overdue ? 'Overdue' : a.status === 'in_progress' ? 'In progress' : 'Assigned'}
                        </span>
                      </td>
                      <td className="p-4 font-mono font-black text-[#2E2A26]">{a.status === 'completed' && typeof a.score === 'number' ? `${a.score}%` : '—'}</td>
                      <td className="p-4 text-right">
                        <button type="button" onClick={() => removeAssignment(a)} className="p-1.5 rounded-lg border bg-red-50 border-red-200 text-red-500 hover:bg-red-100 cursor-pointer" title="Remove assignment"><Trash className="h-3 w-3" /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================= CERTIFICATES ========================== */}
      {tab === 'certificates' && (
        <div className="bg-white rounded-3xl border border-[#EBDECE]/60 overflow-hidden">
          <table className="w-full text-2xs text-left">
            <thead>
              <tr className="bg-[#FBFBFC] text-[9px] uppercase tracking-widest font-black text-neutral-400 border-b border-neutral-100">
                <th className="p-4">Certificate no.</th>
                <th className="p-4">Team member</th>
                <th className="p-4">Module</th>
                <th className="p-4">Score</th>
                <th className="p-4">Issued</th>
                <th className="p-4">E-mailed</th>
              </tr>
            </thead>
            <tbody>
              {sortedCerts.length === 0 && (
                <tr><td colSpan={6} className="p-8 text-center text-neutral-400 font-semibold">No certificates yet — they appear here automatically the moment a team member passes a module.</td></tr>
              )}
              {sortedCerts.map((c) => (
                <tr key={c.id} className="border-b border-neutral-50 hover:bg-[#FBFBFC]">
                  <td className="p-4 font-mono font-black text-[#A46832]">{c.id}</td>
                  <td className="p-4 font-extrabold text-[#2E2A26]">{c.employeeName}</td>
                  <td className="p-4 font-semibold">{c.assessmentTitle}</td>
                  <td className="p-4 font-mono font-black">{c.score}%</td>
                  <td className="p-4 font-mono text-neutral-500">{fmtDate(c.issuedAt)}</td>
                  <td className="p-4">
                    {c.emailedAt ? (
                      <span className="inline-flex items-center gap-1 text-[#5FA777] font-black text-[10px]"><Mail className="h-3 w-3" /> {fmtDate(c.emailedAt)}</span>
                    ) : (
                      <span className="text-neutral-400 font-semibold">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/** Loose YouTube detection for the builder hint (mirrors LessonVideo). */
function youTubeLike(url: string): boolean {
  return /youtube(?:-nocookie)?\.com\/|youtu\.be\//i.test(url);
}
