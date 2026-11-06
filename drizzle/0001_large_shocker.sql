CREATE TABLE `distributors` (
	`id` text PRIMARY KEY NOT NULL,
	`company` text NOT NULL,
	`phone_number` text NOT NULL,
	`state` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_distributors_status_state` ON `distributors` (`status`,`state`);--> statement-breakpoint
CREATE TABLE `relay_config` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` text NOT NULL
);
