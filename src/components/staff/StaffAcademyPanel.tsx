import React, { useState } from 'react';
import type {
  EmployeeProfile,
  TrainingAssessment,
  TrainingAssignment,
  TrainingCertificate,
  TrainingQuestion,
} from '../../types';
import { DragDropQuestion, parseDragTemplate, isDragAnswerCorrect } from '../DragDropQuestion';
import { LessonVideo } from '../LessonVideo';
import { sendTemplateEmail, emailPayloads } from '../../lib/notify';

interface StaffAcademyPanelProps {
  employee: EmployeeProfile;
  assessments?: TrainingAssessment[];
  trainingAssignments: TrainingAssignment[];
  trainingCertificates: TrainingCertificate[];
  businessDate: string;
  staffDataStatus: 'idle' | 'loading' | 'live' | 'error';
  onUpdateAssignment?: (assignment: TrainingAssignment) => Promise<boolean>;
  onCompleteTraining: (args: {
    assessmentId: string;
    score: number;
    submissionId: string;
    assignmentId?: string;
    answers?: (string | (string | null)[])[];
  }) => Promise<{
    ok: boolean;
    passed?: boolean;
    score?: number;
    newCertificate?: boolean;
    certificate?: TrainingCertificate | null;
    pointsAwarded?: number;
    badgeAwarded?: string | null;
  }>;
  onCertificateEmailed?: (certificateId: string) => Promise<boolean>;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
}

const STALE_STATE_MESSAGE = 'Internal data is not fully loaded. Retry before making changes.';

