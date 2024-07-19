import pino from 'pino';
import { Store } from 'src/store/store.lib';
import { workerData } from 'worker_threads';
import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { AMBMessage, KeyActionMessage, RelayStateJSON } from '../store.types';
import {
    bounties,
    transactions,
    ambPayloads,
} from '../postgres/postgres.schema';
import { bountyFromJson } from '../postgres/postgres.transformer';
import { and, eq } from 'drizzle-orm';


const REDIS_QUEUE_KEY = 'relayer:presister:queue';

class PersisterWorker {
    private readonly logger: pino.Logger;

    private readonly postgresConnectionString: string;

    private readonly store: Store;
    private readonly client: Client;
    private readonly db: NodePgDatabase;

    private readonly chains: string[];

    private readonly processingDelay = 200;

    constructor() {
        this.postgresConnectionString = workerData.postgresConnectionString;
        this.chains = workerData.chains;

        // Connect to postgres
        this.client = new Client({
            connectionString: this.postgresConnectionString,
        });
        void this.client.connect(); //TODO this promise shouldn't be in the constructor, as it cannot be awaited here
        this.db = drizzle(this.client);

        // Connect to redis.
        this.store = new Store();

        // Start logger
        this.logger = pino(workerData.loggerOptions).child({
            worker: 'persister',
        });

        this.logger.info('Persister worker started.');
    }

    async run(): Promise<void> {
        // Run migration
        this.logger.info(`Running migrations...`);
        const migrationPromise = migrate(this.db, { migrationsFolder: 'drizzle' });
        this.logger.info(`Migrations finished.`);

        // Start listener
        await this.listen();
        await migrationPromise;

        // SCAN!
        // this.scan();

        // Stay alive.
        while (true) {
            // Consume the queue:
            await this.consumeQueue();
            await new Promise((r) => setTimeout(r, this.processingDelay));
        }
    }

    async queueGet(): Promise<KeyActionMessage[]> {
        const queue = await this.store.redis.lrange(REDIS_QUEUE_KEY, 0, -1);
        return queue.map((element) => JSON.parse(element));
    }

    async queueShift(): Promise<KeyActionMessage | undefined> {
        const firstElement = await this.store.redis.lpop(REDIS_QUEUE_KEY);
        return firstElement != undefined
            ? JSON.parse(firstElement)
            : undefined;
    }

    async queuePush(message: KeyActionMessage) {
        await this.store.redis.rpush(REDIS_QUEUE_KEY, JSON.stringify(message));
    }

    async consumeQueue() {
        // Copy queue to memory.

        let nextElement: KeyActionMessage | undefined = await this.queueShift();
        while (nextElement != undefined) {
            this.logger.info(
                `Got a key: ${nextElement.key} with action: ${nextElement.action}`,
            );
            await this.examineKey(nextElement.key);

            nextElement = await this.queueShift();
        }
    }

    // async scan() {
    //   this.logger.info(`Starting redis scan`);
    //   this.store.scan(this.examineKey);
    // }

    async listen() {
        // Get a constant reference to the queue.

        // Listen for key updates.
        this.logger.info(`Persister listening on on ${'key'}`);
        await this.store.on('key', (event: any) => {

            //TODO verify event format
            const message = event as KeyActionMessage;
            void this.queuePush(message);
        });
        // Listen for proofs. Notice that proofs aren't submitted so we need to listen seperately.
        // We need to iter over each key seperately.
        // const chains = this.chains;
        // for (const chain of chains) {
        //   const channel = Store.combineString('submit', chain);
        //   this.logger.info(`Persister listening on on ${channel}`);
        //   this.store.on(channel, this.examineProof());
        // }
    }

