# Generalised Relayer

The Generalised Relayer is built to act as a relayer for different AMBs using the [Generalised Incentives](https://github.com/catalystdao/GeneralisedIncentives) scheme. 

The goal for the Generalised Relayer is 2 fold:

1. Acts as a reference implementation of a relayer that understands [Generalised Incentives](https://github.com/catalystdao/GeneralisedIncentives).
2. Lower the barrier to entry resulting in greater competition which will improve relaying speed, robustness, and resistance to censorship.

Currently, the Relayer supports the following AMBs:

- Wormhole

And act as a relayer for signed messages (called mock).

# Running the relayer

It is advised to run the relayer via docker. In which case the dependencies are:

- Docker
- Docker Compose plugin.

With these dependencies the relayer can be started by running

```bash
docker compose up (-d)
```
Adding `-d` runs the relayer in the background rather than foreground.

# Development

For development, the requiresments vary by AMB. For the specific requirements, see the docker compose file.

Regardless, a redis instance is needed. The simplest way to get one is through docker with:
```bash
docker container run -p 6379:6379 redis
```

Afterwards the dependencies can be installed and the relayer can be build:

```bash
yarn install && yarn build
```

The relayer can then be started by running

```bash
yarn start
```


## Configuration

To run the relayer, it is mandatory to provide a config file. A reference is provided as `/config.example.yaml`. The `relayer.privateKey` field needs to be set with a funded privatekey for all chains the relayer should run on.

The supported AMBs can be set under `ambs`  and chains can be configured under `chains`. The current example rpcs are public and are hopefully good enough to run the relayer for a short period. For production environment we recommend using paid rpcs.

# Relayer Structure

The Relayer is devided into 4 main services: `Getter`, `Evaluator`, `Collector`, `Submitter`. These services work together to get all messages, evaluate their value, collect message proofs, and submit them on chain. The services communicate using `redis` and are run in parallel. Wherever it makes sense, chains are allocated seperate workers to ensure a chain fault doesn't propagate and impact the performance on other chains.

## Getter

The Getter service is responsible for fetching on-chain bounties and messages. It works by searching for relevant EVM logs:

These events are:

- `BountyPlaced`: Signals that a message has been initiated and also contains the associated incentives.
- `MessageDelivered`: Signals that a message has been relayed from source to destination.
- `BountyClaimed`: Signals that a message has been relayed from destination to source, and the bounty has been distributed.
- `BountyIncreased`: Singals that the associated relaying incentive has been updated.

It holds the map of currently tracked bounties, all pending bounties are sent to the evaluator to gauge their profitability.

## Evaluator

The evaluator takes in messages along with their parameters to estimate if it is worth it to relay the message. It exposes a method which is called on the submittor for evaluations.

## Collector

The collector service is collecting information from various AMB's to pair with the bounty given from the `Getter` before calling the submitter for the final step.

## Submitter

The submitter service gets the information gathered by all the services, simulates the transaction for gas usage and compares it to the evaluator’s conditions.
If it is profitable the submitter will relay the message using the [processPacket](https://github.com/catalystdao/GeneralisedRelayer/blob/32cc0c56d1891f03257971723ce9ba9d15b900af/abis/IncentivizedMockEscrow.json#L735-L757) method from the IncentivizedMessageEscrow contract.

# Adding a new AMB

In order to add a new AMB you need to create a new service folder under [collector](https://github.com/catalystdao/GeneralisedRelayer/blob/main/src/collector) and make an independent service that can be run on it's own worker thread. For each chain, a worker will be spawned with the appropiate context. For more documentation, read the documentation for the bootstrap function of mock.

Inside the service after you recieve the amb information use `redis.postMessage(emitToChannel, ambPayload)` to deliver it to the submitter.

To ensure the AMB is being created, add it to the both the use config but also `config.example.yaml`.


# Using the Mock implementation

The mock implementation is PoA scheme which works well for testnet, development, or testing. To use it, deploy a [Mock Generalised Incentive](https://github.com/catalystdao/GeneralisedIncentives/tree/main/src/apps/mock) implementation using a known key. Then set the key in the config and run the relayer.