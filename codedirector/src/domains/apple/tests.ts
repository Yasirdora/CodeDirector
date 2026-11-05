/**
 * Apple test conventions, and how their test targets compress into deny
 * globs.
 *
 * A Swift test is recognised by where it sits, never by its file name:
 *
 *  - SwiftPM: `Tests/<Target>/…` — the target is the directory directly
 *    under `Tests`; a file directly under `Tests` is not in a target.
 *  - Xcode: a bundle folder whose name ends in `Tests` (AppTests,
 *    AppUITests, …).
 *
 * A path under `Sources/` is app code even when a directory in it is named
 * `Tests`, and `Package.swift` is a manifest. Both rules keep
 * `Sources/Demo/TestTools.swift` and `Package.swift` out.
 */

const SWIFT_FILE = /\.swift$/i;

/**
 * The module of a SwiftPM source file: `X/Sources/M/…` is module `M`.
 * The innermost `Sources` wins, so a package nested inside another
 * package's sources (`Outer/Sources/Host/Vendor/Inner/Sources/Core/…`)
 * names its own module, `Core`. Null when the path names no `Sources/<M>/`
 * folder — an Xcode app target, whose symbols have no known module.
 */
export function swiftModuleOf(relPath: string): string | null {
  const segs = relPath.split("/");
  const sourcesAt = segs.lastIndexOf("Sources");
  if (sourcesAt === -1 || sourcesAt + 1 >= segs.length - 1) return null;
  return segs[sourcesAt + 1] || null;
}

/** Whether this mapping owns the file's language for symbol-to-test matching. */
export function isSwiftSourceFile(relPath: string): boolean {
  return SWIFT_FILE.test(relPath);
}

/** Whether a root-relative path is a Swift test file by target convention. */
export function isSwiftTestFile(relPath: string): boolean {
  const segs = relPath.split("/");
  const base = segs[segs.length - 1] ?? "";
  if (!SWIFT_FILE.test(base) || base === "Package.swift") return false;
  const dirs = segs.slice(0, -1);
  // Never under Sources: a Tests-looking directory there is still app code.
  if (dirs.includes("Sources")) return false;
  // SwiftPM: the file must be inside Tests/<Target>/, not directly in Tests/.
  const testsAt = dirs.indexOf("Tests");
  if (testsAt !== -1 && testsAt < dirs.length - 1) return true;
  // Xcode: a test bundle folder ends in Tests (AppTests, AppUITests).
  return dirs.some((dir) => dir !== "Tests" && dir.endsWith("Tests"));
}

/**
 * Collapse Swift test files to one glob per test target. A package with
 * hundreds of files in `Tests/NotesTests/` becomes `Tests/NotesTests/**`;
 * an Xcode app's `AppTests/` and `AppUITests/` become two globs. Sorted and
 * de-duplicated, so a draft is deterministic.
 */
export function compressSwiftTestPaths(testFiles: string[]): string[] {
  const globs = new Set<string>();
  for (const file of [...testFiles].sort()) {
    const dirs = file.split("/").slice(0, -1);
    const testsAt = dirs.indexOf("Tests");
    if (testsAt !== -1 && testsAt < dirs.length - 1) {
      globs.add(`${dirs.slice(0, testsAt + 2).join("/")}/**`);
      continue;
    }
    const bundleAt = dirs.findIndex((dir) => dir !== "Tests" && dir.endsWith("Tests"));
    if (bundleAt !== -1) {
      globs.add(`${dirs.slice(0, bundleAt + 1).join("/")}/**`);
      continue;
    }
    globs.add(file);
  }
  return [...globs].sort();
}
