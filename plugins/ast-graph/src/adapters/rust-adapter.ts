import * as crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CompilerAdapter, CompilerGraphBatch, EdgeKind, GraphEdgeRecord, GraphFileRecord, GraphNodeRecord, NodeKind } from '../types.js';

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', 'target', 'vendor']);

interface RawRustNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  signature: string;
  returnType?: string;
  exported: boolean;
}

interface RawRustEdge {
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

interface RustBlockSpan {
  header: string;
  body: string;
  startLine: number;
  endLine: number;
  attrs: string[];
}

const RUST_USE_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/;
const RUST_MOD_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*(?:;|\{)/;
const RUST_STRUCT_RE =
  /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?\s*(?:where[^{;]+)?(?:\{([\s\S]*)\}|\(([\s\S]*)\)\s*;|\s*;)/;
const RUST_ENUM_RE =
  /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?\s*(?:where[^{]+)?\{([\s\S]*)\}/;
const RUST_TRAIT_RE =
  /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?(?:\s*:\s*([^{]+))?\s*\{([\s\S]*)\}/;
const RUST_IMPL_RE =
  /^(?:unsafe\s+)?impl(?:\s*<[^>]*>)?\s+(?:([A-Za-z_][\w:<>]*)\s+for\s+)?([A-Za-z_][\w:<>]*)\s*(?:where[^{]+)?\{([\s\S]*)\}/;
const RUST_FN_RE =
  /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?fn\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^{;]+))?/;
const RUST_MACRO_RE = /^(?:pub(?:\([^)]*\))?\s+)?macro_rules!\s+([A-Za-z_]\w*)/;
const RUST_CONST_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)\s*:\s*([^=;]+)=/;
const RUST_TYPE_ALIAS_RE =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?\s*=\s*([^;]+);/;
const RUST_STRUCT_FIELD_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?([A-Za-z_]\w*)\s*:\s*(.+)$/;
const RUST_ACTIX_ROUTE_RE =
  /#\[(get|post|put|delete|patch|head|options)\s*\(\s*"([^"]+)"/i;
const RUST_AXUM_ROUTE_RE =
  /\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|delete|patch|head|options)\(\s*([A-Za-z_][\w:]*)/g;
const RUST_ENV_VAR_RE = /\b(?:std::)?env::var(?:_os)?\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g;
const RUST_SQLX_TABLE_RE =
  /\bsqlx::query(?:_as|_scalar)?!\s*\([\s\S]*?\b(?:FROM|INTO|UPDATE)\s+([A-Za-z_][\w.]*)/gi;
const RUST_FN_CALL_RE = /\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/g;

const RUST_CONTROL_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'loop',
  'match',
  'return',
  'Some',
  'None',
  'Ok',
  'Err',
  'Box',
  'Vec',
  'Arc',
  'Rc',
  'Mutex',
  'RwLock',
  'String',
]);

/**
 * Counts brace delta on a single line of Rust code, safely skipping:
 * - `//` line comments and block comments
 * - Standard `"..."` strings and raw strings (`r"..."`, `r#"..."#`)
 * - Character literals (`'x'`, `'\n'`) WITHOUT getting confused by lifetime annotations (`'a`, `'static`)
 */
export function countRustBracesLine(
  line: string,
  inBlockComment: boolean,
  rawStringHashes: number
): { delta: number; inBlockComment: boolean; rawStringHashes: number } {
  let delta = 0;
  let inString = false;
  let i = 0;

  while (i < line.length) {
    if (inBlockComment) {
      const endIdx = line.indexOf('*/', i);
      if (endIdx < 0) {
        return { delta, inBlockComment: true, rawStringHashes };
      }
      inBlockComment = false;
      i = endIdx + 2;
      continue;
    }

    if (rawStringHashes >= 0) {
      const closingPattern = '"' + '#'.repeat(rawStringHashes);
      const endIdx = line.indexOf(closingPattern, i);
      if (endIdx < 0) {
        return { delta, inBlockComment: false, rawStringHashes };
      }
      rawStringHashes = -1;
      i = endIdx + closingPattern.length;
      continue;
    }

    const ch = line[i];

    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '/' && i + 1 < line.length) {
      if (line[i + 1] === '/') {
        break;
      }
      if (line[i + 1] === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }
    }

    // Raw string literal: r"..." or r#"..."# or br#"..."#
    if ((ch === 'r' || (ch === 'b' && line[i + 1] === 'r')) && i + 1 < line.length) {
      let j = ch === 'b' ? i + 2 : i + 1;
      let hashes = 0;
      while (j < line.length && line[j] === '#') {
        hashes++;
        j++;
      }
      if (j < line.length && line[j] === '"') {
        rawStringHashes = hashes;
        i = j + 1;
        continue;
      }
    }

    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }

