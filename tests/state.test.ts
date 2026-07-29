import { afterEach, describe, expect, test } from "bun:test";
import { StateStore } from "../src/core/state.ts";
import { EventLevel } from "../src/core/types.ts";
import { removeTemporaryRoot, temporaryRoot, testPaths } from "./test-utils.ts";

describe("durable state", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removeTemporaryRoot));
  });

  test("persists observations and append-only redacted events", async () => {
    const root = await temporaryRoot();
    roots.push(root);
    const state = await StateStore.open(testPaths(root));
    state.recordObservation({
      projectId: "demo",
      checkedAt: "2026-07-30T00:00:00.000Z",
      sourceSha: "a".repeat(40),
      destinationSha: "b".repeat(40),
      unread: false,
      error: null,
    });
    await state.event("test", "recorded", {
      level: EventLevel.Info,
      projectId: "demo",
      details: { token: "never-store-this" },
    });
    expect(state.getObservation("demo")?.sourceSha).toBe("a".repeat(40));
    expect(state.listEvents()).toHaveLength(1);
    expect(state.listEvents()[0]?.details).toEqual({ token: "[redacted]" });
    state.close();
  });
});
