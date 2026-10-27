import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
function findGoClosingBrace(lines, startLineIdx) {
    let depth = 0;
    let seenOpen = false;
    for (let i = startLineIdx; i < lines.length; i++) {
        const line = lines[i];
        let inString = false;
        let stringChar = '';
        for (let c = 0; c < line.length; c++) {
            const ch = line[c];
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
            if (inString)
                continue;
            if (ch === '{') {
                depth += 1;
                seenOpen = true;
            }
            else if (ch === '}') {
                depth -= 1;
                if (seenOpen && depth <= 0) {
                    return i + 1;
                }
            }
        }
    }
    return Math.min(lines.length, startLineIdx + 1);
}
function computeGoComplexity(bodyLines) {
    let c = 1;
    for (const raw of bodyLines) {
        const line = raw.replace(/\/\/.*$/, '');
        if (/\b(if|for|case|select)\b/.test(line))
            c += 1;
        if (line.includes('&&') || line.includes('||'))
            c += 1;
    }
    return c;
}
export class GoCompilerAdapter {
    name = 'go';
    languages = ['go', 'templ'];
    supportsFile(filePath) {
        const norm = filePath.replace(/\\/g, '/');
        if (norm.includes('node_modules') ||
            norm.includes('vendor/') ||
            norm.includes('.git/') ||
            norm.includes('.ast-graph') ||
            norm.endsWith('_templ.go')) {
            return false;
        }
        return norm.endsWith('.go') || norm.endsWith('.templ');
    }
    discoverGoFiles(workspaceRoot) {
        const results = [];
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
        const walk = (dir) => {
            if (!fs.existsSync(dir))
                return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (skipDirs.has(entry.name))
                    continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                }
                else if (entry.isFile()) {
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
    detectGoModuleName(workspaceRoot) {
        const goModPath = path.join(workspaceRoot, 'go.mod');
        if (fs.existsSync(goModPath)) {
            try {
                const raw = fs.readFileSync(goModPath, 'utf8');
                const m = raw.match(/^\s*module\s+([^\s]+)/m);
                if (m?.[1])
                    return m[1].trim();
            }
            catch {
                // ignore
            }
        }
        return path.basename(workspaceRoot);
    }
    extract(workspaceRoot, targetFiles) {
        const resolvedRoot = path.resolve(workspaceRoot);
        const moduleName = this.detectGoModuleName(resolvedRoot);
        const allFiles = this.discoverGoFiles(resolvedRoot);
        const targetRelSet = targetFiles
            ? new Set(targetFiles.map((f) => path.isAbsolute(f)
                ? path.relative(resolvedRoot, f).split(path.sep).join('/')
                : f.replace(/^\.\//, '').split(path.sep).join('/')))
            : null;
        const filesBatch = [];
        const nodesMap = new Map();
        const edgesMap = new Map();
        if (allFiles.length === 0) {
            return { compiler: this.name, files: [], nodes: [], edges: [], diagnostics: [] };
        }
        const addNode = (n) => {
            nodesMap.set(n.id, n);
        };
        const addEdge = (srcId, dstId, kind, filePath, line, properties = {}) => {
            if (!srcId || !dstId || srcId === dstId)
                return;
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
        const structIdByName = new Map();
        const fieldIdByStructAndName = new Map();
        const fieldIdsByName = new Map();
        const funcIdsByName = new Map();
        const callables = [];
        // Pass 1: Discover packages, files, structs, interfaces, functions, methods, tests, and .templ components
        for (const absPath of allFiles) {
            const relPath = path.relative(resolvedRoot, absPath).split(path.sep).join('/');
            if (!fs.existsSync(absPath))
                continue;
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
            let suiteId = null;
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
                    const line = lines[i];
                    const templMatch = line.match(/^\s*templ\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
                    if (templMatch) {
                        const compName = templMatch[1];
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
                            });
                        }
                    }
                }
                continue;
            }
            // Parse Go declarations in `.go` files
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // 1. Struct definition: `type Foo struct {`
                const structMatch = line.match(/^\s*type\s+([A-Za-z0-9_]+)\s+struct\s*\{/);
                if (structMatch) {
                    const structName = structMatch[1];
                    const startLine = i + 1;
                    const endLine = findGoClosingBrace(lines, i);
                    const structId = `scip-go gomod ${moduleName} 1.0.0 ${relPath}/${structName}#`;
                    structIdByName.set(structName, structId);
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
                        const fLine = lines[fIdx].replace(/\/\/.*$/, '').trim();
                        if (!fLine || fLine.startsWith('}') || fLine.startsWith('{'))
                            continue;
                        const fieldMatch = fLine.match(/^([A-Za-z0-9_]+)\s+([^\s`]+)(?:\s+`([^`]*)`)?/);
                        if (fieldMatch) {
                            const fieldName = fieldMatch[1];
                            const fieldType = fieldMatch[2];
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
                            }
                        }
                    }
                    continue;
                }
                // 2. Interface definition: `type Bar interface {`
                const ifaceMatch = line.match(/^\s*type\s+([A-Za-z0-9_]+)\s+interface\s*\{/);
                if (ifaceMatch) {
                    const ifaceName = ifaceMatch[1];
                    const startLine = i + 1;
                    const endLine = findGoClosingBrace(lines, i);
                    const ifaceId = `scip-go gomod ${moduleName} 1.0.0 ${relPath}/${ifaceName}#`;
                    structIdByName.set(ifaceName, ifaceId);
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
                            const mLine = lines[mIdx].replace(/\/\/.*$/, '').trim();
                            const mMatch = mLine.match(/^([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*(.*)$/);
                            if (mMatch) {
                                const mName = mMatch[1];
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
                            }
                        }
                    }
                    continue;
                }
                // 3. Receiver method or function: `func (r *Recv) Name(args...) ... {` or `func Name(args...) ... {`
                const funcMatch = line.match(/^\s*func\s+(?:\(\s*([A-Za-z0-9_]+)?\s*\*?([A-Za-z0-9_]+)(?:\[[^\]]+\])?\s*\)\s+)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
                if (funcMatch) {
                    const recvVar = funcMatch[1];
                    const recvType = funcMatch[2];
                    const fnName = funcMatch[3];
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
                        }
                        else if (recvType && structIdByName.has(recvType)) {
                            addEdge(structIdByName.get(recvType), fnId, 'CONTAINS', relPath, startLine);
                        }
                        else {
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
                        });
                    }
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
                const rawLine = callable.bodyLines[offset];
                const lineNo = callable.startLine + offset;
                if (isTemplFile) {
                    // Extract HTMX route bindings: hx-get, hx-post, hx-delete, hx-put, action
                    const htmxRegex = /\b(hx-get|hx-post|hx-delete|hx-put|hx-patch|action)\s*=\s*"([^"]+)"/g;
                    let hm;
                    while ((hm = htmxRegex.exec(rawLine)) !== null) {
                        const attr = hm[1];
                        const rawUrl = hm[2].split('?')[0].trim();
                        if (!rawUrl.startsWith('/'))
                            continue;
                        const method = attr === 'hx-post' || attr === 'action'
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
                // 1. Detect Go HTTP route registrations: mux.HandleFunc("/admin/...", handler) or http.HandleFunc(...)
                const handleMatch = line.match(/\b(?:HandleFunc|Handle)\s*\(\s*"([^"]+)"\s*,\s*([A-Za-z0-9_.]+)/);
                if (handleMatch) {
                    const rawPattern = handleMatch[1].trim();
                    const handlerExpr = handleMatch[2].trim();
                    const parts = rawPattern.split(/\s+/);
                    const method = parts.length > 1 ? parts[0].toUpperCase() : 'HTTP';
                    const routePath = parts.length > 1 ? parts[1] : parts[0];
                    const routeId = `scip-endpoint http ROUTE:${routePath}#`;
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
                        signature: `HandleFunc("${rawPattern}", ${handlerExpr})`,
                        docstring: `Go ServeMux route ${rawPattern} -> ${handlerExpr}`,
                        exported: true,
                        complexity: 1,
                        labels: ['RouteEndpoint', 'HttpEndpoint', 'GoServeMuxRoute'],
                        properties: { method, path: routePath, handler: handlerExpr },
                    });
                    const handlerShort = handlerExpr.split('.').pop();
                    const handlerTargets = funcIdsByName.get(handlerShort) ?? [];
                    if (handlerTargets.length > 0 && !callable.isTest) {
                        for (const hId of handlerTargets) {
                            addEdge(hId, routeId, 'HANDLES_ROUTE', callable.filePath, lineNo, {
                                method,
                                path: routePath,
                            });
                        }
                    }
                    else {
                        addEdge(callable.id, routeId, callable.isTest ? 'TESTS_SYMBOL' : 'HANDLES_ROUTE', callable.filePath, lineNo, { method, path: routePath });
                    }
                }
                // 2. Receiver / struct field reads & writes: `r.Field = ...` or `r.Field`
                if (callable.receiverVar && callable.receiverType) {
                    const recvRegex = new RegExp(`\\b${callable.receiverVar}\\.([A-Za-z0-9_]+)\\b`, 'g');
                    let rm;
                    while ((rm = recvRegex.exec(line)) !== null) {
                        const memberName = rm[1];
                        const afterIdx = rm.index + rm[0].length;
                        const rest = line.slice(afterIdx).trimStart();
                        if (rest.startsWith('('))
                            continue; // Method call handled below
                        const fieldId = fieldIdByStructAndName.get(`${callable.receiverType}.${memberName}`) ??
                            fieldIdsByName.get(memberName)?.[0];
                        if (fieldId) {
                            const isWrite = /^(=|\+=|-=|\*=|\/=|\+\+|--)/.test(rest) && !rest.startsWith('==');
                            addEdge(callable.id, fieldId, isWrite ? 'WRITES_PROPERTY' : 'READS_PROPERTY', callable.filePath, lineNo, { property: memberName });
                        }
                    }
                }
                // 3. Function & Method Calls: `foo(...)` or `obj.Bar(...)`
                const callRegex = /\b(?:([A-Za-z0-9_]+)\.)?([A-Za-z0-9_]+)\s*\(/g;
                let cm;
                while ((cm = callRegex.exec(line)) !== null) {
                    const calleeName = cm[2];
                    if (goKeywords.has(calleeName) || calleeName === callable.name)
                        continue;
                    const targets = funcIdsByName.get(calleeName);
                    if (targets && targets.length > 0) {
                        const targetId = targets[0];
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
//# sourceMappingURL=go-adapter.js.map