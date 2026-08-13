import React, { useMemo, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import type { StaffDocument } from '../../types';
import { getAccessToken } from '../../lib/auth';
import { getStaffDocumentUrl } from '../../lib/staffDocs';
import { safeExternalHref } from '../../lib/safeUrl';
import { useSingleFlight } from '../../hooks/useSingleFlight';
import CompliancePanel from '../CompliancePanel';

interface StaffDocumentsPanelProps {
  employeeId: string;
  documents: StaffDocument[];
  onUploadDocument: (args: {
    file: File;
    name: string;
    category: StaffDocument['category'];
    employeeId?: string;
  }) => Promise<boolean>;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
}

const StaffDocumentsPanel: React.FC<StaffDocumentsPanelProps> = ({
  employeeId,
  documents,
  onUploadDocument,
  addToast,
}) => {
  const documentFlight = useSingleFlight();
  const [form, setForm] = useState({
    name: '',
    category: 'compliance' as StaffDocument['category'],
  });
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const visibleDocuments = useMemo(
    () => documents.filter((document) => document.employeeId === employeeId || !document.employeeId),
    [documents, employeeId],
  );

  const openDocument = async (documentId: string): Promise<void> => {
    await documentFlight.run(`open:${documentId}`, async () => {
      const preview = window.open('', '_blank');
      if (preview) {
        preview.opener = null;
        preview.document.title = 'Opening secure document…';
        preview.document.body.textContent = 'Opening secure document…';
      }

      const token = await getAccessToken();
      if (!token) {
        preview?.close();
        addToast('Your session has expired. Sign in again.', 'error');
        return;
      }

      const result = await getStaffDocumentUrl(documentId, token);
      if (result.ok === false) {
        preview?.close();
        addToast(result.message, 'error');
        return;
      }

      const safeDocumentUrl = safeExternalHref(result.data);
      if (!safeDocumentUrl) {
        preview?.close();
        addToast('That document link was not valid.', 'error');
        return;
      }

      if (preview) preview.location.replace(safeDocumentUrl);
      else window.location.assign(safeDocumentUrl);
    });
  };

  const submitUpload = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) {
      addToast('Please give the document a descriptive label (e.g. “Passport — photo page”).', 'error');
      return;
    }
    if (!file) {
      addToast('Please attach the file itself before submitting.', 'error');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      addToast('That file is over 10 MB — please attach a smaller scan or photo.', 'error');
      return;
    }

    const selectedFile = file;
    void documentFlight.run('upload', async () => {
      const ok = await onUploadDocument({ file: selectedFile, name, category: form.category });
      if (!ok) {
        addToast('The document was not uploaded. Your selected file has been kept so you can retry.', 'error');
        return;
      }

      addToast('Document uploaded to the secure vault — a store manager will verify and sign it off.', 'success');
      setForm({ name: '', category: 'compliance' });
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start text-left">
      <div className="lg:col-span-8 bg-white p-8 rounded-3xl border border-[#EBDECE] space-y-6">
        <div className="flex items-center justify-between border-b border-gray-100 pb-4">
          <div>
            <h2 className="font-display text-md font-black text-[#2E2A26] uppercase tracking-wide">My Document Locker</h2>
            <p className="text-2xs text-gray-400 mt-1">Right-to-work and safety documents your store needs on file.</p>
          </div>
          <span className="text-[10px] font-mono font-bold uppercase text-gray-400">On file: {visibleDocuments.length}</span>
        </div>

        <form onSubmit={submitUpload} className="p-4 bg-[#F7EFE6]/60 border border-dashed border-[#A46832]/50 mp-blob-b space-y-3">
          <p className="text-[10px] font-black uppercase tracking-wider text-[#2E2A26]/85">Upload a document for verification (PDF, JPEG or PNG, max 10 MB)</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="staff-doc-name" className="sr-only">Document label</label>
              <input
                id="staff-doc-name"
                type="text"
                autoComplete="off"
                required
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Label, e.g. Passport — photo page"
                className="w-full bg-white border border-[#EBDECE] p-2.5 rounded-xl rounded-tl-sm text-2xs outline-none focus:border-[#A46832]"
              />
            </div>
            <div>
              <label htmlFor="staff-doc-category" className="sr-only">Document category</label>
              <select
                id="staff-doc-category"
                value={form.category}
                onChange={(event) => setForm((current) => ({ ...current, category: event.target.value as StaffDocument['category'] }))}
                className="w-full bg-white border border-[#EBDECE] p-2.5 rounded-xl text-2xs outline-none focus:border-[#A46832]"
              >
                <option value="compliance">Compliance</option>
                <option value="id_verification">ID / Right to work</option>
                <option value="contracts">Contract</option>
                <option value="performance">Performance</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,image/jpeg,image/png"
              className="hidden"
              id="staff-doc-file"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
            <button
              type="button"
              disabled={documentFlight.isBusy}
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-2 bg-[#2E2A26] text-white text-[10px] uppercase font-black rounded-lg hover:bg-[#A46832] transition-colors cursor-pointer disabled:opacity-50"
            >
              Choose file
            </button>
            {file ? (
              <span className="text-[10px] text-[#5FA777] font-semibold mp-tilt-l2">{file.name} ✅</span>
            ) : (
              <span className="text-[10px] text-gray-400 font-light">No file selected</span>
            )}
            <button
              type="submit"
              disabled={documentFlight.isBusy}
              className="ml-auto px-4 py-2 bg-[#A46832] hover:bg-[#A5642B] text-white rounded-full text-[10px] font-black uppercase tracking-wider cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {documentFlight.activeKey === 'upload' ? 'Uploading…' : 'Submit for sign-off'}
            </button>
          </div>
        </form>

        <div className="space-y-4">
          {visibleDocuments.map((document) => (
            <div key={document.id} className="p-4 bg-[#FFFFFF] rounded-2xl border border-gray-100 flex items-center justify-between gap-4">
              <div className="flex items-start space-x-3">
                <div className="p-2.5 bg-white border rounded-xl">
                  <FileText className="h-5 w-5 text-gray-500" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-[#2E2A26]">{document.name}</h4>
                  <div className="flex items-center gap-2 text-[10px] text-gray-400 mt-0.5">
                    <span>Uploaded: {document.uploadDate}</span>
                    <span>•</span>
                    <span className="uppercase text-[9px] font-black">{document.category}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full ${
                  document.status === 'approved' ? 'bg-[#5FA777]/20 text-[#5FA777]' : 'bg-amber-100 text-[#A46832]'
                }`}>
                  {document.status}
                </span>
                {document.storagePath ? (
                  <button
                    type="button"
                    disabled={documentFlight.isBusy}
                    onClick={() => void openDocument(document.id)}
                    className="p-1 px-3 bg-white hover:bg-[#A46832]/10 text-xs font-bold rounded-lg border border-[#EBDECE] text-[#2E2A26] cursor-pointer disabled:opacity-50"
                  >
                    {documentFlight.activeKey === `open:${document.id}` ? 'Opening…' : 'View'}
                  </button>
                ) : (
                  <span className="p-1 px-3 text-[10px] text-gray-300 font-bold" title="Legacy record — the file was never stored centrally">No file</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <CompliancePanel />
    </div>
  );
};

export default React.memo(StaffDocumentsPanel);
