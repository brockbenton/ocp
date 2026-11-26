// August is the first month of the fall semester; everything before it is spring.
const FALL_START_MONTH = 7;

/** The semester a date falls in, matching the backend's rule. */
export function semesterFor(date: Date): string {
  const season = date.getUTCMonth() >= FALL_START_MONTH ? 'Fall' : 'Spring';
  return `${season} ${date.getUTCFullYear()}`;
}
