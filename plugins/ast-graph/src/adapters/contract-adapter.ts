import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CompilerAdapter, CompilerGraphBatch, EdgeKind, GraphEdgeRecord, GraphFileRecord, GraphNodeRecord, NodeKind } from '../types.js';

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

interface RawContractNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  packageName: string;
  filePath: string;
  language?: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  signature: string;
  docComment: string | null;
  exported: boolean;
  complexity: number;
  contentHash?: string;
}

interface RawContractEdge {
  srcId: string;
  dstId: string;
  kind: EdgeKind;
  filePath: string;
  line: number;
  contextText: string;
  confidence: number;
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', 'target', 'vendor']);

interface GqlToken {
  kind: 'NAME' | 'STRING' | 'PUNCT' | 'DIRECTIVE';
  val: string;
  line: number;
}

export class ContractCompilerAdapter implements CompilerAdapter {
  public readonly name = 'scip-contracts';
  public readonly languages = ['protobuf', 'graphql'] as const;
  public supportsFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (
      lower.endsWith('.proto') ||
      lower.endsWith('.graphql') ||
      lower.endsWith('.gql')
    );
  }

  public discoverContractFiles(workspaceRoot: string): string[] {
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

  /**
   * Replaces /* ... *\/ block comments with spaces while preserving exact '\n' line numbers.
   */
  private stripProtoBlockComments(src: string): string {
    const out: string[] = [];
    let inString: string | null = null;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < src.length; i++) {
      const ch = src[i]!;
      if (inLineComment) {
        out.push(ch);
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && i + 1 < src.length && src[i + 1] === '/') {
          inBlockComment = false;
          i++;
          out.push(' ', ' ');
        } else if (ch === '\n') {
          out.push('\n');
        } else {
          out.push(' ');
        }
        continue;
      }
      if (inString !== null) {
        out.push(ch);
        if (ch === '\\' && i + 1 < src.length) {
          i++;
          out.push(src[i]!);
          continue;
        }
        if (ch === inString) {
          inString = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        out.push(ch);
        continue;
      }
      if (ch === '/' && i + 1 < src.length) {
        if (src[i + 1] === '/') {
          inLineComment = true;
          out.push(ch);
          continue;
        }
        if (src[i + 1] === '*') {
          inBlockComment = true;
          i++;
          out.push(' ', ' ');
          continue;
        }
      }
      out.push(ch);
    }
    return out.join('');
  }

