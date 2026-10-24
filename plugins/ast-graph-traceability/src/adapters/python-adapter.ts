import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CompilerAdapter,
  CompilerGraphBatch,
  GraphEdgeRecord,
  GraphFileRecord,
  GraphNodeRecord,
  NodeKind,
} from '../types.js';

const PYTHON_AST_EXTRACTOR_SCRIPT = `
import ast, json, sys

source = sys.stdin.read()
file_path = sys.argv[1] if len(sys.argv) > 1 else "module.py"
pkg_name = sys.argv[2] if len(sys.argv) > 2 else "python-pkg"

try:
    tree = ast.parse(source, filename=file_path)
except SyntaxError as e:
    print(json.dumps({
        "nodes": [],
        "edges": [],
        "diagnostics": [{
            "line": e.lineno or 1,
            "col": e.offset or 1,
            "message": str(e.msg),
            "code": "PY_SYNTAX_ERROR"
        }]
    }))
    sys.exit(0)

nodes = []
edges = []

def complexity_of(node):
    c = 1
    for child in ast.walk(node):
        if isinstance(child, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.IfExp, ast.BoolOp)):
            c += 1
    return c

file_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/"

for item in tree.body:
    if isinstance(item, ast.Import):
        for alias in item.names:
            mod_id = f"scip-py uv {alias.name} 0.1.0 module/"
            edges.append({"srcId": file_id, "dstId": mod_id, "kind": "IMPORTS", "line": item.lineno})
    elif isinstance(item, ast.ImportFrom):
        mod_name = item.module or "relative"
        mod_id = f"scip-py uv {mod_name} 0.1.0 module/"
        edges.append({"srcId": file_id, "dstId": mod_id, "kind": "IMPORTS", "line": item.lineno})
    elif isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
        fn_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{item.name}()."
        args = [a.arg for a in item.args.args]
        sig = f"def {item.name}({', '.join(args)})"
        doc = ast.get_docstring(item) or ""
        nodes.append({
            "id": fn_id,
            "kind": "Function",
            "name": item.name,
            "qualifiedName": f"{pkg_name}/{item.name}",
            "startLine": item.lineno,
            "endLine": getattr(item, "end_lineno", item.lineno),
            "signature": sig,
            "docstring": doc[:300],
            "complexity": complexity_of(item)
        })
        edges.append({"srcId": file_id, "dstId": fn_id, "kind": "CONTAINS", "line": item.lineno})
        for sub in ast.walk(item):
            if isinstance(sub, ast.Call):
                if isinstance(sub.func, ast.Name):
                    callee = sub.func.id
                    target_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{callee}()."
                    edges.append({"srcId": fn_id, "dstId": target_id, "kind": "CALLS", "line": getattr(sub, "lineno", item.lineno)})
                elif isinstance(sub.func, ast.Attribute):
                    callee = sub.func.attr
                    target_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{callee}()."
                    edges.append({"srcId": fn_id, "dstId": target_id, "kind": "CALLS", "line": getattr(sub, "lineno", item.lineno)})
    elif isinstance(item, ast.ClassDef):
        cls_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{item.name}#"
        doc = ast.get_docstring(item) or ""
        nodes.append({
            "id": cls_id,
            "kind": "Class",
            "name": item.name,
            "qualifiedName": f"{pkg_name}/{item.name}",
            "startLine": item.lineno,
            "endLine": getattr(item, "end_lineno", item.lineno),
            "signature": f"class {item.name}",
            "docstring": doc[:300],
            "complexity": complexity_of(item)
        })
        edges.append({"srcId": file_id, "dstId": cls_id, "kind": "CONTAINS", "line": item.lineno})
        for member in item.body:
            if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                m_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{item.name}#{member.name}()."
                args = [a.arg for a in member.args.args]
                nodes.append({
                    "id": m_id,
                    "kind": "Method",
                    "name": member.name,
                    "qualifiedName": f"{item.name}.{member.name}",
                    "startLine": member.lineno,
                    "endLine": getattr(member, "end_lineno", member.lineno),
                    "signature": f"def {member.name}({', '.join(args)})",
                    "docstring": (ast.get_docstring(member) or "")[:300],
                    "complexity": complexity_of(member)
                })
                edges.append({"srcId": cls_id, "dstId": m_id, "kind": "CONTAINS", "line": member.lineno})
                for sub in ast.walk(member):
                    if isinstance(sub, ast.Call):
                        if isinstance(sub.func, ast.Name):
                            callee = sub.func.id
                            target_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{callee}()."
                            edges.append({"srcId": m_id, "dstId": target_id, "kind": "CALLS", "line": getattr(sub, "lineno", member.lineno)})
                        elif isinstance(sub.func, ast.Attribute):
                            callee = sub.func.attr
                            target_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{item.name}#{callee}()."
                            edges.append({"srcId": m_id, "dstId": target_id, "kind": "CALLS", "line": getattr(sub, "lineno", member.lineno)})

print(json.dumps({"nodes": nodes, "edges": edges, "diagnostics": []}))
`;

