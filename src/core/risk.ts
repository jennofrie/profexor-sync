import type { CommitSummary, RiskItem } from "./types.ts";

const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/(^|\/)(Cargo\.toml|Cargo\.lock|bun\.lock|package\.json|rust-toolchain\.toml)$/, "dependency or toolchain"],
  [/(^|\/)(Dockerfile|docker-compose|\.github\/workflows|scripts\/build)/, "build or CI"],
  [/(^|\/)(auth|security|secrets?|credentials?|providers?)(\/|\.|$)/i, "security-sensitive"],
  [/\.(exe|dll|so|dylib|bin|wasm)$/i, "binary"],
];

const MEDIUM_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/(^|\/)(tests?|fixtures?)(\/|\.|$)/i, "test surface"],
  [/(^|\/)(config|settings|migrations?)(\/|\.|$)/i, "configuration"],
  [/\.(yaml|yml|json|toml)$/i, "structured configuration"],
];

export function scoreRisk(files: string[], commits: CommitSummary[]): RiskItem[] {
  const risks: RiskItem[] = [];
  for (const [pattern, category] of HIGH_RISK_PATTERNS) {
    const paths = files.filter((path) => pattern.test(path));
    if (paths.length > 0) {
      risks.push({
        level: "high",
        category,
        message: `${paths.length} ${category} path${paths.length === 1 ? "" : "s"} changed`,
        paths,
      });
    }
  }
  for (const [pattern, category] of MEDIUM_RISK_PATTERNS) {
    const paths = files.filter((path) => pattern.test(path));
    if (paths.length > 0) {
      risks.push({
        level: "medium",
        category,
        message: `${paths.length} ${category} path${paths.length === 1 ? "" : "s"} changed`,
        paths,
      });
    }
  }
  if (files.length > 250) {
    risks.push({
      level: "high",
      category: "churn",
      message: `Large update touches ${files.length} files`,
      paths: files.slice(0, 50),
    });
  } else if (files.length > 75) {
    risks.push({
      level: "medium",
      category: "churn",
      message: `Update touches ${files.length} files`,
      paths: files.slice(0, 50),
    });
  }
  const securitySubjects = commits.filter((commit) =>
    /\b(auth|security|credential|secret|permission|sandbox)\b/i.test(commit.subject),
  );
  if (securitySubjects.length > 0) {
    risks.push({
      level: "high",
      category: "commit message",
      message: `${securitySubjects.length} commit message${securitySubjects.length === 1 ? "" : "s"} mention a security-sensitive area`,
      paths: [],
    });
  }
  if (risks.length === 0) {
    risks.push({
      level: "low",
      category: "general",
      message: `${commits.length} commits across ${files.length} files; no deterministic high-risk patterns`,
      paths: [],
    });
  }
  return risks;
}
