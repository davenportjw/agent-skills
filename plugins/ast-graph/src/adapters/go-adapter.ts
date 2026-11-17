import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CompilerAdapter,
  CompilerGraphBatch,
  EdgeKind,
  GraphEdgeRecord,
  GraphFileRecord,
  GraphNodeRecord,
  ScipSymbolUri,
} from '../types.js';
import { isExcludedSubtree } from '../repo-boundary.js';

function findGoClosingBrace(lines: string[], startLineIdx: number): number {
  let depth = 0;
  let seenOpen = false;
  for (let i = startLineIdx; i < lines.length; i++) {
    const line = lines[i]!;
    let inString = false;
    let stringChar = '';
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      const prev = c > 0 ? line[c - 1] : '';
      if (!inString && ch === '/' && line[c + 1] === '/') {
        break; // line comment
      }
      if (!inString && (ch === '"' || ch === '`')) {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (inString && ch === stringChar && prev !== '\\') {
        inString = false;
        continue;
      }
      if (inString) continue;
      if (ch === '{') {
        depth += 1;
        seenOpen = true;
      } else if (ch === '}') {
        depth -= 1;
        if (seenOpen && depth <= 0) {
          return i + 1;
        }
      }
    }
  }
  return Math.min(lines.length, startLineIdx + 1);
}

function computeGoComplexity(bodyLines: string[]): number {
  let c = 1;
  for (const raw of bodyLines) {
    const line = raw.replace(/\/\/.*$/, '');
    if (/\b(if|for|case|select)\b/.test(line)) c += 1;
    if (line.includes('&&') || line.includes('||')) c += 1;
  }
  return c;
}

/**
 * Candidate type identifiers in a Go expression or statement. String/rune literals are stripped,
 * selector members of local values (`r.Config`) are ignored, while package-qualified names
 * (`router.Proxy`) yield the bare type name. Callers resolve names against declared types only,
 * so builtins and locals never produce edges.
 */
