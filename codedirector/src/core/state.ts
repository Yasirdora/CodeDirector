/**
 * What under .codedirector/ is Code Director's own working state, and so is
 * never judged as a project change.
 *
 * Everything in a .codedirector/ folder is state — locks, runs, seals,
 * baselines, the index, and any note a tool or a test leaves there — except
 * the rules file directly inside it. `checks.yaml` is configuration: a run
 * that edits it is judged like any other project file. The exception is one
 * file by name, so new state never has to be added to a list to stay out of
 * a report.
 */

/** The rules file's name inside .codedirector/ (CHECKS_FILE's last part). */
const RULES_FILE_NAME = "checks.yaml";

/**
 * True when `relPath` — root-relative or git-root-relative — is a
 * .codedirector/ folder or lies inside one, and is not that folder's
 * checks.yaml. Paths outside such a folder are project files, and so is the
 * rules file.
 */
export function isCodedirectorState(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const at = parts.indexOf(".codedirector");
  if (at === -1) return false;
  const under = parts.slice(at + 1);
  return !(under.length === 1 && under[0] === RULES_FILE_NAME);
}
