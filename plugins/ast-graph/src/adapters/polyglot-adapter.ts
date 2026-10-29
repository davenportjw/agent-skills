import * as crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CompilerAdapter,
  CompilerGraphBatch,
  EdgeKind,
  GraphEdgeRecord as CanonicalGraphEdgeRecord,
  GraphFileRecord,
  GraphNodeRecord as CanonicalGraphNodeRecord,
  NodeKind,
} from '../types.js';

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', 'target', 'vendor']);

interface GraphNodeRecord {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: PolyglotLanguage;
  startLine: number;
  endLine: number;
  signature: string;
  returnType?: string;
  exported: boolean;
}

interface GraphEdgeRecord {
  sourceId: string;
  targetId: string;
  kind: EdgeKind;
  filePath: string;
  line: number;
  confidence: number;
  evidence?: string;
}

function normalizeCrossLayerId(id: string): string {
  if (id.startsWith('route:')) {
    const rest = id.slice('route:'.length);
    return `scip-endpoint http ${rest}#`;
  }
  if (id.startsWith('env:')) {
    const envName = id.slice('env:'.length);
    return `scip-env global env 1.0.0 ${envName}#`;
  }
  if (id.startsWith('sql:table:')) {
    const tableName = id.slice('sql:table:'.length).split('.').pop() ?? id.slice('sql:table:'.length);
    return `scip-sql ddl sql 1.0.0 table:${tableName}#`;
  }
  return id;
}

export type PolyglotLanguage =
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'ruby'
  | 'elixir'
  | 'php'
  | 'cpp'
  | 'swift'
  | 'zig'
  | 'wasm';

interface BraceScanState {
  inBlockComment: boolean;
  inRawString: boolean;
  heredocEnd: string;
}

/**
 * Counts brace delta on a single line across C-family / JVM / PHP / Swift / Zig languages,
 * skipping line and block comments, PHP `#` comments (excluding `#[Attr]`), standard strings,
 * verbatim strings (`@"..."`), triple-quoted raw strings (`"""..."""`), and PHP heredocs (`<<<EOF`).
 */
export function countPolyglotBracesLine(
  line: string,
  state: BraceScanState,
  lang: PolyglotLanguage
): { delta: number; state: BraceScanState } {
  let delta = 0;
  let { inBlockComment, inRawString, heredocEnd } = state;

  if (heredocEnd) {
    const trimmed = line.trim().replace(/;$/, '');
    if (trimmed === heredocEnd) {
      heredocEnd = '';
    }
    return { delta: 0, state: { inBlockComment, inRawString, heredocEnd } };
  }

  let inSingle = false;
  let inDouble = false;
  let inVerbatim = false;
  let i = 0;

  while (i < line.length) {
    if (inBlockComment) {
      const endIdx = line.indexOf('*/', i);
      if (endIdx < 0) {
        return { delta, state: { inBlockComment: true, inRawString, heredocEnd } };
      }
      inBlockComment = false;
      i = endIdx + 2;
      continue;
    }

    if (inRawString) {
      const endIdx = line.indexOf('"""', i);
      if (endIdx < 0) {
        return { delta, state: { inBlockComment, inRawString: true, heredocEnd } };
      }
      inRawString = false;
      i = endIdx + 3;
      continue;
    }

    const ch = line[i];

    if (inVerbatim) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          i += 2;
          continue;
        }
        inVerbatim = false;
      }
      i++;
      continue;
    }

    if (inSingle) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }

    if (inDouble) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }

    // Comments
    if (ch === '/' && i + 1 < line.length) {
      if (line[i + 1] === '/') break;
      if (line[i + 1] === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }
    }

    // PHP `#` line comment (but NOT PHP 8 `#[Attribute]`)
    if (lang === 'php' && ch === '#') {
      if (i + 1 < line.length && line[i + 1] === '[') {
        i += 2;
        continue;
      }
      break;
    }

    // PHP heredoc / nowdoc: <<<EOF or <<<'EOF' or <<<"EOF"
    if (lang === 'php' && ch === '<' && line.slice(i, i + 3) === '<<<') {
      const rest = line.slice(i + 3).trim();
      const hdMatch = /^['"]?([A-Za-z_]\w*)['"]?$/.exec(rest);
      if (hdMatch) {
        heredocEnd = hdMatch[1];
        break;
      }
    }

    // C# verbatim string @"..."
    if (lang === 'csharp' && ch === '@' && i + 1 < line.length && line[i + 1] === '"') {
      inVerbatim = true;
      i += 2;
      continue;
    }

    // Triple-quoted raw string """...""" (Java, Kotlin, C#, Swift)
    if (ch === '"' && line.slice(i, i + 3) === '"""') {
      inRawString = true;
      i += 3;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }

    if (ch === '{') {
      delta++;
    } else if (ch === '}') {
      delta--;
    }
    i++;
  }

  return { delta, state: { inBlockComment, inRawString, heredocEnd } };
}

function findMatchingEndLineBrace(
  lines: string[],
  startLineIdx: number,
  lang: PolyglotLanguage
): number {
  let depth = 0;
  let opened = false;
  let state: BraceScanState = {
    inBlockComment: false,
    inRawString: false,
    heredocEnd: '',
  };

  for (let i = startLineIdx; i < lines.length; i++) {
    const step = countPolyglotBracesLine(lines[i], state, lang);
    state = step.state;
    depth += step.delta;
    if (depth > 0) {
      opened = true;
    }
    if (opened && depth <= 0) {
      return i + 1;
    }
    if (!opened && i === startLineIdx && lines[i].replace(/\/\/.*$/, '').trim().endsWith(';')) {
      return i + 1;
    }
  }
  return startLineIdx + 1;
}

/**
 * Splits a comma-separated supertype list at top-level commas (`<...>` depth 0).
 */
function splitTopLevelGenericCommas(raw: string): string[] {
  const parts: string[] = [];
  let angleDepth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '<') angleDepth++;
    else if (ch === '>' && angleDepth > 0) angleDepth--;
    else if (ch === ',' && angleDepth === 0) {
      const token = raw.slice(start, i).trim();
      if (token) parts.push(token);
      start = i + 1;
    }
  }
  const tail = raw.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function stripGenericsAndArgs(typeExpr: string): string {
  let s = typeExpr.trim();
  const ltIdx = s.indexOf('<');
  if (ltIdx >= 0) s = s.slice(0, ltIdx);
  const parenIdx = s.indexOf('(');
  if (parenIdx >= 0) s = s.slice(0, parenIdx);
  return s.trim();
}

export function detectPolyglotLanguage(filePath: string): PolyglotLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.java':
      return 'java';
    case '.kt':
    case '.kts':
      return 'kotlin';
    case '.cs':
      return 'csharp';
    case '.rb':
      return 'ruby';
    case '.ex':
    case '.exs':
      return 'elixir';
    case '.php':
      return 'php';
    case '.c':
    case '.cc':
    case '.cpp':
    case '.cxx':
    case '.h':
    case '.hpp':
    case '.hxx':
      return 'cpp';
    case '.swift':
      return 'swift';
    case '.zig':
      return 'zig';
    case '.wat':
    case '.wit':
    case '.wasm':
      return 'wasm';
    default:
      return null;
  }
}

export class PolyglotCompilerAdapter implements CompilerAdapter {
  public readonly name = 'scip-polyglot';
  public readonly languages = [
    'java',
    'kotlin',
    'csharp',
    'ruby',
    'elixir',
    'php',
    'cpp',
    'swift',
    'zig',
    'wasm',
  ] as const;

  public supportsFile(filePath: string): boolean {
    return detectPolyglotLanguage(filePath) !== null;
  }

