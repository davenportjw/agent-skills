import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type {
  CompilerAdapter,
  CompilerGraphBatch,
  EdgeKind,
  GraphDiagnosticRecord,
  GraphEdgeRecord,
  GraphFileRecord,
  GraphNodeRecord,
  NodeKind,
  ScipSymbolUri,
} from '../types.js';

interface WorkspacePkgInfo {
  name: string;
  version: string;
  relDir: string;
  absDir: string;
  entryRelPath: string;
}

function computeCyclomaticComplexity(node: ts.Node): number {
  let complexity = 1;
  const visit = (n: ts.Node): void => {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        complexity += 1;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const bin = n as ts.BinaryExpression;
        if (
          bin.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          bin.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          bin.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity += 1;
        }
        break;
      }
      default:
        break;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return complexity;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  if (!mods) return false;
  return mods.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
  );
}

function getJSDocComment(node: ts.Node, sourceFile: ts.SourceFile): string {
  const fullText = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
  if (!ranges || ranges.length === 0) return '';
  const last = ranges[ranges.length - 1]!;
  const raw = fullText.slice(last.pos, last.end);
  if (!raw.startsWith('/**')) return '';
  return raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 400);
}

function isZodInitializerText(text: string, varName: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  if (
    normalized.startsWith('z.') ||
    normalized.includes('z.object(') ||
    normalized.includes('z.discriminatedUnion(') ||
    normalized.includes('z.union(') ||
    normalized.includes('z.enum(') ||
    normalized.includes('z.array(') ||
    normalized.includes('z.string(') ||
    normalized.includes('z.number(')
  ) {
    return true;
  }
  if (
    varName.endsWith('Schema') &&
    (normalized.endsWith('Schema') ||
      normalized.includes('.refine(') ||
      normalized.includes('.superRefine('))
  ) {
    return true;
  }
  return false;
}

export class TypeScriptCompilerAdapter implements CompilerAdapter {
  public readonly name = 'typescript';
  public readonly languages = ['typescript', 'javascript'] as const;

  public supportsFile(filePath: string): boolean {
    if (
      filePath.includes('node_modules') ||
      filePath.includes('/dist/') ||
      filePath.startsWith('dist/') ||
      filePath.includes('.ast-graph') ||
      filePath.endsWith('.d.ts')
    ) {
      return false;
    }
    return filePath.endsWith('.ts') || filePath.endsWith('.mjs');
  }

