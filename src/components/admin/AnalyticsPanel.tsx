import React from 'react';
import type { AdminTrainingCompletionRow } from './adminAnalytics';
import type { AdminRecruitmentBar } from './adminDashboard';

interface AnalyticsPanelProps {
  trainingCompletionRows: AdminTrainingCompletionRow[];
  recruitmentBars: AdminRecruitmentBar[];
}

export const AnalyticsPanel = React.memo(function AnalyticsPanel({
  trainingCompletionRows,
  recruitmentBars,
}: AnalyticsPanelProps) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display font-black text-2xl">Business Analytics</h1>
        <p className="text-2xs text-[#2E2A26]/70">Live metrics calculated from training, recruitment and store records in this database.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-2xl border border-[#EBDECE]/60 space-y-4">
          <h3 className="font-display font-bold text-xs uppercase tracking-wide">Course Completion Rates by Roster</h3>
          <div className="space-y-3">
            {trainingCompletionRows.map((row) => (
              <div key={row.assessmentId} className="space-y-1">
                <div className="flex justify-between text-2xs">
                  <span className="font-semibold">{row.title}</span>
                  <span className="font-mono text-[#A46832]">{row.completedActiveStaff}/{row.activeStaff} active staff completed</span>
                </div>
                <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
                  <div className="h-full bg-[#A46832] transition-all" style={{ width: `${row.percent}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-[#EBDECE]/60 space-y-4">
          <h3 className="font-display font-bold text-xs uppercase tracking-wide">Store Recruitment Pipelines</h3>
          <div className="grid grid-cols-5 h-48 items-end gap-2 text-center text-[10px]">
            {recruitmentBars.map((bar) => (
              <div key={bar.id} className="flex flex-col items-center flex-1 h-full justify-end">
                <span className="font-mono text-zinc-400 mb-1">{bar.count}</span>
                <div className="w-full bg-[#EBDECE]/60 hover:bg-[#A46832] transition-colors rounded-t-lg" style={{ height: `${bar.heightPercent}%` }} />
                <span className="text-[8px] text-stone-500 font-bold truncate w-full mt-2 leading-none">{bar.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
