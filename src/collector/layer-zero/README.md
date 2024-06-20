## README: Layer Zero Worker Implementation

### Overview

The Layer Zero worker implementation is designed to monitor and process events from the Layer Zero blockchain network. This implementation involves configuring, initializing, and running worker threads that handle specific events like `PacketSent` and `PayloadVerified`. This document provides a detailed overview of the processes involved and how to interact with the Layer Zero implementation.

### Table of Contents

1. [Setup and Configuration](#setup-and-configuration)
2. [Initialization](#initialization)
3. [Event Processing](#event-processing)
    - [Query Logs](#query-logs)
    - [Parse Events](#parse-events)
    - [Process PacketSent Event](#process-packetsent-event)
    - [Process PayloadVerified Event](#process-payloadverified-event)

### Setup and Configuration

1. **Global Configuration**: Load global settings specific to Layer Zero, such as retry intervals and processing intervals.
2. **Chain Configuration**: For each blockchain network (chain), load configurations including RPC endpoints, addresses, and identifiers.
3. **Monitor Service**: Attach a monitoring service to each chain for tracking the current status and block numbers.

### Initialization

1. **Load Worker Data**: For each chain, load specific configuration data necessary for the worker threads, including chain IDs, RPC URLs, contract addresses, and logger options.
2. **Create Worker Threads**: Initialize worker threads with the loaded configuration data, including mappings of chain IDs and incentives addresses.
3. **Start Workers**: Start the worker threads, set up error handling, and start logging the status of each worker at regular intervals.

### Event Processing

#### Query Logs

The worker threads periodically query the blockchain for logs related to the `PacketSent` and `PayloadVerified` events. The query includes filters based on addresses and topics to fetch relevant logs within a specified block range.

#### Parse Events

Once logs are fetched, the worker threads parse these logs to extract event data. Depending on the address associated with the log, the appropriate interface is used to parse the log and identify the event type.

#### Process PacketSent Event

1. **Decode Packet**: The worker decodes the `PacketSent` event data to extract details like encoded packet, options, and send library.
2. **Verify Sender**: The sender address is verified against the incentives addresses associated with the source chain.
3. **Log Event**: The worker logs the event details and processes the packet from the specific sender if it matches the configured incentives address.
4. **Store Data**: The decoded message and transaction details are stored in the database.

#### Process PayloadVerified Event

1. **Decode Header**: The worker decodes the `PayloadVerified` event data to extract details like DVN, header, confirmations, and proof hash.
2. **Fetch Payload Data**: The worker fetches associated payload data from the database using the proof hash.
3. **Verify Payload**: The worker verifies the payload using the retrieved data and configuration.
4. **Store Proof**: If the payload is verifiable, the worker stores the proof in the database.

### Logging and Error Handling

- **Logging**: Throughout the process, detailed logging is performed to track the status and any issues encountered. Logs include information about initialization, event processing, and errors.
- **Error Handling**: Errors are caught and logged at each step. For critical errors, appropriate error messages are logged, and retries are attempted as per the configured intervals.
