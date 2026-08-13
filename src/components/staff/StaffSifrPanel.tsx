import React, { useState } from 'react';
import { Send } from 'lucide-react';
import type { CreateSIFRReportInput, EmployeeProfile, SIFRReport } from '../../types';
import { useSingleFlight } from '../../hooks/useSingleFlight';

interface StaffSifrPanelProps {
  employee: EmployeeProfile;
  reports: SIFRReport[];
  onAddReport: (input: CreateSIFRReportInput) => Promise<boolean>;
  onAddReply: (reportId: string, message: string) => Promise<boolean>;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
}

const EMPTY_REPORT: CreateSIFRReportInput = {
  title: '',
  category: 'operations',
  involvedPeople: '',
  description: '',
  impact: '',
  suggestedAction: '',
  confidentiality: 'standard',
};

const StaffSifrPanel: React.FC<StaffSifrPanelProps> = ({
  employee,
  reports,
  onAddReport,
  onAddReply,
  addToast,
}) => {
  const sifrFlight = useSingleFlight();
  const [form, setForm] = useState<CreateSIFRReportInput>(EMPTY_REPORT);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const canManage = employee.role === 'owner' || employee.role === 'store_manager';

  const submitReport = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const input: CreateSIFRReportInput = {
      title: form.title.trim(),
      category: form.category,
      involvedPeople: form.involvedPeople.trim(),
      description: form.description.trim(),
      impact: form.impact.trim(),
      suggestedAction: form.suggestedAction.trim(),
      confidentiality: form.confidentiality,
    };

    if (!input.title || !input.description || !input.impact || !input.suggestedAction) {
      addToast('Complete the title, description, impact and suggested action.', 'error');
      return;
    }

    void sifrFlight.run('create-report', async () => {
      const ok = await onAddReport(input);
      if (!ok) {
        addToast('The server did not confirm the observation. Your form has been kept so you can retry; reload the report first.', 'error');
        return;
      }
      addToast('The operations observation has been submitted for management review.', 'success');
      setForm(EMPTY_REPORT);
    });
  };

  const submitReply = (reportId: string): void => {
    if (!canManage) return;
    const message = replyDrafts[reportId]?.trim();
    if (!message) return;

    void sifrFlight.run(`reply:${reportId}`, async () => {
      const ok = await onAddReply(reportId, message);
      if (!ok) {
        addToast('The server did not confirm the management reply. Reload the report before retrying.', 'error');
        return;
      }
      addToast('Comment posted.', 'success');
      setReplyDrafts((current) => ({ ...current, [reportId]: '' }));
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start text-left">
      <div className="lg:col-span-8 space-y-6">
        <div className="bg-white p-6 rounded-3xl border border-[#EBDECE] flex items-center justify-between">
          <div>
            <h2 className="font-display text-md font-black text-[#5FA777] uppercase tracking-wide">SIFR Incident Registers</h2>
            <p className="text-2xs text-gray-400 mt-1">Staff Incident and Feedback Reports.</p>
          </div>
          <span className="text-[10px] font-mono text-gray-400 uppercase">Operational observations</span>
        </div>

        <div className="space-y-6">
          {reports.map((report) => (
            <div key={report.id} className="bg-white p-6 rounded-3xl border border-[#EBDECE]/50 shadow-2xs space-y-4">
              <div className="flex items-center justify-between mb-2">
                <div className="space-y-0.5">
                  <h3 className="font-display font-black text-xs text-[#2E2A26] uppercase tracking-wide">{report.title}</h3>
                  <div className="flex items-center gap-2 text-[10px] text-gray-400">
                    <span>Category: {report.category}</span>
                    <span>•</span>
                    <span>Store: {report.storeName}</span>
                  </div>
                </div>

                <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full ${
                  report.status === 'resolved' ? 'bg-[#5FA777]/20 text-[#5FA777]' : 'bg-amber-100 text-[#A46832]'
                }`}>
                  {report.status}
                </span>
              </div>

              <div className="bg-[#FFFFFF] p-4 rounded-2xl text-xs space-y-2 text-[#2E2A26]/85 font-light">
                <p><span className="font-bold text-[#2E2A26]">Observation Description: </span>{report.description}</p>
                <p><span className="font-bold text-[#2E2A26]">Impact Parameters: </span>{report.impact}</p>
                <p><span className="font-bold text-[#2E2A26]">Suggested action: </span>{report.suggestedAction}</p>
              </div>

              {report.replies && report.replies.length > 0 && (
                <div className="space-y-3 pt-3 border-t border-gray-100">
                  <h4 className="text-[10px] uppercase font-black tracking-widest text-[#A46832]">Comments & Actions</h4>
                  {report.replies.map((comment) => (
                    <div key={comment.id} className="bg-[#7CC0C7]/10 p-3 rounded-xl space-y-1">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="font-extrabold">{comment.user} ({comment.role.replace('_', ' ')})</span>
                        <span className="text-gray-400 font-mono">{new Date(comment.timestamp).toLocaleDateString()}</span>
                      </div>
                      <p className="text-2xs text-gray-600 font-light leading-relaxed">{comment.message}</p>
                    </div>
                  ))}
                </div>
              )}

              {canManage && (
                <div className="flex items-center gap-3 pt-2">
                  <input
                    id={`sifr-comment-input-${report.id}`}
                    type="text"
                    placeholder="Add a management response..."
                    value={replyDrafts[report.id] || ''}
                    onChange={(event) => setReplyDrafts((current) => ({ ...current, [report.id]: event.target.value }))}
                    className="flex-1 text-2xs p-2.5 bg-[#FFFFFF] border rounded-lg focus:outline-none"
                  />
                  <button
                    id={`sifr-comment-submit-${report.id}`}
                    type="button"
                    aria-label={`Send management response for incident ${report.id}`}
                    disabled={sifrFlight.isBusy}
                    onClick={() => submitReply(report.id)}
                    className="p-2.5 bg-[#2E2A26] text-white rounded-lg hover:bg-[#A46832] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="lg:col-span-4 bg-white p-6 rounded-3xl border border-[#EBDECE] space-y-4">
        <h3 className="font-display text-xs uppercase font-extrabold tracking-widest text-[#5FA777]">Post SIFR Observation</h3>

        <form onSubmit={submitReport} className="space-y-4">
          <div>
            <label className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Observation Title</label>
            <input
              id="sifr-title-input"
              type="text"
              required
              placeholder="e.g. Blenders Seal Calibration Error"
              value={form.title}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Category</label>
              <select
                id="sifr-category-select"
                value={form.category}
                onChange={(event) => setForm((current) => ({ ...current, category: event.target.value as CreateSIFRReportInput['category'] }))}
                className="w-full text-xs p-2.5 bg-[#FFFFFF] border rounded-xl"
              >
                <option value="attendance">Attendance</option>
                <option value="operations">Operations</option>
                <option value="health_safety">Safety</option>
                <option value="customer_service">Guest Care</option>
                <option value="teamwork">Teamwork</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Visibility</label>
              <select
                id="sifr-confidential-select"
                value={form.confidentiality}
                onChange={(event) => setForm((current) => ({ ...current, confidentiality: event.target.value as CreateSIFRReportInput['confidentiality'] }))}
                className="w-full text-xs p-2.5 bg-[#FFFFFF] border rounded-xl"
              >
                <option value="standard">Standard report</option>
                <option value="confidential">Sensitive — authorised managers can see my identity</option>
              </select>
              <p className="mt-1 text-[9px] leading-relaxed text-gray-400">
                Sensitive reports are restricted to authorised management, but your verified identity is retained for safeguarding and follow-up.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Involved Personnel</label>
            <input
              id="sifr-personnel-input"
              type="text"
              placeholder="Marcus, Sarah Jenkins"
              value={form.involvedPeople}
              onChange={(event) => setForm((current) => ({ ...current, involvedPeople: event.target.value }))}
              className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Description of Incident</label>
            <textarea
              id="sifr-desc-input"
              required
              placeholder="State what you observed objectively..."
              value={form.description}
              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
              className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none h-20"
            />
          </div>

          <div>
            <label className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Operational Impact</label>
            <textarea
              id="sifr-impact-input"
              required
              placeholder="How does this impact recipe safety or speed?"
              value={form.impact}
              onChange={(event) => setForm((current) => ({ ...current, impact: event.target.value }))}
              className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none h-16"
            />
          </div>

          <div>
            <label className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Suggested action</label>
            <textarea
              id="sifr-action-input"
              required
              placeholder="What should the team do to stop this happening?"
              value={form.suggestedAction}
              onChange={(event) => setForm((current) => ({ ...current, suggestedAction: event.target.value }))}
              className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none h-16"
            />
          </div>

          <button
            id="sifr-form-submit-btn"
            type="submit"
            disabled={sifrFlight.isBusy}
            className="w-full py-3.5 disabled:opacity-50 disabled:cursor-not-allowed bg-[#5FA777] hover:bg-[#2E2A26] text-white rounded-full text-xs font-black uppercase tracking-wider transition-colors cursor-pointer"
          >
            {sifrFlight.activeKey === 'create-report' ? 'Submitting…' : 'Submit observation'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default React.memo(StaffSifrPanel);
