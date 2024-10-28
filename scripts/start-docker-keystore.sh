#!/bin/bash
PRIVATE_KEY_RESPONSE=$(cast wallet decrypt-keystore --keystore-dir ./ $NODE_ENV.keystore) || exit 1
RELAYER_PRIVATE_KEY="${PRIVATE_KEY_RESPONSE: -66}"
RELAYER_PRIVATE_KEY="$RELAYER_PRIVATE_KEY" docker compose up -d
