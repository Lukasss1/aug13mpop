/**
 * @file notify.ts
 * @description E-mail notification client. After the Block C rebuild the client
 * NO LONGER builds any HTML: it sends a server-side template id + structured
 * params + a recipient *reference* (a DB row id, or "self"), and the
 * `send-email` Edge Function authenticates the caller, resolves the recipient
 * address from the database, renders the template, rate-limits and audits the
 * send. See supabase/functions/send-email/ and the security notes in README.md → 3.
 *
 * WHY NO HTML HERE: the old flow let anyone holding the public anon key POST an
 * arbitrary recipient and raw HTML — an open relay. Moving templates and
 * recipient resolution entirely server-side, behind a verified staff JWT, is
 * what closes that. The client's job is now only to name *which* template and
 * *which* on-file recipient.
 */
import { getAccessToken } from './auth';
import { isCloudConfigured, sbInvokeFunctionAuthed } from './supabase';
import { cloudNotConfiguredMessage } from './operatorMessages';
import type { EmailSettings, Payslip, WorkShift, JobApplication, ContactMessage, FranchiseInquiry } from '../types';

/** The rebuilt, authenticated Edge Function is live (Block C). */
export const EMAIL_SENDING_DISABLED = false;

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  enabled: false,
  fromName: 'Milk Pop',
  notifyNewShift: true,
  notifyPayslip: true,
};

/* ------------------------------------------------------------------ */
/*  Template contract — MUST mirror supabase/functions/send-email/     */
/*  templates.ts. The client sends ids + params, never HTML.           */
/* ------------------------------------------------------------------ */
export type EmailTemplateId =
  | 'payslip_available'
  | 'shift_scheduled'
  | 'staff_notification'
  | 'application_interview'
  | 'application_offer'
  | 'application_declined'
  | 'application_reply'
  | 'enquiry_reply'
  | 'franchise_reply'
  | 'training_certificate'
  | 'test_email';

/** A recipient is a *reference* to a DB row (never a raw address), or "self". */
export type EmailRecipient =
  | { kind: 'staff'; id: string }
  | { kind: 'application'; id: string }
  | { kind: 'contact'; id: string }
  | { kind: 'franchise'; id: string }
  | { kind: 'self' };

/** Data-only params (strings / numbers) that the server slots into a template. */
export type EmailParams = Record<string, string | number | boolean | null | undefined>;

export interface SendTemplateInput {
  templateId: EmailTemplateId;
  recipient: EmailRecipient;
  params?: EmailParams;
  /** Optional display name + brand for the template shell. */
  fromName?: string;
  brand?: string;
}

/**
 * Send a templated e-mail via the authenticated Edge Function.
 * Returns null on success, or a short, user-safe error string (never a raw
 * backend message).
 */
export async function sendTemplateEmail(input: SendTemplateInput): Promise<string | null> {
  if (EMAIL_SENDING_DISABLED) {
    return 'E-mail sending is currently disabled.';
  }
  if (!isCloudConfigured()) {
    return cloudNotConfiguredMessage('E-mail sending');
  }
  const token = await getAccessToken();
  if (!token) {
    return 'You must be signed in to send e-mail. Please sign in again.';
  }
  try {
    const res = await sbInvokeFunctionAuthed<{ ok?: boolean; error?: string }>('send-email', input, token);
    if (res && res.error) return res.error;   // the function already returns safe, coarse messages
    return null;
  } catch (e: unknown) {
    const msg = String((e as { message?: string })?.message || e);
    if (msg.includes('404')) return 'The send-email Edge Function is not deployed yet — see OWNERS-GUIDE.md (E-mail).';
    if (msg.includes('401') || msg.includes('403')) return 'Your session is not authorised to send e-mail. Please sign in again.';
    if (msg.includes('429')) return 'E-mail rate limit reached — please wait a little before sending more.';
    if (msg.includes('delivery_unconfirmed') || msg.includes('delivery was not confirmed')) {
      return 'E-mail delivery was not confirmed. Check the e-mail log before retrying.';
    }
    return 'E-mail could not be sent. Check the e-mail log before retrying.';
  }
}

/* ------------------------------------------------------------------ */
/*  Typed payload builders — keep call sites clean and prevent a       */
/*  stray raw address or HTML string from ever being passed.           */
/* ------------------------------------------------------------------ */
export const emailPayloads = {
  payslip(p: Payslip, currencySymbol: string): SendTemplateInput {
    return {
      templateId: 'payslip_available',
      recipient: { kind: 'staff', id: p.employeeId },
      params: {
        periodLabel: p.periodLabel,
        hoursTotal: p.hoursTotal,
        hourlyRate: p.hourlyRate,
        gross: p.gross,
        currencySymbol,
      },
    };
  },

  shift(shift: WorkShift): SendTemplateInput {
    return {
      templateId: 'shift_scheduled',
      recipient: { kind: 'staff', id: shift.employeeId },
      params: {
        dateISO: shift.date,
        startTime: shift.startTime,
        endTime: shift.endTime,
        shiftType: shift.type,
        storeName: shift.storeName,
        notes: shift.notes ?? '',
      },
    };
  },

  staffNotice(staffId: string, title: string, body: string): SendTemplateInput {
    return { templateId: 'staff_notification', recipient: { kind: 'staff', id: staffId }, params: { title, body } };
  },

  applicationInterview(app: JobApplication): SendTemplateInput {
    return { templateId: 'application_interview', recipient: { kind: 'application', id: app.id }, params: { position: app.position } };
  },
  applicationOffer(app: JobApplication): SendTemplateInput {
    return { templateId: 'application_offer', recipient: { kind: 'application', id: app.id }, params: { position: app.position } };
  },
  applicationDeclined(app: JobApplication): SendTemplateInput {
    return { templateId: 'application_declined', recipient: { kind: 'application', id: app.id }, params: { position: app.position } };
  },
  applicationReply(app: JobApplication, subject: string, body: string): SendTemplateInput {
    return { templateId: 'application_reply', recipient: { kind: 'application', id: app.id }, params: { subject, body } };
  },

  contactReply(msg: ContactMessage, body: string): SendTemplateInput {
    return { templateId: 'enquiry_reply', recipient: { kind: 'contact', id: msg.id }, params: { reason: msg.reason, body } };
  },
  franchiseReply(fran: FranchiseInquiry, subject: string, body: string): SendTemplateInput {
    return { templateId: 'franchise_reply', recipient: { kind: 'franchise', id: fran.id }, params: { subject, body } };
  },

  /**
   * Certificate of completion, auto-sent to the PASSING staff member's own
   * address (recipient 'self' — the server resolves the caller's address, so
   * this can never relay anywhere else). Fired by the Academy on a pass.
   */
  trainingCertificate(cert: {
    id: string; assessmentTitle: string; category: string; score: number; issuedAt: string;
  }, badge: string): SendTemplateInput {
    return {
      templateId: 'training_certificate',
      recipient: { kind: 'self' },
      params: {
        moduleTitle: cert.assessmentTitle,
        category: cert.category,
        score: cert.score,
        certNo: cert.id,
        issuedAtISO: cert.issuedAt,
        badge,
      },
    };
  },

  test(): SendTemplateInput {
    return { templateId: 'test_email', recipient: { kind: 'self' } };
  },
};