    // Character literal vs lifetime: `'x'` or `'\n'` vs `'a`
    if (ch === "'") {
      if (i + 2 < line.length && line[i + 1] !== '\\' && line[i + 2] === "'") {
        i += 3;
        continue;
      }
      if (i + 3 < line.length && line[i + 1] === '\\' && line[i + 3] === "'") {
        i += 4;
        continue;
      }
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

  return { delta, inBlockComment, rawStringHashes };
}

function scanRustBlocks(text: string, baseLineOffset = 1): RustBlockSpan[] {
  const lines = text.split(/\r?\n/);
  const blocks: RustBlockSpan[] = [];

  let i = 0;
  let inBlockComment = false;
  let rawStringHashes = -1;
  let pendingAttrs: string[] = [];

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!inBlockComment && rawStringHashes < 0) {
      if (!trimmed || trimmed.startsWith('//')) {
        i++;
        continue;
      }
      if (trimmed.startsWith('#[') || trimmed.startsWith('#![')) {
        pendingAttrs.push(trimmed);
        i++;
        continue;
      }
    }

    const startLine = baseLineOffset + i;
    const headerParts: string[] = [];
    let braceDepth = 0;
    let opened = false;
    const bodyLines: string[] = [];
    let endLine = startLine;

    while (i < lines.length) {
      const line = lines[i];
      const currentLineNo = baseLineOffset + i;
      const prevDepth = braceDepth;
      const step = countRustBracesLine(line, inBlockComment, rawStringHashes);
      inBlockComment = step.inBlockComment;
      rawStringHashes = step.rawStringHashes;
      braceDepth += step.delta;

      if (!opened) {
        headerParts.push(line.trim());
        // Semicolon statement before any `{` (e.g. unit struct, trait method decl, use/const/type)
        if (
          step.delta === 0 &&
          !inBlockComment &&
          rawStringHashes < 0 &&
          line.replace(/\/\/.*$/, '').trim().endsWith(';')
        ) {
          endLine = currentLineNo;
          i++;
          break;
        }
        if (braceDepth > 0) {
          opened = true;
          const openBraceIdx = line.indexOf('{');
          if (openBraceIdx >= 0 && openBraceIdx + 1 < line.length) {
            const after = line.slice(openBraceIdx + 1);
            if (braceDepth === 0) {
              const closeIdx = after.lastIndexOf('}');
              if (closeIdx > 0) bodyLines.push(after.slice(0, closeIdx));
            } else {
              bodyLines.push(after);
            }
          }
        } else if (step.delta === 0 && headerParts.length === 1 && !/^(?:pub|struct|enum|trait|impl|fn|async|unsafe|const|macro_rules)/.test(trimmed)) {
          endLine = currentLineNo;
          i++;
          break;
        }
      } else {
        if (braceDepth <= 0) {
          const closeIdx = line.lastIndexOf('}');
          if (closeIdx > 0) {
            bodyLines.push(line.slice(0, closeIdx));
          }
          endLine = currentLineNo;
          i++;
          break;
        } else {
          bodyLines.push(line);
        }
      }

      if (opened && braceDepth <= 0 && prevDepth > 0) {
        endLine = currentLineNo;
        i++;
        break;
      }
      endLine = currentLineNo;
      i++;
    }

    const fullText = [headerParts.join(' '), ...bodyLines, opened ? '}' : ''].join('\n').trim();
    blocks.push({
      header: fullText,
      body: bodyLines.join('\n'),
      startLine,
      endLine,
      attrs: pendingAttrs,
    });
    pendingAttrs = [];
  }

  return blocks;
}

function cleanRustTypeName(raw: string): string {
  const trimmed = raw.trim();
  const ltIdx = trimmed.indexOf('<');
  return (ltIdx >= 0 ? trimmed.slice(0, ltIdx) : trimmed).trim();
}

export class RustCompilerAdapter implements CompilerAdapter {
  public readonly name = 'scip-rust';
  public readonly languages = ['rust'] as const;

  public supportsFile(filePath: string): boolean {
    return filePath.toLowerCase().endsWith('.rs');
  }

