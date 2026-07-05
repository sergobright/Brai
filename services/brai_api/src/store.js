import Database from 'better-sqlite3';
import { activityEventMethods } from './store-activity-events.js';
import { authUserMethods } from './store-auth-users.js';
import { airWhisperStoreMethods } from './store-airwhisper.js';
import { aiLogMethods } from './store-ai-logs.js';
import { inboxEventMethods } from './store-inbox-events.js';
import { migrationMethods } from './store-migrations.js';
import { deploymentMethods } from './store-deployments.js';
import { readModelMethods } from './store-read-models.js';
import { timerEventMethods } from './store-timer-events.js';
export { formatActivity, formatFocusInterval, formatSession, groupSessionsByDateHour } from './store-helpers.js';

export class BraiStore {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }
}

Object.assign(
  BraiStore.prototype,
  migrationMethods,
  authUserMethods,
  airWhisperStoreMethods,
  aiLogMethods,
  deploymentMethods,
  timerEventMethods,
  activityEventMethods,
  inboxEventMethods,
  readModelMethods
);
