import fs from 'node:fs';
import path from 'node:path';
import { isExcludedSubtree } from './repo-boundary.js';
/**
 * Lightweight, TypeScript-free candidate file matcher shared by the fast CLI freshness check.
 * Kept strictly aligned with the union of all 10 compiler adapters so the fast path never
 * misses a new/gitignored indexable file.
 */
export const FAST_SCAN_IGNORED_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    '.venv',
    'venv',
    '.ast-graph',
    '__pycache__',
    '.pytest_cache',
    '.ruff_cache',
    '.terraform',
    'target',
    'vendor',
]);
const INDEXABLE_EXTS = new Set([
    // TypeScript / JavaScript
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
    // Python
    '.py',
    // Go / Templ
    '.go', '.templ',
    // Rust
    '.rs',
    // Terraform / HCL
    '.tf', '.hcl', '.tfvars',
    // SQL
    '.sql', '.sqlx',
    // API Contracts
    '.proto', '.graphql', '.gql',
    // Web / Templates / Styles
    '.html', '.htm', '.jinja', '.jinja2', '.njk', '.astro', '.vue', '.svelte', '.css',
    // Polyglot (Java, Kotlin, C#, Ruby, Elixir, PHP, C/C++, Swift, Zig, WASM/WIT)
    '.java', '.kt', '.kts', '.cs', '.rb', '.ex', '.exs', '.php',
    '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx',
    '.swift', '.zig', '.wat', '.wit', '.wasm',
]);
export function isIndexableCandidatePath(relOrAbsPath) {
    const base = path.basename(relOrAbsPath);
    const lowerBase = base.toLowerCase();
    if (lowerBase.endsWith('.d.ts') || lowerBase.endsWith('.terraform.lock.hcl')) {
        return false;
    }
    if (lowerBase === 'dockerfile' ||
        lowerBase.startsWith('dockerfile.') ||
        lowerBase.endsWith('.dockerfile') ||
        lowerBase === 'containerfile' ||
        lowerBase.startsWith('containerfile.') ||
        lowerBase.endsWith('.containerfile')) {
        return true;
    }
    const ext = path.extname(lowerBase);
    return INDEXABLE_EXTS.has(ext);
}
/**
 * Fast pure-Node filesystem scan (~2–4ms on typical repos) that checks whether every indexable
 * file on disk matches `tracked` (by presence and mtimeMs within 1ms) with no missing or extra
 * indexable files. Returns `false` (fail-safe) on any discrepancy or I/O error.
 */
export function isWorkspaceFilesystemClean(workspaceRoot, tracked) {
    let matchedTracked = 0;
    const walk = (dir, relPrefix) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return false;
        }
        for (const entry of entries) {
            if (FAST_SCAN_IGNORED_DIRS.has(entry.name))
                continue;
            const full = path.join(dir, entry.name);
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (isExcludedSubtree(full))
                    continue;
                if (!walk(full, rel))
                    return false;
            }
            else if (entry.isFile() && isIndexableCandidatePath(entry.name)) {
                const prev = tracked.get(rel);
                if (!prev)
                    return false;
                try {
                    const stat = fs.statSync(full);
                    if (Math.abs(stat.mtimeMs - prev.mtimeMs) > 1)
                        return false;
                }
                catch {
                    return false;
                }
                matchedTracked++;
            }
        }
        return true;
    };
    if (!walk(workspaceRoot, ''))
        return false;
    return matchedTracked === tracked.size;
}
//# sourceMappingURL=candidate-files.js.map