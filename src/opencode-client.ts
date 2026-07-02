/**
 * Typed adapter over the OpenCode SDK client.
 *
 * Provides convenience wrappers and ensures all session API calls
 * are properly typed without `as any` / `as unknown as` casts.
 *
 * Import getClient() to access the raw SDK client when needed.
 */

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";

let client: OpencodeClient | null = null;
const DEFAULT_BASE_URL = "http://localhost:4096";

/**
 * Returns the singleton OpenCode SDK client, creating it on first call.
 */
export function getClient(): OpencodeClient {
  if (!client) {
    const baseUrl = process.env.OPENCODE_URL || DEFAULT_BASE_URL;
    client = createOpencodeClient({ baseUrl });
  }
  return client;
}

/**
 * Reset the client singleton (useful for testing or re-initialization).
 */
export function resetClient(): void {
  client = null;
}

/**
 * Create a new session and return its ID, or null on failure.
 */
export async function createSession(title: string): Promise<string | null> {
  const c = getClient();
  const res = await c.session.create({ body: { title } });
  return res.data?.id ?? null;
}

/**
 * Send a prompt asynchronously to a session.
 */
export async function sendPromptAsync(sessionId: string, text: string, agent: string): Promise<void> {
  const c = getClient();
  await c.session.promptAsync({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text" as const, text }],
      agent,
    },
  });
}

/**
 * Get messages from a session. Returns the raw SDK response data
 * (array of { info, parts }) or an empty array.
 */
export async function getMessages(
  sessionId: string,
): Promise<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>> {
  const c = getClient();
  const msgRes = await c.session.messages({ path: { id: sessionId } });
  return (msgRes.data ?? []) as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
}

/**
 * Abort an active session.
 */
export async function abortSession(sessionId: string): Promise<void> {
  const c = getClient();
  await c.session.abort({ path: { id: sessionId } });
}

/**
 * Delete a session and all its data.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const c = getClient();
  await c.session.delete({ path: { id: sessionId } });
}
