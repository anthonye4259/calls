CREATE TABLE `calls` (
	`id` text PRIMARY KEY NOT NULL,
	`phone_number` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_calls_created_at` ON `calls` (`created_at`);