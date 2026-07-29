import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SyncEngine } from "../src/core/engine.ts";
import { ProfexorError } from "../src/core/errors.ts";
import { StateStore } from "../src/core/state.ts";
import { RunStatus, type ProjectSpec } from "../src/core/types.ts";
import {
  command,
  projectConfig,
  removeTemporaryRoot,
  temporaryRoot,
  testPaths,
} from "./test-utils.ts";

type Fixture = {
  root: string;
  bare: string;
  maintainer: string;
  contributor: string;
  project: ProjectSpec;
};

async function createFixture(): Promise<Fixture> {
  const root = await temporaryRoot();
  const bare = join(root, "remote.git");
  const seed = join(root, "seed");
  const maintainer = join(root, "maintainer");
  const contributor = join(root, "contributor");
  command(root, ["git", "init", "--bare", "--initial-branch=main", bare]);
  command(root, ["git", "init", "--initial-branch=main", seed]);
  command(seed, ["git", "config", "user.name", "Seed Author"]);
  command(seed, ["git", "config", "user.email", "seed@example.test"]);
  await writeFile(join(seed, "shared.txt"), "base\n");
  command(seed, ["git", "add", "shared.txt"]);
  command(seed, ["git", "commit", "-m", "feat: initial"]);
  command(seed, ["git", "remote", "add", "origin", bare]);
  command(seed, ["git", "push", "-u", "origin", "main"]);
  command(root, ["git", "clone", bare, maintainer]);
  command(root, ["git", "clone", bare, contributor]);
  for (const [path, name] of [
    [maintainer, "Local Maintainer"],
    [contributor, "Upstream Contributor"],
  ] as const) {
    command(path, ["git", "config", "user.name", name]);
    command(path, ["git", "config", "user.email", `${name.replaceAll(" ", ".")}@example.test`]);
  }
  return {
    root,
    bare,
    maintainer,
    contributor,
    project: {
      id: "fixture",
      label: "Fixture",
      path: maintainer,
      localBranch: "main",
      source: { remote: "origin", branch: "main" },
      destination: { remote: "origin", branch: "main" },
      validator: {
        kind: "fexor",
        image: "fixture/validator:never",
        cacheVolume: "fixture-cache",
        resources: {
          cpus: 1,
          memory: "1g",
          pids: 64,
          timeoutSeconds: 30,
        },
      },
    },
  };
}

describe("sync engine", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removeTemporaryRoot));
  });

  test("merges a divergent whole range and preserves upstream authors", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);
    await writeFile(join(fixture.maintainer, "local.txt"), "local\n");
    command(fixture.maintainer, ["git", "add", "local.txt"]);
    command(fixture.maintainer, ["git", "commit", "-m", "feat: local maintenance"]);

    await writeFile(join(fixture.contributor, "upstream.txt"), "upstream\n");
    command(fixture.contributor, ["git", "add", "upstream.txt"]);
    command(fixture.contributor, ["git", "commit", "-m", "fix: upstream repair"]);
    command(fixture.contributor, ["git", "push", "origin", "main"]);

    const paths = testPaths(fixture.root);
    const state = await StateStore.open(paths);
    const engine = new SyncEngine({
      config: projectConfig(fixture.project),
      paths,
      state,
    });
    const run = await engine.prepare("fixture");
    expect(run).not.toBeNull();
    expect(run?.status).toBe(RunStatus.Ready);
    expect(run?.commits.map((commit) => commit.subject)).toContain("fix: upstream repair");
    const parents = command(run!.worktreePath, [
      "git",
      "rev-list",
      "--parents",
      "-n",
      "1",
      run!.candidateSha!,
    ]).split(/\s+/);
    expect(parents).toHaveLength(3);
    expect(
      command(run!.worktreePath, ["git", "show", "-s", "--format=%an", run!.candidateSha!]),
    ).toBe("Profexor");
    expect(
      command(run!.worktreePath, ["git", "log", "--format=%an", run!.candidateSha!]),
    ).toContain("Upstream Contributor");
    await engine.discard(run!.id);
    state.close();
  });

  test("allows review but blocks promotion while primary worktree is dirty", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);
    await writeFile(join(fixture.contributor, "upstream.txt"), "upstream\n");
    command(fixture.contributor, ["git", "add", "upstream.txt"]);
    command(fixture.contributor, ["git", "commit", "-m", "fix: upstream repair"]);
    command(fixture.contributor, ["git", "push", "origin", "main"]);

    const paths = testPaths(fixture.root);
    const state = await StateStore.open(paths);
    const engine = new SyncEngine({
      config: projectConfig(fixture.project),
      paths,
      state,
    });
    const run = await engine.prepare("fixture");
    expect(run?.status).toBe(RunStatus.Ready);
    run!.status = RunStatus.Validated;
    run!.validatedCandidateSha = run!.candidateSha;
    run!.validatorImage = fixture.project.validator.image;
    state.saveRun(run!);
    await writeFile(join(fixture.maintainer, "uncommitted.txt"), "do not touch\n");

    try {
      await engine.promote(run!.id);
      throw new Error("promotion unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(ProfexorError);
      expect((error as ProfexorError).code).toBe("DIRTY_WORKTREE");
    }
    await engine.discard(run!.id);
    state.close();
  });
});