  private countProtoBraces(line: string): { delta: number; sawOpen: boolean } {
    let delta = 0;
    let sawOpen = false;
    let inString: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inString !== null) {
        if (ch === '\\' && i + 1 < line.length) {
          i++;
          continue;
        }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }
      if (ch === '/' && i + 1 < line.length && line[i + 1] === '/') break;
      if (ch === '{') {
        delta++;
        sawOpen = true;
      } else if (ch === '}') {
        delta--;
      }
    }
    return { delta, sawOpen };
  }

  private findProtoBlockEnd(lines: string[], startIdx: number): number {
    let depth = 0;
    let sawOpen = false;
    for (let i = startIdx; i < lines.length; i++) {
      const res = this.countProtoBraces(lines[i] ?? '');
      if (res.sawOpen) sawOpen = true;
      depth += res.delta;
      if (sawOpen && depth <= 0) {
        return i;
      }
    }
    return lines.length - 1;
  }

  private tokenizeGraphQL(src: string): GqlToken[] {
    const tokens: GqlToken[] = [];
    const lines = src.split('\n');
    let inBlockString = false;
    let blockStringBuf: string[] = [];

    const isIdentStart = (c: string) => /^[A-Za-z_]$/.test(c);
    const isIdentChar = (c: string) => /^[A-Za-z0-9_-]$/.test(c);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineNum = lineIdx + 1;
      let line = lines[lineIdx] ?? '';
      let trimmed = line.trim();

      if (inBlockString) {
        const endIdx = line.indexOf('"""');
        if (endIdx >= 0) {
          blockStringBuf.push(line.slice(0, endIdx));
          tokens.push({
            kind: 'STRING',
            val: blockStringBuf.join('\n').trim(),
            line: lineNum,
          });
          blockStringBuf = [];
          inBlockString = false;
          line = line.slice(endIdx + 3);
          trimmed = line.trim();
          if (!trimmed) continue;
        } else {
          blockStringBuf.push(line);
          continue;
        }
      }

      if (trimmed.startsWith('"""')) {
        const rest = trimmed.slice(3);
        const endIdx = rest.indexOf('"""');
        if (endIdx >= 0) {
          tokens.push({
            kind: 'STRING',
            val: rest.slice(0, endIdx).trim(),
            line: lineNum,
          });
          line = rest.slice(endIdx + 3);
        } else {
          inBlockString = true;
          blockStringBuf.push(rest);
          continue;
        }
      }

      if (trimmed.startsWith('#')) continue;

      let i = 0;
      while (i < line.length) {
        const ch = line[i]!;
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',') {
          i++;
          continue;
        }
        if (ch === '#') break;

        if (ch === '"') {
          let end = i + 1;
          while (end < line.length && line[end] !== '"') {
            if (line[end] === '\\' && end + 1 < line.length) end += 2;
            else end++;
          }
          const strVal = line.slice(i + 1, end);
          i = end < line.length ? end + 1 : line.length;
          tokens.push({ kind: 'STRING', val: strVal, line: lineNum });
          continue;
        }

        if (ch === '@') {
          let end = i + 1;
          while (end < line.length && (isIdentChar(line[end]!) || line[end] === '.')) {
            end++;
          }
          tokens.push({ kind: 'DIRECTIVE', val: line.slice(i, end), line: lineNum });
          i = end;
          continue;
        }

        if ('{}()[]:=!|&'.includes(ch)) {
          tokens.push({ kind: 'PUNCT', val: ch, line: lineNum });
          i++;
          continue;
        }

        if (isIdentStart(ch) || /[0-9-]/.test(ch)) {
          let end = i + 1;
          while (end < line.length && isIdentChar(line[end]!)) {
            end++;
          }
          tokens.push({ kind: 'NAME', val: line.slice(i, end), line: lineNum });
          i = end;
          continue;
        }

        i++;
      }
    }

    return tokens;
  }

  public extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch {
    const files = targetFiles
      ? targetFiles.filter((f) => this.supportsFile(f) && fs.existsSync(f))
      : this.discoverContractFiles(workspaceRoot);

    const nodes: RawContractNode[] = [];
    const edges: RawContractEdge[] = [];
    const fileRecords: GraphFileRecord[] = [];

    const schemaIdByName = new Map<string, string>();
    const pendingSchemaEdges: Array<{
      srcId: string;
      targetTypeName: string;
      kind: EdgeKind;
      filePath: string;
      line: number;
      contextText: string;
    }> = [];

    for (const absPath of files) {
      const relPath = path.relative(workspaceRoot, absPath).replace(/\\/g, '/');
      const content = fs.readFileSync(absPath, 'utf8');
      const stat = fs.statSync(absPath);
      const fileHash = sha256Hex(content);
      const rawLines = content.split('\n');
      const isProto = relPath.toLowerCase().endsWith('.proto');
      const lang = isProto ? 'protobuf' : 'graphql';

      const fileScipId = `scip-${lang} file ${relPath}`;
      fileRecords.push({
        filePath: relPath,
        packageName: lang,
        language: lang,
        sha256: fileHash,
        mtimeMs: Math.trunc(stat.mtimeMs),
        sizeBytes: stat.size,
        lineCount: rawLines.length,
      });

      nodes.push({
        id: fileScipId,
        kind: 'File',
        name: path.basename(relPath),
        qualifiedName: relPath,
        packageName: lang,
        filePath: relPath,
        startLine: 1,
        endLine: rawLines.length,
        startCol: 1,
        endCol: 1,
        signature: relPath,
        docComment: isProto ? 'Protocol Buffers IDL File' : 'GraphQL Schema File',
        exported: true,
        complexity: 1,
        contentHash: fileHash,
      });

      if (isProto) {
        const cleanSrc = this.stripProtoBlockComments(content);
        const lines = cleanSrc.split('\n');
        let protoPkg = 'proto';

        for (const l of lines) {
          const pm = l.trim().match(/^package\s+([A-Za-z0-9_.]+)\s*;/);
          if (pm) {
            protoPkg = pm[1]!;
            break;
          }
        }

        let i = 0;
        while (i < lines.length) {
          const line = (lines[i] ?? '').replace(/\/\/.*$/, '').trim();
          if (!line) {
            i++;
            continue;
          }

          // 1. service <Name> { ... }
          const svcMatch = line.match(/^service\s+([A-Za-z0-9_]+)/);
          if (svcMatch) {
            const svcName = svcMatch[1]!;
            const startLine = i + 1;
            const endIdx = this.findProtoBlockEnd(lines, i);
            const endLine = endIdx + 1;
            const svcId = `scip-proto service ${relPath} ${svcName}#`;

            nodes.push({
              id: svcId,
              kind: 'Interface',
              name: svcName,
              qualifiedName: `${protoPkg}.${svcName}`,
              packageName: protoPkg,
              filePath: relPath,
              startLine,
              endLine,
              startCol: 1,
              endCol: 1,
              signature: `service ${svcName}`,
              docComment: `gRPC / Protobuf Service ${protoPkg}.${svcName}`,
              exported: true,
              complexity: 1,
              contentHash: sha256Hex(`${svcId}:${startLine}-${endLine}`),
            });

            edges.push({
              srcId: fileScipId,
              dstId: svcId,
              kind: 'CONTAINS',
              filePath: relPath,
              line: startLine,
              contextText: `service ${svcName}`,
              confidence: 1.0,
            });

            // Parse RPCs inside service
            let rIdx = i + 1;
            while (rIdx <= endIdx) {
              const rLine = (lines[rIdx] ?? '').replace(/\/\/.*$/, '').trim();
              const rpcMatch = rLine.match(
                /^rpc\s+([A-Za-z0-9_]+)\s*\(\s*(stream\s+)?([A-Za-z0-9_.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([A-Za-z0-9_.]+)\s*\)/,
              );
              if (rpcMatch) {
                const rpcName = rpcMatch[1]!;
                const inStream = Boolean(rpcMatch[2]);
                const reqType = rpcMatch[3]!;
                const outStream = Boolean(rpcMatch[4]);
                const respType = rpcMatch[5]!;
                const rpcStartLine = rIdx + 1;
                const rpcEndIdx = rLine.includes('{') ? this.findProtoBlockEnd(lines, rIdx) : rIdx;
                const rpcEndLine = rpcEndIdx + 1;
                const rpcId = `${svcId}${rpcName}().`;

                nodes.push({
                  id: rpcId,
                  kind: 'Method',
                  name: rpcName,
                  qualifiedName: `${svcName}.${rpcName}`,
                  packageName: protoPkg,
                  filePath: relPath,
                  startLine: rpcStartLine,
                  endLine: rpcEndLine,
                  startCol: 1,
                  endCol: 1,
                  signature: `rpc ${rpcName}(${inStream ? 'stream ' : ''}${reqType}) returns (${outStream ? 'stream ' : ''}${respType})`,
                  docComment: null,
                  exported: true,
                  complexity: 1,
                  contentHash: sha256Hex(`${rpcId}:${rpcStartLine}`),
                });

                edges.push({
                  srcId: svcId,
                  dstId: rpcId,
                  kind: 'CONTAINS',
                  filePath: relPath,
                  line: rpcStartLine,
                  contextText: rLine,
                  confidence: 1.0,
                });

                pendingSchemaEdges.push({
                  srcId: rpcId,
                  targetTypeName: reqType,
                  kind: 'VALIDATES_SCHEMA',
                  filePath: relPath,
                  line: rpcStartLine,
                  contextText: `rpc ${rpcName} input ${reqType}`,
                });
                pendingSchemaEdges.push({
                  srcId: rpcId,
                  targetTypeName: respType,
                  kind: 'EMITS_SCHEMA',
                  filePath: relPath,
                  line: rpcStartLine,
                  contextText: `rpc ${rpcName} output ${respType}`,
                });

                // Check google.api.http annotation inside RPC block
                if (rpcEndIdx > rIdx) {
                  const rpcBody = lines.slice(rIdx, rpcEndIdx + 1).join('\n');
                  const httpMatch = rpcBody.match(/\b(get|post|put|delete|patch)\s*:\s*["']([^"']+)["']/);
                  if (httpMatch) {
                    const method = httpMatch[1]!.toUpperCase();
                    const httpPath = httpMatch[2]!;
                    const routeId = `scip-endpoint http ${method}:${httpPath}#`;
                    nodes.push({
                      id: routeId,
                      kind: 'RouteEndpoint',
                      name: `${method} ${httpPath}`,
                      qualifiedName: `${protoPkg} ${method} ${httpPath}`,
                      packageName: protoPkg,
                      filePath: relPath,
                      startLine: rpcStartLine,
                      endLine: rpcEndLine,
                      startCol: 1,
                      endCol: 1,
                      signature: `google.api.http ${method} ${httpPath}`,
                      docComment: `gRPC-Gateway HTTP route for ${svcName}.${rpcName}`,
                      exported: true,
                      complexity: 1,
                      contentHash: sha256Hex(`${routeId}:${rpcStartLine}`),
                    });
                    edges.push({
                      srcId: rpcId,
                      dstId: routeId,
                      kind: 'HANDLES_ROUTE',
                      filePath: relPath,
                      line: rpcStartLine,
                      contextText: `${method}: "${httpPath}"`,
                      confidence: 1.0,
                    });
                  }
                }

                rIdx = rpcEndIdx + 1;
                continue;
              }
              rIdx++;
            }

            i = endIdx + 1;
            continue;
          }

          // 2. message <Name> { ... }
          const msgMatch = line.match(/^message\s+([A-Za-z0-9_]+)/);
          if (msgMatch) {
            const msgName = msgMatch[1]!;
            const startLine = i + 1;
            const endIdx = this.findProtoBlockEnd(lines, i);
            const endLine = endIdx + 1;
            const msgId = `scip-proto message ${relPath} ${msgName}#`;
            schemaIdByName.set(msgName, msgId);
            schemaIdByName.set(`${protoPkg}.${msgName}`, msgId);

            nodes.push({
              id: msgId,
              kind: 'Class',
              name: msgName,
              qualifiedName: `${protoPkg}.${msgName}`,
              packageName: protoPkg,
              filePath: relPath,
              startLine,
              endLine,
              startCol: 1,
              endCol: 1,
              signature: `message ${msgName}`,
              docComment: `Protobuf Message ${protoPkg}.${msgName}`,
              exported: true,
              complexity: 1,
              contentHash: sha256Hex(`${msgId}:${startLine}-${endLine}`),
            });

            edges.push({
              srcId: fileScipId,
              dstId: msgId,
              kind: 'CONTAINS',
              filePath: relPath,
              line: startLine,
              contextText: `message ${msgName}`,
              confidence: 1.0,
            });

            // Parse fields inside message
            for (let fIdx = i + 1; fIdx < endIdx; fIdx++) {
              const fLine = (lines[fIdx] ?? '').replace(/\/\/.*$/, '').trim();
              if (!fLine || fLine.startsWith('}') || fLine.startsWith('reserved')) continue;
              const mapMatch = fLine.match(
                /^map\s*<\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_.]+)\s*>\s+([A-Za-z0-9_]+)\s*=\s*(\d+)/,
              );
              const fldMatch = fLine.match(
                /^(repeated\s+|optional\s+)?([A-Za-z0-9_.]+)\s+([A-Za-z0-9_]+)\s*=\s*(\d+)/,
              );
              if (mapMatch || fldMatch) {
                const fName = mapMatch ? mapMatch[3]! : fldMatch![3]!;
                const fType = mapMatch ? `map<${mapMatch[1]}, ${mapMatch[2]}>` : fldMatch![2]!;
                const refType = mapMatch ? mapMatch[2]! : fldMatch![2]!;
                const fLineNum = fIdx + 1;
                const fldId = `${msgId}${fName}.`;

                nodes.push({
                  id: fldId,
                  kind: 'Property',
                  name: fName,
                  qualifiedName: `${msgName}.${fName}`,
                  packageName: protoPkg,
                  filePath: relPath,
                  startLine: fLineNum,
                  endLine: fLineNum,
                  startCol: 1,
                  endCol: 1,
                  signature: fLine,
                  docComment: null,
                  exported: true,
                  complexity: 1,
                  contentHash: sha256Hex(`${fldId}:${fLineNum}`),
                });

                edges.push({
                  srcId: msgId,
                  dstId: fldId,
                  kind: 'CONTAINS',
                  filePath: relPath,
                  line: fLineNum,
                  contextText: fLine,
                  confidence: 1.0,
                });

                pendingSchemaEdges.push({
                  srcId: msgId,
                  targetTypeName: refType,
                  kind: 'REFERENCES',
                  filePath: relPath,
                  line: fLineNum,
                  contextText: fLine,
                });
              }
            }

            i = endIdx + 1;
            continue;
          }

          // 3. enum <Name> { ... }
          const enumMatch = line.match(/^enum\s+([A-Za-z0-9_]+)/);
          if (enumMatch) {
            const enumName = enumMatch[1]!;
            const startLine = i + 1;
            const endIdx = this.findProtoBlockEnd(lines, i);
            const endLine = endIdx + 1;
            const enumId = `scip-proto enum ${relPath} ${enumName}#`;
            schemaIdByName.set(enumName, enumId);
            schemaIdByName.set(`${protoPkg}.${enumName}`, enumId);

            nodes.push({
              id: enumId,
              kind: 'Enum',
              name: enumName,
              qualifiedName: `${protoPkg}.${enumName}`,
              packageName: protoPkg,
              filePath: relPath,
              startLine,
              endLine,
              startCol: 1,
              endCol: 1,
              signature: `enum ${enumName}`,
              docComment: `Protobuf Enum ${protoPkg}.${enumName}`,
              exported: true,
              complexity: 1,
              contentHash: sha256Hex(`${enumId}:${startLine}-${endLine}`),
            });

            edges.push({
              srcId: fileScipId,
              dstId: enumId,
              kind: 'CONTAINS',
              filePath: relPath,
              line: startLine,
              contextText: `enum ${enumName}`,
              confidence: 1.0,
            });

            i = endIdx + 1;
            continue;
          }

          i++;
        }
        continue;
      }

      // GraphQL (.graphql / .gql) token-based parser with exact 1-based startLine and endLine
      const tokens = this.tokenizeGraphQL(content);
      let idx = 0;
      let pendingDoc: string | null = null;

      while (idx < tokens.length) {
        const tok = tokens[idx]!;
        if (tok.kind === 'STRING') {
          pendingDoc = tok.val;
          idx++;
          continue;
        }
        if (tok.kind !== 'NAME') {
          idx++;
          continue;
        }

        let startLine = tok.line;
        let kw = tok.val;
        if (kw === 'extend' && idx + 1 < tokens.length) {
          idx++;
          kw = tokens[idx]!.val;
        }

        if (kw === 'type' || kw === 'input' || kw === 'interface' || kw === 'enum') {
          const nameTok = tokens[idx + 1];
          if (!nameTok || nameTok.kind !== 'NAME') {
            idx++;
            continue;
          }
          const typeName = nameTok.val;
          idx += 2;

          const implementedIfaces: string[] = [];
          // Scan header until '{'
          while (idx < tokens.length && !(tokens[idx]!.kind === 'PUNCT' && tokens[idx]!.val === '{')) {
            if (tokens[idx]!.kind === 'NAME' && tokens[idx]!.val === 'implements') {
              idx++;
              while (
                idx < tokens.length &&
                !(tokens[idx]!.kind === 'PUNCT' && tokens[idx]!.val === '{') &&
                tokens[idx]!.kind !== 'DIRECTIVE'
              ) {
                if (tokens[idx]!.kind === 'NAME') {
                  implementedIfaces.push(tokens[idx]!.val);
                }
                idx++;
              }
              continue;
            }
            idx++;
          }

          // Scan balanced '{ ... }'
          let endLine = startLine;
          const bodyTokens: GqlToken[] = [];
          if (idx < tokens.length && tokens[idx]!.kind === 'PUNCT' && tokens[idx]!.val === '{') {
            let depth = 1;
            idx++;
            while (idx < tokens.length && depth > 0) {
              const bt = tokens[idx]!;
              endLine = bt.line;
              if (bt.kind === 'PUNCT' && bt.val === '{') depth++;
              else if (bt.kind === 'PUNCT' && bt.val === '}') {
                depth--;
                if (depth === 0) {
                  idx++;
                  break;
                }
              }
              if (depth > 0) bodyTokens.push(bt);
              idx++;
            }
          }

          const nodeKind: GraphNodeRecord['kind'] =
            kw === 'interface' ? 'Interface' : kw === 'enum' ? 'Enum' : 'Class';
          const typeId = `scip-graphql ${kw} ${relPath} ${typeName}#`;
          schemaIdByName.set(typeName, typeId);

          nodes.push({
            id: typeId,
            kind: nodeKind,
            name: typeName,
            qualifiedName: `graphql::${typeName}`,
            packageName: 'graphql',
            filePath: relPath,
            startLine,
            endLine,
            startCol: 1,
            endCol: 1,
            signature: `${kw} ${typeName}`,
            docComment: pendingDoc,
            exported: true,
            complexity: 1,
            contentHash: sha256Hex(`${typeId}:${startLine}-${endLine}`),
          });
          pendingDoc = null;

          edges.push({
            srcId: fileScipId,
            dstId: typeId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startLine,
            contextText: `${kw} ${typeName}`,
            confidence: 1.0,
          });

          for (const iface of implementedIfaces) {
            pendingSchemaEdges.push({
              srcId: typeId,
              targetTypeName: iface,
              kind: 'IMPLEMENTS',
              filePath: relPath,
              line: startLine,
              contextText: `${typeName} implements ${iface}`,
            });
          }

          // Parse fields inside type/input/interface
          if (kw !== 'enum') {
            const isOperationRoot =
              typeName === 'Query' || typeName === 'Mutation' || typeName === 'Subscription';
            let bIdx = 0;
            while (bIdx < bodyTokens.length) {
              if (bodyTokens[bIdx]!.kind === 'STRING') {
                bIdx++;
                continue;
              }
              if (bodyTokens[bIdx]!.kind !== 'NAME') {
                bIdx++;
                continue;
              }
              const fieldTok = bodyTokens[bIdx]!;
              const fieldName = fieldTok.val;
              const fieldStartLine = fieldTok.line;
              bIdx++;

              // Optional arguments (...)
              const argTypes: string[] = [];
              if (
                bIdx < bodyTokens.length &&
                bodyTokens[bIdx]!.kind === 'PUNCT' &&
                bodyTokens[bIdx]!.val === '('
              ) {
                let pDepth = 1;
                bIdx++;
                while (bIdx < bodyTokens.length && pDepth > 0) {
                  const pt = bodyTokens[bIdx]!;
                  if (pt.kind === 'PUNCT' && pt.val === '(') pDepth++;
                  else if (pt.kind === 'PUNCT' && pt.val === ')') pDepth--;
                  else if (pt.kind === 'PUNCT' && pt.val === ':') {
                    // Next NAME token is argument type
                    let k = bIdx + 1;
                    while (k < bodyTokens.length && bodyTokens[k]!.kind === 'PUNCT' && bodyTokens[k]!.val === '[') {
                      k++;
                    }
                    if (k < bodyTokens.length && bodyTokens[k]!.kind === 'NAME') {
                      argTypes.push(bodyTokens[k]!.val);
                    }
                  }
                  bIdx++;
                }
              }

              // Expect ':' followed by return type
              if (
                bIdx < bodyTokens.length &&
                bodyTokens[bIdx]!.kind === 'PUNCT' &&
                bodyTokens[bIdx]!.val === ':'
              ) {
                bIdx++;
                let retTypeName = '';
                let fieldEndLine = fieldStartLine;
                while (
                  bIdx < bodyTokens.length &&
                  ((bodyTokens[bIdx]!.kind === 'PUNCT' && '[]!'.includes(bodyTokens[bIdx]!.val)) ||
                    (bodyTokens[bIdx]!.kind === 'NAME' && retTypeName === ''))
                ) {
                  if (bodyTokens[bIdx]!.kind === 'NAME') {
                    retTypeName = bodyTokens[bIdx]!.val;
                  }
                  fieldEndLine = bodyTokens[bIdx]!.line;
                  bIdx++;
                }

                // Skip field directives
                while (bIdx < bodyTokens.length && bodyTokens[bIdx]!.kind === 'DIRECTIVE') {
                  fieldEndLine = bodyTokens[bIdx]!.line;
                  bIdx++;
                  if (
                    bIdx < bodyTokens.length &&
                    bodyTokens[bIdx]!.kind === 'PUNCT' &&
                    bodyTokens[bIdx]!.val === '('
                  ) {
                    let dDepth = 1;
                    bIdx++;
                    while (bIdx < bodyTokens.length && dDepth > 0) {
                      if (bodyTokens[bIdx]!.kind === 'PUNCT' && bodyTokens[bIdx]!.val === '(') dDepth++;
                      else if (bodyTokens[bIdx]!.kind === 'PUNCT' && bodyTokens[bIdx]!.val === ')') dDepth--;
                      fieldEndLine = bodyTokens[bIdx]!.line;
                      bIdx++;
                    }
                  }
                }

                const fldId = `${typeId}${fieldName}${isOperationRoot ? '().' : '.'}`;
                nodes.push({
                  id: fldId,
                  kind: isOperationRoot ? 'Method' : 'Property',
                  name: fieldName,
                  qualifiedName: `${typeName}.${fieldName}`,
                  packageName: 'graphql',
                  filePath: relPath,
                  startLine: fieldStartLine,
                  endLine: fieldEndLine,
                  startCol: 1,
                  endCol: 1,
                  signature: `${fieldName}: ${retTypeName}`,
                  docComment: null,
                  exported: true,
                  complexity: 1,
                  contentHash: sha256Hex(`${fldId}:${fieldStartLine}`),
                });

                edges.push({
                  srcId: typeId,
                  dstId: fldId,
                  kind: 'CONTAINS',
                  filePath: relPath,
                  line: fieldStartLine,
                  contextText: `${fieldName}: ${retTypeName}`,
                  confidence: 1.0,
                });

                if (isOperationRoot) {
                  const routeId = `scip-endpoint graphql ${typeName.toUpperCase()}:${fieldName}#`;
                  nodes.push({
                    id: routeId,
                    kind: 'RouteEndpoint',
                    name: `${typeName}.${fieldName}`,
                    qualifiedName: `graphql::${typeName}.${fieldName}`,
                    packageName: 'graphql',
                    filePath: relPath,
                    startLine: fieldStartLine,
                    endLine: fieldEndLine,
                    startCol: 1,
                    endCol: 1,
                    signature: `${typeName}.${fieldName}: ${retTypeName}`,
                    docComment: `GraphQL ${typeName} operation ${fieldName}`,
                    exported: true,
                    complexity: 1,
                    contentHash: sha256Hex(`${routeId}:${fieldStartLine}`),
                  });
                  edges.push({
                    srcId: fldId,
                    dstId: routeId,
                    kind: 'HANDLES_ROUTE',
                    filePath: relPath,
                    line: fieldStartLine,
                    contextText: `${typeName}.${fieldName}`,
                    confidence: 1.0,
                  });
                }

                for (const at of argTypes) {
                  pendingSchemaEdges.push({
                    srcId: fldId,
                    targetTypeName: at,
                    kind: 'VALIDATES_SCHEMA',
                    filePath: relPath,
                    line: fieldStartLine,
                    contextText: `${fieldName} arg ${at}`,
                  });
                }
                if (retTypeName) {
                  pendingSchemaEdges.push({
                    srcId: isOperationRoot ? fldId : typeId,
                    targetTypeName: retTypeName,
                    kind: isOperationRoot ? 'EMITS_SCHEMA' : 'REFERENCES',
                    filePath: relPath,
                    line: fieldStartLine,
                    contextText: `${fieldName}: ${retTypeName}`,
                  });
                }
              }
            }
          }
          continue;
        }

        if (kw === 'union' || kw === 'scalar') {
          const nameTok = tokens[idx + 1];
          if (!nameTok || nameTok.kind !== 'NAME') {
            idx++;
            continue;
          }
          const typeName = nameTok.val;
          let endLine = nameTok.line;
          idx += 2;
          const unionMembers: string[] = [];
          if (kw === 'union' && idx < tokens.length && tokens[idx]!.val === '=') {
            idx++;
            while (
              idx < tokens.length &&
              (tokens[idx]!.val === '|' || (tokens[idx]!.kind === 'NAME' && !['type', 'input', 'interface', 'union', 'enum', 'scalar', 'extend'].includes(tokens[idx]!.val)))
            ) {
              if (tokens[idx]!.kind === 'NAME') {
                unionMembers.push(tokens[idx]!.val);
              }
              endLine = tokens[idx]!.line;
              idx++;
            }
          }
          const nodeId = `scip-graphql ${kw} ${relPath} ${typeName}#`;
          schemaIdByName.set(typeName, nodeId);

          nodes.push({
            id: nodeId,
            kind: 'TypeAlias',
            name: typeName,
            qualifiedName: `graphql::${typeName}`,
            packageName: 'graphql',
            filePath: relPath,
            startLine,
            endLine,
            startCol: 1,
            endCol: 1,
            signature: unionMembers.length > 0 ? `union ${typeName} = ${unionMembers.join(' | ')}` : `${kw} ${typeName}`,
            docComment: pendingDoc,
            exported: true,
            complexity: 1,
            contentHash: sha256Hex(`${nodeId}:${startLine}`),
          });
          pendingDoc = null;

          edges.push({
            srcId: fileScipId,
            dstId: nodeId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startLine,
            contextText: `${kw} ${typeName}`,
            confidence: 1.0,
          });

          for (const m of unionMembers) {
            pendingSchemaEdges.push({
              srcId: nodeId,
              targetTypeName: m,
              kind: 'REFERENCES',
              filePath: relPath,
              line: startLine,
              contextText: `union ${typeName} member ${m}`,
            });
          }
          continue;
        }

        idx++;
      }
    }

    // Resolve cross-schema edges
    for (const pe of pendingSchemaEdges) {
      const dstId =
        schemaIdByName.get(pe.targetTypeName) ??
        schemaIdByName.get(pe.targetTypeName.split('.').pop() ?? pe.targetTypeName);
      if (dstId && dstId !== pe.srcId) {
        edges.push({
          srcId: pe.srcId,
          dstId,
          kind: pe.kind,
          filePath: pe.filePath,
          line: pe.line,
          contextText: pe.contextText,
          confidence: 0.98,
        });
      }
    }

    const normalizedNodes: GraphNodeRecord[] = nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      qualifiedName: n.qualifiedName,
      packageName: n.packageName,
      filePath: n.filePath,
      language: n.language ?? (n.filePath.toLowerCase().endsWith('.proto') ? 'protobuf' : 'graphql'),
      startLine: n.startLine,
      startCol: n.startCol,
      endLine: n.endLine,
      endCol: n.endCol,
      signature: n.signature,
      docstring: n.docComment ?? '',
      exported: n.exported,
      complexity: n.complexity,
      labels: [n.kind],
      properties: {},
    }));

    const normalizedEdges: GraphEdgeRecord[] = edges.map((e) => ({
      srcId: e.srcId,
      dstId: e.dstId,
      kind: e.kind,
      filePath: e.filePath,
      line: e.line,
      col: 1,
      weight: e.confidence,
      properties: e.contextText ? { context: e.contextText } : {},
    }));

    return {
      compiler: this.name,
      files: fileRecords,
      nodes: normalizedNodes,
      edges: normalizedEdges,
      diagnostics: [],
    };
  }
}
