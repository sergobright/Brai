import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bundleWorkflowCode } from '@temporalio/worker';

test('Inbox Temporal workflow bundles and keeps side effects in Activities', async () => {
  const workflowsPath = new URL('../src/inbox-workflows.js', import.meta.url).pathname;
  const bundle = await bundleWorkflowCode({ workflowsPath });
  assert.ok(bundle.code.length > 0);

  const workflow = fs.readFileSync(workflowsPath, 'utf8');
  assert.match(workflow, /proxyActivities/);
  assert.match(workflow, /attempt <= 3/);
  assert.doesNotMatch(workflow, /BraiStore|node:fs|node:child_process/);
});

test('global event insertion cannot create items or item roles', () => {
  const eventStore = fs.readFileSync(new URL('../src/store-events-logs.js', import.meta.url), 'utf8');
  const inboxStore = fs.readFileSync(new URL('../src/store-inbox-events.js', import.meta.url), 'utf8');
  assert.doesNotMatch(eventStore, /ensureEventItem|INSERT INTO items|INSERT INTO item_roles/);
  assert.doesNotMatch(inboxStore, /createInboxNormalizationEvent|INSERT INTO items|INSERT INTO item_roles/);
});
