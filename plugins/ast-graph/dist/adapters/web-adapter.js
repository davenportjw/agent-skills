import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const IGNORED_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    'site',
    'out',
    '.terraform',
    '.ast-graph',
    '.venv',
    'venv',
    '__pycache__',
    '.pytest_cache',
    '.ruff_cache',
    '.mypy_cache',
    '.cache',
]);
const COMPOSITE_EXTENSIONS = new Set([
    '.html',
    '.htm',
    '.jinja',
    '.jinja2',
    '.njk',
    '.astro',
    '.vue',
    '.svelte',
]);
const STYLESHEET_EXTENSIONS = new Set(['.css']);
function isSupportedWebFile(filePath) {
    const lower = filePath.toLowerCase();
    for (const ext of COMPOSITE_EXTENSIONS) {
        if (lower.endsWith(ext))
            return true;
    }
    for (const ext of STYLESHEET_EXTENSIONS) {
        if (lower.endsWith(ext))
            return true;
    }
    return false;
}
export class WebCompilerAdapter {
    name = 'web-composite';
    languages = ['html', 'css'];
    supportsFile(filePath) {
        if (filePath.includes('node_modules') ||
            filePath.includes('.venv') ||
            filePath.includes('/dist/') ||
            filePath.includes('/build/')) {
            return false;
        }
        return isSupportedWebFile(filePath);
    }
    discoverWebFiles(workspaceRoot) {
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
                else if (entry.isFile() && isSupportedWebFile(entry.name)) {
                    results.push(full);
                }
            }
        };
        walk(path.resolve(workspaceRoot));
        return results.sort();
    }
    extract(workspaceRoot, targetFiles) {
        const resolvedRoot = path.resolve(workspaceRoot);
        const allWebFiles = this.discoverWebFiles(resolvedRoot);
        if (allWebFiles.length === 0) {
            return { compiler: this.name, files: [], nodes: [], edges: [], diagnostics: [] };
        }
        const targetRelSet = targetFiles
            ? new Set(targetFiles.map((f) => path.isAbsolute(f)
                ? path.relative(resolvedRoot, f).split(path.sep).join('/')
                : f.replace(/^\.\//, '').split(path.sep).join('/')))
            : null;
        const pkgName = path.basename(resolvedRoot) || 'web-ui';
        const filesBatch = [];
        const nodesMap = new Map();
        const edgesMap = new Map();
        const addNode = (n) => {
            nodesMap.set(n.id, n);
        };
        const addEdge = (e) => {
            if (!e.srcId || !e.dstId || e.srcId === e.dstId)
                return;
            edgesMap.set(`${e.srcId}|${e.dstId}|${e.kind}|${e.filePath}|${e.line}`, e);
        };
        const firstRel = path.relative(resolvedRoot, allWebFiles[0]).split(path.sep).join('/');
        const pkgId = `scip-web ui ${pkgName} 0.1.0 package#`;
        addNode({
            id: pkgId,
            kind: 'WorkspacePackage',
            name: `${pkgName}-web`,
            qualifiedName: `${pkgName}-web`,
            packageName: pkgName,
            filePath: firstRel,
            language: 'html',
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 1,
            signature: `web composite module ${pkgName}`,
            docstring: 'Web templates, composite components, embedded scripts, and stylesheets',
            exported: true,
            complexity: 1,
            labels: ['WorkspacePackage', 'WebModule'],
            properties: {},
        });
        for (const absPath of allWebFiles) {
            const relPath = path.relative(resolvedRoot, absPath).split(path.sep).join('/');
            if (targetRelSet && !targetRelSet.has(relPath))
                continue;
            if (!fs.existsSync(absPath))
                continue;
            const stat = fs.statSync(absPath);
            const content = fs.readFileSync(absPath, 'utf8');
            const lines = content.split('\n');
            const sha256 = crypto.createHash('sha256').update(content).digest('hex');
            const isCss = relPath.toLowerCase().endsWith('.css');
            const language = isCss ? 'css' : 'html';
            filesBatch.push({
                filePath: relPath,
                packageName: pkgName,
                language,
                sha256,
                mtimeMs: stat.mtimeMs,
                sizeBytes: stat.size,
                lineCount: lines.length,
            });
            const fileId = `scip-web ui ${pkgName} 0.1.0 ${relPath}/`;
            addNode({
                id: fileId,
                kind: 'File',
                name: path.basename(relPath),
                qualifiedName: relPath,
                packageName: pkgName,
                filePath: relPath,
                language,
                startLine: 1,
                startCol: 1,
                endLine: Math.max(1, lines.length),
                endCol: 1,
                signature: `${language} file ${relPath} (${lines.length} lines)`,
                docstring: '',
                exported: true,
                complexity: 1,
                labels: ['File', isCss ? 'StylesheetFile' : 'CompositeWebFile'],
                properties: { lineCount: lines.length },
            });
            addEdge({
                srcId: pkgId,
                dstId: fileId,
                kind: 'CONTAINS',
                filePath: relPath,
                line: 1,
                col: 1,
                weight: 1,
                properties: {},
            });
            if (isCss) {
                this.indexStylesheetRegion({
                    content,
                    baseLineOffset: 1,
                    relPath,
                    pkgName,
                    fileId,
                    addNode,
                    addEdge,
                });
            }
            else {
                this.indexCompositeWebDocument({
                    content,
                    lines,
                    relPath,
                    pkgName,
                    fileId,
                    addNode,
                    addEdge,
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
    /**
     * Demultiplexes a composite HTML / Jinja2 / Vue / Svelte / Astro document into:
     * 1. Structural DOM & template landmarks (<section>, <dialog>, <template>, <form>, {% block %}, id="...")
     * 2. Embedded <style> blocks -> delegated to indexStylesheetRegion with exact line offset preservation
     * 3. Embedded <script> blocks -> delegated to TypeScript AST parser (ts.createSourceFile) with newline padding
     *    so functions, classes, event handlers, fetch('/api/...') CALLS_ROUTE edges, and WebMCP tools have exact host line numbers.
     */
    indexCompositeWebDocument(params) {
        const { content, lines, relPath, pkgName, fileId, addNode, addEdge } = params;
        const landmarkById = new Map();
        // 1. Extract Jinja2 / Nunjucks {% block name %} and {% macro name %} spans
        const blockStack = [];
        for (let i = 0; i < lines.length; i++) {
            const lineText = lines[i] ?? '';
            const lineNum = i + 1;
            const blockMatch = lineText.match(/\{%-?\s*(block|macro)\s+([A-Za-z0-9_]+)(\([^)]*\))?/);
            if (blockMatch) {
                const bKind = blockMatch[1];
                const bName = blockMatch[2];
                const bArgs = blockMatch[3] ?? '';
                blockStack.push({
                    kind: bKind,
                    name: bName,
                    startLine: lineNum,
                    sig: `{% ${bKind} ${bName}${bArgs} %}`,
                });
            }
            const endMatch = lineText.match(/\{%-?\s*end(block|macro)\b/);
            if (endMatch && blockStack.length > 0) {
                const opened = blockStack.pop();
                const symId = `scip-web ui ${pkgName} 0.1.0 ${relPath}/template-${opened.kind}:${opened.name}#`;
                addNode({
                    id: symId,
                    kind: 'TemplateLandmark',
                    name: `${opened.kind}:${opened.name}`,
                    qualifiedName: `${relPath}#${opened.name}`,
                    packageName: pkgName,
                    filePath: relPath,
                    language: 'html',
                    startLine: opened.startLine,
                    startCol: 1,
                    endLine: lineNum,
                    endCol: lineText.length + 1,
                    signature: opened.sig,
                    docstring: `Template ${opened.kind} ${opened.name}`,
                    exported: true,
                    complexity: 1,
                    labels: ['TemplateLandmark', 'JinjaBlock'],
                    properties: { templateConstruct: opened.kind },
                });
                addEdge({
                    srcId: fileId,
                    dstId: symId,
                    kind: 'CONTAINS',
                    filePath: relPath,
                    line: opened.startLine,
                    col: 1,
                    weight: 1,
                    properties: {},
                });
            }
        }
        // 2. Extract HTML structural landmarks & HTMX / Form route bindings
        const LANDMARK_TAGS = new Set([
            'header',
            'nav',
            'main',
            'aside',
            'footer',
            'section',
            'article',
            'dialog',
            'template',
            'form',
            'agent-embed',
            'details',
        ]);
        const tagStack = [];
        const VOID_TAGS = new Set([
            'area',
            'base',
            'br',
            'col',
            'embed',
            'hr',
            'img',
            'input',
            'link',
            'meta',
            'param',
            'source',
            'track',
            'wbr',
        ]);
        let inScriptOrStyle = null;
        for (let i = 0; i < lines.length; i++) {
            const lineText = lines[i] ?? '';
            const lineNum = i + 1;
            if (inScriptOrStyle) {
                if ((inScriptOrStyle === 'script' && /<\/script\s*>/i.test(lineText)) ||
                    (inScriptOrStyle === 'style' && /<\/style\s*>/i.test(lineText))) {
                    inScriptOrStyle = null;
                }
                continue;
            }
            // Check for HTMX or form route attributes on this line
            const htmxRegex = /\b(?:hx-(get|post|put|delete|patch)|action)\s*=\s*["']([^"']+)["']/gi;
            let routeMatch;
            while ((routeMatch = htmxRegex.exec(lineText)) !== null) {
                const method = (routeMatch[1] ?? 'POST').toUpperCase();
                const rawUrl = routeMatch[2].trim();
                if (rawUrl.startsWith('/') && !rawUrl.startsWith('//')) {
                    const cleanRoute = rawUrl.split('?')[0];
                    const routeNodeId = `scip-web route ${pkgName} 0.1.0 ${method}:${cleanRoute}#`;
                    addNode({
                        id: routeNodeId,
                        kind: 'RouteEndpoint',
                        name: `${method} ${cleanRoute}`,
                        qualifiedName: `${method} ${cleanRoute}`,
                        packageName: pkgName,
                        filePath: relPath,
                        language: 'html',
                        startLine: lineNum,
                        startCol: 1,
                        endLine: lineNum,
                        endCol: lineText.length + 1,
                        signature: `${method} ${cleanRoute}`,
                        docstring: `Template route reference ${method} ${cleanRoute}`,
                        exported: true,
                        complexity: 1,
                        labels: ['RouteEndpoint', 'TemplateRouteBinding'],
                        properties: { method, path: cleanRoute },
                    });
                    const enclosingLandmark = [...tagStack].reverse().find((t) => t.isLandmark && t.idAttr);
                    const callerId = (enclosingLandmark ? landmarkById.get(enclosingLandmark.idAttr) : undefined) ?? fileId;
                    addEdge({
                        srcId: callerId,
                        dstId: routeNodeId,
                        kind: 'CALLS_ROUTE',
                        filePath: relPath,
                        line: lineNum,
                        col: 1,
                        weight: 1,
                        properties: { method, path: cleanRoute },
                    });
                }
            }
            if (/<script\b/i.test(lineText) && !/<\/script\s*>/i.test(lineText)) {
                inScriptOrStyle = 'script';
                continue;
            }
            if (/<style\b/i.test(lineText) && !/<\/style\s*>/i.test(lineText)) {
                inScriptOrStyle = 'style';
                continue;
            }
            // Scan tags on this line
            const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9_-]*)([^>]*?)\/?>/g;
            let m;
            while ((m = tagRegex.exec(lineText)) !== null) {
                const fullTag = m[0];
                const tagName = m[1].toLowerCase();
                const attrs = m[2] ?? '';
                if (tagName === 'script' || tagName === 'style' || VOID_TAGS.has(tagName))
                    continue;
                const isClosing = fullTag.startsWith('</');
                const isSelfClosing = fullTag.endsWith('/>');
                if (!isClosing) {
                    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
                    const classMatch = attrs.match(/\bclass\s*=\s*["']([^"']+)["']/i);
                    const ariaMatch = attrs.match(/\b(?:aria-label|data-panel|data-section|data-tab)\s*=\s*["']([^"']+)["']/i);
                    const idAttr = idMatch?.[1]?.trim() ?? '';
                    const classAttr = classMatch?.[1]?.trim().split(/\s+/).slice(0, 2).join('.') ?? '';
                    const labelAttr = ariaMatch?.[1]?.trim() ?? '';
                    const isLandmark = LANDMARK_TAGS.has(tagName) ||
                        Boolean(idAttr && (tagName === 'div' || tagName === 'ul' || tagName === 'table' || tagName === 'canvas'));
                    const selectorName = idAttr
                        ? `${tagName}#${idAttr}`
                        : labelAttr
                            ? `${tagName}[${labelAttr}]`
                            : classAttr
                                ? `${tagName}.${classAttr}`
                                : tagName;
                    const sig = fullTag.replace(/\s+/g, ' ').trim();
                    if (isSelfClosing) {
                        if (isLandmark) {
                            const symId = `scip-web ui ${pkgName} 0.1.0 ${relPath}/dom:${selectorName}:L${lineNum}#`;
                            if (idAttr)
                                landmarkById.set(idAttr, symId);
                            addNode({
                                id: symId,
                                kind: 'TemplateLandmark',
                                name: selectorName,
                                qualifiedName: `${relPath}::${selectorName}`,
                                packageName: pkgName,
                                filePath: relPath,
                                language: 'html',
                                startLine: lineNum,
                                startCol: 1,
                                endLine: lineNum,
                                endCol: lineText.length + 1,
                                signature: sig,
                                docstring: `DOM landmark ${selectorName}`,
                                exported: Boolean(idAttr),
                                complexity: 1,
                                labels: ['TemplateLandmark', 'DomElement'],
                                properties: { tag: tagName, domId: idAttr || undefined },
                            });
                            addEdge({
                                srcId: fileId,
                                dstId: symId,
                                kind: 'CONTAINS',
                                filePath: relPath,
                                line: lineNum,
                                col: 1,
                                weight: 1,
                                properties: {},
                            });
                        }
                    }
                    else {
                        tagStack.push({
                            tag: tagName,
                            idAttr,
                            classAttr,
                            labelAttr,
                            startLine: lineNum,
                            isLandmark,
                            signature: sig,
                        });
                    }
                }
                else {
                    // Find matching opening tag on stack
                    let matchIdx = -1;
                    for (let k = tagStack.length - 1; k >= 0; k--) {
                        if (tagStack[k].tag === tagName) {
                            matchIdx = k;
                            break;
                        }
                    }
                    if (matchIdx >= 0) {
                        const [opened] = tagStack.splice(matchIdx, 1);
                        if (opened && opened.isLandmark) {
                            const spanLines = lineNum - opened.startLine + 1;
                            // Index all named (#id / aria-label) landmarks or structural tags spanning >= 4 lines
                            if (opened.idAttr || opened.labelAttr || spanLines >= 4 || LANDMARK_TAGS.has(opened.tag)) {
                                const selectorName = opened.idAttr
                                    ? `${opened.tag}#${opened.idAttr}`
                                    : opened.labelAttr
                                        ? `${opened.tag}[${opened.labelAttr}]`
                                        : opened.classAttr
                                            ? `${opened.tag}.${opened.classAttr}`
                                            : `${opened.tag}@L${opened.startLine}`;
                                const symId = `scip-web ui ${pkgName} 0.1.0 ${relPath}/dom:${selectorName}:L${opened.startLine}#`;
                                if (opened.idAttr)
                                    landmarkById.set(opened.idAttr, symId);
                                addNode({
                                    id: symId,
                                    kind: 'TemplateLandmark',
                                    name: selectorName,
                                    qualifiedName: `${relPath}::${selectorName}`,
                                    packageName: pkgName,
                                    filePath: relPath,
                                    language: 'html',
                                    startLine: opened.startLine,
                                    startCol: 1,
                                    endLine: lineNum,
                                    endCol: lineText.length + 1,
                                    signature: `${opened.signature} (${spanLines} lines)`,
                                    docstring: `DOM landmark ${selectorName} (L${opened.startLine}-L${lineNum})`,
                                    exported: Boolean(opened.idAttr || LANDMARK_TAGS.has(opened.tag)),
                                    complexity: Math.max(1, Math.min(20, Math.ceil(spanLines / 25))),
                                    labels: ['TemplateLandmark', 'DomElement'],
                                    properties: { tag: opened.tag, domId: opened.idAttr || undefined },
                                });
                                addEdge({
                                    srcId: fileId,
                                    dstId: symId,
                                    kind: 'CONTAINS',
                                    filePath: relPath,
                                    line: opened.startLine,
                                    col: 1,
                                    weight: 1,
                                    properties: {},
                                });
                            }
                        }
                    }
                }
            }
        }
        // 3. Extract embedded <style>...</style> blocks and delegate to indexStylesheetRegion
        const styleBlockRegex = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
        let styleMatch;
        while ((styleMatch = styleBlockRegex.exec(content)) !== null) {
            const fullMatch = styleMatch[0];
            const innerCss = styleMatch[1] ?? '';
            const prefixBeforeMatch = content.slice(0, styleMatch.index);
            const openTagLine = prefixBeforeMatch.split('\n').length;
            const openTagEndOffset = fullMatch.indexOf('>') + 1;
            const openTagLines = fullMatch.slice(0, openTagEndOffset).split('\n').length - 1;
            const innerStartLine = openTagLine + openTagLines;
            const endLine = openTagLine + fullMatch.split('\n').length - 1;
            const styleBlockId = `scip-web ui ${pkgName} 0.1.0 ${relPath}/style@L${openTagLine}#`;
            addNode({
                id: styleBlockId,
                kind: 'StylesheetSection',
                name: `<style>@L${openTagLine}`,
                qualifiedName: `${relPath}::<style>@L${openTagLine}`,
                packageName: pkgName,
                filePath: relPath,
                language: 'css',
                startLine: openTagLine,
                startCol: 1,
                endLine,
                endCol: 1,
                signature: `<style> embedded stylesheet (${endLine - openTagLine + 1} lines)`,
                docstring: `Embedded stylesheet block at L${openTagLine}-L${endLine}`,
                exported: true,
                complexity: 1,
                labels: ['StylesheetSection', 'EmbeddedStyleBlock'],
                properties: {},
            });
            addEdge({
                srcId: fileId,
                dstId: styleBlockId,
                kind: 'CONTAINS',
                filePath: relPath,
                line: openTagLine,
                col: 1,
                weight: 1,
                properties: {},
            });
            this.indexStylesheetRegion({
                content: innerCss,
                baseLineOffset: innerStartLine,
                relPath,
                pkgName,
                fileId: styleBlockId,
                addNode,
                addEdge,
            });
        }
        // 4. Extract embedded <script>...</script> blocks and delegate to TypeScript AST parser
        const scriptBlockRegex = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
        let scriptMatch;
        while ((scriptMatch = scriptBlockRegex.exec(content)) !== null) {
            const attrs = (scriptMatch[1] ?? '').toLowerCase();
            const innerScript = scriptMatch[2] ?? '';
            if (!innerScript.trim())
                continue;
            // Skip non-executable JSON data blocks (e.g. application/ld+json, importmap)
            if (attrs.includes('application/ld+json') ||
                attrs.includes('application/json') ||
                attrs.includes('importmap')) {
                continue;
            }
            const fullMatch = scriptMatch[0];
            const prefixBeforeMatch = content.slice(0, scriptMatch.index);
            const openTagLine = prefixBeforeMatch.split('\n').length;
            const openTagEndOffset = fullMatch.indexOf('>') + 1;
            const openTagLines = fullMatch.slice(0, openTagEndOffset).split('\n').length - 1;
            const innerStartLine = openTagLine + openTagLines;
            const endLine = openTagLine + fullMatch.split('\n').length - 1;
            const scriptBlockId = `scip-web ui ${pkgName} 0.1.0 ${relPath}/script@L${openTagLine}#`;
            addNode({
                id: scriptBlockId,
                kind: 'TemplateLandmark',
                name: `<script>@L${openTagLine}`,
                qualifiedName: `${relPath}::<script>@L${openTagLine}`,
                packageName: pkgName,
                filePath: relPath,
                language: 'javascript',
                startLine: openTagLine,
                startCol: 1,
                endLine,
                endCol: 1,
                signature: `<script> embedded module (${endLine - openTagLine + 1} lines)`,
                docstring: `Embedded script block at L${openTagLine}-L${endLine}`,
                exported: true,
                complexity: 1,
                labels: ['TemplateLandmark', 'EmbeddedScriptBlock'],
                properties: {},
            });
            addEdge({
                srcId: fileId,
                dstId: scriptBlockId,
                kind: 'CONTAINS',
                filePath: relPath,
                line: openTagLine,
                col: 1,
                weight: 1,
                properties: {},
            });
            this.indexEmbeddedScriptAst({
                scriptContent: innerScript,
                baseLineOffset: innerStartLine,
                relPath,
                pkgName,
                parentId: scriptBlockId,
                landmarkById,
                addNode,
                addEdge,
            });
        }
    }
    /**
     * Delegates an embedded <script> region to TypeScript's AST parser with leading newline padding
     * so all extracted functions, classes, event listeners, fetch() CALLS_ROUTE edges, and WebMCP
     * tools carry exact 1-based line numbers from the host composite document.
     */
    indexEmbeddedScriptAst(params) {
        const { scriptContent, baseLineOffset, relPath, pkgName, parentId, landmarkById, addNode, addEdge, } = params;
        // Neutralize Jinja2 {{ ... }} or {% ... %} interpolations inside JS so ts.createSourceFile parses cleanly
        const sanitizedScript = scriptContent
            .replace(/\{\{[\s\S]*?\}\}/g, (m) => 'null' + ' '.repeat(Math.max(0, m.length - 4)))
            .replace(/\{%[\s\S]*?%\}/g, (m) => ' '.repeat(m.length));
        const paddedSource = '\n'.repeat(Math.max(0, baseLineOffset - 1)) + sanitizedScript;
        const sourceFile = ts.createSourceFile(`${relPath}.ts`, paddedSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const getPos = (pos) => {
            const lc = sourceFile.getLineAndCharacterOfPosition(pos);
            return { line: lc.line + 1, col: lc.character + 1 };
        };
        const localSymByName = new Map();
        const computeComplexity = (node) => {
            let c = 1;
            const walk = (n) => {
                if (ts.isIfStatement(n) ||
                    ts.isForStatement(n) ||
                    ts.isForOfStatement(n) ||
                    ts.isForInStatement(n) ||
                    ts.isWhileStatement(n) ||
                    ts.isCaseClause(n) ||
                    ts.isCatchClause(n) ||
                    ts.isConditionalExpression(n)) {
                    c += 1;
                }
                ts.forEachChild(n, walk);
            };
            walk(node);
            return c;
        };
        // Pass 1: Collect functions, classes, methods, and major state declarations
        const visitDecls = (node, enclosingId, enclosingName) => {
            if (ts.isFunctionDeclaration(node) && node.name) {
                const fnName = node.name.text;
                const start = getPos(node.getStart(sourceFile));
                const end = getPos(node.getEnd());
                const symId = `scip-web js ${pkgName} 0.1.0 ${relPath}/${fnName}().`;
                const sig = node
                    .getText(sourceFile)
                    .split('{')[0]
                    .replace(/\s+/g, ' ')
                    .trim();
                localSymByName.set(fnName, symId);
                addNode({
                    id: symId,
                    kind: 'Function',
                    name: fnName,
                    qualifiedName: `${relPath}::${fnName}`,
                    packageName: pkgName,
                    filePath: relPath,
                    language: 'javascript',
                    startLine: start.line,
                    startCol: start.col,
                    endLine: end.line,
                    endCol: end.col,
                    signature: sig || `function ${fnName}()`,
                    docstring: `Embedded script function ${fnName}`,
                    exported: true,
                    complexity: computeComplexity(node),
                    labels: ['Function', 'EmbeddedScriptSymbol'],
                    properties: {},
                });
                addEdge({
                    srcId: enclosingId,
                    dstId: symId,
                    kind: 'CONTAINS',
                    filePath: relPath,
                    line: start.line,
                    col: start.col,
                    weight: 1,
                    properties: {},
                });
                ts.forEachChild(node, (child) => visitDecls(child, symId, fnName));
                return;
            }
            if (ts.isClassDeclaration(node) && node.name) {
                const clsName = node.name.text;
                const start = getPos(node.getStart(sourceFile));
                const end = getPos(node.getEnd());
                const symId = `scip-web js ${pkgName} 0.1.0 ${relPath}/${clsName}#`;
                localSymByName.set(clsName, symId);
                addNode({
                    id: symId,
                    kind: 'Class',
                    name: clsName,
                    qualifiedName: `${relPath}::${clsName}`,
                    packageName: pkgName,
                    filePath: relPath,
                    language: 'javascript',
                    startLine: start.line,
                    startCol: start.col,
                    endLine: end.line,
                    endCol: end.col,
                    signature: `class ${clsName}`,
                    docstring: `Embedded script class ${clsName}`,
                    exported: true,
                    complexity: computeComplexity(node),
                    labels: ['Class', 'EmbeddedScriptSymbol'],
                    properties: {},
                });
                addEdge({
                    srcId: enclosingId,
                    dstId: symId,
                    kind: 'CONTAINS',
                    filePath: relPath,
                    line: start.line,
                    col: start.col,
                    weight: 1,
                    properties: {},
                });
                for (const member of node.members) {
                    if (ts.isMethodDeclaration(member) && member.name) {
                        const mName = member.name.getText(sourceFile);
                        const mStart = getPos(member.getStart(sourceFile));
                        const mEnd = getPos(member.getEnd());
                        const mId = `scip-web js ${pkgName} 0.1.0 ${relPath}/${clsName}#${mName}().`;
                        localSymByName.set(mName, mId);
                        addNode({
                            id: mId,
                            kind: 'Method',
                            name: mName,
                            qualifiedName: `${clsName}.${mName}`,
                            packageName: pkgName,
                            filePath: relPath,
                            language: 'javascript',
                            startLine: mStart.line,
                            startCol: mStart.col,
                            endLine: mEnd.line,
                            endCol: mEnd.col,
                            signature: `${clsName}.${mName}()`,
                            docstring: '',
                            exported: true,
                            complexity: computeComplexity(member),
                            labels: ['Method', 'EmbeddedScriptSymbol'],
                            properties: {},
                        });
                        addEdge({
                            srcId: symId,
                            dstId: mId,
                            kind: 'CONTAINS',
                            filePath: relPath,
                            line: mStart.line,
                            col: mStart.col,
                            weight: 1,
                            properties: {},
                        });
                    }
                }
                return;
            }
            if (ts.isVariableStatement(node)) {
                for (const decl of node.declarationList.declarations) {
                    if (!ts.isIdentifier(decl.name) || !decl.initializer)
                        continue;
                    const varName = decl.name.text;
                    const init = decl.initializer;
                    const start = getPos(decl.getStart(sourceFile));
                    const end = getPos(decl.getEnd());
                    const isFn = ts.isArrowFunction(init) || ts.isFunctionExpression(init);
                    const spanLines = end.line - start.line + 1;
                    // Index arrow functions and non-trivial top-level objects/constants (or multi-line structures)
                    if (isFn || (!enclosingName && spanLines >= 3)) {
                        const kind = isFn ? 'Function' : 'Variable';
                        const symId = `scip-web js ${pkgName} 0.1.0 ${relPath}/${varName}${isFn ? '().' : '.'}`;
                        localSymByName.set(varName, symId);
                        addNode({
                            id: symId,
                            kind,
                            name: varName,
                            qualifiedName: enclosingName ? `${enclosingName}.${varName}` : `${relPath}::${varName}`,
                            packageName: pkgName,
                            filePath: relPath,
                            language: 'javascript',
                            startLine: start.line,
                            startCol: start.col,
                            endLine: end.line,
                            endCol: end.col,
                            signature: isFn ? `const ${varName} = (...) => ...` : `const ${varName}`,
                            docstring: '',
                            exported: !enclosingName,
                            complexity: isFn ? computeComplexity(init) : 1,
                            labels: [kind, 'EmbeddedScriptSymbol'],
                            properties: {},
                        });
                        addEdge({
                            srcId: enclosingId,
                            dstId: symId,
                            kind: 'CONTAINS',
                            filePath: relPath,
                            line: start.line,
                            col: start.col,
                            weight: 1,
                            properties: {},
                        });
                        if (isFn) {
                            ts.forEachChild(init, (child) => visitDecls(child, symId, varName));
                            continue;
                        }
                    }
                }
            }
            ts.forEachChild(node, (child) => visitDecls(child, enclosingId, enclosingName));
        };
        visitDecls(sourceFile, parentId);
        // Pass 2: Extract CALLS, fetch('/api/...') CALLS_ROUTE, WebMCP registerTool, and DOM getElementById REFERENCES
        const visitCalls = (node, currentCallerId) => {
            let nextCallerId = currentCallerId;
            if (ts.isFunctionDeclaration(node) && node.name) {
                nextCallerId = localSymByName.get(node.name.text) ?? currentCallerId;
            }
            else if (ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.initializer &&
                (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
                nextCallerId = localSymByName.get(node.name.text) ?? currentCallerId;
            }
            if (ts.isCallExpression(node)) {
                const exprText = node.expression.getText(sourceFile);
                const callPos = getPos(node.getStart(sourceFile));
                // 1. Direct call to another function in the embedded script
                const calleeName = ts.isIdentifier(node.expression)
                    ? node.expression.text
                    : ts.isPropertyAccessExpression(node.expression)
                        ? node.expression.name.text
                        : '';
                if (calleeName && localSymByName.has(calleeName)) {
                    addEdge({
                        srcId: nextCallerId,
                        dstId: localSymByName.get(calleeName),
                        kind: 'CALLS',
                        filePath: relPath,
                        line: callPos.line,
                        col: callPos.col,
                        weight: 1,
                        properties: {},
                    });
                }
                // 2. fetch('/api/...') or EventSource('/api/...') -> CALLS_ROUTE
                if (exprText === 'fetch' ||
                    exprText === 'window.fetch' ||
                    exprText.endsWith('.sendBeacon')) {
                    const firstArg = node.arguments[0];
                    let routeUrl = '';
                    if (firstArg && (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))) {
                        routeUrl = firstArg.text.trim();
                    }
                    else if (firstArg && ts.isTemplateExpression(firstArg)) {
                        routeUrl = firstArg.head.text.trim();
                    }
                    if (routeUrl.startsWith('/')) {
                        const cleanRoute = routeUrl.split('?')[0].replace(/\/+$/, '') || '/';
                        let method = 'GET';
                        const secondArg = node.arguments[1];
                        if (secondArg && ts.isObjectLiteralExpression(secondArg)) {
                            for (const prop of secondArg.properties) {
                                if (ts.isPropertyAssignment(prop) &&
                                    prop.name.getText(sourceFile) === 'method' &&
                                    ts.isStringLiteral(prop.initializer)) {
                                    method = prop.initializer.text.toUpperCase();
                                }
                            }
                        }
                        const routeId = `scip-web route ${pkgName} 0.1.0 ${method}:${cleanRoute}#`;
                        addNode({
                            id: routeId,
                            kind: 'RouteEndpoint',
                            name: `${method} ${cleanRoute}`,
                            qualifiedName: `${method} ${cleanRoute}`,
                            packageName: pkgName,
                            filePath: relPath,
                            language: 'javascript',
                            startLine: callPos.line,
                            startCol: callPos.col,
                            endLine: callPos.line,
                            endCol: callPos.col + 10,
                            signature: `fetch('${cleanRoute}', { method: '${method}' })`,
                            docstring: `Client fetch call to ${method} ${cleanRoute}`,
                            exported: true,
                            complexity: 1,
                            labels: ['RouteEndpoint', 'FetchRouteClient'],
                            properties: { method, path: cleanRoute },
                        });
                        addEdge({
                            srcId: nextCallerId,
                            dstId: routeId,
                            kind: 'CALLS_ROUTE',
                            filePath: relPath,
                            line: callPos.line,
                            col: callPos.col,
                            weight: 1,
                            properties: { method, path: cleanRoute },
                        });
                    }
                }
                // 3. WebMCP registerTool({ name: '...' })
                if (exprText.endsWith('registerTool') && node.arguments.length > 0) {
                    const arg0 = node.arguments[0];
                    let toolName = '';
                    if (ts.isObjectLiteralExpression(arg0)) {
                        for (const prop of arg0.properties) {
                            if (ts.isPropertyAssignment(prop) &&
                                prop.name.getText(sourceFile) === 'name' &&
                                ts.isStringLiteral(prop.initializer)) {
                                toolName = prop.initializer.text.trim();
                            }
                        }
                    }
                    else if (ts.isStringLiteral(arg0)) {
                        toolName = arg0.text.trim();
                    }
                    if (toolName) {
                        const endPos = getPos(node.getEnd());
                        const toolId = `scip-web webmcp ${pkgName} 0.1.0 ${relPath}/webmcp:${toolName}().`;
                        addNode({
                            id: toolId,
                            kind: 'Function',
                            name: `webmcp:${toolName}`,
                            qualifiedName: `${relPath}::webmcp:${toolName}`,
                            packageName: pkgName,
                            filePath: relPath,
                            language: 'javascript',
                            startLine: callPos.line,
                            startCol: callPos.col,
                            endLine: endPos.line,
                            endCol: endPos.col,
                            signature: `navigator.modelContext.registerTool({ name: "${toolName}" })`,
                            docstring: `WebMCP browser tool ${toolName}`,
                            exported: true,
                            complexity: computeComplexity(node),
                            labels: ['Function', 'WebMcpTool'],
                            properties: { webMcpTool: toolName },
                        });
                        addEdge({
                            srcId: nextCallerId,
                            dstId: toolId,
                            kind: 'CONTAINS',
                            filePath: relPath,
                            line: callPos.line,
                            col: callPos.col,
                            weight: 1,
                            properties: {},
                        });
                    }
                }
                // 4. document.getElementById('...') -> REFERENCES edge to TemplateLandmark
                if (exprText === 'document.getElementById' && node.arguments.length > 0) {
                    const arg0 = node.arguments[0];
                    if (ts.isStringLiteral(arg0)) {
                        const domId = arg0.text.trim();
                        const targetLandmarkId = landmarkById.get(domId);
                        if (targetLandmarkId) {
                            addEdge({
                                srcId: nextCallerId,
                                dstId: targetLandmarkId,
                                kind: 'REFERENCES',
                                filePath: relPath,
                                line: callPos.line,
                                col: callPos.col,
                                weight: 1,
                                properties: { domId },
                            });
                        }
                    }
                }
            }
            ts.forEachChild(node, (child) => visitCalls(child, nextCallerId));
        };
        visitCalls(sourceFile, parentId);
    }
    /**
     * Hierarchical CSS / Stylesheet structural parser.
     * Extracts:
     * - Section banner comments (/* === Section === *\/) spanning until the next banner
     * - At-rule containers (@media, @layer, @keyframes, @container, @supports)
     * - :root / theme custom property groups (--* tokens)
     * - Grouped or multi-line top-level component rule blocks so a 2,400-line stylesheet
     *   produces clean, navigable outline spans.
     */
    indexStylesheetRegion(params) {
        const { content, baseLineOffset, relPath, pkgName, fileId, addNode, addEdge } = params;
        const lines = content.split('\n');
        const totalLines = lines.length;
        // 1. Detect Section Banner Comments: e.g. /* === Header === */ or /* --- 1. Typography --- */
        const banners = [];
        for (let i = 0; i < totalLines; i++) {
            const lineText = (lines[i] ?? '').trim();
            const singleLineBanner = lineText.match(/^\/\*\s*(?:[=\-*#]{2,}\s*)?([A-Za-z0-9][A-Za-z0-9\s/&(),.:_-]{2,60}?)(?:\s*[=\-*#]{2,})?\s*\*\/$/);
            if (singleLineBanner) {
                const rawTitle = singleLineBanner[1].trim();
                // Only treat as a section banner if it has ===/--- markers, numbered prefix, or uppercase heading style
                if (/[=\-]{2,}/.test(lineText) ||
                    /^\d+[.)]\s+/.test(rawTitle) ||
                    rawTitle === rawTitle.toUpperCase()) {
                    banners.push({ title: rawTitle, startLine: baseLineOffset + i });
                }
            }
        }
        for (let b = 0; b < banners.length; b++) {
            const current = banners[b];
            const next = banners[b + 1];
            const endLine = next ? next.startLine - 1 : baseLineOffset + totalLines - 1;
            const symId = `scip-web css ${pkgName} 0.1.0 ${relPath}/section:${current.title.replace(/\s+/g, '_')}:L${current.startLine}#`;
            addNode({
                id: symId,
                kind: 'StylesheetSection',
                name: `Section: ${current.title}`,
                qualifiedName: `${relPath}::${current.title}`,
                packageName: pkgName,
                filePath: relPath,
                language: 'css',
                startLine: current.startLine,
                startCol: 1,
                endLine: Math.max(current.startLine, endLine),
                endCol: 1,
                signature: `/* ${current.title} */ (L${current.startLine}-L${Math.max(current.startLine, endLine)})`,
                docstring: `Stylesheet section ${current.title}`,
                exported: true,
                complexity: 1,
                labels: ['StylesheetSection', 'CssBannerSection'],
                properties: {},
            });
            addEdge({
                srcId: fileId,
                dstId: symId,
                kind: 'CONTAINS',
                filePath: relPath,
                line: current.startLine,
                col: 1,
                weight: 1,
                properties: {},
            });
        }
        const topBlocks = [];
        let braceDepth = 0;
        let inComment = false;
        let pendingHeaderLines = [];
        let currentBlockStartLine = 0;
        let currentBlockHeader = '';
        let currentBodyLines = [];
        for (let i = 0; i < totalLines; i++) {
            const rawLine = lines[i] ?? '';
            const lineNum = baseLineOffset + i;
            // Strip comments on this line while tracking multi-line /* ... */
            let cleanLine = '';
            let k = 0;
            while (k < rawLine.length) {
                if (inComment) {
                    const closeIdx = rawLine.indexOf('*/', k);
                    if (closeIdx === -1) {
                        k = rawLine.length;
                    }
                    else {
                        inComment = false;
                        k = closeIdx + 2;
                    }
                }
                else {
                    const openIdx = rawLine.indexOf('/*', k);
                    if (openIdx === -1) {
                        cleanLine += rawLine.slice(k);
                        break;
                    }
                    else {
                        cleanLine += rawLine.slice(k, openIdx);
                        const closeIdx = rawLine.indexOf('*/', openIdx + 2);
                        if (closeIdx === -1) {
                            inComment = true;
                            break;
                        }
                        else {
                            k = closeIdx + 2;
                        }
                    }
                }
            }
            const trimmed = cleanLine.trim();
            if (!trimmed)
                continue;
            for (let cIdx = 0; cIdx < cleanLine.length; cIdx++) {
                const ch = cleanLine[cIdx];
                if (ch === '{') {
                    if (braceDepth === 0) {
                        const beforeBrace = cleanLine.slice(0, cIdx).trim();
                        if (beforeBrace) {
                            pendingHeaderLines.push({ lineNum, text: beforeBrace });
                        }
                        currentBlockStartLine = pendingHeaderLines[0]?.lineNum ?? lineNum;
                        currentBlockHeader = pendingHeaderLines
                            .map((p) => p.text)
                            .join(' ')
                            .replace(/\s+/g, ' ')
                            .trim();
                        pendingHeaderLines = [];
                        currentBodyLines = [cleanLine];
                    }
                    else {
                        currentBodyLines.push(cleanLine);
                    }
                    braceDepth += 1;
                }
                else if (ch === '}') {
                    braceDepth = Math.max(0, braceDepth - 1);
                    if (braceDepth === 0 && currentBlockHeader) {
                        currentBodyLines.push(cleanLine);
                        topBlocks.push({
                            header: currentBlockHeader,
                            startLine: currentBlockStartLine,
                            endLine: lineNum,
                            bodyLines: currentBodyLines,
                        });
                        currentBlockHeader = '';
                        currentBodyLines = [];
                    }
                }
            }
            if (braceDepth === 0 && !cleanLine.includes('{') && !cleanLine.includes('}')) {
                if (trimmed.endsWith(';')) {
                    pendingHeaderLines = [];
                }
                else {
                    pendingHeaderLines.push({ lineNum, text: trimmed });
                }
            }
            else if (braceDepth > 0 && !cleanLine.includes('{') && !cleanLine.includes('}')) {
                currentBodyLines.push(cleanLine);
            }
        }
        // 3. Classify and coalesce top-level blocks into navigable AST symbols
        const getComponentPrefix = (selector) => {
            const firstSel = selector.split(',')[0].trim();
            const classMatch = firstSel.match(/^\.([A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)/);
            if (classMatch)
                return `.${classMatch[1]}`;
            const idMatch = firstSel.match(/^#([A-Za-z0-9_-]+)/);
            if (idMatch)
                return `#${idMatch[1]}`;
            const attrMatch = firstSel.match(/^(\[[^\]]+\])/);
            if (attrMatch)
                return attrMatch[1];
            return firstSel.split(/[\s>+~:]/)[0] || selector;
        };
        let idx = 0;
        while (idx < topBlocks.length) {
            const block = topBlocks[idx];
            const spanLines = block.endLine - block.startLine + 1;
            if (block.header.startsWith('@')) {
                const symId = `scip-web css ${pkgName} 0.1.0 ${relPath}/at:${block.header.slice(0, 40).replace(/\s+/g, '_')}:L${block.startLine}#`;
                addNode({
                    id: symId,
                    kind: 'CssAtRule',
                    name: block.header,
                    qualifiedName: `${relPath}::${block.header}`,
                    packageName: pkgName,
                    filePath: relPath,
                    language: 'css',
                    startLine: block.startLine,
                    startCol: 1,
                    endLine: block.endLine,
                    endCol: 1,
                    signature: `${block.header} { ... } (${spanLines} lines)`,
                    docstring: `CSS at-rule block ${block.header}`,
                    exported: true,
                    complexity: Math.max(1, Math.ceil(spanLines / 15)),
                    labels: ['CssAtRule', 'StylesheetSection'],
                    properties: {},
                });
                addEdge({
                    srcId: fileId,
                    dstId: symId,
                    kind: 'CONTAINS',
                    filePath: relPath,
                    line: block.startLine,
                    col: 1,
                    weight: 1,
                    properties: {},
                });
                idx += 1;
                continue;
            }
            if (block.header.includes(':root') ||
                block.header.includes('[data-theme') ||
                block.header.includes('.dark')) {
                const customProps = [];
                for (const bl of block.bodyLines) {
                    const pm = bl.match(/(--[A-Za-z0-9_-]+)\s*:/);
                    if (pm)
                        customProps.push(pm[1]);
                }
                const symId = `scip-web css ${pkgName} 0.1.0 ${relPath}/tokens:${block.header.replace(/\s+/g, '_')}:L${block.startLine}#`;
                addNode({
                    id: symId,
                    kind: 'StylesheetSection',
                    name: `${block.header} (${customProps.length} CSS vars)`,
                    qualifiedName: `${relPath}::${block.header}`,
                    packageName: pkgName,
                    filePath: relPath,
                    language: 'css',
                    startLine: block.startLine,
                    startCol: 1,
                    endLine: block.endLine,
                    endCol: 1,
                    signature: `${block.header} { ${customProps.slice(0, 6).join(', ')}${customProps.length > 6 ? ', ...' : ''} }`,
                    docstring: `CSS custom property definitions (${customProps.join(', ')})`,
                    exported: true,
                    complexity: 1,
                    labels: ['StylesheetSection', 'CssCustomProperties'],
                    properties: { customPropertiesCount: customProps.length },
                });
                addEdge({
                    srcId: fileId,
                    dstId: symId,
                    kind: 'CONTAINS',
                    filePath: relPath,
                    line: block.startLine,
                    col: 1,
                    weight: 1,
                    properties: {},
                });
                idx += 1;
                continue;
            }
            // Group consecutive rules sharing the same component prefix (or merge small neighboring rules into a cluster)
            const prefix = getComponentPrefix(block.header);
            let groupEndIdx = idx;
            let groupEndLine = block.endLine;
            const selectorsInGroup = [block.header];
            while (groupEndIdx + 1 < topBlocks.length) {
                const nextBlock = topBlocks[groupEndIdx + 1];
                if (nextBlock.header.startsWith('@') ||
                    nextBlock.header.includes(':root') ||
                    nextBlock.header.includes('[data-theme')) {
                    break;
                }
                const nextPrefix = getComponentPrefix(nextBlock.header);
                const currentGroupSpan = groupEndLine - block.startLine + 1;
                if (nextPrefix === prefix ||
                    (currentGroupSpan < 25 && nextBlock.startLine - groupEndLine <= 4 && currentGroupSpan + (nextBlock.endLine - nextBlock.startLine) <= 45)) {
                    groupEndIdx += 1;
                    groupEndLine = nextBlock.endLine;
                    if (selectorsInGroup.length < 6 && !selectorsInGroup.includes(nextBlock.header)) {
                        selectorsInGroup.push(nextBlock.header);
                    }
                }
                else {
                    break;
                }
            }
            const totalGroupSpan = groupEndLine - block.startLine + 1;
            const groupName = groupEndIdx > idx
                ? `${prefix} (${groupEndIdx - idx + 1} rules)`
                : block.header.length > 55
                    ? `${block.header.slice(0, 52)}...`
                    : block.header;
            const symId = `scip-web css ${pkgName} 0.1.0 ${relPath}/rule:${prefix.replace(/[^A-Za-z0-9_-]/g, '_')}:L${block.startLine}#`;
            addNode({
                id: symId,
                kind: 'StylesheetSection',
                name: groupName,
                qualifiedName: `${relPath}::${groupName}`,
                packageName: pkgName,
                filePath: relPath,
                language: 'css',
                startLine: block.startLine,
                startCol: 1,
                endLine: groupEndLine,
                endCol: 1,
                signature: `${selectorsInGroup.slice(0, 4).join(' | ')} (${totalGroupSpan} lines)`,
                docstring: `CSS rule group: ${selectorsInGroup.join(', ')}`,
                exported: true,
                complexity: Math.max(1, Math.min(15, groupEndIdx - idx + 1)),
                labels: ['StylesheetSection', 'CssRuleCluster'],
                properties: { ruleCount: groupEndIdx - idx + 1 },
            });
            addEdge({
                srcId: fileId,
                dstId: symId,
                kind: 'CONTAINS',
                filePath: relPath,
                line: block.startLine,
                col: 1,
                weight: 1,
                properties: {},
            });
            idx = groupEndIdx + 1;
        }
    }
}
/**
 * Universal fallback structural chunker for Markdown, YAML, JSON, TOML, or any unindexed workspace file.
 * Guarantees that `ast_outline` never returns 0 symbols for a non-empty file on disk.
 */
export function buildFallbackStructuralOutline(relPath, content) {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const lower = relPath.toLowerCase();
    const symbols = [];
    if (lower.endsWith('.md') || lower.endsWith('.mdx')) {
        const headings = [];
        let inFence = false;
        for (let i = 0; i < lineCount; i++) {
            const line = lines[i] ?? '';
            if (/^```/.test(line.trim())) {
                inFence = !inFence;
                continue;
            }
            if (inFence)
                continue;
            const m = line.match(/^(#{1,4})\s+(.+)$/);
            if (m) {
                headings.push({
                    level: m[1].length,
                    title: m[2].trim(),
                    startLine: i + 1,
                    raw: line.trim(),
                });
            }
        }
        for (let i = 0; i < headings.length; i++) {
            const h = headings[i];
            let endLine = lineCount;
            for (let j = i + 1; j < headings.length; j++) {
                if (headings[j].level <= h.level) {
                    endLine = headings[j].startLine - 1;
                    break;
                }
            }
            symbols.push({
                id: `scip-doc md ${relPath}#L${h.startLine}`,
                kind: 'DocumentSection',
                name: h.title,
                qualifiedName: `${relPath}#${h.title}`,
                signature: h.raw,
                exported: true,
                startLine: h.startLine,
                endLine: Math.max(h.startLine, endLine),
                complexity: 1,
            });
        }
        return { language: 'markdown', lineCount, symbols };
    }
    if (lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) {
        const topKeys = [];
        for (let i = 0; i < lineCount; i++) {
            const line = lines[i] ?? '';
            const tomlTable = line.match(/^\[([^\]]+)\]/);
            const yamlKey = line.match(/^([A-Za-z0-9_.-]+)\s*:/);
            if (tomlTable) {
                topKeys.push({ key: `[${tomlTable[1]}]`, startLine: i + 1, raw: line.trim() });
            }
            else if (yamlKey) {
                topKeys.push({ key: yamlKey[1], startLine: i + 1, raw: line.trim() });
            }
        }
        for (let i = 0; i < topKeys.length; i++) {
            const tk = topKeys[i];
            const next = topKeys[i + 1];
            const endLine = next ? next.startLine - 1 : lineCount;
            symbols.push({
                id: `scip-doc cfg ${relPath}#${tk.key}`,
                kind: 'DocumentSection',
                name: tk.key,
                qualifiedName: `${relPath}::${tk.key}`,
                signature: tk.raw,
                exported: true,
                startLine: tk.startLine,
                endLine: Math.max(tk.startLine, endLine),
                complexity: 1,
            });
        }
        return { language: 'config', lineCount, symbols };
    }
    if (lower.endsWith('.json')) {
        const topKeys = [];
        for (let i = 0; i < lineCount; i++) {
            const line = lines[i] ?? '';
            const m = line.match(/^\s{2}"([^"]+)"\s*:/);
            if (m) {
                topKeys.push({ key: m[1], startLine: i + 1, raw: line.trim() });
            }
        }
        for (let i = 0; i < topKeys.length; i++) {
            const tk = topKeys[i];
            const next = topKeys[i + 1];
            const endLine = next ? next.startLine - 1 : lineCount;
            symbols.push({
                id: `scip-doc json ${relPath}#${tk.key}`,
                kind: 'DocumentSection',
                name: tk.key,
                qualifiedName: `${relPath}::${tk.key}`,
                signature: tk.raw,
                exported: true,
                startLine: tk.startLine,
                endLine: Math.max(tk.startLine, endLine),
                complexity: 1,
            });
        }
        return { language: 'config', lineCount, symbols };
    }
    // Generic fixed-window structural chunking if no specific format matched
    const chunkSize = 80;
    for (let start = 1; start <= lineCount; start += chunkSize) {
        const end = Math.min(lineCount, start + chunkSize - 1);
        const firstNonEmpty = lines
            .slice(start - 1, end)
            .map((l) => l.trim())
            .find((l) => l.length > 0) ?? `Lines ${start}-${end}`;
        symbols.push({
            id: `scip-doc txt ${relPath}#L${start}-L${end}`,
            kind: 'DocumentSection',
            name: `Section L${start}-L${end}`,
            qualifiedName: `${relPath}#L${start}-L${end}`,
            signature: firstNonEmpty.slice(0, 90),
            exported: true,
            startLine: start,
            endLine: end,
            complexity: 1,
        });
    }
    return { language: 'text', lineCount, symbols };
}
//# sourceMappingURL=web-adapter.js.map