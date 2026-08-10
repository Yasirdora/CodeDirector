/**
 * Change Report renderers: calm, dense terminal output (default), PR-postable
 * markdown, and deterministic JSON. Markers carry meaning: ✓ held · ✗
 * violated · ? unchecked · ! asserted finding.
 */

import { stableStringify } from "../core/store";
import { VerificationItem } from "../verify/types";
import { ChangeReport } from "./report";

const MARK: Record<VerificationItem["verdict"], string> = { held: "✓", violated: "✗", unchecked: "?" };

/** Violations first, then held claims; original (ladder) order within each. */
function orderedChecked(items: VerificationItem[]): VerificationItem[] {
  const violated = items.filter((i) => i.verdict === "violated");
  const held = items.filter((i) => i.verdict === "held");
  return [...violated, ...held];
}

// ---------------------------------------------------------------------
// Plain-language summary

function plural(n: number, one: string, many?: string): string {
  return n === 1 ? `${n} ${one}` : `${n} ${many ?? one + "s"}`;
}

/**
 * One-glance summary, generated from the same data the detail below renders
 * (blueprint's depth principle applied to the product itself). Register:
 * competent colleague. Hard rule: the word "verified" appears only when the
 * report's verdict is verified — which requires zero violations and a
 * successful command.
 */
export function summarizeReport(report: ChangeReport): string {
  const sentences: string[] = [];
  const held = report.items.filter((i) => i.verdict === "held");
  const violatedItems = report.items.filter((i) => i.verdict === "violated");
  const unchecked = report.items.filter((i) => i.verdict === "unchecked");
  const outOfScope = report.changed.filter((c) => c.class !== "in-budget");
  const undoHint = "Nothing was reverted — run `cdir undo` to restore.";

  // 1. Outcome first.
  if (report.verdict === "verified") {
    sentences.push("Done — verified.");
  } else if (outOfScope.length > 0) {
    const first = outOfScope[0];
    const what =
      first.class === "denied"
        ? `${first.path} is off-limits`
        : `${first.path} was outside the agreed scope`;
    const more = outOfScope.length > 1 ? ` (${outOfScope.length - 1} more below)` : "";
    sentences.push(`Blocked: ${what}${more}. ${undoHint}`);
  } else if (violatedItems.length > 0) {
    sentences.push(`Blocked: ${violatedItems[0].subject} — ${violatedItems[0].detail}. ${undoHint}`);
  } else if (report.violations.length > 0) {
    sentences.push(`Blocked: ${report.violations[0]}. ${undoHint}`);
  } else {
    sentences.push(`The command itself failed. ${undoHint}`);
  }

  // 2. Scope.
  if (report.changed.length > 0) {
    if (outOfScope.length === 0) {
      const names = report.changed.map((c) => c.path);
      sentences.push(
        names.length <= 3
          ? `Only ${names.join(", ")} changed, within the agreed scope.`
          : `${plural(names.length, "file")} changed, all within the agreed scope.`,
      );
    } else {
      const outside = outOfScope.length === 1 ? "1 was" : `${outOfScope.length} were`;
      sentences.push(
        `${plural(report.changed.length, "file")} changed in total; ${outside} outside or off-limits.`,
      );
    }
  }

  // 3. Checked promises.
  if (held.length > 0) {
    sentences.push(`${plural(held.length, "promise")} held (checked).`);
  }

  // 4. What still needs a human.
  if (unchecked.length > 0) {
    const named = unchecked
      .slice(0, 2)
      .map((i) => i.reason ?? i.detail)
      .join("; ");
    const more = unchecked.length > 2 ? `; +${unchecked.length - 2} more` : "";
    sentences.push(
      `${unchecked.length === 1 ? "1 thing needs" : `${unchecked.length} things need`} your judgment: ${named}${more}.`,
    );
  }

  // 5. Incidental observations.
  if (report.findings.length > 0) {
    sentences.push(`${plural(report.findings.length, "observation")} noted along the way (not verified).`);
  }

  return sentences.join(" ");
}

// ---------------------------------------------------------------------
// Terminal

