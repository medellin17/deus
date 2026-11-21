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
  StepExecution,
  TokenUsage,
} from "./types.ts";

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
        permissions: input.step.permissions,
      });
      sessionID = session.id;

      const handled = new Set<string>();

      const pollPermissions = async (): Promise<void> => {
        try {
          const requests: PermissionRequest[] = await this.client.permission.list({
            sessionID,
          });

          for (const request of requests) {
            if (handled.has(request.id)) continue;
            handled.add(request.id);

            const verdict = decidePermission(this.options.policy, {
              action: request.action,
              resources: request.resources,
            });

            await this.client.permission.reply({
              sessionID,
              requestID: request.id,
              decision: verdict.decision === "allow" ? "once" : "reject",
              message: verdict.reason,
            });

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
        await sleep(500);

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
      return {
        stepId: input.step.id,
        agent: input.step.agent,
        sessionID,
        status: "failed",
        text: "",
        transcript: "",
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        permissionDecisions,
      };
    }
  }
}
