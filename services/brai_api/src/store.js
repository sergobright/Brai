import Database from 'better-sqlite3';
import { PostgresSyncDatabase, isPostgresUrl } from './postgres-sync-db.js';
import { activityEventMethods } from './store-activity-events.js';
import { authUserMethods } from './store-auth-users.js';
import { braiCmdStoreMethods } from './store-brai-cmd.js';
import { aiLogMethods } from './store-ai-logs.js';
import { inboxEventMethods } from './store-inbox-events.js';
import { migrationMethods } from './store-migrations.js';
import { deploymentMethods } from './store-deployments.js';
import { readModelMethods } from './store-read-models.js';
import { timerEventMethods } from './store-timer-events.js';
export { formatActivity, formatFocusInterval, formatSession, groupSessionsByDateHour } from './store-helpers.js';

export class BraiStore {
  constructor(dbTarget) {
    if (isPostgresUrl(dbTarget)) {
      // ponytail: sync adapter preserves existing store API; replace with async store if DB throughput matters.
      this.db = new PostgresSyncDatabase(dbTarget);
      return;
    }
    this.db = new Database(dbTarget);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }
}

Object.assign(
  BraiStore.prototype,
  migrationMethods,
  authUserMethods,
  braiCmdStoreMethods,
  aiLogMethods,
  deploymentMethods,
  timerEventMethods,
  activityEventMethods,
  inboxEventMethods,
  readModelMethods
);
