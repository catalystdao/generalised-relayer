CREATE TABLE IF NOT EXISTS "ambPayloads" (
	"id" serial PRIMARY KEY NOT NULL,
	"bountyId" integer NOT NULL,
	"amb" text NOT NULL,
	"sourceChain" text NOT NULL,
	"destinationChain" text NOT NULL,
	"payload" text NOT NULL,
	"message" text,
	"recoveryContext" text,
	"messageCtx" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bounties" (
	"id" serial PRIMARY KEY NOT NULL,
	"bountyIdentifier" text NOT NULL,
	"fromChainId" text,
	"toChainId" text,
	"maxGasDelivery" text,
	"maxGasAck" text,
	"refundGasTo" text,
	"priceOfDeliveryGas" text,
	"priceOfAckGas" text,
	"targetDelta" text,
	"bountyStatus" integer,
	"address" text,
	"submitTransactionId" integer,
	"execTransactionId" integer,
	"ackTransactionId" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"transactionHash" text NOT NULL,
	"chainId" text NOT NULL,
	CONSTRAINT "transactions_transactionHash_chainId_unique" UNIQUE("transactionHash","chainId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ambPayloads" ADD CONSTRAINT "ambPayloads_bountyId_bounties_id_fk" FOREIGN KEY ("bountyId") REFERENCES "bounties"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounties" ADD CONSTRAINT "bounties_submitTransactionId_transactions_id_fk" FOREIGN KEY ("submitTransactionId") REFERENCES "transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounties" ADD CONSTRAINT "bounties_execTransactionId_transactions_id_fk" FOREIGN KEY ("execTransactionId") REFERENCES "transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounties" ADD CONSTRAINT "bounties_ackTransactionId_transactions_id_fk" FOREIGN KEY ("ackTransactionId") REFERENCES "transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
