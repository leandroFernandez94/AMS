import { describe, expect, it } from "vitest";
import { CliReindexer, type CommandRunner } from "../src/indexing/cli-reindexer.js";
import type { CommandResult } from "../src/indexing/index.js";

/** Builds a fake runner that records every call and returns canned results. */
function makeRecorder(results: CommandResult[]): {
  runner: CommandRunner;
  calls: { cmd: string; args: string[] }[];
} {
  const calls: { cmd: string; args: string[] }[] = [];
  let i = 0;
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    return results[Math.min(i++, results.length - 1)];
  };
  return { runner, calls };
}

describe("CliReindexer", () => {
  it("runs `qmd update` then `qmd embed` with no flags by default", async () => {
    const { runner, calls } = makeRecorder([
      { code: 0, stdout: "Indexed: 1 new, 0 unchanged", stderr: "" },
      { code: 0, stdout: "Embedding: 1/1", stderr: "" },
    ]);
    const reindexer = new CliReindexer({ run: runner });

    const result = await reindexer.reindex([{ path: "decisions/a.md", markedAt: 1 }]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ cmd: "qmd", args: ["update"] });
    expect(calls[1]).toEqual({ cmd: "qmd", args: ["embed"] });
    expect(result).toEqual({
      pending: 1,
      updateSummary: "Indexed: 1 new, 0 unchanged",
      embedSummary: "Embedding: 1/1",
    });
  });

  it("scopes only `qmd embed` to the configured collection (update has no -c)", async () => {
    const { runner, calls } = makeRecorder([
      { code: 0, stdout: "u", stderr: "" },
      { code: 0, stdout: "e", stderr: "" },
    ]);
    const reindexer = new CliReindexer({ collection: "ams", run: runner });

    await reindexer.reindex([{ path: "x.md", markedAt: 1 }]);

    expect(calls[0].args).toEqual(["update"]);
    expect(calls[1].args).toEqual(["embed", "-c", "ams"]);
  });

  it("honors a custom qmd binary path", async () => {
    const { runner, calls } = makeRecorder([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ]);
    const reindexer = new CliReindexer({ qmdBin: "/opt/qmd/bin/qmd", run: runner });

    await reindexer.reindex([{ path: "x.md", markedAt: 1 }]);

    expect(calls[0].cmd).toBe("/opt/qmd/bin/qmd");
  });

  it("throws when `qmd update` exits non-zero, surfacing stderr", async () => {
    const { runner } = makeRecorder([{ code: 1, stdout: "", stderr: "no such collection" }]);
    const reindexer = new CliReindexer({ run: runner });

    await expect(reindexer.reindex([{ path: "x.md", markedAt: 1 }])).rejects.toThrow(
      /update failed \(exit 1\): no such collection/,
    );
  });

  it("throws when `qmd embed` exits non-zero even if update succeeded", async () => {
    const { runner } = makeRecorder([
      { code: 0, stdout: "ok", stderr: "" },
      { code: 2, stdout: "", stderr: "model missing" },
    ]);
    const reindexer = new CliReindexer({ run: runner });

    await expect(reindexer.reindex([{ path: "x.md", markedAt: 1 }])).rejects.toThrow(
      /embed failed \(exit 2\): model missing/,
    );
  });

  it("treats a spawn failure (ENOENT, code undefined) as a non-zero exit", async () => {
    const runner: CommandRunner = async () => ({
      code: -1,
      stdout: "",
      stderr: "spawn qmd ENOENT",
    });
    const reindexer = new CliReindexer({ run: runner });

    await expect(reindexer.reindex([{ path: "x.md", markedAt: 1 }])).rejects.toThrow(
      /update failed \(exit -1\): spawn qmd ENOENT/,
    );
  });

  it("leaves summaries undefined when stdout is empty", async () => {
    const { runner } = makeRecorder([
      { code: 0, stdout: "   \n  ", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ]);
    const reindexer = new CliReindexer({ run: runner });

    const result = await reindexer.reindex([{ path: "x.md", markedAt: 1 }]);

    expect(result.updateSummary).toBeUndefined();
    expect(result.embedSummary).toBeUndefined();
  });
});
