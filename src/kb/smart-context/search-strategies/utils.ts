export function isSubsequence(sub: string, str: string): boolean {
  const s = sub.toLowerCase();
  const t = str.toLowerCase();
  let subIdx = 0;
  let strIdx = 0;
  while (subIdx < s.length && strIdx < t.length) {
    if (s[subIdx] === t[strIdx]) {
      subIdx++;
    }
    strIdx++;
  }
  return subIdx === s.length;
}

export function cleanPath(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  const noExt = dotIndex !== -1 ? filePath.slice(0, dotIndex) : filePath;
  if (noExt.endsWith('/index')) {
    return noExt.slice(0, -6);
  }
  return noExt;
}

export function getSynonyms(token: string, synonyms?: Record<string, string[]>): string[] {
  const t = token.toLowerCase();
  const result = new Set<string>();
  for (const [key, syns] of Object.entries(synonyms || {})) {
    if (t.includes(key) || key.includes(t)) {
      for (const s of syns) result.add(s);
    }
  }
  return Array.from(result);
}

export function levenshtein(s1: string, s2: string): number {
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,       // deletion
        matrix[i][j - 1] + 1,       // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return matrix[len1][len2];
}