export function goTypeIdentifiers(
  text: string,
  receiverVar?: string,
): { name: string; composite: boolean; typeContext: boolean }[] {
  const cleaned = text
    .replace(/\/\/.*$/, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const out: { name: string; composite: boolean; typeContext: boolean }[] = [];
  const seen = new Set<string>();
  const re = /(?:\b([A-Za-z_][A-Za-z0-9_]*)\.)?\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const qualifier = m[1];
    const name = m[2]!;
    const start = m.index + (qualifier ? qualifier.length + 1 : 0);
    // Member access on a value (`x.Field`) unless the qualifier looks like a package (lowercase,
    // not the receiver). Exported-only for qualified names since other packages can't see others.
    if (qualifier) {
      if (qualifier === receiverVar || !/^[a-z]/.test(qualifier) || !/^[A-Z]/.test(name)) continue;
    } else if (start > 0 && cleaned[start - 1] === '.') {
      continue;
    }
    const after = cleaned.slice(m.index + m[0].length);
    const composite = /^\s*(?:\[[^\]]*\])?\s*\{/.test(after);
    // Skip calls of same-named functions (`Foo(` where Foo is a func); conversions of types are kept
    // by the caller only if the name resolves to a declared type.
    const before = cleaned.slice(0, m.index).trimEnd();
    const typeContext =
      composite ||
      /(?:\*|\]|\.\(|\bnew\(|\bvar\s+[A-Za-z0-9_, ]+|\bcase|\bchan|\bfunc\s*\([^)]*\)?)$/.test(before);
    const key = `${name}|${composite}|${typeContext}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, composite, typeContext });
  }
  return out;
}

export class GoCompilerAdapter implements CompilerAdapter {
  public readonly name = 'go';
  public readonly languages = ['go', 'templ'] as const;

  public supportsFile(filePath: string): boolean {
    const norm = filePath.replace(/\\/g, '/');
    if (
      norm.includes('node_modules') ||
      norm.includes('vendor/') ||
      norm.includes('.git/') ||
      norm.includes('.ast-graph') ||
      norm.endsWith('_templ.go')
    ) {
      return false;
    }
    return norm.endsWith('.go') || norm.endsWith('.templ');
  }

  public discoverGoFiles(workspaceRoot: string): string[] {
    const results: string[] = [];
    const skipDirs = new Set([
      'node_modules',
      'vendor',
      'dist',
      'build',
      'site',
      'bin',
      '.git',
      '.venv',
      'venv',
      '.ast-graph',
      '.terraform',
      '.cache',
      'scratch',
    ]);
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skipDirs.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (isExcludedSubtree(full)) continue;
          walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(workspaceRoot, full).split(path.sep).join('/');
          if (this.supportsFile(rel)) {
            results.push(full);
          }
        }
      }
    };
    walk(workspaceRoot);
    return results.sort();
  }

  private detectGoModuleName(workspaceRoot: string): string {
    const goModPath = path.join(workspaceRoot, 'go.mod');
    if (fs.existsSync(goModPath)) {
      try {
        const raw = fs.readFileSync(goModPath, 'utf8');
        const m = raw.match(/^\s*module\s+([^\s]+)/m);
        if (m?.[1]) return m[1].trim();
      } catch {
        // ignore
      }
    }
    return path.basename(workspaceRoot);
  }

  public extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch {
    const resolvedRoot = path.resolve(workspaceRoot);
    const moduleName = this.detectGoModuleName(resolvedRoot);
    const allFiles = this.discoverGoFiles(resolvedRoot);
    const targetRelSet = targetFiles
      ? new Set(
          targetFiles.map((f) =>
            path.isAbsolute(f)
              ? path.relative(resolvedRoot, f).split(path.sep).join('/')
              : f.replace(/^\.\//, '').split(path.sep).join('/'),
          ),
        )
      : null;

    const filesBatch: GraphFileRecord[] = [];
    const nodesMap = new Map<string, GraphNodeRecord>();
    const edgesMap = new Map<string, GraphEdgeRecord>();

    if (allFiles.length === 0) {
      return { compiler: this.name, files: [], nodes: [], edges: [], diagnostics: [] };
    }

    const addNode = (n: GraphNodeRecord): void => {
      nodesMap.set(n.id, n);
    };
    const addEdge = (
      srcId: ScipSymbolUri,
      dstId: ScipSymbolUri,
      kind: EdgeKind,
      filePath: string,
      line: number,
      properties: Record<string, unknown> = {},
    ): void => {
      if (!srcId || !dstId || srcId === dstId) return;
      const key = `${srcId}|${dstId}|${kind}|${filePath}|${line}`;
      edgesMap.set(key, {
        srcId,
        dstId,
        kind,
        filePath,
        line,
        col: 1,
        weight: 1,
        properties,
      });
    };

    // Global lookup maps across workspace for Pass 2 edge resolution
    const structIdByName = new Map<string, ScipSymbolUri>();
    const fieldIdByStructAndName = new Map<string, ScipSymbolUri>();
    const fieldIdsByName = new Map<string, ScipSymbolUri[]>();
    const funcIdsByName = new Map<string, ScipSymbolUri[]>();
    // Named types (structs, interfaces, defined types) by short name, with their package dir so
    // same-package declarations win when several packages declare the same name.
    const typeIdsByName = new Map<string, { id: ScipSymbolUri; pkgDir: string }[]>();
    const registerType = (name: string, id: ScipSymbolUri, pkgDir: string): void => {
      const list = typeIdsByName.get(name) ?? [];
      if (!list.some((t) => t.id === id)) list.push({ id, pkgDir });
      typeIdsByName.set(name, list);
    };
    const resolveType = (name: string, pkgDir: string): ScipSymbolUri | undefined => {
      const list = typeIdsByName.get(name);
      if (!list || list.length === 0) return undefined;
      return (list.find((t) => t.pkgDir === pkgDir) ?? list[0])!.id;
    };
    // Deferred type usages from struct fields / interface method signatures (resolved after pass 1,
    // since the referenced type may be declared in a file that is parsed later).
    const pendingTypeRefs: {
      srcId: ScipSymbolUri;
      typeExpr: string;
      pkgDir: string;
      filePath: string;
      line: number;
      usage: string;
    }[] = [];
    const pendingReceiverContains: { recvType: string; fnId: ScipSymbolUri; pkgDir: string; filePath: string; line: number }[] = [];

    interface ParsedCallable {
      id: ScipSymbolUri;
      name: string;
      receiverVar?: string;
      receiverType?: string;
      filePath: string;
      pkgName: string;
      startLine: number;
      endLine: number;
      isTest: boolean;
      bodyLines: string[];
      pkgDir: string;
    }
    const callables: ParsedCallable[] = [];

    // Pass 1: Discover packages, files, structs, interfaces, functions, methods, tests, and .templ components
    for (const absPath of allFiles) {
      const relPath = path.relative(resolvedRoot, absPath).split(path.sep).join('/');
      if (!fs.existsSync(absPath)) continue;
      const includeFile = !targetRelSet || targetRelSet.has(relPath);

      const stat = fs.statSync(absPath);
      const content = fs.readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');

      const pkgDir = path.dirname(relPath);
      const pkgMatch = content.match(/^\s*package\s+([a-zA-Z0-9_]+)/m);
      const goPkgShort = pkgMatch?.[1] ?? (pkgDir === '.' ? path.basename(resolvedRoot) : path.basename(pkgDir));
      const pkgName = pkgDir === '.' ? moduleName : `${moduleName}/${pkgDir}`;
      const pkgId = `scip-go gomod ${moduleName} 1.0.0 ${pkgDir}#`;

      if (!nodesMap.has(pkgId)) {
        addNode({
          id: pkgId,
          kind: 'WorkspacePackage',
          name: pkgName,
          qualifiedName: pkgName,
          packageName: pkgName,
          filePath: relPath,
          language: 'go',
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 1,
          signature: `package ${goPkgShort} (${pkgName})`,
          docstring: `Go package ${pkgName}`,
          exported: true,
          complexity: 1,
          labels: ['WorkspacePackage', 'GoPackage'],
          properties: { module: moduleName, package: goPkgShort },
        });
      }

      const isTempl = relPath.endsWith('.templ');
      const isTestFile = relPath.endsWith('_test.go');
      const lang = isTempl ? 'templ' : 'go';
      const fileId = `scip-go gomod ${moduleName} 1.0.0 ${relPath}/`;

      if (includeFile) {
        filesBatch.push({
          filePath: relPath,
          packageName: pkgName,
          language: lang,
          sha256,
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
          lineCount: lines.length,
        });

        addNode({
          id: fileId,
          kind: 'File',
          name: path.basename(relPath),
          qualifiedName: relPath,
          packageName: pkgName,
          filePath: relPath,
          language: lang,
          startLine: 1,
          startCol: 1,
          endLine: lines.length,
          endCol: 1,
          signature: `${lang} file ${relPath}`,
          docstring: `${isTempl ? 'Templ component' : 'Go source'} file ${relPath}`,
          exported: true,
          complexity: 1,
          labels: isTestFile ? ['File', 'GoTestFile'] : ['File', isTempl ? 'TemplFile' : 'GoFile'],
          properties: {},
        });

        addEdge(pkgId, fileId, 'CONTAINS', relPath, 1);
      }

      let suiteId: ScipSymbolUri | null = null;
      if (isTestFile && includeFile) {
        suiteId = `scip-go gomod ${moduleName} 1.0.0 ${relPath}/TestSuite#`;
        addNode({
          id: suiteId,
          kind: 'TestSuite',
          name: path.basename(relPath),
          qualifiedName: `${pkgName}/${path.basename(relPath)}`,
          packageName: pkgName,
          filePath: relPath,
          language: 'go',
          startLine: 1,
          startCol: 1,
          endLine: lines.length,
          endCol: 1,
          signature: `go test ./${pkgDir === '.' ? '...' : pkgDir}`,
          docstring: `Go test suite ${relPath}`,
          exported: true,
          complexity: 1,
          labels: ['TestSuite', 'GoTestSuite'],
          properties: {},
        });
        addEdge(fileId, suiteId, 'CONTAINS', relPath, 1);
      }

      if (isTempl) {
        // Parse `templ ComponentName(args...) {`
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const templMatch = line.match(/^\s*templ\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
          if (templMatch) {
            const compName = templMatch[1]!;
            const compArgs = templMatch[2] ?? '';
            const startLine = i + 1;
            const endLine = findGoClosingBrace(lines, i);
            const compId = `scip-go gomod ${moduleName} 1.0.0 ${relPath}/${compName}().`;
            const bodySlice = lines.slice(i, endLine);

            funcIdsByName.set(compName, [...(funcIdsByName.get(compName) ?? []), compId]);

            if (includeFile) {
              addNode({
                id: compId,
                kind: 'Function',
                name: compName,
                qualifiedName: `${goPkgShort}.${compName}`,
                packageName: pkgName,
                filePath: relPath,
                language: 'templ',
                startLine,
                startCol: 1,
                endLine,
                endCol: 1,
                signature: `templ ${compName}(${compArgs.trim()})`,
                docstring: `Templ HTML/HTMX component ${compName} in ${relPath}`,
                exported: /^[A-Z]/.test(compName),
                complexity: computeGoComplexity(bodySlice),
                labels: ['Function', 'TemplComponent'],
                properties: {},
              });
              addEdge(fileId, compId, 'CONTAINS', relPath, startLine);

              callables.push({
                id: compId,
                name: compName,
                filePath: relPath,
                pkgName,
                startLine,
                endLine,
                isTest: false,
                bodyLines: bodySlice,
                pkgDir,
              });
            }
          }
        }
        continue;
      }

      // Parse Go declarations in `.go` files
      let inTypeBlock = false;
      for (let i = 0; i < lines.length; i++) {
        const rawDeclLine = lines[i]!;
        if (/^\s*type\s*\(\s*(?:\/\/.*)?$/.test(rawDeclLine)) {
          inTypeBlock = true;
          continue;
        }
        if (inTypeBlock && /^\s*\)\s*$/.test(rawDeclLine)) {
          inTypeBlock = false;
          continue;
        }
        // Inside `type ( ... )` each spec is parsed as if written `type Name ...`.
        const line =
          inTypeBlock && /^\s*[A-Za-z_]/.test(rawDeclLine) ? `type ${rawDeclLine.trim()}` : rawDeclLine;

        // 1. Struct definition: `type Foo struct {` or `type Foo[T any] struct {`
        const structMatch = line.match(/^\s*type\s+([A-Za-z0-9_]+)(?:\[[^\]]+\])?\s+struct\s*\{/);
        if (structMatch) {
          const structName = structMatch[1]!;
          const startLine = i + 1;
          const endLine = findGoClosingBrace(lines, i);
          const structId = `scip-go gomod ${moduleName} 1.0.0 ${relPath}/${structName}#`;
          structIdByName.set(structName, structId);
          registerType(structName, structId, pkgDir);

          if (includeFile) {
            addNode({
              id: structId,
              kind: 'Class',
              name: structName,
              qualifiedName: `${goPkgShort}.${structName}`,
              packageName: pkgName,
              filePath: relPath,
              language: 'go',
              startLine,
              startCol: 1,
              endLine,
              endCol: 1,
              signature: `type ${structName} struct`,
              docstring: `Go struct ${goPkgShort}.${structName}`,
              exported: /^[A-Z]/.test(structName),
              complexity: 1,
              labels: ['Class', 'GoStruct'],
              properties: {},
            });
            addEdge(fileId, structId, 'CONTAINS', relPath, startLine);
          }

          // Extract struct fields inside `startLine..endLine`
          for (let fIdx = i + 1; fIdx < endLine - 1; fIdx++) {
            const fLine = lines[fIdx]!.replace(/\/\/.*$/, '').trim();
            if (!fLine || fLine.startsWith('}') || fLine.startsWith('{')) continue;
            const fieldMatch = fLine.match(/^([A-Za-z0-9_]+)\s+([^\s`]+)(?:\s+`([^`]*)`)?/);
            const embeddedMatch = !fieldMatch ? fLine.match(/^\*?((?:[A-Za-z0-9_]+\.)?[A-Z][A-Za-z0-9_]*)\s*(?:`[^`]*`)?$/) : null;
            if (embeddedMatch && includeFile) {
              pendingTypeRefs.push({
                srcId: structId,
                typeExpr: embeddedMatch[1]!,
                pkgDir,
                filePath: relPath,
                line: fIdx + 1,
                usage: 'embedded',
              });
            }
            if (fieldMatch) {
              const fieldName = fieldMatch[1]!;
              const fieldType = fieldMatch[2]!;
              const structTag = fieldMatch[3] ?? '';
              const fieldId = `scip-go gomod ${moduleName} 1.0.0 ${relPath}/${structName}#${fieldName}.`;
              fieldIdByStructAndName.set(`${structName}.${fieldName}`, fieldId);
              fieldIdsByName.set(fieldName, [...(fieldIdsByName.get(fieldName) ?? []), fieldId]);

              if (includeFile) {
                addNode({
                  id: fieldId,
                  kind: 'Property',
                  name: fieldName,
                  qualifiedName: `${structName}.${fieldName}`,
                  packageName: pkgName,
                  filePath: relPath,
                  language: 'go',
                  startLine: fIdx + 1,
                  startCol: 1,
                  endLine: fIdx + 1,
                  endCol: 1,
                  signature: structTag ? `${fieldName} ${fieldType} \`${structTag}\`` : `${fieldName} ${fieldType}`,
                  docstring: `Field ${fieldName} (${fieldType}) on struct ${structName}`,
                  exported: /^[A-Z]/.test(fieldName),
                  complexity: 1,
                  labels: ['Property', 'GoStructField'],
                  properties: { fieldType, tag: structTag },
                });
                addEdge(structId, fieldId, 'CONTAINS', relPath, fIdx + 1);
                pendingTypeRefs.push({
                  srcId: fieldId,
                  typeExpr: fieldType,
                  pkgDir,
                  filePath: relPath,
                  line: fIdx + 1,
                  usage: 'field_type',
                });
              }
            }
          }
          i = Math.max(i, endLine - 1);
          continue;
        }

        // 2. Interface definition: `type Bar interface {` or `type Bar[T any] interface {`
        const ifaceMatch = line.match(/^\s*type\s+([A-Za-z0-9_]+)(?:\[[^\]]+\])?\s+interface\s*\{/);
        if (ifaceMatch) {
          const ifaceName = ifaceMatch[1]!;
          const startLine = i + 1;
          const endLine = findGoClosingBrace(lines, i);
          const ifaceId = `scip-go gomod ${moduleName} 1.0.0 ${relPath}/${ifaceName}#`;
          structIdByName.set(ifaceName, ifaceId);
          registerType(ifaceName, ifaceId, pkgDir);

          if (includeFile) {
            addNode({
              id: ifaceId,
              kind: 'Interface',
              name: ifaceName,
              qualifiedName: `${goPkgShort}.${ifaceName}`,
              packageName: pkgName,
              filePath: relPath,
              language: 'go',
              startLine,
              startCol: 1,
              endLine,
              endCol: 1,
              signature: `type ${ifaceName} interface`,
              docstring: `Go interface ${goPkgShort}.${ifaceName}`,
              exported: /^[A-Z]/.test(ifaceName),
              complexity: 1,
              labels: ['Interface', 'GoInterface'],
              properties: {},
            });
            addEdge(fileId, ifaceId, 'CONTAINS', relPath, startLine);

            for (let mIdx = i + 1; mIdx < endLine - 1; mIdx++) {
              const mLine = lines[mIdx]!.replace(/\/\/.*$/, '').trim();
              const mMatch = mLine.match(/^([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*(.*)$/);
              if (mMatch) {
                const mName = mMatch[1]!;
                const mSigId = `scip-go gomod ${moduleName} 1.0.0 ${relPath}/${ifaceName}#${mName}().`;
                funcIdsByName.set(mName, [...(funcIdsByName.get(mName) ?? []), mSigId]);
                addNode({
                  id: mSigId,
                  kind: 'Method',
                  name: mName,
                  qualifiedName: `${ifaceName}.${mName}`,
                  packageName: pkgName,
                  filePath: relPath,
                  language: 'go',
                  startLine: mIdx + 1,
                  startCol: 1,
                  endLine: mIdx + 1,
                  endCol: 1,
                  signature: mLine,
                  docstring: `Interface method ${ifaceName}.${mName}`,
                  exported: /^[A-Z]/.test(mName),
                  complexity: 1,
                  labels: ['Method', 'GoInterfaceMethod'],
                  properties: {},
                });
                addEdge(ifaceId, mSigId, 'CONTAINS', relPath, mIdx + 1);
                pendingTypeRefs.push({
                  srcId: mSigId,
                  typeExpr: `${mMatch[2] ?? ''} ${mMatch[3] ?? ''}`,
                  pkgDir,
                  filePath: relPath,
                  line: mIdx + 1,
                  usage: 'signature',
                });
              }
            }
          }
          i = Math.max(i, endLine - 1);
          continue;
        }

        // 2b. Defined / alias types: `type Status int`, `type HandlerFunc func(...)`, `type ID = string`
        const definedMatch = line.match(
          /^\s*type\s+([A-Za-z0-9_]+)(?:\[[^\]]+\])?\s*(=)?\s*(?!struct\b|interface\b)([^{\s][^{]*?)\s*$/,
        );
        if (definedMatch && !/^\($/.test(definedMatch[3] ?? '')) {
          const typeName = definedMatch[1]!;
          const underlying = definedMatch[3]!.replace(/\/\/.*$/, '').trim();
          const typeId = `scip-go gomod ${moduleName} 1.0.0 ${relPath}/${typeName}#`;
          registerType(typeName, typeId, pkgDir);
          if (!structIdByName.has(typeName)) structIdByName.set(typeName, typeId);
          if (includeFile) {
            addNode({
              id: typeId,
              kind: 'TypeAlias',
              name: typeName,
              qualifiedName: `${goPkgShort}.${typeName}`,
              packageName: pkgName,
              filePath: relPath,
              language: 'go',
              startLine: i + 1,
              startCol: 1,
              endLine: i + 1,
              endCol: 1,
              signature: `type ${typeName} ${definedMatch[2] ? '= ' : ''}${underlying}`,
              docstring: `Go ${definedMatch[2] ? 'type alias' : 'defined type'} ${goPkgShort}.${typeName}`,
              exported: /^[A-Z]/.test(typeName),
              complexity: 1,
              labels: ['TypeAlias', 'GoDefinedType'],
              properties: { underlying },
            });
            addEdge(fileId, typeId, 'CONTAINS', relPath, i + 1);
            pendingTypeRefs.push({
              srcId: typeId,
              typeExpr: underlying,
              pkgDir,
              filePath: relPath,
              line: i + 1,
              usage: 'underlying_type',
            });
          }
          continue;
        }

        // 3. Receiver method or function: `func (r *Recv) Name(args...) ... {` or `func Name[T any](args...) ... {`
        const funcMatch = line.match(
          /^\s*func\s+(?:\(\s*([A-Za-z0-9_]+)?\s*\*?([A-Za-z0-9_]+)(?:\[[^\]]+\])?\s*\)\s+)?([A-Za-z0-9_]+)(?:\[[^\]]+\])?\s*\(([^)]*)\)/,
        );
        if (funcMatch) {
          const recvVar = funcMatch[1];
          const recvType = funcMatch[2];
          const fnName = funcMatch[3]!;
          const fnArgs = funcMatch[4] ?? '';
          const startLine = i + 1;
          const endLine = findGoClosingBrace(lines, i);
          const bodySlice = lines.slice(i, endLine);
          const isTest = isTestFile && /^Test[A-Z0-9_]/.test(fnName);

          const fnId = recvType
            ? `scip-go gomod ${moduleName} 1.0.0 ${relPath}/${recvType}#${fnName}().`
            : `scip-go gomod ${moduleName} 1.0.0 ${relPath}/${fnName}().`;

          funcIdsByName.set(fnName, [...(funcIdsByName.get(fnName) ?? []), fnId]);

          if (includeFile) {
            const kind = isTest ? 'TestCase' : recvType ? 'Method' : 'Function';
            const qualifiedName = recvType ? `${recvType}.${fnName}` : `${goPkgShort}.${fnName}`;
            const sig = recvType
              ? `func (${recvVar ? recvVar + ' ' : ''}*${recvType}) ${fnName}(${fnArgs.trim()})`
              : `func ${fnName}(${fnArgs.trim()})`;

            addNode({
              id: fnId,
              kind,
              name: fnName,
              qualifiedName,
              packageName: pkgName,
              filePath: relPath,
              language: 'go',
              startLine,
              startCol: 1,
              endLine,
              endCol: 1,
              signature: sig,
              docstring: `Go ${kind.toLowerCase()} ${qualifiedName} in ${relPath}`,
              exported: /^[A-Z]/.test(fnName),
              complexity: computeGoComplexity(bodySlice),
              labels: [kind, isTest ? 'GoTestCase' : 'GoCallable'],
              properties: { receiverType: recvType ?? null },
            });

            if (isTest && suiteId) {
              addEdge(suiteId, fnId, 'CONTAINS', relPath, startLine);
            } else if (recvType) {
              // The receiver type may be declared in a file parsed later; resolve after pass 1.
              pendingReceiverContains.push({ recvType, fnId, pkgDir, filePath: relPath, line: startLine });
            } else {
              addEdge(fileId, fnId, 'CONTAINS', relPath, startLine);
            }

            callables.push({
              id: fnId,
              name: fnName,
              receiverVar: recvVar,
              receiverType: recvType,
              filePath: relPath,
              pkgName,
              startLine,
              endLine,
              isTest,
              bodyLines: bodySlice,
              pkgDir,
            });
          }
        }
      }
    }

    // Pass 1b: resolve deferred receiver containment and declaration-level type usages.
    for (const r of pendingReceiverContains) {
      const typeId = resolveType(r.recvType, r.pkgDir);
      const fileId = `scip-go gomod ${moduleName} 1.0.0 ${r.filePath}/`;
      addEdge(typeId ?? fileId, r.fnId, 'CONTAINS', r.filePath, r.line);
    }
    for (const ref of pendingTypeRefs) {
      for (const { name } of goTypeIdentifiers(ref.typeExpr)) {
        const typeId = resolveType(name, ref.pkgDir);
        if (typeId) {
          addEdge(ref.srcId, typeId, 'REFERENCES', ref.filePath, ref.line, { usage: ref.usage, type: name });
        }
      }
    }

    // Pass 2: Extract edges inside callables (routes, HTMX attributes, struct field reads/writes, calls, test coverage)
    const goKeywords = new Set([
      'if', 'for', 'switch', 'select', 'return', 'go', 'defer', 'make', 'new', 'len', 'cap',
      'append', 'copy', 'delete', 'close', 'panic', 'recover', 'string', 'int', 'int64',
      'float64', 'bool', 'byte', 'error', 'fmt', 'strings', 'strconv', 'time', 'context',
      'json', 'http', 'log', 'os', 'io', 'filepath', 'sync', 'errors',
    ]);

    for (const callable of callables) {
      const isTemplFile = callable.filePath.endsWith('.templ');

      for (let offset = 0; offset < callable.bodyLines.length; offset++) {
        const rawLine = callable.bodyLines[offset]!;
        const lineNo = callable.startLine + offset;

        if (isTemplFile) {
          // Extract HTMX route bindings: hx-get, hx-post, hx-delete, hx-put, action
          const htmxRegex = /\b(hx-get|hx-post|hx-delete|hx-put|hx-patch|action)\s*=\s*"([^"]+)"/g;
          let hm: RegExpExecArray | null;
          while ((hm = htmxRegex.exec(rawLine)) !== null) {
            const attr = hm[1]!;
            const rawUrl = hm[2]!.split('?')[0]!.trim();
            if (!rawUrl.startsWith('/')) continue;
            const method =
              attr === 'hx-post' || attr === 'action'
                ? 'POST'
                : attr === 'hx-delete'
                  ? 'DELETE'
                  : attr === 'hx-put'
                    ? 'PUT'
                    : attr === 'hx-patch'
                      ? 'PATCH'
                      : 'GET';
            const routeId = `scip-endpoint http ROUTE:${rawUrl}#`;
            if (!nodesMap.has(routeId)) {
              addNode({
                id: routeId,
                kind: 'RouteEndpoint',
                name: `HTTP ${rawUrl}`,
                qualifiedName: `${moduleName} HTTP ${rawUrl}`,
                packageName: callable.pkgName,
                filePath: callable.filePath,
                language: 'templ',
                startLine: lineNo,
                startCol: 1,
                endLine: lineNo,
                endCol: 1,
                signature: `${attr}="${rawUrl}"`,
                docstring: `HTTP route ${rawUrl} referenced by Templ component ${callable.name}`,
                exported: true,
                complexity: 1,
                labels: ['RouteEndpoint', 'HttpEndpoint', 'HtmxTarget'],
                properties: { method, path: rawUrl, attribute: attr },
              });
            }
            addEdge(callable.id, routeId, 'CALLS_ROUTE', callable.filePath, lineNo, {
              method,
              path: rawUrl,
              attribute: attr,
            });
          }
          continue;
        }

        const line = rawLine.replace(/\/\/.*$/, '');

        // 1. Detect Go HTTP route registrations: mux.HandleFunc("/admin/...", handler), r.GET("/...", handler)
        const handleMatch = line.match(
          /\b(?:HandleFunc|Handle|GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"\s*,\s*([A-Za-z0-9_.]+)/,
        );
        if (handleMatch) {
          const verbMatch = line.match(/\b(GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch)\s*\(/);
          const rawPattern = handleMatch[1]!.trim();
          const handlerExpr = handleMatch[2]!.trim();
          const parts = rawPattern.split(/\s+/);
          const method = verbMatch
            ? verbMatch[1]!.toUpperCase()
            : parts.length > 1
              ? parts[0]!.toUpperCase()
              : 'HTTP';
          const routePath = parts.length > 1 ? parts[1]! : parts[0]!;
          const routeId =
            method !== 'HTTP'
              ? `scip-endpoint http ${method}:${routePath}#`
              : `scip-endpoint http ROUTE:${routePath}#`;

          addNode({
            id: routeId,
            kind: 'RouteEndpoint',
            name: `${method} ${routePath}`,
            qualifiedName: `${moduleName} ${method} ${routePath}`,
            packageName: callable.pkgName,
            filePath: callable.filePath,
            language: 'go',
            startLine: lineNo,
            startCol: 1,
            endLine: lineNo,
            endCol: 1,
            signature: `${method} "${rawPattern}" -> ${handlerExpr}`,
            docstring: `Go HTTP route ${rawPattern} -> ${handlerExpr}`,
            exported: true,
            complexity: 1,
            labels: ['RouteEndpoint', 'HttpEndpoint', 'GoServeMuxRoute'],
            properties: { method, path: routePath, handler: handlerExpr },
          });

          const handlerShort = handlerExpr.split('.').pop()!;
          const handlerTargets = funcIdsByName.get(handlerShort) ?? [];
          if (handlerTargets.length > 0 && !callable.isTest) {
            for (const hId of handlerTargets) {
              addEdge(hId, routeId, 'HANDLES_ROUTE', callable.filePath, lineNo, {
                method,
                path: routePath,
              });
            }
          } else {
            addEdge(
              callable.id,
              routeId,
              callable.isTest ? 'TESTS_SYMBOL' : 'HANDLES_ROUTE',
              callable.filePath,
              lineNo,
              { method, path: routePath },
            );
          }
        }

        // 1b. Detect Go os.Getenv("VAR") / os.LookupEnv("VAR") environment bindings
        const envMatch = line.match(/\bos\.(?:Getenv|LookupEnv)\s*\(\s*"([A-Za-z0-9_]+)"\s*\)/);
        if (envMatch) {
          const envName = envMatch[1]!;
          const envId = `scip-env global env 1.0.0 ${envName}#`;
          if (!nodesMap.has(envId)) {
            addNode({
              id: envId,
              kind: 'EnvVar',
              name: envName,
              qualifiedName: `env::${envName}`,
              packageName: callable.pkgName,
              filePath: callable.filePath,
              language: 'go',
              startLine: lineNo,
              startCol: 1,
              endLine: lineNo,
              endCol: 1,
              signature: `os.Getenv("${envName}")`,
              docstring: `Environment variable ${envName}`,
              exported: true,
              complexity: 1,
              labels: ['EnvVar'],
              properties: {},
            });
          }
          addEdge(callable.id, envId, 'CONFIGURES_ENV', callable.filePath, lineNo, {
            envVar: envName,
          });
        }

        // 2. Receiver / struct field reads & writes: `r.Field = ...` or `r.Field`
        if (callable.receiverVar && callable.receiverType) {
          const recvRegex = new RegExp(`\\b${callable.receiverVar}\\.([A-Za-z0-9_]+)\\b`, 'g');
          let rm: RegExpExecArray | null;
          while ((rm = recvRegex.exec(line)) !== null) {
            const memberName = rm[1]!;
            const afterIdx = rm.index + rm[0].length;
            const rest = line.slice(afterIdx).trimStart();
            if (rest.startsWith('(')) continue; // Method call handled below

            const fieldId =
              fieldIdByStructAndName.get(`${callable.receiverType}.${memberName}`) ??
              fieldIdsByName.get(memberName)?.[0];
            if (fieldId) {
              const isWrite = /^(=|\+=|-=|\*=|\/=|\+\+|--)/.test(rest) && !rest.startsWith('==');
              addEdge(
                callable.id,
                fieldId,
                isWrite ? 'WRITES_PROPERTY' : 'READS_PROPERTY',
                callable.filePath,
                lineNo,
                { property: memberName },
              );
            }
          }
        }

        // 2c. Type usages: signature param/return types, composite literals (`T{`, `&T{`), conversions,
        //     var declarations, type assertions/switches, generic instantiation. Receivers are skipped
        //     (they are modelled as CONTAINS from the type to its methods).
        if (offset === 0) {
          const sigMatch = line.match(
            /^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z0-9_]+(?:\[[^\]]+\])?\s*\(([^)]*)\)(.*)$/,
          );
          if (sigMatch) {
            const params = sigMatch[1] ?? '';
            const results = (sigMatch[2] ?? '').replace(/\{\s*$/, '');
            for (const [expr, kind, usage] of [
              [params, 'HAS_PARAMETER_TYPE', 'parameter_type'],
              [results, 'RETURNS_TYPE', 'return_type'],
            ] as const) {
              for (const { name } of goTypeIdentifiers(expr)) {
                const typeId = resolveType(name, callable.pkgDir);
                if (!typeId) continue;
                addEdge(callable.id, typeId, kind, callable.filePath, lineNo, { type: name });
                addEdge(callable.id, typeId, 'REFERENCES', callable.filePath, lineNo, { usage, type: name });
                if (callable.isTest) addEdge(callable.id, typeId, 'TESTS_SYMBOL', callable.filePath, lineNo);
              }
            }
          }
        } else {
          for (const { name, composite, typeContext } of goTypeIdentifiers(line, callable.receiverVar)) {
            // Unexported type names are commonly shadowed by same-named locals (`router := ...`),
            // so only count them in unambiguous type positions.
            if (/^[a-z_]/.test(name) && !typeContext) continue;
            const typeId = resolveType(name, callable.pkgDir);
            if (!typeId) continue;
            addEdge(callable.id, typeId, 'REFERENCES', callable.filePath, lineNo, {
              usage: composite ? 'composite_literal' : 'type_ref',
              type: name,
            });
            if (callable.isTest) addEdge(callable.id, typeId, 'TESTS_SYMBOL', callable.filePath, lineNo);
          }
        }

        // 3. Function & Method Calls: `foo(...)` or `obj.Bar(...)`
        const callRegex = /\b(?:([A-Za-z0-9_]+)\.)?([A-Za-z0-9_]+)\s*\(/g;
        let cm: RegExpExecArray | null;
        while ((cm = callRegex.exec(line)) !== null) {
          const calleeName = cm[2]!;
          if (goKeywords.has(calleeName) || calleeName === callable.name) continue;
          const targets = funcIdsByName.get(calleeName);
          if (targets && targets.length > 0) {
            const targetId = targets[0]!;
            addEdge(callable.id, targetId, 'CALLS', callable.filePath, lineNo);
            if (callable.isTest) {
              addEdge(callable.id, targetId, 'TESTS_SYMBOL', callable.filePath, lineNo);
            }
          }
        }
      }
    }

    return {
      compiler: this.name,
      files: filesBatch,
      nodes: [...nodesMap.values()],
      edges: [...edgesMap.values()],
      diagnostics: [],
    };
  }
}
