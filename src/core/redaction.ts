const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|authorization|bearer|password|passwd|secret|token|credential)/i;

const TOKEN_PATTERNS = [
  /\b(?:ghp|github_pat|glpat|nvapi|sk)-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:ghp|github_pat|glpat)_[A-Za-z0-9_]{8,}\b/g,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/g,
  /(?:authorization:\s*bearer\s+)[^\s]+/gi,
];

export function redactText(input: string): string {
  let output = input;
  for (const pattern of TOKEN_PATTERNS) {
    output = output.replace(pattern, (match) => {
      if (match.startsWith("http")) {
        const protocol = match.startsWith("https") ? "https://" : "http://";
        return `${protocol}[redacted]@`;
      }
      if (/authorization:/i.test(match)) {
        return "Authorization: Bearer [redacted]";
      }
      return "[redacted]";
    });
  }
  return output;
}

export function redactValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function sanitizeArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    const previous = args[index - 1] ?? "";
    const separatorIndex = arg.indexOf("=");
    if (
      SECRET_KEY_PATTERN.test(previous) ||
      (separatorIndex >= 0 && SECRET_KEY_PATTERN.test(arg.slice(0, separatorIndex)))
    ) {
      return separatorIndex >= 0
        ? `${arg.slice(0, separatorIndex + 1)}[redacted]`
        : "[redacted]";
    }
    return redactText(arg);
  });
}
