DELETE FROM ai_logs
WHERE agent_id = 'inbox.normalizer'
  AND ai_title = 'Fallback разбора Inbox-записи';
