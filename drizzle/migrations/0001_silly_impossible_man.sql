CREATE TABLE `ledger_write_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_receipts` (
	`key` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`fingerprint` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
