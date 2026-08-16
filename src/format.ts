/**
 * Table and time formatting shared by the listing tools.
 *
 * These were a jq program piped into an awk program. Both were correct; both
 * were also the reason nobody touched the output, because changing a column
 * meant editing two languages that agree only by convention about which field
 * is which.
 */

const SECOND = 1;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
const MONTH = 2_629_800;
const YEAR = 31_557_600;

/** `3 hours ago`, matching the jq original's thresholds exactly. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';

  // Clamped at zero: a clock a second behind the server should read "0 seconds
  // ago", never "-1 seconds ago".
  const seconds = Math.max(0, (now.getTime() - then) / 1000);

  const scale = (unit: number, name: string): string => {
    const count = Math.floor(seconds / unit);
    return `${count} ${name}${count === 1 ? '' : 's'} ago`;
  };

  if (seconds < MINUTE) return scale(SECOND, 'second');
  if (seconds < HOUR) return scale(MINUTE, 'minute');
  if (seconds < DAY) return scale(HOUR, 'hour');
  if (seconds < WEEK) return scale(DAY, 'day');
  if (seconds < MONTH) return scale(WEEK, 'week');
  if (seconds < YEAR) return scale(MONTH, 'month');
  return scale(YEAR, 'year');
}

/** Collapse the whitespace that would otherwise break a row across lines. */
export const clean = (value: unknown): string => String(value ?? '').replace(/[\t\r\n]+/g, ' ');

export function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

// Written as an escape rather than a literal 0x1B byte: the raw character is
// invisible in a diff and does not survive every copy-paste intact.
const ESC = '\u001b';

/** An OSC-8 terminal hyperlink. */
export const hyperlink = (text: string, url: string): string =>
  `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;

export interface TableOptions {
  /** Column indices to wrap in a link to the row's `url`. */
  linkColumns?: readonly number[];
  /** Per-row link target, by row index (header is row 0). */
  urls?: readonly (string | undefined)[];
  hyperlinks?: boolean;
  gap?: string;
}

/**
 * Pad columns to the widest cell, then join.
 *
 * Padding is measured on the *unlinked* text. An OSC-8 escape is zero-width on
 * screen but a dozen characters to `String.length`, so padding the decorated
 * cell throws every following column out by the length of a URL — which is how
 * the awk version stayed correct: it padded first and decorated second.
 */
export function table(rows: readonly (readonly string[])[], options: TableOptions = {}): string {
  const { linkColumns = [], urls = [], hyperlinks = false, gap = '  ' } = options;

  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }

  return rows
    .map((row, rowIndex) => {
      const url = urls[rowIndex];
      const last = row.length - 1;

      return row
        .map((cell, column) => {
          const padded = column < last ? cell.padEnd(widths[column] ?? 0) : cell;
          const decorate =
            hyperlinks && rowIndex > 0 && url && linkColumns.includes(column);
          // Trailing pad sits outside the link so the clickable region is the
          // text, not the whitespace after it.
          if (!decorate) return padded;
          const trimmed = padded.trimEnd();
          return hyperlink(trimmed, url) + ' '.repeat(padded.length - trimmed.length);
        })
        .join(gap)
        .trimEnd();
    })
    .join('\n');
}

/** Terminal hyperlinks only make sense on a real terminal. */
export const supportsHyperlinks = (stream: { isTTY?: boolean } = process.stdout): boolean =>
  Boolean(stream.isTTY) && (process.env.TERM ?? 'dumb') !== 'dumb';
