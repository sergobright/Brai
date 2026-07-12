INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (57, now()::text, 'add admin role/workflow observability telemetry')
ON CONFLICT (version) DO NOTHING;
