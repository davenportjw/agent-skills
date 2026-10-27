import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const PYTHON_AST_EXTRACTOR_SCRIPT = `
import ast, json, re, sys

payload = json.loads(sys.stdin.read())
files_input = payload.get("files", [])
pkg_name = payload.get("packageName", "python-pkg")

all_nodes = []
all_edges = []
all_diagnostics = []

# Global symbol registries for cross-file resolution within the repository
global_symbols_by_name = {}       # name -> list of node IDs
global_properties_by_name = {}    # prop_name -> list of property node IDs
global_classes_by_name = {}       # class_name -> class node ID

SQL_TABLE_RE = re.compile(
    r"\\b(?:FROM|INTO|UPDATE|JOIN|TABLE\\s+IF\\s+NOT\\s+EXISTS|TABLE)\\s+\`?([a-zA-Z_][a-zA-Z0-9_]*)\`?",
    re.IGNORECASE,
)
SQL_KEYWORDS = {
    "select", "where", "values", "set", "unnest", "dual", "json_table",
    "information_schema", "unnest", "lateral", "only", "stdin", "stdout",
}

def complexity_of(node):
    c = 1
    for child in ast.walk(node):
        if isinstance(child, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.IfExp, ast.BoolOp)):
            c += 1
    return c

def get_decorator_info(dec):
    """Returns (full_dotted_name, call_args, call_kwargs) for a decorator."""
    if isinstance(dec, ast.Name):
        return dec.id, [], {}
    if isinstance(dec, ast.Attribute):
        parts = []
        curr = dec
        while isinstance(curr, ast.Attribute):
            parts.append(curr.attr)
            curr = curr.value
        if isinstance(curr, ast.Name):
            parts.append(curr.id)
        return ".".join(reversed(parts)), [], {}
    if isinstance(dec, ast.Call):
        name, _, _ = get_decorator_info(dec.func)
        args = []
        for a in dec.args:
            if isinstance(a, ast.Constant) and isinstance(a.value, str):
                args.append(a.value)
        kwargs = {}
        for kw in dec.keywords:
            if kw.arg:
                if isinstance(kw.value, ast.Name):
                    kwargs[kw.arg] = kw.value.id
                elif isinstance(kw.value, ast.Constant):
                    kwargs[kw.arg] = str(kw.value.value)
        return name, args, kwargs
    return "", [], {}

def is_test_file(file_path):
    base = file_path.rsplit("/", 1)[-1]
    return (
        base.startswith("test_")
        or base.endswith("_test.py")
        or "/tests/" in f"/{file_path}/"
        or "/test/" in f"/{file_path}/"
    )

parsed_trees = []

# Pass 1: Parse AST and register all top-level and class-level declarations
for f_item in files_input:
    file_path = f_item["filePath"]
    source = f_item["content"]
    try:
        tree = ast.parse(source, filename=file_path)
        parsed_trees.append((file_path, source, tree))
    except SyntaxError as e:
        all_diagnostics.append({
            "filePath": file_path,
            "line": e.lineno or 1,
            "col": e.offset or 1,
            "message": str(e.msg),
            "code": "PY_SYNTAX_ERROR",
        })
        continue

    file_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/"
    test_file = is_test_file(file_path)
    suite_id = None
    if test_file:
        suite_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/TestSuite#"
        all_nodes.append({
            "id": suite_id,
            "filePath": file_path,
            "kind": "TestSuite",
            "name": file_path.rsplit("/", 1)[-1],
            "qualifiedName": f"{pkg_name}/{file_path}",
            "startLine": 1,
            "endLine": max(1, len(source.splitlines())),
            "signature": f"pytest suite {file_path}",
            "docstring": f"Pytest test suite {file_path}",
            "complexity": 1,
            "labels": ["TestSuite", "PytestSuite"],
        })
        all_edges.append({
            "filePath": file_path,
            "srcId": file_id,
            "dstId": suite_id,
            "kind": "CONTAINS",
            "line": 1,
        })

    router_prefixes = {}
    for item in tree.body:
        if isinstance(item, ast.Assign) and isinstance(item.value, ast.Call):
            func_name, _, kwargs = get_decorator_info(item.value)
            if func_name.endswith("APIRouter") or func_name.endswith("Blueprint"):
                prefix = kwargs.get("prefix", "")
                for t in item.targets:
                    if isinstance(t, ast.Name):
                        router_prefixes[t.id] = prefix

        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            is_tc = test_file and item.name.startswith("test_")
            kind = "TestCase" if is_tc else "Function"
            fn_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{item.name}()."
            args = [a.arg for a in item.args.args]
            prefix_kw = "async def" if isinstance(item, ast.AsyncFunctionDef) else "def"
            sig = f"{prefix_kw} {item.name}({', '.join(args)})"
            doc = ast.get_docstring(item) or ""
            labels = [kind, "Python"]
            if is_tc:
                labels.append("PytestCase")
            all_nodes.append({
                "id": fn_id,
                "filePath": file_path,
                "kind": kind,
                "name": item.name,
                "qualifiedName": f"{pkg_name}/{item.name}",
                "startLine": item.lineno,
                "endLine": getattr(item, "end_lineno", item.lineno),
                "signature": sig,
                "docstring": doc[:300],
                "complexity": complexity_of(item),
                "labels": labels,
            })
            parent_container = suite_id if (is_tc and suite_id) else file_id
            all_edges.append({
                "filePath": file_path,
                "srcId": parent_container,
                "dstId": fn_id,
                "kind": "CONTAINS",
                "line": item.lineno,
            })
            global_symbols_by_name.setdefault(item.name, []).append(fn_id)

        elif isinstance(item, ast.ClassDef):
            base_names = []
            for b in item.bases:
                if isinstance(b, ast.Name):
                    base_names.append(b.id)
                elif isinstance(b, ast.Attribute):
                    base_names.append(b.attr)
            dec_names = [get_decorator_info(d)[0] for d in item.decorator_list]
            is_pydantic = any(b in ("BaseModel", "SQLModel", "BaseSettings") for b in base_names)
            is_dataclass = any(d.endswith("dataclass") for d in dec_names)
            is_schema = is_pydantic or is_dataclass

            cls_kind = "ZodSchema" if is_schema else "Class"
            cls_labels = ["ZodSchema", "Schema", "PydanticModel" if is_pydantic else "Dataclass", "Python"] if is_schema else ["Class", "Python"]
            cls_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{item.name}#"
            doc = ast.get_docstring(item) or ""
            sig = f"class {item.name}({', '.join(base_names)})" if base_names else f"class {item.name}"
            all_nodes.append({
                "id": cls_id,
                "filePath": file_path,
                "kind": cls_kind,
                "name": item.name,
                "qualifiedName": f"{pkg_name}/{item.name}",
                "startLine": item.lineno,
                "endLine": getattr(item, "end_lineno", item.lineno),
                "signature": sig,
                "docstring": doc[:300],
                "complexity": complexity_of(item),
                "labels": cls_labels,
            })
            all_edges.append({
                "filePath": file_path,
                "srcId": file_id,
                "dstId": cls_id,
                "kind": "CONTAINS",
                "line": item.lineno,
            })
            global_symbols_by_name.setdefault(item.name, []).append(cls_id)
            global_classes_by_name[item.name] = cls_id

            seen_props = set()
            for member in item.body:
                # Typed class field: e.g. name: str = ...
                if isinstance(member, ast.AnnAssign) and isinstance(member.target, ast.Name):
                    prop_name = member.target.id
                    seen_props.add(prop_name)
                    prop_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{item.name}#{prop_name}."
                    ann_str = ast.unparse(member.annotation) if hasattr(ast, "unparse") else "Any"
                    all_nodes.append({
                        "id": prop_id,
                        "filePath": file_path,
                        "kind": "Property",
                        "name": prop_name,
                        "qualifiedName": f"{item.name}.{prop_name}",
                        "startLine": member.lineno,
                        "endLine": getattr(member, "end_lineno", member.lineno),
                        "signature": f"{prop_name}: {ann_str}",
                        "docstring": f"Field {prop_name} on {item.name}",
                        "complexity": 1,
                        "labels": ["Property", "SchemaField" if is_schema else "ClassField"],
                    })
                    all_edges.append({
                        "filePath": file_path,
                        "srcId": cls_id,
                        "dstId": prop_id,
                        "kind": "CONTAINS",
                        "line": member.lineno,
                    })
                    global_properties_by_name.setdefault(prop_name, []).append(prop_id)

                elif isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    is_tc = test_file and member.name.startswith("test_")
                    m_kind = "TestCase" if is_tc else "Method"
                    m_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{item.name}#{member.name}()."
                    args = [a.arg for a in member.args.args]
                    prefix_kw = "async def" if isinstance(member, ast.AsyncFunctionDef) else "def"
                    all_nodes.append({
                        "id": m_id,
                        "filePath": file_path,
                        "kind": m_kind,
                        "name": member.name,
                        "qualifiedName": f"{item.name}.{member.name}",
                        "startLine": member.lineno,
                        "endLine": getattr(member, "end_lineno", member.lineno),
                        "signature": f"{prefix_kw} {member.name}({', '.join(args)})",
                        "docstring": (ast.get_docstring(member) or "")[:300],
                        "complexity": complexity_of(member),
                        "labels": [m_kind, "Python"],
                    })
                    all_edges.append({
                        "filePath": file_path,
                        "srcId": suite_id if (is_tc and suite_id) else cls_id,
                        "dstId": m_id,
                        "kind": "CONTAINS",
                        "line": member.lineno,
                    })
                    global_symbols_by_name.setdefault(member.name, []).append(m_id)

                    # Also discover self.<attr> = ... in __init__ as Property declarations
                    if member.name == "__init__":
                        for sub in ast.walk(member):
                            if isinstance(sub, ast.Attribute) and isinstance(sub.ctx, ast.Store):
                                if isinstance(sub.value, ast.Name) and sub.value.id == "self":
                                    prop_name = sub.attr
                                    if prop_name not in seen_props:
                                        seen_props.add(prop_name)
                                        prop_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{item.name}#{prop_name}."
                                        all_nodes.append({
                                            "id": prop_id,
                                            "filePath": file_path,
                                            "kind": "Property",
                                            "name": prop_name,
                                            "qualifiedName": f"{item.name}.{prop_name}",
                                            "startLine": getattr(sub, "lineno", member.lineno),
                                            "endLine": getattr(sub, "lineno", member.lineno),
                                            "signature": f"self.{prop_name}",
                                            "docstring": f"Instance attribute {prop_name} on {item.name}",
                                            "complexity": 1,
                                            "labels": ["Property", "InstanceAttribute"],
                                        })
                                        all_edges.append({
                                            "filePath": file_path,
                                            "srcId": cls_id,
                                            "dstId": prop_id,
                                            "kind": "CONTAINS",
                                            "line": getattr(sub, "lineno", member.lineno),
                                        })
                                        global_properties_by_name.setdefault(prop_name, []).append(prop_id)

# Pass 2: Extract edges (IMPORTS, CALLS, HANDLES_ROUTE, VALIDATES_SCHEMA, READS/WRITES_PROPERTY, SQL, Templates, TESTS_SYMBOL)
def resolve_symbol_id(name, current_file, current_cls=None):
    if current_cls:
        candidate = f"scip-py uv {pkg_name} 0.1.0 {current_file}/{current_cls}#{name}()."
        if candidate in global_symbols_by_name.get(name, []):
            return candidate
    candidates = global_symbols_by_name.get(name, [])
    if not candidates:
        return f"scip-py uv {pkg_name} 0.1.0 {current_file}/{name}()."
    for c in candidates:
        if f" {current_file}/" in c:
            return c
    return candidates[0]

def resolve_property_id(attr_name, current_file, current_cls=None):
    if current_cls:
        local_prop = f"scip-py uv {pkg_name} 0.1.0 {current_file}/{current_cls}#{attr_name}."
        if local_prop in global_properties_by_name.get(attr_name, []):
            return local_prop
    candidates = global_properties_by_name.get(attr_name, [])
    if candidates:
        return candidates[0]
    if current_cls:
        return f"scip-py uv {pkg_name} 0.1.0 {current_file}/{current_cls}#{attr_name}."
    return None

def analyze_callable_body(fn_node, fn_id, file_path, current_cls, is_test_case, router_prefixes):
    # 1. Inspect decorators for FastAPI/Flask routes and MCP tools
    http_methods = {"get", "post", "put", "delete", "patch", "options", "head", "route", "websocket"}
    for dec in fn_node.decorator_list:
        dec_name, dec_args, dec_kwargs = get_decorator_info(dec)
        parts = dec_name.split(".")
        last_part = parts[-1].lower() if parts else ""
        first_part = parts[0] if parts else ""

        # FastAPI / Flask route decorator
        if len(parts) >= 2 and last_part in http_methods:
            route_subpath = dec_args[0] if dec_args else f"/{fn_node.name}"
            prefix = router_prefixes.get(first_part, "")
            full_route = f"{prefix}{route_subpath}" if not route_subpath.startswith(prefix) or not prefix else route_subpath
            if not full_route.startswith("/"):
                full_route = "/" + full_route
            method_upper = "WS" if last_part == "websocket" else ("GET" if last_part == "route" else last_part.upper())
            route_id = f"scip-endpoint http {method_upper}:{full_route}#"
            all_nodes.append({
                "id": route_id,
                "filePath": file_path,
                "kind": "RouteEndpoint",
                "name": f"{method_upper} {full_route}",
                "qualifiedName": f"{pkg_name} {method_upper} {full_route}",
                "startLine": fn_node.lineno,
                "endLine": getattr(fn_node, "end_lineno", fn_node.lineno),
                "signature": f"@{dec_name}('{full_route}')",
                "docstring": f"FastAPI/HTTP {method_upper} route {full_route} handled by {fn_node.name}",
                "complexity": 1,
                "labels": ["RouteEndpoint", "HttpEndpoint", "FastAPIRoute"],
            })
            all_edges.append({
                "filePath": file_path,
                "srcId": fn_id,
                "dstId": route_id,
                "kind": "HANDLES_ROUTE",
                "line": fn_node.lineno,
            })
            resp_model = dec_kwargs.get("response_model")
            if resp_model and resp_model in global_classes_by_name:
                all_edges.append({
                    "filePath": file_path,
                    "srcId": fn_id,
                    "dstId": global_classes_by_name[resp_model],
                    "kind": "EMITS_SCHEMA",
                    "line": fn_node.lineno,
                })

        # MCP Tool decorator (@server.tool, @mcp.tool)
        elif last_part == "tool" or dec_name in ("tool", "mcp.tool", "server.tool"):
            tool_name = dec_args[0] if dec_args else fn_node.name
            tool_id = f"scip-endpoint mcp {pkg_name} 0.1.0 {tool_name}#"
            all_nodes.append({
                "id": tool_id,
                "filePath": file_path,
                "kind": "RouteEndpoint",
                "name": tool_name,
                "qualifiedName": f"mcp/{tool_name}",
                "startLine": fn_node.lineno,
                "endLine": getattr(fn_node, "end_lineno", fn_node.lineno),
                "signature": f"@{dec_name}() def {fn_node.name}",
                "docstring": f"MCP tool {tool_name} in {file_path}",
                "complexity": 1,
                "labels": ["RouteEndpoint", "McpTool"],
            })
            all_edges.append({
                "filePath": file_path,
                "srcId": fn_id,
                "dstId": tool_id,
                "kind": "HANDLES_ROUTE",
                "line": fn_node.lineno,
            })

    # 2. Check parameter type annotations for Pydantic schema validation
    for arg in fn_node.args.args:
        if arg.annotation:
            ann_name = None
            if isinstance(arg.annotation, ast.Name):
                ann_name = arg.annotation.id
            elif isinstance(arg.annotation, ast.Attribute):
                ann_name = arg.annotation.attr
            if ann_name and ann_name in global_classes_by_name:
                target_cls_id = global_classes_by_name[ann_name]
                all_edges.append({
                    "filePath": file_path,
                    "srcId": fn_id,
                    "dstId": target_cls_id,
                    "kind": "VALIDATES_SCHEMA",
                    "line": fn_node.lineno,
                })

    # Collect call func nodes so we don't double-count method calls as READS_PROPERTY
    call_func_ids = set()
    for sub in ast.walk(fn_node):
        if isinstance(sub, ast.Call):
            call_func_ids.add(id(sub.func))

    for sub in ast.walk(fn_node):
        line_no = getattr(sub, "lineno", fn_node.lineno)

        # Function / Method / Schema calls
        if isinstance(sub, ast.Call):
            callee_name = None
            if isinstance(sub.func, ast.Name):
                callee_name = sub.func.id
            elif isinstance(sub.func, ast.Attribute):
                callee_name = sub.func.attr

            if callee_name:
                # TemplateResponse("index.html", ...) or render_template("index.html")
                if callee_name in ("TemplateResponse", "render_template"):
                    for a in sub.args:
                        if isinstance(a, ast.Constant) and isinstance(a.value, str) and a.value.endswith(".html"):
                            tpl_id = f"scip-html template {pkg_name} 0.1.0 {a.value}/"
                            all_edges.append({
                                "filePath": file_path,
                                "srcId": fn_id,
                                "dstId": tpl_id,
                                "kind": "REFERENCES",
                                "line": line_no,
                            })
                    for kw in sub.keywords:
                        if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str) and kw.value.value.endswith(".html"):
                            tpl_id = f"scip-html template {pkg_name} 0.1.0 {kw.value.value}/"
                            all_edges.append({
                                "filePath": file_path,
                                "srcId": fn_id,
                                "dstId": tpl_id,
                                "kind": "REFERENCES",
                                "line": line_no,
                            })

                # FastAPI TestClient / httpx calls inside tests: client.get('/api/...'), client.post('/api/...')
                if callee_name in ("get", "post", "put", "delete", "patch") and sub.args:
                    first_arg = sub.args[0]
                    if isinstance(first_arg, ast.Constant) and isinstance(first_arg.value, str) and first_arg.value.startswith("/"):
                        route_path = first_arg.value.split("?")[0]
                        route_id = f"scip-endpoint http {callee_name.upper()}:{route_path}#"
                        all_edges.append({
                            "filePath": file_path,
                            "srcId": fn_id,
                            "dstId": route_id,
                            "kind": "TESTS_SYMBOL" if is_test_case else "CALLS_ROUTE",
                            "line": line_no,
                        })

                target_id = resolve_symbol_id(callee_name, file_path, current_cls)
                all_edges.append({
                    "filePath": file_path,
                    "srcId": fn_id,
                    "dstId": target_id,
                    "kind": "CALLS",
                    "line": line_no,
                })
                if is_test_case:
                    all_edges.append({
                        "filePath": file_path,
                        "srcId": fn_id,
                        "dstId": target_id,
                        "kind": "TESTS_SYMBOL",
                        "line": line_no,
                    })

        # Property reads & writes: obj.attr
        elif isinstance(sub, ast.Attribute) and id(sub) not in call_func_ids:
            prop_id = resolve_property_id(sub.attr, file_path, current_cls)
            if prop_id:
                edge_kind = "WRITES_PROPERTY" if isinstance(sub.ctx, ast.Store) else "READS_PROPERTY"
                all_edges.append({
                    "filePath": file_path,
                    "srcId": fn_id,
                    "dstId": prop_id,
                    "kind": edge_kind,
                    "line": line_no,
                })
                if is_test_case:
                    all_edges.append({
                        "filePath": file_path,
                        "srcId": fn_id,
                        "dstId": prop_id,
                        "kind": "TESTS_SYMBOL",
                        "line": line_no,
                    })

        # Embedded SQL string literals referencing DDL tables
        elif isinstance(sub, ast.Constant) and isinstance(sub.value, str) and len(sub.value) > 12:
            val_upper = sub.value.upper()
            if "SELECT " in val_upper or "INSERT " in val_upper or "UPDATE " in val_upper or "CREATE TABLE" in val_upper:
                for m in SQL_TABLE_RE.finditer(sub.value):
                    tbl = m.group(1)
                    if tbl.lower() not in SQL_KEYWORDS and len(tbl) > 2:
                        sql_id = f"scip-sql ddl sql 1.0.0 table:{tbl}#"
                        all_edges.append({
                            "filePath": file_path,
                            "srcId": fn_id,
                            "dstId": sql_id,
                            "kind": "REFERENCES",
                            "line": line_no,
                        })

for file_path, source, tree in parsed_trees:
    file_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/"
    test_file = is_test_file(file_path)
    router_prefixes = {}
    for item in tree.body:
        if isinstance(item, ast.Assign) and isinstance(item.value, ast.Call):
            func_name, _, kwargs = get_decorator_info(item.value)
            if func_name.endswith("APIRouter") or func_name.endswith("Blueprint"):
                prefix = kwargs.get("prefix", "")
                for t in item.targets:
                    if isinstance(t, ast.Name):
                        router_prefixes[t.id] = prefix

        if isinstance(item, ast.Import):
            for alias in item.names:
                mod_id = f"scip-py uv {alias.name} 0.1.0 module/"
                all_edges.append({"filePath": file_path, "srcId": file_id, "dstId": mod_id, "kind": "IMPORTS", "line": item.lineno})
        elif isinstance(item, ast.ImportFrom):
            mod_name = item.module or "relative"
            mod_id = f"scip-py uv {mod_name} 0.1.0 module/"
            all_edges.append({"filePath": file_path, "srcId": file_id, "dstId": mod_id, "kind": "IMPORTS", "line": item.lineno})
            for alias in item.names:
                if alias.name in global_symbols_by_name:
                    for target_sym_id in global_symbols_by_name[alias.name]:
                        all_edges.append({
                            "filePath": file_path,
                            "srcId": file_id,
                            "dstId": target_sym_id,
                            "kind": "TESTS_FILE" if test_file else "REFERENCES",
                            "line": item.lineno,
                        })
        elif isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            fn_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{item.name}()."
            is_tc = test_file and item.name.startswith("test_")
            analyze_callable_body(item, fn_id, file_path, None, is_tc, router_prefixes)
        elif isinstance(item, ast.ClassDef):
            for member in item.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    m_id = f"scip-py uv {pkg_name} 0.1.0 {file_path}/{item.name}#{member.name}()."
                    is_tc = test_file and member.name.startswith("test_")
                    analyze_callable_body(member, m_id, file_path, item.name, is_tc, router_prefixes)

print(json.dumps({
    "nodes": all_nodes,
    "edges": all_edges,
    "diagnostics": all_diagnostics,
}))
`;
export function extractPythonBatch(filesInput, packageName = 'python-pkg') {
    const files = [];
    const nodesMap = new Map();
    const edgesMap = new Map();
    if (filesInput.length === 0) {
        return { compiler: 'python', files: [], nodes: [], edges: [], diagnostics: [] };
    }
    const pkgId = `scip-py uv ${packageName} 0.1.0 package#`;
    nodesMap.set(pkgId, {
        id: pkgId,
        kind: 'WorkspacePackage',
        name: packageName,
        qualifiedName: packageName,
        packageName,
        filePath: filesInput[0].filePath,
        language: 'python',
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 1,
        signature: `python package ${packageName}`,
        docstring: `Python workspace package ${packageName}`,
        exported: true,
        complexity: 1,
        labels: ['WorkspacePackage', 'PythonPackage'],
        properties: {},
    });
    for (const f of filesInput) {
        const sha256 = crypto.createHash('sha256').update(f.content).digest('hex');
        const lines = f.content.split('\n');
        const fileId = `scip-py uv ${packageName} 0.1.0 ${f.filePath}/`;
        files.push({
            filePath: f.filePath,
            packageName,
            language: 'python',
            sha256,
            mtimeMs: f.mtimeMs,
            sizeBytes: Buffer.byteLength(f.content, 'utf8'),
            lineCount: lines.length,
        });
        nodesMap.set(fileId, {
            id: fileId,
            kind: 'File',
            name: path.basename(f.filePath),
            qualifiedName: f.filePath,
            packageName,
            filePath: f.filePath,
            language: 'python',
            startLine: 1,
            startCol: 1,
            endLine: lines.length,
            endCol: 1,
            signature: `python module ${f.filePath}`,
            docstring: `Python source module ${f.filePath}`,
            exported: true,
            complexity: 1,
            labels: ['File', 'PythonModule'],
            properties: {},
        });
        edgesMap.set(`${pkgId}|${fileId}|CONTAINS|${f.filePath}|1`, {
            srcId: pkgId,
            dstId: fileId,
            kind: 'CONTAINS',
            filePath: f.filePath,
            line: 1,
            col: 1,
            weight: 1,
            properties: {},
        });
    }
    const proc = spawnSync('python3', ['-c', PYTHON_AST_EXTRACTOR_SCRIPT], {
        input: JSON.stringify({
            packageName,
            files: filesInput.map((f) => ({ filePath: f.filePath, content: f.content })),
        }),
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 32 * 1024 * 1024,
    });
    if (proc.status === 0 && proc.stdout) {
        const parsed = JSON.parse(proc.stdout);
        for (const n of parsed.nodes) {
            nodesMap.set(n.id, {
                id: n.id,
                kind: n.kind,
                name: n.name,
                qualifiedName: n.qualifiedName,
                packageName,
                filePath: n.filePath,
                language: 'python',
                startLine: n.startLine,
                startCol: 1,
                endLine: n.endLine,
                endCol: 1,
                signature: n.signature,
                docstring: n.docstring,
                exported: !n.name.startsWith('_'),
                complexity: n.complexity,
                labels: n.labels ?? [n.kind, 'Python'],
                properties: {},
            });
        }
        for (const e of parsed.edges) {
            if (!e.srcId || !e.dstId || e.srcId === e.dstId)
                continue;
            const key = `${e.srcId}|${e.dstId}|${e.kind}|${e.filePath}|${e.line}`;
            edgesMap.set(key, {
                srcId: e.srcId,
                dstId: e.dstId,
                kind: e.kind,
                filePath: e.filePath,
                line: e.line,
                col: 1,
                weight: 1,
                properties: {},
            });
        }
        return {
            compiler: 'python',
            files,
            nodes: [...nodesMap.values()],
            edges: [...edgesMap.values()],
            diagnostics: parsed.diagnostics.map((d) => ({
                filePath: d.filePath,
                enclosingSymbolId: `scip-py uv ${packageName} 0.1.0 ${d.filePath}/`,
                compiler: 'python',
                severity: 'error',
                code: d.code,
                message: d.message,
                line: d.line,
                col: d.col,
            })),
        };
    }
    return {
        compiler: 'python',
        files,
        nodes: [...nodesMap.values()],
        edges: [...edgesMap.values()],
        diagnostics: [],
    };
}
export function extractPythonSource(filePath, content, packageName = 'python-pkg') {
    return extractPythonBatch([{ filePath, content, mtimeMs: Date.now() }], packageName);
}
export class PythonCompilerAdapter {
    name = 'python';
    languages = ['python', 'html'];
    supportsFile(filePath) {
        const norm = filePath.replace(/\\/g, '/');
        if (norm.includes('node_modules') ||
            norm.includes('.venv') ||
            norm.includes('venv/') ||
            norm.includes('__pycache__') ||
            norm.includes('.ast-graph') ||
            norm.includes('/site/') ||
            norm.startsWith('site/')) {
            return false;
        }
        return norm.endsWith('.py') || (norm.endsWith('.html') && norm.includes('template'));
    }
    discoverPythonFiles(workspaceRoot) {
        const results = [];
        const skipDirs = new Set([
            'node_modules',
            'dist',
            'build',
            'site',
            '.git',
            '.venv',
            'venv',
            '__pycache__',
            '.pytest_cache',
            '.ruff_cache',
            '.mypy_cache',
            '.ast-graph',
            'out',
            '.terraform',
        ]);
        const walk = (dir) => {
            if (!fs.existsSync(dir))
                return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (skipDirs.has(entry.name)) {
                    continue;
                }
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
    detectPackageName(workspaceRoot) {
        const pyproject = path.join(workspaceRoot, 'pyproject.toml');
        if (fs.existsSync(pyproject)) {
            try {
                const raw = fs.readFileSync(pyproject, 'utf8');
                const m = raw.match(/^\s*name\s*=\s*"([^"]+)"/m);
                if (m?.[1])
                    return m[1];
            }
            catch {
                // ignore
            }
        }
        return path.basename(workspaceRoot);
    }
    extract(workspaceRoot, targetFiles) {
        const resolvedRoot = path.resolve(workspaceRoot);
        const packageName = this.detectPackageName(resolvedRoot);
        const allFiles = this.discoverPythonFiles(resolvedRoot);
        const targetRelSet = targetFiles
            ? new Set(targetFiles.map((f) => path.isAbsolute(f)
                ? path.relative(resolvedRoot, f).split(path.sep).join('/')
                : f.replace(/^\.\//, '').split(path.sep).join('/')))
            : null;
        const pyInputs = [];
        const templateFiles = [];
        const templateNodes = [];
        for (const absPath of allFiles) {
            const relPath = path.relative(resolvedRoot, absPath).split(path.sep).join('/');
            if (targetRelSet && !targetRelSet.has(relPath))
                continue;
            if (!fs.existsSync(absPath))
                continue;
            const stat = fs.statSync(absPath);
            const content = fs.readFileSync(absPath, 'utf8');
            if (relPath.endsWith('.html')) {
                const sha256 = crypto.createHash('sha256').update(content).digest('hex');
                const lines = content.split('\n');
                const baseName = path.basename(relPath);
                const tplId = `scip-html template ${packageName} 0.1.0 ${baseName}/`;
                templateFiles.push({
                    filePath: relPath,
                    packageName,
                    language: 'html',
                    sha256,
                    mtimeMs: stat.mtimeMs,
                    sizeBytes: stat.size,
                    lineCount: lines.length,
                });
                templateNodes.push({
                    id: tplId,
                    kind: 'File',
                    name: baseName,
                    qualifiedName: relPath,
                    packageName,
                    filePath: relPath,
                    language: 'html',
                    startLine: 1,
                    startCol: 1,
                    endLine: lines.length,
                    endCol: 1,
                    signature: `jinja2 template ${relPath}`,
                    docstring: `HTML/Jinja2 template ${relPath}`,
                    exported: true,
                    complexity: 1,
                    labels: ['File', 'HtmlTemplate'],
                    properties: {},
                });
            }
            else if (relPath.endsWith('.py')) {
                pyInputs.push({ filePath: relPath, content, mtimeMs: stat.mtimeMs });
            }
        }
        const batch = extractPythonBatch(pyInputs, packageName);
        batch.files.push(...templateFiles);
        batch.nodes.push(...templateNodes);
        return batch;
    }
}
//# sourceMappingURL=python-adapter.js.map