// Singapore public holidays, hardcoded per year (spec option: hardcode current
// year's PH list as a constant). Fixed-date holidays (New Year, Labour Day,
// National Day, Christmas) are reliable; lunar/Islamic-calendar holidays
// (Chinese New Year, Hari Raya Puasa/Haji, Vesak Day, Deepavali) are gazetted
// by MOM a few years ahead but should be reconfirmed against the official
// data.gov.sg "Public Holidays" dataset before relying on this for a new year.
// When a holiday falls on a Sunday, the following Monday is also a holiday
// ("observed") — both dates are included below.

const PUBLIC_HOLIDAYS: Record<string, string[]> = {
  "2025": [
    "2025-01-01", // New Year's Day
    "2025-01-29", // Chinese New Year
    "2025-01-30", // Chinese New Year
    "2025-03-31", // Hari Raya Puasa
    "2025-04-18", // Good Friday
    "2025-05-01", // Labour Day
    "2025-05-12", // Vesak Day
    "2025-06-07", // Hari Raya Haji
    "2025-08-09", // National Day
    "2025-10-20", // Deepavali
    "2025-12-25", // Christmas Day
  ],
  "2026": [
    "2026-01-01", // New Year's Day
    "2026-02-17", // Chinese New Year
    "2026-02-18", // Chinese New Year
    "2026-03-20", // Hari Raya Puasa (tentative, subject to moon sighting)
    "2026-04-03", // Good Friday
    "2026-05-01", // Labour Day
    "2026-05-27", // Hari Raya Haji (tentative, subject to moon sighting)
    "2026-05-31", // Vesak Day (Sunday)
    "2026-06-01", // Vesak Day observed (Monday)
    "2026-08-09", // National Day (Sunday)
    "2026-08-10", // National Day observed (Monday)
    "2026-11-08", // Deepavali (Sunday)
    "2026-11-09", // Deepavali observed (Monday)
    "2026-12-25", // Christmas Day
  ],
};

/** date is a "YYYY-MM-DD" string in Singapore local time. */
export function isPublicHoliday(date: string): boolean {
  const year = date.slice(0, 4);
  return PUBLIC_HOLIDAYS[year]?.includes(date) ?? false;
}

/** True when the calendar day after `date` (a "YYYY-MM-DD" string) is a public holiday. */
export function isEveOfPublicHoliday(date: string): boolean {
  const nextDayMs = new Date(`${date}T00:00:00Z`).getTime() + 24 * 60 * 60_000;
  const nextDate = new Date(nextDayMs).toISOString().slice(0, 10);
  return isPublicHoliday(nextDate);
}
