import type { Extraction, Extractor } from './common.ts';
import type { Lang, SymbolType } from '../types.ts';

const PATTERNS: Record<
  Lang,
  { symbol: { regex: RegExp; type: SymbolType }[]; import: RegExp[] }
> = {
  typescript: {
    symbol: [
      { regex: /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/g, type: 'function' },
      { regex: /(?:export\s+)?class\s+(\w+)/g, type: 'class' },
      { regex: /(?:export\s+)?interface\s+(\w+)/g, type: 'interface' },
      { regex: /(?:export\s+)?type\s+(\w+)\s*=/g, type: 'type' },
      { regex: /(?:const|let|var)\s+(\w+)\s*[:=]/g, type: 'variable' },
      { regex: /(\w+)\s*\([^)]*\)\s*[:{]\s*(?:\w+|<|\()/g, type: 'method' },
    ],
    import: [
      /import\s+(?:(\{[^}]+\})|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g,
      /import\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],
  },
  javascript: {
    symbol: [
      { regex: /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/g, type: 'function' },
      { regex: /(?:export\s+)?class\s+(\w+)/g, type: 'class' },
      { regex: /(?:const|let|var)\s+(\w+)\s*[:=]/g, type: 'variable' },
      { regex: /(\w+)\s*\([^)]*\)\s*\{/g, type: 'method' },
    ],
    import: [
      /import\s+(?:(\{[^}]+\})|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g,
      /import\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],
  },
  python: {
    symbol: [
      { regex: /(?:async\s+)?def\s+(\w+)\s*\(/g, type: 'function' },
      { regex: /class\s+(\w+)\s*[\(:]/g, type: 'class' },
      { regex: /^(\w+)\s*=/gm, type: 'variable' },
    ],
    import: [
      /(?:from\s+([\w\.]+)\s+import|import\s+([\w\.]+(?:\s*,\s*[\w\.]+)*))/g,
    ],
  },
  go: {
    symbol: [
      { regex: /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/g, type: 'function' },
      { regex: /type\s+(\w+)\s+(?:struct|interface)/g, type: 'type' },
    ],
    import: [
      /import\s+\(\s*([^)]+)\)/gs,
      /import\s+['"]([^'"]+)['"]/g,
    ],
  },
  ruby: {
    symbol: [
      { regex: /def\s+(?:self\.)?(\w+)/g, type: 'function' },
      { regex: /class\s+(\w+)/g, type: 'class' },
      { regex: /module\s+(\w+)/g, type: 'class' },
    ],
    import: [
      /require\s+['"]([^'"]+)['"]/g,
      /require_relative\s+['"]([^'"]+)['"]/g,
    ],
  },
  php: {
    symbol: [
      { regex: /function\s+(\w+)\s*\(/g, type: 'function' },
      { regex: /class\s+(\w+)/g, type: 'class' },
    ],
    import: [
      /(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g,
      /use\s+([\w\\\\]+)/g,
    ],
  },
  kotlin: {
    symbol: [
      { regex: /fun\s+(\w+)\s*\(/g, type: 'function' },
      { regex: /class\s+(\w+)/g, type: 'class' },
      { regex: /interface\s+(\w+)/g, type: 'interface' },
    ],
    import: [
      /import\s+([\w\.]+)/g,
    ],
  },
  swift: {
    symbol: [
      { regex: /func\s+(\w+)\s*\(/g, type: 'function' },
      { regex: /class\s+(\w+)/g, type: 'class' },
      { regex: /struct\s+(\w+)/g, type: 'class' },
    ],
    import: [
      /import\s+([\w\.]+)/g,
    ],
  },
  shell: {
    symbol: [
      { regex: /^(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/gm, type: 'function' },
    ],
    import: [
      /(?:source|\.)\s+['"]([^'"]+)['"]/g,
    ],
  },
  plain: {
    symbol: [],
    import: [],
  },
};

function buildCharToLine(content: string): { charToLine: Uint32Array; lines: string[] } {
  const lines = content.split('\n');
  const charToLine = new Uint32Array(content.length);
  let line = 1;
  for (let i = 0; i < content.length; i++) {
    charToLine[i] = line;
    if (content[i] === '\n') line++;
  }
  return { charToLine, lines };
}

function getLine(charToLine: Uint32Array, index: number): number {
  return charToLine[index] || 1;
}

export class RegexExtractor implements Extractor {
  lang: Lang | Lang[];
  constructor(lang: Lang | Lang[]) {
    this.lang = lang;
  }

  extract(content: string): Extraction {
    const langKey = Array.isArray(this.lang) ? this.lang[0] : this.lang;
    const patterns = PATTERNS[langKey] ?? PATTERNS.plain;
    const symbols: Extraction['symbols'] = [];
    const imports: Extraction['imports'] = [];
    const calls: Extraction['calls'] = [];

    const { charToLine, lines } = buildCharToLine(content);

    const seen = new Set<string>();
    for (const { regex, type } of patterns.symbol) {
      const re = new RegExp(regex.source, regex.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const name = m[1];
        if (!name) continue;
        const line = getLine(charToLine, m.index);
        const key = `${line}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const signature = lines[line - 1]?.trim().slice(0, 200);
        symbols.push({
          name,
          type,
          line,
          signature,
        });
      }
    }

    if (langKey === 'python') {
      let m: RegExpExecArray | null;

      // 1. Single line from-import: from module import name1, name2
      const fromImportSingleRe = /(?:^|[\r\n])\s*from\s+([\w\.]+)\s+import\s+([a-zA-Z0-9_*,\t ]+)/g;
      while ((m = fromImportSingleRe.exec(content)) !== null) {
        const mod = m[1].trim();
        const names = m[2].split(',').map(n => {
          const noComment = n.split('#')[0];
          const parts = noComment.trim().split(/\s+as\s+/);
          return parts[0].trim();
        }).filter(Boolean);
        const line = getLine(charToLine, m.index);
        const isRelative = mod.startsWith('.');
        for (const name of names) {
          imports.push({
            importedModule: mod,
            importedName: name,
            isRelative,
            line,
          });
        }
      }

      // 2. Multiline parenthesized from-import: from module import (name1, name2)
      const fromImportMultiRe = /(?:^|[\r\n])\s*from\s+([\w\.]+)\s+import\s*\(([^)]+)\)/g;
      while ((m = fromImportMultiRe.exec(content)) !== null) {
        const mod = m[1].trim();
        const names = m[2].split(',').map(n => {
          const noComment = n.split('#')[0];
          const parts = noComment.trim().split(/\s+as\s+/);
          return parts[0].trim();
        }).filter(Boolean);
        const line = getLine(charToLine, m.index);
        const isRelative = mod.startsWith('.');
        for (const name of names) {
          imports.push({
            importedModule: mod,
            importedName: name,
            isRelative,
            line,
          });
        }
      }

      // 3. Standalone import: import mod1, mod2
      const importRe = /(?:^|[\r\n])\s*import\s+([\w\.,\t ]+)/g;
      while ((m = importRe.exec(content)) !== null) {
        const line = getLine(charToLine, m.index);
        const mods = m[1].split(',').map(n => n.trim()).filter(Boolean);
        for (const mod of mods) {
          const parts = mod.split(/\s+as\s+/);
          const actualMod = parts[0].trim();
          if (!actualMod) continue;
          const isRelative = actualMod.startsWith('.');
          imports.push({
            importedModule: actualMod,
            isRelative,
            line,
          });
        }
      }
    } else {
      for (const regex of patterns.import) {
        const re = new RegExp(regex.source, regex.flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          const mod = m[m.length - 1];
          if (!mod) continue;
          const isRelative = mod.startsWith('.') || mod.startsWith('/');
          imports.push({
            importedModule: mod.trim(),
            isRelative,
            line: getLine(charToLine, m.index),
          });
        }
      }
    }

    // Very simple call extraction: any identifier followed by '(' that is not a definition
    const defLines = new Set(symbols.filter((s) => s.type !== 'variable').map((s) => s.line));
    const seenCalls = new Set<string>();
    const callRe = /\b([a-zA-Z_]\w*)\s*\(/g;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(content)) !== null) {
      const line = getLine(charToLine, cm.index);
      if (defLines.has(line)) continue;
      const key = `${line}:${cm[1]}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      calls.push({
        callerSymbol: undefined,
        calleeSymbol: cm[1],
        calleeFileId: 0, // resolved later
        confidence: 'INFERRED',
        line,
      });
    }

    return { symbols, imports, calls };
  }
}