    // I don't know why, but without the function factory, 'this' is empty and we cannot use this.store or this.logger.
    async examineKey(key: string) {
        const keyKeys = key.split(':');
        if (keyKeys.includes(Store.RELAY_STATE_KEY_PREFIX)) {
            this.logger.debug(`${key}, bounty`);
            const value: string | null = await this.store.get(key);
            if (value === null) return;
            const parsedValue: RelayStateJSON = JSON.parse(value);

            // Get or set all transactions.
            const fromChainId = parsedValue.bountyPlacedEvent?.fromChainId;
            const toChainId = parsedValue.messageDeliveredEvent?.toChainId;
            const submitTransactionHash = parsedValue?.bountyPlacedEvent?.transactionHash;
            const execTransactionHash = parsedValue?.messageDeliveredEvent?.transactionHash;
            const ackTransactionHash = parsedValue?.bountyClaimedEvent?.transactionHash;

            let submitTransactionId: number | undefined,
                execTransactionId: number | undefined,
                ackTransactionId: number | undefined;
            if (submitTransactionHash && fromChainId) {
                const submitTransactionQuery = await this.db
                    .select({ id: transactions.id })
                    .from(transactions)
                    .where(
                        and(
                            eq(transactions.transactionHash, submitTransactionHash),
                            eq(transactions.chainId, fromChainId),
                        ),
                    )
                    .limit(1);
                if (submitTransactionQuery.length === 0) {
                    submitTransactionId = (
                        await this.db
                            .insert(transactions)
                            .values({
                                transactionHash: submitTransactionHash,
                                chainId: fromChainId,
                            })
                            .returning({ id: transactions.id })
                    )[0]!.id;
                } else {
                    submitTransactionId = submitTransactionQuery[0]!.id;
                }
            }
            // execTransactionHash?: string;
            if (execTransactionHash && toChainId) {
                const execTransactionQuery = await this.db
                    .select({ id: transactions.id })
                    .from(transactions)
                    .where(
                        and(
                            eq(transactions.transactionHash, execTransactionHash),
                            eq(transactions.chainId, toChainId),
                        ),
                    )
                    .limit(1);
                if (execTransactionQuery.length === 0) {
                    execTransactionId = (
                        await this.db
                            .insert(transactions)
                            .values({
                                transactionHash: execTransactionHash,
                                chainId: toChainId,
                            })
                            .returning({ id: transactions.id })
                    )[0]!.id;
                } else {
                    execTransactionId = execTransactionQuery[0]!.id;
                }
            }
            // ackTransactionHash?: string;
            if (ackTransactionHash && fromChainId) {
                const ackTransactionQuery = await this.db
                    .select({ id: transactions.id })
                    .from(transactions)
                    .where(
                        and(
                            eq(transactions.transactionHash, ackTransactionHash),
                            eq(transactions.chainId, fromChainId),
                        ),
                    )
                    .limit(1);
                if (ackTransactionQuery.length === 0) {
                    ackTransactionId = (
                        await this.db
                            .insert(transactions)
                            .values({
                                transactionHash: ackTransactionHash,
                                chainId: fromChainId,
                            })
                            .returning({ id: transactions.id })
                    )[0]!.id;
                } else {
                    ackTransactionId = ackTransactionQuery[0]!.id;
                }
            }

            const sqlReadyBounty = {
                ...bountyFromJson(parsedValue),
                submitTransactionId,
                execTransactionId,
                ackTransactionId,
            };
            // Try to get first.
            const bountiesSelected = await this.db
                .select({})
                .from(bounties)
                .where(eq(bounties.bountyIdentifier, sqlReadyBounty.bountyIdentifier))
                .limit(1);
            if (bountiesSelected.length === 0) {
                // insert
                this.logger.debug(`Inserting ${key} as bounty`);
                return this.db.insert(bounties).values(sqlReadyBounty);
            } else {
                // update
                this.logger.debug(`Updating ${key} as bounty`);
                return this.db
                    .update(bounties)
                    .set(sqlReadyBounty)
                    .where(
                        eq(bounties.bountyIdentifier, sqlReadyBounty.bountyIdentifier),
                    );
            }
        } else if (keyKeys.includes(Store.AMB_MESSAGE_KEY_PREFIX)) {
            this.logger.debug(`${key}, amb`);
            const value: string | null = await this.store.get(key);
            if (value === null) return;
            const parsedValue: AMBMessage = JSON.parse(value);

            let bountyId: number;
            // Get or set an associated bounty.
            const bountiesSelected = await this.db
                .select({ id: bounties.id })
                .from(bounties)
                .where(eq(bounties.bountyIdentifier, parsedValue.messageIdentifier))
                .limit(1);
            if (bountiesSelected.length === 0) {
                // Insert a bounty and get the id.
                this.logger.debug(
                    `Inserting ${key}, ${parsedValue.messageIdentifier} as bounty via AMB`,
                );
                bountyId = (
                    await this.db
                        .insert(bounties)
                        .values({
                            bountyIdentifier: parsedValue.messageIdentifier,
                            destinationAddress: parsedValue.toIncentivesAddress,
                        })
                        .returning({ id: bounties.id })
                )[0]!.id;
            } else {
                // Set the bountyId based on the selected.
                bountyId = bountiesSelected[0]!.id;
                // Set the `destinationAddress` within the existing record
                await this.db
                    .update(bounties)
                    .set({ destinationAddress: parsedValue.toIncentivesAddress })
                    .where(
                        eq(bounties.bountyIdentifier, parsedValue.messageIdentifier),
                    );
            }

            const sqlReadyBounty: typeof ambPayloads.$inferInsert = {
                bountyId,
                amb: parsedValue.amb,
                sourceChain: parsedValue.fromChainId,
                destinationChain: parsedValue.toChainId,
                payload: parsedValue.incentivesPayload,
                recoveryContext: parsedValue.recoveryContext,
            };

            // Check if there exists an equiv bounty.
            // Try to get first.
            const payloadsSelected = await this.db
                .select({})
                .from(ambPayloads)
                .where(
                    and(
                        eq(ambPayloads.bountyId, sqlReadyBounty.bountyId),
                        eq(ambPayloads.payload, sqlReadyBounty.payload),
                    ),
                )
                .limit(1); // TODO: Fix this.
            // TODO: There is currently a change for overlaps. Even if we also index by everything else, someone could replicate a bountyId.
            // TODO: See comment in the store.
            if (payloadsSelected.length === 0) {
                // insert
                this.logger.debug(`Inserting ${key} as amb`);
                return this.db.insert(ambPayloads).values(sqlReadyBounty);
            }
        } else if (keyKeys.includes(Store.AMB_PROOF_KEY_PREFIX)) {
            this.logger.debug(`${key}, proof`);
        }
        return undefined;
    }

    // examineProof(): (message: AmbPayload) => void {
    //   const store = this.store;
    //   const logger = this.logger;
    //   const db = this.db;

    //   return async function (message: AmbPayload) {
    //     logger.debug(`Got proof: ${message}`);
    //   };
    // }

    async onBounty(key: string, value: string) {
        this.logger.debug(`${key}: ${value}`);
    }

    async onProof(key: string, value: string) {
        this.logger.debug(`${key}: ${value}`);
    }
}

void new PersisterWorker().run();
