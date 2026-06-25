import {
  CHALLENGE_DAYS,
  CHALLENGE_START_DATE,
  CHALLENGE_TARGET_SECONDS,
  DAILY_GOAL_SECONDS,
  addDays,
  challengeDates,
  challengeEndExclusiveUtcMs,
  moscowDateStartUtcMs,
  remainingChallengeDays,
  splitSessionByMoscowDay
} from './time.js';
import { formatSession, groupSessionsByDateHour } from './store-helpers.js';

export const readModelMethods = {
  listSessions({ from, to } = {}) {
    const fromUtc = from ? new Date(moscowDateStartUtcMs(from)).toISOString() : null;
    const toUtc = to ? new Date(moscowDateStartUtcMs(addDays(to, 1))).toISOString() : null;

    let sql = 'SELECT * FROM timer_sessions WHERE ended_at_utc IS NOT NULL';
    const params = [];
    if (fromUtc) {
      sql += ' AND ended_at_utc >= ?';
      params.push(fromUtc);
    }
    if (toUtc) {
      sql += ' AND started_at_utc < ?';
      params.push(toUtc);
    }
    sql += ' ORDER BY started_at_utc DESC';

    const sessions = this.db.prepare(sql).all(...params).map(formatSession);
    return { sessions, groups: groupSessionsByDateHour(sessions, { from, to }) };
  }
,

  challengeSummary(currentUtcMs = Date.now()) {
    const startUtc = new Date(moscowDateStartUtcMs(CHALLENGE_START_DATE)).toISOString();
    const endUtc = new Date(challengeEndExclusiveUtcMs()).toISOString();
    const rows = this.db
      .prepare(`
        SELECT * FROM timer_sessions
        WHERE ended_at_utc IS NOT NULL
          AND ended_at_utc > ?
          AND started_at_utc < ?
        ORDER BY started_at_utc ASC
      `)
      .all(startUtc, endUtc);

    const totals = new Map(challengeDates().map((date) => [date, 0]));
    for (const session of rows) {
      for (const chunk of splitSessionByMoscowDay(
        session.started_at_utc,
        session.ended_at_utc
      )) {
        if (totals.has(chunk.date)) {
          totals.set(chunk.date, totals.get(chunk.date) + chunk.seconds);
        }
      }
    }

    const days = challengeDates().map((date) => {
      const completedSeconds = totals.get(date) ?? 0;
      return {
        date,
        completed_seconds: completedSeconds,
        completed_hours: completedSeconds / 3600,
        percentage: (completedSeconds / DAILY_GOAL_SECONDS) * 100,
        achieved: completedSeconds >= DAILY_GOAL_SECONDS
      };
    });

    const completedSeconds = days.reduce((sum, day) => sum + day.completed_seconds, 0);
    const remainingSeconds = Math.max(0, CHALLENGE_TARGET_SECONDS - completedSeconds);
    const remainingDays = remainingChallengeDays(currentUtcMs);
    const requiredAverageSeconds =
      completedSeconds >= CHALLENGE_TARGET_SECONDS || remainingDays === 0
        ? 0
        : remainingSeconds / remainingDays;

    return {
      timezone: 'Europe/Moscow',
      start_date: CHALLENGE_START_DATE,
      end_date: addDays(CHALLENGE_START_DATE, CHALLENGE_DAYS - 1),
      days_count: CHALLENGE_DAYS,
      daily_goal_seconds: DAILY_GOAL_SECONDS,
      total_goal_seconds: CHALLENGE_TARGET_SECONDS,
      completed_seconds: completedSeconds,
      completed_hours: completedSeconds / 3600,
      percentage: (completedSeconds / CHALLENGE_TARGET_SECONDS) * 100,
      remaining_seconds: remainingSeconds,
      remaining_days: remainingDays,
      required_average_seconds_per_remaining_day: requiredAverageSeconds,
      required_average_hours_per_remaining_day: requiredAverageSeconds / 3600,
      achieved: completedSeconds >= CHALLENGE_TARGET_SECONDS,
      days
    };
  }
};
