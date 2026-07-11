-- brai:reapply-after-production-seed

CREATE TEMP TABLE legacy_event_cleanup_stage (
  legacy_table text NOT NULL,
  id text NOT NULL,
  event_domain text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  event_action text NOT NULL,
  title text NOT NULL,
  items_id text,
  item_roles_id integer,
  subject_type text NOT NULL,
  subject_id text,
  actor_type text NOT NULL,
  actor_id text,
  device_id text,
  client_sequence integer,
  domain_sequence integer NOT NULL,
  status text NOT NULL,
  ignore_reason text,
  occurred_at_utc text NOT NULL,
  received_at_utc text NOT NULL,
  base_server_revision integer,
  payload_version integer NOT NULL,
  payload_json text NOT NULL,
  created_at_utc text NOT NULL,
  user_id text
) ON COMMIT DROP;

LOCK TABLE events IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'timer_events')) IS NOT NULL THEN
    LOCK TABLE timer_events IN ACCESS EXCLUSIVE MODE;
    EXECUTE $sql$
      INSERT INTO legacy_event_cleanup_stage
      SELECT
        'timer_events', 'timer:' || e.event_id, 'timer', e.event_id, e.type,
        'timer.' || e.type, 'Timer ' || e.type, NULL, NULL, 'timer', e.local_timer_id,
        CASE WHEN e.device_id = 'legacy-server' THEN 'system' ELSE 'user' END,
        e.device_id, e.device_id, e.client_sequence, e.server_sequence, e.status,
        e.ignore_reason, e.occurred_at_utc, e.received_at_utc, e.base_server_revision,
        e.payload_version, COALESCE(e.metadata_json, '{}'), e.received_at_utc, e.user_id
      FROM timer_events e
    $sql$;
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'activity_events')) IS NOT NULL THEN
    LOCK TABLE activity_events IN ACCESS EXCLUSIVE MODE;
    EXECUTE $sql$
      INSERT INTO legacy_event_cleanup_stage
      SELECT
        'activity_events', 'activity:' || e.event_id, 'activity', e.event_id, e.change_type,
        'activity.' || e.change_type, 'Activity ' || e.change_type,
        CASE WHEN i.id IS NULL OR e.change_type = 'reorder' THEN NULL ELSE e.activity_id END,
        CASE WHEN e.change_type = 'reorder' THEN NULL ELSE a.item_roles_id END,
        CASE WHEN e.change_type = 'reorder' THEN 'activity_list' ELSE 'activity' END,
        CASE WHEN e.change_type = 'reorder' THEN NULL ELSE e.activity_id END,
        'user', e.device_id, e.device_id, e.client_sequence, e.server_sequence, e.status,
        e.ignore_reason, e.occurred_at_utc, e.received_at_utc, NULL,
        e.payload_version, COALESCE(e.payload_json, '{}'), e.received_at_utc, e.user_id
      FROM activity_events e
      LEFT JOIN items i ON i.id = e.activity_id
      LEFT JOIN activities a ON a.id = e.activity_id
    $sql$;
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'inbox_events')) IS NOT NULL THEN
    LOCK TABLE inbox_events IN ACCESS EXCLUSIVE MODE;
    EXECUTE $sql$
      INSERT INTO legacy_event_cleanup_stage
      SELECT
        'inbox_events', 'inbox:' || e.event_id, 'inbox', e.event_id, e.type,
        'inbox.' || e.type, 'Inbox ' || e.type,
        CASE WHEN i.id IS NULL THEN NULL ELSE e.inbox_id END,
        i.item_roles_id, 'inbox', e.inbox_id,
        CASE WHEN e.device_id = 'inbox-ai' THEN 'agent' ELSE 'user' END,
        e.device_id, e.device_id, e.client_sequence, e.server_sequence, e.status,
        e.ignore_reason, e.occurred_at_utc, e.received_at_utc, NULL,
        e.payload_version, COALESCE(e.payload_json, '{}'), e.received_at_utc, e.user_id
      FROM inbox_events e
      LEFT JOIN inbox i ON i.id = e.inbox_id
    $sql$;
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM activities a
    WHERE a.last_event_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM events e
        WHERE e.event_domain = 'activity' AND e.event_id = a.last_event_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM legacy_event_cleanup_stage s
        WHERE s.event_domain = 'activity' AND s.event_id = a.last_event_id
      )
    GROUP BY a.last_event_id
    HAVING COUNT(DISTINCT a.user_id) > 1
  ) THEN
    RAISE EXCEPTION 'legacy event cleanup ambiguous activity reference ownership';
  END IF;
END;
$$;

