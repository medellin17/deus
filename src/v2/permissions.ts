import fs from "node:fs";

export interface PermissionRuleDecision {
  match: RegExp;
  decision: "allow" | "deny";
  reason: string;
}

export interface PermissionPolicy {
  defaultDecision: "allow" | "deny";
  rules: PermissionRuleDecision[];
}

export interface PermissionRequestLike {
  action: string;
  resources: string[];
}

export interface PermissionVerdict {
  decision: "allow" | "deny";
  reason: string;
}

const DEFAULT_RULES: PermissionRuleDecision[] = [
  { match: /\bgit\b[^\n]*\bpush\b/i, decision: "deny", reason: "pushing is a human decision" },
  { match: /\bgit\b[^\n]*\breset\b[^\n]*--hard\b/i, decision: "deny", reason: "hard reset destroys work" },
  { match: /\bgit\b[^\n]*\bclean\b[^\n]*\s-[a-z]*f/i, decision: "deny", reason: "git clean destroys untracked work" },
  {
    match: /\brm\b(?=[^\n]*\s-[a-z]*r)(?=[^\n]*\s-[a-z]*f)[^\n]*\s+(?:--\s+)?\/(?:\s|$)/i,
    decision: "deny",
    reason: "refuse to remove /",
  },
  { match: /\bsudo\b/i, decision: "deny", reason: "no privilege escalation" },
  { match: /\bmkfs\b/i, decision: "deny", reason: "filesystem formatting is never allowed" },
  { match: /\bdd\s+if=/i, decision: "deny", reason: "raw disk writes are never allowed" },
  { match: /\b(?:shutdown|reboot|poweroff)\b/i, decision: "deny", reason: "host lifecycle is off-limits" },
  { match: /:\(\)\s*\{/i, decision: "deny", reason: "fork bomb pattern" },
  { match: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash)\b/i, decision: "deny", reason: "remote script execution" },
  {
    match: /\bread\b[^\n]*(?:^|[\s/])(?:[\w.-]*\.env(?!\.example\b)(?:\.[a-z0-9_-]+)?|\.envrc)(?:\s|$)/i,
    decision: "deny",
    reason: "environment files can contain secrets",
  },
  {
    match: /\bread\b[^\n]*(?:id_rsa|id_ed25519|\.pem|\.key|\.p12|\.pfx)(?:\s|$)/i,
    decision: "deny",
    reason: "private keys are off-limits",
  },
  {
    match: /\bread\b[^\n]*(?:^|[\s/])\.(?:ssh|aws|gnupg)(?:\/|\s|$)/i,
    decision: "deny",
    reason: "credential directories are off-limits",
  },
  {
    match: /\bedit\b[^\n]*(?:^|[\s/])(?:[\w.-]*\.env(?!\.example\b)(?:\.[a-z0-9_-]+)?|\.envrc)(?:\s|$)/i,
    decision: "deny",
    reason: "environment files can contain secrets",
  },
  {
    match: /\bedit\b[^\n]*(?:id_rsa|id_ed25519|\.pem|\.key|\.p12|\.pfx)(?:\s|$)/i,
    decision: "deny",
    reason: "private keys are off-limits",
  },
  {
    match: /\bedit\b[^\n]*(?:^|[\s/])\.(?:ssh|aws|gnupg)(?:\/|\s|$)/i,
    decision: "deny",
    reason: "credential directories are off-limits",
  },
  {
    match: /\bshell\b[^\n]*(?:[\w.-]*\.env(?!\.example\b)|\.envrc|id_rsa|id_ed25519|\.pem\b|\.key\b|\.ssh|\.aws|\.gnupg|\bprintenv\b)/i,
    decision: "deny",
    reason: "shell commands must not read secrets",
  },
  {
    match: /\bshell\b[^\n]*\benv\s*(?:-i\b|$|[|;&])/i,
    decision: "deny",
    reason: "printing the environment leaks secrets",
  },
  {
    match: /\bshell\b[^\n]*\bset\s*(?:$|[|;&])/i,
    decision: "deny",
    reason: "printing shell variables leaks secrets",
  },
  {
    match: /^(?:webfetch|websearch)\b/i,
    decision: "deny",
    reason: "network access is a human decision",
  },
  {
    match: /^external_directory\b/i,
    decision: "deny",
    reason: "paths outside the project are off-limits",
  },
];

export const DEFAULT_POLICY: PermissionPolicy = {
  defaultDecision: "allow",
  rules: DEFAULT_RULES,
};

/**
 * Rules are checked in order and the last matching rule wins. Therefore a
 * policy file can add explicit exceptions after the built-in deny rules.
 */
export function decidePermission(
  policy: PermissionPolicy,
  request: PermissionRequestLike,
): PermissionVerdict {
  const subject = `${request.action} ${request.resources.join(" ")}`;
  let verdict: PermissionVerdict = {
    decision: policy.defaultDecision,
    reason: `default policy: ${policy.defaultDecision}`,
  };

  for (const rule of policy.rules) {
    if (rule.match.test(subject)) {
      verdict = { decision: rule.decision, reason: rule.reason };
    }
  }

  return verdict;
}

interface PolicyFile {
  default?: "allow" | "deny";
  rules?: Array<{
    match: string;
    decision: "allow" | "deny";
    reason?: string;
  }>;
}

export function loadPolicy(file?: string): PermissionPolicy {
  if (!file || !fs.existsSync(file)) return DEFAULT_POLICY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    throw new Error(
      `policy ${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`policy ${file}: expected a JSON object`);
  }

  const raw = parsed as PolicyFile;
  if (raw.default !== undefined && raw.default !== "allow" && raw.default !== "deny") {
    throw new Error(`policy ${file}: "default" must be "allow" or "deny"`);
  }
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) {
    throw new Error(`policy ${file}: "rules" must be an array`);
  }

  const extraRules: PermissionRuleDecision[] = (raw.rules ?? []).map((rule, index) => {
    if (typeof rule?.match !== "string" || rule.match.trim().length === 0) {
      throw new Error(`policy ${file}: rules[${index}].match must be a non-empty string`);
    }
    if (rule.decision !== "allow" && rule.decision !== "deny") {
      throw new Error(`policy ${file}: rules[${index}].decision must be "allow" or "deny"`);
    }

    let match: RegExp;
    try {
      match = new RegExp(rule.match, "i");
    } catch (error) {
      throw new Error(
        `policy ${file}: rules[${index}].match is not a valid regex: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      match,
      decision: rule.decision,
      reason: rule.reason ?? `policy file rule: ${rule.match}`,
    };
  });

  return {
    defaultDecision: raw.default ?? DEFAULT_POLICY.defaultDecision,
    rules: [...DEFAULT_POLICY.rules, ...extraRules],
  };
}
