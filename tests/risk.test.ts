import { describe, expect, test } from "bun:test";
import { scoreRisk } from "../src/core/risk.ts";

describe("risk scoring", () => {
  test("marks manifests, credentials, and toolchains as high risk", () => {
    const risks = scoreRisk(
      ["Cargo.lock", "rust-toolchain.toml", "src/auth/credentials.ts"],
      [],
    );
    expect(risks.some((risk) => risk.level === "high")).toBe(true);
    expect(risks.flatMap((risk) => risk.paths)).toContain("Cargo.lock");
  });

  test("returns an explicit low-risk signal for ordinary changes", () => {
    const risks = scoreRisk(["src/ui/panel.tsx"], []);
    expect(risks).toHaveLength(1);
    expect(risks[0]?.level).toBe("low");
  });
});
