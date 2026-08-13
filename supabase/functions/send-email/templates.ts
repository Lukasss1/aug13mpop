// ============================================================================
//  MILK POP — send-email TEMPLATE CATALOGUE  (Block C / requirement C2)
//
//  Every e-mail the platform can send is defined HERE, server-side. The client
//  sends only a template id + structured params + a recipient reference; it can
//  NEVER send raw HTML or a recipient address. That is the core of the rebuild:
//  an attacker holding a valid staff token still cannot inject markup or relay
//  to an arbitrary inbox — they can only trigger a fixed template to a DB-
//  resolved recipient, rate-limited and audited (see index.ts).
//
//  SAFETY RULES for anyone editing templates
//  -----------------------------------------
//   • EVERY value that comes from params or the database MUST pass through
//     esc() (HTML-escape) before it lands in the markup. Multi-line bodies use
//     nl2br(). There is no code path that inserts an un-escaped string.
//   • Subjects are single-lined (oneLine) to prevent header injection.
//   • Templates are pure string builders — no I/O, no secrets, no DB access.
//     The function (index.ts) owns auth, recipient resolution, rate limits and
//     the audit row; templates only turn safe data into HTML.
// ============================================================================

export type Role = 'team_member' | 'supervisor' | 'store_manager' | 'owner';

export type RecipientKind =
  | 'staff'        // any address on a staff_profiles row
  | 'application'  // the address on a specific job_applications row
  | 'contact'      // the address on a specific contact_messages row
  | 'franchise'    // the address on a specific franchise_inquiries row
  | 'self';        // the caller's own staff address (test e-mail)

export interface RenderContext {
  /** Brand name for the header/footer (length-capped by the caller). */
  brand: string;
  /** Recipient display name, resolved SERVER-SIDE from the DB row. */
  recipientName: string;
  /** Structured, data-only params from the client (never HTML). */
  params: Record<string, unknown>;
}

export interface TemplateDef {
  /** Which class of recipient this template may be sent to. */
  recipientKind: RecipientKind;
  /** Least-privilege: the minimum staff role allowed to send it. */
  minRole: Role;
  /** Turn safe data into a subject + HTML body. */
  render: (ctx: RenderContext) => { subject: string; html: string };
}

/* ------------------------------------------------------------------ */
/*  Shared helpers — escaping is mandatory, not optional.              */
/* ------------------------------------------------------------------ */

/** HTML-escape any value. The single reason the client may not send HTML. */
export const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Escape, then turn newlines into <br/> for staff-authored message bodies. */
const nl2br = (v: unknown): string => esc(v).replace(/\r?\n/g, '<br/>');

/** Collapse to a single line (subjects / from-names — blocks header injection). */
export const oneLine = (v: unknown): string =>
  String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();

/** First name for a friendly greeting, safely defaulted. */
const first = (name: string): string => (oneLine(name).split(' ')[0] || 'there');

const money = (v: unknown, sym: string): string => `${esc(sym)}${(Number(v) || 0).toFixed(2)}`;
const hrs = (v: unknown): string => `${(Number(v) || 0).toFixed(2)} hrs`;

const str = (v: unknown): string => oneLine(v);

