import type { SymbolInfo, ImportInfo, CallEdge, Lang } from '../types.ts';

export interface Extraction {
  symbols: Omit<SymbolInfo, 'fileId'>[];
  imports: Omit<ImportInfo, 'fileId'>[];
  calls: Omit<CallEdge, 'callerFileId'>[];
}

export interface Extractor {
  lang: Lang | Lang[];
  extract(content: string): Extraction;
}
