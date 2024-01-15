ALTER TABLE "bounties" RENAME COLUMN "address" TO "sourceAddress";--> statement-breakpoint
ALTER TABLE "bounties" ADD COLUMN "destinationAddress" text;