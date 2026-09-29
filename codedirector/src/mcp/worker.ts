/** Whole guarded run/report lives here, including baseline probes and rendering. */
import { parentPort, workerData } from "node:worker_threads";
import { runWithLock } from "../run/run";
import { buildReport } from "../report/report";
import { formatReport, formatReportJson, formatReportMarkdown } from "../report/format";
import type { Job, ToolResult, WorkerReply } from "./jobs";

const text = (body: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}),
});

async function execute(job: Job): Promise<ToolResult> {
  const { root, lockId } = job;
  if (job.kind === "report") {
    const report = await buildReport(root, lockId);
    if (job.format === "md") return text(formatReportMarkdown(report));
    if (job.format === "json") return text(formatReportJson(report));
    return text(formatReport(report));
  }
  const outcome = await runWithLock(root, lockId, job.command, {
    stdio: "pipe",
    ...(job.testTimeoutMs !== undefined ? { verifyOptions: { testTimeoutMs: job.testTimeoutMs } } : {}),
  });
  const report = await buildReport(root, lockId, {
    verification: outcome.record.verification,
    run: outcome.record,
    runRecordPath: outcome.recordPath,
  });
  const body = formatReport(report);
  if (outcome.exitCode === 0) return text(`run ${lockId} succeeded — no violations.\n\n${body}`);
  if (report.verdict === "incomplete") {
    return text(
      `run ${lockId} is NOT VERIFIED — a declared check did not run; the report names it. ` +
        `Do not claim success; show this report to the human.\n\n${body}`, true,
    );
  }
  return text(
    `run ${lockId} FAILED (exit ${outcome.exitCode}) — violations below. ` +
      `Do not retry blindly; show this report to the human. Nothing was reverted — undo() restores the checkpoint.\n\n${body}`, true,
  );
}

execute(workerData as Job).then(
  (result) => parentPort!.postMessage({ result } satisfies WorkerReply),
  (error) => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies WorkerReply),
);
