import fs from 'fs';
import path from 'path';
import type { Parser as ParserType, Language as LanguageType, Tree, Node, Point } from 'web-tree-sitter';
import type { Extraction, Extractor } from './common.ts';
import type { Lang, SymbolType } from '../types.ts';
import { RegexExtractor } from './regex.ts';

let Parser: typeof ParserType | null = null;
let Language: typeof LanguageType | null = null;

const GRAMMAR_FILES: Record<Lang, string | null> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: null,
  ruby: null,
  php: null,
  kotlin: null,
  swift: null,
  shell: null,
  plain: null,
};

function getGrammarPath(name: string): string {
  return path.join(__dirname, '..', '..', 'grammars', name);
}

export async function initTreeSitter(): Promise<void> {
  if (Parser) return;
  try {
    const mod = await import('web-tree-sitter');
    Parser = mod.Parser;
    Language = mod.Language;
    if (typeof Parser.init === 'function') {
      await Parser.init();
    }
  } catch {
    // web-tree-sitter not available — tree-sitter extractor will fall back to regex
  }
}

export class TreeSitterExtractor implements Extractor {
  lang: Lang;
  private fallback: RegexExtractor;
  private parser: ParserType | null = null;
  private language: LanguageType | null = null;

  constructor(lang: Lang) {
    this.lang = lang;
    this.fallback = new RegexExtractor(lang);
  }

  async init(): Promise<boolean> {
    const grammarName = GRAMMAR_FILES[this.lang];
    if (!grammarName) return false;
    try {
      await initTreeSitter();
      if (!Parser || !Language) return false;
      const wasmPath = getGrammarPath(grammarName);
      if (!fs.existsSync(wasmPath)) return false;
      this.language = await Language.load(wasmPath);
      this.parser = new Parser();
      this.parser.setLanguage(this.language);
      return true;
    } catch (e) {
      return false;
    }
  }

  extract(content: string): Extraction {
    if (!this.parser || !this.language) {
      return this.fallback.extract(content);
    }
    let tree: Tree | null = null;
    try {
      tree = this.parser.parse(content);
      if (!tree) {
        return this.fallback.extract(content);
      }
      const root = tree.rootNode;
      const symbols: Extraction['symbols'] = [];
      const imports: Extraction['imports'] = [];
      const calls: Extraction['calls'] = [];

      const walk = (node: Node) => {
        const type = node.type;
        // Functions
        if (
          type.includes('function') ||
          type.includes('method') ||
          type.includes('arrow_function')
        ) {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              type: type.includes('method') ? 'method' : 'function',
              line: nameNode.startPosition.row + 1,
              signature: content.split('\n')[nameNode.startPosition.row]?.trim().slice(0, 200),
            });
          }
        }
        // Classes / interfaces / types
        if (
          type === 'class_declaration' ||
          type === 'interface_declaration' ||
          type === 'type_alias_declaration' ||
          type === 'class_definition'
        ) {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            let st: SymbolType = 'class';
            if (type.includes('interface')) st = 'interface';
            else if (type.includes('type')) st = 'type';
            symbols.push({
              name: nameNode.text,
              type: st,
              line: nameNode.startPosition.row + 1,
              signature: content.split('\n')[nameNode.startPosition.row]?.trim().slice(0, 200),
            });
          }
        }
        // Imports
        if (type === 'import_statement' || type === 'import_from_statement' || type === 'import_declaration') {
          const modNode = node.childForFieldName('module_name') ?? node.childForFieldName('source');
          if (modNode) {
            const mod = modNode.text.replace(/['"]/g, '');
            const isRelative = mod.startsWith('.') || mod.startsWith('/');
            imports.push({
              importedModule: mod,
              isRelative,
              line: node.startPosition.row + 1,
            });
          }
        }
        // Call expressions
        if (type === 'call_expression' || type === 'call') {
          const fnNode = node.childForFieldName('function');
          if (fnNode) {
            if (fnNode.type === 'identifier') {
              calls.push({
                callerSymbol: undefined,
                calleeSymbol: fnNode.text,
                calleeFileId: 0,
                confidence: 'EXTRACTED',
                line: fnNode.startPosition.row + 1,
              });
            } else if (fnNode.type === 'member_expression') {
              const propNode = fnNode.childForFieldName('property');
              if (propNode && propNode.type === 'property_identifier') {
                calls.push({
                  callerSymbol: undefined,
                  calleeSymbol: propNode.text,
                  calleeFileId: 0,
                  confidence: 'EXTRACTED',
                  line: propNode.startPosition.row + 1,
                });
              }
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) walk(child);
        }
      };

      walk(root);
      return { symbols, imports, calls };
    } catch (e) {
      return this.fallback.extract(content);
    } finally {
      if (tree) {
        tree.delete();
      }
    }
  }
}

const SUPPORTED_TREE_SITTER_LANGS = Object.keys(GRAMMAR_FILES).filter(
  (k): k is Lang => GRAMMAR_FILES[k as Lang] !== null
);

export async function createExtractor(lang: Lang): Promise<Extractor> {
  if (SUPPORTED_TREE_SITTER_LANGS.includes(lang)) {
    const ts = new TreeSitterExtractor(lang);
    const ok = await ts.init();
    if (ok) return ts;
  }
  return new RegexExtractor(lang);
}
