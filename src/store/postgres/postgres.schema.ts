import { relations } from 'drizzle-orm';
import { integer, pgTable, serial, text, unique } from 'drizzle-orm/pg-core';

export const transactions = pgTable(
  'transactions',
  {
    id: serial('id').primaryKey(),
    transactionHash: text('transactionHash').notNull(),
    chainId: text('chainId').notNull(),
  },
  (transaction) => ({
    chain_id_unq: unique().on(transaction.transactionHash, transaction.chainId),
  }),
);

export const transactionsRelations = relations(transactions, ({ many }) => ({
  submit: many(bounties, { relationName: 'submit' }),
  exec: many(bounties, { relationName: 'exec' }),
  ack: many(bounties, { relationName: 'ack' }),
}));

export const bounties = pgTable('bounties', {
  id: serial('id').primaryKey(),
  bountyIdentifier: text('bountyIdentifier').notNull(),
  fromChainId: text('fromChainId'), // Where bounty got emitted.
  toChainId: text('toChainId'), // Figure out how to notNull this entry.
  maxGasDelivery: text('maxGasDelivery'),
  maxGasAck: text('maxGasAck'),
  refundGasTo: text('refundGasTo'),
  priceOfDeliveryGas: text('priceOfDeliveryGas'),
  priceOfAckGas: text('priceOfAckGas'),
  targetDelta: text('targetDelta'),
  bountyStatus: integer('bountyStatus'),
  address: text('address'),
  submitTransactionId: integer('submitTransactionId').references(
    () => transactions.id,
  ),
  execTransactionId: integer('execTransactionId').references(
    () => transactions.id,
  ),
  ackTransactionId: integer('ackTransactionId').references(
    () => transactions.id,
  ),
});

export const bountiesRelations = relations(bounties, ({ one, many }) => ({
  proofs: many(ambPayloads),
  submit: one(transactions, {
    fields: [bounties.submitTransactionId],
    references: [transactions.id],
    relationName: 'submit',
  }),
  exec: one(transactions, {
    fields: [bounties.execTransactionId],
    references: [transactions.id],
    relationName: 'exec',
  }),
  ack: one(transactions, {
    fields: [bounties.ackTransactionId],
    references: [transactions.id],
    relationName: 'ack',
  }),
}));

export const ambPayloads = pgTable('ambPayloads', {
  id: serial('id').primaryKey(),
  bountyId: integer('bountyId')
    .notNull()
    .references(() => bounties.id),
  amb: text('amb').notNull(),
  destinationChain: text('destinationChain').notNull(),
  payload: text('payload').notNull(), // This is specifically Generalised Incentive payload.
  message: text('message'), // This is the message to execute.
  recoveryContext: text('recoveryContext'),
  messageCtx: text('messageCtx'), // This is the message context to execute the message with.
});

export const ambPayloadsRelations = relations(ambPayloads, ({ one }) => ({
  bounty: one(bounties, {
    fields: [ambPayloads.bountyId],
    references: [bounties.id],
  }),
}));
