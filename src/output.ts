/**
 * Output contract (mirrors the sibling `uno` CLI):
 *  - `--json` prints machine JSON on stdout, nothing else on stdout.
 *  - Human-readable tables / notes go to stderr so piping `--json` stays clean.
 */

let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJson(): boolean {
  return jsonMode;
}

export function emit(data: unknown): void {
  // The primary machine result. In --json mode -> stdout JSON.
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  }
}

export function note(msg: string): void {
  // Human progress / hints -> stderr always.
  process.stderr.write(msg + "\n");
}

export function debugEnabled(): boolean {
  return !!process.env.LMC_DEBUG;
}

export function debug(...args: unknown[]): void {
  if (debugEnabled()) {
    process.stderr.write(
      "[lmc] " +
        args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
          .join(" ") +
        "\n"
    );
  }
}

/** Render an array of flat objects as a simple aligned table (stderr). */
export function table(rows: Record<string, unknown>[], columns?: string[]): void {
  if (jsonMode) return; // tables are for humans only
  if (!rows.length) {
    note("(no rows)");
    return;
  }
  const cols = columns || Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(
      c.length,
      ...rows.map((r) => String(r[c] ?? "").replace(/\n/g, " ").length)
    )
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  note(fmt(cols));
  note(fmt(widths.map((w) => "-".repeat(w))));
  for (const r of rows) {
    note(
      fmt(
        cols.map((c) => String(r[c] ?? "").replace(/\n/g, " ").slice(0, 200))
      )
    );
  }
}

/** When not in json mode, also pretty-print a value block to stderr. */
export function human(msg: string): void {
  if (!jsonMode) note(msg);
}