/** Basic address shape check (defence in depth; the DB is the allow-list). */
export const isValidEmail = (e: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/* ------------------------------------------------------------------ */
/*  Role ranking + recipient source tables (used by index.ts).        */
/* ------------------------------------------------------------------ */
const RANK: Record<string, number> = { team_member: 1, supervisor: 2, store_manager: 3, owner: 4 };
export const roleAtLeast = (role: string, min: Role): boolean =>
  (RANK[role] || 0) >= (RANK[min] || 99);

/** How index.ts resolves a recipient address from a named DB row (never the
 *  client). `self` is handled directly from the caller's own profile. */
export const RECIPIENT_SOURCES: Record<Exclude<RecipientKind, 'self'>, { table: string; nameCol: string }> = {
  staff:       { table: 'staff_profiles',      nameCol: 'name' },
  application: { table: 'job_applications',    nameCol: 'full_name' },
  contact:     { table: 'contact_messages',    nameCol: 'full_name' },
  franchise:   { table: 'franchise_inquiries', nameCol: 'full_name' },
};

/* ------------------------------------------------------------------ */
/*  Branded shell — matches the original notify.ts styling.           */
/* ------------------------------------------------------------------ */
const wrap = (title: string, body: string, brand: string): string => `
<div style="font-family:Arial,Helvetica,sans-serif;background:#F7F1E8;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #EBDECE">
    <div style="background:#BD783A;padding:20px 28px">
      <span style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:2px">${esc(brand).toUpperCase()}</span>
    </div>
    <div style="padding:28px">
      <h2 style="margin:0 0 12px;color:#2E2A26;font-size:18px">${esc(title)}</h2>
      ${body}
    </div>
    <div style="background:#EBDECE;padding:14px 28px;color:#2E2A26;font-size:11px">
      This is an automated message from the ${esc(brand)} staff platform. Please do not reply.
    </div>
  </div>
</div>`;

const genericBody = (message: string): string =>
  `<p style="color:#2E2A26;font-size:14px;margin:0">${nl2br(message)}</p>`;

/* ------------------------------------------------------------------ */
/*  THE CATALOGUE                                                       */
/* ------------------------------------------------------------------ */
export const TEMPLATES: Record<string, TemplateDef> = {
  /* ---- Staff notifications ---------------------------------------- */

  // Payslip available. Payroll is owner-only across the platform, so is this.
  payslip_available: {
    recipientKind: 'staff',
    minRole: 'owner',
    render: ({ brand, recipientName, params }) => {
      const sym = str(params.currencySymbol) || '£';
      const row = (label: string, value: string, strong = false) =>
        `<tr><td style="padding:8px 0;color:#6b6b6b;font-size:13px">${esc(label)}</td>
         <td style="padding:8px 0;text-align:right;font-size:13px;color:#2E2A26;${strong ? 'font-weight:800' : ''}">${value}</td></tr>`;
      const body = `
        <p style="color:#2E2A26;font-size:14px;margin:0 0 16px">Hi ${esc(first(recipientName))}, your earnings estimate for <b>${esc(str(params.periodLabel))}</b> is now available.</p>
        <table style="width:100%;border-collapse:collapse;border-top:1px solid #EBDECE;border-bottom:1px solid #EBDECE">
          ${row('Pay period', esc(str(params.periodLabel)))}
          ${row('Approved hours', hrs(params.hoursTotal))}
          ${row('Hourly rate', money(params.hourlyRate, sym))}
          ${row('Estimated gross earnings', money(params.gross, sym), true)}
        </table>
        <p style="color:#6b6b6b;font-size:12px;margin:16px 0 0">You can also view this estimate any time in your Staff Dashboard.</p>
        <p style="color:#6b6b6b;font-size:11px;margin:12px 0 0">This is an estimate only, not an official payroll document. PAYE, National Insurance and pension are not calculated here.</p>`;
      return { subject: oneLine(`Your ${str(params.periodLabel)} earnings estimate is available`), html: wrap('Your earnings estimate is available', body, brand) };
    },
  },

  // New shift scheduled. Managers/owners write the rota, so they send this.
  shift_scheduled: {
    recipientKind: 'staff',
    minRole: 'store_manager',
    render: ({ brand, recipientName, params }) => {
      const dateISO = str(params.dateISO);
      let niceDate = dateISO;
      const d = new Date(dateISO + 'T00:00:00');
      if (!isNaN(d.getTime())) {
        niceDate = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      }
      const shortDate = (() => {
        const dd = new Date(dateISO + 'T00:00:00');
        return isNaN(dd.getTime()) ? dateISO : dd.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      })();
      const notes = str(params.notes);
      const body = `
        <p style="color:#2E2A26;font-size:14px;margin:0 0 16px">Hi ${esc(first(recipientName))}, a new shift has been scheduled for you.</p>
        <div style="background:#F7F1E8;border:1px solid #EBDECE;border-radius:12px;padding:16px">
          <p style="margin:0 0 6px;color:#2E2A26;font-size:14px"><b>${esc(niceDate)}</b></p>
          <p style="margin:0 0 6px;color:#2E2A26;font-size:14px">${esc(str(params.startTime))} – ${esc(str(params.endTime))} · ${esc(str(params.shiftType).toUpperCase())}</p>
          <p style="margin:0;color:#6b6b6b;font-size:13px">${esc(str(params.storeName))}</p>
          ${notes ? `<p style="margin:8px 0 0;color:#6b6b6b;font-size:12px">Notes: ${esc(notes)}</p>` : ''}
        </div>
        <p style="color:#6b6b6b;font-size:12px;margin:16px 0 0">Check your full rota in the Staff Dashboard.</p>`;
      return { subject: oneLine(`New shift scheduled — ${shortDate}`), html: wrap('You have a new shift scheduled', body, brand) };
    },
  },

  // Generic staff notice (free-form title + body written by a manager/owner).
  staff_notification: {
    recipientKind: 'staff',
    minRole: 'store_manager',
    render: ({ brand, params }) => {
      const title = str(params.title) || 'A message from the team';
      return { subject: oneLine(title), html: wrap(title, genericBody(str(params.body)), brand) };
    },
  },

  /* ---- Application replies (job candidates) ----------------------- */

  application_interview: {
    recipientKind: 'application',
    minRole: 'store_manager',
    render: ({ brand, recipientName, params }) => {
      const body = `Hi ${first(recipientName)}, thank you for applying for the ${str(params.position)} role. We'd love to invite you to an interview — we'll be in touch shortly to arrange a time.`;
      return { subject: oneLine(`Your ${brand} application — interview invitation`), html: wrap('Interview invitation', genericBody(body), brand) };
    },
  },

  application_offer: {
    recipientKind: 'application',
    minRole: 'store_manager',
    render: ({ brand, recipientName, params }) => {
      const body = `Hi ${first(recipientName)}, we're delighted to offer you the ${str(params.position)} position. We'll follow up with your contract and start details very soon. Welcome to the team!`;
      return { subject: oneLine(`Great news about your ${brand} application!`), html: wrap('You have an offer!', genericBody(body), brand) };
    },
  },

  application_declined: {
    recipientKind: 'application',
    minRole: 'store_manager',
    render: ({ brand, recipientName, params }) => {
      const body = `Hi ${first(recipientName)}, thank you for your interest in the ${str(params.position)} role. After careful review we won't be moving forward this time, but we'd love to see you apply again in the future.`;
      return { subject: oneLine(`Your ${brand} application`), html: wrap('Thank you for applying', genericBody(body), brand) };
    },
  },

  // Free-form reply to a candidate (staff writes the subject + body).
  application_reply: {
    recipientKind: 'application',
    minRole: 'store_manager',
    render: ({ brand, params }) => {
      const subject = str(params.subject) || `Your ${brand} application`;
      return { subject: oneLine(subject), html: wrap(subject, genericBody(str(params.body)), brand) };
    },
  },

  /* ---- Enquiry responses ------------------------------------------ */

  // Reply to a customer contact message.
  enquiry_reply: {
    recipientKind: 'contact',
    minRole: 'owner',            // Stage 2.1 F3: contact inbox is owner-only
    render: ({ brand, params }) => {
      const reason = str(params.reason);
      const subject = reason ? `Re: ${reason}` : `A message from ${brand}`;
      return { subject: oneLine(subject), html: wrap(subject, genericBody(str(params.body)), brand) };
    },
  },

  // Reply to a franchise enquiry.
  franchise_reply: {
    recipientKind: 'franchise',
    minRole: 'owner',            // Stage 2.1 F3: franchise inbox is owner-only
    render: ({ brand, params }) => {
      const subject = str(params.subject) || `Your ${brand} franchise enquiry`;
      return { subject: oneLine(subject), html: wrap(subject, genericBody(str(params.body)), brand) };
    },
  },

  /* ---- Training Academy -------------------------------------------- */

  // Certificate of completion — sent automatically to the STAFF MEMBER'S OWN
  // address the moment they pass a module. recipientKind 'self' means the
  // function resolves the address from the caller's own linked profile: a
  // team member can only ever trigger this e-mail to themselves, so minRole
  // team_member is safe (there is no relay surface).
  training_certificate: {
    recipientKind: 'self',
    minRole: 'team_member',
    render: ({ brand, recipientName, params }) => {
      const moduleTitle = str(params.moduleTitle) || 'Training module';
      const certNo = str(params.certNo);
      const score = Math.max(0, Math.min(100, Number(params.score) || 0));
      const category = str(params.category);
      const badge = str(params.badge);
      const issuedDate = (() => {
        const d = new Date(str(params.issuedAtISO));
        return isNaN(d.getTime())
          ? new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
          : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      })();
      const body = `
        <p style="color:#2E2A26;font-size:14px;margin:0 0 16px">Congratulations ${esc(first(recipientName))} — you have successfully completed your training. This e-mail is your certificate of completion; keep it for your records.</p>
        <div style="background:#F7F1E8;border:2px solid #BD783A;border-radius:14px;padding:22px;text-align:center">
          <p style="margin:0 0 4px;color:#BD783A;font-size:11px;font-weight:800;letter-spacing:2px">CERTIFICATE OF COMPLETION</p>
          <p style="margin:0 0 10px;color:#2E2A26;font-size:18px;font-weight:800">${esc(moduleTitle)}</p>
          <p style="margin:0 0 2px;color:#2E2A26;font-size:14px">Awarded to <b>${esc(oneLine(recipientName))}</b></p>
          <p style="margin:0 0 12px;color:#6b6b6b;font-size:12px">${esc(issuedDate)}${category ? ` · ${esc(category.toUpperCase())}` : ''}</p>
          <table style="width:100%;border-collapse:collapse;border-top:1px solid #EBDECE">
            <tr>
              <td style="padding:10px 0;color:#6b6b6b;font-size:12px">Final score</td>
              <td style="padding:10px 0;text-align:right;color:#2E2A26;font-size:12px;font-weight:800">${score}%</td>
            </tr>
            ${badge ? `<tr>
              <td style="padding:0 0 10px;color:#6b6b6b;font-size:12px">Badge earned</td>
              <td style="padding:0 0 10px;text-align:right;color:#2E2A26;font-size:12px;font-weight:800">🏅 ${esc(badge)}</td>
            </tr>` : ''}
            ${certNo ? `<tr>
              <td style="padding:0;color:#6b6b6b;font-size:12px">Certificate no.</td>
              <td style="padding:0;text-align:right;color:#2E2A26;font-size:12px;font-family:monospace">${esc(certNo)}</td>
            </tr>` : ''}
          </table>
        </div>
        <p style="color:#6b6b6b;font-size:12px;margin:16px 0 0">Your certificate is also stored in the Academy and visible to your manager.</p>`;
      return {
        subject: oneLine(`Certificate of completion — ${moduleTitle}`),
        html: wrap('You passed! 🎉', body, brand),
      };
    },
  },

  /* ---- Diagnostics ------------------------------------------------ */

  // "Send test e-mail" from Company Settings. Recipient is the caller only.
  test_email: {
    recipientKind: 'self',
    minRole: 'store_manager',
    render: ({ brand }) => ({
      subject: oneLine(`${brand} — test e-mail`),
      html: wrap('It works!', genericBody('This is a test message from your staff platform. Staff, rota and applicant messages use this configured delivery channel.'), brand),
    }),
  },
};

export type TemplateId = keyof typeof TEMPLATES;
