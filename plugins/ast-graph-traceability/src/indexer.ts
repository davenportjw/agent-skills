import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type * as tsNs from 'typescript';
import { PythonCompilerAdapter } from './adapters/python-adapter.js';
import { TerraformCompilerAdapter } from './adapters/terraform-adapter.js';
import { TypeScriptCompilerAdapter, resolveTypeScriptModule } from './adapters/ts-adapter.js';

declare namespace ts {
  export type Node = tsNs.Node;
  export type SourceFile = tsNs.SourceFile;
}

const ts: typeof tsNs = resolveTypeScriptModule();
import type { AstGraphDatabase } from './db.js';
import type {
  CompilerGraphBatch,
  EdgeKind,
  GraphEdgeRecord,
  GraphFileRecord,
  GraphNodeRecord,
  NodeKind,
  ScipSymbolUri,
} from './types.js';

export interface SyncResult {
  mode: 'full' | 'incremental' | 'noop';
  durationMs: number;
  filesScanned: number;
  filesUpdated: number;
  filesDeleted: number;
  totals: {
    files: number;
    nodes: number;
    edges: number;
    diagnostics: number;
    packages: number;
  };
}

export class AstGraphIndexer {
  public readonly workspaceRoot: string;
  public readonly db: AstGraphDatabase;
  public readonly tsAdapter: TypeScriptCompilerAdapter;
  public readonly tfAdapter: TerraformCompilerAdapter;
  public readonly pyAdapter: PythonCompilerAdapter;

