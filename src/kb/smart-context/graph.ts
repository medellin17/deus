import type Database from 'better-sqlite3';
import type { CallEdge, Confidence, SymbolInfo, ImportInfo } from './types.ts';

export interface GraphStats {
  inDegree: Map<number, number>;
  outDegree: Map<number, number>;
}

export class SymbolGraph {
  constructor(private db: Database.Database) {}

  getEdgesFrom(fileId: number): CallEdge[] {
    return this.db
      .prepare('SELECT * FROM sc_call_graph WHERE caller_file_id = ?')
      .all(fileId) as CallEdge[];
  }

  getEdgesTo(fileId: number): CallEdge[] {
    return this.db
      .prepare('SELECT * FROM sc_call_graph WHERE callee_file_id = ?')
      .all(fileId) as CallEdge[];
  }

  getStats(fileIds: number[]): GraphStats {
    const inDegree = new Map<number, number>();
    const outDegree = new Map<number, number>();
    for (const id of fileIds) {
      inDegree.set(id, 0);
      outDegree.set(id, 0);
    }

    if (fileIds.length === 0) {
      return { inDegree, outDegree };
    }

    const chunkSize = 900;
    for (let i = 0; i < fileIds.length; i += chunkSize) {
      const chunk = fileIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');

      const inRows = this.db
        .prepare(
          `SELECT callee_file_id, COUNT(*) as cnt FROM sc_call_graph WHERE callee_file_id IN (${placeholders}) GROUP BY callee_file_id`
        )
        .all(...chunk) as { callee_file_id: number; cnt: number }[];

      for (const row of inRows) {
        inDegree.set(row.callee_file_id, row.cnt);
      }

      const outRows = this.db
        .prepare(
          `SELECT caller_file_id, COUNT(*) as cnt FROM sc_call_graph WHERE caller_file_id IN (${placeholders}) GROUP BY caller_file_id`
        )
        .all(...chunk) as { caller_file_id: number; cnt: number }[];

      for (const row of outRows) {
        outDegree.set(row.caller_file_id, row.cnt);
      }
    }

    return { inDegree, outDegree };
  }

  getHubNodes(fileIds: number[], minDegree: number): Set<number> {
    const { inDegree, outDegree } = this.getStats(fileIds);
    const hubs = new Set<number>();
    for (const id of fileIds) {
      const total = (inDegree.get(id) ?? 0) + (outDegree.get(id) ?? 0);
      if (total >= minDegree) hubs.add(id);
    }
    return hubs;
  }

  walk(
    startFileIds: number[],
    minScore: number,
    maxSymbols: number,
    depth = 1,
    visited?: Set<number>
  ): Map<number, number> {
    const seen = visited ?? new Set<number>();
    const bestScores = new Map<number, number>();
    const queue: { fileId: number; score: number; d: number }[] = [];

    for (const id of startFileIds) {
      bestScores.set(id, 1.0);
      seen.add(id);
      queue.push({
        fileId: id,
        score: 1.0,
        d: 0,
      });
    }

    let head = 0;
    while (head < queue.length) {
      const { fileId, score, d } = queue[head++];

      // Dijkstra optimization: skip if we already processed a better score for this node.
      if (score < (bestScores.get(fileId) ?? 0)) {
        continue;
      }

      if (d >= depth) {
        continue;
      }

      const nextScore = score * 0.6;
      if (nextScore < minScore) {
        continue;
      }

      // Upstream (callers) and downstream (callees)
      const edges = this.db
        .prepare(
          'SELECT caller_file_id AS fid, confidence FROM sc_call_graph WHERE callee_file_id = ? UNION ALL SELECT callee_file_id AS fid, confidence FROM sc_call_graph WHERE caller_file_id = ?'
        )
        .all(fileId, fileId) as { fid: number; confidence: Confidence }[];

      for (const e of edges) {
        const adjusted = e.confidence === 'EXTRACTED' ? nextScore : nextScore * 0.6;
        if (adjusted < minScore) {
          continue;
        }

        const hasBeenVisited = seen.has(e.fid);

        if (hasBeenVisited) {
          const prevScore = bestScores.get(e.fid) ?? 0;
          if (adjusted > prevScore) {
            bestScores.set(e.fid, adjusted);
            if (d < depth) {
              queue.push({ fileId: e.fid, score: adjusted, d: d + 1 });
            }
          }
        } else {
          if (seen.size < maxSymbols) {
            seen.add(e.fid);
            bestScores.set(e.fid, adjusted);
            if (d < depth) {
              queue.push({ fileId: e.fid, score: adjusted, d: d + 1 });
            }
          }
        }
      }
    }
    return bestScores;
  }
}
