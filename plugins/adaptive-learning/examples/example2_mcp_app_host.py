"""Example 2: Google Antigravity (AGY) SDK + MCP Apps (`ui://` + JSON-RPC postMessage Bridge).

Demonstrates how an Antigravity Agent connects to an MCP App server (`mcp_ui_server.py`):
1. Configures `types.McpStdioServer` on `LocalAgentConfig` (using Vertex AI ADC).
2. When the agent invokes `inspect_canary`, the tool result includes
   `_meta.ui.resourceUri = "ui://canary-studio/rollout-widget.html"`.
3. The Host Bridge resolves the `ui://` HTML bundle from the MCP server and mounts
   it inside a sandboxed `<iframe>`.
4. When the user clicks a button inside the iframe, the iframe emits a JSON-RPC 2.0
   message via `window.parent.postMessage`:
   - `method: "tools/call"` -> Host routes the tool execution directly to the MCP server
     and posts the JSON-RPC result back into the iframe (`iframe.contentWindow.postMessage`).
   - `method: "ui/message"` -> Host injects the user's message directly into the next
     Antigravity `await agent.chat(...)` turn.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import mcp_ui_server

try:
    from google.antigravity import Agent, LocalAgentConfig, types
    from google.antigravity.hooks import hooks, policy
except ImportError:  # pragma: no cover - fallback when running unit tests without binary wheel
    Agent = None  # type: ignore[assignment]
    LocalAgentConfig = None  # type: ignore[assignment]
    types = None  # type: ignore[assignment]
    hooks = None  # type: ignore[assignment]
    policy = None  # type: ignore[assignment]


class McpAppHostBridge:
    """Bridges an MCP App `ui://` iframe's `postMessage` JSON-RPC channel with AGY & MCP."""

    def __init__(self) -> None:
        self.mounted_resource_uri: str | None = None
        self.mounted_html: str | None = None
        self.initial_tool_data: dict[str, Any] | None = None
        self.iframe_inbox: list[dict[str, Any]] = []
        self.agent_chat_queue: list[str] = []

        # Registry mapping MCP tool names to callable handlers
        self._mcp_tools: dict[str, Callable[..., Any]] = {
            "inspect_canary": mcp_ui_server.inspect_canary,
            "update_canary_split": mcp_ui_server.update_canary_split,
        }
        # Registry mapping `ui://` URIs to resource loaders
        self._mcp_resources: dict[str, Callable[[], str]] = {
            mcp_ui_server.UI_RESOURCE_URI: mcp_ui_server.get_rollout_widget_html,
        }

    def on_mcp_tool_result(self, tool_result: dict[str, Any]) -> bool:
        """Inspects an MCP tool response for `_meta.ui.resourceUri` and mounts the `ui://` HTML."""
        ui_meta = tool_result.get("_meta", {}).get("ui", {})
        resource_uri = ui_meta.get("resourceUri")
        if not resource_uri:
            return False

        loader = self._mcp_resources.get(resource_uri)
        if loader is None:
            raise KeyError(f"Unknown MCP UI resource URI: {resource_uri}")

        self.mounted_resource_uri = resource_uri
        self.mounted_html = loader()
        self.initial_tool_data = tool_result.get("structuredContent", {})

        # Push initial tool result notification into the iframe (SEP-1865 lifecycle)
        self.iframe_inbox.append(
            {
                "jsonrpc": "2.0",
                "method": "ui/notifications/tool-result",
                "params": {
                    "resourceUri": resource_uri,
                    "structuredContent": self.initial_tool_data,
                },
            }
        )
        return True

    async def handle_iframe_post_message(
        self,
        rpc_payload: dict[str, Any],
        agent_chat_fn: Callable[[str], Any] | None = None,
    ) -> dict[str, Any]:
        """Handles a JSON-RPC 2.0 `window.parent.postMessage` callback from the `ui://` iframe."""
        rpc_id = rpc_payload.get("id")
        method = rpc_payload.get("method")
        params = rpc_payload.get("params", {})

        # Case 1: Iframe triggers an MCP tool directly (`method: "tools/call"`)
        if method == "tools/call":
            tool_name = params.get("name")
            tool_args = params.get("arguments", {})
            handler = self._mcp_tools.get(tool_name)
            if handler is None:
                err_resp = {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "error": {"code": -32601, "message": f"Tool not found: {tool_name}"},
                }
                self.iframe_inbox.append(err_resp)
                return err_resp

            result = handler(**tool_args)
            ok_resp = {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": result,
            }
            self.iframe_inbox.append(ok_resp)
            return ok_resp

        # Case 2: Iframe injects a message/intent into the AGY Agent (`method: "ui/message"`)
        if method == "ui/message":
            content = params.get("content", {})
            text_prompt = content.get("text", "")
            self.agent_chat_queue.append(text_prompt)

            agent_reply = None
            if agent_chat_fn is not None:
                agent_reply = await agent_chat_fn(text_prompt)

            ack_resp = {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {"delivered": True, "agentReply": agent_reply},
            }
            self.iframe_inbox.append(ack_resp)
            return ack_resp

        raise ValueError(f"Unsupported MCP App JSON-RPC method: {method}")


