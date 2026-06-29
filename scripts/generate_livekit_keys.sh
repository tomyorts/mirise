#!/usr/bin/env bash
set -euo pipefail

api_key="mirise_$(openssl rand -hex 6)"
api_secret="$(openssl rand -base64 32 | tr -d '\n')"

cat <<OUT
LIVEKIT_API_KEY=${api_key}
LIVEKIT_API_SECRET=${api_secret}
OUT
