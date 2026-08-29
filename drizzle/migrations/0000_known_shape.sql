CREATE TABLE `app_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` integer,
	`before_json` text,
	`after_json` text,
	`at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dealers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`contact` text,
	`address` text,
	`gstin` text,
	`state_code` text,
	`type` text DEFAULT 'both' NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dealers_archived` ON `dealers` (`is_archived`);--> statement-breakpoint
CREATE TABLE `id_sequences` (
	`scope` text PRIMARY KEY NOT NULL,
	`next_value` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dealer_id` integer NOT NULL,
	`entry_date` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer,
	`reverses_entry_id` integer,
	`debit_paise` integer DEFAULT 0 NOT NULL,
	`credit_paise` integer DEFAULT 0 NOT NULL,
	`running_balance_paise` integer NOT NULL,
	`bank_account` text,
	`label` text,
	`description` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`dealer_id`) REFERENCES `dealers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ledger_dealer_date` ON `ledger_entries` (`dealer_id`,`entry_date`,`id`);--> statement-breakpoint
CREATE INDEX `idx_ledger_source` ON `ledger_entries` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`human_id` text NOT NULL,
	`dealer_id` integer NOT NULL,
	`entry_date` text NOT NULL,
	`direction` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`method` text,
	`bank_account` text,
	`reference` text,
	`notes` text,
	`is_voided` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`dealer_id`) REFERENCES `dealers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_human_id_unique` ON `payments` (`human_id`);--> statement-breakpoint
CREATE INDEX `idx_pay_dealer` ON `payments` (`dealer_id`,`entry_date`);--> statement-breakpoint
CREATE TABLE `transaction_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` integer NOT NULL,
	`line_no` integer DEFAULT 1 NOT NULL,
	`item_name` text,
	`quantity` real NOT NULL,
	`unit` text,
	`rate_paise` integer NOT NULL,
	`amount_paise` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_lines_tx` ON `transaction_lines` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`human_id` text NOT NULL,
	`mode` text NOT NULL,
	`dealer_id` integer NOT NULL,
	`entry_date` text NOT NULL,
	`invoice_no` text,
	`invoice_date` text,
	`reference_tag` text,
	`bank_account` text DEFAULT 'od' NOT NULL,
	`gst_rate` real DEFAULT 18 NOT NULL,
	`base_total_paise` integer NOT NULL,
	`discount_paise` integer DEFAULT 0 NOT NULL,
	`freight_paise` integer DEFAULT 0 NOT NULL,
	`gst_amount_paise` integer DEFAULT 0 NOT NULL,
	`round_off_paise` integer DEFAULT 0 NOT NULL,
	`grand_total_paise` integer NOT NULL,
	`is_return_note` integer DEFAULT false NOT NULL,
	`notes` text,
	`is_voided` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`dealer_id`) REFERENCES `dealers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_human_id_unique` ON `transactions` (`human_id`);--> statement-breakpoint
CREATE INDEX `idx_tx_dealer` ON `transactions` (`dealer_id`,`entry_date`);--> statement-breakpoint
CREATE INDEX `idx_tx_date` ON `transactions` (`entry_date`);