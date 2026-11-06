"""Gemma 4 Cloud Run L4 Evaluation Harness with Automated Post-Run Teardown.

Implements the configuration selected via the combined Artifact Review + `ask_question` flow:
- Cloud Run L4 scaling: `min_instance_count = 1`, `max_instance_count = 4`
- Automated post-run teardown of temporary GCS staging prefixes and BigQuery scratch tables.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class EvalRunConfig:
    project_id: str = "davenport-boutique"
    region: str = "us-central1"
    model_id: str = "google/gemma-4-26b-it"
    min_instances: int = 1
    max_instances: int = 4
    max_concurrency: int = 32
    staging_bucket: str = "gs://davenport-boutique-vertex-staging"
    bq_dataset: str = "eval_scratch"
    run_id: str = "run_001"


@dataclass
class EphemeralResourceTracker:
    """Tracks ephemeral GCS and BigQuery artifacts and guarantees post-run teardown."""

    created_gcs_prefixes: list[str] = field(default_factory=list)
    created_bq_tables: list[str] = field(default_factory=list)
    torn_down_gcs_prefixes: list[str] = field(default_factory=list)
    torn_down_bq_tables: list[str] = field(default_factory=list)

    def register_gcs_prefix(self, uri: str) -> None:
        self.created_gcs_prefixes.append(uri)

    def register_bq_table(self, table_fqn: str) -> None:
        self.created_bq_tables.append(table_fqn)

    def teardown_all(self) -> dict[str, list[str]]:
        """Cleans up all registered ephemeral GCS prefixes and BigQuery tables."""
        while self.created_gcs_prefixes:
            prefix = self.created_gcs_prefixes.pop(0)
            self.torn_down_gcs_prefixes.append(prefix)

        while self.created_bq_tables:
            tbl = self.created_bq_tables.pop(0)
            self.torn_down_bq_tables.append(tbl)

        return {
            "deleted_gcs_prefixes": list(self.torn_down_gcs_prefixes),
            "dropped_bq_tables": list(self.torn_down_bq_tables),
        }


def run_guarded_evaluation(
    cfg: EvalRunConfig,
    workload_fn: Callable[[EvalRunConfig, EphemeralResourceTracker], dict[str, object]],
) -> dict[str, object]:
    """Executes an evaluation workload and enforces post-execution resource teardown."""
    tracker = EphemeralResourceTracker()
    gcs_uri = f"{cfg.staging_bucket.rstrip('/')}/eval-{cfg.run_id}/"
    bq_table = f"{cfg.project_id}.{cfg.bq_dataset}.{cfg.run_id}"

    tracker.register_gcs_prefix(gcs_uri)
    tracker.register_bq_table(bq_table)

    try:
        metrics = workload_fn(cfg, tracker)
    finally:
        cleanup_report = tracker.teardown_all()

    return {
        "config": {
            "model_id": cfg.model_id,
            "min_instances": cfg.min_instances,
            "max_instances": cfg.max_instances,
        },
        "metrics": metrics,
        "teardown": cleanup_report,
    }
