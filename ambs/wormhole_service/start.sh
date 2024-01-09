set -exo pipefail

source .env set

ENTRY="/guardiand ghcr.io/wormhole-foundation/guardiand:latest"

[ $USE_TESTNET == true ] && NETWORK=/wormhole/testnet/2/1 || NETWORK=/wormhole/mainnet/2

MAINNET_URL=/dns4/wormhole-v2-mainnet-bootstrap.xlabs.xyz/udp/8999/quic/p2p/12D3KooWNQ9tVrcb64tw6bNs2CaNrUGPM7yRrKvBBheQ5yCyPHKC,/dns4/wormhole.mcf.rocks/udp/8999/quic/p2p/12D3KooWDZVv7BhZ8yFLkarNdaSWaB43D6UbQwExJ8nnGAEmfHcU,/dns4/wormhole-v2-mainnet-bootstrap.staking.fund/udp/8999/quic/p2p/12D3KooWG8obDX9DNi1KUwZNu9xkGwfKqTp2GFwuuHpWZ3nQruS1
TESTNET_URL=/dns4/t-guardian-01.nodes.stable.io/udp/8999/quic/p2p/12D3KooWCW3LGUtkCVkHZmVSZHzL3C4WRKWfqAiJPz1NR7dT9Bxh,/dns4/t-guardian-02.nodes.stable.io/udp/8999/quic/p2p/12D3KooWJXA6goBCiWM8ucjzc4jVUBSqL9Rri6UpjHbkMPErz5zK

[ $USE_TESTNET == true ] && URL=$TESTNET_URL || URL=$MAINNET_URL

docker run --rm -p $REDIS_PORT:$REDIS_PORT --name redis-docker -d redis
docker run --platform=linux/amd64 -p $SPY_PORT:$SPY_PORT --name spy --entrypoint $ENTRY spy --nodeKey /node.key --spyRPC "[::]:$SPY_PORT" --network $NETWORK --bootstrap $URL
