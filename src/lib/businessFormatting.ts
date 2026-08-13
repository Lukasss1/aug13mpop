/**
 * Small, shared formatting boundaries for owner-editable business settings.
 * These values are presentation data, but they still need bounded shapes so a
 * typo cannot distort every price or make a production snapshot invalid.
 */

/**
 * Accept common symbols/codes such as £, €, $, US$, GBP and kr. Reject empty,
 * control-character, markup-shaped or excessively long values.
 */
export function normalizeCurrencySymbol(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4) return undefined;
  if (/[\u0000-\u001F\u007F<>]/.test(trimmed)) return undefined;
  return trimmed;
}

export function displayCurrencySymbol(value: unknown, fallback = '£'): string {
  return normalizeCurrencySymbol(value) ?? fallback;
}
