import type Database from 'better-sqlite3';
import type { Config } from './types.ts';
import type { SessionEntry } from './types.ts';

export class SessionStore {
  constructor(private db: Database.Database, private config: Config) {}

  getOrCreate(sessionId: string): { id: string; createdAt: number; updatedAt: number } {
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM sc_sessions WHERE session_id = ?').get(sessionId) as
      | { session_id: string; created_at: number; updated_at: number }
      | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE sc_sessions SET updated_at = ? WHERE session_id = ?')
        .run(now, sessionId);
      return { id: existing.session_id, createdAt: existing.created_at, updatedAt: now };
    }
    this.db
      .prepare('INSERT INTO sc_sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)')
      .run(sessionId, now, now);
    return { id: sessionId, createdAt: now, updatedAt: now };
  }

  addEntry(sessionId: string, entry: Omit<SessionEntry, 'timestamp'>): void {
    const now = Date.now();
    this.getOrCreate(sessionId);
    this.db
      .prepare(
        'INSERT INTO sc_session_entries (session_id, timestamp, query, category, selected_file_ids, entities) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        sessionId,
        now,
        entry.query,
        entry.category,
        JSON.stringify(entry.selectedFileIds),
        JSON.stringify(entry.entities)
      );
    this.db
      .prepare('UPDATE sc_sessions SET updated_at = ? WHERE session_id = ?')
      .run(now, sessionId);
    this.prune(sessionId);
  }

  getEntries(sessionId: string): SessionEntry[] {
    const rows = this.db
      .prepare(
        'SELECT timestamp, query, category, selected_file_ids, entities FROM sc_session_entries WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?'
      )
      .all(sessionId, this.config.search.sessionHistoryLength) as {
      timestamp: number;
      query: string;
      category: string;
      selected_file_ids: string;
      entities: string;
    }[];
    return rows.map((r) => {
      let selectedFileIds: number[] = [];
      let entities: string[] = [];
      try {
        selectedFileIds = JSON.parse(r.selected_file_ids) as number[];
      } catch {
        console.warn('Failed to parse selected_file_ids for session entry:', r.timestamp, r.query);
      }
      try {
        entities = JSON.parse(r.entities) as string[];
      } catch {
        console.warn('Failed to parse entities for session entry:', r.timestamp, r.query);
      }
      return {
        timestamp: r.timestamp,
        query: r.query,
        category: r.category as SessionEntry['category'],
        selectedFileIds,
        entities,
      };
    });
  }

  isExpired(sessionId: string): boolean {
    const row = this.db
      .prepare('SELECT updated_at FROM sc_sessions WHERE session_id = ?')
      .get(sessionId) as { updated_at: number } | undefined;
    if (!row) return true;
    const timeoutMs = this.config.search.sessionTimeoutMin * 60 * 1000;
    return Date.now() - row.updated_at > timeoutMs;
  }

  reset(sessionId: string): void {
    this.db.prepare('DELETE FROM sc_session_entries WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sc_sessions WHERE session_id = ?').run(sessionId);
  }

  cleanupExpiredSessions(): void {
    const timeoutMs = this.config.search.sessionTimeoutMin * 60 * 1000;
    this.db.prepare('DELETE FROM sc_sessions WHERE updated_at < ?').run(Date.now() - timeoutMs);
  }

  private prune(sessionId: string): void {
    const limit = this.config.search.sessionHistoryLength;
    const rows = this.db
      .prepare(
        'SELECT id FROM sc_session_entries WHERE session_id = ? ORDER BY timestamp DESC LIMIT -1 OFFSET ?'
      )
      .all(sessionId, limit) as { id: number }[];
    for (const r of rows) {
      this.db.prepare('DELETE FROM sc_session_entries WHERE id = ?').run(r.id);
    }
  }
}
