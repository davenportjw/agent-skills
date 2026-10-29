import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const SKIP_DIRS = new Set([
    'node_modules',
    'dist',
    'build',
    'site',
    'out',
    '.git',
    '.venv',
    'venv',
    '__pycache__',
    '.pytest_cache',
    '.ruff_cache',
    '.mypy_cache',
    '.wireit',
    '.ast-graph',
    '.terraform',
    '.cache',
]);
export function canonicalizeWorkspaceRoot(workspaceRoot) {
    const resolved = path.resolve(workspaceRoot);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        return resolved;
    }
}
export function computeRepoId(canonicalRoot) {
    return crypto.createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
}
export function findEnclosingRepoRoot(targetPath) {
    let current = canonicalizeWorkspaceRoot(targetPath);
    try {
        const st = fs.statSync(current);
        if (st.isFile()) {
            current = path.dirname(current);
        }
    }
    catch {
        current = path.dirname(current);
    }
    let dir = current;
    while (true) {
        if (fs.existsSync(path.join(dir, '.git')) ||
            fs.existsSync(path.join(dir, '.ast-graph', 'manifest.json'))) {
            return canonicalizeWorkspaceRoot(dir);
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    // Second pass for non-git workspaces (e.g. temp test directories with package.json / pyproject.toml / go.mod / Cargo.toml)
    dir = current;
    while (true) {
        if (fs.existsSync(path.join(dir, 'package.json')) ||
            fs.existsSync(path.join(dir, 'pyproject.toml')) ||
            fs.existsSync(path.join(dir, 'go.mod')) ||
            fs.existsSync(path.join(dir, 'Cargo.toml')) ||
            fs.existsSync(path.join(dir, 'pom.xml')) ||
            fs.existsSync(path.join(dir, 'build.gradle')) ||
            fs.existsSync(path.join(dir, 'build.gradle.kts')) ||
            fs.existsSync(path.join(dir, 'Gemfile')) ||
            fs.existsSync(path.join(dir, 'mix.exs')) ||
            fs.existsSync(path.join(dir, 'composer.json')) ||
            fs.existsSync(path.join(dir, 'CMakeLists.txt')) ||
            fs.existsSync(path.join(dir, 'Package.swift')) ||
            fs.existsSync(path.join(dir, 'build.zig'))) {
            return canonicalizeWorkspaceRoot(dir);
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
export function ensureGitExclude(canonicalRoot) {
    const astDir = path.join(canonicalRoot, '.ast-graph');
    try {
        fs.mkdirSync(astDir, { recursive: true });
        const innerGitignorePath = path.join(astDir, '.gitignore');
        if (!fs.existsSync(innerGitignorePath) || fs.readFileSync(innerGitignorePath, 'utf8') !== '*\n') {
            fs.writeFileSync(innerGitignorePath, '*\n', 'utf8');
        }
    }
    catch {
        // ignore if read-only
    }
    const gitDir = path.join(canonicalRoot, '.git');
    try {
        if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
            return false;
        }
        const infoDir = path.join(gitDir, 'info');
        fs.mkdirSync(infoDir, { recursive: true });
        const excludePath = path.join(infoDir, 'exclude');
        const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
        const lines = existing.split(/\r?\n/).map((l) => l.trim());
        if (lines.includes('.ast-graph') || lines.includes('.ast-graph/')) {
            return false;
        }
        const suffix = (existing.endsWith('\n') || existing.length === 0 ? '' : '\n') +
            '# AST GraphDB per-repository index\n.ast-graph/\n';
        fs.writeFileSync(excludePath, existing + suffix, 'utf8');
        return true;
    }
    catch {
        return false;
    }
}
export function getGlobalRegistryPath() {
    if (process.env.AST_GRAPH_REGISTRY_PATH) {
        return path.resolve(process.env.AST_GRAPH_REGISTRY_PATH);
    }
    return path.join(os.homedir(), '.gemini', 'config', 'ast-graph-workspaces.json');
}
export function registerWorkspaceInGlobalRegistry(manifest) {
    const regPath = getGlobalRegistryPath();
    try {
        fs.mkdirSync(path.dirname(regPath), { recursive: true });
        let data = { workspaces: {} };
        if (fs.existsSync(regPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(regPath, 'utf8'));
                if (parsed && typeof parsed.workspaces === 'object' && parsed.workspaces) {
                    data.workspaces = parsed.workspaces;
                }
            }
            catch {
                data = { workspaces: {} };
            }
        }
        data.workspaces[manifest.canonicalRoot] = manifest;
        fs.writeFileSync(regPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    }
    catch {
        // Non-fatal if home config dir is read-only
    }
}
export function getRegisteredWorkspaces() {
    const regPath = getGlobalRegistryPath();
    if (!fs.existsSync(regPath))
        return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        if (!parsed?.workspaces)
            return [];
        return Object.values(parsed.workspaces).filter((m) => {
            try {
                return fs.existsSync(m.canonicalRoot);
            }
            catch {
                return false;
            }
        });
    }
    catch {
        return [];
    }
}
export function assessWorkspace(workspaceRoot) {
    const canonicalRoot = canonicalizeWorkspaceRoot(workspaceRoot);
    const repoId = computeRepoId(canonicalRoot);
    const repoName = path.basename(canonicalRoot);
    ensureGitExclude(canonicalRoot);
    const manifests = [];
    const fileCounts = {
        typescript: 0,
        javascript: 0,
        python: 0,
        go: 0,
        templ: 0,
        terraform: 0,
        sql: 0,
        html: 0,
        css: 0,
        dockerfile: 0,
        protobuf: 0,
        graphql: 0,
        rust: 0,
        java: 0,
        kotlin: 0,
        csharp: 0,
        ruby: 0,
        elixir: 0,
        php: 0,
        cpp: 0,
        swift: 0,
        zig: 0,
        wasm: 0,
    };
    const frameworksSet = new Set();
    for (const rootManifest of [
        'package.json',
        'pyproject.toml',
        'go.mod',
        'Cargo.toml',
        'pom.xml',
        'build.gradle',
        'build.gradle.kts',
        'Gemfile',
        'mix.exs',
        'composer.json',
        'CMakeLists.txt',
        'Package.swift',
        'build.zig',
    ]) {
        if (fs.existsSync(path.join(canonicalRoot, rootManifest))) {
            manifests.push(rootManifest);
        }
    }
    // Inspect package.json if present
    const pkgJsonPath = path.join(canonicalRoot, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
        try {
            const raw = fs.readFileSync(pkgJsonPath, 'utf8');
            if (raw.includes('fastify'))
                frameworksSet.add('Fastify');
            if (raw.includes('zod'))
                frameworksSet.add('Zod');
            if (raw.includes('vitest'))
                frameworksSet.add('Vitest');
        }
        catch {
            // ignore
        }
    }
    // Inspect pyproject.toml if present
    const pyprojectPath = path.join(canonicalRoot, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
        try {
            const raw = fs.readFileSync(pyprojectPath, 'utf8').toLowerCase();
            if (raw.includes('fastapi'))
                frameworksSet.add('FastAPI');
            if (raw.includes('pydantic'))
                frameworksSet.add('Pydantic');
            if (raw.includes('jinja2'))
                frameworksSet.add('Jinja2');
            if (raw.includes('spanner') || raw.includes('bigquery'))
                frameworksSet.add('Spanner/BigQuery');
            if (raw.includes('google-adk') || raw.includes('mcp'))
                frameworksSet.add('MCP/ADK');
        }
        catch {
            // ignore
        }
    }
    // Inspect go.mod if present
    const goModPath = path.join(canonicalRoot, 'go.mod');
    if (fs.existsSync(goModPath)) {
        try {
            const raw = fs.readFileSync(goModPath, 'utf8');
            frameworksSet.add('Go ServeMux');
            if (raw.includes('a-h/templ'))
                frameworksSet.add('Templ');
            if (raw.includes('firestore'))
                frameworksSet.add('Firestore');
        }
        catch {
            // ignore
        }
    }
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name))
                continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            }
            else if (entry.isFile()) {
                const rel = path.relative(canonicalRoot, fullPath).split(path.sep).join('/');
                if ((entry.name === 'package.json' ||
                    entry.name === 'pyproject.toml' ||
                    entry.name === 'go.mod') &&
                    !manifests.includes(rel)) {
                    manifests.push(rel);
                }
                if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                    fileCounts.typescript = (fileCounts.typescript ?? 0) + 1;
                }
                else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
                    fileCounts.javascript = (fileCounts.javascript ?? 0) + 1;
                }
                else if (entry.name.endsWith('.py')) {
                    fileCounts.python = (fileCounts.python ?? 0) + 1;
                }
                else if (entry.name.endsWith('.go') && !entry.name.endsWith('_templ.go')) {
                    fileCounts.go = (fileCounts.go ?? 0) + 1;
                }
                else if (entry.name.endsWith('.templ')) {
                    fileCounts.templ = (fileCounts.templ ?? 0) + 1;
                    frameworksSet.add('Templ');
                }
                else if (entry.name.endsWith('.tf') || entry.name.endsWith('.hcl') || entry.name.endsWith('.tfvars')) {
                    fileCounts.terraform = (fileCounts.terraform ?? 0) + 1;
                    if (!manifests.includes(path.dirname(rel) + '/*.tf')) {
                        manifests.push(path.dirname(rel) + '/*.tf');
                    }
                }
                else if (entry.name.endsWith('.sql')) {
                    fileCounts.sql = (fileCounts.sql ?? 0) + 1;
                    frameworksSet.add('Spanner/BigQuery');
                    if (!manifests.includes(path.dirname(rel) + '/*.sql')) {
                        manifests.push(path.dirname(rel) + '/*.sql');
                    }
                }
                else if (entry.name === 'Dockerfile' ||
                    entry.name === 'Containerfile' ||
                    entry.name.startsWith('Dockerfile.') ||
                    entry.name.endsWith('.dockerfile')) {
                    fileCounts.dockerfile = (fileCounts.dockerfile ?? 0) + 1;
                }
                else if (entry.name.endsWith('.proto')) {
                    fileCounts.protobuf = (fileCounts.protobuf ?? 0) + 1;
                    frameworksSet.add('Protobuf/gRPC');
                }
                else if (entry.name.endsWith('.graphql') || entry.name.endsWith('.gql')) {
                    fileCounts.graphql = (fileCounts.graphql ?? 0) + 1;
                    frameworksSet.add('GraphQL');
                }
                else if (entry.name.endsWith('.rs')) {
                    fileCounts.rust = (fileCounts.rust ?? 0) + 1;
                }
                else if (entry.name.endsWith('.java')) {
                    fileCounts.java = (fileCounts.java ?? 0) + 1;
                }
                else if (entry.name.endsWith('.kt') || entry.name.endsWith('.kts')) {
                    fileCounts.kotlin = (fileCounts.kotlin ?? 0) + 1;
                }
                else if (entry.name.endsWith('.cs')) {
                    fileCounts.csharp = (fileCounts.csharp ?? 0) + 1;
                }
                else if (entry.name.endsWith('.rb')) {
                    fileCounts.ruby = (fileCounts.ruby ?? 0) + 1;
                }
                else if (entry.name.endsWith('.ex') || entry.name.endsWith('.exs')) {
                    fileCounts.elixir = (fileCounts.elixir ?? 0) + 1;
                }
                else if (entry.name.endsWith('.php')) {
                    fileCounts.php = (fileCounts.php ?? 0) + 1;
                }
                else if (entry.name.endsWith('.c') ||
                    entry.name.endsWith('.cc') ||
                    entry.name.endsWith('.cpp') ||
                    entry.name.endsWith('.cxx') ||
                    entry.name.endsWith('.h') ||
                    entry.name.endsWith('.hpp') ||
                    entry.name.endsWith('.hxx')) {
                    fileCounts.cpp = (fileCounts.cpp ?? 0) + 1;
                }
                else if (entry.name.endsWith('.swift')) {
                    fileCounts.swift = (fileCounts.swift ?? 0) + 1;
                }
                else if (entry.name.endsWith('.zig')) {
                    fileCounts.zig = (fileCounts.zig ?? 0) + 1;
                }
                else if (entry.name.endsWith('.wat') || entry.name.endsWith('.wit') || entry.name.endsWith('.wasm')) {
                    fileCounts.wasm = (fileCounts.wasm ?? 0) + 1;
                }
                else if (entry.name.endsWith('.html') ||
                    entry.name.endsWith('.htm') ||
                    entry.name.endsWith('.jinja') ||
                    entry.name.endsWith('.jinja2') ||
                    entry.name.endsWith('.njk') ||
                    entry.name.endsWith('.astro') ||
                    entry.name.endsWith('.vue') ||
                    entry.name.endsWith('.svelte')) {
                    fileCounts.html = (fileCounts.html ?? 0) + 1;
                }
                else if (entry.name.endsWith('.css')) {
                    fileCounts.css = (fileCounts.css ?? 0) + 1;
                }
            }
        }
    };
    walk(canonicalRoot);
    // Detect Fastify/Zod in monorepo subpackages if not in root package.json
    if ((fileCounts.typescript ?? 0) > 0 && frameworksSet.size === 0) {
        frameworksSet.add('Fastify');
        frameworksSet.add('Zod');
    }
    const languages = Object.entries(fileCounts)
        .filter(([, count]) => count > 0)
        .map(([lang]) => lang);
    const activeAdapters = [];
    if ((fileCounts.typescript ?? 0) > 0 || (fileCounts.javascript ?? 0) > 0) {
        activeAdapters.push('ts-compiler');
    }
    if ((fileCounts.python ?? 0) > 0) {
        activeAdapters.push('python-ast');
    }
    if ((fileCounts.go ?? 0) > 0 || (fileCounts.templ ?? 0) > 0) {
        activeAdapters.push('go-ast');
    }
    if ((fileCounts.terraform ?? 0) > 0) {
        activeAdapters.push('terraform-hcl');
    }
    if ((fileCounts.sql ?? 0) > 0) {
        activeAdapters.push('sql-ddl');
    }
    if ((fileCounts.html ?? 0) > 0 || (fileCounts.css ?? 0) > 0) {
        activeAdapters.push('web-composite');
    }
    if ((fileCounts.dockerfile ?? 0) > 0) {
        activeAdapters.push('scip-dockerfile');
    }
    if ((fileCounts.protobuf ?? 0) > 0 || (fileCounts.graphql ?? 0) > 0) {
        activeAdapters.push('scip-contracts');
    }
    if ((fileCounts.rust ?? 0) > 0) {
        activeAdapters.push('scip-rust');
    }
    if ((fileCounts.java ?? 0) > 0 ||
        (fileCounts.kotlin ?? 0) > 0 ||
        (fileCounts.csharp ?? 0) > 0 ||
        (fileCounts.ruby ?? 0) > 0 ||
        (fileCounts.elixir ?? 0) > 0 ||
        (fileCounts.php ?? 0) > 0 ||
        (fileCounts.cpp ?? 0) > 0 ||
        (fileCounts.swift ?? 0) > 0 ||
        (fileCounts.zig ?? 0) > 0 ||
        (fileCounts.wasm ?? 0) > 0) {
        activeAdapters.push('scip-polyglot');
    }
    let testRunner = 'npx vitest run';
    if ((fileCounts.go ?? 0) > 0 && (fileCounts.go ?? 0) >= (fileCounts.python ?? 0)) {
        testRunner = 'go test ./...';
    }
    else if (fs.existsSync(pyprojectPath) || ((fileCounts.python ?? 0) > 0 && (fileCounts.typescript ?? 0) === 0)) {
        testRunner = 'uv run pytest';
    }
    else if ((fileCounts.rust ?? 0) > 0 && (fileCounts.typescript ?? 0) === 0) {
        testRunner = 'cargo test';
    }
    else if ((fileCounts.zig ?? 0) > 0 && (fileCounts.typescript ?? 0) === 0) {
        testRunner = 'zig build test';
    }
    else if ((fileCounts.elixir ?? 0) > 0 && (fileCounts.typescript ?? 0) === 0) {
        testRunner = 'mix test';
    }
    else if ((fileCounts.ruby ?? 0) > 0 && (fileCounts.typescript ?? 0) === 0) {
        testRunner = 'bundle exec rspec';
    }
    else if ((fileCounts.swift ?? 0) > 0 && (fileCounts.typescript ?? 0) === 0) {
        testRunner = 'swift test';
    }
    const manifest = {
        schemaVersion: 1,
        repoId,
        repoName,
        canonicalRoot,
        assessedAt: new Date().toISOString(),
        languages,
        manifests,
        frameworks: [...frameworksSet],
        activeAdapters,
        testRunner,
        fileCounts,
    };
    const astDir = path.join(canonicalRoot, '.ast-graph');
    fs.mkdirSync(astDir, { recursive: true });
    fs.writeFileSync(path.join(astDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    registerWorkspaceInGlobalRegistry(manifest);
    return manifest;
}
//# sourceMappingURL=assessor.js.map