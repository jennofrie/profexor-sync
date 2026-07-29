import { describe, expect, test } from "bun:test";
import { redactText, redactValue, sanitizeArgs } from "../src/core/redaction.ts";

describe("redaction", () => {
  test("removes known credential shapes and authenticated URLs", () => {
    const shapedToken = `${["nv", "api"].join("")}-exampleSecret123`;
    const input =
      `Authorization: Bearer secret-value https://person:password@example.test ${shapedToken}`;
    const output = redactText(input);
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("password");
    expect(output).not.toContain("exampleSecret123");
    expect(output).toContain("[redacted]");
  });

  test("redacts objects by sensitive key", () => {
    expect(
      redactValue({
        project: "fexor-code",
        apiKey: "value",
        nested: { password: "value" },
      }),
    ).toEqual({
      project: "fexor-code",
      apiKey: "[redacted]",
      nested: { password: "[redacted]" },
    });
  });

  test("sanitizes command arguments following secret flags", () => {
    expect(sanitizeArgs(["--token", "unsafe", "--project", "safe"])).toEqual([
      "--token",
      "[redacted]",
      "--project",
      "safe",
    ]);
  });
});
