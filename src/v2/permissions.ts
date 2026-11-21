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
  { match: /\bgit\s+push\b/i, decision: "deny", reason: "pushing is a human decision" },
  { match: /\bgit\s+reset\s+--hard\b/i, decision: "deny", reason: "hard reset destroys work" },
  { match: /\bgit\s+clean\s+-[a-z]*f/i, decision: "deny", reason: "git clean destroys untracked work" },
  { match: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$)/i, decision: "deny", reason: "refuse to remove /" },
  { match: /\bsudo\b/i, decision: "deny", reason: "no privilege escalation" },
  { match: /\bmkfs\b/i, decision: "deny", reason: "filesystem formatting is never allowed" },
  { match: /\bdd\s+if=/i, decision: "deny", reason: "raw disk writes are never allowed" },
  { match: /\b(?:shutdown|reboot|poweroff)\b/i, decision: "deny", reason: "host lifecycle is off-limits" },
  { match: /:\(\)\s*\{/i, decision: "deny", reason: "fork bomb pattern" },
  { match: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash)\b/i, decision: "deny", reason: "remote script execution" },
  {
    match: /\bread\b[^\n]*(?:^|[\s/])\.env(?!\.example\b)(?:\.[a-z0-9_-]+)?(?:\s|$)/i,
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
    match: /\bshell\b[^\n]*(?:\.env(?!\.example\b)|id_rsa|id_ed25519|\.pem\b|\.key\b)/i,
    decision: "deny",
    reason: "shell commands must not read secrets",
  },
];

export const DEFAULT_POLICY: PermissionPolicy = {
  defaultDecision: "allow",
  rules: DEFAULT_RULES,
};

/**
 * Last matching rule wins. This makes policy files able to add explicit
 * exceptions after the built-in deny rules.
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

  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as PolicyFile;
  const extraRules: PermissionRuleDecision[] = (parsed.rules ?? []).map((rule) => ({
    match: new RegExp(rule.match, "i"),
    decision: rule.decision,
    reason: rule.reason ?? `policy file rule: ${rule.match}`,
  }));

  return {
    defaultDecision: parsed.default ?? DEFAULT_POLICY.defaultDecision,
    rules: [...DEFAULT_POLICY.rules, ...extraRules],
  };
}
