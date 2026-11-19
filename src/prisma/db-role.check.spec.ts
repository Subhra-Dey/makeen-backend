import { rlsBypassReasons } from './db-role.check';

describe('runtime DB role must be subject to RLS (D-08)', () => {
  it('accepts the runtime role', () => {
    expect(
      rlsBypassReasons({
        role: 'makeen_app',
        superuser: false,
        bypassRls: false,
        ownsTables: false,
      }),
    ).toEqual([]);
  });
  it('flags owner, superuser and BYPASSRLS roles', () => {
    expect(
      rlsBypassReasons({
        role: 'makeen_owner',
        superuser: false,
        bypassRls: false,
        ownsTables: true,
      }),
    ).toEqual(['owns the application tables']);
    expect(
      rlsBypassReasons({ role: 'postgres', superuser: true, bypassRls: true, ownsTables: true }),
    ).toHaveLength(3);
  });
});
