#!/usr/bin/env bash
# Build and push ficus-core and ficus-sandbox images to ECR.
#
# Usage: ./scripts/push-images.sh [--core-only | --sandbox-only] [--tag TAG]
#
# Environment:
#   AWS_REGION       - AWS region (default: us-east-2)
#   ECR_REGISTRY     - ECR registry URL (auto-detected if not set)
#   IMAGE_TAG        - Image tag (default: latest)
#   SKIP_BUILD       - Set to 1 to push without rebuilding

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse args
CORE=true
SANDBOX=true
TAG="${IMAGE_TAG:-latest}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --core-only)    SANDBOX=false; shift ;;
    --sandbox-only) CORE=false; shift ;;
    --tag)          TAG="$2"; shift 2 ;;
    *)              echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Detect registry
REGION="${AWS_REGION:-us-east-2}"
if [[ -z "${ECR_REGISTRY:-}" ]]; then
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  ECR_REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
fi

echo "Registry: $ECR_REGISTRY"
echo "Tag:      $TAG"
echo ""

cd "$REPO_ROOT"

if [[ "$CORE" == "true" ]]; then
  IMAGE="$ECR_REGISTRY/ficus-core:$TAG"
  echo "=== ficus-core ==="
  if [[ "${SKIP_BUILD:-}" != "1" ]]; then
    echo "Building..."
    docker build --platform linux/amd64 -t "$IMAGE" -f Dockerfile .
  fi
  echo "Pushing $IMAGE"
  docker push "$IMAGE"
  echo ""
fi

if [[ "$SANDBOX" == "true" ]]; then
  # Both images come from one multi-stage Dockerfile (--target). BuildKit builds
  # and caches the shared `base` stage once, reused across both targets.
  IMAGE="$ECR_REGISTRY/ficus-sandbox:$TAG"
  echo "=== ficus-sandbox (squad) ==="
  if [[ "${SKIP_BUILD:-}" != "1" ]]; then
    echo "Building..."
    docker build --platform linux/amd64 --target squad -t "$IMAGE" -f packages/sandbox-server/Dockerfile .
  fi
  echo "Pushing $IMAGE"
  docker push "$IMAGE"
  echo ""

  AGENT_IMAGE="$ECR_REGISTRY/ficus-sandbox-agent:$TAG"
  echo "=== ficus-sandbox-agent (light) ==="
  if [[ "${SKIP_BUILD:-}" != "1" ]]; then
    echo "Building..."
    docker build --platform linux/amd64 --target agent -t "$AGENT_IMAGE" -f packages/sandbox-server/Dockerfile .
  fi
  echo "Pushing $AGENT_IMAGE"
  docker push "$AGENT_IMAGE"
  echo ""
fi

echo "Done."