def build_mcp_app_agent_config() -> Any:
    """Creates an Antigravity `LocalAgentConfig` wired to `mcp_ui_server.py` over Stdio."""
    if LocalAgentConfig is None or types is None:
        raise RuntimeError("google-antigravity SDK package is required to spawn live Agent.")

    server_script = str(Path(__file__).with_name("mcp_ui_server.py").resolve())
    canary_mcp_server = types.McpStdioServer(
        name="canary_rollout_app",
        command="python3",
        args=[server_script],
        enabled_tools=["inspect_canary", "update_canary_split"],
    )

    policies = [
        policy.allow(canary_mcp_server),
    ]

    return LocalAgentConfig(
        vertex=True,
        project="davenport-boutique",
        location="us",
        model="gemini-3.8-flash",
        mcp_servers=[canary_mcp_server],
        policies=policies,
        system_instructions=(
            "You are a Release Engineering assistant connected to the `canary_rollout_app` "
            "MCP server. Use `inspect_canary` to load the rollout status and its attached "
            "`ui://` MCP App widget, and respond to follow-up UI callbacks."
        ),
    )


async def run_live_mcp_app_session() -> None:
    """Demonstrates the full AGY + MCP App (`ui://` + postMessage callback) lifecycle."""
    config = build_mcp_app_agent_config()
    host_bridge = McpAppHostBridge()

    async with Agent(config) as agent:
        # Step 1: User asks AGY agent to inspect the canary rollout
        response = await agent.chat("Inspect the canary rollout for 'checkout-api'.")
        async for call in response.tool_calls:
            print(f"[AGY Tool Call] {call.name}({call.args})")

        # Host receives the MCP tool output containing `_meta.ui.resourceUri`
        tool_output = mcp_ui_server.inspect_canary("checkout-api")
        host_bridge.on_mcp_tool_result(tool_output)
        print(f"[Host Mounted Iframe] {host_bridge.mounted_resource_uri}")

        # Step 2: User clicks "Promote via MCP tools/call (50%)" inside the `ui://` iframe
        await host_bridge.handle_iframe_post_message(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "update_canary_split",
                    "arguments": {"service": "checkout-api", "weight_percent": 50},
                },
            }
        )

        # Step 3: User clicks "Send ui/message to AGY Model" inside the `ui://` iframe
        async def forward_to_agent(prompt_text: str) -> str:
            followup = await agent.chat(f"[MCP App Callback] {prompt_text}")
            return await followup.text()

        await host_bridge.handle_iframe_post_message(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "ui/message",
                "params": {
                    "role": "user",
                    "content": {
                        "type": "text",
                        "text": "Canary is now at 50%; confirm rollout status for checkout-api.",
                    },
                },
            },
            agent_chat_fn=forward_to_agent,
        )
