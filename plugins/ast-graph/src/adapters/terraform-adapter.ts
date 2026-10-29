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
  NodeKind,
  ScipSymbolUri,
} from '../types.js';

interface ParsedTfBlock {
  blockType: 'resource' | 'data' | 'module' | 'provider' | 'variable' | 'output' | 'locals';
  resourceType?: string;
  name: string;
  id: ScipSymbolUri;
  nodeKind: NodeKind;
  filePath: string;
  startLine: number;
  endLine: number;
  bodyText: string;
}

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

/**
 * Counts `{` and `}` delimiters on a single HCL line while ignoring:
 * - `#` and `//` line comments
 * - `/* ... *\/` multi-line block comments
 * - `<<EOF` and `<<-EOF` multi-line heredocs
 * - `"..."` double-quoted strings with `\"` escapes
 */
export function countHclDelimsLine(
  line: string,
  inBlockComment: boolean,
  heredocMarker: string,
): { braceDelta: number; inBlockComment: boolean; heredocMarker: string } {
  let braceDelta = 0;

  if (heredocMarker !== '') {
    if (line.trim() === heredocMarker) {
      return { braceDelta: 0, inBlockComment, heredocMarker: '' };
    }
    return { braceDelta: 0, inBlockComment, heredocMarker };
  }

  let inStr = false;
  let escaped = false;
  const n = line.length;

  for (let i = 0; i < n; i++) {
    const ch = line[i]!;

    if (inBlockComment) {
      if (ch === '*' && i + 1 < n && line[i + 1] === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inStr) {
      if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }

    if (ch === '#') break;
    if (ch === '/' && i + 1 < n) {
      if (line[i + 1] === '/') break;
      if (line[i + 1] === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
    }

    // Check for heredoc start: <<EOF or <<-EOF
    if (ch === '<' && i + 1 < n && line[i + 1] === '<') {
      let j = i + 2;
      if (j < n && line[j] === '-') j++;
      let k = j;
      while (k < n && /[A-Za-z0-9_]/.test(line[k]!)) k++;
      if (k > j) {
        heredocMarker = line.slice(j, k);
        break;
      }
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }

    if (ch === '{') braceDelta++;
    else if (ch === '}') braceDelta--;
  }

  return { braceDelta, inBlockComment, heredocMarker };
}

function findClosingBraceLine(lines: string[], startLineIdx: number): number {
  let depth = 0;
  let seenOpen = false;
  let inBlockComment = false;
  let heredocMarker = '';

  for (let i = startLineIdx; i < lines.length; i++) {
    const step = countHclDelimsLine(lines[i]!, inBlockComment, heredocMarker);
    inBlockComment = step.inBlockComment;
    heredocMarker = step.heredocMarker;
    if (step.braceDelta > 0) seenOpen = true;
    depth += step.braceDelta;
    if (seenOpen && depth <= 0) {
      return i + 1;
    }
  }
  return lines.length;
}

export class TerraformCompilerAdapter implements CompilerAdapter {
  public readonly name = 'terraform';
  public readonly languages = ['terraform'] as const;

  public supportsFile(filePath: string): boolean {
    if (
      filePath.includes('.terraform') ||
      filePath.includes('node_modules') ||
      filePath.endsWith('.terraform.lock.hcl')
    ) {
      return false;
    }
    return (
      filePath.endsWith('.tf') ||
      filePath.endsWith('.hcl') ||
      filePath.endsWith('.tfvars')
    );
  }

  public discoverTfFiles(workspaceRoot: string): string[] {
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
        } else if (entry.isFile() && this.supportsFile(entry.name)) {
          results.push(full);
        }
      }
    };
    walk(path.resolve(workspaceRoot));
    return results.sort();
  }

  public extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch {
    const resolvedRoot = path.resolve(workspaceRoot);
    const allTfFiles = this.discoverTfFiles(resolvedRoot);
    if (allTfFiles.length === 0) {
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
    const allBlocks: ParsedTfBlock[] = [];
    const symbolLookup = new Map<string, ScipSymbolUri>();

    const firstRel = path.relative(resolvedRoot, allTfFiles[0]!).split(path.sep).join('/');
    const pkgId = 'scip-tf hcl infra 1.0.0 package#';
    nodesMap.set(pkgId, {
      id: pkgId,
      kind: 'WorkspacePackage',
      name: 'infra',
      qualifiedName: 'infra',
      packageName: 'infra',
      filePath: firstRel,
      language: 'terraform',
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 1,
      signature: 'terraform module infra',
      docstring: 'Terraform HCL infrastructure configuration',
      exported: true,
      complexity: 1,
      labels: ['WorkspacePackage', 'TerraformModule'],
      properties: {},
    });

    const addEdge = (
      srcId: ScipSymbolUri,
      dstId: ScipSymbolUri,
      kind: EdgeKind,
      filePath: string,
      line: number,
      properties: Record<string, unknown> = {},
    ): void => {
      if (!srcId || !dstId || srcId === dstId) return;
      edgesMap.set(`${srcId}|${dstId}|${kind}|${filePath}|${line}`, {
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

    for (const absPath of allTfFiles) {
      const relPath = path.relative(resolvedRoot, absPath).split(path.sep).join('/');
      if (!fs.existsSync(absPath)) continue;

      const stat = fs.statSync(absPath);
      const content = fs.readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');

      const includeInBatch = !targetRelSet || targetRelSet.has(relPath);
      const fileId = `scip-tf hcl infra 1.0.0 ${relPath}/`;

      if (includeInBatch) {
        filesBatch.push({
          filePath: relPath,
          packageName: 'infra',
          language: 'terraform',
          sha256,
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
          lineCount: lines.length,
        });

        nodesMap.set(fileId, {
          id: fileId,
          kind: 'File',
          name: path.basename(relPath),
          qualifiedName: relPath,
          packageName: 'infra',
          filePath: relPath,
          language: 'terraform',
          startLine: 1,
          startCol: 1,
          endLine: lines.length,
          endCol: 1,
          signature: `terraform file ${relPath}`,
          docstring: `Terraform HCL file ${relPath}`,
          exported: true,
          complexity: 1,
          labels: ['File', 'TerraformFile'],
          properties: {},
        });

        addEdge(pkgId, fileId, 'CONTAINS', relPath, 1);
      }

      // Parse .tfvars assignments
      if (relPath.endsWith('.tfvars')) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const tfvarMatch = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
          if (tfvarMatch) {
            const vName = tfvarMatch[1]!;
            const id = `scip-tf hcl infra 1.0.0 ${relPath}/tfvars#${vName}.`;
            if (includeInBatch) {
              nodesMap.set(id, {
                id,
                kind: 'TerraformVariable',
                name: `var.${vName}`,
                qualifiedName: `infra/var.${vName}`,
                packageName: 'infra',
                filePath: relPath,
                language: 'terraform',
                startLine: i + 1,
                startCol: 1,
                endLine: i + 1,
                endCol: line.length,
                signature: `${vName} = ...`,
                docstring: `Terraform variable assignment ${vName} in ${relPath}`,
                exported: true,
                complexity: 1,
                labels: ['TerraformVariable', 'Terraform'],
                properties: { blockType: 'tfvars' },
              });
              addEdge(fileId, id, 'CONTAINS', relPath, i + 1);
            }
          }
        }
        continue;
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const resMatch = line.match(
          /^\s*(resource|data)\s+"([^"]+)"\s+"([^"]+)"\s*\{/,
        );
        const modProvMatch = line.match(
          /^\s*(module|provider)\s+"([^"]+)"\s*\{/,
        );
        const varMatch = line.match(
          /^\s*(variable|output)\s+"([^"]+)"\s*\{/,
        );
        const localsMatch = line.match(/^\s*locals\s*\{/);

        if (resMatch) {
          const bType = resMatch[1] as 'resource' | 'data';
          const rType = resMatch[2]!;
          const rName = resMatch[3]!;
          const startLine = i + 1;
          const endLine = findClosingBraceLine(lines, i);
          const bodyText = lines.slice(i, endLine).join('\n');
          const id = `scip-tf hcl infra 1.0.0 ${relPath}/${bType}#${rType}.${rName}.`;
          const qualified = bType === 'data' ? `data.${rType}.${rName}` : `${rType}.${rName}`;

          symbolLookup.set(qualified, id);
          allBlocks.push({
            blockType: bType,
            resourceType: rType,
            name: qualified,
            id,
            nodeKind: 'TerraformResource',
            filePath: relPath,
            startLine,
            endLine,
            bodyText,
          });
          i = Math.max(i, endLine - 1);
        } else if (modProvMatch) {
          const bType = modProvMatch[1] as 'module' | 'provider';
          const mName = modProvMatch[2]!;
          const startLine = i + 1;
          const endLine = findClosingBraceLine(lines, i);
          const bodyText = lines.slice(i, endLine).join('\n');
          const id = `scip-tf hcl infra 1.0.0 ${relPath}/${bType}#${mName}.`;
          const qualified = `${bType}.${mName}`;

          symbolLookup.set(qualified, id);
          allBlocks.push({
            blockType: bType,
            name: qualified,
            id,
            nodeKind: 'TerraformResource',
            filePath: relPath,
            startLine,
            endLine,
            bodyText,
          });
          i = Math.max(i, endLine - 1);
        } else if (varMatch) {
          const bType = varMatch[1] as 'variable' | 'output';
          const vName = varMatch[2]!;
          const startLine = i + 1;
          const endLine = findClosingBraceLine(lines, i);
          const bodyText = lines.slice(i, endLine).join('\n');
          const id = `scip-tf hcl infra 1.0.0 ${relPath}/${bType}#${vName}.`;
          const qualified = bType === 'variable' ? `var.${vName}` : `output.${vName}`;
          const nodeKind: NodeKind = bType === 'variable' ? 'TerraformVariable' : 'TerraformOutput';

          symbolLookup.set(qualified, id);
          allBlocks.push({
            blockType: bType,
            name: qualified,
            id,
            nodeKind,
            filePath: relPath,
            startLine,
            endLine,
            bodyText,
          });
          i = Math.max(i, endLine - 1);
        } else if (localsMatch) {
          const startLine = i + 1;
          const endLine = findClosingBraceLine(lines, i);
          const bodyText = lines.slice(i, endLine).join('\n');
          const id = `scip-tf hcl infra 1.0.0 ${relPath}/locals#${startLine}.`;
          symbolLookup.set('local', id);
          allBlocks.push({
            blockType: 'locals',
            name: 'locals',
            id,
            nodeKind: 'TerraformVariable',
            filePath: relPath,
            startLine,
            endLine,
            bodyText,
          });
          i = Math.max(i, endLine - 1);
        }
      }
    }

    const servicePackageLinks: Record<string, string> = {
      'google_cloud_run_v2_service.lobby': 'scip-ts npm @warehouse/lobby 0.1.0 package#',
      'google_cloud_run_v2_service.site': 'scip-ts npm @warehouse/site 0.1.0 package#',
      'google_cloud_run_v2_job.loadtest_128': 'scip-ts npm @warehouse/loadtest 0.1.0 package#',
      'google_cloud_run_v2_service.backend': 'scip-go gomod smartrouter-backend 0.0.0 package#',
      'google_cloud_run_v2_service.frontend': 'scip-go gomod smartrouter-frontend 0.0.0 package#',
    };

    for (const block of allBlocks) {
      if (targetRelSet && !targetRelSet.has(block.filePath)) continue;
      const fileId = `scip-tf hcl infra 1.0.0 ${block.filePath}/`;

      nodesMap.set(block.id, {
        id: block.id,
        kind: block.nodeKind,
        name: block.name,
        qualifiedName: `infra/${block.name}`,
        packageName: 'infra',
        filePath: block.filePath,
        language: 'terraform',
        startLine: block.startLine,
        startCol: 1,
        endLine: block.endLine,
        endCol: 1,
        signature: block.resourceType
          ? `${block.blockType} "${block.resourceType}" "${block.name.split('.').pop() ?? block.name}"`
          : `${block.blockType} "${block.name}"`,
        docstring: `Terraform ${block.blockType} ${block.name} in ${block.filePath}`,
        exported: true,
        complexity: 1,
        labels: [block.nodeKind, 'Terraform'],
        properties: { blockType: block.blockType, resourceType: block.resourceType ?? null },
      });

      addEdge(fileId, block.id, 'CONTAINS', block.filePath, block.startLine);

      // Cross-resource and variable references inside block body
      for (const [refKey, targetScip] of symbolLookup.entries()) {
        if (targetScip === block.id) continue;
        if (block.bodyText.includes(refKey)) {
          addEdge(block.id, targetScip, 'REFERENCES_TF_RESOURCE', block.filePath, block.startLine, {
            reference: refKey,
          });
        }
      }

      // Extract container image = "..." (`PROVISIONS_SERVICE`)
      const imageMatch = block.bodyText.match(/^\s*image\s*=\s*"([^"]+)"/m);
      if (imageMatch) {
        const imageVal = imageMatch[1]!;
        const imgId = `scip-tf hcl infra 1.0.0 image#${imageVal}.`;
        if (!nodesMap.has(imgId)) {
          nodesMap.set(imgId, {
            id: imgId,
            kind: 'ServiceInstance',
            name: imageVal,
            qualifiedName: `image:${imageVal}`,
            packageName: 'infra',
            filePath: block.filePath,
            language: 'terraform',
            startLine: block.startLine,
            startCol: 1,
            endLine: block.startLine,
            endCol: 1,
            signature: `image = "${imageVal}"`,
            docstring: `Container image ${imageVal} provisioned by ${block.name}`,
            exported: true,
            complexity: 1,
            labels: ['ServiceInstance', 'ContainerImage'],
            properties: { image: imageVal },
          });
        }
        addEdge(block.id, imgId, 'PROVISIONS_SERVICE', block.filePath, block.startLine, {
          image: imageVal,
        });
      }

      // Extract env { name = "VAR_NAME" } (`CONFIGURES_ENV`)
      const envRegex = /\benv\s*\{[^}]*?\bname\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/gs;
      let envMatch: RegExpExecArray | null;
      while ((envMatch = envRegex.exec(block.bodyText)) !== null) {
        const envName = envMatch[1]!;
        const envId = `scip-env global env 1.0.0 ${envName}#`;
        if (!nodesMap.has(envId)) {
          nodesMap.set(envId, {
            id: envId,
            kind: 'EnvVar',
            name: envName,
            qualifiedName: `env.${envName}`,
            packageName: 'infra',
            filePath: block.filePath,
            language: 'terraform',
            startLine: block.startLine,
            startCol: 1,
            endLine: block.startLine,
            endCol: 1,
            signature: `env ${envName}`,
            docstring: `Environment variable ${envName} configured in ${block.name}`,
            exported: true,
            complexity: 1,
            labels: ['EnvVar'],
            properties: { envVar: envName },
          });
        }
        addEdge(block.id, envId, 'CONFIGURES_ENV', block.filePath, block.startLine, {
          envVar: envName,
        });
      }

      // Link Cloud Run services/jobs to workspace packages
      const linkedPkgScip = servicePackageLinks[block.name];
      if (linkedPkgScip) {
        addEdge(block.id, linkedPkgScip, 'PROVISIONS_SERVICE', block.filePath, block.startLine);
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
