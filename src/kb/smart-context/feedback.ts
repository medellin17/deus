import path from 'path';
import type Database from 'better-sqlite3';

export function applyPositiveFeedback(db: Database.Database, filePath: string): boolean {
  return applyFeedback(db, filePath, 1.0);
}

export function applyNegativeFeedback(db: Database.Database, filePath: string): boolean {
  return applyFeedback(db, filePath, -1.0);
}

function applyFeedback(db: Database.Database, filePath: string, reward: number): boolean {
  const p = path.normalize(filePath).replace(/\\/g, '/');
  const row = db.prepare('SELECT id FROM sc_files WHERE path = ?').get(p) as
    | { id: number }
    | undefined;
  if (!row) return false;
  const alpha = 0.3;
  db.prepare(
    `UPDATE sc_file_ema
     SET weight = :alpha * :reward + (1 - :alpha) * (CASE WHEN samples = 0 THEN 0.5 ELSE weight END),
         samples = samples + 1,
         updated_at = :now
     WHERE file_id = :id`
  ).run({ alpha, reward, now: Date.now(), id: row.id });
  return true;
}
