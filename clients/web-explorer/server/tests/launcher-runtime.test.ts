import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("starts a detached explorer without Node on PATH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "token-tally-launcher-"));
  const cli = fileURLToPath(new URL("../../../../../store/bin/token-tally.js", import.meta.url));
  const db = join(dir, "events.db");
  const env = { ...process.env, PATH: "", XDG_RUNTIME_DIR: dir };
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  });

  try {
    const migration = run(["migrate", "--db", db]);
    assert.equal(migration.status, 0, migration.stderr);
    const launch = run(["explore", "--db", db, "--port", "43741", "--no-open", "--print-url"]);
    assert.equal(launch.status, 0, launch.stderr);
    const url = launch.stdout.trim().split("\n").at(-1)!;
    const response = await fetch(`${url}/api/health`);
    assert.equal(response.status, 200);
  } finally {
    run(["explore", "--stop"]);
    rmSync(dir, { recursive: true, force: true });
  }
});
