/**
 * Parse the compact opening-hours format used by the Store editor into
 * schema.org OpeningHoursSpecification rows.
 *
 * Accepted examples:
 *   Mon-Sat: 09:00 - 21:00 | Sun: 11:00 - 17:00
 *   Mon–Sat 09:00–21:00 · Sun 11:00–17:00
 */

const DAY_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export interface OpeningHoursSpecification {
  '@type': 'OpeningHoursSpecification';
  dayOfWeek: string[];
  opens: string;
  closes: string;
}

const normaliseDay = (value: string): string =>
  value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();

const normaliseClock = (value: string): string => {
  const [hours = '', minutes = ''] = value.split(':');
  return `${hours.padStart(2, '0')}:${minutes}`;
};

export function parseOpeningHours(openingHours: string): OpeningHoursSpecification[] {
  const specs: OpeningHoursSpecification[] = [];
  const normalised = String(openingHours ?? '')
    .replace(/[–—−]/g, '-')
    .replace(/[·•;]/g, '|');

  for (const segment of normalised.split('|')) {
    const match = segment.trim().match(
      /^([a-z]{3})(?:\s*-\s*([a-z]{3}))?\s*:?\s*((?:[01]?\d|2[0-3]):[0-5]\d)\s*-\s*((?:[01]?\d|2[0-3]):[0-5]\d)$/i,
    );
    if (!match) continue;

    const startKey = normaliseDay(match[1]!);
    const endKey = match[2] ? normaliseDay(match[2]) : startKey;
    const from = DAY_KEYS.indexOf(startKey as (typeof DAY_KEYS)[number]);
    const to = DAY_KEYS.indexOf(endKey as (typeof DAY_KEYS)[number]);
    if (from === -1 || to === -1 || to < from) continue;

    specs.push({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: [...DAY_NAMES.slice(from, to + 1)],
      opens: normaliseClock(match[3]!),
      closes: normaliseClock(match[4]!),
    });
  }

  return specs;
}