WITH reference_groups AS (
  SELECT
    a.last_event_id,
    COUNT(*)::integer AS reference_count,
    MIN(a.id) AS single_activity_id,
    MIN(a.created_at_utc) AS occurred_at_utc,
    MAX(a.updated_at_utc) AS received_at_utc,
    MAX(a.user_id) AS user_id,
    jsonb_agg(a.id ORDER BY a.id) AS activity_ids
  FROM activities a
  WHERE a.last_event_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_domain = 'activity' AND e.event_id = a.last_event_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM legacy_event_cleanup_stage s
      WHERE s.event_domain = 'activity' AND s.event_id = a.last_event_id
    )
  GROUP BY a.last_event_id
), sequence_base AS (
  SELECT GREATEST(
    COALESCE((SELECT MAX(domain_sequence) FROM events WHERE event_domain = 'activity'), 0),
    COALESCE((SELECT MAX(domain_sequence) FROM legacy_event_cleanup_stage WHERE event_domain = 'activity'), 0)
  ) AS value
), numbered AS (
  SELECT r.*, row_number() OVER (ORDER BY r.last_event_id) AS offset
  FROM reference_groups r
)
INSERT INTO legacy_event_cleanup_stage (
  legacy_table, id, event_domain, event_id, event_type, event_action, title,
  items_id, item_roles_id, subject_type, subject_id, actor_type, actor_id,
  device_id, client_sequence, domain_sequence, status, ignore_reason,
  occurred_at_utc, received_at_utc, base_server_revision, payload_version,
  payload_json, created_at_utc, user_id
)
SELECT
  'activities.last_event_id',
  'activity-reference:' || md5(n.last_event_id),
  'activity',
  n.last_event_id,
  'reference_backfill',
  'activity.reference_backfill',
  'Activity reference backfill',
  NULL,
  NULL,
  CASE WHEN n.reference_count = 1 THEN 'activity' ELSE 'activity_list' END,
  CASE WHEN n.reference_count = 1 THEN n.single_activity_id ELSE NULL END,
  'system',
  'migration:54',
  NULL,
  NULL,
  b.value + n.offset,
  'accepted',
  NULL,
  n.occurred_at_utc,
  n.received_at_utc,
  NULL,
  1,
  jsonb_build_object(
    'source', 'legacy_activity_last_event_reference',
    'activity_ids', n.activity_ids
  )::text,
  n.received_at_utc,
  n.user_id
FROM numbered n
CROSS JOIN sequence_base b;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM legacy_event_cleanup_stage s
    JOIN events e ON e.id = s.id
    WHERE e.event_domain IS DISTINCT FROM s.event_domain
       OR e.event_id IS DISTINCT FROM s.event_id
  ) THEN
    RAISE EXCEPTION 'legacy event cleanup id conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM legacy_event_cleanup_stage s
    JOIN events e ON e.event_domain = s.event_domain AND e.domain_sequence = s.domain_sequence
    WHERE e.event_id IS DISTINCT FROM s.event_id
  ) THEN
    RAISE EXCEPTION 'legacy event cleanup domain sequence conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM legacy_event_cleanup_stage s
    JOIN events e
      ON e.event_domain = s.event_domain
     AND e.device_id = s.device_id
     AND e.client_sequence = s.client_sequence
    WHERE e.event_id IS DISTINCT FROM s.event_id
  ) THEN
    RAISE EXCEPTION 'legacy event cleanup device sequence conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM legacy_event_cleanup_stage s
    JOIN events e ON e.event_domain = s.event_domain AND e.event_id = s.event_id
    WHERE e.id IS DISTINCT FROM s.id
       OR e.event_type IS DISTINCT FROM s.event_type
       OR e.event_action IS DISTINCT FROM s.event_action
       OR e.title IS DISTINCT FROM s.title
       OR e.items_id IS DISTINCT FROM s.items_id
       OR e.item_roles_id IS DISTINCT FROM s.item_roles_id
       OR e.subject_type IS DISTINCT FROM s.subject_type
       OR e.subject_id IS DISTINCT FROM s.subject_id
       OR e.actor_type IS DISTINCT FROM s.actor_type
       OR e.actor_id IS DISTINCT FROM s.actor_id
       OR e.device_id IS DISTINCT FROM s.device_id
       OR e.client_sequence IS DISTINCT FROM s.client_sequence
       OR e.domain_sequence IS DISTINCT FROM s.domain_sequence
       OR e.status IS DISTINCT FROM s.status
       OR e.ignore_reason IS DISTINCT FROM s.ignore_reason
       OR e.occurred_at_utc IS DISTINCT FROM s.occurred_at_utc
       OR e.received_at_utc IS DISTINCT FROM s.received_at_utc
       OR e.base_server_revision IS DISTINCT FROM s.base_server_revision
       OR e.payload_version IS DISTINCT FROM s.payload_version
       OR e.payload_json::jsonb IS DISTINCT FROM s.payload_json::jsonb
       OR e.created_at_utc IS DISTINCT FROM s.created_at_utc
       OR e.user_id IS DISTINCT FROM s.user_id
  ) THEN
    RAISE EXCEPTION 'legacy event cleanup field parity conflict';
  END IF;
END;
$$;

