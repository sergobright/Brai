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
  getHandler(id) {
    return this.db
      .prepare('SELECT * FROM handlers WHERE id = ? AND status = ?')
      .get(id, 'active') ?? null;
  }
,

  listSessions({ from, to } = {}) {
    const fromUtc = from ? new Date(moscowDateStartUtcMs(from)).toISOString() : null;
    const toUtc = to ? new Date(moscowDateStartUtcMs(addDays(to, 1))).toISOString() : null;

    let sql = `
      SELECT s.id,
        MIN(i.started_at_utc) AS started_at_utc,
        MAX(i.ended_at_utc) AS ended_at_utc,
        SUM(COALESCE(i.duration_seconds, 0)) AS duration_seconds,
        s.created_at_utc, s.updated_at_utc, s.deleted_at_utc, s.deleted_event_id,
        s.start_origin, s.started_by_activity_id
      FROM focus_sessions s
      JOIN focus_session_intervals i ON i.focus_session_id = s.id
      WHERE NOT EXISTS (
          SELECT 1 FROM focus_session_intervals active
          WHERE active.focus_session_id = s.id AND active.ended_at_utc IS NULL
        )
        AND s.deleted_at_utc IS NULL
    `;
    const params = [];
    if (fromUtc) {
      sql += ' AND i.ended_at_utc >= ?';
      params.push(fromUtc);
    }
    if (toUtc) {
      sql += ' AND i.started_at_utc < ?';
      params.push(toUtc);
    }
    sql += ' GROUP BY s.id ORDER BY started_at_utc DESC';

    const sessions = this.db.prepare(sql).all(...params).map((row) => formatSession(this.sessionWithIntervals(row)));
    return { sessions, groups: groupSessionsByDateHour(sessions, { from, to }) };
  }
,

  challengeSummary(currentUtcMs = Date.now()) {
    const startUtc = new Date(moscowDateStartUtcMs(CHALLENGE_START_DATE)).toISOString();
    const endUtc = new Date(challengeEndExclusiveUtcMs()).toISOString();
    const rows = this.db
      .prepare(`
        SELECT i.id, i.started_at_utc, i.ended_at_utc, i.duration_seconds
        FROM focus_sessions s
        JOIN focus_session_intervals i ON i.focus_session_id = s.id
        WHERE i.ended_at_utc IS NOT NULL
          AND s.deleted_at_utc IS NULL
          AND i.ended_at_utc > ?
          AND i.started_at_utc < ?
        ORDER BY i.started_at_utc ASC
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
