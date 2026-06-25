import test from 'node:test';
import assert from 'node:assert/strict';
import {
  challengeEndDate,
  localDateFromUtcMs,
  remainingChallengeDays,
  splitSessionByMoscowDay
} from '../src/time.js';

test('challenge end date is inclusive 2026-07-09', () => {
  assert.equal(challengeEndDate(), '2026-07-09');
});

test('uses Europe/Moscow UTC+3 local dates', () => {
  assert.equal(localDateFromUtcMs(Date.parse('2026-06-11T20:59:59.000Z')), '2026-06-11');
  assert.equal(localDateFromUtcMs(Date.parse('2026-06-11T21:00:00.000Z')), '2026-06-12');
});

test('splits sessions crossing Moscow midnight', () => {
  const chunks = splitSessionByMoscowDay(
    '2026-06-12T20:30:00.000Z',
    '2026-06-12T21:30:00.000Z'
  );
  assert.deepEqual(chunks, [
    { date: '2026-06-12', seconds: 1800 },
    { date: '2026-06-13', seconds: 1800 }
  ]);
});

test('remaining challenge days count includes current day', () => {
  assert.equal(remainingChallengeDays(Date.parse('2026-06-12T09:00:00.000Z')), 28);
  assert.equal(remainingChallengeDays(Date.parse('2026-07-09T09:00:00.000Z')), 1);
  assert.equal(remainingChallengeDays(Date.parse('2026-07-10T09:00:00.000Z')), 0);
});
