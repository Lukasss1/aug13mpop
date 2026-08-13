import React from 'react';
import type { EmployeeRole, StaffDocument } from '../../types';

interface CompliancePanelProps {
  documents: StaffDocument[];
  currentRole: EmployeeRole;
  openingDocumentId: string | null;
  lifecycleBusy: boolean;
  deleteBusy: boolean;
  onOpen: (documentId: string) => void | Promise<void>;
  onApprove: (document: StaffDocument) => void | Promise<void>;
  onDelete: (document: StaffDocument) => void | Promise<void>;
}

/** Compliance presentation; signed-URL and lifecycle handlers remain in AdminPanel. */
export const CompliancePanel = React.memo(function CompliancePanel({
  documents,
  currentRole,
  openingDocumentId,
  lifecycleBusy,
  deleteBusy,
  onOpen,
  onApprove,
  onDelete,
}: CompliancePanelProps) {
  return (
    <div className="space-y-6">
      <div><h1 className="font-display font-black text-2xl">Compliance Vault &amp; Verification</h1><p className="text-2xs text-[#2E2A26]/70">Securely verify HR contracts, passport validation logs, visa permits, and UK right-to-work checklists.</p></div>
      <div className="grid grid-cols-1 gap-4 font-sans text-2xs">
        {documents.map((document) => {
          const fileActive = (document.fileState || 'active') === 'active';
          const reconciliationLabel = document.fileState === 'deletion_pending'
            ? 'Deletion pending'
            : document.fileState === 'missing' ? 'File missing — retry deletion' : '';
          return (
          <div key={document.id} className="p-4 bg-white rounded-2xl border border-[#EBDECE]/50 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shadow-2xs">
            <div className="space-y-1.5 flex-1">
              <p className="font-extrabold text-sm text-[#2E2A26]">{document.name}</p>
              <div className="flex flex-wrap gap-2 text-[9px] font-mono text-[#2E2A26]/55">
                {document.employeeName && <span>Owner: <b>{document.employeeName}</b></span>}<span>Category: <b>{document.category.toUpperCase()}</b></span><span>Uploaded: <b>{document.uploadDate}</b></span>{document.expiryDate && <span className="text-red-500 font-bold">Expires: <b>{document.expiryDate}</b></span>}
                {document.storagePath && fileActive ? <button type="button" disabled={openingDocumentId !== null} onClick={() => { void onOpen(document.id); }} className="text-[#A46832] underline font-bold cursor-pointer disabled:opacity-50">{openingDocumentId === document.id ? 'Opening…' : 'Open file'}</button> : <span className="italic text-[#2E2A26]/35" title="Legacy record — the file was never stored centrally">no file attached</span>}
              {reconciliationLabel && <span className="font-bold text-amber-700" title={document.deletionError || reconciliationLabel}>{reconciliationLabel}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full ${document.status === 'approved' ? 'bg-[#5CA459]/20 text-[#5CA459]' : 'bg-amber-100 text-[#A46832]'}`}>{document.status.toUpperCase()}</span>
              {fileActive && document.status === 'pending' && <button type="button" onClick={() => { void onApprove(document); }} disabled={lifecycleBusy} className="px-4 py-2 bg-[#5CA459] hover:bg-[#4E8E4B] text-white font-extrabold text-[9px] rounded-full uppercase cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Sign-Off</button>}
              {currentRole === 'owner' && <button type="button" disabled={deleteBusy} onClick={() => { void onDelete(document); }} className="p-1.5 px-3 border border-red-200 text-red-500 hover:bg-red-50 rounded-lg text-[9px] font-black uppercase cursor-pointer disabled:opacity-50">Delete</button>}
            </div>
          </div>
          );
        })}
        {documents.length === 0 && <div className="rounded-2xl border border-dashed border-[#EBDECE] bg-white p-8 text-center text-sm text-[#2E2A26]/60">No compliance documents are available.</div>}
      </div>
    </div>
  );
});
