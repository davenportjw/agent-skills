import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CompilerAdapter,
  CompilerGraphBatch,
  GraphEdgeRecord,
  GraphFileRecord,
  GraphNodeRecord,
} from '../types.js';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.terraform',
  '.ast-graph',
  '.venv',
  'venv',
]);

export class SqlCompilerAdapter implements CompilerAdapter {
  public readonly name = 'sql-ddl';
  public readonly languages = ['sql'] as const;

  public supportsFile(filePath: string): boolean {
    if (filePath.includes('node_modules') || filePath.includes('.venv')) return false;
    return filePath.endsWith('.sql');
  }

  public discoverSqlFiles(workspaceRoot: string): string[] {
    const results: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.sql')) {
          results.push(full);
        }
      }
    };
    walk(path.resolve(workspaceRoot));
    return results.sort();
  }

  public extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch {
    const resolvedRoot = path.resolve(workspaceRoot);
    const allSqlFiles = this.discoverSqlFiles(resolvedRoot);
    if (allSqlFiles.length === 0) {
      return { compiler: this.name, files: [], nodes: [], edges: [], diagnostics: [] };
    }

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

    const firstRel = path.relative(resolvedRoot, allSqlFiles[0]!).split(path.sep).join('/');
    const pkgId = 'scip-sql ddl sql 1.0.0 package#';
    nodesMap.set(pkgId, {
      id: pkgId,
      kind: 'WorkspacePackage',
      name: 'sql',
      qualifiedName: 'sql',
      packageName: 'sql',
      filePath: firstRel,
      language: 'sql',
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 1,
      signature: 'sql ddl module',
      docstring: 'SQL DDL schemas, tables, indexes, and Spanner property graphs',
      exported: true,
      complexity: 1,
      labels: ['WorkspacePackage', 'SqlModule'],
      properties: {},
    });

    for (const absPath of allSqlFiles) {
      const relPath = path.relative(resolvedRoot, absPath).split(path.sep).join('/');
      if (targetRelSet && !targetRelSet.has(relPath)) continue;
      if (!fs.existsSync(absPath)) continue;

      const stat = fs.statSync(absPath);
      const content = fs.readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');

      filesBatch.push({
        filePath: relPath,
        packageName: 'sql',
        language: 'sql',
        sha256,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        lineCount: lines.length,
      });

      const fileId = `scip-sql ddl sql 1.0.0 ${relPath}/`;
      nodesMap.set(fileId, {
        id: fileId,
        kind: 'File',
        name: path.basename(relPath),
        qualifiedName: relPath,
        packageName: 'sql',
        filePath: relPath,
        language: 'sql',
        startLine: 1,
        startCol: 1,
        endLine: lines.length,
        endCol: 1,
        signature: `sql file ${relPath}`,
        docstring: `SQL DDL file ${relPath}`,
        exported: true,
        complexity: 1,
        labels: ['File', 'SqlFile'],
        properties: {},
      });

      edgesMap.set(`${pkgId}|${fileId}|CONTAINS|${relPath}|1`, {
        srcId: pkgId,
        dstId: fileId,
        kind: 'CONTAINS',
        filePath: relPath,
        line: 1,
        col: 1,
        weight: 1,
        properties: {},
      });

      // Extract CREATE TABLE blocks
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const createTableMatch = line.match(
          /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_][A-Za-z0-9_]*)[`"']?\s*\(/i,
        );
        if (createTableMatch) {
          const tableName = createTableMatch[1]!;
          const startLine = i + 1;
          let endLine = startLine;
          let parenDepth = 0;
          for (let j = i; j < lines.length; j++) {
            const l = lines[j]!;
            for (const ch of l) {
              if (ch === '(') parenDepth++;
              else if (ch === ')') parenDepth--;
            }
            if (l.includes(';') && parenDepth <= 0) {
              endLine = j + 1;
              break;
            }
          }

          const tableId = `scip-sql ddl sql 1.0.0 table:${tableName}#`;
          nodesMap.set(tableId, {
            id: tableId,
            kind: 'ZodSchema',
            name: tableName,
            qualifiedName: `sql.${tableName}`,
            packageName: 'sql',
            filePath: relPath,
            language: 'sql',
            startLine,
            startCol: 1,
            endLine,
            endCol: 1,
            signature: `CREATE TABLE ${tableName}`,
            docstring: `SQL Table ${tableName} in ${relPath}`,
            exported: true,
            complexity: 1,
            labels: ['ZodSchema', 'Schema', 'SqlTable'],
            properties: { framework: 'sql-ddl' },
          });

          edgesMap.set(`${fileId}|${tableId}|CONTAINS|${relPath}|${startLine}`, {
            srcId: fileId,
            dstId: tableId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startLine,
            col: 1,
            weight: 1,
            properties: {},
          });

          // Parse columns inside CREATE TABLE
          for (let k = i + 1; k < endLine - 1 && k < lines.length; k++) {
            const colLine = lines[k]!.trim();
            if (
              !colLine ||
              colLine.startsWith('--') ||
              /^(PRIMARY\s+KEY|CONSTRAINT|FOREIGN\s+KEY|INTERLEAVE|INDEX|UNIQUE)/i.test(colLine)
            ) {
              continue;
            }
            const colMatch = colLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_<>()]+)/);
            if (colMatch) {
              const colName = colMatch[1]!;
              const colType = colMatch[2]!;
              const colId = `${tableId}${colName}.`;
              nodesMap.set(colId, {
                id: colId,
                kind: 'Property',
                name: colName,
                qualifiedName: `${tableName}.${colName}`,
                packageName: 'sql',
                filePath: relPath,
                language: 'sql',
                startLine: k + 1,
                startCol: 1,
                endLine: k + 1,
                endCol: colLine.length,
                signature: `${colName} ${colType}`,
                docstring: '',
                exported: true,
                complexity: 1,
                labels: ['Property', 'SqlColumn'],
                properties: { columnType: colType },
              });
              edgesMap.set(`${tableId}|${colId}|CONTAINS|${relPath}|${k + 1}`, {
                srcId: tableId,
                dstId: colId,
                kind: 'CONTAINS',
                filePath: relPath,
                line: k + 1,
                col: 1,
                weight: 1,
                properties: {},
              });
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