  public discoverRustFiles(workspaceRoot: string): string[] {
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
      : this.discoverRustFiles(workspaceRoot);

    const fileRecords: GraphFileRecord[] = [];
    const rawNodes: RawRustNode[] = [];
    const rawEdges: RawRustEdge[] = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const stat = fs.statSync(filePath);
      const relPath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
      const lineCount = content.split(/\r?\n/).length || 1;

      fileRecords.push({
        filePath: relPath,
        packageName: 'rust',
        language: 'rust',
        sha256: sha256Hex(content),
        mtimeMs: Math.trunc(stat.mtimeMs),
        sizeBytes: stat.size,
        lineCount,
      });

      const fileParsed = this.parseRustFile(relPath, content);
      rawNodes.push(...fileParsed.nodes);
      rawEdges.push(...fileParsed.edges);
    }

    const nodes: GraphNodeRecord[] = rawNodes.map((n) => ({
      id: normalizeCrossLayerId(n.id),
      kind: n.kind,
      name: n.name,
      qualifiedName: n.qualifiedName,
      packageName: 'rust',
      filePath: n.filePath,
      language: 'rust',
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

    const edges: GraphEdgeRecord[] = rawEdges.map((e) => ({
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

  public parseRustFile(
    relPath: string,
    content: string
  ): { nodes: RawRustNode[]; edges: RawRustEdge[] } {
    const nodes: RawRustNode[] = [];
    const edges: RawRustEdge[] = [];
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length || 1;
    const isTestFile =
      relPath.startsWith('tests/') || relPath.includes('/tests/') || relPath.endsWith('_test.rs');

    const fileId = `scip-rs 💡 rust crate 0.1.0 ${relPath}/`;
    nodes.push({
      id: fileId,
      kind: isTestFile ? 'TestSuite' : 'File',
      name: path.basename(relPath),
      qualifiedName: relPath,
      filePath: relPath,
      language: 'rust',
      startLine: 1,
      endLine: totalLines,
      signature: relPath,
       exported: true,
    });

    // Scan single-line imports, mods, constants, type aliases, env vars, and sqlx queries
    for (let idx = 0; idx < lines.length; idx++) {
      const lineNo = idx + 1;
      const line = lines[idx];

      const useMatch = RUST_USE_RE.exec(line);
      if (useMatch) {
        const importPath = useMatch[1].trim();
        edges.push({
          sourceId: fileId,
          targetId: `rust:use:${importPath}`,
          kind: 'IMPORTS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.9,
          evidence: line.trim(),
        });
      }

      const modMatch = RUST_MOD_RE.exec(line);
      if (modMatch && line.trim().endsWith(';')) {
        const modName = modMatch[1];
        const modId = `${fileId}mod:${modName}.`;
        nodes.push({
          id: modId,
          kind: 'Namespace',
          name: modName,
          qualifiedName: `${relPath}::${modName}`,
          filePath: relPath,
          language: 'rust',
          startLine: lineNo,
          endLine: lineNo,
          signature: line.trim(),
          exported: line.trim().startsWith('pub'),
        });
        edges.push({
          sourceId: fileId,
          targetId: modId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
      }

      const constMatch = RUST_CONST_RE.exec(line);
      if (constMatch) {
        const constName = constMatch[1];
        const constType = constMatch[2].trim();
        const constId = `${fileId}${constName}.`;
        nodes.push({
          id: constId,
          kind: 'Variable',
          name: constName,
          qualifiedName: `${relPath}::${constName}`,
          filePath: relPath,
          language: 'rust',
          startLine: lineNo,
          endLine: lineNo,
          signature: `const ${constName}: ${constType}`,
          returnType: constType,
          exported: line.trim().startsWith('pub'),
        });
        edges.push({
          sourceId: fileId,
          targetId: constId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
      }

      const typeMatch = RUST_TYPE_ALIAS_RE.exec(line);
      if (typeMatch) {
        const aliasName = typeMatch[1];
        const aliasTarget = typeMatch[2].trim();
        const aliasId = `${fileId}${aliasName}#`;
        nodes.push({
          id: aliasId,
          kind: 'TypeAlias',
          name: aliasName,
          qualifiedName: `${relPath}::${aliasName}`,
          filePath: relPath,
          language: 'rust',
          startLine: lineNo,
          endLine: lineNo,
          signature: `type ${aliasName} = ${aliasTarget}`,
          returnType: aliasTarget,
          exported: line.trim().startsWith('pub'),
        });
        edges.push({
          sourceId: fileId,
          targetId: aliasId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
        });
      }

      RUST_ENV_VAR_RE.lastIndex = 0;
      let envMatch: RegExpExecArray | null;
      while ((envMatch = RUST_ENV_VAR_RE.exec(line)) !== null) {
        const envName = envMatch[1];
        const envId = `env:${envName}`;
        nodes.push({
          id: envId,
          kind: 'EnvVar',
          name: envName,
          qualifiedName: `env.${envName}`,
          filePath: relPath,
          language: 'rust',
          startLine: lineNo,
          endLine: lineNo,
          signature: `env ${envName}`,
          exported: true,
        });
        edges.push({
          sourceId: fileId,
          targetId: envId,
          kind: 'CONFIGURES_ENV',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
          evidence: envMatch[0],
        });
      }

      RUST_AXUM_ROUTE_RE.lastIndex = 0;
      let axumMatch: RegExpExecArray | null;
      while ((axumMatch = RUST_AXUM_ROUTE_RE.exec(line)) !== null) {
        const routePath = axumMatch[1];
        const httpMethod = axumMatch[2].toUpperCase();
        const handlerName = axumMatch[3];
        const routeId = `route:${httpMethod}:${routePath}`;
        nodes.push({
          id: routeId,
          kind: 'RouteEndpoint',
          name: `${httpMethod} ${routePath}`,
          qualifiedName: `${httpMethod} ${routePath}`,
          filePath: relPath,
          language: 'rust',
          startLine: lineNo,
          endLine: lineNo,
          signature: `${httpMethod} ${routePath}`,
          exported: true,
        });
        edges.push({
          sourceId: `${fileId}${handlerName}().`,
          targetId: routeId,
          kind: 'HANDLES_ROUTE',
          filePath: relPath,
          line: lineNo,
          confidence: 1.0,
          evidence: axumMatch[0],
        });
      }
    }

    // Scan sqlx queries across full content
    RUST_SQLX_TABLE_RE.lastIndex = 0;
    let sqlxMatch: RegExpExecArray | null;
    while ((sqlxMatch = RUST_SQLX_TABLE_RE.exec(content)) !== null) {
      const tableName = sqlxMatch[1];
      const matchLine = content.slice(0, sqlxMatch.index).split(/\r?\n/).length;
      edges.push({
        sourceId: fileId,
        targetId: `sql:table:${tableName}`,
        kind: 'REFERENCES',
        filePath: relPath,
        line: matchLine,
        confidence: 0.95,
        evidence: `sqlx query table ${tableName}`,
      });
    }

    // Scan top-level blocks
    const blocks = scanRustBlocks(content, 1);
    for (const block of blocks) {
      const header = block.header;

      // Struct
      const structMatch = RUST_STRUCT_RE.exec(header);
      if (structMatch) {
        const structName = structMatch[1];
        const structBody = block.body;
        const structId = `${fileId}${structName}#`;
        const isExported = header.trim().startsWith('pub');

        nodes.push({
          id: structId,
          kind: 'Class',
          name: structName,
          qualifiedName: `${relPath}::${structName}`,
          filePath: relPath,
          language: 'rust',
          startLine: block.startLine,
          endLine: block.endLine,
          signature: `struct ${structName}`,
          exported: isExported,
        });
        edges.push({
          sourceId: fileId,
          targetId: structId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: block.startLine,
          confidence: 1.0,
        });

        const bodyLines = structBody.split(/\r?\n/);
        for (let fIdx = 0; fIdx < bodyLines.length; fIdx++) {
          const fLine = bodyLines[fIdx].replace(/\/\/.*$/, '').replace(/,\s*$/, '').trim();
          if (!fLine || fLine.startsWith('#[')) continue;
          const fieldMatch = RUST_STRUCT_FIELD_RE.exec(fLine);
          if (fieldMatch) {
            const fieldName = fieldMatch[1];
            const fieldType = fieldMatch[2].trim();
            const fieldLineNo = Math.min(block.endLine, block.startLine + fIdx + 1);
            const fieldId = `${structId}${fieldName}.`;
            nodes.push({
              id: fieldId,
              kind: 'Property',
              name: fieldName,
              qualifiedName: `${structName}.${fieldName}`,
              filePath: relPath,
              language: 'rust',
              startLine: fieldLineNo,
              endLine: fieldLineNo,
              signature: `${fieldName}: ${fieldType}`,
              returnType: fieldType,
              exported: fLine.startsWith('pub'),
            });
            edges.push({
              sourceId: structId,
              targetId: fieldId,
              kind: 'CONTAINS',
              filePath: relPath,
              line: fieldLineNo,
              confidence: 1.0,
            });
          }
        }
        continue;
      }

      // Enum
      const enumMatch = RUST_ENUM_RE.exec(header);
      if (enumMatch) {
        const enumName = enumMatch[1];
        const enumId = `${fileId}${enumName}#`;
        nodes.push({
          id: enumId,
          kind: 'Enum',
          name: enumName,
          qualifiedName: `${relPath}::${enumName}`,
          filePath: relPath,
          language: 'rust',
          startLine: block.startLine,
          endLine: block.endLine,
          signature: `enum ${enumName}`,
          exported: header.trim().startsWith('pub'),
        });
        edges.push({
          sourceId: fileId,
          targetId: enumId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: block.startLine,
          confidence: 1.0,
        });
        continue;
      }

      // Trait
      const traitMatch = RUST_TRAIT_RE.exec(header);
      if (traitMatch) {
        const traitName = traitMatch[1];
        const superTraits = traitMatch[2]?.trim();
        const traitBody = block.body;
        const traitId = `${fileId}${traitName}#`;

        nodes.push({
          id: traitId,
          kind: 'Interface',
          name: traitName,
          qualifiedName: `${relPath}::${traitName}`,
          filePath: relPath,
          language: 'rust',
          startLine: block.startLine,
          endLine: block.endLine,
          signature: superTraits ? `trait ${traitName}: ${superTraits}` : `trait ${traitName}`,
          exported: header.trim().startsWith('pub'),
        });
        edges.push({
          sourceId: fileId,
          targetId: traitId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: block.startLine,
          confidence: 1.0,
        });

        const innerBlocks = scanRustBlocks(traitBody, block.startLine + 1);
        for (const inner of innerBlocks) {
          const fnMatch = RUST_FN_RE.exec(inner.header);
          if (fnMatch) {
            const mName = fnMatch[1];
            const mParams = fnMatch[2].trim();
            const mRet = fnMatch[3]?.trim();
            const methodId = `${traitId}${mName}().`;
            nodes.push({
              id: methodId,
              kind: 'Method',
              name: mName,
              qualifiedName: `${traitName}::${mName}`,
              filePath: relPath,
              language: 'rust',
              startLine: inner.startLine,
              endLine: inner.endLine,
              signature: `fn ${mName}(${mParams})${mRet ? ` -> ${mRet}` : ''}`,
              returnType: mRet,
              exported: true,
            });
            edges.push({
              sourceId: traitId,
              targetId: methodId,
              kind: 'CONTAINS',
              filePath: relPath,
              line: inner.startLine,
              confidence: 1.0,
            });
          }
        }
        continue;
      }

      // Impl block
      const implMatch = RUST_IMPL_RE.exec(header);
      if (implMatch) {
        const traitRaw = implMatch[1] ? cleanRustTypeName(implMatch[1]) : undefined;
        const targetType = cleanRustTypeName(implMatch[2]);
        const implBody = block.body;
        const ownerId = `${fileId}${targetType}#`;

        if (traitRaw) {
          edges.push({
            sourceId: ownerId,
            targetId: `${fileId}${traitRaw}#`,
            kind: 'IMPLEMENTS',
            filePath: relPath,
            line: block.startLine,
            confidence: 0.95,
            evidence: `impl ${traitRaw} for ${targetType}`,
          });
        }

        const innerBlocks = scanRustBlocks(implBody, block.startLine + 1);
        for (const inner of innerBlocks) {
          const fnMatch = RUST_FN_RE.exec(inner.header);
          if (fnMatch) {
            const mName = fnMatch[1];
            const mParams = fnMatch[2].trim();
            const mRet = fnMatch[3]?.trim();
            const methodId = `${ownerId}${mName}().`;
            nodes.push({
              id: methodId,
              kind: 'Method',
              name: mName,
              qualifiedName: `${targetType}::${mName}`,
              filePath: relPath,
              language: 'rust',
              startLine: inner.startLine,
              endLine: inner.endLine,
              signature: `fn ${mName}(${mParams})${mRet ? ` -> ${mRet}` : ''}`,
              returnType: mRet,
              exported: inner.header.trim().startsWith('pub') || Boolean(traitRaw),
            });
            edges.push({
              sourceId: ownerId,
              targetId: methodId,
              kind: 'CONTAINS',
              filePath: relPath,
              line: inner.startLine,
              confidence: 1.0,
            });

            this.extractFnCalls(inner.body, methodId, fileId, relPath, inner.startLine, edges);
          }
        }
        continue;
      }

      // Macro rules
      const macroMatch = RUST_MACRO_RE.exec(header);
      if (macroMatch) {
        const macroName = macroMatch[1];
        const macroId = `${fileId}${macroName}!`;
        nodes.push({
          id: macroId,
          kind: 'Function',
          name: `${macroName}!`,
          qualifiedName: `${relPath}::${macroName}!`,
          filePath: relPath,
          language: 'rust',
          startLine: block.startLine,
          endLine: block.endLine,
          signature: `macro_rules! ${macroName}`,
          exported: true,
        });
        edges.push({
          sourceId: fileId,
          targetId: macroId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: block.startLine,
          confidence: 1.0,
        });
        continue;
      }

      // Top-level Function or Test
      const fnMatch = RUST_FN_RE.exec(header);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const fnParams = fnMatch[2].trim();
        const fnRet = fnMatch[3]?.trim();
        const isTest =
          isTestFile ||
          fnName.startsWith('test_') ||
          block.attrs.some((a) => /^#\[(?:\w+::)?test\b/.test(a));
        const fnId = `${fileId}${fnName}().`;

        nodes.push({
          id: fnId,
          kind: isTest ? 'TestCase' : 'Function',
          name: fnName,
          qualifiedName: `${relPath}::${fnName}`,
          filePath: relPath,
          language: 'rust',
          startLine: block.startLine,
          endLine: block.endLine,
          signature: `fn ${fnName}(${fnParams})${fnRet ? ` -> ${fnRet}` : ''}`,
          returnType: fnRet,
          exported: header.trim().startsWith('pub'),
        });
        edges.push({
          sourceId: fileId,
          targetId: fnId,
          kind: 'CONTAINS',
          filePath: relPath,
          line: block.startLine,
          confidence: 1.0,
        });

        // Actix / Rocket route attribute
        for (const attr of block.attrs) {
          const routeMatch = RUST_ACTIX_ROUTE_RE.exec(attr);
          if (routeMatch) {
            const httpMethod = routeMatch[1].toUpperCase();
            const routePath = routeMatch[2];
            const routeId = `route:${httpMethod}:${routePath}`;
            nodes.push({
              id: routeId,
              kind: 'RouteEndpoint',
              name: `${httpMethod} ${routePath}`,
              qualifiedName: `${httpMethod} ${routePath}`,
              filePath: relPath,
              language: 'rust',
              startLine: block.startLine,
              endLine: block.startLine,
              signature: `${httpMethod} ${routePath}`,
              exported: true,
            });
            edges.push({
              sourceId: fnId,
              targetId: routeId,
              kind: 'HANDLES_ROUTE',
              filePath: relPath,
              line: block.startLine,
              confidence: 1.0,
              evidence: attr,
            });
          }
        }

        this.extractFnCalls(block.body, fnId, fileId, relPath, block.startLine, edges, isTest);
      }
    }

    return { nodes, edges };
  }

  private extractFnCalls(
    body: string,
    callerId: string,
    fileId: string,
    relPath: string,
    baseLine: number,
    edges: RawRustEdge[],
    isTest = false
  ): void {
    const bodyLines = body.split(/\r?\n/);
    for (let idx = 0; idx < bodyLines.length; idx++) {
      const line = bodyLines[idx];
      const lineNo = baseLine + idx;
      RUST_FN_CALL_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = RUST_FN_CALL_RE.exec(line)) !== null) {
        const calleeRaw = match[1];
        const shortName = calleeRaw.includes('::')
          ? calleeRaw.slice(calleeRaw.lastIndexOf('::') + 2)
          : calleeRaw;
        if (RUST_CONTROL_KEYWORDS.has(shortName) || shortName.length <= 1) continue;

        const targetId = `${fileId}${shortName}().`;
        edges.push({
          sourceId: callerId,
          targetId,
          kind: isTest ? 'TESTS_SYMBOL' : 'CALLS',
          filePath: relPath,
          line: lineNo,
          confidence: 0.85,
          evidence: `${calleeRaw}(...)`,
        });
      }
    }
  }
}
