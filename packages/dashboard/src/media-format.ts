/**
 * Formatting for the recording player only — kept out of `format.ts` so the
 * player's lazy chunk imports nothing the first load would have to split
 * into a shared chunk.
 */

/** A media length as a clock — `0:42`, `12:05`, `1:02:03`. */
export function formatClock(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** A file size in the reader's locale — `820 kB`, `1.4 MB` (decimal units, as browsers show downloads). */
export function formatBytes(bytes: number, locale: string): string {
  const [unit, value] =
    bytes >= 1e9
      ? (["gigabyte", bytes / 1e9] as const)
      : bytes >= 1e6
        ? (["megabyte", bytes / 1e6] as const)
        : bytes >= 1e3
          ? (["kilobyte", bytes / 1e3] as const)
          : (["byte", bytes] as const);
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: unit === "byte" || value >= 100 ? 0 : 1,
  }).format(value);
}
