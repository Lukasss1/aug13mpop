import React, { useMemo } from 'react';
import { Edit, FileText, Trash } from 'lucide-react';
import type { CareerVacancy, JobApplication, PublishableContentTable } from '../../types';
import { InboxStatusBar, type InboxStatus } from './InboxStatusBar';
import { PublicationBadge, PublishButton } from './PublicationControls';

interface CareersPanelProps {
  isOwner: boolean;
  canPublishVacancies: boolean;
  inboxStatus: InboxStatus;
  onRefreshInbox: () => void;
  vacancies: CareerVacancy[];
  applications: JobApplication[];
  busyAction: string | null;
  cvLoadingId: string | null;
  onCreateVacancy: () => void;
  onEditVacancy: (vacancy: CareerVacancy) => void;
  onTogglePublication: (
    table: PublishableContentTable,
    id: string,
    publish: boolean,
    label: string,
  ) => Promise<void>;
  onCloseVacancy: (vacancy: CareerVacancy) => Promise<void>;
  onDeleteVacancy: (vacancy: CareerVacancy) => Promise<void>;
  onViewCv: (application: JobApplication) => Promise<void>;
  onTransitionApplication: (
    application: JobApplication,
    status: JobApplication['status'],
  ) => Promise<void>;
}

/**
 * Careers presentation for the small-business admin workspace.
 *
 * The panel owns no persistence and no permission decisions. All vacancy,
 * candidate, CV and publication actions remain guarded by the parent/server;
 * extracting the view only prevents unrelated admin form edits from rebuilding
 * this comparatively long list.
 */
