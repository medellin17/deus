import type {
  PermissionRequest,
  SessionMessageAssistant,
  SessionMessageAssistantText,
  SessionMessageInfo,
  TokenUsageInfo,
} from "@opencode/client";

import { parseModelRef, type OpenCodeClient } from "./client.ts";
import { decidePermission, DEFAULT_POLICY, type PermissionPolicy } from "./permissions.ts";
import { estimateCost } from "./pricing.ts";
import type {
  Executor,
  ExecutorInput,
  PermissionDecision,
  PermissionRule,
  StepExecution,
  TokenUsage,
} from "./types.ts";

export const SESSION_OVERLAY: PermissionRule[] = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "websearch", resource: "*", effect: "ask" },
  { action: "webfetch", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "**/.env", effect: "ask" },
  { action: "read", resource: "**/.env.*", effect: "ask" },
  { action: "read", resource: "**/.envrc", effect: "ask" },
  { action: "read", resource: "**/id_rsa", effect: "ask" },
  { action: "read", resource: "**/id_ed25519", effect: "ask" },
  { action: "read", resource: "**/*.pem", effect: "ask" },
  { action: "read", resource: "**/*.key", effect: "ask" },
  { action: "read", resource: "**/*.p12", effect: "ask" },
  { action: "read", resource: "**/*.pfx", effect: "ask" },
  { action: "read", resource: "**/.ssh/**", effect: "ask" },
  { action: "read", resource: "**/.aws/**", effect: "ask" },
  { action: "read", resource: "**/.gnupg/**", effect: "ask" },
  { action: "edit", resource: "**/.env", effect: "ask" },
  { action: "edit", resource: "**/.env.*", effect: "ask" },
  { action: "edit", resource: "**/.envrc", effect: "ask" },
  { action: "edit", resource: "**/*.pem", effect: "ask" },
  { action: "edit", resource: "**/*.key", effect: "ask" },
  { action: "edit", resource: "**/*.p12", effect: "ask" },
  { action: "edit", resource: "**/*.pfx", effect: "ask" },
  { action: "edit", resource: "**/id_rsa", effect: "ask" },
  { action: "edit", resource: "**/id_ed25519", effect: "ask" },
  { action: "edit", resource: "**/.ssh/**", effect: "ask" },
  { action: "edit", resource: "**/.aws/**", effect: "ask" },
  { action: "edit", resource: "**/.gnupg/**", effect: "ask" },
];

export interface SessionExecutorOptions {
  model: string;
  policy?: PermissionPolicy;
  keepSessions?: boolean;
  onLog?: (message: string) => void;
}

function isAssistant(message: SessionMessageInfo): message is SessionMessageAssistant {
  return message.type === "assistant";
}

