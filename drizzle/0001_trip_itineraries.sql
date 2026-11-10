CREATE TABLE `trip_plan_settings` (
	`slug` text PRIMARY KEY NOT NULL REFERENCES `trips`(`slug`) ON DELETE cascade,
	`details` text NOT NULL,
	CONSTRAINT "trip_plan_settings_details_valid" CHECK(json_type(`details`) = 'object')
);
--> statement-breakpoint
CREATE TABLE `trip_days` (
	`slug` text NOT NULL REFERENCES `trips`(`slug`) ON DELETE cascade,
	`date` text NOT NULL,
	`position` integer NOT NULL,
	`label` text NOT NULL,
	`full_label` text NOT NULL,
	`default_plan` text NOT NULL,
	`details` text NOT NULL,
	PRIMARY KEY(`slug`, `date`),
	CONSTRAINT "trip_days_position_unique" UNIQUE(`slug`, `position`),
	CONSTRAINT "trip_days_details_valid" CHECK(json_type(`details`) = 'object')
);
--> statement-breakpoint
CREATE TABLE `trip_day_plans` (
	`slug` text NOT NULL,
	`date` text NOT NULL,
	`plan_key` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`weather_location` text NOT NULL,
	`details` text NOT NULL,
	PRIMARY KEY(`slug`, `date`, `plan_key`),
	CONSTRAINT "trip_day_plans_position_unique" UNIQUE(`slug`, `date`, `position`),
	FOREIGN KEY(`slug`, `date`) REFERENCES `trip_days`(`slug`, `date`) ON DELETE cascade,
	CONSTRAINT "trip_day_plans_details_valid" CHECK(json_type(`details`) = 'object')
);
--> statement-breakpoint
CREATE TABLE `trip_items` (
	`slug` text NOT NULL REFERENCES `trips`(`slug`) ON DELETE cascade,
	`item_index` integer NOT NULL,
	`time` text NOT NULL,
	`card_type` text,
	`name` text,
	`title` text,
	`note` text,
	`cost` numeric,
	`details` text NOT NULL,
	PRIMARY KEY(`slug`, `item_index`),
	CONSTRAINT "trip_items_details_valid" CHECK(json_type(`details`) = 'object')
);
--> statement-breakpoint
CREATE TABLE `trip_day_plan_items` (
	`slug` text NOT NULL,
	`date` text NOT NULL,
	`plan_key` text NOT NULL,
	`condition` text NOT NULL,
	`position` integer NOT NULL,
	`item_index` integer NOT NULL,
	PRIMARY KEY(`slug`, `date`, `plan_key`, `condition`, `position`),
	FOREIGN KEY(`slug`, `date`, `plan_key`) REFERENCES `trip_day_plans`(`slug`, `date`, `plan_key`) ON DELETE cascade,
	FOREIGN KEY(`slug`, `item_index`) REFERENCES `trip_items`(`slug`, `item_index`),
	CONSTRAINT "trip_day_plan_items_condition_valid" CHECK(`condition` IN ('sun', 'rain'))
);
--> statement-breakpoint
CREATE INDEX `trip_day_plan_items_item_idx` ON `trip_day_plan_items`(`slug`, `item_index`);
--> statement-breakpoint
CREATE VIEW `trip_plan_documents` AS
WITH item_positions AS (
	SELECT *, row_number() OVER (PARTITION BY slug ORDER BY item_index) - 1 AS response_index
	FROM trip_items
)
SELECT s.slug, json_set(s.details,
	'$.days', json((
		SELECT json_group_array(json(day_body)) FROM (
			SELECT json_set(d.details, '$.date', d.date, '$.label', d.label, '$.full', d.full_label,
				'$.default', d.default_plan, '$.plans', json((
					SELECT json_group_object(plan_key, json(plan_body)) FROM (
						SELECT p.plan_key, json_set(p.details, '$.title', p.title, '$.weather', p.weather_location,
							'$.sun', json((
								SELECT json_group_array(response_index) FROM (
									SELECT pos.response_index FROM trip_day_plan_items i
									JOIN item_positions pos USING (slug, item_index)
									WHERE (i.slug, i.date, i.plan_key, i.condition) = (p.slug, p.date, p.plan_key, 'sun')
									ORDER BY i.position
								)
							)),
							'$.rain', json((
								SELECT json_group_array(response_index) FROM (
									SELECT pos.response_index FROM trip_day_plan_items i
									JOIN item_positions pos USING (slug, item_index)
									WHERE (i.slug, i.date, i.plan_key, i.condition) = (p.slug, p.date, p.plan_key, 'rain')
									ORDER BY i.position
								)
							))
						) AS plan_body
						FROM trip_day_plans p WHERE (p.slug, p.date) = (d.slug, d.date)
						ORDER BY p.position
					)
				))
			) AS day_body
			FROM trip_days d WHERE d.slug = s.slug ORDER BY d.position
		)
	)),
	'$.items', json((
		SELECT json_group_array(json(item_body)) FROM (
			SELECT json_patch(i.details, json_patch('{}', json_object(
				'time', i.time, 'type', i.card_type, 'name', i.name,
				'title', i.title, 'note', i.note, 'cost', i.cost
			))) AS item_body
			FROM trip_items i WHERE i.slug = s.slug ORDER BY i.item_index
		)
	))
) AS body
FROM trip_plan_settings s
UNION ALL
SELECT d.slug, d.body FROM trip_documents d
WHERE d.kind = 'plan' AND NOT EXISTS (
	SELECT 1 FROM trip_plan_settings s WHERE s.slug = d.slug
);
