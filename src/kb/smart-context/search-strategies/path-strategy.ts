import type Database from 'better-sqlite3';
import type { Config, ParsedQuery, Lang } from '../types.ts';
import type { RawCandidate, SearchStrategy } from './types.ts';
import { levenshtein, isSubsequence } from './utils.ts';

export class PathStrategy implements SearchStrategy {
  private filesCache: { id: number; path: string; lang: Lang }[] | null = null;

  constructor(private db: Database.Database, private config: Config) {}

  private getFilesCache(): { id: number; path: string; lang: Lang }[] {
    if (!this.filesCache) {
      this.filesCache = this.db
        .prepare('SELECT id, path, lang FROM sc_files')
        .all() as { id: number; path: string; lang: Lang }[];
    }
    return this.filesCache;
  }

  search(parsed: ParsedQuery): RawCandidate[] {
    if (parsed.paths.length === 0) return [];

    const files = this.getFilesCache();
    const candidatesMap = new Map<number, RawCandidate>();

    const typicalBarrels = new Set(['index', 'mod', '__init__', 'page', 'layout']);

    for (const qPath of parsed.paths) {
      const qPathLower = qPath.toLowerCase();
      let filteredFiles = files.filter((f) => isSubsequence(qPathLower, f.path.toLowerCase()));
      if (filteredFiles.length > 1000) {
        filteredFiles.sort((a, b) => a.path.length - b.path.length);
        filteredFiles = filteredFiles.slice(0, 1000);
      }

      const qSegments = qPath.split('/');
      const qLast = qSegments[qSegments.length - 1];
      const qDotIndex = qLast.lastIndexOf('.');
      const qBasename = qDotIndex !== -1 ? qLast.slice(0, qDotIndex) : qLast;
      const qDirs = qSegments.slice(0, qSegments.length - 1);

      for (const candidate of filteredFiles) {
        const cSegments = candidate.path.split('/');
        const cLast = cSegments[cSegments.length - 1];
        const cDotIndex = cLast.lastIndexOf('.');
        const cBasename = cDotIndex !== -1 ? cLast.slice(0, cDotIndex) : cLast;
        const cDirs = cSegments.slice(0, cSegments.length - 1);

        const maxLen = Math.max(qBasename.length, cBasename.length);
        if (maxLen === 0) continue;

        const qSub = isSubsequence(qBasename, cBasename);

        const qBasenameLower = qBasename.toLowerCase();
        const cBasenameLower = cBasename.toLowerCase();
        let prefixMatch =
          cBasenameLower.startsWith(qBasenameLower.slice(0, 2)) ||
          qBasenameLower.startsWith(cBasenameLower.slice(0, 2)) ||
          qSub;

        if (!prefixMatch && typicalBarrels.has(cBasenameLower) && cDirs.length > 0) {
          const parentDir = cDirs[cDirs.length - 1].toLowerCase();
          prefixMatch =
            parentDir.startsWith(qBasenameLower.slice(0, 2)) ||
            qBasenameLower.startsWith(parentDir.slice(0, 2)) ||
            isSubsequence(qBasename, parentDir);
        }

        if (!prefixMatch) {
          continue;
        }

        const origSim = 1 - levenshtein(qBasenameLower, cBasenameLower) / maxLen;

        let basenameSim = origSim;
        if (typicalBarrels.has(cBasenameLower) && cDirs.length > 0) {
          const parentDir = cDirs[cDirs.length - 1];
          const parentMaxLen = Math.max(qBasename.length, parentDir.length);
          const parentSim = parentMaxLen > 0 ? 1 - levenshtein(qBasenameLower, parentDir.toLowerCase()) / parentMaxLen : 0;
          basenameSim = Math.max(origSim, parentSim);
        }

        if (qSub) {
          basenameSim = Math.min(1.0, basenameSim + 0.2);
        }

        let sim = basenameSim;
        if (qDirs.length > 0) {
          let totalDirSim = 0;
          for (const qDir of qDirs) {
            let maxDirSim = 0;
            for (const cDir of cDirs) {
              const dMaxLen = Math.max(qDir.length, cDir.length);
              const dSim = dMaxLen > 0 ? 1 - levenshtein(qDir.toLowerCase(), cDir.toLowerCase()) / dMaxLen : 0;
              if (dSim > maxDirSim) {
                maxDirSim = dSim;
              }
            }
            totalDirSim += maxDirSim;
          }
          const averageDirSim = totalDirSim / qDirs.length;
          sim = 0.6 * basenameSim + 0.4 * averageDirSim;
        }

        if (sim >= 0.75) {
          const existing = candidatesMap.get(candidate.id);
          if (existing) {
            existing.pathScore = Math.max(existing.pathScore, sim);
          } else {
            candidatesMap.set(candidate.id, {
              fileId: candidate.id,
              path: candidate.path,
              lang: candidate.lang,
              bm25Score: 0,
              symbolScore: 0,
              importScore: 0,
              pathScore: sim,
              matchedSymbols: [],
              matchedImports: [],
            });
          }
        }
      }
    }

    return Array.from(candidatesMap.values());
  }
}
