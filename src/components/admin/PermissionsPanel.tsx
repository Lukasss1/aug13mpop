import React from 'react';
import { Shield } from 'lucide-react';

type RefCell = 'yes' | 'store' | 'self' | 'no';
interface PermissionRefRow {
  capability: string;
  mfa?: boolean;
  team_member: RefCell;
  supervisor: RefCell;
  store_manager: RefCell;
  owner: RefCell;
  note?: Partial<Record<'team_member' | 'supervisor' | 'store_manager' | 'owner', string>>;
}

/** Mirrors the real RLS, server MFA and route rules; it never grants access. */
export const PERMISSION_REFERENCE: PermissionRefRow[] = [
  { capability: 'View own profile & earnings estimate', team_member: 'self', supervisor: 'self', store_manager: 'self', owner: 'yes' },
  { capability: 'View store staff directory (no pay)', team_member: 'no', supervisor: 'no', store_manager: 'store', owner: 'yes', mfa: true },
  { capability: 'View / edit pay rates (payroll)', team_member: 'no', supervisor: 'no', store_manager: 'no', owner: 'yes', mfa: true },
  { capability: 'View orders / sales', team_member: 'self', supervisor: 'self', store_manager: 'store', owner: 'yes', mfa: true },
  { capability: 'Approve rota / timesheets', team_member: 'no', supervisor: 'no', store_manager: 'store', owner: 'yes', mfa: true },
  { capability: 'Manage team-member / supervisor accounts', team_member: 'no', supervisor: 'no', store_manager: 'store', owner: 'yes', mfa: true },
  { capability: 'Invite / manage manager accounts', team_member: 'no', supervisor: 'no', store_manager: 'no', owner: 'yes', mfa: true },
  { capability: 'Publish menu (+ menu media)', team_member: 'no', supervisor: 'no', store_manager: 'yes', owner: 'yes', mfa: true },
  { capability: 'Edit deals / news / CMS / media library', team_member: 'no', supervisor: 'no', store_manager: 'no', owner: 'yes', mfa: true },
  { capability: 'Edit company / site settings & stores', team_member: 'no', supervisor: 'no', store_manager: 'no', owner: 'yes', mfa: true },
  { capability: 'Review job applications', team_member: 'no', supervisor: 'no', store_manager: 'store', owner: 'yes', mfa: true },
  { capability: 'Create / edit / delete vacancies', team_member: 'no', supervisor: 'no', store_manager: 'no', owner: 'yes', mfa: true },
  { capability: 'Customer messages & franchise inbox', team_member: 'no', supervisor: 'no', store_manager: 'no', owner: 'yes', mfa: true },
  { capability: 'View CVs (signed URL)', team_member: 'no', supervisor: 'no', store_manager: 'store', owner: 'yes', mfa: true },
  { capability: 'Trigger SEO rebuild', team_member: 'no', supervisor: 'no', store_manager: 'yes', owner: 'yes', mfa: true, note: { store_manager: 'menu only' } },
  { capability: 'Reserved CRM / inventory (customers, loyalty, stock)', team_member: 'no', supervisor: 'no', store_manager: 'no', owner: 'no' },
];

export const PermissionsPanel = React.memo(function PermissionsPanel() {
  return (
  <div className="space-y-6">
    <div>
      <h1 className="font-display font-black text-2xl">Permissions Reference</h1>
      <p className="text-2xs text-[#2E2A26]/70">This is a read-only reference generated from the platform's canonical role rules (database policies, MFA gates and admin navigation). It documents what each role can do — it does not itself change access. Permission changes require a controlled system update.</p>
    </div>

    <div className="flex items-start gap-2 bg-[#FBF3E9] border border-[#E7C9A6] rounded-xl p-3 text-2xs text-[#7A4B1E]">
      <Shield className="h-4 w-4 mt-0.5 shrink-0" />
      <span>Reference only. The real rules live in the database (row-level security, server-side MFA checks) and in the app's route guards. Toggling anything here previously had no effect, so the controls have been removed to keep this screen honest.</span>
    </div>

    <div className="bg-white rounded-2xl border border-[#EBDECE]/50 overflow-hidden shadow-2xs">
      <table className="w-full text-left text-2xs font-mono">
        <thead className="bg-[#DFD3C3]/40 border-b text-[10px] uppercase font-mono text-[#2E2A26]">
          <tr>
            <th className="p-4">Capability</th>
            <th className="p-4">Team member</th>
            <th className="p-4">Supervisor</th>
            <th className="p-4">Store manager</th>
            <th className="p-4">Owner</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#EBDECE]/70 text-[#2E2A26]/80">
          {PERMISSION_REFERENCE.map((row) => (
            <tr key={row.capability} className="hover:bg-[#F7EFE6]/60 align-top">
              <td className="p-4 font-bold text-[#2E2A26] font-sans text-2xs">{row.capability}
                {row.mfa && <span className="ml-1 text-[9px] font-mono text-[#A46832]" title="Requires MFA (AAL2)">· MFA</span>}
              </td>
              {(['team_member', 'supervisor', 'store_manager', 'owner'] as const).map((role) => (
                <td key={role} className="p-4 text-[10px] font-mono">
                  {row[role] === 'yes' && <span className="text-emerald-700 font-bold">✓ {row.note?.[role] ?? 'yes'}</span>}
                  {row[role] === 'store' && <span className="text-amber-700 font-bold">✓ own store</span>}
                  {row[role] === 'self' && <span className="text-amber-700 font-bold">✓ own only</span>}
                  {row[role] === 'no' && <span className="text-stone-400">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
  );
});
