terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.30.0"
    }
  }
}

variable "project_id" {
  type        = string
  default     = "davenport-boutique"
  description = "Target GCP project ID"
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Cloud Run L4 deployment region"
}

variable "gemma4_image" {
  type        = string
  default     = "us-docker.pkg.dev/vertex-ai/vertex-vision-model-garden-dockers/pytorch-vllm-serve:202604"
  description = "Container image serving Gemma 4 via vLLM"
}

resource "google_cloud_run_v2_service" "gemma4_l4_eval" {
  name     = "gemma4-l4-eval-service"
  location = var.region
  project  = var.project_id
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    max_instance_request_concurrency = 32

    scaling {
      min_instance_count = 1
      max_instance_count = 4
    }

    gpu_zonal_redundancy_disabled = true

    containers {
      image = var.gemma4_image

      resources {
        limits = {
          cpu              = "8"
          memory           = "32Gi"
          "nvidia.com/gpu" = "1"
        }
        cpu_idle = false
      }

      env {
        name  = "MODEL_ID"
        value = "google/gemma-4-26b-it"
      }

      env {
        name  = "WEIGHT_SOURCE"
        value = "VERTEX_MODEL_GARDEN_CACHE"
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 15
        period_seconds        = 10
        failure_threshold     = 18
      }
    }

    node_selector {
      accelerator = "nvidia-l4"
    }
  }
}
