/**
 * Owner-safe operational messages.
 *
 * Keep infrastructure actions out of ordinary settings screens: deployment
 * credentials belong in the protected hosting environment, not in the browser.
 * Stable issue codes let a non-technical owner send useful information to the
 * technical operator without exposing secrets or raw backend errors.
 */
export const OPERATOR_ISSUE_CODES = {
  cloudNotConfigured: 'MP-CLD-001',
} as const;

export function cloudNotConfiguredMessage(capability: string): string {
  return `${capability} is unavailable because cloud services are not connected. Contact technical support and quote ${OPERATOR_ISSUE_CODES.cloudNotConfigured}.`;
}
