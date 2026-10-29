import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const IGNORED_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    '.terraform',
    '.ast-graph',
    '.venv',
    'venv',
    'target',
    'vendor',
]);
export class DockerfileCompilerAdapter {
    name = 'dockerfile';
    languages = ['dockerfile'];
    supportsFile(filePath) {
        if (filePath.includes('node_modules') || filePath.includes('.venv'))
            return false;
        const base = path.basename(filePath);
        const lowerBase = base.toLowerCase();
        return (lowerBase === 'dockerfile' ||
            lowerBase.startsWith('dockerfile.') ||
            lowerBase.endsWith('.dockerfile') ||
            lowerBase === 'containerfile' ||
            lowerBase.startsWith('containerfile.') ||
            lowerBase.endsWith('.containerfile'));
    }
    discoverDockerfiles(workspaceRoot) {
        const results = [];
        const walk = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                if (IGNORED_DIRS.has(entry.name))
                    continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                }
                else if (entry.isFile() && this.supportsFile(full)) {
                    results.push(full);
                }
            }
        };
        walk(path.resolve(workspaceRoot));
        return results.sort();
    }
    /**
     * Merges backslash-continued lines while preserving exact 1-based startLine and endLine.
     */
    parseLogicalLines(content) {
        const rawLines = content.split('\n');
        const result = [];
        let currentParts = [];
        let startLine = 0;
        for (let i = 0; i < rawLines.length; i++) {
            const lineNum = i + 1;
            const trimmed = (rawLines[i] ?? '').trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            if (startLine === 0) {
                startLine = lineNum;
            }
            if (trimmed.endsWith('\\')) {
                const clean = trimmed.slice(0, -1).trim();
                if (clean)
                    currentParts.push(clean);
            }
            else {
                currentParts.push(trimmed);
                result.push({
                    startLine,
                    endLine: lineNum,
                    text: currentParts.join(' '),
                });
                currentParts = [];
                startLine = 0;
            }
        }
        if (currentParts.length > 0 && startLine > 0) {
            result.push({
                startLine,
                endLine: rawLines.length,
                text: currentParts.join(' '),
            });
        }
        return result;
    }
    extract(workspaceRoot, targetFiles) {
        const resolvedRoot = path.resolve(workspaceRoot);
        const allFiles = this.discoverDockerfiles(resolvedRoot);
        if (allFiles.length === 0) {
            return { compiler: this.name, files: [], nodes: [], edges: [], diagnostics: [] };
        }
        const targetRelSet = targetFiles
            ? new Set(targetFiles.map((f) => path.isAbsolute(f)
                ? path.relative(resolvedRoot, f).split(path.sep).join('/')
                : f.replace(/^\.\//, '').split(path.sep).join('/')))
            : null;
        const filesBatch = [];
        const nodesMap = new Map();
        const edgesMap = new Map();
        const addNode = (n) => {
            nodesMap.set(n.id, n);
        };
        const addEdge = (srcId, dstId, kind, filePath, line, properties = {}) => {
            if (!srcId || !dstId || srcId === dstId)
                return;
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
        for (const absPath of allFiles) {
            const relPath = path.relative(resolvedRoot, absPath).split(path.sep).join('/');
            if (targetRelSet && !targetRelSet.has(relPath))
                continue;
            if (!fs.existsSync(absPath))
                continue;
            const stat = fs.statSync(absPath);
            const content = fs.readFileSync(absPath, 'utf8');
            const lines = content.split('\n');
            const sha256 = crypto.createHash('sha256').update(content).digest('hex');
            filesBatch.push({
                filePath: relPath,
                packageName: 'container',
                language: 'dockerfile',
                sha256,
                mtimeMs: stat.mtimeMs,
                sizeBytes: stat.size,
                lineCount: lines.length,
            });
            const fileId = `scip-docker file container 1.0.0 ${relPath}/`;
            addNode({
                id: fileId,
                kind: 'File',
                name: path.basename(relPath),
                qualifiedName: relPath,
                packageName: 'container',
                filePath: relPath,
                language: 'dockerfile',
                startLine: 1,
                startCol: 1,
                endLine: lines.length,
                endCol: 1,
                signature: relPath,
                docstring: `Container build specification ${relPath}`,
                exported: true,
                complexity: 1,
                labels: ['File', 'Dockerfile'],
                properties: {},
            });
            const logicalLines = this.parseLogicalLines(content);
            const stageNodesByName = new Map();
            let currentStageId = fileId;
            let stageIndex = 0;
            for (let idx = 0; idx < logicalLines.length; idx++) {
                const ll = logicalLines[idx];
                const nextStartLine = logicalLines[idx + 1]?.startLine;
                const fromMatch = ll.text.match(/^FROM\s+(?:--platform=[^\s]+\s+)?([^\s]+)(?:\s+AS\s+([A-Za-z0-9_.-]+))?/i);
                if (fromMatch) {
                    stageIndex++;
                    const baseImage = fromMatch[1];
                    const stageName = fromMatch[2] ?? `stage-${stageIndex}`;
                    let stageEndLine = lines.length;
                    for (let j = idx + 1; j < logicalLines.length; j++) {
                        if (/^FROM\s+/i.test(logicalLines[j].text)) {
                            stageEndLine = Math.max(ll.endLine, logicalLines[j].startLine - 1);
                            break;
                        }
                    }
                    const stageId = `scip-docker stage container 1.0.0 ${relPath}:${stageName}#`;
                    currentStageId = stageId;
                    stageNodesByName.set(stageName.toLowerCase(), stageId);
                    addNode({
                        id: stageId,
                        kind: 'ServiceInstance',
                        name: stageName,
                        qualifiedName: `docker.${relPath}.${stageName}`,
                        packageName: 'container',
                        filePath: relPath,
                        language: 'dockerfile',
                        startLine: ll.startLine,
                        startCol: 1,
                        endLine: stageEndLine,
                        endCol: 1,
                        signature: ll.text,
                        docstring: `Dockerfile stage ${stageName} (base image ${baseImage})`,
                        exported: true,
                        complexity: 1,
                        labels: ['ServiceInstance', 'DockerStage'],
                        properties: { baseImage },
                    });
                    addEdge(fileId, stageId, 'CONTAINS', relPath, ll.startLine);
                    const baseImgId = `scip-docker image container 1.0.0 ${baseImage}#`;
                    if (!nodesMap.has(baseImgId)) {
                        addNode({
                            id: baseImgId,
                            kind: 'ServiceInstance',
                            name: baseImage,
                            qualifiedName: `docker.image.${baseImage}`,
                            packageName: 'container',
                            filePath: relPath,
                            language: 'dockerfile',
                            startLine: ll.startLine,
                            startCol: 1,
                            endLine: ll.endLine,
                            endCol: 1,
                            signature: `FROM ${baseImage}`,
                            docstring: `Base container image ${baseImage}`,
                            exported: true,
                            complexity: 1,
                            labels: ['ServiceInstance', 'BaseImage'],
                            properties: {},
                        });
                    }
                    addEdge(stageId, baseImgId, 'IMPORTS', relPath, ll.startLine, { baseImage });
                    continue;
                }
                // COPY --from=<stage>
                const copyFromMatch = ll.text.match(/^COPY\s+.*--from=([^\s]+)\s+/i);
                if (copyFromMatch) {
                    const fromStage = copyFromMatch[1];
                    const targetStageId = stageNodesByName.get(fromStage.toLowerCase()) ??
                        `scip-docker image container 1.0.0 ${fromStage}#`;
                    if (!nodesMap.has(targetStageId)) {
                        addNode({
                            id: targetStageId,
                            kind: 'ServiceInstance',
                            name: fromStage,
                            qualifiedName: `docker.image.${fromStage}`,
                            packageName: 'container',
                            filePath: relPath,
                            language: 'dockerfile',
                            startLine: ll.startLine,
                            startCol: 1,
                            endLine: ll.endLine,
                            endCol: 1,
                            signature: `COPY --from=${fromStage}`,
                            docstring: `External stage/image ${fromStage}`,
                            exported: true,
                            complexity: 1,
                            labels: ['ServiceInstance'],
                            properties: {},
                        });
                    }
                    addEdge(currentStageId, targetStageId, 'REFERENCES', relPath, ll.startLine, {
                        instruction: ll.text,
                    });
                    continue;
                }
                // ENV / ARG
                const envArgMatch = ll.text.match(/^(ENV|ARG)\s+([\s\S]+)$/i);
                if (envArgMatch) {
                    const directive = envArgMatch[1].toUpperCase();
                    const rest = envArgMatch[2].trim();
                    const keyMatches = [...rest.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)(?:=|\s|$)/g)];
                    const keys = keyMatches.length > 0 ? keyMatches.map((m) => m[1]) : [rest.split(/\s+/)[0]];
                    for (const key of keys) {
                        if (!key)
                            continue;
                        const envId = `scip-env global env 1.0.0 ${key}#`;
                        addNode({
                            id: envId,
                            kind: 'EnvVar',
                            name: key,
                            qualifiedName: `env.${key}`,
                            packageName: 'container',
                            filePath: relPath,
                            language: 'dockerfile',
                            startLine: ll.startLine,
                            startCol: 1,
                            endLine: ll.endLine,
                            endCol: 1,
                            signature: `${directive} ${key}`,
                            docstring: `Dockerfile ${directive} ${key}`,
                            exported: true,
                            complexity: 1,
                            labels: ['EnvVar', `Docker${directive}`],
                            properties: { directive },
                        });
                        addEdge(currentStageId, envId, 'CONFIGURES_ENV', relPath, ll.startLine, {
                            directive,
                            key,
                        });
                    }
                    continue;
                }
                // EXPOSE <port>
                const exposeMatch = ll.text.match(/^EXPOSE\s+([\s\S]+)$/i);
                if (exposeMatch) {
                    const ports = exposeMatch[1].trim().split(/\s+/);
                    for (const rawPort of ports) {
                        if (!rawPort)
                            continue;
                        const portId = `scip-endpoint port EXPOSE:${rawPort}#`;
                        addNode({
                            id: portId,
                            kind: 'RouteEndpoint',
                            name: `EXPOSE ${rawPort}`,
                            qualifiedName: `port.${rawPort}`,
                            packageName: 'container',
                            filePath: relPath,
                            language: 'dockerfile',
                            startLine: ll.startLine,
                            startCol: 1,
                            endLine: ll.endLine,
                            endCol: 1,
                            signature: `EXPOSE ${rawPort}`,
                            docstring: `Exposed container port ${rawPort}`,
                            exported: true,
                            complexity: 1,
                            labels: ['RouteEndpoint', 'ContainerPort'],
                            properties: { port: rawPort },
                        });
                        addEdge(currentStageId, portId, 'HANDLES_ROUTE', relPath, ll.startLine, {
                            port: rawPort,
                        });
                    }
                    continue;
                }
                // ENTRYPOINT / CMD / HEALTHCHECK
                const cmdMatch = ll.text.match(/^(ENTRYPOINT|CMD|HEALTHCHECK)\s+([\s\S]+)$/i);
                if (cmdMatch) {
                    const directive = cmdMatch[1].toUpperCase();
                    const cmdId = `scip-docker cmd container 1.0.0 ${relPath}:${directive}:L${ll.startLine}#`;
                    addNode({
                        id: cmdId,
                        kind: 'Function',
                        name: directive,
                        qualifiedName: `docker.${relPath}.${directive}`,
                        packageName: 'container',
                        filePath: relPath,
                        language: 'dockerfile',
                        startLine: ll.startLine,
                        startCol: 1,
                        endLine: nextStartLine ? Math.min(ll.endLine, nextStartLine - 1) : ll.endLine,
                        endCol: 1,
                        signature: ll.text.slice(0, 120),
                        docstring: `Dockerfile ${directive} instruction`,
                        exported: true,
                        complexity: 1,
                        labels: ['Function', 'DockerCommand'],
                        properties: { directive },
                    });
                    addEdge(currentStageId, cmdId, 'CONTAINS', relPath, ll.startLine);
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
//# sourceMappingURL=dockerfile-adapter.js.map