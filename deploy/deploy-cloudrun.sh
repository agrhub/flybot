#!/usr/bin/env bash
# Deploy CamHub to Google Cloud Run (macOS / Linux / Git Bash).
# Usage: ./deploy/deploy-cloudrun.sh [--project ID] [--region REGION] [--update-secrets] [--skip-setup] [--dry-run] [--yes]
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required (https://nodejs.org)." >&2
    exit 1
fi
if ! command -v gcloud >/dev/null 2>&1; then
    echo "Google Cloud CLI is required: https://cloud.google.com/sdk/docs/install" >&2
    exit 1
fi

exec node deploy/deploy-cloudrun.js "$@"
