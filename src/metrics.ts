// Re-export metrics DB operations from the plugin-local module.
// This keeps the public API in src/ while making the implementation available
// to the OpenCode plugin without breaking relative imports after .opencode/ is
// copied into a target project.
export * from "../.opencode/lib/metrics-db.ts"