export const CareersPanel = React.memo(function CareersPanel({
  isOwner,
  canPublishVacancies,
  inboxStatus,
  onRefreshInbox,
  vacancies,
  applications,
  busyAction,
  cvLoadingId,
  onCreateVacancy,
  onEditVacancy,
  onTogglePublication,
  onCloseVacancy,
  onDeleteVacancy,
  onViewCv,
  onTransitionApplication,
}: CareersPanelProps) {
  const vacancyCounts = useMemo(() => {
    let live = 0;
    for (const vacancy of vacancies) {
      if (vacancy.status === 'published') live += 1;
    }
    return { live, inactive: vacancies.length - live };
  }, [vacancies]);

  return (
    <div className="space-y-6">
      <InboxStatusBar status={inboxStatus} onRefresh={onRefreshInbox} />
      <div className="flex justify-between items-center">
        <div>
          <h1 className="font-display font-black text-2xl">Careers Vacancy & Recruitment</h1>
          <p className="text-2xs text-[#2E2A26]/70">Publish active store opportunities, change candidate selection parameters, and schedule store trials.</p>
        </div>
        {/* Vacancy persistence is owner-only. Managers may still review
            applications already scoped to their store by the server. */}
        {isOwner && (
          <button
            onClick={onCreateVacancy}
            className="px-4 py-2 bg-[#A46832] text-white rounded-full text-2xs font-black uppercase tracking-wider"
          >
            Create Opportunity
          </button>
        )}
      </div>

      <div className="space-y-4">
        <h3 className="font-display font-black text-xs uppercase tracking-wide">
          Vacancies ({vacancyCounts.live} live · {vacancyCounts.inactive} draft or closed)
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {vacancies.map((vacancy, index) => (
            <div key={vacancy.id} className={`p-4 bg-white ${index % 2 === 0 ? 'mp-blob-l' : 'mp-blob-r'} border border-[#EBDECE] mp-shadow mp-lift space-y-2`}>
              <div className="flex justify-between items-start gap-2">
                <div>
                  <h4 className="font-extrabold text-sm text-[#2E2A26]">{vacancy.title}</h4>
                  <p className="text-[9px] font-mono text-[#A5642B]/70 uppercase">{vacancy.department} · {vacancy.location} · {vacancy.type} · {vacancy.salary}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <PublicationBadge live={vacancy.status === 'published'} closed={vacancy.status === 'closed'} />
                  <PublishButton
                    table="job_vacancies"
                    canPublish={canPublishVacancies}
                    busyAction={busyAction}
                    onToggle={onTogglePublication}
                    id={vacancy.id}
                    live={vacancy.status === 'published'}
                    label={`Vacancy "${vacancy.title}"`}
                  />
                  {isOwner && (
                    <>
                      <button
                        onClick={() => onEditVacancy(vacancy)}
                        className="p-1.5 border border-[#EBDECE] rounded-xl rounded-tr-sm text-[#A46832] hover:bg-[#F7EFE6] cursor-pointer"
                        aria-label="Edit vacancy"
                      >
                        <Edit className="h-3.5 w-3.5" />
                      </button>
                      {vacancy.status === 'published' && (
                        <button
                          onClick={() => { void onCloseVacancy(vacancy); }}
                          disabled={busyAction !== null}
                          className="p-1.5 border border-[#EBDECE] rounded-xl text-[#A46832] hover:bg-amber-50 cursor-pointer text-[9px] font-black uppercase disabled:opacity-50 disabled:cursor-not-allowed"
                          aria-label="Close vacancy"
                        >
                          Close
                        </button>
                      )}
                      <button
                        onClick={() => { void onDeleteVacancy(vacancy); }}
                        disabled={busyAction !== null}
                        className="p-1.5 border border-[#EBDECE] rounded-xl rounded-bl-sm text-red-500 hover:bg-red-50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Delete vacancy"
                      >
                        <Trash className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-[#2E2A26]/75 leading-relaxed line-clamp-3">
                {vacancy.roleDescription || <span className="italic text-[#2E2A26]/40">No description yet — press edit to write one.</span>}
              </p>
            </div>
          ))}
          {vacancies.length === 0 && (
            <p className="text-[10px] font-mono text-[#2E2A26]/40 col-span-2 text-center py-6">No live vacancies — create one to accept applications.</p>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="font-display font-black text-xs uppercase tracking-wide">Candidate Applications Registry</h3>
        <div className="space-y-3 font-sans text-2xs">
          {applications.map((application) => (
            <div key={application.id} className="p-4 bg-white rounded-2xl border border-[#EBDECE]/50 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
              <div className="space-y-1.5 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-extrabold text-sm text-[#2E2A26]">{application.fullName}</span>
                  <span className="text-[8px] bg-[#EBDECE] text-zinc-600 px-2 py-0.5 rounded font-mono font-bold uppercase">{application.store} store</span>
                </div>
                <p className="text-zinc-500 font-medium">
                  Applied for: <b>{application.position}</b> | Experience: "{application.experience}" | CV:{' '}
                  {application.hasCv ? (
                    <button
                      onClick={() => { void onViewCv(application); }}
                      disabled={cvLoadingId === application.id}
                      className="inline-flex items-center gap-1 text-[#A46832] font-bold font-mono underline decoration-dotted hover:text-[#2E2A26] disabled:opacity-60 cursor-pointer"
                    >
                      <FileText className="h-3 w-3" />
                      {cvLoadingId === application.id ? 'opening…' : 'view CV'}
                    </button>
                  ) : (
                    <span className="text-stone-400 font-mono italic">none attached</span>
                  )}
                </p>
                {application.message && (
                  <p className="text-[11px] bg-stone-50 p-2.5 rounded-xl border border-dotted font-light text-[#2E2A26]/80">Remarks: "{application.message}"</p>
                )}
              </div>

              <div className="flex flex-col items-end gap-2 shrink-0">
                <span className={`text-[8px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full ${application.status === 'offer' ? 'bg-[#5CA459]/25 text-[#5CA459]' : 'bg-amber-100 text-[#A46832]'}`}>
                  {application.status.toUpperCase()}
                </span>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => { void onTransitionApplication(application, 'reviewing'); }} disabled={busyAction !== null} className="p-1 border hover:bg-stone-55 rounded text-2xs font-bold font-mono disabled:opacity-50">SCREEN</button>
                  <button onClick={() => { void onTransitionApplication(application, 'interview'); }} disabled={busyAction !== null} className="p-1 border hover:bg-stone-55 rounded text-2xs font-bold font-mono disabled:opacity-50">INTERVIEW</button>
                  <button onClick={() => { void onTransitionApplication(application, 'offer'); }} disabled={busyAction !== null} className="p-1.5 bg-[#5CA459] hover:bg-[#4E8E4B] text-white rounded font-black font-mono disabled:opacity-50">MAKE OFFER</button>
                  <button onClick={() => { void onTransitionApplication(application, 'declined'); }} disabled={busyAction !== null} className="p-1 border border-red-200 text-red-500 hover:bg-red-50 rounded text-2xs font-bold font-mono disabled:opacity-50">DECLINE</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
