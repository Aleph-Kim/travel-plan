INSERT INTO trip_days (slug, date, position, label, full_label, default_plan, details)
SELECT d.slug, day.value ->> '$.date', day.key, day.value ->> '$.label', day.value ->> '$.full',
	day.value ->> '$.default',
	CASE WHEN json_type(day.value, '$.plans') = 'object' AND EXISTS (
		SELECT 1 FROM json_each(day.value, '$.plans') WHERE key = day.value ->> '$.default'
	) THEN json_remove(day.value, '$.date', '$.label', '$.full', '$.default', '$.plans') END
FROM trip_documents d, json_each(d.body, '$.days') day
WHERE d.kind = 'plan' AND NOT EXISTS (SELECT 1 FROM trip_plan_settings s WHERE s.slug = d.slug);
--> statement-breakpoint
INSERT INTO trip_day_plans (slug, date, plan_key, position, title, weather_location, details)
SELECT d.slug, day.value ->> '$.date', plan.key,
	row_number() OVER (PARTITION BY d.slug, day.key ORDER BY plan.id) - 1,
	plan.value ->> '$.title', plan.value ->> '$.weather',
	CASE WHEN json_type(plan.value, '$.sun') = 'array' AND json_type(plan.value, '$.rain') = 'array'
		THEN json_remove(plan.value, '$.title', '$.weather', '$.sun', '$.rain') END
FROM trip_documents d, json_each(d.body, '$.days') day, json_each(day.value, '$.plans') plan
WHERE d.kind = 'plan' AND NOT EXISTS (SELECT 1 FROM trip_plan_settings s WHERE s.slug = d.slug);
--> statement-breakpoint
INSERT INTO trip_items (slug, item_index, time, card_type, name, title, note, cost, details)
SELECT d.slug, item.key, CASE WHEN json_type(item.value, '$.time') = 'text' THEN item.value ->> '$.time' END,
	CASE WHEN json_type(item.value, '$.type') = 'text' THEN item.value ->> '$.type' END,
	CASE WHEN json_type(item.value, '$.name') = 'text' THEN item.value ->> '$.name' END,
	CASE WHEN json_type(item.value, '$.title') = 'text' THEN item.value ->> '$.title' END,
	CASE WHEN json_type(item.value, '$.note') = 'text' THEN item.value ->> '$.note' END,
	CASE WHEN json_type(item.value, '$.cost') IN ('integer', 'real') THEN item.value ->> '$.cost' END,
	(
		SELECT json_group_object(field.key, item.value -> field.fullkey)
		FROM json_each(item.value) field
		WHERE field.key <> 'time'
			AND NOT (field.key IN ('type', 'name', 'title', 'note') AND field.type = 'text')
			AND NOT (field.key = 'cost' AND field.type IN ('integer', 'real'))
	)
FROM trip_documents d, json_each(d.body, '$.items') item
WHERE d.kind = 'plan' AND NOT EXISTS (SELECT 1 FROM trip_plan_settings s WHERE s.slug = d.slug);
--> statement-breakpoint
INSERT INTO trip_day_plan_items (slug, date, plan_key, condition, position, item_index)
SELECT d.slug, day.value ->> '$.date', plan.key, condition.value, item.key,
	CASE WHEN item.type = 'integer' THEN item.value END
FROM trip_documents d, json_each(d.body, '$.days') day, json_each(day.value, '$.plans') plan,
	json_each('["sun", "rain"]') condition, json_each(plan.value, '$.' || condition.value) item
WHERE d.kind = 'plan'
	AND NOT EXISTS (SELECT 1 FROM trip_plan_settings s WHERE s.slug = d.slug);
--> statement-breakpoint
INSERT INTO trip_plan_settings (slug, details)
SELECT d.slug, CASE WHEN json_type(d.body, '$.days') = 'array' AND json_type(d.body, '$.items') = 'array'
	THEN json_remove(d.body, '$.days', '$.items') END
FROM trip_documents d
WHERE d.kind = 'plan' AND NOT EXISTS (SELECT 1 FROM trip_plan_settings s WHERE s.slug = d.slug);
