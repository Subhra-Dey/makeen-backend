import { nextIstRun } from './notice-scheduler';

describe('nextIstRun (NOTIF-J1: 07:00 India time)', () => {
  it('later today when 07:00 IST has not come yet', () => {
    // 01:00 UTC = 06:30 IST
    expect(nextIstRun(new Date('2026-10-16T01:00:00Z'), '07:00').toISOString()).toBe(
      '2026-10-16T01:30:00.000Z',
    );
  });

  it('tomorrow once it has passed (or is exactly now)', () => {
    expect(nextIstRun(new Date('2026-10-16T01:30:00Z'), '07:00').toISOString()).toBe(
      '2026-10-17T01:30:00.000Z',
    );
    expect(nextIstRun(new Date('2026-10-16T10:00:00Z'), '07:00').toISOString()).toBe(
      '2026-10-17T01:30:00.000Z',
    );
  });

  it('uses the India date, not the UTC date, around midnight', () => {
    // 20:00 UTC on the 16th = 01:30 IST on the 17th → 07:00 IST on the 17th.
    expect(nextIstRun(new Date('2026-10-16T20:00:00Z'), '07:00').toISOString()).toBe(
      '2026-10-17T01:30:00.000Z',
    );
  });
});
