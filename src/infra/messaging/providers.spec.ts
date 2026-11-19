import { Msg91SmsProvider } from './providers';

describe('MSG91 SMS adapter (D-34)', () => {
  it('posts the OTP to the DLT template with the auth key in a header', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch = ((url: URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return Promise.resolve(new Response(JSON.stringify({ type: 'success' }), { status: 200 }));
    }) as unknown as typeof fetch;
    await new Msg91SmsProvider('key-123', 'tmpl-9', fakeFetch).sendOtp({
      to: '98123 45621',
      code: '042917',
      ttlMinutes: 10,
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('mobile')).toBe('919812345621');
    expect(url.searchParams.get('otp')).toBe('042917');
    expect(url.searchParams.get('template_id')).toBe('tmpl-9');
    expect((calls[0]?.init?.headers as Record<string, string>).authkey).toBe('key-123');
  });

  it('throws when MSG91 does not confirm success', async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ type: 'error' }), { status: 200 }),
      )) as unknown as typeof fetch;
    await expect(
      new Msg91SmsProvider('k', 't', fakeFetch).sendOtp({
        to: '9812345621',
        code: '1',
        ttlMinutes: 10,
      }),
    ).rejects.toThrow(/MSG91/);
  });
});