  public discoverPolyglotFiles(workspaceRoot: string): string[] {
    const results: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && this.supportsFile(full)) {
          results.push(full);
        }
      }
    };
    walk(workspaceRoot);
    return results.sort();
  }

  public extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch {
    const files = targetFiles
      ? targetFiles.filter((f) => this.supportsFile(f) && fs.existsSync(f))
      : this.discoverPolyglotFiles(workspaceRoot);

    const fileRecords: GraphFileRecord[] = [];
    const rawNodes: GraphNodeRecord[] = [];
    const rawEdges: GraphEdgeRecord[] = [];

    for (const filePath of files) {
      const lang = detectPolyglotLanguage(filePath);
      if (!lang) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      const stat = fs.statSync(filePath);
      const relPath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
      const lineCount = content.split(/\r?\n/).length || 1;

      fileRecords.push({
        filePath: relPath,
        packageName: lang,
        language: lang,
        sha256: sha256Hex(content),
        mtimeMs: Math.trunc(stat.mtimeMs),
        sizeBytes: stat.size,
        lineCount,
      });

      const parsed = this.parseFile(relPath, content, lang);
      rawNodes.push(...parsed.nodes);
      rawEdges.push(...parsed.edges);
    }

    const nodes: CanonicalGraphNodeRecord[] = rawNodes.map((n) => ({
      id: normalizeCrossLayerId(n.id),
      kind: n.kind,
      name: n.name,
      qualifiedName: n.qualifiedName,
      packageName: n.language,
      filePath: n.filePath,
      language: n.language,
      startLine: n.startLine,
      startCol: 1,
      endLine: n.endLine,
      endCol: 1,
      signature: n.signature,
      docstring: '',
      exported: n.exported,
      complexity: 1,
      labels: [n.kind],
      properties: n.returnType ? { returnType: n.returnType } : {},
    }));

    const edges: CanonicalGraphEdgeRecord[] = rawEdges.map((e) => ({
      srcId: normalizeCrossLayerId(e.sourceId),
      dstId: normalizeCrossLayerId(e.targetId),
      kind: e.kind,
      filePath: e.filePath,
      line: e.line,
      col: 1,
      weight: e.confidence,
      properties: e.evidence ? { evidence: e.evidence } : {},
    }));

    return {
      compiler: this.name,
      files: fileRecords,
      nodes,
      edges,
      diagnostics: [],
    };
  }

  public parseFile(
    relPath: string,
    content: string,
    lang: PolyglotLanguage
  ): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    switch (lang) {
      case 'java':
        return this.parseJava(relPath, content);
      case 'kotlin':
        return this.parseKotlin(relPath, content);
      case 'csharp':
        return this.parseCSharp(relPath, content);
      case 'ruby':
        return this.parseRuby(relPath, content);
      case 'elixir':
        return this.parseElixir(relPath, content);
      case 'php':
        return this.parsePhp(relPath, content);
      case 'cpp':
        return this.parseCpp(relPath, content);
      case 'swift':
        return this.parseSwift(relPath, content);
      case 'zig':
        return this.parseZig(relPath, content);
      case 'wasm':
        return this.parseWasm(relPath, content);
    }
  }

  private createFileNode(
    relPath: string,
    lang: PolyglotLanguage,
    totalLines: number,
    isTestFile: boolean
  ): { fileId: string; node: GraphNodeRecord } {
    const fileId = `scip-${lang} 💡 ${lang} pkg 0.1.0 ${relPath}/`;
    return {
      fileId,
      node: {
        id: fileId,
        kind: isTestFile ? 'TestSuite' : 'File',
        name: path.basename(relPath),
        qualifiedName: relPath,
        filePath: relPath,
        language: lang,
        startLine: 1,
        endLine: totalLines,
        signature: relPath,
        exported: true,
      },
    };
  }

  // ============================================================================
  // 1. JAVA (.java)
  // ============================================================================
  private parseJava(
    relPath: string,
    content: string
  ): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];
    const lines = content.split(/\r?\n/);
    const isTestFile = relPath.endsWith('Test.java') || relPath.endsWith('Tests.java') || relPath.includes('/test/');
    const { fileId, node: fileNode } = this.createFileNode(relPath, 'java', lines.length || 1, isTestFile);
    nodes.push(fileNode);

    const JAVA_IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/;
    const JAVA_TYPE_RE =
      /^\s*(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+|sealed\s+|non-sealed\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)(?:<[^>]*>)?(?:\([^)]*\))?(?:\s+extends\s+([A-Za-z_][\w.<>,\s]*?))?(?:\s+implements\s+([A-Za-z_][\w.<>,\s]*?))?\s*\{/;
    const JAVA_METHOD_RE =
      /^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+|synchronized\s+|default\s+|native\s+)*(?:<[^>]+>\s+)?([A-Za-z_][\w.<>\[\],\s?]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:throws\s+[^{;]+)?(?:\{|;)/;
    const JAVA_SPRING_ROUTE_RE =
      /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)")?/;
    const JAVA_TABLE_RE = /@Table\s*\(\s*(?:name\s*=\s*)?"([^"]+)"/;
    const JAVA_ENV_RE = /\bSystem\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g;

    let currentClassId = fileId;
    let currentClassName = '';
    let baseRoutePrefix = '';
    let pendingAnnotations: string[] = [];

    const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw', 'synchronized']);

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

      if (trimmed.startsWith('@')) {
        pendingAnnotations.push(trimmed);
      }

      const impMatch = JAVA_IMPORT_RE.exec(line);
      if (impMatch) {
        edges.push({
          sourceId: fileId,
          targetId: `java:import:${impMatch[1]}`,
          kind: 'IMPORTS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
          evidence: trimmed,
        });
        continue;
      }

      JAVA_ENV_RE.lastIndex = 0;
      let envMatch: RegExpExecArray | null;
      while ((envMatch = JAVA_ENV_RE.exec(line)) !== null) {
        const envId = `env:${envMatch[1]}`;
        nodes.push({
          id: envId,
          kind: 'EnvVar',
          name: envMatch[1],
          qualifiedName: `env.${envMatch[1]}`,
          filePath: relPath,
          language: 'java',
          startLine: lineNo,
          endLine: lineNo,
          signature: `env ${envMatch[1]}`,
          exported: true,
        });
        edges.push({
          sourceId: currentClassId,
          targetId: envId,
          kind: 'CONFIGURES_ENV',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
      }

      const typeMatch = JAVA_TYPE_RE.exec(line);
      if (typeMatch) {
        const kw = typeMatch[1];
        const typeName = typeMatch[2];
        const extendsClause = typeMatch[3]?.trim();
        const implClause = typeMatch[4]?.trim();
        const endLine = findMatchingEndLineBrace(lines, i, 'java');
        const kind: NodeKind = kw === 'interface' ? 'Interface' : kw === 'enum' ? 'Enum' : 'Class';
        const typeId = `${fileId}${typeName}#`;
        currentClassId = typeId;
        currentClassName = typeName;

        nodes.push({
          id: typeId,
          kind,
          name: typeName,
          qualifiedName: `${relPath}:${typeName}`,
          filePath: relPath,
          language: 'java',
          startLine: lineNo,
          endLine,
          signature: `${kw} ${typeName}`,
          exported: trimmed.includes('public'),
        });
        edges.push({
          sourceId: fileId,
          targetId: typeId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });

        if (extendsClause) {
          for (const parent of splitTopLevelGenericCommas(extendsClause)) {
            const cleanParent = stripGenericsAndArgs(parent);
            edges.push({
              sourceId: typeId,
              targetId: `${fileId}${cleanParent}#`,
              kind: 'EXTENDS',
              filePath: relPath,
              line: lineNo,
              confidence: 0.9,
            });
          }
        }
        if (implClause) {
          for (const iface of splitTopLevelGenericCommas(implClause)) {
            const cleanIface = stripGenericsAndArgs(iface);
            edges.push({
              sourceId: typeId,
              targetId: `${fileId}${cleanIface}#`,
              kind: 'IMPLEMENTS',
              filePath: relPath,
              line: lineNo,
              confidence: 0.9,
            });
          }
        }

        for (const ann of pendingAnnotations) {
          const routeMatch = JAVA_SPRING_ROUTE_RE.exec(ann);
          if (routeMatch && routeMatch[2]) {
            baseRoutePrefix = routeMatch[2];
          }
          const tableMatch = JAVA_TABLE_RE.exec(ann);
          if (tableMatch) {
            edges.push({
              sourceId: typeId,
              targetId: `sql:table:${tableMatch[1]}`,
              kind: 'REFERENCES',
              filePath: relPath,
              line: lineNo,
              confidence: 0.95,
              evidence: ann,
            });
          }
        }
        pendingAnnotations = [];
        continue;
      }

      if (!trimmed.startsWith('@')) {
        const mMatch = JAVA_METHOD_RE.exec(line);
        if (mMatch) {
          const retType = mMatch[1].trim();
          const mName = mMatch[2];
          const params = mMatch[3].trim();
          if (!KEYWORDS.has(mName) && !KEYWORDS.has(retType)) {
            const endLine = findMatchingEndLineBrace(lines, i, 'java');
            const isTest = pendingAnnotations.some((a) => /^@(?:Test|ParameterizedTest)\b/.test(a));
            const methodId = `${currentClassId}${mName}().`;
            nodes.push({
              id: methodId,
              kind: isTest ? 'TestCase' : 'Method',
              name: mName,
              qualifiedName: currentClassName ? `${currentClassName}.${mName}` : mName,
              filePath: relPath,
              language: 'java',
              startLine: lineNo,
              endLine,
              signature: `${retType} ${mName}(${params})`,
              returnType: retType,
              exported: !trimmed.startsWith('private'),
            });
            edges.push({
              sourceId: currentClassId,
              targetId: methodId,
              kind: 'CONTAINS',
              filePath: relPath,
              line: lineNo,
              confidence: 1.0,
            });

            for (const ann of pendingAnnotations) {
              const routeMatch = JAVA_SPRING_ROUTE_RE.exec(ann);
              if (routeMatch) {
                const verbMap: Record<string, string> = {
                  GetMapping: 'GET',
                  PostMapping: 'POST',
                  PutMapping: 'PUT',
                  DeleteMapping: 'DELETE',
                  PatchMapping: 'PATCH',
                  RequestMapping: 'ANY',
                };
                const verb = verbMap[routeMatch[1]] ?? 'ANY';
                const subPath = routeMatch[2] ?? '';
                const fullRoute = `${baseRoutePrefix}/${subPath}`.replace(/\/+/g, '/');
                const routeId = `route:${verb}:${fullRoute}`;
                nodes.push({
                  id: routeId,
                  kind: 'RouteEndpoint',
                  name: `${verb} ${fullRoute}`,
                  qualifiedName: `${verb} ${fullRoute}`,
                  filePath: relPath,
                  language: 'java',
                  startLine: lineNo,
                  endLine: lineNo,
                  signature: `${verb} ${fullRoute}`,
                  exported: true,
                });
                edges.push({
                  sourceId: methodId,
                  targetId: routeId,
                  kind: 'HANDLES_ROUTE',
                  filePath: relPath,
                  line: lineNo,
                  confidence: 1.0,
                  evidence: ann,
                });
              }
            }
            pendingAnnotations = [];
          }
        } else {
          pendingAnnotations = [];
        }
      }
    }

    return { nodes, edges };
  }

  // ============================================================================
  // 2. KOTLIN (.kt, .kts)
  // ============================================================================
  private parseKotlin(
    relPath: string,
    content: string
  ): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];
    const lines = content.split(/\r?\n/);
    const isTestFile = relPath.endsWith('Test.kt') || relPath.endsWith('Tests.kt') || relPath.includes('/test/');
    const { fileId, node: fileNode } = this.createFileNode(relPath, 'kotlin', lines.length || 1, isTestFile);
    nodes.push(fileNode);

    const KT_IMPORT_RE = /^\s*import\s+([\w.*]+)/;
    const KT_TYPE_RE =
      /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|open\s+|abstract\s+|sealed\s+|data\s+|value\s+|enum\s+)*(class|interface|object)\s+([A-Za-z_]\w*)(?:<[^>]*>)?(?:\s*(?:constructor\s*)?\([^)]*\))?(?:\s*:\s*([^{]+))?/;
    const KT_FUN_RE =
      /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|override\s+|suspend\s+|inline\s+|operator\s+|infix\s+)*fun\s+(?:<[^>]+>\s+)?([A-Za-z_][\w.`]*)\s*\(([^)]*)\)(?:\s*:\s*([^{=]+))?/;
    const KT_KTOR_ROUTE_RE = /^\s*(get|post|put|delete|patch)\s*\(\s*"([^"]+)"\s*\)/;

    let currentClassId = fileId;
    let currentClassName = '';
    let pendingAnnotations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      if (trimmed.startsWith('@')) {
        pendingAnnotations.push(trimmed);
        continue;
      }

      const impMatch = KT_IMPORT_RE.exec(line);
      if (impMatch) {
        edges.push({
          sourceId: fileId,
          targetId: `kotlin:import:${impMatch[1]}`,
          kind: 'IMPORTS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
        continue;
      }

      const ktorMatch = KT_KTOR_ROUTE_RE.exec(line);
      if (ktorMatch) {
        const verb = ktorMatch[1].toUpperCase();
        const routePath = ktorMatch[2];
        const routeId = `route:${verb}:${routePath}`;
        nodes.push({
          id: routeId,
          kind: 'RouteEndpoint',
          name: `${verb} ${routePath}`,
          qualifiedName: `${verb} ${routePath}`,
          filePath: relPath,
          language: 'kotlin',
          startLine: lineNo,
          endLine: lineNo,
          signature: `${verb} ${routePath}`,
          exported: true,
        });
        edges.push({
          sourceId: currentClassId,
          targetId: routeId,
          kind: 'HANDLES_ROUTE',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
      }

      const typeMatch = KT_TYPE_RE.exec(line);
      if (typeMatch && typeMatch[2] !== 'companion') {
        const kw = typeMatch[1];
        const typeName = typeMatch[2];
        const supers = typeMatch[3]?.trim();
        const endLine = findMatchingEndLineBrace(lines, i, 'kotlin');
        const kind: NodeKind =
          kw === 'interface' ? 'Interface' : trimmed.includes('enum class') ? 'Enum' : 'Class';
        const typeId = `${fileId}${typeName}#`;
        currentClassId = typeId;
        currentClassName = typeName;

        nodes.push({
          id: typeId,
          kind,
          name: typeName,
          qualifiedName: `${relPath}:${typeName}`,
          filePath: relPath,
          language: 'kotlin',
          startLine: lineNo,
          endLine,
          signature: `${kw} ${typeName}`,
          exported: !trimmed.startsWith('private'),
        });
        edges.push({
          sourceId: fileId,
          targetId: typeId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });

        if (supers) {
          for (const sup of splitTopLevelGenericCommas(supers)) {
            const hasCtorCall = sup.includes('(');
            const cleanSup = stripGenericsAndArgs(sup);
            if (!cleanSup) continue;
            edges.push({
              sourceId: typeId,
              targetId: `${fileId}${cleanSup}#`,
              kind: hasCtorCall ? 'EXTENDS' : 'IMPLEMENTS',
              filePath: relPath,
              line: lineNo,
              confidence: 0.9,
            });
          }
        }
        pendingAnnotations = [];
        continue;
      }

      const funMatch = KT_FUN_RE.exec(line);
      if (funMatch) {
        const rawName = funMatch[1];
        const shortName = rawName.includes('.') ? rawName.slice(rawName.lastIndexOf('.') + 1) : rawName;
        const params = funMatch[2].trim();
        const retType = funMatch[3]?.trim();
        const endLine = findMatchingEndLineBrace(lines, i, 'kotlin');
        const isTest = pendingAnnotations.some((a) => /^@Test\b/.test(a));
        const funId = `${currentClassId}${shortName}().`;
        nodes.push({
          id: funId,
          kind: isTest ? 'TestCase' : currentClassId === fileId ? 'Function' : 'Method',
          name: shortName,
          qualifiedName: currentClassName ? `${currentClassName}.${shortName}` : shortName,
          filePath: relPath,
          language: 'kotlin',
          startLine: lineNo,
          endLine,
          signature: `fun ${rawName}(${params})${retType ? `: ${retType}` : ''}`,
          returnType: retType,
          exported: !trimmed.startsWith('private'),
        });
        edges.push({
          sourceId: currentClassId,
          targetId: funId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        pendingAnnotations = [];
      } else {
        pendingAnnotations = [];
      }
    }

    return { nodes, edges };
  }

  // ============================================================================
  // 3. C# (.cs)
  // ============================================================================
  private parseCSharp(
    relPath: string,
    content: string
  ): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];
    const lines = content.split(/\r?\n/);
    const isTestFile = relPath.endsWith('Tests.cs') || relPath.endsWith('Test.cs');
    const { fileId, node: fileNode } = this.createFileNode(relPath, 'csharp', lines.length || 1, isTestFile);
    nodes.push(fileNode);

    const CS_USING_RE = /^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/;
    const CS_TYPE_RE =
      /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|abstract\s+|sealed\s+|static\s+|partial\s+|readonly\s+)*(class|struct|interface|record|enum)\s+([A-Za-z_]\w*)(?:<[^>]*>)?(?:\([^)]*\))?(?:\s*:\s*([^{where]+))?/;
    const CS_PROP_RE =
      /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|virtual\s+|override\s+|required\s+|static\s+)+([A-Za-z_][\w.<>\[\]?]*)\s+([A-Za-z_]\w*)\s*\{\s*(?:get|set|init)\b/;
    const CS_METHOD_RE =
      /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|static\s+|virtual\s+|override\s+|abstract\s+|async\s+)+([A-Za-z_][\w.<>\[\],\s?]*?)\s+([A-Za-z_]\w*)(?:<[^>]*>)?\s*\(([^)]*)\)/;
    const CS_ATTR_ROUTE_RE =
      /\[(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|Route)\s*(?:\(\s*"([^"]*)"\s*\))?\]/i;
    const CS_MINIMAL_API_RE = /\bMap(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/g;
    const CS_TABLE_ATTR_RE = /\[Table\s*\(\s*"([^"]+)"/;
    const CS_DBSET_RE = /DbSet<\s*([A-Za-z_]\w*)\s*>\s+([A-Za-z_]\w*)/;

    let currentClassId = fileId;
    let currentClassName = '';
    let routePrefix = '';
    let pendingAttrs: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      if (trimmed.startsWith('[')) {
        pendingAttrs.push(trimmed);
        continue;
      }

      const usingMatch = CS_USING_RE.exec(line);
      if (usingMatch) {
        edges.push({
          sourceId: fileId,
          targetId: `csharp:using:${usingMatch[1]}`,
          kind: 'IMPORTS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
        continue;
      }

      CS_MINIMAL_API_RE.lastIndex = 0;
      let minMatch: RegExpExecArray | null;
      while ((minMatch = CS_MINIMAL_API_RE.exec(line)) !== null) {
        const verb = minMatch[1].toUpperCase();
        const routePath = minMatch[2];
        const routeId = `route:${verb}:${routePath}`;
        nodes.push({
          id: routeId,
          kind: 'RouteEndpoint',
          name: `${verb} ${routePath}`,
          qualifiedName: `${verb} ${routePath}`,
          filePath: relPath,
          language: 'csharp',
          startLine: lineNo,
          endLine: lineNo,
          signature: `${verb} ${routePath}`,
          exported: true,
        });
        edges.push({
          sourceId: currentClassId,
          targetId: routeId,
          kind: 'HANDLES_ROUTE',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
      }

      const typeMatch = CS_TYPE_RE.exec(line);
      if (typeMatch) {
        const kw = typeMatch[1];
        const typeName = typeMatch[2];
        const baseList = typeMatch[3]?.trim();
        const endLine = findMatchingEndLineBrace(lines, i, 'csharp');
        const kind: NodeKind = kw === 'interface' ? 'Interface' : kw === 'enum' ? 'Enum' : 'Class';
        const typeId = `${fileId}${typeName}#`;
        currentClassId = typeId;
        currentClassName = typeName;

        nodes.push({
          id: typeId,
          kind,
          name: typeName,
          qualifiedName: `${relPath}:${typeName}`,
          filePath: relPath,
          language: 'csharp',
          startLine: lineNo,
          endLine,
          signature: `${kw} ${typeName}`,
          exported: !trimmed.startsWith('private'),
        });
        edges.push({
          sourceId: fileId,
          targetId: typeId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });

        if (baseList) {
          for (const base of splitTopLevelGenericCommas(baseList)) {
            const cleanBase = stripGenericsAndArgs(base);
            if (!cleanBase) continue;
            const isIface = /^I[A-Z]/.test(cleanBase) || kw === 'struct';
            edges.push({
              sourceId: typeId,
              targetId: `${fileId}${cleanBase}#`,
              kind: isIface ? 'IMPLEMENTS' : 'EXTENDS',
              filePath: relPath,
              line: lineNo,
              confidence: 0.9,
            });
          }
        }

        for (const attr of pendingAttrs) {
          const rMatch = CS_ATTR_ROUTE_RE.exec(attr);
          if (rMatch && rMatch[2]) {
            routePrefix = rMatch[2].replace('[controller]', typeName.replace(/Controller$/i, '').toLowerCase());
          }
          const tMatch = CS_TABLE_ATTR_RE.exec(attr);
          if (tMatch) {
            edges.push({
              sourceId: typeId,
              targetId: `sql:table:${tMatch[1]}`,
              kind: 'REFERENCES',
              filePath: relPath,
              line: lineNo,
              confidence: 0.95,
            });
          }
        }
        pendingAttrs = [];
        continue;
      }

      const propMatch = CS_PROP_RE.exec(line);
      if (propMatch) {
        const propType = propMatch[1];
        const propName = propMatch[2];
        const propId = `${currentClassId}${propName}.`;
        nodes.push({
          id: propId,
          kind: 'Property',
          name: propName,
          qualifiedName: currentClassName ? `${currentClassName}.${propName}` : propName,
          filePath: relPath,
          language: 'csharp',
          startLine: lineNo,
          endLine: lineNo,
          signature: `${propType} ${propName}`,
          returnType: propType,
          exported: trimmed.startsWith('public'),
        });
        edges.push({
          sourceId: currentClassId,
          targetId: propId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        const dbSetMatch = CS_DBSET_RE.exec(line);
        if (dbSetMatch) {
          edges.push({
            sourceId: currentClassId,
            targetId: `sql:table:${dbSetMatch[2]}`,
            kind: 'REFERENCES',
            filePath: relPath,
            line: lineNo,
            confidence: 0.9,
          });
        }
        pendingAttrs = [];
        continue;
      }

      const mMatch = CS_METHOD_RE.exec(line);
      if (mMatch) {
        const retType = mMatch[1].trim();
        const mName = mMatch[2];
        const params = mMatch[3].trim();
        const endLine = findMatchingEndLineBrace(lines, i, 'csharp');
        const isTest = pendingAttrs.some((a) => /^\[(?:Fact|Theory|Test|TestMethod)\b/.test(a));
        const methodId = `${currentClassId}${mName}().`;
        nodes.push({
          id: methodId,
          kind: isTest ? 'TestCase' : 'Method',
          name: mName,
          qualifiedName: currentClassName ? `${currentClassName}.${mName}` : mName,
          filePath: relPath,
          language: 'csharp',
          startLine: lineNo,
          endLine,
          signature: `${retType} ${mName}(${params})`,
          returnType: retType,
          exported: !trimmed.startsWith('private'),
        });
        edges.push({
          sourceId: currentClassId,
          targetId: methodId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });

        for (const attr of pendingAttrs) {
          const rMatch = CS_ATTR_ROUTE_RE.exec(attr);
          if (rMatch) {
            const rawVerb = rMatch[1].replace(/^Http/i, '').toUpperCase();
            const verb = rawVerb === 'ROUTE' ? 'ANY' : rawVerb;
            const sub = rMatch[2] ?? '';
            const fullRoute = `/${routePrefix}/${sub}`.replace(/\/+/g, '/');
            const routeId = `route:${verb}:${fullRoute}`;
            nodes.push({
              id: routeId,
              kind: 'RouteEndpoint',
              name: `${verb} ${fullRoute}`,
              qualifiedName: `${verb} ${fullRoute}`,
              filePath: relPath,
              language: 'csharp',
              startLine: lineNo,
              endLine: lineNo,
              signature: `${verb} ${fullRoute}`,
              exported: true,
            });
            edges.push({
              sourceId: methodId,
              targetId: routeId,
              kind: 'HANDLES_ROUTE',
              filePath: relPath,
              line: lineNo,
              confidence: 1.0,
              evidence: attr,
            });
          }
        }
        pendingAttrs = [];
      } else {
        pendingAttrs = [];
      }
    }

    return { nodes, edges };
  }

  // ============================================================================
  // 4. RUBY (.rb)
  // ============================================================================
  private parseRuby(
    relPath: string,
    content: string
  ): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];
    const lines = content.split(/\r?\n/);
    const isTestFile = relPath.endsWith('_spec.rb') || relPath.endsWith('_test.rb') || relPath.startsWith('spec/');
    const { fileId, node: fileNode } = this.createFileNode(relPath, 'ruby', lines.length || 1, isTestFile);
    nodes.push(fileNode);

    const RB_REQUIRE_RE = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/;
    const RB_CLASS_RE = /^\s*class\s+([A-Za-z_][\w:]*)(?:\s*<\s*([A-Za-z_][\w:]*))?/;
    const RB_MODULE_RE = /^\s*module\s+([A-Za-z_][\w:]*)/;
    const RB_DEF_RE = /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)(?:\s*\(([^)]*)\))?/;
    const RB_ROUTE_RE = /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/i;
    const RB_RESOURCES_RE = /^\s*resources?\s+:([A-Za-z_]\w*)/;
    const RB_TABLE_NAME_RE = /^\s*self\.table_name\s*=\s*['"]([^'"]+)['"]/;
    const RB_ENV_RE = /\bENV(?:\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]|\.fetch\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"])/g;

    let currentContainerId = fileId;
    let currentContainerName = '';

    const findRubyEndLine = (startIdx: number): number => {
      let depth = 0;
      for (let idx = startIdx; idx < lines.length; idx++) {
        const l = lines[idx].replace(/#.*$/, '').trim();
        if (!l) continue;
        if (/^(?:class|module|def|if|unless|case|while|until|for|begin)\b/.test(l) || /\bdo(?:\s*\|[^|]*\|)?\s*$/.test(l)) {
          depth++;
        }
        if (/^end\b/.test(l) || /\bend\s*$/.test(l)) {
          depth--;
          if (depth <= 0) return idx + 1;
        }
      }
      return startIdx + 1;
    };

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const reqMatch = RB_REQUIRE_RE.exec(line);
      if (reqMatch) {
        edges.push({
          sourceId: fileId,
          targetId: `ruby:require:${reqMatch[1]}`,
          kind: 'IMPORTS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
        continue;
      }

      RB_ENV_RE.lastIndex = 0;
      let envMatch: RegExpExecArray | null;
      while ((envMatch = RB_ENV_RE.exec(line)) !== null) {
        const envName = envMatch[1] || envMatch[2];
        const envId = `env:${envName}`;
        nodes.push({
          id: envId,
          kind: 'EnvVar',
          name: envName,
          qualifiedName: `env.${envName}`,
          filePath: relPath,
          language: 'ruby',
          startLine: lineNo,
          endLine: lineNo,
          signature: `env ${envName}`,
          exported: true,
        });
        edges.push({
          sourceId: currentContainerId,
          targetId: envId,
          kind: 'CONFIGURES_ENV',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
      }

      const clsMatch = RB_CLASS_RE.exec(line);
      if (clsMatch) {
        const clsName = clsMatch[1];
        const superName = clsMatch[2];
        const endLine = findRubyEndLine(i);
        const clsId = `${fileId}${clsName}#`;
        currentContainerId = clsId;
        currentContainerName = clsName;
        nodes.push({
          id: clsId,
          kind: 'Class',
          name: clsName,
          qualifiedName: `${relPath}:${clsName}`,
          filePath: relPath,
          language: 'ruby',
          startLine: lineNo,
          endLine,
          signature: superName ? `class ${clsName} < ${superName}` : `class ${clsName}`,
          exported: true,
        });
        edges.push({
          sourceId: fileId,
          targetId: clsId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        if (superName) {
          edges.push({
            sourceId: clsId,
            targetId: `${fileId}${superName}#`,
            kind: 'EXTENDS',
            filePath: relPath,
            line: lineNo,
            confidence: 0.9,
          });
        }
        continue;
      }

      const modMatch = RB_MODULE_RE.exec(line);
      if (modMatch) {
        const modName = modMatch[1];
        const endLine = findRubyEndLine(i);
        const modId = `${fileId}${modName}#`;
        currentContainerId = modId;
        currentContainerName = modName;
        nodes.push({
          id: modId,
          kind: 'Namespace',
          name: modName,
          qualifiedName: `${relPath}:${modName}`,
          filePath: relPath,
          language: 'ruby',
          startLine: lineNo,
          endLine,
          signature: `module ${modName}`,
          exported: true,
        });
        edges.push({
          sourceId: fileId,
          targetId: modId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        continue;
      }

      const defMatch = RB_DEF_RE.exec(line);
      if (defMatch) {
        const fnName = defMatch[1];
        const params = defMatch[2] ?? '';
        const endLine = findRubyEndLine(i);
        const isTest = isTestFile && fnName.startsWith('test_');
        const fnId = `${currentContainerId}${fnName}().`;
        nodes.push({
          id: fnId,
          kind: isTest ? 'TestCase' : currentContainerId === fileId ? 'Function' : 'Method',
          name: fnName,
          qualifiedName: currentContainerName ? `${currentContainerName}#${fnName}` : fnName,
          filePath: relPath,
          language: 'ruby',
          startLine: lineNo,
          endLine,
          signature: `def ${fnName}(${params})`,
          exported: true,
        });
        edges.push({
          sourceId: currentContainerId,
          targetId: fnId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        continue;
      }

      const routeMatch = RB_ROUTE_RE.exec(line);
      if (routeMatch) {
        const verb = routeMatch[1].toUpperCase();
        const routePath = routeMatch[2];
        const routeId = `route:${verb}:${routePath}`;
        nodes.push({
          id: routeId,
          kind: 'RouteEndpoint',
          name: `${verb} ${routePath}`,
          qualifiedName: `${verb} ${routePath}`,
          filePath: relPath,
          language: 'ruby',
          startLine: lineNo,
          endLine: lineNo,
          signature: `${verb} ${routePath}`,
          exported: true,
        });
        edges.push({
          sourceId: currentContainerId,
          targetId: routeId,
          kind: 'HANDLES_ROUTE',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
        continue;
      }

      const resMatch = RB_RESOURCES_RE.exec(line);
      if (resMatch) {
        const resName = `/${resMatch[1]}`;
        const routeId = `route:RESOURCE:${resName}`;
        nodes.push({
          id: routeId,
          kind: 'RouteEndpoint',
          name: `RESOURCE ${resName}`,
          qualifiedName: `RESOURCE ${resName}`,
          filePath: relPath,
          language: 'ruby',
          startLine: lineNo,
          endLine: lineNo,
          signature: `resources :${resMatch[1]}`,
          exported: true,
        });
        edges.push({
          sourceId: currentContainerId,
          targetId: routeId,
          kind: 'HANDLES_ROUTE',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
        continue;
      }

      const tblMatch = RB_TABLE_NAME_RE.exec(line);
      if (tblMatch) {
        edges.push({
          sourceId: currentContainerId,
          targetId: `sql:table:${tblMatch[1]}`,
          kind: 'REFERENCES',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
      }
    }

    return { nodes, edges };
  }

  // ============================================================================
  // 5. ELIXIR (.ex, .exs)
  // ============================================================================
  private parseElixir(
    relPath: string,
    content: string
  ): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];
    const lines = content.split(/\r?\n/);
    const isTestFile = relPath.endsWith('_test.exs');
    const { fileId, node: fileNode } = this.createFileNode(relPath, 'elixir', lines.length || 1, isTestFile);
    nodes.push(fileNode);

    const EX_DEFMODULE_RE = /^\s*defmodule\s+([A-Za-z_][\w.]*)\s+do\b/;
    const EX_DEF_RE = /^\s*(def|defp|defmacro|defmacrop)\s+([A-Za-z_]\w*[?!]?)(?:\(([^)]*)\))?/;
    const EX_DEP_RE = /^\s*(?:alias|import|use|require)\s+([A-Za-z_][\w.]*)/;
    const EX_PHOENIX_ROUTE_RE =
      /^\s*(get|post|put|patch|delete)\s+"([^"]+)"\s*,\s*([A-Za-z_][\w.]*)\s*,\s*:([A-Za-z_]\w*)/;
    const EX_ECTO_SCHEMA_RE = /^\s*schema\s+"([^"]+)"\s+do\b/;
    const EX_TEST_RE = /^\s*test\s+"([^"]+)"/;

    let currentModId = fileId;
    let currentModName = '';

    const findElixirEndLine = (startIdx: number): number => {
      if (lines[startIdx].includes(', do:')) return startIdx + 1;
      let depth = 0;
      for (let idx = startIdx; idx < lines.length; idx++) {
        const l = lines[idx].replace(/#.*$/, '');
        const doMatches = l.match(/\bdo\b(?!:)/g);
        const fnMatches = l.match(/\bfn\b/g);
        const endMatches = l.match(/\bend\b/g);
        depth += (doMatches?.length ?? 0) + (fnMatches?.length ?? 0);
        depth -= endMatches?.length ?? 0;
        if (depth <= 0 && idx >= startIdx) return idx + 1;
      }
      return startIdx + 1;
    };

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const modMatch = EX_DEFMODULE_RE.exec(line);
      if (modMatch) {
        const modName = modMatch[1];
        const endLine = findElixirEndLine(i);
        const modId = `${fileId}${modName}#`;
        currentModId = modId;
        currentModName = modName;
        nodes.push({
          id: modId,
          kind: 'Class',
          name: modName,
          qualifiedName: modName,
          filePath: relPath,
          language: 'elixir',
          startLine: lineNo,
          endLine,
          signature: `defmodule ${modName}`,
          exported: true,
        });
        edges.push({
          sourceId: fileId,
          targetId: modId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        continue;
      }

      const depMatch = EX_DEP_RE.exec(line);
      if (depMatch) {
        edges.push({
          sourceId: currentModId,
          targetId: `elixir:mod:${depMatch[1]}`,
          kind: 'IMPORTS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.9,
        });
        continue;
      }

      const defMatch = EX_DEF_RE.exec(line);
      if (defMatch && defMatch[2] !== 'when') {
        const kw = defMatch[1];
        const fnName = defMatch[2];
        const params = defMatch[3] ?? '';
        const endLine = findElixirEndLine(i);
        const fnId = `${currentModId}${fnName}().`;
        nodes.push({
          id: fnId,
          kind: 'Function',
          name: fnName,
          qualifiedName: currentModName ? `${currentModName}.${fnName}` : fnName,
          filePath: relPath,
          language: 'elixir',
          startLine: lineNo,
          endLine,
          signature: `${kw} ${fnName}(${params})`,
          exported: kw === 'def' || kw === 'defmacro',
        });
        edges.push({
          sourceId: currentModId,
          targetId: fnId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        continue;
      }

      const testMatch = EX_TEST_RE.exec(line);
      if (testMatch) {
        const testName = testMatch[1];
        const endLine = findElixirEndLine(i);
        const testId = `${currentModId}test:${testName}.`;
        nodes.push({
          id: testId,
          kind: 'TestCase',
          name: testName,
          qualifiedName: `${currentModName}:${testName}`,
          filePath: relPath,
          language: 'elixir',
          startLine: lineNo,
          endLine,
          signature: `test "${testName}"`,
          exported: false,
        });
        edges.push({
          sourceId: currentModId,
          targetId: testId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        continue;
      }

      const routeMatch = EX_PHOENIX_ROUTE_RE.exec(line);
      if (routeMatch) {
        const verb = routeMatch[1].toUpperCase();
        const routePath = routeMatch[2];
        const routeId = `route:${verb}:${routePath}`;
        nodes.push({
          id: routeId,
          kind: 'RouteEndpoint',
          name: `${verb} ${routePath}`,
          qualifiedName: `${verb} ${routePath}`,
          filePath: relPath,
          language: 'elixir',
          startLine: lineNo,
          endLine: lineNo,
          signature: `${verb} ${routePath}`,
          exported: true,
        });
        edges.push({
          sourceId: currentModId,
          targetId: routeId,
          kind: 'HANDLES_ROUTE',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
        continue;
      }

      const schemaMatch = EX_ECTO_SCHEMA_RE.exec(line);
      if (schemaMatch) {
        edges.push({
          sourceId: currentModId,
          targetId: `sql:table:${schemaMatch[1]}`,
          kind: 'REFERENCES',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
      }
    }

    return { nodes, edges };
  }

  // ============================================================================
  // 6. PHP (.php)
  // ============================================================================
  private parsePhp(
    relPath: string,
    content: string
  ): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];
    const lines = content.split(/\r?\n/);
    const isTestFile = relPath.endsWith('Test.php') || relPath.includes('/tests/');
    const { fileId, node: fileNode } = this.createFileNode(relPath, 'php', lines.length || 1, isTestFile);
    nodes.push(fileNode);

    const PHP_USE_RE = /^\s*use\s+([A-Za-z_][\w\\]*)(?:\s+as\s+[A-Za-z_]\w*)?\s*;/;
    const PHP_TYPE_RE =
      /^\s*(?:abstract\s+|final\s+|readonly\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)(?:\s*:\s*[A-Za-z_]\w*)?(?:\s+extends\s+([A-Za-z_][\w\\,\s]*))?(?:\s+implements\s+([A-Za-z_][\w\\,\s]*))?/;
    const PHP_FN_RE =
      /^\s*(?:public\s+|protected\s+|private\s+|static\s+|abstract\s+|final\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(([^)]*)\)(?:\s*:\s*\??([A-Za-z_][\w\\|?]*))?/;
    const PHP_SYMFONY_ROUTE_RE =
      /#\[Route\(\s*['"]([^'"]+)['"](?:[^]]*methods:\s*\[['"]([A-Za-z]+)['"])?/;
    const PHP_LARAVEL_ROUTE_RE =
      /\bRoute::(get|post|put|patch|delete|resource)\s*\(\s*['"]([^'"]+)['"]/i;

    let currentClassId = fileId;
    let currentClassName = '';
    let pendingAttrs: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      if (trimmed.startsWith('#[')) {
        pendingAttrs.push(trimmed);
        continue;
      }

      const useMatch = PHP_USE_RE.exec(line);
      if (useMatch) {
        edges.push({
          sourceId: fileId,
          targetId: `php:use:${useMatch[1]}`,
          kind: 'IMPORTS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
        continue;
      }

      const lRoute = PHP_LARAVEL_ROUTE_RE.exec(line);
      if (lRoute) {
        const verb = lRoute[1].toUpperCase();
        const routePath = lRoute[2];
        const routeId = `route:${verb}:${routePath}`;
        nodes.push({
          id: routeId,
          kind: 'RouteEndpoint',
          name: `${verb} ${routePath}`,
          qualifiedName: `${verb} ${routePath}`,
          filePath: relPath,
          language: 'php',
          startLine: lineNo,
          endLine: lineNo,
          signature: `${verb} ${routePath}`,
          exported: true,
        });
        edges.push({
          sourceId: currentClassId,
          targetId: routeId,
          kind: 'HANDLES_ROUTE',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
      }

      const typeMatch = PHP_TYPE_RE.exec(line);
      if (typeMatch) {
        const kw = typeMatch[1];
        const typeName = typeMatch[2];
        const extendsClause = typeMatch[3]?.trim();
        const implClause = typeMatch[4]?.trim();
        const endLine = findMatchingEndLineBrace(lines, i, 'php');
        const kind: NodeKind =
          kw === 'interface' || kw === 'trait' ? 'Interface' : kw === 'enum' ? 'Enum' : 'Class';
        const typeId = `${fileId}${typeName}#`;
        currentClassId = typeId;
        currentClassName = typeName;
        nodes.push({
          id: typeId,
          kind,
          name: typeName,
          qualifiedName: `${relPath}:${typeName}`,
          filePath: relPath,
          language: 'php',
          startLine: lineNo,
          endLine,
          signature: `${kw} ${typeName}`,
          exported: true,
        });
        edges.push({
          sourceId: fileId,
          targetId: typeId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        if (extendsClause) {
          edges.push({
            sourceId: typeId,
            targetId: `${fileId}${extendsClause.trim()}#`,
            kind: 'EXTENDS',
            filePath: relPath,
            line: lineNo,
            confidence: 0.9,
          });
        }
        if (implClause) {
          for (const iface of implClause.split(',')) {
            const clean = iface.trim();
            if (clean) {
              edges.push({
                sourceId: typeId,
                targetId: `${fileId}${clean}#`,
                kind: 'IMPLEMENTS',
                filePath: relPath,
                line: lineNo,
                confidence: 0.9,
              });
            }
          }
        }
        pendingAttrs = [];
        continue;
      }

      const fnMatch = PHP_FN_RE.exec(line);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const params = fnMatch[2].trim();
        const retType = fnMatch[3]?.trim();
        const endLine = findMatchingEndLineBrace(lines, i, 'php');
        const isTest = isTestFile && fnName.startsWith('test');
        const fnId = `${currentClassId}${fnName}().`;
        nodes.push({
          id: fnId,
          kind: isTest ? 'TestCase' : currentClassId === fileId ? 'Function' : 'Method',
          name: fnName,
          qualifiedName: currentClassName ? `${currentClassName}::${fnName}` : fnName,
          filePath: relPath,
          language: 'php',
          startLine: lineNo,
          endLine,
          signature: `function ${fnName}(${params})${retType ? `: ${retType}` : ''}`,
          returnType: retType,
          exported: !trimmed.startsWith('private'),
        });
        edges.push({
          sourceId: currentClassId,
          targetId: fnId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });

        for (const attr of pendingAttrs) {
          const sRoute = PHP_SYMFONY_ROUTE_RE.exec(attr);
          if (sRoute) {
            const routePath = sRoute[1];
            const verb = (sRoute[2] ?? 'GET').toUpperCase();
            const routeId = `route:${verb}:${routePath}`;
            nodes.push({
              id: routeId,
              kind: 'RouteEndpoint',
              name: `${verb} ${routePath}`,
              qualifiedName: `${verb} ${routePath}`,
              filePath: relPath,
              language: 'php',
              startLine: lineNo,
              endLine: lineNo,
              signature: `${verb} ${routePath}`,
              exported: true,
            });
            edges.push({
              sourceId: fnId,
              targetId: routeId,
              kind: 'HANDLES_ROUTE',
              filePath: relPath,
              line: lineNo,
              confidence: 1.0,
              evidence: attr,
            });
          }
        }
        pendingAttrs = [];
      } else {
        pendingAttrs = [];
      }
    }

    return { nodes, edges };
  }

  // ============================================================================
  // 7. C / C++ (.c, .cc, .cpp, .cxx, .h, .hpp, .hxx)
  // ============================================================================
  private parseCpp(
    relPath: string,
    content: string
  ): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];
    const lines = content.split(/\r?\n/);
    const isTestFile = relPath.includes('test') || relPath.endsWith('_test.cc') || relPath.endsWith('_test.cpp');
    const { fileId, node: fileNode } = this.createFileNode(relPath, 'cpp', lines.length || 1, isTestFile);
    nodes.push(fileNode);

    const CPP_INCLUDE_RE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/;
    const CPP_NAMESPACE_RE = /^\s*namespace\s+([A-Za-z_][\w:]*)\s*\{/;
    const CPP_CLASS_RE =
      /^\s*(?:template\s*<[^>]*>\s*)?(class|struct)\s+(?:[A-Z_]+\s+)?([A-Za-z_]\w*)(?:\s+final)?(?:\s*:\s*([^{;]+))?\s*\{/;
    const CPP_ENUM_RE = /^\s*enum(?:\s+class|\s+struct)?\s+([A-Za-z_]\w*)(?:\s*:\s*[A-Za-z_]\w*)?\s*\{/;
    const CPP_GTEST_RE = /^\s*TEST(?:_F|_P)?\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)/;
    const CPP_FN_RE =
      /^\s*(?:template\s*<[^>]*>\s*)?(?:inline\s+|static\s+|virtual\s+|explicit\s+|constexpr\s+|extern\s+)*([A-Za-z_][\w:<>*&\s]*?)\s+([A-Za-z_~][\w:]*)\s*\(([^;{}]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:\{|;)/;

    const CPP_KEYWORDS = new Set([
      'if',
      'for',
      'while',
      'switch',
      'catch',
      'return',
      'sizeof',
      'alignof',
      'delete',
      'new',
    ]);

    let currentContainerId = fileId;

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      const incMatch = CPP_INCLUDE_RE.exec(line);
      if (incMatch) {
        edges.push({
          sourceId: fileId,
          targetId: `cpp:include:${incMatch[1]}`,
          kind: 'IMPORTS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
        continue;
      }

      const nsMatch = CPP_NAMESPACE_RE.exec(line);
      if (nsMatch) {
        const nsName = nsMatch[1];
        const endLine = findMatchingEndLineBrace(lines, i, 'cpp');
        const nsId = `${fileId}ns:${nsName}#`;
        nodes.push({
          id: nsId,
          kind: 'Namespace',
          name: nsName,
          qualifiedName: nsName,
          filePath: relPath,
          language: 'cpp',
          startLine: lineNo,
          endLine,
          signature: `namespace ${nsName}`,
          exported: true,
        });
        edges.push({
          sourceId: fileId,
          targetId: nsId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        continue;
      }

      const clsMatch = CPP_CLASS_RE.exec(line);
      if (clsMatch) {
        const kw = clsMatch[1];
        const clsName = clsMatch[2];
        const bases = clsMatch[3]?.trim();
        const endLine = findMatchingEndLineBrace(lines, i, 'cpp');
        const clsId = `${fileId}${clsName}#`;
        currentContainerId = clsId;
        nodes.push({
          id: clsId,
          kind: 'Class',
          name: clsName,
          qualifiedName: `${relPath}:${clsName}`,
          filePath: relPath,
          language: 'cpp',
          startLine: lineNo,
          endLine,
          signature: `${kw} ${clsName}`,
          exported: true,
        });
        edges.push({
          sourceId: fileId,
          targetId: clsId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        if (bases) {
          for (const b of splitTopLevelGenericCommas(bases)) {
            const cleanBase = stripGenericsAndArgs(b.replace(/\b(?:public|protected|private|virtual)\b/g, ''));
            if (cleanBase) {
              edges.push({
                sourceId: clsId,
                targetId: `${fileId}${cleanBase}#`,
                kind: 'EXTENDS',
                filePath: relPath,
                line: lineNo,
                confidence: 0.9,
              });
            }
          }
        }
        continue;
      }

      const enumMatch = CPP_ENUM_RE.exec(line);
      if (enumMatch) {
        const enumName = enumMatch[1];
        const endLine = findMatchingEndLineBrace(lines, i, 'cpp');
        const enumId = `${fileId}${enumName}#`;
        nodes.push({
          id: enumId,
          kind: 'Enum',
          name: enumName,
          qualifiedName: `${relPath}:${enumName}`,
          filePath: relPath,
          language: 'cpp',
          startLine: lineNo,
          endLine,
          signature: `enum ${enumName}`,
          exported: true,
        });
        edges.push({
          sourceId: fileId,
          targetId: enumId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        continue;
      }

      const gtestMatch = CPP_GTEST_RE.exec(line);
      if (gtestMatch) {
        const suiteName = gtestMatch[1];
        const testName = gtestMatch[2];
        const endLine = findMatchingEndLineBrace(lines, i, 'cpp');
        const testId = `${fileId}${suiteName}.${testName}().`;
        nodes.push({
          id: testId,
          kind: 'TestCase',
          name: `${suiteName}.${testName}`,
          qualifiedName: `${suiteName}.${testName}`,
          filePath: relPath,
          language: 'cpp',
          startLine: lineNo,
          endLine,
          signature: `TEST(${suiteName}, ${testName})`,
          exported: false,
        });
        edges.push({
          sourceId: fileId,
          targetId: testId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        continue;
      }

      const fnMatch = CPP_FN_RE.exec(line);
      if (fnMatch) {
        const retType = fnMatch[1].trim();
        const rawName = fnMatch[2].trim();
        const params = fnMatch[3].trim();
        const shortName = rawName.includes('::') ? rawName.slice(rawName.lastIndexOf('::') + 2) : rawName;
        if (!CPP_KEYWORDS.has(shortName) && !CPP_KEYWORDS.has(retType)) {
          const endLine = findMatchingEndLineBrace(lines, i, 'cpp');
          const isMethod = rawName.includes('::') || currentContainerId !== fileId;
          const fnId = `${currentContainerId}${shortName}().`;
          nodes.push({
            id: fnId,
            kind: isMethod ? 'Method' : 'Function',
            name: shortName,
            qualifiedName: rawName,
            filePath: relPath,
            language: 'cpp',
            startLine: lineNo,
            endLine,
            signature: `${retType} ${rawName}(${params})`,
            returnType: retType,
            exported: true,
          });
          edges.push({
            sourceId: currentContainerId,
            targetId: fnId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: lineNo,
            confidence: 1.0,
          });
        }
      }
    }

    return { nodes, edges };
  }

  // ============================================================================
  // 8. SWIFT (.swift)
  // ============================================================================
  private parseSwift(
    relPath: string,
    content: string
  ): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];
    const lines = content.split(/\r?\n/);
    const isTestFile = relPath.endsWith('Tests.swift') || relPath.endsWith('Test.swift');
    const { fileId, node: fileNode } = this.createFileNode(relPath, 'swift', lines.length || 1, isTestFile);
    nodes.push(fileNode);

    const SWIFT_IMPORT_RE = /^\s*import\s+(?:struct\s+|class\s+|enum\s+|protocol\s+|func\s+)?([A-Za-z_][\w.]*)/;
    const SWIFT_TYPE_RE =
      /^\s*(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+|final\s+)*(class|struct|enum|actor|protocol|extension)\s+([A-Za-z_]\w*)(?:<[^>]*>)?(?:\s*:\s*([^{where]+))?/;
    const SWIFT_FUNC_RE =
      /^\s*(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+|static\s+|class\s+|override\s+|mutating\s+)*func\s+([A-Za-z_]\w*)(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*(?:async|throws|rethrows))*\s*(?:->\s*([^{]+))?/;

    let currentTypeId = fileId;
    let currentTypeName = '';
    let pendingAttrs: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      if (trimmed.startsWith('@')) {
        pendingAttrs.push(trimmed);
      }

      const impMatch = SWIFT_IMPORT_RE.exec(line);
      if (impMatch) {
        edges.push({
          sourceId: fileId,
          targetId: `swift:import:${impMatch[1]}`,
          kind: 'IMPORTS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
        continue;
      }

      const typeMatch = SWIFT_TYPE_RE.exec(line);
      if (typeMatch) {
        const kw = typeMatch[1];
        const typeName = typeMatch[2];
        const supers = typeMatch[3]?.trim();
        const endLine = findMatchingEndLineBrace(lines, i, 'swift');
        const kind: NodeKind =
          kw === 'protocol' ? 'Interface' : kw === 'enum' ? 'Enum' : 'Class';
        const typeId = `${fileId}${typeName}#`;
        currentTypeId = typeId;
        currentTypeName = typeName;

        if (kw !== 'extension') {
          nodes.push({
            id: typeId,
            kind,
            name: typeName,
            qualifiedName: `${relPath}:${typeName}`,
            filePath: relPath,
            language: 'swift',
            startLine: lineNo,
            endLine,
            signature: `${kw} ${typeName}`,
            exported: !trimmed.startsWith('private'),
          });
          edges.push({
            sourceId: fileId,
            targetId: typeId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: lineNo,
            confidence: 1.0,
          });
        }

        if (supers) {
          for (const s of splitTopLevelGenericCommas(supers)) {
            const clean = stripGenericsAndArgs(s);
            if (clean) {
              edges.push({
                sourceId: typeId,
                targetId: `${fileId}${clean}#`,
                kind: kw === 'class' ? 'EXTENDS' : 'IMPLEMENTS',
                filePath: relPath,
                line: lineNo,
                confidence: 0.9,
              });
            }
          }
        }
        pendingAttrs = [];
        continue;
      }

      const fnMatch = SWIFT_FUNC_RE.exec(line);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const params = fnMatch[2].trim();
        const retType = fnMatch[3]?.trim();
        const endLine = findMatchingEndLineBrace(lines, i, 'swift');
        const isTest =
          (isTestFile && fnName.startsWith('test')) ||
          pendingAttrs.some((a) => /^@Test\b/.test(a));
        const fnId = `${currentTypeId}${fnName}().`;
        nodes.push({
          id: fnId,
          kind: isTest ? 'TestCase' : currentTypeId === fileId ? 'Function' : 'Method',
          name: fnName,
          qualifiedName: currentTypeName ? `${currentTypeName}.${fnName}` : fnName,
          filePath: relPath,
          language: 'swift',
          startLine: lineNo,
          endLine,
          signature: `func ${fnName}(${params})${retType ? ` -> ${retType}` : ''}`,
          returnType: retType,
          exported: !trimmed.startsWith('private'),
        });
        edges.push({
          sourceId: currentTypeId,
          targetId: fnId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        pendingAttrs = [];
      }
    }

    return { nodes, edges };
  }

  // ============================================================================
  // 9. ZIG (.zig)
  // ============================================================================
  private parseZig(
    relPath: string,
    content: string
  ): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];
    const lines = content.split(/\r?\n/);
    const { fileId, node: fileNode } = this.createFileNode(relPath, 'zig', lines.length || 1, false);
    nodes.push(fileNode);

    const ZIG_IMPORT_RE = /@import\(\s*"([^"]+)"\s*\)/g;
    const ZIG_CONTAINER_RE =
      /^\s*(?:pub\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(?:packed\s+|extern\s+)?(struct|enum|union|error)\b/;
    const ZIG_FN_RE =
      /^\s*(?:pub\s+)?(?:export\s+|inline\s+|noinline\s+)*fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*([^{;]*)/;
    const ZIG_TEST_RE = /^\s*test\s+"([^"]+)"\s*\{/;

    let currentContainerId = fileId;
    let currentContainerName = '';

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      ZIG_IMPORT_RE.lastIndex = 0;
      let impMatch: RegExpExecArray | null;
      while ((impMatch = ZIG_IMPORT_RE.exec(line)) !== null) {
        edges.push({
          sourceId: fileId,
          targetId: `zig:import:${impMatch[1]}`,
          kind: 'IMPORTS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
      }

      const cMatch = ZIG_CONTAINER_RE.exec(line);
      if (cMatch) {
        const cName = cMatch[1];
        const kw = cMatch[2];
        const endLine = findMatchingEndLineBrace(lines, i, 'zig');
        const kind: NodeKind = kw === 'enum' || kw === 'error' ? 'Enum' : 'Class';
        const cId = `${fileId}${cName}#`;
        currentContainerId = cId;
        currentContainerName = cName;
        nodes.push({
          id: cId,
          kind,
          name: cName,
          qualifiedName: `${relPath}:${cName}`,
          filePath: relPath,
          language: 'zig',
          startLine: lineNo,
          endLine,
          signature: `const ${cName} = ${kw}`,
          exported: trimmed.startsWith('pub'),
        });
        edges.push({
          sourceId: fileId,
          targetId: cId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        continue;
      }

      const fnMatch = ZIG_FN_RE.exec(line);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const params = fnMatch[2].trim();
        const retType = fnMatch[3]?.trim();
        const endLine = findMatchingEndLineBrace(lines, i, 'zig');
        const fnId = `${currentContainerId}${fnName}().`;
        nodes.push({
          id: fnId,
          kind: currentContainerId === fileId ? 'Function' : 'Method',
          name: fnName,
          qualifiedName: currentContainerName ? `${currentContainerName}.${fnName}` : fnName,
          filePath: relPath,
          language: 'zig',
          startLine: lineNo,
          endLine,
          signature: `fn ${fnName}(${params}) ${retType}`,
          returnType: retType,
          exported: trimmed.startsWith('pub'),
        });
        edges.push({
          sourceId: currentContainerId,
          targetId: fnId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
        continue;
      }

      const testMatch = ZIG_TEST_RE.exec(line);
      if (testMatch) {
        const testName = testMatch[1];
        const endLine = findMatchingEndLineBrace(lines, i, 'zig');
        const testId = `${fileId}test:${testName}.`;
        nodes.push({
          id: testId,
          kind: 'TestCase',
          name: testName,
          qualifiedName: `${relPath}:test "${testName}"`,
          filePath: relPath,
          language: 'zig',
          startLine: lineNo,
          endLine,
          signature: `test "${testName}"`,
          exported: false,
        });
        edges.push({
          sourceId: fileId,
          targetId: testId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
      }
    }

    return { nodes, edges };
  }

  // ============================================================================
  // 10. WEBASSEMBLY (.wat, .wit, .wasm)
  // ============================================================================
  private parseWasm(
    relPath: string,
    content: string
  ): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];
    const lines = content.split(/\r?\n/);
    const { fileId, node: fileNode } = this.createFileNode(relPath, 'wasm', lines.length || 1, false);
    nodes.push(fileNode);

    if (relPath.endsWith('.wit')) {
      const WIT_BLOCK_RE = /^\s*(interface|world|record|resource)\s+([A-Za-z_][\w-]*)\s*\{/;
      const WIT_FUNC_RE = /^\s*([A-Za-z_][\w-]*)\s*:\s*func\s*\(([^)]*)\)(?:\s*->\s*(.+))?/;
      let currentBlockId = fileId;

      for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        const line = lines[i];
        const bMatch = WIT_BLOCK_RE.exec(line);
        if (bMatch) {
          const kw = bMatch[1];
          const bName = bMatch[2];
          const endLine = findMatchingEndLineBrace(lines, i, 'wasm');
          const bId = `${fileId}${bName}#`;
          currentBlockId = bId;
          nodes.push({
            id: bId,
            kind: kw === 'record' || kw === 'resource' ? 'Class' : 'Interface',
            name: bName,
            qualifiedName: `${relPath}:${bName}`,
            filePath: relPath,
            language: 'wasm',
            startLine: lineNo,
            endLine,
            signature: `${kw} ${bName}`,
            exported: true,
          });
          edges.push({
            sourceId: fileId,
            targetId: bId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: lineNo,
            confidence: 1.0,
          });
          continue;
        }

        const fMatch = WIT_FUNC_RE.exec(line.replace(/\/\/.*$/, ''));
        if (fMatch) {
          const fName = fMatch[1];
          const fParams = fMatch[2].trim();
          const fRet = fMatch[3]?.trim();
          const fId = `${currentBlockId}${fName}().`;
          nodes.push({
            id: fId,
            kind: 'Function',
            name: fName,
            qualifiedName: `${relPath}:${fName}`,
            filePath: relPath,
            language: 'wasm',
            startLine: lineNo,
            endLine: lineNo,
            signature: `${fName}: func(${fParams})${fRet ? ` -> ${fRet}` : ''}`,
            returnType: fRet,
            exported: true,
          });
          edges.push({
            sourceId: currentBlockId,
            targetId: fId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: lineNo,
            confidence: 1.0,
          });
        }
      }
      return { nodes, edges };
    }

    // WAT (.wat)
    const WAT_FUNC_RE = /\(\s*func\s+(?:\$([A-Za-z0-9_.$+-]+)\s+)?(?:\(\s*export\s+"([^"]+)"\s*\))?/;
    const WAT_IMPORT_RE = /\(\s*import\s+"([^"]+)"\s+"([^"]+)"/;

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];

      const impMatch = WAT_IMPORT_RE.exec(line);
      if (impMatch) {
        edges.push({
          sourceId: fileId,
          targetId: `wasm:import:${impMatch[1]}.${impMatch[2]}`,
          kind: 'IMPORTS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.95,
        });
      }

      const fnMatch = WAT_FUNC_RE.exec(line);
      if (fnMatch && (fnMatch[1] || fnMatch[2])) {
        const fnName = fnMatch[2] || fnMatch[1];
        const fnId = `${fileId}${fnName}().`;
        nodes.push({
          id: fnId,
          kind: 'Function',
          name: fnName,
          qualifiedName: `${relPath}:${fnName}`,
          filePath: relPath,
          language: 'wasm',
          startLine: lineNo,
          endLine: lineNo,
          signature: `(func $${fnName})`,
          exported: Boolean(fnMatch[2]),
        });
        edges.push({
          sourceId: fileId,
          targetId: fnId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
      }
    }

    return { nodes, edges };
  }
}
