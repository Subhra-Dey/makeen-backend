/**
 * In-memory stand-in for the ioredis commands the API uses (GET/SET[EX|PX]/DEL/INCR/PEXPIRE/
 * PTTL/PING/FLUSHDB), with real TTL behaviour. Used by unit tests always, and by e2e tests only
 * when no real Redis is reachable (CI always has a real one).
 */
export class FakeRedis {
  status = 'ready';
  healthy = true;
  private readonly data = new Map<string, { value: string; expiresAt: number | null }>();

  private live(key: string): { value: string; expiresAt: number | null } | undefined {
    const e = this.data.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  private guard(): void {
    if (!this.healthy) throw new Error('ECONNREFUSED');
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }
  ping(): Promise<string> {
    this.guard();
    return Promise.resolve('PONG');
  }
  get(key: string): Promise<string | null> {
    this.guard();
    return Promise.resolve(this.live(key)?.value ?? null);
  }
  set(key: string, value: string, mode?: 'EX' | 'PX', ttl?: number): Promise<'OK'> {
    this.guard();
    const ms =
      mode === 'EX' && ttl !== undefined
        ? ttl * 1000
        : mode === 'PX' && ttl !== undefined
          ? ttl
          : null;
    this.data.set(key, { value, expiresAt: ms === null ? null : Date.now() + ms });
    return Promise.resolve('OK');
  }
  del(...keys: string[]): Promise<number> {
    this.guard();
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n += 1;
    return Promise.resolve(n);
  }
  incr(key: string): Promise<number> {
    this.guard();
    const e = this.live(key);
    const next = (e ? Number(e.value) : 0) + 1;
    this.data.set(key, { value: String(next), expiresAt: e?.expiresAt ?? null });
    return Promise.resolve(next);
  }
  pexpire(key: string, ms: number): Promise<number> {
    this.guard();
    const e = this.live(key);
    if (!e) return Promise.resolve(0);
    e.expiresAt = Date.now() + ms;
    return Promise.resolve(1);
  }
  pttl(key: string): Promise<number> {
    this.guard();
    const e = this.live(key);
    if (!e) return Promise.resolve(-2);
    return Promise.resolve(e.expiresAt === null ? -1 : e.expiresAt - Date.now());
  }
  flushdb(): Promise<'OK'> {
    this.data.clear();
    return Promise.resolve('OK');
  }
  quit(): Promise<'OK'> {
    return Promise.resolve('OK');
  }
  disconnect(): void {
    /* nothing to close */
  }
}