const StaffAcademyPanel: React.FC<StaffAcademyPanelProps> = ({
  employee,
  assessments,
  trainingAssignments,
  trainingCertificates,
  businessDate,
  staffDataStatus,
  onUpdateAssignment,
  onCompleteTraining,
  onCertificateEmailed,
  addToast,
}) => {
  const [activeAcademyCourse, setActiveAcademyCourse] = useState<TrainingAssessment | null>(null);
  const [activeAcademyCourseLessonIndex, setActiveAcademyCourseLessonIndex] = useState(0);
  const [showAcademyQuiz, setShowAcademyQuiz] = useState(false);
  const [academyQuizUserAnswers, setAcademyQuizUserAnswers] = useState<Record<number, string>>({});
  const [academyQuizChecked, setAcademyQuizChecked] = useState(false);
  const [academyQuizPassed, setAcademyQuizPassed] = useState(false);
  const [academyServerScore, setAcademyServerScore] = useState<number | null>(null);
  const [academySubmitting, setAcademySubmitting] = useState(false);
  const [academyDragAnswers, setAcademyDragAnswers] = useState<Record<number, (string | null)[]>>({});
  const [academyVideoDone, setAcademyVideoDone] = useState<Record<number, boolean>>({});

  const hasAnswerKey = (question: TrainingQuestion): boolean => {
    if (question.type === 'drag_drop' && question.dragTemplate) return !question.dragTemplate.includes('⋯');
    return typeof question.correctAnswer === 'string' && question.correctAnswer.length > 0;
  };

  const dragWordBank = (question: TrainingQuestion): string[] => [
    ...parseDragTemplate(question.dragTemplate || '').answers,
    ...(question.dragDistractors || []),
  ];
  const dragPlacedWords = (question: TrainingQuestion, ids: (string | null)[]): (string | null)[] => {
    const bank = dragWordBank(question);
    return ids.map((id) => {
      if (!id) return null;
      const index = Number(id.slice(1));
      return Number.isFinite(index) ? bank[index] ?? null : null;
    });
  };
  const isQuestionAnswered = (question: TrainingQuestion, index: number): boolean => {
    if (question.type === 'drag_drop' && question.dragTemplate) {
      const placed = academyDragAnswers[index];
      const gaps = parseDragTemplate(question.dragTemplate).answers.length;
      return !!placed && placed.length === gaps && placed.every(Boolean);
    }
    return academyQuizUserAnswers[index] !== undefined;
  };
  const isQuestionCorrect = (question: TrainingQuestion, index: number): boolean => {
    if (question.type === 'drag_drop' && question.dragTemplate) {
      return isDragAnswerCorrect(
        parseDragTemplate(question.dragTemplate).answers,
        dragPlacedWords(question, academyDragAnswers[index] || []),
      );
    }
    return academyQuizUserAnswers[index] === question.correctAnswer;
  };

  const emailCertificate = async (certificate: TrainingCertificate, badge: string): Promise<void> => {
    const error = await sendTemplateEmail(emailPayloads.trainingCertificate(certificate, badge));
    if (!error) {
      const recorded = onCertificateEmailed ? await onCertificateEmailed(certificate.id) : true;
      if (recorded) addToast('📧 Your certificate has been e-mailed to you.', 'success');
      else addToast('The certificate e-mail was sent, but its sent status was not recorded. Ask a manager to verify before sending it again.', 'warning');
    } else {
      addToast(`Certificate saved — e-mail not sent: ${error}`, 'warning');
    }
  };

  const refuseIfNotLive = (): boolean => {
    if (staffDataStatus === 'live') return false;
    addToast(STALE_STATE_MESSAGE, 'error');
    return true;
  };

  return (
  <div className="space-y-8 text-left font-sans animate-fade-in pb-12">
    <div className="bg-white p-6 rounded-3xl border border-[#EBDECE] flex flex-col sm:flex-row items-center justify-between gap-4">
      <div>
        <h2 className="font-display text-sm uppercase font-extrabold tracking-wider text-[#A46832]">Training</h2>
        <p className="text-2xs text-gray-400 mt-1">Complete Milk Pop’s internal training modules, study approved product guidance and keep a record of your progress.</p>
      </div>
      <div className="bg-[#7CC0C7]/30 px-6 py-3 rounded-2xl text-center shrink-0">
        <span className="block text-2xs uppercase text-[#2E2A26] font-black tracking-widest">Training progress</span>
        <span className="block text-lg font-mono font-black text-[#2E2A26]">Level {employee.level}</span>
      </div>
    </div>

    
    {!activeAcademyCourse ? (
      /* Course Cards List Workspace */
      <div className="space-y-6">
        {/* My internal training records strip */}
        {trainingCertificates.filter((c) => c.employeeId === employee?.id).length > 0 && (
          <div className="bg-white rounded-3xl border border-[#EBDECE]/45 p-5 space-y-3">
            <h3 className="text-[10px] uppercase tracking-widest font-black text-neutral-400">My internal training records</h3>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {trainingCertificates
                .filter((c) => c.employeeId === employee?.id)
                .sort((a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || ''))
                .map((c) => (
                  <div key={c.id} className="shrink-0 bg-[#FBFBFC] border border-[#EBDECE] rounded-2xl px-4 py-3 min-w-52">
                    <p className="font-mono font-black text-[10px] text-[#A46832]">{c.id}</p>
                    <p className="font-extrabold text-2xs text-[#2E2A26] mt-1 leading-snug">{c.assessmentTitle}</p>
                    <p className="text-[10px] font-mono text-neutral-400 mt-1">
                      {c.score}% · {new Date(c.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  </div>
                ))}
            </div>
          </div>
        )}

        {(assessments || []).length === 0 && (
          <div className="rounded-3xl border border-dashed border-[#EBDECE] bg-white p-8 text-center">
            <p className="text-xs font-black text-[#2E2A26]">No training modules have been published.</p>
            <p className="mt-1 text-2xs text-neutral-500">Your manager will publish approved Milk Pop training here when it is ready.</p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {(assessments || []).map((ass) => {
            const myCert = trainingCertificates.find((c) => c.employeeId === employee?.id && c.assessmentId === ass.id);
            const completed = !!myCert || employee?.badges?.includes(ass.badge);
            const openAssignment = trainingAssignments
              .filter((a) => a.employeeId === employee?.id && a.assessmentId === ass.id && a.status !== 'completed')
              .sort((a, b) => (b.assignedAt || '').localeCompare(a.assignedAt || ''))[0];
            const overdue = !!openAssignment && openAssignment.dueDate < businessDate;
            return (
              <div key={ass.id} className={`bg-white p-6 rounded-3xl border shadow-3xs flex flex-col justify-between space-y-4 ${overdue ? 'border-rose-300' : 'border-[#EBDECE]/45'}`}>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] uppercase font-black bg-[#EBDECE]/40 text-[#2E2A26] px-2.5 py-1 rounded-full">
                        {ass.category}
                      </span>
                      {ass.mandatory && (
                        <span className="text-[10px] uppercase font-black bg-rose-50 text-rose-600 px-2.5 py-1 rounded-full">Mandatory</span>
                      )}
                    </div>
                    {openAssignment && (
                      <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full shrink-0 ${overdue ? 'bg-rose-100 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>
                        {overdue ? '⚠ Overdue — ' : 'Due '}
                        {new Date(openAssignment.dueDate + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </span>
                    )}
                  </div>

                  <h3 className="font-display font-black text-sm text-[#2E2A26] leading-snug">{ass.title}</h3>
                  <p className="text-2xs text-[#2E2A26]/80 font-light leading-relaxed">{ass.description}</p>
                </div>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] font-bold">
                      <span className="text-gray-400 uppercase tracking-widest font-sans font-extrabold">Status</span>
                      <span>{completed ? `Completed${myCert ? ` · ${myCert.score}%` : ''}` : openAssignment?.status === 'in_progress' ? 'In progress' : openAssignment ? 'Assigned to you' : 'Pending'}</span>
                    </div>
                    <div className="w-full bg-stone-150 h-2.5 rounded-full overflow-hidden border border-neutral-200">
                      <div className={`h-full ${completed ? 'bg-[#5FA777]' : 'bg-[#A46832]'}`} style={{ width: completed ? '100%' : openAssignment?.status === 'in_progress' ? '45%' : '10%' }} />
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t border-gray-150">
                    <span className="text-[10px] text-[#A46832] font-bold uppercase tracking-wider font-sans">+{ass.points} points</span>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveAcademyCourse(ass);
                        setActiveAcademyCourseLessonIndex(0);
                        setShowAcademyQuiz(false);
                        setAcademyQuizUserAnswers({});
                        setAcademyDragAnswers({});
                        setAcademyVideoDone({});
                        setAcademyQuizChecked(false);
                        setAcademyQuizPassed(false);
                        const assigned = trainingAssignments.find(
                          (a) => a.employeeId === employee?.id && a.assessmentId === ass.id && a.status === 'assigned',
                        );
                        if (assigned && onUpdateAssignment) void onUpdateAssignment({ ...assigned, status: 'in_progress' });
                        addToast(`Opened: ${ass.title}`, 'success');
                      }}
                      className={`px-4 py-2 rounded-full text-2xs uppercase tracking-widest font-extrabold border-0 cursor-pointer transition-all ${
                        completed
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-100 hover:bg-emerald-100'
                          : 'bg-[#2E2A26] text-white hover:bg-[#A46832]'
                      }`}
                    >
                      {completed ? 'Review Assessment ✓' : 'Start training'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    ) : (
      /* Interactive Course Workspace */
      <div className="bg-white rounded-3xl border border-[#EBDECE]/60 shadow-sm p-6 sm:p-8 space-y-6 relative z-10">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-neutral-100 pb-4 gap-4">
          <button
            type="button"
            onClick={() => setActiveAcademyCourse(null)}
            className="px-4 py-1.5 bg-neutral-100 hover:bg-[#EBDECE]/20 text-[#2E2A26] rounded-full text-2xs uppercase tracking-wider font-extrabold transition-all border-0 cursor-pointer"
          >
            ← Back to training
          </button>
          
          <div className="text-right">
            <h4 className="font-display font-black text-sm text-[#2E2A26] uppercase tracking-wide inline-block mr-1">{activeAcademyCourse.title}</h4>
            <span className="text-[9px] uppercase font-bold tracking-widest text-neutral-400 bg-neutral-100 px-2 py-0.5 rounded">
              {activeAcademyCourse.category}
            </span>
          </div>
        </div>

        {!showAcademyQuiz ? (
          <div className="space-y-6">
            {activeAcademyCourse.slides && activeAcademyCourse.slides.length > 0 ? (
              <div className="space-y-6">
                 <div className="flex justify-between items-center text-xs font-mono text-neutral-400">
                   <span>Slide {activeAcademyCourseLessonIndex + 1} of {activeAcademyCourse.slides.length+1}</span>
                   <div className="h-1.5 w-32 bg-neutral-100 rounded-full overflow-hidden">
                      <div className="h-full bg-[#A46832] transition-all" style={{ width: `${((activeAcademyCourseLessonIndex + 1) / (activeAcademyCourse.slides.length+1)) * 100}%` }} />
                   </div>
                 </div>
                 
                 {activeAcademyCourseLessonIndex < activeAcademyCourse.slides.length ? (() => {
                   const slide = activeAcademyCourse.slides[activeAcademyCourseLessonIndex];
                   if (!slide) return null;
                   return (
                   <div className="bg-[#FBFBFC] rounded-2xl border border-neutral-200 p-8 space-y-6 animate-fade-in shadow-sm">
                     <h3 className="font-display font-medium text-[#2E2A26] text-xl border-b pb-4">
                       {slide.title}
                     </h3>
                     {slide.type === 'video' && slide.videoUrl ? (
                       <div className="space-y-4">
                         <LessonVideo
                           key={`${activeAcademyCourse.id}-${activeAcademyCourseLessonIndex}`}
                           videoUrl={slide.videoUrl}
                           noSkip={!!slide.noSkip}
                           completed={!!academyVideoDone[activeAcademyCourseLessonIndex]}
                           onCompleted={() => setAcademyVideoDone((prev) => ({ ...prev, [activeAcademyCourseLessonIndex]: true }))}
                         />
                         {slide.content && (
                           <div className="text-sm text-neutral-700 leading-loose whitespace-pre-wrap">
                             {slide.content}
                           </div>
                         )}
                       </div>
                     ) : (
                       <div className="text-sm text-neutral-700 leading-loose whitespace-pre-wrap">
                         {slide.content}
                       </div>
                     )}
                   </div>
                   );
                 })() : (
                   <div className="bg-[#FBFBFC] rounded-2xl border border-neutral-200 p-8 space-y-6 animate-fade-in shadow-sm items-center flex flex-col text-center">
                     <h3 className="font-display font-medium text-[#2E2A26] text-xl border-b pb-4 w-full">
                       Slides Completed
                     </h3>
                     <div className="text-sm text-neutral-700 leading-loose whitespace-pre-wrap pb-4">
                       You have completed all learning material for this module. Are you ready to take the exam?
                     </div>
                     <button
                       type="button"
                       onClick={() => setShowAcademyQuiz(true)}
                       className="px-8 py-3 bg-[#A46832] hover:bg-[#2E2A26] text-white text-xs font-extrabold uppercase rounded-full cursor-pointer transition-all shadow-md"
                     >
                       Take Exam
                     </button>
                   </div>
                 )}

                 <div className="flex justify-between pt-4 border-t border-neutral-100">
                   <button
                     type="button"
                     disabled={activeAcademyCourseLessonIndex === 0}
                     onClick={() => setActiveAcademyCourseLessonIndex(i => Math.max(0, i - 1))}
                     className="px-6 py-3 bg-neutral-100 hover:bg-neutral-200 text-[#2E2A26] text-2xs font-extrabold uppercase rounded-full cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                   >
                     Previous
                   </button>
                   {activeAcademyCourseLessonIndex < activeAcademyCourse.slides.length && (() => {
                     const curSlide = activeAcademyCourse.slides![activeAcademyCourseLessonIndex];
                     const nextLocked = curSlide?.type === 'video' && !!curSlide.noSkip && !!curSlide.videoUrl && !academyVideoDone[activeAcademyCourseLessonIndex];
                     return (
                       <div className="flex flex-col items-end gap-1.5">
                         <button
                           type="button"
                           disabled={nextLocked}
                           onClick={() => setActiveAcademyCourseLessonIndex(i => Math.min(activeAcademyCourse.slides!.length, i + 1))}
                           className="px-6 py-3 bg-[#2E2A26] hover:bg-[#A46832] text-white text-2xs font-extrabold uppercase rounded-full cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[#2E2A26]"
                         >
                           {nextLocked ? '🔒 Next Slide' : 'Next Slide'}
                         </button>
                         {nextLocked && (
                           <span className="text-[9px] font-black uppercase tracking-widest text-neutral-400">Finish the video to continue</span>
                         )}
                       </div>
                     );
                   })()}
                 </div>
              </div>
            ) : (
              <div className="space-y-6">
                <h3 className="font-display font-medium text-neutral-950 text-md border-b pb-2">
                  Learning Objectives
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {activeAcademyCourse.learningObjectives?.map((obj, i) => (
                     <div key={i} className="flex items-start gap-2 bg-[#FFFFFF] p-4 rounded-xl">
                       <div className="h-2 w-2 rounded-full bg-[#A46832] mt-1.5 shrink-0" />
                       <span className="text-xs font-semibold text-[#2E2A26]">{obj}</span>
                     </div>
                  ))}
                </div>
                <div className="flex justify-end pt-4 border-t border-neutral-100">
                  <button
                    type="button"
                    onClick={() => setShowAcademyQuiz(true)}
                    className="px-6 py-3 bg-[#A46832] hover:bg-[#2E2A26] text-white text-2xs font-extrabold uppercase rounded-full cursor-pointer transition-all"
                  >
                    Proceed to Assessment
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6 text-left">
            <div className="bg-[#FBFBFC] rounded-2xl border border-neutral-200 p-6 space-y-4">
              <span className="text-[9px] uppercase tracking-widest font-black text-[#5FA777] bg-emerald-50 border border-[#5FA777] px-3 py-1 rounded-full inline-block">
                FINAL ASSESSMENT: {activeAcademyCourse.title}
              </span>
              <p className="text-xs text-neutral-500 font-light leading-relaxed">
                {(() => {
                  const total = activeAcademyCourse.questions?.length || 0;
                  const passMark = Math.min(100, Math.max(1, activeAcademyCourse.passingScore || 80));
                  const need = Math.ceil((passMark / 100) * total);
                  return `Score at least ${passMark}% (${need} of ${total} questions) to pass and earn the ${activeAcademyCourse.badge} badge.`;
                })()}
              </p>
            </div>

            <div className="space-y-6 max-h-[60vh] overflow-y-auto pr-4 custom-scrollbar">
              {activeAcademyCourse.questions?.map((q, qIdx) => {
                const isUserIncorrect = hasAnswerKey(q) && isQuestionAnswered(q, qIdx) && !isQuestionCorrect(q, qIdx);

                if (q.type === 'drag_drop' && q.dragTemplate) {
                  const gapCount = parseDragTemplate(q.dragTemplate).answers.length;
                  return (
                    <div key={qIdx} className="bg-white p-5 rounded-2xl border border-neutral-200/80 space-y-3">
                      <h4 className="text-xs font-bold text-[#2E2A26]">
                        {qIdx + 1}. {q.text || 'Drag each word into the right gap:'}
                      </h4>
                      <DragDropQuestion
                        template={q.dragTemplate}
                        distractors={q.dragDistractors}
                        wordBank={q.dragWords}
                        value={academyDragAnswers[qIdx] ?? Array(gapCount).fill(null)}
                        onChange={(placed) => setAcademyDragAnswers((prev) => ({ ...prev, [qIdx]: placed }))}
                        checked={academyQuizChecked}
                      />
                      {academyQuizChecked && isUserIncorrect && (
                        <p className="text-3xs text-rose-600 font-medium pl-6 bg-rose-50/50 p-2 rounded-lg border border-rose-100/40">
                          {q.explanation}
                        </p>
                      )}
                    </div>
                  );
                }

                return (
                  <div key={qIdx} className="bg-white p-5 rounded-2xl border border-neutral-200/80 space-y-3">
                    <h4 className="text-xs font-bold text-[#2E2A26]">
                      {qIdx + 1}. {q.text}
                    </h4>
                    <div className="grid grid-cols-1 gap-2 pt-1">
                      {q.options.map((opt, oIdx) => {
                        const isSelected = academyQuizUserAnswers[qIdx] === opt;
                        const showColors = academyQuizChecked && hasAnswerKey(q);
                        const isCorrect = opt === q.correctAnswer;
                        
                        let btnStyle = 'bg-[#FBFBFC] hover:bg-neutral-100 border-neutral-205 text-[#2E2A26] font-medium';
                        if (isSelected && !showColors) {
                          btnStyle = 'bg-stone-900 border-stone-900 text-white font-bold';
                        } else if (showColors) {
                          if (isCorrect) {
                            btnStyle = 'bg-emerald-50 border-[#5FA777]/50 text-emerald-950 font-bold';
                          } else if (isSelected && !isCorrect) {
                            btnStyle = 'bg-rose-50 border-rose-300 text-rose-900';
                          }
                        }

                        return (
                          <button
                            type="button"
                            key={oIdx}
                            disabled={academyQuizChecked}
                            onClick={() => setAcademyQuizUserAnswers(prev => ({ ...prev, [qIdx]: opt }))}
                            className={`w-full text-left p-3 rounded-xl border text-2xs tracking-snug transition-all flex items-center space-x-2.5 cursor-pointer ${btnStyle}`}
                          >
                            <span>{opt}</span>
                          </button>
                        );
                      })}
                    </div>
                    {academyQuizChecked && isUserIncorrect && (
                      <p className="text-3xs text-rose-600 font-medium pl-6 bg-rose-50/50 p-2 rounded-lg border border-rose-100/40">
                        {q.explanation}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 p-4 border-t pt-6 bg-[#FFFFFF] rounded-2xl mt-4">
              <div>
                {academyQuizChecked && (
                  <p className={`text-xs font-black ${academyQuizPassed ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {(() => {
                      // FIX-9: the SERVER'S grade is the recorded one; the local
                      // recount only exists for manager sessions that still hold
                      // the answer keys.
                      const qs = activeAcademyCourse.questions || [];
                      const local = qs.length ? Math.round((qs.filter((q, i) => isQuestionCorrect(q, i)).length / qs.length) * 100) : 0;
                      const score = academyServerScore ?? local;
                      const passMark = Math.min(100, Math.max(1, activeAcademyCourse.passingScore || 80));
                      return academyQuizPassed
                        ? `✓ ${score}% — EXCELLENT! BADGE EARNED.`
                        : `✗ ${score}% — BELOW THE ${passMark}% PASS MARK. REVIEW AND RETRY.`;
                    })()}
                  </p>
                )}
              </div>

              <div className="flex space-x-2 shrink-0">
                {academyQuizChecked && !academyQuizPassed && (
                  <button
                    type="button"
                    onClick={() => {
                      setAcademyQuizUserAnswers({});
                      setAcademyDragAnswers({});
                      setAcademyQuizChecked(false);
                      setAcademyQuizPassed(false);
                      setAcademyServerScore(null);
                      addToast('Logs reset. Review slides and retry!', 'warning');
                    }}
                    className="px-5 py-3 bg-neutral-900 text-white rounded-xl text-2xs uppercase tracking-widest font-extrabold border-0 cursor-pointer"
                  >
                    Retry Assessment
                  </button>
                )}

                {!academyQuizChecked ? (
                  <button
                    type="button"
                    onClick={async () => {
                      if (academySubmitting) return;
                      const qs = activeAcademyCourse.questions || [];
                      const correctCount = qs.filter((q, i) => isQuestionCorrect(q, i)).length;
                      const score = qs.length ? Math.round((correctCount / qs.length) * 100) : 0;
                      // STAGE 4: completion is ONE server transaction. The
                      // submission id is derived from the answers, so a retry
                      // of the SAME submission replays the SAME stored result
                      // (no duplicate certificates, points or badges).
                      const answerSig = JSON.stringify({ a: academyQuizUserAnswers, d: academyDragAnswers });
                      let h = 5381; for (let i = 0; i < answerSig.length; i++) h = ((h * 33) ^ answerSig.charCodeAt(i)) >>> 0;
                      const submissionId = `sub_${employee.id}_${activeAcademyCourse.id}_${h.toString(36)}`;
                      const assignment = trainingAssignments.find(x => x.employeeId === employee.id && x.assessmentId === activeAcademyCourse.id && x.status !== 'completed');
                      // The SERVER grades these against the stored questions —
                      // the local score above only drives the instant UI colours.
                      const answers = qs.map((q, i) =>
                        q.type === 'drag_drop' && q.dragTemplate
                          ? dragPlacedWords(q, academyDragAnswers[i] || [])
                          : (academyQuizUserAnswers[i] ?? ''));
                      if (refuseIfNotLive()) return; // T13-8
                      setAcademySubmitting(true);
                      const res = await onCompleteTraining({
                        assessmentId: activeAcademyCourse.id,
                        score,
                        submissionId,
                        ...(assignment ? { assignmentId: assignment.id } : {}),
                        answers,
                      }).finally(() => setAcademySubmitting(false));
                      if (!res.ok) {
                        addToast('The server did not confirm your answers. Reload your progress before retrying.', 'error');
                        return;
                      }
                      setAcademyQuizChecked(true);
                      setAcademyQuizPassed(!!res.passed);
                      if (typeof res.score === 'number') {
                        setAcademyServerScore(res.score);
                        // Only manager sessions hold answer keys, so only THEY can
                        // produce a meaningful local preview worth reconciling.
                        const keysHeld = qs.every((q) => hasAnswerKey(q));
                        if (keysHeld && res.score !== score) {
                          addToast(`The server graded this attempt at ${res.score}% (the page preview said ${score}%). The server's grade is the recorded one.`, 'warning');
                        }
                      }
                      if (res.passed) {
                        if (res.newCertificate && res.certificate) {
                          addToast(`Congratulations! You earned the ${res.badgeAwarded || activeAcademyCourse.badge} badge (+${res.pointsAwarded || 0} pts).`, 'success');
                          void emailCertificate(res.certificate, res.badgeAwarded || activeAcademyCourse.badge);
                        } else {
                          addToast('Passed! This module was already completed — your existing training record and points stand.', 'success');
                        }
                      } else {
                        addToast('Assessment failed. Review and retry.', 'error');
                      }
                    }}
                    disabled={academySubmitting || (activeAcademyCourse.questions || []).some((q, i) => !isQuestionAnswered(q, i))}
                    className="px-6 py-3.5 bg-emerald-600 disabled:opacity-40 hover:bg-neutral-950 text-white rounded-xl text-2xs uppercase tracking-widest font-extrabold border-0 cursor-pointer"
                  >
                    Submit Assessment
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setActiveAcademyCourse(null)}
                    className="px-6 py-3.5 bg-[#2E2A26] text-white rounded-xl text-2xs uppercase tracking-widest font-extrabold border-0 cursor-pointer"
                  >
                    Back to Academy
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )}
  </div>
  );
};

export default React.memo(StaffAcademyPanel);
