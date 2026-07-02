import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function withUserScope(userId, fn) {
  return storage.run(userId ?? null, fn);
}

export function scopedUserId() {
  return storage.getStore() ?? null;
}

export function scopeSql(alias = '') {
  const userId = scopedUserId();
  if (!userId) return { clause: '', where: '1 = 1', params: [], userId: null };
  const column = `${alias ? `${alias}.` : ''}user_id`;
  return {
    clause: ` AND ${column} = ?`,
    where: `${column} = ?`,
    params: [userId],
    userId
  };
}
