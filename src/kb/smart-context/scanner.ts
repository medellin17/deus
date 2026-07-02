import fs from 'fs';
import path from 'path';
import type { Lang } from './types.ts';

export const EXT_LANG_MAP: Record<string, Lang> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
  '.php': 'php',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
};

export function detectLang(filePath: string): Lang {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_LANG_MAP[ext] ?? 'plain';
}

async function isBinary(filePath: string): Promise<boolean> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(1024);
    const result = await handle.read(buf, 0, 1024, 0);
    for (let i = 0; i < result.bytesRead; i++) {
      if (buf[i] === 0x00) return true;
    }
    return false;
  } catch {
    return true;
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
  }
}

export interface FileEntry {
  absPath: string;
  relPath: string;
  lang: Lang;
  mtime: number;
  size: number;
}

export function shouldIgnore(
  relPath: string,
  ignorePatterns: string[],
  maxFileSizeKb: number,
  sizeBytes: number
): boolean {
  const normalizedRel = relPath.replace(/\\/g, '/');
  if (sizeBytes > maxFileSizeKb * 1024) return true;
  const parts = normalizedRel.split('/');
  for (const pattern of ignorePatterns) {
    // Support *.ext patterns by checking endsWith
    if (pattern.startsWith('*.') && normalizedRel.endsWith(pattern.slice(1))) {
      return true;
    }
    // **/ prefix = match at any depth
    if (pattern.startsWith('**/')) {
      const suffix = pattern.slice(3);
      if (parts.some(p => p === suffix || p.startsWith(suffix))) return true;
      continue;
    }
    // Trailing * = prefix match
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (parts.some(p => p.startsWith(prefix))) return true;
      continue;
    }
    // Exact segment match or full path match
    if (parts.some(p => p === pattern) || normalizedRel === pattern || normalizedRel.endsWith('/' + pattern)) {
      return true;
    }
  }
  return false;
}

export async function* scanDirectory(
  root: string,
  ignorePatterns: string[],
  maxFileSizeKb: number
): AsyncGenerator<FileEntry> {
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = path.join(root, rel);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (shouldIgnore(rel || '.', ignorePatterns, maxFileSizeKb, 0)) continue;
      try {
        const children = await fs.promises.readdir(abs);
        for (const child of children) {
          stack.push(path.join(rel, child));
        }
      } catch {
        // skip
      }
      continue;
    }
    if (!stat.isFile()) continue;
    if (shouldIgnore(rel, ignorePatterns, maxFileSizeKb, stat.size)) continue;
    if (await isBinary(abs)) continue;
    yield {
      absPath: abs,
      relPath: rel.replace(/\\/g, '/'),
      lang: detectLang(rel),
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  }
}