function assistantText(message: SessionMessageAssistant): string {
  return message.content
    .filter(
      (part): part is SessionMessageAssistantText =>
        part.type === "text" && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function mapTokens(tokens?: TokenUsageInfo): TokenUsage | undefined {
  if (!tokens) return undefined;
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache: { read: tokens.cache.read, write: tokens.cache.write },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one pipeline step as an isolated OpenCode V2 session.
 *
 * The session lifecycle is owned by the shared service. This class only
 * creates a session, sends a prompt, answers permission requests according to
 * policy, waits for completion, and extracts the final assistant message.
 */
export class SessionExecutor implements Executor {
  private readonly client: OpenCodeClient;
  private readonly options: Required<Pick<SessionExecutorOptions, "model" | "policy" | "keepSessions">> &
    Pick<SessionExecutorOptions, "onLog">;

  constructor(client: OpenCodeClient, options: SessionExecutorOptions) {
    this.client = client;
    this.options = {
      model: options.model,
      policy: options.policy ?? DEFAULT_POLICY,
      keepSessions: options.keepSessions ?? true,
      onLog: options.onLog,
    };
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }

  async run(input: ExecutorInput): Promise<StepExecution> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const timeoutMs = input.step.timeoutMs ?? input.timeoutMs;
    const title = `[deus-v2] ${input.runId} · ${input.step.id}`;

    let sessionID = "";
    const permissionDecisions: PermissionDecision[] = [];

    try {
      const session = await this.client.session.create({
        title,
        agent: input.step.agent,
        model: parseModelRef(this.options.model),
        location: { directory: input.workDir },
        permissions: [...SESSION_OVERLAY, ...(input.step.permissions ?? [])],
      });
      sessionID = session.id;

      const handled = new Set<string>();
      const replyAttempts = new Map<string, number>();

      const pollPermissions = async (): Promise<void> => {
        try {
          const requests: PermissionRequest[] = await this.client.permission.list({
            sessionID,
          });

          for (const request of requests) {
            if (handled.has(request.id)) continue;

            const attempts = replyAttempts.get(request.id) ?? 0;
            if (attempts >= 5) {
              handled.add(request.id);
              this.log(
                `permission reply failed 5 times, giving up: ${request.action} ${request.resources.join(" ")}`,
              );
              continue;
            }
            replyAttempts.set(request.id, attempts + 1);

            const verdict = decidePermission(this.options.policy, {
              action: request.action,
              resources: request.resources,
            });

            try {
              await this.client.permission.reply({
                sessionID,
                requestID: request.id,
                decision: verdict.decision === "allow" ? "once" : "reject",
                message: verdict.reason,
              });
            } catch (error) {
              this.log(
                `permission reply failed, will retry: ${error instanceof Error ? error.message : String(error)}`,
              );
              continue;
            }

            replyAttempts.delete(request.id);
            handled.add(request.id);
            permissionDecisions.push({
              requestID: request.id,
              action: request.action,
              resources: request.resources,
              decision: verdict.decision,
              reason: verdict.reason,
            });
            this.log(
              `permission ${verdict.decision}: ${request.action} ${request.resources.join(" ")} (${verdict.reason})`,
            );
          }
        } catch (error) {
          this.log(
            `permission poll failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      await this.client.session.prompt({
        sessionID,
        text: input.prompt,
      });

      let timedOut = false;
      let aborted = false;
      let info = await this.client.session.get({ sessionID });
      let consecutiveErrors = 0;

      const interruptAndWait = async (): Promise<void> => {
        await this.client.session.interrupt({ sessionID }).catch(() => undefined);
        const graceEnd = Date.now() + 2000;
        while (!info.outcome && Date.now() < graceEnd) {
          await sleep(250);
          info = await this.client.session.get({ sessionID }).catch(() => info);
        }
      };

      // A pending permission request makes session.wait fail, so poll the
      // session state instead. The same loop answers permission requests.
      while (!info.outcome) {
        if (input.signal?.aborted) {
          aborted = true;
          await interruptAndWait();
          break;
        }

        if (Date.now() - started > timeoutMs) {
          timedOut = true;
          await interruptAndWait();
          break;
        }

        await pollPermissions();
        await sleep(250);

        try {
          info = await this.client.session.get({ sessionID });
          consecutiveErrors = 0;
        } catch (error) {
          consecutiveErrors++;
          this.log(
            `session poll failed (${consecutiveErrors}/5): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (consecutiveErrors >= 5) throw error;
        }
      }

      const response = await this.client.message.list({
        sessionID,
        order: "asc",
        type: "assistant",
      });
      const messages = response.data.filter(isAssistant);

      const transcript = messages
        .map(assistantText)
        .filter((text) => text.trim().length > 0)
        .join("\n\n---\n\n");

      const lastAssistant = messages[messages.length - 1];
      const finalMessage =
        [...messages].reverse().find((message) => message.finish === "stop") ?? lastAssistant;
      const text = finalMessage ? assistantText(finalMessage) : "";
      const structuredError = [...messages].reverse().find((message) => message.error)?.error;
      const error =
        structuredError?.message ??
        (aborted ? "run interrupted" : undefined) ??
        (timedOut ? `step timed out after ${Math.round(timeoutMs / 1000)}s` : undefined) ??
        (info.outcome === "failed" ? "session failed" : undefined) ??
        (info.outcome === "interrupted" ? "session interrupted" : undefined);

      const succeeded = !error && text.trim().length > 0;
      const tokens = mapTokens(info.tokens);
      const reportedCost = info.cost ?? 0;
      const costEstimated = reportedCost <= 0 && tokens !== undefined;
      const cost = reportedCost > 0
        ? reportedCost
        : tokens
          ? estimateCost(this.options.model, tokens)
          : 0;
      const result: StepExecution = {
        stepId: input.step.id,
        agent: input.step.agent,
        sessionID,
        status: succeeded ? "succeeded" : "failed",
        text: text.trim(),
        transcript,
        error: succeeded ? undefined : (error ?? "empty assistant response"),
        tokens,
        cost,
        costEstimated,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        permissionDecisions,
      };

      if (succeeded && !this.options.keepSessions) {
        await this.client.session.remove({ sessionID }).catch((removeError) => {
          this.log(
            `session cleanup failed: ${
              removeError instanceof Error ? removeError.message : String(removeError)
            }`,
          );
        });
      }

      return result;
    } catch (error) {
      let tokens: TokenUsage | undefined;
      let cost: number | undefined;
      let costEstimated = false;

      if (sessionID) {
        try {
          const info = await this.client.session.get({ sessionID });
          tokens = mapTokens(info.tokens);
          const reportedCost = info.cost ?? 0;
          costEstimated = reportedCost <= 0 && tokens !== undefined;
          cost = reportedCost > 0
            ? reportedCost
            : tokens
              ? estimateCost(this.options.model, tokens)
              : 0;
        } catch {
          // The session may already be gone; keep the error as is.
        }
      }

      if (sessionID) {
        await this.client.session.interrupt({ sessionID }).catch((cleanupError) => {
          this.log(
            `session interrupt failed: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          );
        });
        if (!this.options.keepSessions) {
          await this.client.session.remove({ sessionID }).catch((removeError) => {
            this.log(
              `session cleanup failed: ${
                removeError instanceof Error ? removeError.message : String(removeError)
              }`,
            );
          });
        }
      }

      return {
        stepId: input.step.id,
        agent: input.step.agent,
        sessionID,
        status: "failed",
        text: "",
        transcript: "",
        error: error instanceof Error ? error.message : String(error),
        tokens,
        cost,
        costEstimated,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        permissionDecisions,
      };
    }
  }
}