export function extractPythonSource(
  filePath: string,
  content: string,
  packageName = 'python-pkg',
): CompilerGraphBatch {
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const lines = content.split('\n');
  const fileId = `scip-py uv ${packageName} 0.1.0 ${filePath}/`;

  const fileRecord: GraphFileRecord = {
    filePath,
    packageName,
    language: 'python',
    sha256,
    mtimeMs: Date.now(),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    lineCount: lines.length,
  };

  const nodes: GraphNodeRecord[] = [
    {
      id: fileId,
      kind: 'File',
      name: path.basename(filePath),
      qualifiedName: filePath,
      packageName,
      filePath,
      language: 'python',
      startLine: 1,
      startCol: 1,
      endLine: lines.length,
      endCol: 1,
      signature: `python module ${filePath}`,
      docstring: `Python source module ${filePath}`,
      exported: true,
      complexity: 1,
      labels: ['File', 'PythonModule'],
      properties: {},
    },
  ];
  const edges: GraphEdgeRecord[] = [];

  const proc = spawnSync('python3', ['-c', PYTHON_AST_EXTRACTOR_SCRIPT, filePath, packageName], {
    input: content,
    encoding: 'utf8',
    timeout: 5000,
  });

  if (proc.status === 0 && proc.stdout) {
    const parsed = JSON.parse(proc.stdout) as {
      nodes: Array<{
        id: string;
        kind: NodeKind;
        name: string;
        qualifiedName: string;
        startLine: number;
        endLine: number;
        signature: string;
        docstring: string;
        complexity: number;
      }>;
      edges: Array<{
        srcId: string;
        dstId: string;
        kind: 'CONTAINS' | 'CALLS' | 'IMPORTS';
        line: number;
      }>;
      diagnostics: Array<{ line: number; col: number; message: string; code: string }>;
    };

    for (const n of parsed.nodes) {
      nodes.push({
        id: n.id,
        kind: n.kind,
        name: n.name,
        qualifiedName: n.qualifiedName,
        packageName,
        filePath,
        language: 'python',
        startLine: n.startLine,
        startCol: 1,
        endLine: n.endLine,
        endCol: 1,
        signature: n.signature,
        docstring: n.docstring,
        exported: !n.name.startsWith('_'),
        complexity: n.complexity,
        labels: [n.kind, 'Python'],
        properties: {},
      });
    }

    for (const e of parsed.edges) {
      edges.push({
        srcId: e.srcId,
        dstId: e.dstId,
        kind: e.kind,
        filePath,
        line: e.line,
        col: 1,
        weight: 1,
        properties: {},
      });
    }

    return {
      compiler: 'python',
      files: [fileRecord],
      nodes,
      edges,
      diagnostics: parsed.diagnostics.map((d) => ({
        filePath,
        enclosingSymbolId: fileId,
        compiler: 'python',
        severity: 'error',
        code: d.code,
        message: d.message,
        line: d.line,
        col: d.col,
      })),
    };
  }

  return {
    compiler: 'python',
    files: [fileRecord],
    nodes,
    edges,
    diagnostics: [],
  };
}

export class PythonCompilerAdapter implements CompilerAdapter {
  public readonly name = 'python';
  public readonly languages = ['python'] as const;

  public supportsFile(filePath: string): boolean {
    if (filePath.includes('node_modules') || filePath.includes('.venv') || filePath.includes('__pycache__')) {
      return false;
    }
    return filePath.endsWith('.py');
  }

  public discoverPythonFiles(workspaceRoot: string): string[] {
    const results: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === '.git' ||
          entry.name === '.venv' ||
          entry.name === '.ast-graph' ||
          entry.name === '.agents' ||
          entry.name === '.claude'
        ) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.py')) {
          results.push(full);
        }
      }
    };
    walk(workspaceRoot);
    return results.sort();
  }

  public extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch {
    const resolvedRoot = path.resolve(workspaceRoot);
    const pyFiles = this.discoverPythonFiles(resolvedRoot);
    const targetRelSet = targetFiles
      ? new Set(
          targetFiles.map((f) =>
            path.isAbsolute(f)
              ? path.relative(resolvedRoot, f).split(path.sep).join('/')
              : f.replace(/^\.\//, '').split(path.sep).join('/'),
          ),
        )
      : null;

    const batch: CompilerGraphBatch = {
      compiler: this.name,
      files: [],
      nodes: [],
      edges: [],
      diagnostics: [],
    };

    for (const absPath of pyFiles) {
      const relPath = path.relative(resolvedRoot, absPath).split(path.sep).join('/');
      if (targetRelSet && !targetRelSet.has(relPath)) continue;
      if (!fs.existsSync(absPath)) continue;
      const stat = fs.statSync(absPath);
      const content = fs.readFileSync(absPath, 'utf8');
      const sub = extractPythonSource(relPath, content);
      for (const f of sub.files) {
        f.mtimeMs = stat.mtimeMs;
        batch.files.push(f);
      }
      batch.nodes.push(...sub.nodes);
      batch.edges.push(...sub.edges);
      batch.diagnostics.push(...sub.diagnostics);
    }

    return batch;
  }
}
