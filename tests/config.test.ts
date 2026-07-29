import { afterEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, writeDefaultConfig } from "../src/core/config.ts";
import { removeTemporaryRoot, temporaryRoot, testPaths } from "./test-utils.ts";

describe("configuration", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removeTemporaryRoot));
  });

  test("writes and validates the Ubuntu default", async () => {
    const root = await temporaryRoot();
    roots.push(root);
    const paths = testPaths(root);
    await writeDefaultConfig(paths.configFile);
    const config = await loadConfig(paths.configFile);
    expect(config.schemaVersion).toBe(1);
    expect(config.identity.name).toBe("Profexor");
    expect(config.projects.map((project) => project.id)).toEqual([
      "fexor-code",
      "grok-build",
    ]);
    expect(config.advisor.enabled).toBe(false);
    expect(config.projects[0]?.path).toBe(
      join(homedir(), "Desktop", "Github", "fexor-code"),
    );
    expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
  });
});
