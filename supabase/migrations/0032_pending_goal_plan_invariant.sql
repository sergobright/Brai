-- brai:reapply-after-production-seed

UPDATE context_decisions
SET status = 'stale_context', updated_at_utc = now()::text
WHERE decision_kind = 'goal_plan' AND status = 'pending'
  AND workflow_execution_id IS NULL;

WITH ranked_pending_plans AS (
  SELECT id, row_number() OVER (
    PARTITION BY user_id, trigger_items_id
    ORDER BY created_at_utc DESC, id DESC
  ) AS plan_rank
  FROM context_decisions
  WHERE decision_kind = 'goal_plan' AND status = 'pending'
    AND trigger_items_id IS NOT NULL
)
UPDATE context_decisions AS decision
SET status = 'stale_context', updated_at_utc = now()::text
FROM ranked_pending_plans AS ranked
WHERE decision.id = ranked.id AND ranked.plan_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_context_decisions_pending_goal_plan
  ON context_decisions (user_id, trigger_items_id)
  WHERE decision_kind = 'goal_plan' AND status = 'pending'
    AND trigger_items_id IS NOT NULL;

INSERT INTO table_descriptions (
  table_name, title, short_description, long_description, updated_at_utc
) VALUES (
  'context_decisions',
  'Context decisions',
  'Durable versioned untrusted AI proposals and resolution provenance.',
  'Stores bounded proposal/evidence, exact execution contract and lifecycle. A partial unique index keeps at most one pending goal_plan per user and Goal; migration reconciliation marks older duplicates stale_context.',
  now()::text
)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (67, now()::text, 'keep one unresolved Goal plan per Goal')
ON CONFLICT (version) DO NOTHING;
