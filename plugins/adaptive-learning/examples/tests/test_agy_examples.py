"""Unit tests for Example 1 (AGY + A2UI) and Example 2 (AGY + MCP Apps)."""

from __future__ import annotations

import json
import pytest

import example1_a2ui_rollout as ex1
import example2_mcp_app_host as ex2
import eval_harness_teardown as eval_harness
import mcp_ui_server


def test_example1_a2ui_full_lifecycle() -> None:
    """Verifies AGY -> A2UI JSONL stream -> Slider Mutation -> userAction -> ToolContext update."""
    # 1. Construct Turn 1 structured output from the AGY Agent
    turn1 = ex1.A2UITurnResponse(
        surface_id="canary-rollout",
        root_component_id="rollout-card",
        include_component_tree=True,
        components=[
            ex1.A2UIComponentNode(
                id="rollout-card",
                component="Card",
                children=["hdr-text", "canary-slider", "promote-btn"],
            ),
            ex1.A2UIComponentNode(
                id="hdr-text",
                component="Text",
                text=ex1.JsonPointerBinding(path="/title"),
            ),
            ex1.A2UIComponentNode(
                id="canary-slider",
                component="Slider",
                min_val=0,
                max_val=100,
                value=ex1.JsonPointerBinding(path="/canaryPercent"),
            ),
            ex1.A2UIComponentNode(
                id="promote-btn",
                component="Button",
                label="Promote Canary",
                action=ex1.A2UIActionSpec(
                    name="promote_canary",
                    context=[
                        ex1.A2UIActionContextEntry(
                            key="service",
                            value=ex1.JsonPointerBinding(path="/service"),
                        ),
                        ex1.A2UIActionContextEntry(
                            key="canaryPercent",
                            value=ex1.JsonPointerBinding(path="/canaryPercent"),
                        ),
                    ],
                ),
            ),
        ],
        data_model=ex1.CanaryDataModel(
            title="Checkout API Rollout",
            service="checkout-api",
            canaryPercent=10,
            status="STAGED",
        ),
        agent_narration="Initialized A2UI canary rollout surface at 10%.",
    )

    jsonl_packets = ex1.to_a2ui_jsonl_stream(turn1)
    assert len(jsonl_packets) == 3
    assert "createSurface" in json.loads(jsonl_packets[0])
    assert "updateComponents" in json.loads(jsonl_packets[1])
    assert "updateDataModel" in json.loads(jsonl_packets[2])

    # 2. Client surface hydrates the JSONL packets
    surface = ex1.A2UIClientSurface()
    surface.ingest_jsonl(jsonl_packets)
    assert surface.surface_id == "canary-rollout"
    assert surface.data_model["canaryPercent"] == 10

    # 3. User drags the A2UI slider to 50% and clicks 'promote-btn'
    surface.set_bound_value("/canaryPercent", 50)
    action_payload = surface.dispatch_user_action("promote-btn")
    assert action_payload == {
        "userAction": {
            "name": "promote_canary",
            "surfaceId": "canary-rollout",
            "sourceComponentId": "promote-btn",
            "context": {
                "service": "checkout-api",
                "canaryPercent": 50,
            },
        }
    }

    # 4. AGY Agent receives `userAction`, invokes `apply_canary_traffic` with ToolContext
    ctx = ex1.ToolContext()
    ua_ctx = action_payload["userAction"]["context"]
    tool_out_raw = ex1.apply_canary_traffic(
        service_name=ua_ctx["service"],
        canary_percent=ua_ctx["canaryPercent"],
        ctx=ctx,
    )
    tool_out = json.loads(tool_out_raw)
    assert tool_out["canaryPercent"] == 50
    assert tool_out["status"] == "CANARY_ACTIVE"

    # 5. Turn 2 emits only an incremental `updateDataModel` packet (`include_component_tree=False`)
    turn2 = ex1.A2UITurnResponse(
        surface_id="canary-rollout",
        include_component_tree=False,
        data_model_path="/",
        data_model=ex1.CanaryDataModel(
            title="Checkout API Rollout",
            service="checkout-api",
            canaryPercent=tool_out["canaryPercent"],
            status=tool_out["status"],
        ),
        agent_narration="Promoted checkout-api canary to 50%.",
    )
    jsonl_t2 = ex1.to_a2ui_jsonl_stream(turn2)
    assert len(jsonl_t2) == 1
    surface.ingest_jsonl(jsonl_t2)
    assert surface.data_model["status"] == "CANARY_ACTIVE"
    assert surface.data_model["canaryPercent"] == 50


