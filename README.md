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

The evaluator takes in messages along with their parameters to estimate if it is worth it to relay the message. It exposes a method to do so which can be called from the getter after a new bounty has been placed.

## Collector

The collector service is collecting information from various AMB's to pair with the bounty given from the `Getter` before calling the submitter for the final step.

## Submitter

The submitter service gets the information gathered by all the services, simulates the transaction for gas usage and compares it to the evaluator’s conditions.
If it is profitable the submitter will relay the message using the [processPacket](https://github.com/catalystdao/GeneralisedRelayer/blob/c5c697693cad82a972a4ddbd72be229e599777ef/src/abis/IncentivizedMessageEscrow.json#L398-L412) method from the [IncentivizedMessageEscrow](https://github.com/catalystdao/GeneralisedRelayer/blob/c5c697693cad82a972a4ddbd72be229e599777ef/src/abis/IncentivizedMessageEscrow.json) contract.

# Adding a new AMB

In order to add a new AMB you need to create a new service folder under [collector](https://github.com/catalystdao/GeneralisedRelayer/blob/main/src/collector) and make an independent service that can be run on it's own worker thread. For each chain, a worker will be spawned with the appropiate context. For more documentation, read the documentation for the bootstrap function of mock.

Inside the service after when you recieve the amb information use `parentPort.postMessage(ambInfo)` to send it up to the worker thread caller.

The worker thread caller will recieve that information and will get the matching bounty for your amb using the unique messageIdentifier [this.bountiesService.getBounty(messageIdentifier)](https://github.com/catalystdao/GeneralisedRelayer/blob/c5c697693cad82a972a4ddbd72be229e599777ef/src/getter/bounties.service.ts#L22).

Using the bounty information and the AMB information you can use the submitter service [simulateAndSubmitDeliveryTx](https://github.com/catalystdao/GeneralisedRelayer/blob/c5c697693cad82a972a4ddbd72be229e599777ef/src/submitter/submitter.service.ts#L18) to submit the message.

This service will look something like this

```ts
  async startService() {
    //Fetching info from chains..
    app.listen(
      {
        //chain1...
        //chain2...
      },
      async (ambInfo: any) => {
        const messageIdentifier = ambInfo.messageIdentifier;

        parentPort.postMessage({
          destinationChain: ambInfo.destinationChain,
          messageIdentifier: ambInfo.messageIdentifier,
          rawMessage:ambInfo.rawMessage,
        });
      },
    );
  }
```

Add the amb to the [ambs.config.json](https://github.com/catalystdao/GeneralisedRelayer/blob/c5c697693cad82a972a4ddbd72be229e599777ef/src/ambs.config.json) file with true to make it active and call the service in the
[CollectorController](https://github.com/catalystdao/GeneralisedRelayer/blob/main/src/collector/collector.controller.ts) like so

```ts
if (ambConfig.myNewAMB) {
  this.loggerService.info('Starting my new Service...');

  const worker = new Worker(join(__dirname, './myNewAMB/myNewAMB.service.js'));

  worker.on('message', (ambInfo: AMBInfo) => {
    const bounty = this.bountiesService.getBounty(ambInfo.messageIdentifier);

    if (bounty) {
      this.submitterService.simulateAndSubmitDeliveryTx(
        ambInfo.rawMessage,
        ambInfo.destinationChain,
        bounty,
      );
    }
  });
}
```

# Using the Mock implementation

The mock implementation is a simple message signing service which sends the signing output message using the [processPacket](https://github.com/catalystdao/GeneralisedRelayer/blob/c5c697693cad82a972a4ddbd72be229e599777ef/src/abis/IncentivizedMockEscrow.json) method from the [IncentivizedMockEscrow](https://github.com/catalystdao/GeneralisedRelayer/blob/c5c697693cad82a972a4ddbd72be229e599777ef/src/abis/IncentivizedMockEscrow.json) contract.
It can be used for testing the contract since it only requires the signature info.

Under [mock.service](https://github.com/catalystdao/GeneralisedRelayer/blob/main/src/collector/mock/mock.service.ts) you will find the method to start mock by providing a chain and a mock contract address.
