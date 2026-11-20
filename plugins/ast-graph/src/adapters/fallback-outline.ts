import type { FileOutlineSymbol } from '../types.js';

/**
 * Universal fallback structural chunker for Markdown, YAML, JSON, TOML, or any unindexed workspace file.
 * Kept dependency-free (no `typescript` import) so read-only CLI/DB queries stay fast on cold start.
 * Guarantees that `ast_outline` never returns 0 symbols for a non-empty file on disk.
 */
export function buildFallbackStructuralOutline(
  relPath: string,
  content: string,
): { language: string; lineCount: number; symbols: FileOutlineSymbol[] } {
  const lines = content.split('\n');
  const lineCount = lines.length;
  const lower = relPath.toLowerCase();
  const symbols: FileOutlineSymbol[] = [];

  if (lower.endsWith('.md') || lower.endsWith('.mdx')) {
    const headings: Array<{ level: number; title: string; startLine: number; raw: string }> = [];
    let inFence = false;
    for (let i = 0; i < lineCount; i++) {
      const line = lines[i] ?? '';
      if (/^```/.test(line.trim())) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = line.match(/^(#{1,4})\s+(.+)$/);
      if (m) {
        headings.push({
          level: m[1]!.length,
          title: m[2]!.trim(),
          startLine: i + 1,
          raw: line.trim(),
        });
      }
    }
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i]!;
      let endLine = lineCount;
      for (let j = i + 1; j < headings.length; j++) {
        if (headings[j]!.level <= h.level) {
          endLine = headings[j]!.startLine - 1;
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
    const topKeys: Array<{ key: string; startLine: number; raw: string }> = [];
    for (let i = 0; i < lineCount; i++) {
      const line = lines[i] ?? '';
      const tomlTable = line.match(/^\[([^\]]+)\]/);
      const yamlKey = line.match(/^([A-Za-z0-9_.-]+)\s*:/);
      if (tomlTable) {
        topKeys.push({ key: `[${tomlTable[1]}]`, startLine: i + 1, raw: line.trim() });
      } else if (yamlKey) {
        topKeys.push({ key: yamlKey[1]!, startLine: i + 1, raw: line.trim() });
      }
    }
    for (let i = 0; i < topKeys.length; i++) {
      const tk = topKeys[i]!;
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
    const topKeys: Array<{ key: string; startLine: number; raw: string }> = [];
    for (let i = 0; i < lineCount; i++) {
      const line = lines[i] ?? '';
      const m = line.match(/^\s{2}"([^"]+)"\s*:/);
      if (m) {
        topKeys.push({ key: m[1]!, startLine: i + 1, raw: line.trim() });
      }
    }
    for (let i = 0; i < topKeys.length; i++) {
      const tk = topKeys[i]!;
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
    const firstNonEmpty =
      lines
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
