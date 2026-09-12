/**
 * Human-readable Lock rendering (`cdir lock show`), modeled on the
 * blueprint's Vibe Check panel: per-clause checkability markers
 *   ✓ machine-checkable (structural diff or executed by the verifier)
 *   ? not machine-checkable — human judges
 */

import { VibeCheck, KeepClause, CHECKABILITY_MARK, clauseCheckability } from "./types";
import { LockCheckResult } from "./check";

function describeClause(c: KeepClause): string {
  switch (c.kind) {
    case "output-unchanged":
      return `output unchanged · ${c.command ?? "(no command)"}` +
        (c.fixtures && c.fixtures.length > 0 ? ` · ${c.fixtures.length} fixture(s)` : "");
    case "api-unchanged":
      return `API unchanged · ${(c.symbols ?? []).join(", ")}`;
    case "no-new-dependency":
      return "no new dependency · manifest/lockfile diff must be empty";
    case "tests-pass":
      return `tests pass · ${c.glob ?? "(no glob)"}`;
    case "custom":
      return c.text ?? "(empty custom clause)";
  }
}

export function formatLock(lock: VibeCheck, check?: LockCheckResult): string {
  const lines: string[] = [];
  lines.push(`Vibe Check · ${lock.id} · status: ${lock.status}`);
  lines.push(``);
  lines.push(`Said    "${lock.utterance}"`);
  lines.push(`Goal    ${lock.goal}`);
  lines.push(`Interp  ${lock.interpretation}  (interpretation — editable)`);

  lines.push(``);
  if (lock.keep.length === 0) {
    lines.push(`Keep    (none)`);
  } else {
    lines.push(`Keep`);
    for (const c of lock.keep) {
      const mark = CHECKABILITY_MARK[clauseCheckability(c)];
      const checkInfo = check?.clauses.find((x) => x.clause === c);
      const suffix =
        checkInfo && checkInfo.errors.length > 0
          ? `  ✗ ${checkInfo.errors[0]}`
          : checkInfo && checkInfo.note
            ? `  · ${checkInfo.note}`
            : "";
      lines.push(`  ${mark} ${describeClause(c)}${suffix}`);
    }
  }

  lines.push(``);
  lines.push(`Change  ${lock.change}`);
  if (lock.verifyCommand) lines.push(`Verify  ${lock.verifyCommand}  (user harness — measured)`);
  if (lock.deny.length > 0) {
    lines.push(`Do not`);
    for (const d of lock.deny) lines.push(`  ✗ ${d}`);
  }

  lines.push(``);
  const b = lock.budget;
  lines.push(`Budget  ${b.files.length} file(s) declared · max ${b.maxFiles} files · max ${b.maxLines} lines`);
  for (const f of b.files) lines.push(`  ${f}`);
  if (b.symbols.length > 0) {
    lines.push(`  symbols: ${b.symbols.join(", ")}`);
  }

  if (lock.accept.length > 0) {
    lines.push(``);
    lines.push(`Accept`);
    for (const a of lock.accept) lines.push(`  ${a}`);
  }

  if (lock.assumptions.length > 0) {
    lines.push(``);
    lines.push(`Assumed`);
    for (const a of lock.assumptions) {
      const state = a.confirmed ? "confirmed" : "unconfirmed";
      lines.push(`  (${a.source}, ${state}) ${a.text}`);
    }
  }

  lines.push(``);
  lines.push(`Created ${lock.createdAt} by ${lock.createdBy}`);

  if (check) {
    lines.push(``);
    if (check.ok) {
      lines.push(`Check   ✓ valid${check.warnings.length > 0 ? ` (${check.warnings.length} warning(s))` : ""}`);
    } else {
      lines.push(`Check   ✗ invalid`);
      for (const e of check.errors) lines.push(`  ✗ ${e}`);
    }
    for (const w of check.warnings) lines.push(`  ! ${w}`);
  }

  return lines.join("\n");
}

/** One-line summary for `cdir lock ls`. */
export function formatLockLine(lock: VibeCheck): string {
  const said = lock.utterance.length > 60 ? lock.utterance.slice(0, 57) + "..." : lock.utterance;
  return `${lock.id}  ${lock.status.padEnd(9)}  ${said}`;
}
