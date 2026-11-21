import assert from "node:assert";
import { describe, it } from "node:test";

import { SESSION_OVERLAY } from "../../v2/executor.ts";

void describe("session permission overlay", () => {
  void it("forces policy checks for dangerous actions", () => {
    for (const action of ["shell", "websearch", "webfetch", "external_directory"]) {
      assert.ok(
        SESSION_OVERLAY.some(
          (rule) => rule.action === action && rule.resource === "*" && rule.effect === "ask",
        ),
        `missing ask overlay for ${action}`,
      );
    }

    for (const action of ["read", "edit"]) {
      for (const resource of [
        "**/.env",
        "**/.envrc",
        "**/*.key",
        "**/*.p12",
        "**/*.pfx",
        "**/.ssh/**",
        "**/.aws/**",
        "**/.gnupg/**",
      ]) {
        assert.ok(
          SESSION_OVERLAY.some(
            (rule) =>
              rule.action === action && rule.resource === resource && rule.effect === "ask",
          ),
          `missing ask overlay for ${action} ${resource}`,
        );
      }
    }
  });
});