  public discoverWorkspacePackages(workspaceRoot: string): WorkspacePkgInfo[] {
    const pkgs: WorkspacePkgInfo[] = [];
    for (const group of ['packages', 'apps', 'tools']) {
      const groupDir = path.join(workspaceRoot, group);
      if (!fs.existsSync(groupDir)) continue;
      for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const absDir = path.join(groupDir, entry.name);
        const pkgJsonPath = path.join(absDir, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
            name?: string;
            version?: string;
          };
          const relDir = path.relative(workspaceRoot, absDir).split(path.sep).join('/');
          const srcIndex = path.join(absDir, 'src', 'index.ts');
          const srcServer = path.join(absDir, 'src', 'server.ts');
          const entryRelPath = fs.existsSync(srcIndex)
            ? `${relDir}/src/index.ts`
            : fs.existsSync(srcServer)
              ? `${relDir}/src/server.ts`
              : `${relDir}/src/index.ts`;
          pkgs.push({
            name: parsed.name ?? `@warehouse/${entry.name}`,
            version: parsed.version ?? '0.1.0',
            relDir,
            absDir,
            entryRelPath,
          });
        } catch {
          // Ignore malformed package.json
        }
      }
    }
    return pkgs;
  }

  public discoverAllSourceFiles(workspaceRoot: string): string[] {
    const results: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === '.git' ||
          entry.name === '.wireit' ||
          entry.name === '.ast-graph' ||
          entry.name === 'out'
        ) {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const relPath = path.relative(workspaceRoot, fullPath).split(path.sep).join('/');
          if (this.supportsFile(relPath)) {
            results.push(fullPath);
          }
        }
      }
    };

    for (const rootSub of ['packages', 'apps', 'tools']) {
      walk(path.join(workspaceRoot, rootSub));
    }
    return results.sort();
  }

  public extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch {
    const resolvedRoot = path.resolve(workspaceRoot);
    const pkgs = this.discoverWorkspacePackages(resolvedRoot);
    const allFiles = this.discoverAllSourceFiles(resolvedRoot);

    const targetRelSet = targetFiles
      ? new Set(
          targetFiles.map((f) =>
            path.isAbsolute(f)
              ? path.relative(resolvedRoot, f).split(path.sep).join('/')
              : f.replace(/^\.\//, '').split(path.sep).join('/'),
          ),
        )
      : null;

    const findPkgForRelPath = (relPath: string): WorkspacePkgInfo => {
      for (const p of pkgs) {
        if (relPath === p.relDir || relPath.startsWith(`${p.relDir}/`)) {
          return p;
        }
      }
      return {
        name: 'warehouse-root',
        version: '0.1.0',
        relDir: '.',
        absDir: resolvedRoot,
        entryRelPath: relPath,
      };
    };

    // Map dist/*.d.ts paths back to src/*.ts paths if TypeScript resolves to built declarations
    const normalizeDeclFilePath = (absOrRelPath: string): string => {
      const rel = (
        path.isAbsolute(absOrRelPath) ? path.relative(resolvedRoot, absOrRelPath) : absOrRelPath
      )
        .split(path.sep)
        .join('/');
      const distMatch = rel.match(/^(packages|apps|tools)\/([^/]+)\/dist\/(.+)\.d\.ts$/);
      if (distMatch) {
        const candidateSrc = `${distMatch[1]}/${distMatch[2]}/src/${distMatch[3]}.ts`;
        if (fs.existsSync(path.join(resolvedRoot, candidateSrc))) {
          return candidateSrc;
        }
      }
      return rel;
    };

    // Build path mappings so @warehouse/* imports resolve directly to source .ts files
    const pathsMap: Record<string, string[]> = {};
    for (const p of pkgs) {
      pathsMap[p.name] = [path.join(resolvedRoot, p.entryRelPath)];
    }

    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowJs: true,
      checkJs: false,
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      baseUrl: resolvedRoot,
      paths: pathsMap,
    };

    const program = ts.createProgram(allFiles, compilerOptions);
    const checker = program.getTypeChecker();

    const filesBatch: GraphFileRecord[] = [];
    const nodesMap = new Map<string, GraphNodeRecord>();
    const edgesMap = new Map<string, GraphEdgeRecord>();
    const diagnosticsBatch: GraphDiagnosticRecord[] = [];

    const addNode = (node: GraphNodeRecord): void => {
      nodesMap.set(node.id, node);
    };

    const addEdge = (edge: GraphEdgeRecord): void => {
      if (!edge.srcId || !edge.dstId || edge.srcId === edge.dstId) return;
      const key = `${edge.srcId}|${edge.dstId}|${edge.kind}|${edge.filePath}|${edge.line}`;
      if (!edgesMap.has(key)) {
        edgesMap.set(key, edge);
      }
    };

    // Emit WorkspacePackage nodes on full sync (or for packages touched in incremental sync)
    for (const p of pkgs) {
      const pkgNodeId = `scip-ts npm ${p.name} ${p.version} package#`;
      addNode({
        id: pkgNodeId,
        kind: 'WorkspacePackage',
        name: p.name,
        qualifiedName: p.name,
        packageName: p.name,
        filePath: `${p.relDir}/package.json`,
        language: 'typescript',
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 1,
        signature: `package ${p.name}@${p.version}`,
        docstring: `Workspace package ${p.name} at ${p.relDir}`,
        exported: true,
        complexity: 1,
        labels: ['WorkspacePackage'],
        properties: { version: p.version, relDir: p.relDir },
      });
    }

    const makeFileScipId = (pkg: WorkspacePkgInfo, relFile: string): ScipSymbolUri =>
      `scip-ts npm ${pkg.name} ${pkg.version} ${relFile}/`;

    const makeSymbolScipId = (
      pkg: WorkspacePkgInfo,
      relFile: string,
      descriptor: string,
    ): ScipSymbolUri => `scip-ts npm ${pkg.name} ${pkg.version} ${relFile}/${descriptor}`;

    // Map ts.Declaration -> SCIP URI across all source files so call sites resolve accurately
    const declToScipId = new Map<ts.Node, ScipSymbolUri>();
    const propertyScipByName = new Map<string, ScipSymbolUri[]>();

    const registerPropertyScip = (propName: string, scipId: ScipSymbolUri): void => {
      let list = propertyScipByName.get(propName);
      if (!list) {
        list = [];
        propertyScipByName.set(propName, list);
      }
      if (!list.includes(scipId)) {
        list.push(scipId);
      }
    };

    const registerFileDeclarations = (sf: ts.SourceFile): void => {
      const absPath = path.resolve(sf.fileName);
      const relPath = normalizeDeclFilePath(absPath);
      if (!this.supportsFile(relPath)) return;
      const pkg = findPkgForRelPath(relPath);

      const visitDecl = (node: ts.Node, containerName?: string): void => {
        if (ts.isFunctionDeclaration(node) && node.name) {
          const name = node.name.text;
          const desc = containerName ? `${containerName}#${name}().` : `${name}().`;
          declToScipId.set(node, makeSymbolScipId(pkg, relPath, desc));
        } else if (ts.isClassDeclaration(node) && node.name) {
          const className = node.name.text;
          declToScipId.set(node, makeSymbolScipId(pkg, relPath, `${className}#`));
          for (const member of node.members) {
            visitDecl(member, className);
          }
          return;
        } else if (ts.isInterfaceDeclaration(node) && node.name) {
          const ifaceName = node.name.text;
          declToScipId.set(node, makeSymbolScipId(pkg, relPath, `${ifaceName}#`));
          for (const member of node.members) {
            visitDecl(member, ifaceName);
          }
          return;
        } else if (ts.isMethodDeclaration(node) && node.name && containerName) {
          const methodName = node.name.getText(sf);
          declToScipId.set(node, makeSymbolScipId(pkg, relPath, `${containerName}#${methodName}().`));
        } else if (
          (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) &&
          node.name &&
          containerName
        ) {
          const propName = node.name.getText(sf);
          const propId = makeSymbolScipId(pkg, relPath, `${containerName}#${propName}.`);
          declToScipId.set(node, propId);
          registerPropertyScip(propName, propId);
        } else if (
          ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          containerName &&
          node.parent &&
          ts.isObjectLiteralExpression(node.parent) &&
          node.parent.parent &&
          ts.isCallExpression(node.parent.parent) &&
          node.parent.parent.expression.getText(sf).includes('object')
        ) {
          const propName = node.name.text;
          const propId = makeSymbolScipId(pkg, relPath, `${containerName}#${propName}.`);
          declToScipId.set(node, propId);
          registerPropertyScip(propName, propId);
        } else if (ts.isTypeAliasDeclaration(node) && node.name) {
          declToScipId.set(node, makeSymbolScipId(pkg, relPath, `${node.name.text}#`));
        } else if (ts.isEnumDeclaration(node) && node.name) {
          declToScipId.set(node, makeSymbolScipId(pkg, relPath, `${node.name.text}#`));
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          const varName = node.name.text;
          const initText = node.initializer ? node.initializer.getText(sf) : '';
          const isZod = isZodInitializerText(initText, varName);
          const isFuncLike =
            node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
          const desc = isFuncLike ? `${varName}().` : `${varName}.`;
          declToScipId.set(node, makeSymbolScipId(pkg, relPath, desc));
          if (isZod && node.initializer) {
            ts.forEachChild(node.initializer, (child) => visitDecl(child, varName));
            return;
          }
        }
        ts.forEachChild(node, (child) => visitDecl(child, containerName));
      };

      ts.forEachChild(sf, (child) => visitDecl(child));
    };

    for (const sf of program.getSourceFiles()) {
      if (!sf.isDeclarationFile) {
        registerFileDeclarations(sf);
      }
    }

    const resolveTargetDeclarationScip = (
      sym: ts.Symbol | undefined,
      _fallbackPropName?: string,
    ): ScipSymbolUri | null => {
      if (!sym) {
        return null;
      }
      let resolvedSym = sym;
      if (resolvedSym.flags & ts.SymbolFlags.Alias) {
        try {
          resolvedSym = checker.getAliasedSymbol(resolvedSym);
        } catch {
          // Keep original symbol if alias cannot be resolved
        }
      }
      const decls = resolvedSym.getDeclarations();
      if (!decls || decls.length === 0) {
        return null;
      }
      for (const decl of decls) {
        const direct = declToScipId.get(decl);
        if (direct) return direct;

        // If declaration came from a dist/*.d.ts file, map back to canonical source SCIP URI
        const declSf = decl.getSourceFile();
        const relPath = normalizeDeclFilePath(declSf.fileName);
        if (!relPath.startsWith('packages/') && !relPath.startsWith('apps/') && !relPath.startsWith('tools/')) {
          continue;
        }
        if (relPath.includes('node_modules')) continue;
        const pkg = findPkgForRelPath(relPath);
        const symName = resolvedSym.getName();
        if (!symName || symName === '__type' || symName === 'default') continue;

        if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) {
          const parent = decl.parent;
          if ((ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) && parent.name) {
            return makeSymbolScipId(pkg, relPath, `${parent.name.text}#${symName}().`);
          }
          return makeSymbolScipId(pkg, relPath, `${symName}().`);
        }
        if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isPropertyAssignment(decl)) {
          const parent = decl.parent;
          if ((ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) && parent.name) {
            return makeSymbolScipId(pkg, relPath, `${parent.name.text}#${symName}.`);
          }
          const matches = propertyScipByName.get(symName);
          if (matches && matches.length > 0) {
            const sameFileMatch = matches.find((m) => m.includes(`/${relPath}/`));
            if (sameFileMatch) return sameFileMatch;
          }
        }
        if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl)) {
          return makeSymbolScipId(pkg, relPath, `${symName}#`);
        }
        if (ts.isVariableDeclaration(decl)) {
          return makeSymbolScipId(pkg, relPath, `${symName}.`);
        }
      }
      return null;
    };

    const resolveModuleSpecifierToFileScip = (
      containingFileAbs: string,
      moduleSpec: string,
    ): { fileScipId: ScipSymbolUri; targetRelPath: string } | null => {
      // Check workspace package match first
      for (const p of pkgs) {
        if (moduleSpec === p.name || moduleSpec.startsWith(`${p.name}/`)) {
          return {
            fileScipId: makeFileScipId(p, p.entryRelPath),
            targetRelPath: p.entryRelPath,
          };
        }
      }
      if (moduleSpec.startsWith('.')) {
        const dir = path.dirname(containingFileAbs);
        const rawTarget = path.resolve(dir, moduleSpec);
        const candidates = [
          rawTarget,
          rawTarget.replace(/\.js$/, '.ts'),
          rawTarget.replace(/\.mjs$/, '.ts'),
          `${rawTarget}.ts`,
          path.join(rawTarget, 'index.ts'),
        ];
        for (const cand of candidates) {
          if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
            const rel = normalizeDeclFilePath(cand);
            const pkg = findPkgForRelPath(rel);
            return {
              fileScipId: makeFileScipId(pkg, rel),
              targetRelPath: rel,
            };
          }
        }
      }
      return null;
    };

    // Process each target file
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const absPath = path.resolve(sf.fileName);
      const relPath = normalizeDeclFilePath(absPath);
      if (!this.supportsFile(relPath)) continue;
      if (targetRelSet && !targetRelSet.has(relPath)) continue;
      if (!fs.existsSync(absPath)) continue;

      const stat = fs.statSync(absPath);
      const content = fs.readFileSync(absPath, 'utf8');
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const lineCount = content.split('\n').length;
      const pkg = findPkgForRelPath(relPath);
      const language = relPath.endsWith('.mjs') ? 'javascript' : 'typescript';
      const isTestFile = relPath.endsWith('.test.ts') || relPath.includes('/test/');

      filesBatch.push({
        filePath: relPath,
        packageName: pkg.name,
        language,
        sha256,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        lineCount,
      });

      const pkgNodeId = `scip-ts npm ${pkg.name} ${pkg.version} package#`;
      const fileNodeId = makeFileScipId(pkg, relPath);

      addNode({
        id: fileNodeId,
        kind: 'File',
        name: path.basename(relPath),
        qualifiedName: relPath,
        packageName: pkg.name,
        filePath: relPath,
        language,
        startLine: 1,
        startCol: 1,
        endLine: lineCount,
        endCol: 1,
        signature: `file ${relPath}`,
        docstring: `Source file ${relPath} in ${pkg.name}`,
        exported: true,
        complexity: 1,
        labels: isTestFile ? ['File', 'TestFile'] : ['File'],
        properties: { sizeBytes: stat.size, lineCount },
      });

      addEdge({
        srcId: pkgNodeId,
        dstId: fileNodeId,
        kind: 'CONTAINS',
        filePath: relPath,
        line: 1,
        col: 1,
        weight: 1,
        properties: {},
      });

      const posToLineCol = (pos: number): { line: number; col: number } => {
        const lc = sf.getLineAndCharacterOfPosition(pos);
        return { line: lc.line + 1, col: lc.character + 1 };
      };

      const importedFileScipIds: ScipSymbolUri[] = [];

      // Walk AST keeping a stack of enclosing symbol IDs (including TestSuite / TestCase)
      const symbolStack: Array<{ id: ScipSymbolUri; kind: NodeKind; name: string }> = [
        { id: fileNodeId, kind: 'File', name: path.basename(relPath) },
      ];

      const currentEnclosing = () => symbolStack[symbolStack.length - 1]!;
      const currentTestContext = () => {
        for (let i = symbolStack.length - 1; i >= 0; i--) {
          const item = symbolStack[i]!;
          if (item.kind === 'TestCase' || item.kind === 'TestSuite') {
            return item;
          }
        }
        return null;
      };

      const visitNode = (node: ts.Node): void => {
        const startPos = posToLineCol(node.getStart(sf));
        const endPos = posToLineCol(node.getEnd());

        // 1. Imports & Re-exports
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          const resolved = resolveModuleSpecifierToFileScip(absPath, spec);
          if (resolved) {
            importedFileScipIds.push(resolved.fileScipId);
            addEdge({
              srcId: fileNodeId,
              dstId: resolved.fileScipId,
              kind: 'IMPORTS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: { specifier: spec },
            });
            if (isTestFile && !resolved.targetRelPath.endsWith('.test.ts')) {
              addEdge({
                srcId: fileNodeId,
                dstId: resolved.fileScipId,
                kind: 'TESTS_FILE',
                filePath: relPath,
                line: startPos.line,
                col: startPos.col,
                weight: 1,
                properties: {},
              });
            }
          }
        } else if (
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const spec = node.moduleSpecifier.text;
          const resolved = resolveModuleSpecifierToFileScip(absPath, spec);
          if (resolved) {
            addEdge({
              srcId: fileNodeId,
              dstId: resolved.fileScipId,
              kind: 'IMPORTS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: { reexport: true, specifier: spec },
            });
            addEdge({
              srcId: fileNodeId,
              dstId: resolved.fileScipId,
              kind: 'EXPORTS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: { reexport: true },
            });
          }
        }

        // 2. Declarations (Function, Class, Interface, Method, Property, TypeAlias, Enum, Variable/ZodSchema)
        if (ts.isFunctionDeclaration(node) && node.name) {
          const fnName = node.name.text;
          const fnId = declToScipId.get(node) ?? makeSymbolScipId(pkg, relPath, `${fnName}().`);
          const exported = hasExportModifier(node);
          const sigText = node
            .getText(sf)
            .split('{')[0]
            ?.replace(/\s+/g, ' ')
            .trim()
            .slice(0, 240) ?? `function ${fnName}()`;
          const doc = getJSDocComment(node, sf);
          const comp = computeCyclomaticComplexity(node);

          addNode({
            id: fnId,
            kind: 'Function',
            name: fnName,
            qualifiedName: `${pkg.name}/${fnName}`,
            packageName: pkg.name,
            filePath: relPath,
            language,
            startLine: startPos.line,
            startCol: startPos.col,
            endLine: endPos.line,
            endCol: endPos.col,
            signature: sigText,
            docstring: doc,
            exported,
            complexity: comp,
            labels: ['Function'],
            properties: {},
          });

          addEdge({
            srcId: currentEnclosing().id,
            dstId: fnId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startPos.line,
            col: startPos.col,
            weight: 1,
            properties: {},
          });
          if (exported) {
            addEdge({
              srcId: fileNodeId,
              dstId: fnId,
              kind: 'EXPORTS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: {},
            });
          }

          symbolStack.push({ id: fnId, kind: 'Function', name: fnName });
          ts.forEachChild(node, visitNode);
          symbolStack.pop();
          return;
        }

        if (ts.isClassDeclaration(node) && node.name) {
          const className = node.name.text;
          const classId = declToScipId.get(node) ?? makeSymbolScipId(pkg, relPath, `${className}#`);
          const exported = hasExportModifier(node);
          const doc = getJSDocComment(node, sf);

          addNode({
            id: classId,
            kind: 'Class',
            name: className,
            qualifiedName: `${pkg.name}/${className}`,
            packageName: pkg.name,
            filePath: relPath,
            language,
            startLine: startPos.line,
            startCol: startPos.col,
            endLine: endPos.line,
            endCol: endPos.col,
            signature: `class ${className}`,
            docstring: doc,
            exported,
            complexity: computeCyclomaticComplexity(node),
            labels: ['Class'],
            properties: {},
          });

          addEdge({
            srcId: currentEnclosing().id,
            dstId: classId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startPos.line,
            col: startPos.col,
            weight: 1,
            properties: {},
          });
          if (exported) {
            addEdge({
              srcId: fileNodeId,
              dstId: classId,
              kind: 'EXPORTS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: {},
            });
          }

          // Heritage clauses (EXTENDS / IMPLEMENTS)
          if (node.heritageClauses) {
            for (const hc of node.heritageClauses) {
              const edgeKind: EdgeKind =
                hc.token === ts.SyntaxKind.ExtendsKeyword ? 'EXTENDS' : 'IMPLEMENTS';
              for (const typeNode of hc.types) {
                const sym = checker.getSymbolAtLocation(typeNode.expression);
                const targetId = resolveTargetDeclarationScip(sym);
                if (targetId) {
                  addEdge({
                    srcId: classId,
                    dstId: targetId,
                    kind: edgeKind,
                    filePath: relPath,
                    line: startPos.line,
                    col: startPos.col,
                    weight: 1,
                    properties: {},
                  });
                }
              }
            }
          }

          symbolStack.push({ id: classId, kind: 'Class', name: className });
          ts.forEachChild(node, visitNode);
          symbolStack.pop();
          return;
        }

        if (ts.isMethodDeclaration(node) && node.name) {
          const methodName = node.name.getText(sf);
          const enclosing = currentEnclosing();
          const methodId =
            declToScipId.get(node) ??
            makeSymbolScipId(pkg, relPath, `${enclosing.name}#${methodName}().`);
          const sigText =
            node
              .getText(sf)
              .split('{')[0]
              ?.replace(/\s+/g, ' ')
              .trim()
              .slice(0, 240) ?? `${enclosing.name}.${methodName}()`;

          addNode({
            id: methodId,
            kind: 'Method',
            name: methodName,
            qualifiedName: `${enclosing.name}.${methodName}`,
            packageName: pkg.name,
            filePath: relPath,
            language,
            startLine: startPos.line,
            startCol: startPos.col,
            endLine: endPos.line,
            endCol: endPos.col,
            signature: sigText,
            docstring: getJSDocComment(node, sf),
            exported: true,
            complexity: computeCyclomaticComplexity(node),
            labels: ['Method'],
            properties: { className: enclosing.name },
          });

          addEdge({
            srcId: enclosing.id,
            dstId: methodId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startPos.line,
            col: startPos.col,
            weight: 1,
            properties: {},
          });

          symbolStack.push({ id: methodId, kind: 'Method', name: `${enclosing.name}.${methodName}` });
          ts.forEachChild(node, visitNode);
          symbolStack.pop();
          return;
        }

        if (
          (ts.isPropertyDeclaration(node) ||
            ts.isPropertySignature(node) ||
            ts.isPropertyAssignment(node)) &&
          node.name &&
          ts.isIdentifier(node.name)
        ) {
          const propId = declToScipId.get(node);
          if (propId) {
            const propName = node.name.text;
            const enclosing = currentEnclosing();
            const sigText = node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 200);
            addNode({
              id: propId,
              kind: 'Property',
              name: propName,
              qualifiedName: `${pkg.name}/${enclosing.name}.${propName}`,
              packageName: pkg.name,
              filePath: relPath,
              language,
              startLine: startPos.line,
              startCol: startPos.col,
              endLine: endPos.line,
              endCol: endPos.col,
              signature: sigText,
              docstring: getJSDocComment(node, sf),
              exported: true,
              complexity: 1,
              labels: ['Property'],
              properties: { container: enclosing.name, containerKind: enclosing.kind },
            });
            addEdge({
              srcId: enclosing.id,
              dstId: propId,
              kind: 'CONTAINS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: {},
            });
          }
        }

        if (ts.isInterfaceDeclaration(node) && node.name) {
          const ifaceName = node.name.text;
          const ifaceId = declToScipId.get(node) ?? makeSymbolScipId(pkg, relPath, `${ifaceName}#`);
          const exported = hasExportModifier(node);

          addNode({
            id: ifaceId,
            kind: 'Interface',
            name: ifaceName,
            qualifiedName: `${pkg.name}/${ifaceName}`,
            packageName: pkg.name,
            filePath: relPath,
            language,
            startLine: startPos.line,
            startCol: startPos.col,
            endLine: endPos.line,
            endCol: endPos.col,
            signature: `interface ${ifaceName}`,
            docstring: getJSDocComment(node, sf),
            exported,
            complexity: 1,
            labels: ['Interface'],
            properties: {},
          });

          addEdge({
            srcId: currentEnclosing().id,
            dstId: ifaceId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startPos.line,
            col: startPos.col,
            weight: 1,
            properties: {},
          });
          if (exported) {
            addEdge({
              srcId: fileNodeId,
              dstId: ifaceId,
              kind: 'EXPORTS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: {},
            });
          }

          symbolStack.push({ id: ifaceId, kind: 'Interface', name: ifaceName });
          ts.forEachChild(node, visitNode);
          symbolStack.pop();
          return;
        }

        if (ts.isTypeAliasDeclaration(node) && node.name) {
          const typeName = node.name.text;
          const typeId = declToScipId.get(node) ?? makeSymbolScipId(pkg, relPath, `${typeName}#`);
          const exported = hasExportModifier(node);
          const sigText = node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 240);

          addNode({
            id: typeId,
            kind: 'TypeAlias',
            name: typeName,
            qualifiedName: `${pkg.name}/${typeName}`,
            packageName: pkg.name,
            filePath: relPath,
            language,
            startLine: startPos.line,
            startCol: startPos.col,
            endLine: endPos.line,
            endCol: endPos.col,
            signature: sigText,
            docstring: getJSDocComment(node, sf),
            exported,
            complexity: 1,
            labels: ['TypeAlias'],
            properties: {},
          });

          addEdge({
            srcId: currentEnclosing().id,
            dstId: typeId,
            kind: 'CONTAINS',
            filePath: relPath,
            line: startPos.line,
            col: startPos.col,
            weight: 1,
            properties: {},
          });
          if (exported) {
            addEdge({
              srcId: fileNodeId,
              dstId: typeId,
              kind: 'EXPORTS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: {},
            });
          }
        }

        if (ts.isVariableStatement(node)) {
          const exported = hasExportModifier(node);
          const doc = getJSDocComment(node, sf);
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              const varName = decl.name.text;
              const initText = decl.initializer ? decl.initializer.getText(sf) : '';
              const isZod = isZodInitializerText(initText, varName);
              const isFunc =
                decl.initializer &&
                (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));

              // Only index top-level variables, exported constants, Zod schemas, or function variables
              if (exported || isZod || isFunc || currentEnclosing().kind === 'File') {
                const varId =
                  declToScipId.get(decl) ??
                  makeSymbolScipId(pkg, relPath, isFunc ? `${varName}().` : `${varName}.`);
                const nodeKind: NodeKind = isZod
                  ? 'ZodSchema'
                  : isFunc
                    ? 'Function'
                    : 'Variable';
                const labels = isZod ? ['ZodSchema', 'Variable', 'ProtocolContract'] : [nodeKind];
                const dStart = posToLineCol(decl.getStart(sf));
                const dEnd = posToLineCol(decl.getEnd());

                addNode({
                  id: varId,
                  kind: nodeKind,
                  name: varName,
                  qualifiedName: `${pkg.name}/${varName}`,
                  packageName: pkg.name,
                  filePath: relPath,
                  language,
                  startLine: dStart.line,
                  startCol: dStart.col,
                  endLine: dEnd.line,
                  endCol: dEnd.col,
                  signature: `${exported ? 'export ' : ''}const ${varName} = ${initText
                    .replace(/\s+/g, ' ')
                    .slice(0, 180)}`,
                  docstring: doc,
                  exported,
                  complexity: decl.initializer ? computeCyclomaticComplexity(decl.initializer) : 1,
                  labels,
                  properties: isZod ? { zodSchema: true } : {},
                });

                addEdge({
                  srcId: currentEnclosing().id,
                  dstId: varId,
                  kind: 'CONTAINS',
                  filePath: relPath,
                  line: dStart.line,
                  col: dStart.col,
                  weight: 1,
                  properties: {},
                });

                if (exported) {
                  addEdge({
                    srcId: fileNodeId,
                    dstId: varId,
                    kind: 'EXPORTS',
                    filePath: relPath,
                    line: dStart.line,
                    col: dStart.col,
                    weight: 1,
                    properties: {},
                  });
                }

                if (decl.initializer) {
                  symbolStack.push({ id: varId, kind: nodeKind, name: varName });
                  visitNode(decl.initializer);
                  symbolStack.pop();
                }
              } else if (decl.initializer) {
                visitNode(decl.initializer);
              }
            } else if (decl.initializer) {
              visitNode(decl.initializer);
            }
          }
          return;
        }

        // 3. Vitest TestSuite / TestCase blocks: describe(...), it(...), test(...)
        if (ts.isCallExpression(node) && isTestFile) {
          const exprText = node.expression.getText(sf);
          const isSuite =
            exprText === 'describe' ||
            exprText.startsWith('describe.') ||
            exprText === 'suite';
          const isTest =
            exprText === 'it' ||
            exprText.startsWith('it.') ||
            exprText === 'test' ||
            exprText.startsWith('test.');

          if ((isSuite || isTest) && node.arguments.length >= 2) {
            const firstArg = node.arguments[0]!;
            const testTitle = ts.isStringLiteralLike(firstArg)
              ? firstArg.text
              : firstArg.getText(sf).slice(0, 120);
            const testKind: NodeKind = isSuite ? 'TestSuite' : 'TestCase';
            const slug = testTitle.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
            const testId = makeSymbolScipId(
              pkg,
              relPath,
              `${testKind}:${slug}:${startPos.line}#`,
            );

            addNode({
              id: testId,
              kind: testKind,
              name: testTitle,
              qualifiedName: `${relPath}::${testTitle}`,
              packageName: pkg.name,
              filePath: relPath,
              language,
              startLine: startPos.line,
              startCol: startPos.col,
              endLine: endPos.line,
              endCol: endPos.col,
              signature: `${exprText}('${testTitle}')`,
              docstring: `Vitest ${testKind} in ${relPath}`,
              exported: false,
              complexity: computeCyclomaticComplexity(node),
              labels: [testKind, 'Vitest'],
              properties: { title: testTitle },
            });

            addEdge({
              srcId: currentEnclosing().id,
              dstId: testId,
              kind: 'CONTAINS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: {},
            });

            for (const impFileId of importedFileScipIds) {
              addEdge({
                srcId: testId,
                dstId: impFileId,
                kind: 'TESTS_FILE',
                filePath: relPath,
                line: startPos.line,
                col: startPos.col,
                weight: 1,
                properties: {},
              });
            }

            symbolStack.push({ id: testId, kind: testKind, name: testTitle });
            ts.forEachChild(node, visitNode);
            symbolStack.pop();
            return;
          }
        }

        // 4. Call expressions: CALLS, VALIDATES_SCHEMA, HANDLES_ROUTE, CONNECTS_ENDPOINT, TESTS_SYMBOL
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const enclosing = currentEnclosing();
          const testCtx = currentTestContext();

          // 4a. Detect Fastify route registration: app.get('/api/...', ...) or fastify.post(...)
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const objText = node.expression.expression.getText(sf);
            const propName = node.expression.name.text;
            const httpMethods = new Set(['get', 'post', 'put', 'delete', 'patch', 'all']);
            if (
              (objText === 'app' || objText === 'fastify' || objText === 'server') &&
              httpMethods.has(propName) &&
              node.arguments.length >= 1
            ) {
              const routeArg = node.arguments[0]!;
              if (ts.isStringLiteralLike(routeArg)) {
                const routePath = routeArg.text;
                const methodUpper = propName.toUpperCase();
                const routeId = `scip-endpoint http ${pkg.name} ${pkg.version} ${methodUpper}:${routePath}#`;
                addNode({
                  id: routeId,
                  kind: 'RouteEndpoint',
                  name: `${methodUpper} ${routePath}`,
                  qualifiedName: `${pkg.name} ${methodUpper} ${routePath}`,
                  packageName: pkg.name,
                  filePath: relPath,
                  language,
                  startLine: startPos.line,
                  startCol: startPos.col,
                  endLine: endPos.line,
                  endCol: endPos.col,
                  signature: `${objText}.${propName}('${routePath}', handler)`,
                  docstring: `Fastify HTTP ${methodUpper} endpoint ${routePath} in ${pkg.name}`,
                  exported: true,
                  complexity: computeCyclomaticComplexity(node),
                  labels: ['RouteEndpoint', 'HttpEndpoint'],
                  properties: { method: methodUpper, path: routePath },
                });
                addEdge({
                  srcId: enclosing.id,
                  dstId: routeId,
                  kind: 'HANDLES_ROUTE',
                  filePath: relPath,
                  line: startPos.line,
                  col: startPos.col,
                  weight: 1,
                  properties: { method: methodUpper, path: routePath },
                });
              }
            }

            // 4b. Detect Zod schema validation: SomeSchema.parse(...) or SomeSchema.safeParse(...)
            if (propName === 'parse' || propName === 'safeParse' || propName === 'parseAsync') {
              const targetSym = checker.getSymbolAtLocation(node.expression.expression);
              const targetScip = resolveTargetDeclarationScip(targetSym);
              if (targetScip) {
                addEdge({
                  srcId: enclosing.id,
                  dstId: targetScip,
                  kind: 'VALIDATES_SCHEMA',
                  filePath: relPath,
                  line: startPos.line,
                  col: startPos.col,
                  weight: 1,
                  properties: { validatorMethod: propName },
                });
                if (testCtx) {
                  addEdge({
                    srcId: testCtx.id,
                    dstId: targetScip,
                    kind: 'TESTS_SYMBOL',
                    filePath: relPath,
                    line: startPos.line,
                    col: startPos.col,
                    weight: 1,
                    properties: {},
                  });
                }
              }
            }
          }

          // 4c. Detect client fetch('/api/...') or WebSocket('/ws') connections
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
            const firstArg = node.arguments[0];
            if (firstArg) {
              const argText = firstArg.getText(sf);
              const routeMatch = argText.match(/\/(api\/[a-zA-Z0-9/_-]+|internal\/[a-zA-Z0-9/_-]+|healthz|readyz)/);
              if (routeMatch) {
                const routePath = `/${routeMatch[1]}`;
                // Find or emit generic endpoint connection
                const methodGuess = argText.includes('POST') || node.getText(sf).includes('POST') ? 'POST' : 'GET';
                const endpointId = `scip-endpoint http @warehouse/lobby 0.1.0 ${methodGuess}:${routePath}#`;
                addEdge({
                  srcId: enclosing.id,
                  dstId: endpointId,
                  kind: 'CONNECTS_ENDPOINT',
                  filePath: relPath,
                  line: startPos.line,
                  col: startPos.col,
                  weight: 1,
                  properties: { path: routePath },
                });
              }
            }
          }

          // 4d. Resolve general call target symbol
          const callSym = checker.getSymbolAtLocation(node.expression);
          const targetScip = resolveTargetDeclarationScip(callSym);
          if (targetScip) {
            addEdge({
              srcId: enclosing.id,
              dstId: targetScip,
              kind: 'CALLS',
              filePath: relPath,
              line: startPos.line,
              col: startPos.col,
              weight: 1,
              properties: {},
            });
            if (testCtx) {
              addEdge({
                srcId: testCtx.id,
                dstId: targetScip,
                kind: 'TESTS_SYMBOL',
                filePath: relPath,
                line: startPos.line,
                col: startPos.col,
                weight: 1,
                properties: {},
              });
            }
          }
        }

        const isWriteExpr = (expr: ts.Node): boolean => {
          const parent = expr.parent;
          if (!parent) return false;
          if (
            ts.isBinaryExpression(parent) &&
            parent.left === expr &&
            parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ) {
            return true;
          }
          if (
            (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
            (parent.operator === ts.SyntaxKind.PlusPlusToken ||
              parent.operator === ts.SyntaxKind.MinusMinusToken)
          ) {
            return true;
          }
          if (ts.isDeleteExpression(parent) && parent.expression === expr) {
            return true;
          }
          return false;
        };

        // 4b. Property read/write tracking (e.g., v.runEndsAt = ..., state.depletedRunVid = ...)
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
          const propSym = checker.getSymbolAtLocation(node.name);
          const targetScip = resolveTargetDeclarationScip(propSym, node.name.text);
          if (targetScip) {
            const enclosing = currentEnclosing();
            const testCtx = currentTestContext();
            if (targetScip !== enclosing.id) {
              const edgeKind = isWriteExpr(node) ? 'WRITES_PROPERTY' : 'READS_PROPERTY';
              addEdge({
                srcId: enclosing.id,
                dstId: targetScip,
                kind: edgeKind,
                filePath: relPath,
                line: startPos.line,
                col: startPos.col,
                weight: edgeKind === 'WRITES_PROPERTY' ? 1 : 0.75,
                properties: { property: node.name.text },
              });
              if (testCtx && !targetScip.includes('.test.ts')) {
                addEdge({
                  srcId: testCtx.id,
                  dstId: targetScip,
                  kind: 'TESTS_SYMBOL',
                  filePath: relPath,
                  line: startPos.line,
                  col: startPos.col,
                  weight: 1,
                  properties: {},
                });
              }
            }
          }
        }

        // 5. Identifier references (to catch schema references, constants, types, and test references)
        if (
          ts.isIdentifier(node) &&
          !(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        ) {
          const sym = checker.getSymbolAtLocation(node);
          const targetScip = resolveTargetDeclarationScip(sym);
          if (targetScip) {
            const enclosing = currentEnclosing();
            const testCtx = currentTestContext();
            if (targetScip !== enclosing.id) {
              const edgeKind = isWriteExpr(node) ? 'WRITES_PROPERTY' : 'REFERENCES';
              addEdge({
                srcId: enclosing.id,
                dstId: targetScip,
                kind: edgeKind,
                filePath: relPath,
                line: startPos.line,
                col: startPos.col,
                weight: edgeKind === 'WRITES_PROPERTY' ? 1 : 0.5,
                properties: {},
              });
              if (testCtx && !targetScip.includes('.test.ts')) {
                addEdge({
                  srcId: testCtx.id,
                  dstId: targetScip,
                  kind: 'TESTS_SYMBOL',
                  filePath: relPath,
                  line: startPos.line,
                  col: startPos.col,
                  weight: 1,
                  properties: {},
                });
              }
            }
          }
        }

        ts.forEachChild(node, visitNode);
      };

      ts.forEachChild(sf, visitNode);

      // Collect compiler diagnostics for this file
      const syntactics = program.getSyntacticDiagnostics(sf);
      for (const diag of syntactics) {
        const lc = diag.start !== undefined ? posToLineCol(diag.start) : { line: 1, col: 1 };
        diagnosticsBatch.push({
          filePath: relPath,
          enclosingSymbolId: fileNodeId,
          compiler: 'typescript',
          severity:
            diag.category === ts.DiagnosticCategory.Error
              ? 'error'
              : diag.category === ts.DiagnosticCategory.Warning
                ? 'warning'
                : 'info',
          code: `TS${diag.code}`,
          message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
          line: lc.line,
          col: lc.col,
        });
      }
    }

    return {
      compiler: this.name,
      files: filesBatch,
      nodes: [...nodesMap.values()],
      edges: [...edgesMap.values()],
      diagnostics: diagnosticsBatch,
    };
  }
}
