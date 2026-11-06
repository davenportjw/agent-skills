"""MCP App Server (`ui://` Resource + `_meta.ui.resourceUri` Tools).

Demonstrates an MCP Server following the MCP Apps (SEP-1865 / MCP-UI) pattern:
1. Serves an interactive HTML/JS micro-application at `ui://canary-studio/rollout-widget.html`.
2. Inside the HTML bundle, user interactions emit JSON-RPC 2.0 requests via
   `window.parent.postMessage` (`method: "tools/call"` and `method: "ui/message"`).
3. Exposes `inspect_canary` (which attaches `_meta.ui.resourceUri`) and
   `update_canary_split` (which executes when the iframe calls `tools/call`).
"""

from __future__ import annotations

from typing import Any
try:
    from mcp.server.mcpserver import MCPServer
except ImportError:
    from mcp.server.fastmcp import FastMCP as MCPServer  # type: ignore[no-redef]

mcp = MCPServer("CanaryRolloutMcpApp")

UI_RESOURCE_URI = "ui://canary-studio/rollout-widget.html"

# In-memory service state managed by the MCP Server
_CANARY_STATE: dict[str, dict[str, Any]] = {
    "checkout-api": {
        "service": "checkout-api",
        "weight_percent": 15,
        "error_rate": 0.02,
        "p99_ms": 48,
        "status": "CANARY_HEALTHY",
    }
}


@mcp.resource(UI_RESOURCE_URI, mime_type="text/html")
def get_rollout_widget_html() -> str:
    """Returns the sandboxed MCP App HTML/JS bundle with JSON-RPC postMessage bridge."""
    return """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Canary Rollout MCP App</title>
</head>
<body>
  <div id="mcp-app-root">
    <h3 id="svc-title">Service: checkout-api</h3>
    <input id="weight-slider" type="range" min="0" max="100" value="15" />
    <button id="btn-call-tool" onclick="callMcpTool(50)">
      Promote via MCP tools/call (50%)
    </button>
    <button id="btn-Ask-model" onclick="sendChatFollowup('Verify p99 latency after 50% split')">
      Send ui/message to AGY Model
    </button>
  </div>
  <script>
    let rpcId = 1;

    // 1. Direct MCP Tool Execution from Iframe -> Host -> MCP Server (JSON-RPC 2.0)
    function callMcpTool(weightPercent) {
      window.parent.postMessage({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: {
          name: "update_canary_split",
          arguments: {
            service: "checkout-api",
            weight_percent: weightPercent
          }
        }
      }, "*");
    }

    // 2. Prompt / Intent Injection from Iframe -> Host -> AGY `agent.chat(...)`
    function sendChatFollowup(promptText) {
      window.parent.postMessage({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "ui/message",
        params: {
          role: "user",
          content: { type: "text", text: promptText }
        }
      }, "*");
    }
  </script>
</body>
</html>"""


@mcp.tool()
def inspect_canary(service: str) -> dict[str, Any]:
    """Inspects current canary metrics and attaches the `ui://` MCP App resource URI.

    Args:
        service: Name of the service to inspect (e.g. 'checkout-api').
    """
    state = _CANARY_STATE.get(
        service,
        {
            "service": service,
            "weight_percent": 10,
            "error_rate": 0.01,
            "p99_ms": 42,
            "status": "STAGED",
        },
    )
    return {
        "content": [
            {
                "type": "text",
                "text": f"Service {service} is at {state['weight_percent']}% canary traffic.",
            }
        ],
        "structuredContent": state,
        "_meta": {
            "ui": {
                "resourceUri": UI_RESOURCE_URI,
            }
        },
    }


@mcp.tool()
def update_canary_split(service: str, weight_percent: int) -> dict[str, Any]:
    """Updates the canary traffic weight for a service (called by the agent OR the MCP App UI).

    Args:
        service: Target service identifier.
        weight_percent: New canary percentage between 0 and 100.
    """
    if not (0 <= weight_percent <= 100):
        raise ValueError("weight_percent must be between 0 and 100")

    current = _CANARY_STATE.setdefault(
        service,
        {"service": service, "error_rate": 0.02, "p99_ms": 48},
    )
    current["weight_percent"] = weight_percent
    current["status"] = "PROMOTED_100" if weight_percent == 100 else "CANARY_UPDATED"
    return {
        "service": service,
        "weight_percent": weight_percent,
        "status": current["status"],
    }


if __name__ == "__main__":
    mcp.run()