WITH sequence_base AS (
  SELECT GREATEST(
    COALESCE((SELECT MAX(server_sequence) FROM events), 0),
    COALESCE((SELECT last_value FROM sequence_counters WHERE name = 'events.server_sequence'), 0)
  ) AS value
), missing AS (
  SELECT s.*, row_number() OVER (ORDER BY s.event_domain, s.domain_sequence, s.event_id) AS offset
  FROM legacy_event_cleanup_stage s
  WHERE NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.event_domain = s.event_domain AND e.event_id = s.event_id
  )
)
INSERT INTO events (
  id, event_domain, event_id, event_type, event_action, title, items_id, item_roles_id,
  subject_type, subject_id, actor_type, actor_id, device_id, client_sequence,
  server_sequence, domain_sequence, status, ignore_reason, occurred_at_utc,
  received_at_utc, base_server_revision, payload_version, payload_json,
  created_at_utc, user_id
)
SELECT
  m.id, m.event_domain, m.event_id, m.event_type, m.event_action, m.title,
  m.items_id, m.item_roles_id, m.subject_type, m.subject_id, m.actor_type,
  m.actor_id, m.device_id, m.client_sequence, b.value + m.offset,
  m.domain_sequence, m.status, m.ignore_reason, m.occurred_at_utc,
  m.received_at_utc, m.base_server_revision, m.payload_version, m.payload_json,
  m.created_at_utc, m.user_id
FROM missing m
CROSS JOIN sequence_base b;

INSERT INTO sequence_counters (name, last_value)
VALUES
  ('events.server_sequence', COALESCE((SELECT MAX(server_sequence) FROM events), 0)),
  ('events.domain_sequence.timer', COALESCE((SELECT MAX(domain_sequence) FROM events WHERE event_domain = 'timer'), 0)),
  ('events.domain_sequence.activity', COALESCE((SELECT MAX(domain_sequence) FROM events WHERE event_domain = 'activity'), 0)),
  ('events.domain_sequence.inbox', COALESCE((SELECT MAX(domain_sequence) FROM events WHERE event_domain = 'inbox'), 0))
ON CONFLICT (name) DO UPDATE
SET last_value = GREATEST(sequence_counters.last_value, excluded.last_value);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM legacy_event_cleanup_stage s
    LEFT JOIN events e ON e.event_domain = s.event_domain AND e.event_id = s.event_id
    WHERE e.id IS NULL
       OR e.domain_sequence IS DISTINCT FROM s.domain_sequence
       OR e.payload_json::jsonb IS DISTINCT FROM s.payload_json::jsonb
  ) THEN
    RAISE EXCEPTION 'legacy event cleanup missing canonical rows';
  END IF;

  IF EXISTS (
    SELECT 1 FROM activities a
    WHERE a.last_event_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.event_domain = 'activity' AND e.event_id = a.last_event_id)
  ) THEN
    RAISE EXCEPTION 'legacy event cleanup broken activity reference';
  END IF;

  IF EXISTS (
    SELECT 1 FROM inbox i
    WHERE i.last_event_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.event_domain = 'inbox' AND e.event_id = i.last_event_id)
  ) THEN
    RAISE EXCEPTION 'legacy event cleanup broken inbox reference';
  END IF;

  IF EXISTS (
    SELECT 1 FROM focus_session_sources s
    WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.event_domain = 'timer' AND e.event_id = s.event_id)
  ) OR EXISTS (
    SELECT 1 FROM focus_sessions s
    WHERE s.deleted_event_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.event_domain = 'timer' AND e.event_id = s.deleted_event_id)
  ) OR EXISTS (
    SELECT 1 FROM focus_session_intervals i
    WHERE (i.created_event_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM events e WHERE e.event_domain = 'timer' AND e.event_id = i.created_event_id
    )) OR (i.ended_event_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM events e WHERE e.event_domain = 'timer' AND e.event_id = i.ended_event_id
    ))
  ) THEN
    RAISE EXCEPTION 'legacy event cleanup broken focus reference';
  END IF;
END;
$$;

DELETE FROM table_descriptions
WHERE table_name IN ('timer_events', 'activity_events', 'inbox_events');

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc)
VALUES (
  'events',
  'Global events',
  'Единственный canonical ledger timer, activity, inbox и system событий.',
  'Содержит accepted и ignored domain events, domain-local revision и universal role links. Legacy timer_events, activity_events и inbox_events удалены после field-parity backfill и restricted dependency checks.',
  now()::text
)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

DO $$
BEGIN
  EXECUTE format('DROP TABLE IF EXISTS %I.timer_events RESTRICT', current_schema());
  EXECUTE format('DROP TABLE IF EXISTS %I.activity_events RESTRICT', current_schema());
  EXECUTE format('DROP TABLE IF EXISTS %I.inbox_events RESTRICT', current_schema());
END;
$$;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (54, now()::text, 'drop verified legacy event tables')
ON CONFLICT (version) DO NOTHING;
