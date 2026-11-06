"""Example 1: Google Antigravity (AGY) SDK + A2UI (Agent-to-UI) Protocol.

Demonstrates how an Antigravity Agent drives a declarative A2UI v0.9 surface:
1. Agent uses `response_schema=A2UITurnResponse` + stateful `ToolContext` tools
   to emit A2UI JSONL messages (`createSurface`, `updateComponents`, `updateDataModel`).
2. Components are flat adjacency-list items referencing pre-approved host catalog
   types (`Card`, `Text`, `Slider`, `Button`) and JSON Pointer data bindings
   (`{"path": "/canaryTrafficPercent"}`) — zero executable HTML/JS from the LLM.
3. When the user clicks a button on the client surface, the client resolves the
   bound JSON Pointers from its local DataModel and sends a `userAction` event
   back into `await agent.chat(...)`, which executes the stateful rollout tool
   and emits an incremental `updateDataModel` delta.
"""

from __future__ import annotations

import json
from typing import Any
import pydantic

try:
    from google.antigravity import Agent, LocalAgentConfig, ToolContext
except ImportError:  # pragma: no cover - fallback type stub if binary wheel not installed in test env
    Agent = None  # type: ignore[assignment]
    LocalAgentConfig = None  # type: ignore[assignment]

    class ToolContext:  # type: ignore[no-redef]
        def __init__(self) -> None:
            self._store: dict[str, Any] = {}

        def get_state(self, key: str, default: Any = None) -> Any:
            return self._store.get(key, default)

        def set_state(self, key: str, value: Any) -> None:
            self._store[key] = value


# ---------------------------------------------------------------------------
# 1. A2UI v0.9 Declarative Wire Schemas (Enforced via AGY `response_schema`)
# ---------------------------------------------------------------------------


class JsonPointerBinding(pydantic.BaseModel):
    """Binds a component property to a reactive path in the surface DataModel."""

    path: str = pydantic.Field(description="JSON Pointer path, e.g. '/canaryPercent'")


class A2UIActionContextEntry(pydantic.BaseModel):
    """Maps a key in a `userAction` payload to a JSON Pointer path in DataModel."""

    key: str
    value: JsonPointerBinding


class A2UIActionSpec(pydantic.BaseModel):
    """Declarative callback dispatched when the user interacts with a component."""

    name: str
    context: list[A2UIActionContextEntry] = pydantic.Field(default_factory=list)


class A2UIComponentNode(pydantic.BaseModel):
    """Single node in A2UI's flat adjacency-list component tree."""

    id: str
    component: str = pydantic.Field(
        description="Host catalog type: 'Card' | 'Text' | 'Slider' | 'Button'"
    )
    children: list[str] = pydantic.Field(default_factory=list)
    text: JsonPointerBinding | str | None = None
    label: str | None = None
    min_val: int | None = None
    max_val: int | None = None
    value: JsonPointerBinding | None = None
    action: A2UIActionSpec | None = None


class CanaryDataModel(pydantic.BaseModel):
    """Typed A2UI DataModel so Gemini structured decoding populates every field."""

    title: str = pydantic.Field(description="Header title displayed in the Card")
    service: str = pydantic.Field(description="Target service name, e.g. 'checkout-api'")
    canaryPercent: int = pydantic.Field(
        description="Current canary traffic split percentage (0-100)"
    )
    status: str = pydantic.Field(
        description="Rollout state: 'STAGED' | 'CANARY_ACTIVE' | 'FULL_PROMOTED'"
    )


class A2UITurnResponse(pydantic.BaseModel):
    """Structured A2UI envelope emitted by the Antigravity Agent each turn."""

    surface_id: str
    catalog_id: str = "https://a2ui.org/catalogs/standard-v0.9"
    root_component_id: str = "rollout-card"
    include_component_tree: bool = pydantic.Field(
        description="True on initial render (emits createSurface + updateComponents); False for state-only updates."
    )
    components: list[A2UIComponentNode] = pydantic.Field(default_factory=list)
    data_model_path: str = "/"
    data_model: CanaryDataModel
    agent_narration: str


def to_a2ui_jsonl_stream(turn: A2UITurnResponse) -> list[str]:
    """Serializes an AGY `A2UITurnResponse` into standard A2UI v0.9 JSONL packets."""
    packets: list[dict[str, Any]] = []
    if turn.include_component_tree:
        packets.append(
            {
                "createSurface": {
                    "surfaceId": turn.surface_id,
                    "catalogId": turn.catalog_id,
                    "rootComponentId": turn.root_component_id,
                }
            }
        )
        packets.append(
            {
                "updateComponents": {
                    "surfaceId": turn.surface_id,
                    "components": [
                        comp.model_dump(exclude_none=True) for comp in turn.components
                    ],
                }
            }
        )
    packets.append(
        {
            "updateDataModel": {
                "surfaceId": turn.surface_id,
                "path": turn.data_model_path,
                "value": turn.data_model.model_dump(),
            }
        }
    )
    return [json.dumps(pkt) for pkt in packets]


# ---------------------------------------------------------------------------
# 2. Client-Side A2UI Surface State & `userAction` Resolver
# ---------------------------------------------------------------------------


