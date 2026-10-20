import { execFile } from "node:child_process";

/**
 * Fail-fast prerequisite check for the E2E suite.
 *
 * Runs before vitest starts so a missing `qmd` binary produces a readable
 * message instead of a cryptic spawn error inside a test fixture.
 */
execFile("qmd", ["--version"], (error) => {
  if (error) {
    process.stderr.write(
      "Missing prerequisite: 'qmd' is not on PATH — install with npm i -g @tobilu/qmd, see docs/e2e-runbook.md\n",
    );
    process.exit(1);
  }
  process.exit(0);
});