@pytest.mark.asyncio
async def test_example2_mcp_app_ui_resource_and_postmessage_bridge() -> None:
    """Verifies AGY + MCP App `ui://` resource mounting and JSON-RPC postMessage callbacks."""
    bridge = ex2.McpAppHostBridge()

    # 1. MCP tool `inspect_canary` returns `_meta.ui.resourceUri`
    tool_result = mcp_ui_server.inspect_canary("checkout-api")
    mounted = bridge.on_mcp_tool_result(tool_result)
    assert mounted is True
    assert bridge.mounted_resource_uri == "ui://canary-studio/rollout-widget.html"
    assert bridge.mounted_html is not None
    assert "window.parent.postMessage" in bridge.mounted_html
    assert bridge.iframe_inbox[0]["method"] == "ui/notifications/tool-result"

    # 2. User clicks button in `ui://` iframe -> emits `method: "tools/call"` via postMessage
    rpc_tool_resp = await bridge.handle_iframe_post_message(
        {
            "jsonrpc": "2.0",
            "id": 101,
            "method": "tools/call",
            "params": {
                "name": "update_canary_split",
                "arguments": {"service": "checkout-api", "weight_percent": 75},
            },
        }
    )
    assert rpc_tool_resp["id"] == 101
    assert rpc_tool_resp["result"]["weight_percent"] == 75
    assert rpc_tool_resp["result"]["status"] == "CANARY_UPDATED"

    # 3. User clicks follow-up button in `ui://` iframe -> emits `method: "ui/message"` to AGY Agent
    received_prompts: list[str] = []

    async def fake_agy_chat(prompt: str) -> str:
        received_prompts.append(prompt)
        return f"Confirmed: {prompt}"

    rpc_msg_resp = await bridge.handle_iframe_post_message(
        {
            "jsonrpc": "2.0",
            "id": 102,
            "method": "ui/message",
            "params": {
                "role": "user",
                "content": {
                    "type": "text",
                    "text": "Verify checkout-api error rate at 75% traffic",
                },
            },
        },
        agent_chat_fn=fake_agy_chat,
    )
    assert rpc_msg_resp["result"]["delivered"] is True
    assert received_prompts == ["Verify checkout-api error rate at 75% traffic"]


def test_gemma4_l4_eval_harness_automated_teardown() -> None:
    """Verifies that the Gemma 4 L4 eval harness enforces GCS + BigQuery teardown."""
    cfg = eval_harness.EvalRunConfig(min_instances=1, max_instances=4, run_id="l4_test")

    def sample_workload(
        c: eval_harness.EvalRunConfig, tracker: eval_harness.EphemeralResourceTracker
    ) -> dict[str, object]:
        assert len(tracker.created_gcs_prefixes) == 1
        assert len(tracker.created_bq_tables) == 1
        return {"ttft_ms": 188, "prompts_evaluated": 50000}

    result = eval_harness.run_guarded_evaluation(cfg, sample_workload)
    assert result["config"]["min_instances"] == 1
    assert result["config"]["max_instances"] == 4
    assert result["teardown"]["deleted_gcs_prefixes"] == [
        "gs://davenport-boutique-vertex-staging/eval-l4_test/"
    ]
    assert result["teardown"]["dropped_bq_tables"] == [
        "davenport-boutique.eval_scratch.l4_test"
    ]

