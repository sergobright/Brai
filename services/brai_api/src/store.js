import { PostgresSyncDatabase, isPostgresUrl } from './postgres-sync-db.js';
import { activityEventMethods } from './store-activity-events.js';
import { activityWorkflowStoreMethods } from './store-activity-workflows.js';
import { appSettingsMethods } from './store-app-settings.js';
import { authUserMethods } from './store-auth-users.js';
import { braiCmdStoreMethods } from './store-brai-cmd.js';
import { contextApplyMethods } from './store-context-apply.js';
import { contextDecisionMethods } from './store-context-decisions.js';
import { aiLogMethods } from './store-ai-logs.js';
import { inboxEventMethods } from './store-inbox-events.js';
import { deploymentMethods } from './store-deployments.js';
import { eventsLogsMethods } from './store-events-logs.js';
import { goalRelationMethods } from './store-goal-relations.js';
import { goalAgentWorkflowMethods } from './store-goal-agent-workflows.js';
import { readModelMethods } from './store-read-models.js';
import { relationMethods } from './store-relations.js';
import { roleLinkMethods } from './store-role-links.js';
import { timerEventMethods } from './store-timer-events.js';
import { userAiStoreMethods } from './store-user-ai.js';
import { workflowStoreMethods } from './store-workflows.js';
import { userContentMethods } from './store-user-content.js';
import { versionHistoryMethods } from './store-version-history.js';
export { formatActivity, formatFocusInterval, formatSession, groupSessionsByDateHour } from './store-helpers.js';

export class BraiStore {
  constructor(dbTarget) {
    if (!isPostgresUrl(dbTarget)) throw new Error('BRAI_DATABASE_URL must be a postgres:// or postgresql:// URL');
    // ponytail: sync adapter preserves existing store API; replace with async store if DB throughput matters.
    this.db = new PostgresSyncDatabase(dbTarget);
    this.db.exec('SELECT 1');
  }
}

Object.assign(
  BraiStore.prototype,
  appSettingsMethods,
  authUserMethods,
  braiCmdStoreMethods,
  contextApplyMethods,
  contextDecisionMethods,
  aiLogMethods,
  deploymentMethods,
  eventsLogsMethods,
  goalRelationMethods,
  goalAgentWorkflowMethods,
  relationMethods,
  roleLinkMethods,
  timerEventMethods,
  activityEventMethods,
  activityWorkflowStoreMethods,
  inboxEventMethods,
  workflowStoreMethods,
  userContentMethods,
  readModelMethods,
  userAiStoreMethods,
  versionHistoryMethods
);
