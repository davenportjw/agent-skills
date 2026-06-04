---
name: apple_container
description: Replaces Docker with Apple's native container CLI for local development, orchestration, and Kubernetes.
---

# Local Development with Apple Container CLI

<description>
This skill documents the usage of Apple's native `container` CLI as a drop-in replacement for Docker Desktop or Podman. It provides explicit command translations, orchestration tips (`container-compose`), and Kubernetes management guidelines.
</description>

<triggers>
- Use this skill WHEN asked to write Docker commands on this repository.
- Use this skill WHEN asked to build, run, or debug local containers.
- Use this skill BEFORE writing any shell scripts that execute `docker` commands.
- Use this skill WHEN setting up local Kubernetes (e.g., Minikube).
</triggers>

<instructions>
1. **Always default to `container` instead of `docker`** for any CLI execution.
2. **Translate standard Docker commands** to their native Apple Container equivalents according to the matrix in the context.
3. **Use `container-compose`** when asked to orchestrate multiple services or start `docker-compose.yml` files.
4. **Scripts should prioritize `container`:** When modifying universal shell scripts (e.g., `start-dev.sh`), ensure they check for `container` before falling back to `docker`.
</instructions>

<context>

## Installation

Apple's native container toolset is installed on macOS 15+ via Homebrew.

- Base runtime: `brew install --cask container`
- Orchestration tool: `brew install container-compose`

## Command Translation Matrix

| Docker Command | Apple Container Command | Description |
| :--- | :--- | :--- |
| `docker run` | `container run` | Run a command in a new container |
| `docker build` | `container build` | Build an image from a Dockerfile |
| `docker ps` | `container ps` | List running containers |
| `docker stop` | `container stop` | Stop one or more running containers |
| `docker rm` | `container rm` | Remove one or more containers |
| `docker images` | `container images` | List available locally built/pulled images |
| `docker exec -it` | `container exec -it` | Run a command in a running container |
| `docker logs -f` | `container logs -f` | Fetch the logs of a container |
| `docker pull` | `container pull` | Pull an image or a repository from a registry |

## Orchestration Example

```bash
# Start services defined in docker-compose.yml
container-compose up -d

# Stop and remove containers, networks, and volumes
container-compose down -v
```

## Running Kubernetes (Minikube)

Running a local Kubernetes cluster can be achieved on top of the `container` engine.

1. Install Minikube: `brew install minikube`.
2. Start Cluster: `minikube start --driver=docker`. (Minikube may use generic container interfaces).
</context>

<gotchas>
- **Networking:** Local container networking differs slightly from Docker Desktop's managed network bridge. Exposing NodePorts natively to `localhost` may require `minikube tunnel`.
- **Image Context:** If you build an image locally using `container build`, ensure those images are loaded into the Minikube environment (`minikube image load <image_name>`) before Kubernetes can schedule pods using them.
</gotchas>