class A2UIClientSurface:
    """Simulates a host A2UI client renderer (Lit / Angular / Flutter) hydrating JSONL."""

    def __init__(self) -> None:
        self.surface_id: str | None = None
        self.catalog_id: str | None = None
        self.root_component_id: str | None = None
        self.components: dict[str, dict[str, Any]] = {}
        self.data_model: dict[str, Any] = {}

    def ingest_jsonl(self, jsonl_lines: list[str]) -> None:
        """Processes incoming A2UI JSONL messages from the Antigravity agent."""
        for line in jsonl_lines:
            msg = json.loads(line)
            if "createSurface" in msg:
                cs = msg["createSurface"]
                self.surface_id = cs["surfaceId"]
                self.catalog_id = cs["catalogId"]
                self.root_component_id = cs["rootComponentId"]
            elif "updateComponents" in msg:
                for comp in msg["updateComponents"]["components"]:
                    self.components[comp["id"]] = comp
            elif "updateDataModel" in msg:
                dm = msg["updateDataModel"]
                if dm["path"] == "/":
                    self.data_model.update(dm["value"])
                else:
                    key = dm["path"].lstrip("/")
                    self.data_model[key] = dm["value"]

    def set_bound_value(self, pointer: str, new_value: Any) -> None:
        """Simulates a user dragging a bound A2UI Slider on the client."""
        key = pointer.lstrip("/")
        self.data_model[key] = new_value

    def dispatch_user_action(self, component_id: str) -> dict[str, Any]:
        """Resolves bound JSON Pointers and creates the `userAction` callback packet."""
        comp = self.components[component_id]
        action_spec = comp["action"]
        resolved_context: dict[str, Any] = {}
        for item in action_spec.get("context", []):
            ptr_key = item["value"]["path"].lstrip("/")
            resolved_context[item["key"]] = self.data_model.get(ptr_key)

        return {
            "userAction": {
                "name": action_spec["name"],
                "surfaceId": self.surface_id,
                "sourceComponentId": component_id,
                "context": resolved_context,
            }
        }


# ---------------------------------------------------------------------------
# 3. Stateful AGY Custom Tool (Mutates Backend State & Syncs DataModel)
# ---------------------------------------------------------------------------


def apply_canary_traffic(
    service_name: str, canary_percent: int, ctx: ToolContext
) -> str:
    """Applies a new canary traffic split and persists state in AGY ToolContext.

    Args:
        service_name: Target Cloud Run service name (e.g. 'checkout-api').
        canary_percent: Traffic percentage (0 to 100) routed to the canary revision.
        ctx: Injected Antigravity ToolContext for cross-turn state persistence.
    """
    rollouts = ctx.get_state("rollouts", {})
    status = "FULL_PROMOTED" if canary_percent == 100 else "CANARY_ACTIVE"
    rollouts[service_name] = {
        "service": service_name,
        "canaryPercent": canary_percent,
        "status": status,
    }
    ctx.set_state("rollouts", rollouts)
    return json.dumps(rollouts[service_name])


# ---------------------------------------------------------------------------
# 4. AGY Agent Factory & End-to-End A2UI Loop
# ---------------------------------------------------------------------------


def build_a2ui_agent_config() -> Any:
    """Creates the Antigravity `LocalAgentConfig` using Vertex AI ADC & Gemini 3.8 Flash."""
    if LocalAgentConfig is None:
        raise RuntimeError("google-antigravity SDK package is required to spawn live Agent.")

    return LocalAgentConfig(
        vertex=True,
        project="davenport-boutique",
        location="us",
        model="gemini-3.8-flash",
        tools=[apply_canary_traffic],
        response_schema=A2UITurnResponse,
        system_instructions=(
            "You are an SRE Rollout Controller speaking the A2UI v0.9 protocol. "
            "On the first turn, set include_component_tree=True and emit a Card "
            "('rollout-card') containing a Text header bound to '/title', a Slider "
            "('canary-slider') bound to '/canaryPercent', and a Button ('promote-btn') "
            "with action name='promote_canary' binding 'service' -> '/service' and "
            "'canaryPercent' -> '/canaryPercent'. "
            "When you receive a `[A2UI userAction]` message, call `apply_canary_traffic` "
            "and return include_component_tree=False with the updated data_model."
        ),
    )


async def run_live_a2ui_session() -> None:
    """Runs a 2-turn bidirectional A2UI session with the Google Antigravity Agent."""
    config = build_a2ui_agent_config()
    client_surface = A2UIClientSurface()

    async with Agent(config) as agent:
        # Turn 1: User asks to manage a canary rollout -> Agent streams A2UI surface
        resp1 = await agent.chat(
            "Open an interactive canary traffic controller for 'checkout-api' starting at 10%."
        )
        turn1_data = A2UITurnResponse.model_validate(await resp1.structured_output())
        jsonl_t1 = to_a2ui_jsonl_stream(turn1_data)
        client_surface.ingest_jsonl(jsonl_t1)

        # User drags the A2UI slider to 50% and clicks the Promote button
        client_surface.set_bound_value("/canaryPercent", 50)
        action_packet = client_surface.dispatch_user_action("promote-btn")

        # Turn 2: Client sends the `userAction` JSON packet back to the AGY Agent
        resp2 = await agent.chat(f"[A2UI userAction] {json.dumps(action_packet)}")
        turn2_data = A2UITurnResponse.model_validate(await resp2.structured_output())
        jsonl_t2 = to_a2ui_jsonl_stream(turn2_data)
        client_surface.ingest_jsonl(jsonl_t2)
        print("Updated Client DataModel:", client_surface.data_model)
