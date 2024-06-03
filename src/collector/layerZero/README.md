# Layer Zero Collector Implementation

## Description

The Layer Zero Collector operates by utilizing only a part of the Layer Zero stack. This software represents the offchain component that supports the Generalized Incentives Smart Contracts Stack by reading their events and monitorizing Layer Zero Endpoints (they're also Smart Contracts), and it is crucial to understand how both complement each other.

## Functionality

We will use Layer Zero Arbitrary Message Bridge (AMB) stack for the transmission of packets between the GeneralizedIncentivesEscrow contracts on the source and destination blockchains. The AMB will only transport the message between the two blockchains an d verify it's integrity; it's important to have under account, we are not implementing a Layer Zero OApp.

Thus, the GeneralizedIncentives Smart Contract (SC) will issue the `sendPacket` command, and it will be validated against the Layer Zero ULN to ensure it has reached its destination correctly.

## Workflow

1. **Monitoring the GARP Contract**:
   - First, we monitor the GARP contract to emit an event indicating that a packet has been sent to the AMB.
   - This event will be recorded and processed by our software.

2. **Underwriter Usage**:
   - For using the underwriter, we monitor the incoming data at the Layer Zero endpoint.

3. **Packet Reception**:
   - When the packet reaches its destination, we monitor `MessageReceiveLib`, which is responsible for receiving the packet and emitting an event indicating that the packet has been verified on the destination chain.
   - After a certain number of confirmations, the packet will be considered received and submitted to Redis database.

4. **Validation and Confirmation**:
   - The collector will validate the proof, allowing the submitter to upload the transaction.