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
const COLUMN_STOP_KEYWORDS = new Set([
    'NOT',
    'NULL',
    'DEFAULT',
    'PRIMARY',
    'UNIQUE',
    'REFERENCES',
    'CHECK',
    'CONSTRAINT',
    'GENERATED',
    'AS',
    'OPTIONS',
    'HIDDEN',
    'AUTO_INCREMENT',
    'AUTOINCREMENT',
    'COLLATE',
    'ON',
]);
export class SqlCompilerAdapter {
    name = 'sql-ddl';
    languages = ['sql'];
    supportsFile(filePath) {
        if (filePath.includes('node_modules') || filePath.includes('.venv'))
            return false;
        const lower = filePath.toLowerCase();
        return lower.endsWith('.sql') || lower.endsWith('.sqlx');
    }
    discoverSqlFiles(workspaceRoot) {
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
                else if (entry.isFile() && this.supportsFile(entry.name)) {
                    results.push(full);
                }
            }
        };
        walk(path.resolve(workspaceRoot));
        return results.sort();
    }
    /**
     * Splits SQL content into top-level statements terminated by ';',
     * preserving 1-based startLine and endLine while ignoring semicolons inside:
     * - single quotes '...'
     * - double quotes "..."
     * - backticks `...`
     * - dollar-quoted blocks $$...$$ or $tag$...$tag$
     * - line comments --...
     * - block comments /* ... *\/
     * - Dataform SQLX config { ... } blocks
     */
    splitSqlStatementsWithLines(src) {
        const statements = [];
        let current = '';
        let stmtStartLine = 0;
        let stmtLastNonSpaceLine = 1;
        let line = 1;
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inBacktick = false;
        let inLineComment = false;
        let inBlockComment = false;
        let dollarTag = '';
        let braceDepth = 0;
        const n = src.length;
        for (let i = 0; i < n; i++) {
            const ch = src[i];
            if (inLineComment) {
                if (ch === '\n') {
                    inLineComment = false;
                    current += '\n';
                    line++;
                }
                continue;
            }
            if (inBlockComment) {
                if (ch === '*' && i + 1 < n && src[i + 1] === '/') {
                    inBlockComment = false;
                    i++;
                }
                else if (ch === '\n') {
                    current += '\n';
                    line++;
                }
                continue;
            }
            if (dollarTag !== '') {
                if (ch === '-' && i + 1 < n && src[i + 1] === '-') {
                    inLineComment = true;
                    i++;
                    continue;
                }
                if (ch === '/' && i + 1 < n && src[i + 1] === '*') {
                    inBlockComment = true;
                    i++;
                    continue;
                }
                if (src.startsWith(dollarTag, i)) {
                    current += dollarTag;
                    stmtLastNonSpaceLine = line;
                    i += dollarTag.length - 1;
                    dollarTag = '';
                }
                else {
                    current += ch;
                    if (ch === '\n') {
                        line++;
                    }
                    else if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
                        stmtLastNonSpaceLine = line;
                    }
                }
                continue;
            }
            if (inSingleQuote) {
                current += ch;
                if (ch === '\n') {
                    line++;
                }
                else {
                    stmtLastNonSpaceLine = line;
                }
                if (ch === "'" && i + 1 < n && src[i + 1] === "'") {
                    current += "'";
                    i++;
                    continue;
                }
                if (ch === '\\' && i + 1 < n) {
                    current += src[i + 1];
                    i++;
                    continue;
                }
                if (ch === "'") {
                    inSingleQuote = false;
                }
                continue;
            }
            if (inDoubleQuote) {
                current += ch;
                if (ch === '\n') {
                    line++;
                }
                else {
                    stmtLastNonSpaceLine = line;
                }
                if (ch === '"') {
                    inDoubleQuote = false;
                }
                continue;
            }
            if (inBacktick) {
                current += ch;
                if (ch === '\n') {
                    line++;
                }
                else {
                    stmtLastNonSpaceLine = line;
                }
                if (ch === '`') {
                    inBacktick = false;
                }
                continue;
            }
            // Check for comments
            if (ch === '-' && i + 1 < n && src[i + 1] === '-') {
                inLineComment = true;
                i++;
                continue;
            }
            if (ch === '/' && i + 1 < n && src[i + 1] === '*') {
                inBlockComment = true;
                i++;
                continue;
            }
            // Check for PostgreSQL dollar-quoting: $$ or $tag$
            if (ch === '$') {
                const rest = src.slice(i);
                const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
                if (tagMatch) {
                    dollarTag = tagMatch[0];
                    if (stmtStartLine === 0)
                        stmtStartLine = line;
                    stmtLastNonSpaceLine = line;
                    current += dollarTag;
                    i += dollarTag.length - 1;
                    continue;
                }
            }
            if (ch === "'") {
                inSingleQuote = true;
                if (stmtStartLine === 0)
                    stmtStartLine = line;
                stmtLastNonSpaceLine = line;
                current += ch;
                continue;
            }
            if (ch === '"') {
                inDoubleQuote = true;
                if (stmtStartLine === 0)
                    stmtStartLine = line;
                stmtLastNonSpaceLine = line;
                current += ch;
                continue;
            }
            if (ch === '`') {
                inBacktick = true;
                if (stmtStartLine === 0)
                    stmtStartLine = line;
                stmtLastNonSpaceLine = line;
                current += ch;
                continue;
            }
            if (ch === '{') {
                braceDepth++;
            }
            else if (ch === '}' && braceDepth > 0) {
                braceDepth--;
            }
            if (ch === ';' && braceDepth === 0) {
                const trimmed = current.trim();
                if (trimmed.length > 0 && stmtStartLine > 0) {
                    statements.push({
                        text: trimmed,
                        startLine: stmtStartLine,
                        endLine: Math.max(stmtStartLine, stmtLastNonSpaceLine),
                    });
                }
                current = '';
                stmtStartLine = 0;
                continue;
            }
            if (ch === '\n') {
                current += '\n';
                line++;
                continue;
            }
            if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
                if (stmtStartLine === 0) {
                    stmtStartLine = line;
                }
                stmtLastNonSpaceLine = line;
            }
            current += ch;
        }
        const tail = current.trim();
        if (tail.length > 0 && stmtStartLine > 0) {
            statements.push({
                text: tail,
                startLine: stmtStartLine,
                endLine: Math.max(stmtStartLine, stmtLastNonSpaceLine),
            });
        }
        return statements;
    }
    /**
     * Splits a CREATE TABLE (...) body on top-level commas (paren depth 0),
     * preserving the relative line offset of each column or table constraint.
     */
    splitSqlBodyItems(body) {
        const items = [];
        let depth = 0;
        let inSingleQuote = false;
        let current = '';
        let itemStartLineOffset = -1;
        let lineOffset = 0;
        for (let i = 0; i < body.length; i++) {
            const ch = body[i];
            if (inSingleQuote) {
                current += ch;
                if (ch === '\n')
                    lineOffset++;
                if (ch === "'")
                    inSingleQuote = false;
                continue;
            }
            if (ch === "'") {
                inSingleQuote = true;
                if (itemStartLineOffset < 0)
                    itemStartLineOffset = lineOffset;
                current += ch;
                continue;
            }
            if (ch === '(' || ch === '<') {
                depth++;
            }
            else if ((ch === ')' || ch === '>') && depth > 0) {
                depth--;
            }
            else if (ch === ',' && depth === 0) {
                const trimmed = current.trim();
                if (trimmed.length > 0) {
                    items.push({
                        text: trimmed,
                        lineOffset: Math.max(0, itemStartLineOffset),
                    });
                }
                current = '';
                itemStartLineOffset = -1;
                continue;
            }
            if (ch === '\n') {
                lineOffset++;
                current += ch;
                continue;
            }
            if (ch !== ' ' && ch !== '\t' && ch !== '\r' && itemStartLineOffset < 0) {
                itemStartLineOffset = lineOffset;
            }
            current += ch;
        }
        const tail = current.trim();
        if (tail.length > 0) {
            items.push({
                text: tail,
                lineOffset: Math.max(0, itemStartLineOffset),
            });
        }
        return items;
    }
    normalizeSqlIdentifier(raw) {
        return raw.trim().replace(/^[`"'\[]+|[`"'\]]+$/g, '');
    }
    /**
     * Parses column name and full SQL type (including multi-word types like
     * `TIMESTAMP WITH TIME ZONE`, `DOUBLE PRECISION`, `ARRAY<STRING(64)>`, `NUMERIC(10, 2)`)
     * stopping at SQL column constraint keywords.
     */
    parseColumnNameAndType(itemText) {
        const s = itemText.trim();
        if (!s)
            return null;
        let colName = '';
        let rest = '';
        if (s[0] === '"' || s[0] === '`' || s[0] === '[') {
            const closeChar = s[0] === '[' ? ']' : s[0];
            const endQuote = s.indexOf(closeChar, 1);
            if (endQuote < 0)
                return null;
            colName = s.slice(1, endQuote);
            rest = s.slice(endQuote + 1).trim();
        }
        else {
            const wsMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]+)$/.exec(s);
            if (!wsMatch)
                return null;
            colName = wsMatch[1];
            rest = wsMatch[2].trim();
        }
        let depth = 0;
        let typeEnd = rest.length;
        let i = 0;
        while (i < rest.length) {
            const ch = rest[i];
            if (ch === '(' || ch === '<' || ch === '[') {
                depth++;
                i++;
                continue;
            }
            if ((ch === ')' || ch === '>' || ch === ']') && depth > 0) {
                depth--;
                i++;
                continue;
            }
            if (depth === 0 && /\s/.test(ch)) {
                let j = i;
                while (j < rest.length && /\s/.test(rest[j]))
                    j++;
                let k = j;
                while (k < rest.length && /[A-Za-z_]/.test(rest[k]))
                    k++;
                const word = rest.slice(j, k).toUpperCase();
                if (COLUMN_STOP_KEYWORDS.has(word)) {
                    typeEnd = i;
                    break;
                }
                i = k > j ? k : j + 1;
                continue;
            }
            i++;
        }
        const colType = rest.slice(0, typeEnd).trim().replace(/\s+/g, ' ');
        if (!colName || !colType)
            return null;
        return { colName, colType };
    }
    extract(workspaceRoot, targetFiles) {
        const resolvedRoot = path.resolve(workspaceRoot);
        const allSqlFiles = this.discoverSqlFiles(resolvedRoot);
        if (allSqlFiles.length === 0) {
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
        const tableNodesByName = new Map();
        const pendingTableLinks = [];
        const firstRel = path.relative(resolvedRoot, allSqlFiles[0]).split(path.sep).join('/');
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
            docstring: 'SQL DDL schemas, tables, views, indexes, and foreign key lineage',
            exported: true,
            complexity: 1,
            labels: ['WorkspacePackage', 'SqlModule'],
            properties: {},
        });
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
        for (const absPath of allSqlFiles) {
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
            addEdge(pkgId, fileId, 'CONTAINS', relPath, 1);
            const statements = this.splitSqlStatementsWithLines(content);
            for (const stmt of statements) {
                const trimmed = stmt.text.trim();
                if (!trimmed)
                    continue;
                // 1. CREATE TABLE [IF NOT EXISTS] <name> (...) [PRIMARY KEY (...), INTERLEAVE IN PARENT <parent>]
                const createTableMatch = trimmed.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`[\]-]+)\s*\(([\s\S]+)\)/i);
                if (createTableMatch) {
                    const rawTableName = this.normalizeSqlIdentifier(createTableMatch[1]);
                    const shortTableName = rawTableName.split('.').pop() ?? rawTableName;
                    const tableId = `scip-sql ddl sql 1.0.0 table:${shortTableName}#`;
                    tableNodesByName.set(shortTableName.toLowerCase(), tableId);
                    tableNodesByName.set(rawTableName.toLowerCase(), tableId);
                    // Check Spanner INTERLEAVE IN PARENT
                    const interleaveMatch = trimmed.match(/\)\s*(?:PRIMARY\s+KEY\s*\([^)]*\)\s*,\s*)?INTERLEAVE\s+IN\s+PARENT\s+([A-Za-z0-9_."`]+)/i);
                    if (interleaveMatch) {
                        const parentTable = this.normalizeSqlIdentifier(interleaveMatch[1]);
                        pendingTableLinks.push({
                            srcId: tableId,
                            targetTableName: parentTable,
                            kind: 'REFERENCES',
                            filePath: relPath,
                            line: stmt.endLine,
                            evidence: `INTERLEAVE IN PARENT ${parentTable}`,
                        });
                    }
                    // Extract balanced (...) body for CREATE TABLE
                    const openParenIdx = stmt.text.indexOf('(');
                    let closeParenIdx = stmt.text.lastIndexOf(')');
                    if (openParenIdx >= 0) {
                        let pDepth = 0;
                        for (let k = openParenIdx; k < stmt.text.length; k++) {
                            if (stmt.text[k] === '(')
                                pDepth++;
                            else if (stmt.text[k] === ')') {
                                pDepth--;
                                if (pDepth === 0) {
                                    closeParenIdx = k;
                                    break;
                                }
                            }
                        }
                    }
                    const bodyPrefixLines = openParenIdx >= 0 ? stmt.text.slice(0, openParenIdx + 1).split('\n').length - 1 : 0;
                    const bodyBaseLine = stmt.startLine + bodyPrefixLines;
                    const bodyText = openParenIdx >= 0 && closeParenIdx > openParenIdx
                        ? stmt.text.slice(openParenIdx + 1, closeParenIdx)
                        : createTableMatch[2];
                    nodesMap.set(tableId, {
                        id: tableId,
                        kind: 'ZodSchema',
                        name: shortTableName,
                        qualifiedName: `sql.${rawTableName}`,
                        packageName: 'sql',
                        filePath: relPath,
                        language: 'sql',
                        startLine: stmt.startLine,
                        startCol: 1,
                        endLine: stmt.endLine,
                        endCol: 1,
                        signature: `CREATE TABLE ${rawTableName}`,
                        docstring: `SQL Table ${rawTableName} in ${relPath}`,
                        exported: true,
                        complexity: 1,
                        labels: ['ZodSchema', 'Schema', 'SqlTable'],
                        properties: { framework: 'sql-ddl', rawTableName },
                    });
                    addEdge(fileId, tableId, 'CONTAINS', relPath, stmt.startLine);
                    const items = this.splitSqlBodyItems(bodyText);
                    for (const item of items) {
                        const itemLine = bodyBaseLine + item.lineOffset;
                        // Table-level CONSTRAINT ... FOREIGN KEY (...) REFERENCES target_table(...)
                        const tableFkMatch = item.text.match(/^(?:CONSTRAINT\s+[A-Za-z0-9_."`[\]]+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([A-Za-z0-9_."`[\]]+)/i);
                        if (tableFkMatch) {
                            const refTable = this.normalizeSqlIdentifier(tableFkMatch[2]);
                            pendingTableLinks.push({
                                srcId: tableId,
                                targetTableName: refTable,
                                kind: 'REFERENCES',
                                filePath: relPath,
                                line: itemLine,
                                evidence: item.text.replace(/\s+/g, ' ').slice(0, 120),
                            });
                            continue;
                        }
                        if (/^(PRIMARY\s+KEY|CONSTRAINT|FOREIGN\s+KEY|INTERLEAVE|INDEX|UNIQUE|CHECK)\b/i.test(item.text.trim())) {
                            continue;
                        }
                        const parsedCol = this.parseColumnNameAndType(item.text);
                        if (parsedCol) {
                            const { colName, colType } = parsedCol;
                            const colId = `${tableId}${colName}.`;
                            nodesMap.set(colId, {
                                id: colId,
                                kind: 'Property',
                                name: colName,
                                qualifiedName: `${shortTableName}.${colName}`,
                                packageName: 'sql',
                                filePath: relPath,
                                language: 'sql',
                                startLine: itemLine,
                                startCol: 1,
                                endLine: itemLine,
                                endCol: item.text.length,
                                signature: `${colName} ${colType}`,
                                docstring: '',
                                exported: true,
                                complexity: 1,
                                labels: ['Property', 'SqlColumn'],
                                properties: {
                                    columnType: colType,
                                    notNull: /\bNOT\s+NULL\b/i.test(item.text),
                                    primaryKey: /\bPRIMARY\s+KEY\b/i.test(item.text),
                                },
                            });
                            addEdge(tableId, colId, 'CONTAINS', relPath, itemLine);
                            // Inline column REFERENCES <target_table>
                            const inlineRefMatch = item.text.match(/\bREFERENCES\s+([A-Za-z0-9_."`[\]]+)(?:\s*\(([^)]+)\))?/i);
                            if (inlineRefMatch) {
                                const refTable = this.normalizeSqlIdentifier(inlineRefMatch[1]);
                                pendingTableLinks.push({
                                    srcId: tableId,
                                    targetTableName: refTable,
                                    kind: 'REFERENCES',
                                    filePath: relPath,
                                    line: itemLine,
                                    evidence: `${colName} REFERENCES ${refTable}`,
                                });
                            }
                        }
                    }
                    continue;
                }
                // 2. CREATE [OR REPLACE] [MATERIALIZED] VIEW <name> AS SELECT ...
                const createViewMatch = trimmed.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`[\]-]+)\s+AS\s+([\s\S]+)$/i);
                if (createViewMatch) {
                    const rawViewName = this.normalizeSqlIdentifier(createViewMatch[1]);
                    const shortViewName = rawViewName.split('.').pop() ?? rawViewName;
                    const viewQuery = createViewMatch[2];
                    const viewId = `scip-sql ddl sql 1.0.0 view:${shortViewName}#`;
                    tableNodesByName.set(shortViewName.toLowerCase(), viewId);
                    tableNodesByName.set(rawViewName.toLowerCase(), viewId);
                    nodesMap.set(viewId, {
                        id: viewId,
                        kind: 'ZodSchema',
                        name: shortViewName,
                        qualifiedName: `sql.view.${rawViewName}`,
                        packageName: 'sql',
                        filePath: relPath,
                        language: 'sql',
                        startLine: stmt.startLine,
                        startCol: 1,
                        endLine: stmt.endLine,
                        endCol: 1,
                        signature: `CREATE VIEW ${rawViewName}`,
                        docstring: `SQL View ${rawViewName} in ${relPath}`,
                        exported: true,
                        complexity: 1,
                        labels: ['ZodSchema', 'Schema', 'SqlView'],
                        properties: { framework: 'sql-ddl' },
                    });
                    addEdge(fileId, viewId, 'CONTAINS', relPath, stmt.startLine);
                    const fromJoinRe = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_."`]*)/gi;
                    let fjMatch;
                    while ((fjMatch = fromJoinRe.exec(viewQuery)) !== null) {
                        const refTable = this.normalizeSqlIdentifier(fjMatch[1]);
                        if (!['UNNEST', 'LATERAL', 'DUAL'].includes(refTable.toUpperCase())) {
                            pendingTableLinks.push({
                                srcId: viewId,
                                targetTableName: refTable,
                                kind: 'REFERENCES',
                                filePath: relPath,
                                line: stmt.startLine,
                                evidence: `VIEW ${shortViewName} -> ${refTable}`,
                            });
                        }
                    }
                    continue;
                }
                // 3. CREATE [UNIQUE] INDEX <idx_name> ON <table> (<cols>)
                const createIndexMatch = trimmed.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`[\]]+)\s+ON\s+(?:ONLY\s+)?([A-Za-z0-9_."`[\]]+)/i);
                if (createIndexMatch) {
                    const idxName = this.normalizeSqlIdentifier(createIndexMatch[1]);
                    const targetTable = this.normalizeSqlIdentifier(createIndexMatch[2]);
                    const idxId = `scip-sql ddl sql 1.0.0 index:${idxName}#`;
                    nodesMap.set(idxId, {
                        id: idxId,
                        kind: 'Variable',
                        name: idxName,
                        qualifiedName: `sql.index.${idxName}`,
                        packageName: 'sql',
                        filePath: relPath,
                        language: 'sql',
                        startLine: stmt.startLine,
                        startCol: 1,
                        endLine: stmt.endLine,
                        endCol: 1,
                        signature: `CREATE INDEX ${idxName} ON ${targetTable}`,
                        docstring: `SQL Index ${idxName} on ${targetTable}`,
                        exported: true,
                        complexity: 1,
                        labels: ['Variable', 'SqlIndex'],
                        properties: { targetTable },
                    });
                    addEdge(fileId, idxId, 'CONTAINS', relPath, stmt.startLine);
                    pendingTableLinks.push({
                        srcId: idxId,
                        targetTableName: targetTable,
                        kind: 'REFERENCES',
                        filePath: relPath,
                        line: stmt.startLine,
                        evidence: `CREATE INDEX ${idxName} ON ${targetTable}`,
                    });
                    continue;
                }
                // 4. ALTER TABLE <table> ...
                const alterTableMatch = trimmed.match(/^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z0-9_."`[\]]+)\s+([\s\S]+)$/i);
                if (alterTableMatch) {
                    const targetTable = this.normalizeSqlIdentifier(alterTableMatch[1]);
                    const actionText = alterTableMatch[2];
                    const fkMatch = actionText.match(/FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([A-Za-z0-9_."`[\]]+)/i);
                    if (fkMatch) {
                        const refTable = this.normalizeSqlIdentifier(fkMatch[2]);
                        const srcTableId = tableNodesByName.get(targetTable.toLowerCase()) ??
                            tableNodesByName.get((targetTable.split('.').pop() ?? targetTable).toLowerCase()) ??
                            fileId;
                        pendingTableLinks.push({
                            srcId: srcTableId,
                            targetTableName: refTable,
                            kind: 'REFERENCES',
                            filePath: relPath,
                            line: stmt.startLine,
                            evidence: `ALTER TABLE ${targetTable} FOREIGN KEY REFERENCES ${refTable}`,
                        });
                    }
                }
            }
        }
        for (const link of pendingTableLinks) {
            const lowerRaw = link.targetTableName.toLowerCase();
            const lowerShort = (link.targetTableName.split('.').pop() ?? link.targetTableName).toLowerCase();
            const dstId = tableNodesByName.get(lowerRaw) ?? tableNodesByName.get(lowerShort);
            if (dstId && dstId !== link.srcId) {
                addEdge(link.srcId, dstId, link.kind, link.filePath, link.line, {
                    evidence: link.evidence,
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
//# sourceMappingURL=sql-adapter.js.map