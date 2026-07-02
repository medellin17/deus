import fs from 'fs';
import path from 'path';
import os from 'os';
import type Database from 'better-sqlite3';
import type { Config, Lang } from './types.ts';
import { scanDirectory } from './scanner.ts';
import { tokenizeForIndex } from './tokenizer.ts';
import { createExtractor } from './extractors/treesitter.ts';
import type { Extractor } from './extractors/common.ts';

export interface IndexStats {
  scanned: number;
  indexed: number;
  removed: number;
  errors: string[];
}

export async function buildIndex(db: Database.Database, projectRoot: string, config: Config): Promise<IndexStats> {
  const stats: IndexStats = { scanned: 0, indexed: 0, removed: 0, errors: [] };

  try {

  // Track known files for deletion of missing
  const knownPaths = new Set(
    (db.prepare('SELECT path FROM sc_files').all() as { path: string }[]).map((r) => r.path)
  );
  const currentPaths = new Set<string>();

  // Prepare extractors cache
  const extractorCache = new Map<Lang, Extractor>();

  const modifiedFiles = new Map<number, { relPath: string; absPath: string; lang: Lang; mtime: number; size: number; content: string; calls: any[] }>();
  const relatedFileIds = new Set<number>();

  // Pass 1: Scan files, update metadata, symbols, imports, FTS
  for await (const entry of scanDirectory(projectRoot, config.indexing.ignore, config.indexing.maxFileSizeKb)) {
    stats.scanned++;
    currentPaths.add(entry.relPath);

    try {
      const existing = db
        .prepare('SELECT id, mtime, size FROM sc_files WHERE path = ?')
        .get(entry.relPath) as { id: number; mtime: number; size: number } | undefined;

      if (existing && existing.mtime === entry.mtime && existing.size === entry.size) {
        continue;
      }

      const content = fs.readFileSync(entry.absPath, 'utf-8');
      const indexedContent = tokenizeForIndex(content);

      // Extract symbols/imports/calls
      if (!extractorCache.has(entry.lang)) {
        extractorCache.set(entry.lang, await createExtractor(entry.lang));
      }
      const extractor = extractorCache.get(entry.lang)!;
      const extracted = extractor.extract(content);

      const fileId = db.transaction(() => {
        let fid: number;
        if (existing) {
          fid = existing.id;
          // Fetch caller files of incoming calls to this file to re-resolve them later
          const callers = db.prepare('SELECT DISTINCT caller_file_id FROM sc_call_graph WHERE callee_file_id = ?').all(fid) as { caller_file_id: number }[];
          for (const c of callers) {
            relatedFileIds.add(c.caller_file_id);
          }

          // Delete old data
          db.prepare('DELETE FROM sc_symbols WHERE file_id = ?').run(fid);
          db.prepare('DELETE FROM sc_imports WHERE file_id = ?').run(fid);
          db.prepare('DELETE FROM sc_call_graph WHERE caller_file_id = ?').run(fid);
          db.prepare('DELETE FROM sc_call_graph WHERE callee_file_id = ?').run(fid);
          db.prepare('DELETE FROM sc_content_fts WHERE path = ?').run(entry.relPath);
          db.prepare(
            'UPDATE sc_files SET mtime = ?, size = ?, lang = ?, indexed_at = ? WHERE id = ?'
          ).run(entry.mtime, entry.size, entry.lang, Date.now(), fid);
        } else {
          const ins = db
            .prepare(
              'INSERT INTO sc_files (path, mtime, size, lang, indexed_at) VALUES (?, ?, ?, ?, ?)'
            )
            .run(entry.relPath, entry.mtime, entry.size, entry.lang, Date.now());
          fid = Number(ins.lastInsertRowid);
        }

        // FTS
        db.prepare('INSERT INTO sc_content_fts (path, content) VALUES (?, ?)').run(
          entry.relPath,
          indexedContent
        );

        const symbolStmt = db.prepare(
          'INSERT INTO sc_symbols (file_id, name, type, line, signature) VALUES (?, ?, ?, ?, ?)'
        );
        for (const s of extracted.symbols) {
          symbolStmt.run(fid, s.name, s.type, s.line, s.signature ?? null);
        }

        const importStmt = db.prepare(
          'INSERT INTO sc_imports (file_id, imported_module, imported_name, is_relative, resolved_path, line, imported_basename) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        for (const imp of extracted.imports) {
          const lastPart = imp.importedModule.split('/').pop() || '';
          const importedBasename = lastPart.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, '');
          importStmt.run(
            fid,
            imp.importedModule,
            imp.importedName ?? null,
            imp.isRelative ? 1 : 0,
            imp.resolvedPath ?? null,
            imp.line,
            importedBasename
          );
        }

        // Ensure EMA row exists
        db.prepare(
          'INSERT OR IGNORE INTO sc_file_ema (file_id, weight, samples, updated_at) VALUES (?, 0.5, 0, ?)'
        ).run(fid, Date.now());

        return fid;
      })();

      modifiedFiles.set(fileId, {
        relPath: entry.relPath,
        absPath: entry.absPath,
        lang: entry.lang,
        mtime: entry.mtime,
        size: entry.size,
        content,
        calls: extracted.calls,
      });

      stats.indexed++;
    } catch (e: any) {
      stats.errors.push(`${entry.relPath}: ${e.message}`);
    }

    // Yield every 10 files
    if (stats.scanned % 10 === 0) {
      await new Promise((r) => setImmediate(r));
    }
  }

  // Pass 2: Resolve call targets and insert into sc_call_graph
  const rawCallsToResolve: { fileId: number; calls: any[] }[] = [];

  // 1. Add modified files' calls
  for (const [fileId, info] of modifiedFiles) {
    rawCallsToResolve.push({ fileId, calls: info.calls });
  }

  // 2. Add related files' calls (re-extract calls since they were not modified but their targets changed)
  for (const relatedId of relatedFileIds) {
    if (modifiedFiles.has(relatedId)) continue;

    try {
      const pathRow = db.prepare('SELECT path, lang FROM sc_files WHERE id = ?').get(relatedId) as { path: string; lang: Lang } | undefined;
      if (pathRow) {
        const absPath = path.resolve(projectRoot, pathRow.path);
        if (fs.existsSync(absPath)) {
          const content = fs.readFileSync(absPath, 'utf8');
          if (!extractorCache.has(pathRow.lang)) {
            extractorCache.set(pathRow.lang, await createExtractor(pathRow.lang));
          }
          const extractor = extractorCache.get(pathRow.lang)!;
          const extracted = extractor.extract(content);

          db.transaction(() => {
            // Delete old outgoing calls to rebuild them fresh
            db.prepare('DELETE FROM sc_call_graph WHERE caller_file_id = ?').run(relatedId);
          })();

          rawCallsToResolve.push({ fileId: relatedId, calls: extracted.calls });
        }
      }
    } catch (e: any) {
      stats.errors.push(`Related file re-indexing error (ID ${relatedId}): ${e.message}`);
    }
  }

  // 3. Resolve and insert
  db.transaction(() => {
    const callStmt = db.prepare(
      'INSERT INTO sc_call_graph (caller_file_id, caller_symbol, callee_file_id, callee_symbol, confidence, line) VALUES (?, ?, ?, ?, ?, ?)'
    );

    for (const item of rawCallsToResolve) {
      const { fileId, calls } = item;
      const calledNames = Array.from(
        new Set(calls.map((c) => c.calleeSymbol).filter((name): name is string => !!name))
      );

      const nameToFile = new Map<string, number[]>();
      if (calledNames.length > 0) {
        const sqlChunkSize = 900;
        for (let i = 0; i < calledNames.length; i += sqlChunkSize) {
          const chunk = calledNames.slice(i, i + sqlChunkSize);
          const placeholders = chunk.map(() => '?').join(',');
          const rows = db
            .prepare(`SELECT file_id, name FROM sc_symbols WHERE name IN (${placeholders}) ORDER BY file_id ASC`)
            .all(...chunk) as { file_id: number; name: string }[];
          for (const row of rows) {
            if (!nameToFile.has(row.name)) nameToFile.set(row.name, []);
            nameToFile.get(row.name)!.push(row.file_id);
          }
        }
      }

      for (const call of calls) {
        if (!call.calleeSymbol) continue;
        const targets = nameToFile.get(call.calleeSymbol) ?? [];
        if (targets.length === 1) {
          callStmt.run(
            fileId,
            call.callerSymbol ?? null,
            targets[0],
            call.calleeSymbol,
            'EXTRACTED',
            call.line ?? null
          );
        } else if (targets.length > 1) {
          for (const t of targets.slice(0, 3)) {
            callStmt.run(
              fileId,
              call.callerSymbol ?? null,
              t,
              call.calleeSymbol,
              'AMBIGUOUS',
              call.line ?? null
            );
          }
        }
      }
    }
  })();

  // Remove missing files
  db.transaction(() => {
    for (const p of knownPaths) {
      if (!currentPaths.has(p)) {
        db.prepare('DELETE FROM sc_files WHERE path = ?').run(p);
        db.prepare('DELETE FROM sc_content_fts WHERE path = ?').run(p);
        stats.removed++;
      }
    }
  })();

  } finally {
    // db lifecycle is managed by the caller
  }
  return stats;
}