  constructor(workspaceRoot: string, db: AstGraphDatabase) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.db = db;
    this.tsAdapter = new TypeScriptCompilerAdapter();
    this.tfAdapter = new TerraformCompilerAdapter();
    this.pyAdapter = new PythonCompilerAdapter();
  }

  public normalizeRelPath(filePath: string): string {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspaceRoot, filePath);
    return path.relative(this.workspaceRoot, abs).split(path.sep).join('/');
  }

  public discoverAllCandidateFiles(): string[] {
    const tsFiles = this.tsAdapter.discoverAllSourceFiles(this.workspaceRoot);
    const tfFiles = this.tfAdapter.discoverTfFiles(this.workspaceRoot);
    const pyFiles = this.pyAdapter.discoverPythonFiles(this.workspaceRoot);
    return [...tsFiles, ...tfFiles, ...pyFiles];
  }

  /**
   * Fast (<3ms) check comparing filesystem mtimeMs and SHA-256 against tracked files in SQLite.
   * Automatically incrementally re-indexes any modified/added/deleted files.
   */
  public lazySyncIfDirty(options?: { targetFileHint?: string }): SyncResult {
    const t0 = performance.now();
    const tracked = this.db.getTrackedFilesMap();
    if (tracked.size === 0) {
      return this.syncWorkspace({ full: true });
    }

    // Fast path for target-scoped queries (e.g., outline <file>): only stat/sync the requested file if tracked
    if (options?.targetFileHint) {
      const cleanHint = options.targetFileHint.replace(/\\/g, '/').replace(/^\.\//, '');
      let matchedRel: string | null = null;
      if (tracked.has(cleanHint)) {
        matchedRel = cleanHint;
      } else {
        for (const rel of tracked.keys()) {
          if (rel.endsWith(cleanHint)) {
            matchedRel = rel;
            break;
          }
        }
      }
      if (matchedRel) {
        const absPath = path.join(this.workspaceRoot, matchedRel);
        const prev = tracked.get(matchedRel);
        try {
          const stat = fs.statSync(absPath);
          if (!prev || Math.abs(stat.mtimeMs - prev.mtimeMs) > 1) {
            const content = fs.readFileSync(absPath, 'utf8');
            const sha256 = crypto.createHash('sha256').update(content).digest('hex');
            if (!prev || sha256 !== prev.sha256) {
              return this.syncWorkspace({ full: false, targetPaths: [matchedRel] });
            }
          }
          return {
            mode: 'noop',
            durationMs: performance.now() - t0,
            filesScanned: 1,
            filesUpdated: 0,
            filesDeleted: 0,
            totals: this.db.getCounts(),
          };
        } catch {
          // Fall through to full candidate check if file was moved/deleted
        }
      }
    }

    const candidates = this.discoverAllCandidateFiles();
    const currentRelSet = new Set<string>();
    const dirtyRelPaths: string[] = [];

    for (const absPath of candidates) {
      const relPath = this.normalizeRelPath(absPath);
      currentRelSet.add(relPath);
      const prev = tracked.get(relPath);
      try {
        const stat = fs.statSync(absPath);
        if (!prev || Math.abs(stat.mtimeMs - prev.mtimeMs) > 1) {
          const content = fs.readFileSync(absPath, 'utf8');
          const sha256 = crypto.createHash('sha256').update(content).digest('hex');
          if (!prev || sha256 !== prev.sha256) {
            dirtyRelPaths.push(relPath);
          }
        }
      } catch {
        // File might have been removed mid-scan
      }
    }

    const deletedCount = this.db.removeDeletedFiles(currentRelSet);
    if (dirtyRelPaths.length === 0 && deletedCount === 0) {
      return {
        mode: 'noop',
        durationMs: performance.now() - t0,
        filesScanned: candidates.length,
        filesUpdated: 0,
        filesDeleted: 0,
        totals: this.db.getCounts(),
      };
    }

    if (dirtyRelPaths.length > 0) {
      return this.syncWorkspace({ full: false, targetPaths: dirtyRelPaths });
    }

    const durationMs = performance.now() - t0;
    this.db.recordSyncRun({
      durationMs,
      mode: 'incremental',
      filesScanned: candidates.length,
      filesUpdated: 0,
    });
    return {
      mode: 'incremental',
      durationMs,
      filesScanned: candidates.length,
      filesUpdated: 0,
      filesDeleted: deletedCount,
      totals: this.db.getCounts(),
    };
  }

  private acquireSyncLock(): (() => void) | null {
    const lockPath = path.join(path.dirname(this.db.dbPath), 'sync.lock');
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      if (fs.existsSync(lockPath)) {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs < 15000) {
          return null;
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Ignore stale lock removal race
        }
      }
      fs.writeFileSync(lockPath, `${process.pid}:${Date.now()}`, { flag: 'wx' });
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Ignore cleanup race
        }
      };
    } catch {
      return null;
    }
  }

  public syncWorkspace(options: {
    full?: boolean;
    targetPaths?: string[];
    force?: boolean;
    exportSnapshots?: boolean;
  } = {}): SyncResult {
    const t0 = performance.now();
    const tracked = this.db.getTrackedFilesMap();
    const isCold = tracked.size === 0 || Boolean(options.full);
    const releaseLock = this.acquireSyncLock();
    if (!releaseLock && !options.force && tracked.size > 0) {
      return {
        mode: 'noop',
        durationMs: performance.now() - t0,
        filesScanned: 0,
        filesUpdated: 0,
        filesDeleted: 0,
        totals: this.db.getCounts(),
      };
    }

    try {
      if (isCold) {
        const candidates = this.discoverAllCandidateFiles();
        const currentRelSet = new Set(candidates.map((c) => this.normalizeRelPath(c)));
        const deletedCount = this.db.removeDeletedFiles(currentRelSet);

        const tsBatch = this.tsAdapter.extract(this.workspaceRoot);
        this.db.applyBatch(tsBatch, true);

        const tfBatch = this.tfAdapter.extract(this.workspaceRoot);
        this.db.applyBatch(tfBatch, true);

        const pyBatch = this.pyAdapter.extract(this.workspaceRoot);
        if (pyBatch.files.length > 0) {
          this.db.applyBatch(pyBatch, true);
        }

        if (options.exportSnapshots !== false) {
          this.db.exportGraph(path.dirname(this.db.dbPath));
        }

        const durationMs = performance.now() - t0;
        const updatedCount = tsBatch.files.length + tfBatch.files.length + pyBatch.files.length;
        this.db.recordSyncRun({
          durationMs,
          mode: 'full',
          filesScanned: candidates.length,
          filesUpdated: updatedCount,
        });

        return {
          mode: 'full',
          durationMs,
          filesScanned: candidates.length,
          filesUpdated: updatedCount,
          filesDeleted: deletedCount,
          totals: this.db.getCounts(),
        };
      }

      // Incremental sync for targetPaths (or auto-discovered dirty files)
      const rawTargets =
        options.targetPaths && options.targetPaths.length > 0
          ? options.targetPaths.map((p) => this.normalizeRelPath(p))
          : this.discoverAllCandidateFiles().map((p) => this.normalizeRelPath(p));

      const tsTargets: string[] = [];
      const tfTargets: string[] = [];
      const pyTargets: string[] = [];
      let deletedCount = 0;

      for (const relPath of rawTargets) {
        const absPath = path.join(this.workspaceRoot, relPath);
        if (!fs.existsSync(absPath)) {
          // File was deleted
          const allTracked = new Set(tracked.keys());
          allTracked.delete(relPath);
          deletedCount += this.db.removeDeletedFiles(allTracked);
          continue;
        }

        if (!options.force) {
          const prev = tracked.get(relPath);
          if (prev) {
            const content = fs.readFileSync(absPath, 'utf8');
            const sha256 = crypto.createHash('sha256').update(content).digest('hex');
            if (sha256 === prev.sha256) {
              continue;
            }
          }
        }

        if (this.tsAdapter.supportsFile(relPath)) {
          tsTargets.push(relPath);
        } else if (this.tfAdapter.supportsFile(relPath)) {
          tfTargets.push(relPath);
        } else if (this.pyAdapter.supportsFile(relPath)) {
          pyTargets.push(relPath);
        }
      }

      let filesUpdated = 0;

      if (tsTargets.length > 0) {
        if (tsTargets.length <= 32 && tracked.size > 0) {
          // Fast incremental AST + symbol-table resolution (<45ms for up to 32 files)
          const fastBatch = this.extractFastIncrementalTsBatch(tsTargets);
          this.db.applyBatch(fastBatch, true);
          filesUpdated += fastBatch.files.length;
        } else {
          const tsBatch = this.tsAdapter.extract(this.workspaceRoot, tsTargets);
          this.db.applyBatch(tsBatch, true);
          filesUpdated += tsBatch.files.length;
        }
      }

      if (tfTargets.length > 0) {
        const tfBatch = this.tfAdapter.extract(this.workspaceRoot, tfTargets);
        this.db.applyBatch(tfBatch, true);
        filesUpdated += tfBatch.files.length;
      }

      if (pyTargets.length > 0) {
        const pyBatch = this.pyAdapter.extract(this.workspaceRoot, pyTargets);
        this.db.applyBatch(pyBatch, true);
        filesUpdated += pyBatch.files.length;
      }

      if (options.exportSnapshots) {
        this.db.exportGraph(path.dirname(this.db.dbPath));
      }

      const durationMs = performance.now() - t0;
      this.db.recordSyncRun({
        durationMs,
        mode: filesUpdated > 0 || deletedCount > 0 ? 'incremental' : 'noop',
        filesScanned: rawTargets.length,
        filesUpdated,
      });

      return {
        mode: filesUpdated > 0 || deletedCount > 0 ? 'incremental' : 'noop',
        durationMs,
        filesScanned: rawTargets.length,
        filesUpdated,
        filesDeleted: deletedCount,
        totals: this.db.getCounts(),
      };
    } finally {
      releaseLock?.();
    }
  }

  /**
   * Sub-30ms incremental single-file TypeScript AST parser & graph linker.
   * Uses ts.createSourceFile + the existing SQLite symbol table to resolve cross-file
   * calls, references, Zod schemas, Fastify routes, and Vitest test lineage without
   * re-parsing all of node_modules/@types.
   */
  private extractFastIncrementalTsBatch(relPaths: string[]): CompilerGraphBatch {
    const pkgs = this.tsAdapter.discoverWorkspacePackages(this.workspaceRoot);
    const findPkg = (relPath: string) => {
      for (const p of pkgs) {
        if (relPath === p.relDir || relPath.startsWith(`${p.relDir}/`)) return p;
      }
      return {
        name: 'warehouse-root',
        version: '0.1.0',
        relDir: '.',
        absDir: this.workspaceRoot,
        entryRelPath: relPath,
      };
    };

    // Load known exported symbol names -> SCIP IDs from SQLite for cross-file resolution
    const knownRows = this.db.db
      .prepare(
        `SELECT id, name, kind, file_path
         FROM nodes
         WHERE kind NOT IN ('WorkspacePackage', 'TestCase', 'TestSuite')
         ORDER BY exported DESC`,
      )
      .all() as Array<{ id: string; name: string; kind: string; file_path: string }>;

    const symbolByName = new Map<string, string>();
    const propertyByName = new Map<string, string>();
    const fileIdByRelPath = new Map<string, string>();
    for (const r of knownRows) {
      if (r.kind === 'File') {
        fileIdByRelPath.set(r.file_path, r.id);
      } else if (r.kind === 'Property') {
        if (!propertyByName.has(r.name)) {
          propertyByName.set(r.name, r.id);
        }
      } else if (!symbolByName.has(r.name)) {
        symbolByName.set(r.name, r.id);
      }
    }

    const filesBatch: GraphFileRecord[] = [];
    const nodesMap = new Map<string, GraphNodeRecord>();
    const edgesMap = new Map<string, GraphEdgeRecord>();

    const addNode = (n: GraphNodeRecord) => nodesMap.set(n.id, n);
    const addEdge = (e: GraphEdgeRecord) => {
      if (!e.srcId || !e.dstId || e.srcId === e.dstId) return;
      edgesMap.set(`${e.srcId}|${e.dstId}|${e.kind}|${e.filePath}|${e.line}`, e);
    };

    for (const relPath of relPaths) {
      const absPath = path.join(this.workspaceRoot, relPath);
      if (!fs.existsSync(absPath)) continue;
      const stat = fs.statSync(absPath);
      const content = fs.readFileSync(absPath, 'utf8');
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const lineCount = content.split('\n').length;
      const pkg = findPkg(relPath);
      const language = relPath.endsWith('.mjs') ? 'javascript' : 'typescript';
      const isTestFile = relPath.endsWith('.test.ts') || relPath.includes('/test/');

      filesBatch.push({
        filePath: relPath,
        packageName: pkg.name,
        language,
        sha256,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        lineCount,
      });

      const pkgNodeId = `scip-ts npm ${pkg.name} ${pkg.version} package#`;
      const fileNodeId = `scip-ts npm ${pkg.name} ${pkg.version} ${relPath}/`;
      const makeSymId = (desc: string): ScipSymbolUri =>
        `scip-ts npm ${pkg.name} ${pkg.version} ${relPath}/${desc}`;

      addNode({
        id: fileNodeId,
        kind: 'File',
        name: path.basename(relPath),
        qualifiedName: relPath,
        packageName: pkg.name,
        filePath: relPath,
        language,
        startLine: 1,
        startCol: 1,
        endLine: lineCount,
        endCol: 1,
        signature: `file ${relPath}`,
        docstring: `Source file ${relPath} in ${pkg.name}`,
        exported: true,
        complexity: 1,
        labels: isTestFile ? ['File', 'TestFile'] : ['File'],
        properties: { sizeBytes: stat.size, lineCount },
      });

      addEdge({
        srcId: pkgNodeId,
        dstId: fileNodeId,
        kind: 'CONTAINS',
        filePath: relPath,
        line: 1,
        col: 1,
        weight: 1,
        properties: {},
      });

      const sf = ts.createSourceFile(absPath, content, ts.ScriptTarget.ES2023, true);
      const posToLineCol = (pos: number) => {
        const lc = sf.getLineAndCharacterOfPosition(pos);
        return { line: lc.line + 1, col: lc.character + 1 };
      };

      // Pre-register local declarations in this file
      const visitLocalDecls = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name) {
          symbolByName.set(node.name.text, makeSymId(`${node.name.text}().`));
        } else if (ts.isClassDeclaration(node) && node.name) {
          const className = node.name.text;
          symbolByName.set(className, makeSymId(`${className}#`));
          for (const member of node.members) {
            if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
              propertyByName.set(member.name.text, makeSymId(`${className}#${member.name.text}.`));
            } else if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
              symbolByName.set(member.name.text, makeSymId(`${className}#${member.name.text}().`));
            }
          }
        } else if (ts.isInterfaceDeclaration(node) && node.name) {
          const ifaceName = node.name.text;
          symbolByName.set(ifaceName, makeSymId(`${ifaceName}#`));
          for (const member of node.members) {
            if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
              propertyByName.set(member.name.text, makeSymId(`${ifaceName}#${member.name.text}.`));
            }
          }
        } else if (ts.isTypeAliasDeclaration(node) && node.name) {
          symbolByName.set(node.name.text, makeSymId(`${node.name.text}#`));
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          symbolByName.set(node.name.text, makeSymId(`${node.name.text}.`));
        }
        ts.forEachChild(node, visitLocalDecls);
      };
      ts.forEachChild(sf, visitLocalDecls);

      const symbolStack: Array<{ id: ScipSymbolUri; kind: NodeKind; name: string }> = [
        { id: fileNodeId, kind: 'File', name: path.basename(relPath) },
      ];
      const currentEnclosing = () => symbolStack[symbolStack.length - 1]!;
      const currentTestContext = () => {
        for (let i = symbolStack.length - 1; i >= 0; i--) {
          if (symbolStack[i]!.kind === 'TestCase' || symbolStack[i]!.kind === 'TestSuite') {
            return symbolStack[i]!;
          }
        }
        return null;
      };

      const visit = (node: ts.Node): void => {
        const startPos = posToLineCol(node.getStart(sf));
        const endPos = posToLineCol(node.getEnd());

        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          for (const p of pkgs) {
            if (spec === p.name || spec.startsWith(`${p.name}/`)) {
              const dstFileId =
                fileIdByRelPath.get(p.entryRelPath) ??
                `scip-ts npm ${p.name} ${p.version} ${p.entryRelPath}/`;
              addEdge({
                srcId: fileNodeId,
                dstId: dstFileId,
                kind: 'IMPORTS',
                filePath: relPath,
                line: startPos.line,
                col: startPos.col,
                weight: 1,
                properties: { specifier: spec },
              });
            }
          }
        }

        if (ts.isFunctionDeclaration(node) && node.name) {
          const fnName = node.name.text;
          const fnId = makeSymId(`${fnName}().`);
          const exported = Boolean(
            ts.canHaveModifiers(node) &&
              ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
          );
          addNode({
            id: fnId,
            kind: 'Function',
            name: fnName,
            qualifiedName: `${pkg.name}/${fnName}`,
            packageName: pkg.name,
            filePath: relPath,
            language,
            startLine: startPos.line,
            startCol: startPos.col,
            endLine: endPos.line,
            endCol: endPos.col,
            signature: node.getText(sf).split('{')[0]?.replace(/\s+/g, ' ').trim().slice(0, 240) ?? `function ${fnName}()`,
            docstring: '',
            exported,
            complexity: 1,
            labels: ['Function'],
            properties: {},
          });
          addEdge({
            srcId: currentEnclosing().id,
            dstId: fnId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startPos.line,
            col: startPos.col,
            weight: 1,
            properties: {},
          });
          if (exported) {
            addEdge({
              srcId: fileNodeId,
              dstId: fnId,
              kind: 'EXPORTS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: {},
            });
          }
          symbolStack.push({ id: fnId, kind: 'Function', name: fnName });
          ts.forEachChild(node, visit);
          symbolStack.pop();
          return;
        }

        if (ts.isClassDeclaration(node) && node.name) {
          const className = node.name.text;
          const classId = makeSymId(`${className}#`);
          const exported = Boolean(
            ts.canHaveModifiers(node) &&
              ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
          );
          addNode({
            id: classId,
            kind: 'Class',
            name: className,
            qualifiedName: `${pkg.name}/${className}`,
            packageName: pkg.name,
            filePath: relPath,
            language,
            startLine: startPos.line,
            startCol: startPos.col,
            endLine: endPos.line,
            endCol: endPos.col,
            signature: `class ${className}`,
            docstring: '',
            exported,
            complexity: 1,
            labels: ['Class'],
            properties: {},
          });
          addEdge({
            srcId: currentEnclosing().id,
            dstId: classId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startPos.line,
            col: startPos.col,
            weight: 1,
            properties: {},
          });
          symbolStack.push({ id: classId, kind: 'Class', name: className });
          ts.forEachChild(node, visit);
          symbolStack.pop();
          return;
        }

        if (ts.isInterfaceDeclaration(node) && node.name) {
          const ifaceName = node.name.text;
          const ifaceId = makeSymId(`${ifaceName}#`);
          const exported = Boolean(
            ts.canHaveModifiers(node) &&
              ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
          );
          addNode({
            id: ifaceId,
            kind: 'Interface',
            name: ifaceName,
            qualifiedName: `${pkg.name}/${ifaceName}`,
            packageName: pkg.name,
            filePath: relPath,
            language,
            startLine: startPos.line,
            startCol: startPos.col,
            endLine: endPos.line,
            endCol: endPos.col,
            signature: `interface ${ifaceName}`,
            docstring: '',
            exported,
            complexity: 1,
            labels: ['Interface'],
            properties: {},
          });
          addEdge({
            srcId: currentEnclosing().id,
            dstId: ifaceId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startPos.line,
            col: startPos.col,
            weight: 1,
            properties: {},
          });
          symbolStack.push({ id: ifaceId, kind: 'Interface', name: ifaceName });
          ts.forEachChild(node, visit);
          symbolStack.pop();
          return;
        }

        if (ts.isTypeAliasDeclaration(node) && node.name) {
          const typeName = node.name.text;
          const typeId = makeSymId(`${typeName}#`);
          const exported = Boolean(
            ts.canHaveModifiers(node) &&
              ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
          );
          addNode({
            id: typeId,
            kind: 'TypeAlias',
            name: typeName,
            qualifiedName: `${pkg.name}/${typeName}`,
            packageName: pkg.name,
            filePath: relPath,
            language,
            startLine: startPos.line,
            startCol: startPos.col,
            endLine: endPos.line,
            endCol: endPos.col,
            signature: node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 200),
            docstring: '',
            exported,
            complexity: 1,
            labels: ['TypeAlias'],
            properties: {},
          });
          addEdge({
            srcId: currentEnclosing().id,
            dstId: typeId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startPos.line,
            col: startPos.col,
            weight: 1,
            properties: {},
          });
        }

        if (ts.isMethodDeclaration(node) && node.name) {
          const methodName = node.name.getText(sf);
          const enclosing = currentEnclosing();
          const methodId = makeSymId(`${enclosing.name}#${methodName}().`);
          addNode({
            id: methodId,
            kind: 'Method',
            name: methodName,
            qualifiedName: `${enclosing.name}.${methodName}`,
            packageName: pkg.name,
            filePath: relPath,
            language,
            startLine: startPos.line,
            startCol: startPos.col,
            endLine: endPos.line,
            endCol: endPos.col,
            signature: `${enclosing.name}.${methodName}()`,
            docstring: '',
            exported: true,
            complexity: 1,
            labels: ['Method'],
            properties: {},
          });
          addEdge({
            srcId: enclosing.id,
            dstId: methodId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startPos.line,
            col: startPos.col,
            weight: 1,
            properties: {},
          });
          symbolStack.push({ id: methodId, kind: 'Method', name: `${enclosing.name}.${methodName}` });
          ts.forEachChild(node, visit);
          symbolStack.pop();
          return;
        }

        if (
          (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) &&
          node.name &&
          ts.isIdentifier(node.name)
        ) {
          const propName = node.name.text;
          const enclosing = currentEnclosing();
          if (enclosing.kind === 'Class' || enclosing.kind === 'Interface') {
            const propId = makeSymId(`${enclosing.name}#${propName}.`);
            propertyByName.set(propName, propId);
            addNode({
              id: propId,
              kind: 'Property',
              name: propName,
              qualifiedName: `${pkg.name}/${enclosing.name}.${propName}`,
              packageName: pkg.name,
              filePath: relPath,
              language,
              startLine: startPos.line,
              startCol: startPos.col,
              endLine: endPos.line,
              endCol: endPos.col,
              signature: node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 200),
              docstring: '',
              exported: true,
              complexity: 1,
              labels: ['Property'],
              properties: { container: enclosing.name, containerKind: enclosing.kind },
            });
            addEdge({
              srcId: enclosing.id,
              dstId: propId,
              kind: 'CONTAINS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: {},
            });
          }
        }

        if (ts.isVariableStatement(node)) {
          const exported = Boolean(
            ts.canHaveModifiers(node) &&
              ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
          );
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && (exported || currentEnclosing().kind === 'File')) {
              const varName = decl.name.text;
              const initText = decl.initializer ? decl.initializer.getText(sf) : '';
              const isZod = initText.includes('z.') || varName.endsWith('Schema');
              const varId = makeSymId(`${varName}.`);
              const kind: NodeKind = isZod ? 'ZodSchema' : 'Variable';
              const dStart = posToLineCol(decl.getStart(sf));
              const dEnd = posToLineCol(decl.getEnd());
              addNode({
                id: varId,
                kind,
                name: varName,
                qualifiedName: `${pkg.name}/${varName}`,
                packageName: pkg.name,
                filePath: relPath,
                language,
                startLine: dStart.line,
                startCol: dStart.col,
                endLine: dEnd.line,
                endCol: dEnd.col,
                signature: `${exported ? 'export ' : ''}const ${varName}`,
                docstring: '',
                exported,
                complexity: 1,
                labels: isZod ? ['ZodSchema', 'Variable'] : ['Variable'],
                properties: {},
              });
              addEdge({
                srcId: currentEnclosing().id,
                dstId: varId,
                kind: 'CONTAINS',
                filePath: relPath,
                line: dStart.line,
                col: dStart.col,
                weight: 1,
                properties: {},
              });
              if (decl.initializer) {
                symbolStack.push({ id: varId, kind, name: varName });
                visit(decl.initializer);
                symbolStack.pop();
              }
            } else if (decl.initializer) {
              visit(decl.initializer);
            }
          }
          return;
        }

        if (ts.isCallExpression(node) && isTestFile) {
          const exprText = node.expression.getText(sf);
          const isSuite = exprText === 'describe' || exprText.startsWith('describe.');
          const isTest = exprText === 'it' || exprText.startsWith('it.') || exprText === 'test';
          if ((isSuite || isTest) && node.arguments.length >= 2) {
            const firstArg = node.arguments[0]!;
            const title = ts.isStringLiteralLike(firstArg) ? firstArg.text : firstArg.getText(sf);
            const testKind: NodeKind = isSuite ? 'TestSuite' : 'TestCase';
            const slug = title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
            const testId = makeSymId(`${testKind}:${slug}:${startPos.line}#`);
            addNode({
              id: testId,
              kind: testKind,
              name: title,
              qualifiedName: `${relPath}::${title}`,
              packageName: pkg.name,
              filePath: relPath,
              language,
              startLine: startPos.line,
              startCol: startPos.col,
              endLine: endPos.line,
              endCol: endPos.col,
              signature: `${exprText}('${title}')`,
              docstring: '',
              exported: false,
              complexity: 1,
              labels: [testKind, 'Vitest'],
              properties: {},
            });
            addEdge({
              srcId: currentEnclosing().id,
              dstId: testId,
              kind: 'CONTAINS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: {},
            });
            symbolStack.push({ id: testId, kind: testKind, name: title });
            ts.forEachChild(node, visit);
            symbolStack.pop();
            return;
          }
        }

        if (ts.isCallExpression(node)) {
          const enclosing = currentEnclosing();
          if (ts.isPropertyAccessExpression(node.expression)) {
            const objText = node.expression.expression.getText(sf);
            const propName = node.expression.name.text;
            const httpMethods = new Set(['get', 'post', 'put', 'delete', 'patch', 'all']);
            if (
              (objText === 'app' || objText === 'fastify' || objText === 'server') &&
              httpMethods.has(propName) &&
              node.arguments.length >= 1
            ) {
              const routeArg = node.arguments[0]!;
              if (ts.isStringLiteralLike(routeArg)) {
                const routePath = routeArg.text;
                const methodUpper = propName.toUpperCase();
                const routeId: ScipSymbolUri = `scip-endpoint http ${pkg.name} ${pkg.version} ${methodUpper}:${routePath}#`;
                addNode({
                  id: routeId,
                  kind: 'RouteEndpoint',
                  name: `${methodUpper} ${routePath}`,
                  qualifiedName: `${pkg.name} ${methodUpper} ${routePath}`,
                  packageName: pkg.name,
                  filePath: relPath,
                  language,
                  startLine: startPos.line,
                  startCol: startPos.col,
                  endLine: endPos.line,
                  endCol: endPos.col,
                  signature: `${objText}.${propName}('${routePath}', handler)`,
                  docstring: `Fastify HTTP ${methodUpper} endpoint ${routePath} in ${pkg.name}`,
                  exported: true,
                  complexity: 1,
                  labels: ['RouteEndpoint', 'HttpEndpoint'],
                  properties: { method: methodUpper, path: routePath },
                });
                addEdge({
                  srcId: enclosing.id,
                  dstId: routeId,
                  kind: 'HANDLES_ROUTE',
                  filePath: relPath,
                  line: startPos.line,
                  col: startPos.col,
                  weight: 1,
                  properties: { method: methodUpper, path: routePath },
                });
              }
            }
          }

          if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
            const firstArg = node.arguments[0];
            if (firstArg) {
              const argText = firstArg.getText(sf);
              const routeMatch = argText.match(/\/(api\/[a-zA-Z0-9/_-]+|internal\/[a-zA-Z0-9/_-]+|healthz|readyz)/);
              if (routeMatch) {
                const routePath = `/${routeMatch[1]}`;
                const methodGuess = argText.includes('POST') || node.getText(sf).includes('POST') ? 'POST' : 'GET';
                const endpointId: ScipSymbolUri = `scip-endpoint http @warehouse/lobby 0.1.0 ${methodGuess}:${routePath}#`;
                addEdge({
                  srcId: enclosing.id,
                  dstId: endpointId,
                  kind: 'CONNECTS_ENDPOINT',
                  filePath: relPath,
                  line: startPos.line,
                  col: startPos.col,
                  weight: 1,
                  properties: { path: routePath },
                });
              }
            }
          }

          const calleeName = ts.isIdentifier(node.expression)
            ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : null;
          if (calleeName) {
            const targetId = symbolByName.get(calleeName);
            if (targetId) {
              const testCtx = currentTestContext();
              const edgeKind: EdgeKind =
                calleeName === 'parse' || calleeName === 'safeParse' ? 'VALIDATES_SCHEMA' : 'CALLS';
              addEdge({
                srcId: enclosing.id,
                dstId: targetId,
                kind: edgeKind,
                filePath: relPath,
                line: startPos.line,
                col: startPos.col,
                weight: 1,
                properties: {},
              });
              if (testCtx) {
                addEdge({
                  srcId: testCtx.id,
                  dstId: targetId,
                  kind: 'TESTS_SYMBOL',
                  filePath: relPath,
                  line: startPos.line,
                  col: startPos.col,
                  weight: 1,
                  properties: {},
                });
              }
            }
          }
        }

        const isWriteExpr = (expr: ts.Node): boolean => {
          const parent = expr.parent;
          if (!parent) return false;
          if (
            ts.isBinaryExpression(parent) &&
            parent.left === expr &&
            parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ) {
            return true;
          }
          if (
            (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
            (parent.operator === ts.SyntaxKind.PlusPlusToken ||
              parent.operator === ts.SyntaxKind.MinusMinusToken)
          ) {
            return true;
          }
          if (ts.isDeleteExpression(parent) && parent.expression === expr) {
            return true;
          }
          return false;
        };

        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
          const propName = node.name.text;
          const targetId = propertyByName.get(propName);
          if (targetId) {
            const enclosing = currentEnclosing();
            const testCtx = currentTestContext();
            if (targetId !== enclosing.id) {
              const edgeKind = isWriteExpr(node) ? 'WRITES_PROPERTY' : 'READS_PROPERTY';
              addEdge({
                srcId: enclosing.id,
                dstId: targetId,
                kind: edgeKind,
                filePath: relPath,
                line: startPos.line,
                col: startPos.col,
                weight: edgeKind === 'WRITES_PROPERTY' ? 1 : 0.75,
                properties: { property: propName },
              });
              if (testCtx && !targetId.includes('.test.ts')) {
                addEdge({
                  srcId: testCtx.id,
                  dstId: targetId,
                  kind: 'TESTS_SYMBOL',
                  filePath: relPath,
                  line: startPos.line,
                  col: startPos.col,
                  weight: 1,
                  properties: {},
                });
              }
            }
          }
        }

        if (
          ts.isIdentifier(node) &&
          !(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        ) {
          const targetId = symbolByName.get(node.text);
          if (targetId) {
            const enclosing = currentEnclosing();
            const testCtx = currentTestContext();
            if (targetId !== enclosing.id) {
              const edgeKind = isWriteExpr(node) ? 'WRITES_PROPERTY' : 'REFERENCES';
              addEdge({
                srcId: enclosing.id,
                dstId: targetId,
                kind: edgeKind,
                filePath: relPath,
                line: startPos.line,
                col: startPos.col,
                weight: edgeKind === 'WRITES_PROPERTY' ? 1 : 0.5,
                properties: {},
              });
              if (testCtx && !targetId.includes('.test.ts')) {
                addEdge({
                  srcId: testCtx.id,
                  dstId: targetId,
                  kind: 'TESTS_SYMBOL',
                  filePath: relPath,
                  line: startPos.line,
                  col: startPos.col,
                  weight: 1,
                  properties: {},
                });
              }
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      ts.forEachChild(sf, visit);
    }

    return {
      compiler: 'typescript-incremental',
      files: filesBatch,
      nodes: [...nodesMap.values()],
      edges: [...edgesMap.values()],
      diagnostics: [],
    };
  }
}
