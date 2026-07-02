import fs from 'fs';
import path from 'path';
import type { Config, SearchResult, Chunk, Lang } from './types.ts';
import {
  CONTEXT_LINES_AROUND_MATCH,
  MAX_SKELETON_FILE_SIZE_BYTES,
  FALLBACK_SIGS_COUNT,
  MAX_SIGS_COUNT,
} from './constants.ts';

export function extractChunks(
  filePath: string,
  matchedSymbols: string[],
  matchedImports: string[],
  queryTokens: string[],
  config: Config
): Chunk[] {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  if (stat.size > config.indexing.maxFileSizeKb * 1024) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').replace(/\r/g, '').split('\n');
  const chunks: Chunk[] = [];

  // Find lines matching symbols or tokens
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let score = 0;
    for (const ms of matchedSymbols) {
      const name = ms.split(':').pop() ?? '';
      if (name && line.includes(name)) score += 1;
    }
    for (const mi of matchedImports) {
      if (line.includes(mi)) score += 0.8;
    }
    for (const t of queryTokens) {
      if (line.toLowerCase().includes(t.toLowerCase())) score += 0.3;
    }
    if (score > 0) {
      const context = CONTEXT_LINES_AROUND_MATCH;
      const start = Math.max(0, i - context);
      const end = Math.min(lines.length - 1, i + context);
      chunks.push({
        fileId: -1,
        startLine: start + 1,
        endLine: end + 1,
        text: lines.slice(start, end + 1).join('\n'),
        relevance: score,
      });
    }
  }

  return mergeChunks(chunks, config.search.chunkMergeDistanceLines);
}

export function mergeChunks(chunks: Chunk[], maxDistance: number): Chunk[] {
  if (chunks.length === 0) return [];
  const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine);
  const out: Chunk[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const last = out[out.length - 1];
    if (curr.startLine - last.endLine <= maxDistance) {
      let mergedText: string;
      if (curr.startLine <= last.endLine) {
        const overlap = last.endLine - curr.startLine + 1;
        const currLines = curr.text.split('\n');
        if (overlap < currLines.length) {
          const nonOverlappingText = currLines.slice(overlap).join('\n');
          mergedText = last.text + '\n' + nonOverlappingText;
        } else {
          mergedText = last.text;
        }
      } else {
        mergedText = last.text + '\n' + curr.text;
      }
      out[out.length - 1] = {
        fileId: last.fileId,
        startLine: last.startLine,
        endLine: Math.max(last.endLine, curr.endLine),
        text: mergedText,
        relevance: Math.max(last.relevance, curr.relevance),
      };
    } else {
      out.push(curr);
    }
  }
  return out;
}

export function collapseLines(lines: string[], threshold: number, includedLines: Set<number>): string[] {
  const out: string[] = [];
  let skipStart = -1;
  for (let i = 1; i <= lines.length; i++) {
    if (includedLines.has(i)) {
      if (skipStart !== -1) {
        const skipped = i - skipStart;
        if (skipped >= threshold) {
          out.push(`// ... [свернуто ${skipped} строк] ...`);
        } else {
          for (let k = skipStart; k < i; k++) out.push(lines[k - 1]);
        }
        skipStart = -1;
      }
      out.push(lines[i - 1]);
    } else {
      if (skipStart === -1) skipStart = i;
    }
  }
  if (skipStart !== -1) {
    const skipped = lines.length - skipStart + 1;
    if (skipped >= threshold) {
      out.push(`// ... [свернуто ${skipped} строк] ...`);
    } else {
      for (let k = skipStart; k <= lines.length; k++) out.push(lines[k - 1]);
    }
  }
  return out;
}

export function buildSkeleton(
  filePath: string,
  chunks: Chunk[],
  thresholdLines: number
): { text: string; isSkeleton: boolean } {
  if (!fs.existsSync(filePath)) return { text: '', isSkeleton: false };
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_SKELETON_FILE_SIZE_BYTES) return { text: `// file too large to skeletonize`, isSkeleton: false };
  const content = fs.readFileSync(filePath, 'utf-8').replace(/\r/g, '');
  const lines = content.split('\n');
  if (lines.length <= thresholdLines) {
    return { text: content, isSkeleton: false };
  }

  const chunkLines = new Set<number>();
  for (const ch of chunks) {
    for (let i = ch.startLine; i <= ch.endLine; i++) {
      chunkLines.add(i);
    }
  }

  const out = collapseLines(lines, 3, chunkLines);
  return { text: out.join('\n'), isSkeleton: true };
}

export function assembleFileContent(
  result: SearchResult,
  projectRoot: string,
  config: Config,
  queryTokens: string[] = []
): { text: string; isSkeleton: boolean } {
  const resolvedRoot = path.resolve(projectRoot);
  const absPath = path.resolve(projectRoot, result.path);
  const relative = path.relative(resolvedRoot, absPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Access denied: path '${result.path}' resolves outside of project root`);
  }
  if (!fs.existsSync(absPath)) return { text: `// missing: ${result.path}`, isSkeleton: false };
  
  const stat = fs.statSync(absPath);
  if (stat.size > config.indexing.maxFileSizeKb * 1024) {
    return { text: `// file too large to assemble: ${result.path}`, isSkeleton: false };
  }

  const content = fs.readFileSync(absPath, 'utf-8').replace(/\r/g, '');
  const lines = content.split('\n');

  if (result.tier === 2) {
    // Tier 2: skeleton only (signatures)
    const sigs: string[] = [];
    for (const ms of result.matchedSymbols) {
      const name = ms.split(':').pop() ?? '';
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(name)) sigs.push(`${i + 1}: ${lines[i].trim()}`);
      }
    }
    if (sigs.length === 0) {
      // fallback: first N lines
      sigs.push(...lines.slice(0, FALLBACK_SIGS_COUNT));
    }
    return {
      text: `// ${result.path} (signatures only)\n${sigs.slice(0, MAX_SIGS_COUNT).join('\n')}`,
      isSkeleton: true,
    };
  }

  if (result.tier === 3) {
    return { text: `// ${result.path} (relevance: ${result.relevance.toFixed(3)})`, isSkeleton: true };
  }

  let chunks = result.chunks;
  if (chunks.length === 0) {
    chunks = extractChunks(absPath, result.matchedSymbols, result.matchedImports, queryTokens, config);
  }

  if (chunks.length === 0 && lines.length > 0) {
    chunks = [{
      fileId: -1,
      startLine: 1,
      endLine: Math.min(50, lines.length),
      text: lines.slice(0, Math.min(50, lines.length)).join('\n'),
      relevance: 1.0,
    }];
  }

  if (lines.length > config.search.skeletonThresholdLines) {
    const skel = buildSkeleton(absPath, chunks, config.search.skeletonThresholdLines);
    return skel;
  }

  if (chunks.length > 0) {
    // Inject chunks with markers if file is small enough but has scattered chunks
    const chunkLines = new Set<number>();
    for (const ch of chunks) {
      for (let i = ch.startLine; i <= ch.endLine; i++) chunkLines.add(i);
    }
    const out = collapseLines(lines, 6, chunkLines);
    return { text: out.join('\n'), isSkeleton: true };
  }

  return { text: content, isSkeleton: false };
}
