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
  ScipSymbolUri,
} from '../types.js';

interface ParsedTfBlock {
  blockType: 'resource' | 'data' | 'variable' | 'output' | 'locals';
  resourceType?: string;
  name: string;
  id: ScipSymbolUri;
  nodeKind: NodeKind;
  filePath: string;
  startLine: number;
  endLine: number;
  bodyText: string;
}

function findClosingBraceLine(lines: string[], startLineIdx: number): number {
  let depth = 0;
  let seenOpen = false;
  for (let i = startLineIdx; i < lines.length; i++) {
    const line = lines[i]!;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
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
  return lines.length;
}

export class TerraformCompilerAdapter implements CompilerAdapter {
  public readonly name = 'terraform';
  public readonly languages = ['terraform'] as const;

  public supportsFile(filePath: string): boolean {
    if (filePath.includes('.terraform') || filePath.includes('node_modules')) {
      return false;
    }
    return filePath.endsWith('.tf');
  }

  public discoverTfFiles(workspaceRoot: string): string[] {
    const infraDir = path.join(workspaceRoot, 'infra');
    if (!fs.existsSync(infraDir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(infraDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.tf')) {
        results.push(path.join(infraDir, entry.name));
      }
    }
    return results.sort();
  }

  public extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch {
    const resolvedRoot = path.resolve(workspaceRoot);
    const allTfFiles = this.discoverTfFiles(resolvedRoot);
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

    const pkgId = 'scip-tf hcl infra 1.0.0 package#';
    nodesMap.set(pkgId, {
      id: pkgId,
      kind: 'WorkspacePackage',
      name: 'infra',
      qualifiedName: 'infra',
      packageName: 'infra',
      filePath: 'infra/main.tf',
      language: 'terraform',
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 1,
      signature: 'terraform module infra',
      docstring: 'Google Cloud Run v2, Pub/Sub, Firestore, Secret Manager, and Artifact Registry infrastructure',
      exported: true,
      complexity: 1,
      labels: ['WorkspacePackage', 'TerraformModule'],
      properties: {},
    });

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
          docstring: `Terraform HCL configuration ${relPath}`,
          exported: true,
          complexity: 1,
          labels: ['File', 'TerraformFile'],
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
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const resMatch = line.match(/^\s*(resource|data)\s+"([^"]+)"\s+"([^"]+)"\s*\{/);
        const varMatch = line.match(/^\s*(variable|output)\s+"([^"]+)"\s*\{/);
        const localsMatch = line.match(/^\s*locals\s*\{/);

        if (resMatch) {
          const bType = resMatch[1] as 'resource' | 'data';
          const rType = resMatch[2]!;
          const rName = resMatch[3]!;
          const startLine = i + 1;
          const endLine = findClosingBraceLine(lines, i);
          const bodyText = lines.slice(i, endLine).join('\n');
          const id = `scip-tf hcl infra 1.0.0 ${relPath}/${bType}:${rType}#${rName}.`;
          const qualified = bType === 'resource' ? `${rType}.${rName}` : `data.${rType}.${rName}`;

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
        }
      }
    }

    const servicePackageLinks: Record<string, string> = {
      'google_cloud_run_v2_service.lobby': 'scip-ts npm @warehouse/lobby 0.1.0 package#',
      'google_cloud_run_v2_service.site': 'scip-ts npm @warehouse/site 0.1.0 package#',
      'google_cloud_run_v2_job.loadtest_128': 'scip-ts npm @warehouse/loadtest 0.1.0 package#',
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
          ? `${block.blockType} "${block.resourceType}" "${block.name.split('.')[1] ?? block.name}"`
          : `${block.blockType} "${block.name}"`,
        docstring: `Terraform ${block.blockType} ${block.name} in ${block.filePath}`,
        exported: true,
        complexity: 1,
        labels: [block.nodeKind, 'Terraform'],
        properties: { blockType: block.blockType, resourceType: block.resourceType ?? null },
      });

      edgesMap.set(`${fileId}|${block.id}|CONTAINS|${block.filePath}|${block.startLine}`, {
        srcId: fileId,
        dstId: block.id,
        kind: 'CONTAINS',
        filePath: block.filePath,
        line: block.startLine,
        col: 1,
        weight: 1,
        properties: {},
      });

      // Cross-resource and variable references inside block body
      for (const [refKey, targetScip] of symbolLookup.entries()) {
        if (targetScip === block.id) continue;
        if (block.bodyText.includes(refKey)) {
          const edgeKey = `${block.id}|${targetScip}|REFERENCES_TF_RESOURCE|${block.filePath}|${block.startLine}`;
          edgesMap.set(edgeKey, {
            srcId: block.id,
            dstId: targetScip,
            kind: 'REFERENCES_TF_RESOURCE',
            filePath: block.filePath,
            line: block.startLine,
            col: 1,
            weight: 1,
            properties: { reference: refKey },
          });
        }
      }

      // Link Cloud Run services/jobs to workspace packages
      const linkedPkgScip = servicePackageLinks[block.name];
      if (linkedPkgScip) {
        const provKey = `${block.id}|${linkedPkgScip}|PROVISIONS_SERVICE|${block.filePath}|${block.startLine}`;
        edgesMap.set(provKey, {
          srcId: block.id,
          dstId: linkedPkgScip,
          kind: 'PROVISIONS_SERVICE',
          filePath: block.filePath,
          line: block.startLine,
          col: 1,
          weight: 1,
          properties: {},
        });
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
