import { dashboardPeriod } from './dashboard.service';

describe('dashboardPeriod (D-122)', () => {
  it('no date or month: everything still waiting', () => {
    expect(dashboardPeriod({})).toBeNull();
  });

  it('a date: that day for Daily rows, its month for Monthly rows', () => {
    expect(dashboardPeriod({ date: '2026-10-15' })).toEqual({
      from: '2026-10-15',
      to: '2026-10-15',
      monthFrom: '2026-10-01',
      monthTo: '2026-10-01',
    });
  });

  it('a month: every day of it, and that month', () => {
    expect(dashboardPeriod({ month: '2026-02' })).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
      monthFrom: '2026-02-01',
      monthTo: '2026-02-01',
    });
  });
});
