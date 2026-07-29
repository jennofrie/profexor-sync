import { describe, expect, test } from "bun:test";
import { ProfexorError } from "../src/core/errors.ts";
import { validatePatchScope } from "../src/core/advisor.ts";

describe("Advisor patch scope", () => {
  test("accepts a single-file conflict patch", () => {
    expect(() =>
      validatePatchScope(
        [
          "diff --git a/src/conflict.ts b/src/conflict.ts",
          "--- a/src/conflict.ts",
          "+++ b/src/conflict.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
        "src/conflict.ts",
      ),
    ).not.toThrow();
  });

  test("rejects a response that disguises an out-of-scope file", () => {
    expect(() =>
      validatePatchScope(
        [
          "diff --git a/src/conflict.ts b/src/conflict.ts",
          "--- a/src/conflict.ts",
          "+++ b/src/credential-store.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
        "src/conflict.ts",
      ),
    ).toThrow(ProfexorError);
  });

  test("rejects mode and binary changes", () => {
    expect(() =>
      validatePatchScope(
        [
          "diff --git a/src/conflict.ts b/src/conflict.ts",
          "new file mode 100755",
          "GIT binary patch",
        ].join("\n"),
        "src/conflict.ts",
      ),
    ).toThrow(ProfexorError);
  });
});
