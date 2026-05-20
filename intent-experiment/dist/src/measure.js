"use strict";
/**
 * measure.ts — mechanical metrics for one benchmark run.
 * Nothing here uses a model; these are the numbers the report can stand on.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchPath = matchPath;
exports.isTestHelper = isTestHelper;
exports.unintendedChanges = unintendedChanges;
exports.runChecks = runChecks;
exports.checksPass = checksPass;
exports.mechanicalProxy = mechanicalProxy;
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const execP = (0, node_util_1.promisify)(node_child_process_1.exec);
/** Minimal glob: supports `*` (within a segment), `**` (any depth), and exact paths. */
function matchPath(glob, rel) {
    const re = glob
        .split("/")
        .map((seg) => {
        if (seg === "**")
            return "(?:[^/]+/)*?";
        return seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "/";
    })
        .join("")
        .replace(/\/$/, "");
    try {
        return new RegExp(`^${re}$`).test(rel);
    }
    catch {
        return glob === rel;
    }
}
/** Test-helper files never count as unintended changes. */
function isTestHelper(rel) {
    return /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.[tj]sx?$/.test(rel);
}
/**
 * Files changed outside must_change ∪ test-helpers.
 * must_change entries are exact paths or globs.
 */
function unintendedChanges(changedFiles, mustChange) {
    return changedFiles.filter((f) => !isTestHelper(f) && !mustChange.some((g) => matchPath(g, f)));
}
async function runChecks(workdir, checks) {
    const out = [];
    for (const command of checks) {
        try {
            const { stdout, stderr } = await execP(command, {
                cwd: workdir,
                timeout: 60_000,
                env: { ...process.env, CI: "1" },
            });
            out.push({ command, exitCode: 0, outputTail: (stdout + stderr).slice(-400) });
        }
        catch (err) {
            const e = err;
            out.push({
                command,
                exitCode: typeof e.code === "number" ? e.code : 1,
                outputTail: ((e.stdout ?? "") + (e.stderr ?? "") + (e.code === undefined ? e.message ?? "" : "")).slice(-400),
            });
        }
    }
    return out;
}
function checksPass(results) {
    return results.length > 0 && results.every((r) => r.exitCode === 0);
}
/** Mechanical proxy for intent accuracy — never rests on the LLM judge. */
function mechanicalProxy(checks, unintended) {
    return checksPass(checks) && unintended.length === 0;
}
