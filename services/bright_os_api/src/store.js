import Database from 'better-sqlite3';
import { activityEventMethods } from './store-activity-events.js';
import { migrationMethods } from './store-migrations.js';
import { deploymentMethods } from './store-deployments.js';
import { readModelMethods } from './store-read-models.js';
import { timerEventMethods } from './store-timer-events.js';
export { formatActivity, formatSession, groupSessionsByDateHour } from './store-helpers.js';

export class BrightOsStore {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }
}

Object.assign(
  BrightOsStore.prototype,
  migrationMethods,
  deploymentMethods,
  timerEventMethods,
  activityEventMethods,
  readModelMethods
);