export function formatReport(report: ChangeReport): string {
  const lines: string[] = [];
  lines.push(summarizeReport(report));
  lines.push(``);
  lines.push(`CHANGE REPORT · ${report.lockId} · verdict: ${report.verdict.toUpperCase()}`);
  lines.push(`Said   "${report.utterance}"`);
  lines.push(`Goal   ${report.goal}`);
  if (report.command) {
    lines.push(
      `Run    ${report.command.join(" ")} · record ${report.runRecordPath ?? "(unknown)"}`,
    );
  }
  if (report.baselinePath) lines.push(`Base   ${report.baselinePath}`);

  lines.push(``);
  if (report.changed.length === 0 && !report.budget) {
    lines.push(`Changed files: (no run record — verification only)`);
  } else {
    const b = report.budget;
    lines.push(
      `Changed files (${report.changed.length} changed` +
        (b ? ` · budget ${b.filesChanged}/${b.maxFiles} files, ${b.linesChanged}/${b.maxLines} lines` : "") +
        `):`,
    );
    for (const c of report.changed) {
      const mark = c.class === "denied" ? "✗" : c.class === "out-of-budget" ? "~" : "✓";
      const tag =
        c.class === "denied"
          ? `DENIED (matches "${c.matchedDeny}")`
          : c.class === "out-of-budget"
            ? "OUT-OF-BUDGET"
            : "in-budget";
      lines.push(`  ${mark} ${c.path}  ${tag}`);
    }
  }

  lines.push(``);
  if (report.violations.length === 0) {
    lines.push(`Violations: none`);
  } else {
    lines.push(`Violations (${report.violations.length}):`);
    for (const v of report.violations) lines.push(`  ✗ ${v}`);
  }

  const checked = orderedChecked(report.items.filter((i) => i.verdict !== "unchecked"));
  const unchecked = report.items.filter((i) => i.verdict === "unchecked");

  lines.push(``);
  if (checked.length === 0) {
    lines.push(`Checks: none ran`);
  } else {
    lines.push(`Checks (violations first):`);
    for (const i of checked) {
      lines.push(`  ${MARK[i.verdict]} ${i.evidenceClass.padEnd(8)} ${i.subject} — ${i.detail}`);
      if (i.artifactRef) lines.push(`             artifact: ${i.artifactRef}`);
    }
  }

  // The Unchecked bucket is always visible — naming it honestly is the feature.
  lines.push(``);
  if (unchecked.length === 0) {
    lines.push(`Unchecked: none — every claim had a runnable check`);
  } else {
    lines.push(`Unchecked (${unchecked.length}) — named, not silently dropped:`);
    for (const i of unchecked) {
      lines.push(`  ? ${i.subject} — ${i.reason ?? i.detail}`);
    }
  }

  if (report.findings.length > 0) {
    lines.push(``);
    lines.push(`Findings (asserted — observed, not verified):`);
    for (const f of report.findings) lines.push(`  ! ${f.text}`);
  }

  lines.push(``);
  const c = report.counts;
  lines.push(`Counts: proven ${c.proven} · measured ${c.measured} · asserted ${c.asserted} · unchecked ${c.unchecked}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Markdown (PR-postable)

export function formatReportMarkdown(report: ChangeReport): string {
  const lines: string[] = [];
  lines.push(`# Change Report · ${report.lockId} · **${report.verdict.toUpperCase()}**`);
  lines.push(``);
  lines.push(`**${summarizeReport(report)}**`);
  lines.push(``);
  lines.push(`> "${report.utterance}"`);
  lines.push(``);
  lines.push(`- **Goal:** ${report.goal}`);
  if (report.command) lines.push(`- **Run:** \`${report.command.join(" ")}\` (record: \`${report.runRecordPath ?? "?"}\`)`);
  if (report.baselinePath) lines.push(`- **Baseline:** \`${report.baselinePath}\``);
  lines.push(`- **Evidence counts:** proven ${report.counts.proven} · measured ${report.counts.measured} · asserted ${report.counts.asserted} · unchecked ${report.counts.unchecked}`);

  if (report.budget || report.changed.length > 0) {
    lines.push(``);
    lines.push(`## Changed files`);
    lines.push(``);
    if (report.budget) {
      const b = report.budget;
      lines.push(`Budget: ${b.filesChanged}/${b.maxFiles} files, ${b.linesChanged}/${b.maxLines} lines.`);
      lines.push(``);
    }
    lines.push(`| file | classification |`);
    lines.push(`|---|---|`);
    for (const c of report.changed) {
      const tag = c.class === "denied" ? `**denied** (\`${c.matchedDeny}\`)` : c.class === "out-of-budget" ? "**out-of-budget**" : "in-budget";
      lines.push(`| \`${c.path}\` | ${tag} |`);
    }
  }

  lines.push(``);
  lines.push(`## Violations`);
  lines.push(``);
  if (report.violations.length === 0) {
    lines.push(`None.`);
  } else {
    for (const v of report.violations) lines.push(`- ✗ ${v}`);
  }

  const checked = orderedChecked(report.items.filter((i) => i.verdict !== "unchecked"));
  const unchecked = report.items.filter((i) => i.verdict === "unchecked");

  lines.push(``);
  lines.push(`## Checks`);
  lines.push(``);
  if (checked.length === 0) {
    lines.push(`No checks ran.`);
  } else {
    lines.push(`| result | evidence | check | detail | artifact |`);
    lines.push(`|---|---|---|---|---|`);
    for (const i of checked) {
      lines.push(
        `| ${MARK[i.verdict]} ${i.verdict} | ${i.evidenceClass} | ${i.subject} | ${i.detail} | ${i.artifactRef ? `\`${i.artifactRef}\`` : "—"} |`,
      );
    }
  }

  lines.push(``);
  lines.push(`## Unchecked`);
  lines.push(``);
  if (unchecked.length === 0) {
    lines.push(`None — every claim had a runnable check.`);
  } else {
    for (const i of unchecked) lines.push(`- ? **${i.subject}** — ${i.reason ?? i.detail}`);
  }

  if (report.findings.length > 0) {
    lines.push(``);
    lines.push(`## Findings (asserted)`);
    lines.push(``);
    for (const f of report.findings) lines.push(`- ! ${f.text}`);
  }

  lines.push(``);
  lines.push(`_Generated by Code Director. Asserted = claimed without a differential check; Unchecked = no check exists or could run._`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// JSON (deterministic)

export function formatReportJson(report: ChangeReport): string {
  return stableStringify(report);
}
