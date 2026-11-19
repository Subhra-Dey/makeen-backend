import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDiskObjectStore } from './object-store';

describe('LocalDiskObjectStore (dev adapter)', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'makeen-store-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores, reads and deletes by a random key', async () => {
    const store = new LocalDiskObjectStore(dir);
    const key = 'daily-exception/0190a000-0000-7000-8000-000000000001';
    await store.put(key, Buffer.from('%PDF-1.7'));
    expect((await store.get(key)).toString()).toBe('%PDF-1.7');
    await expect(store.put(key, Buffer.from('again'))).rejects.toThrow();
    await store.delete(key);
    await expect(store.get(key)).rejects.toThrow();
  });

  it('refuses keys that could leave the folder', async () => {
    const store = new LocalDiskObjectStore(dir);
    await expect(store.get('../secrets/0190a000-0000-7000-8000-000000000001')).rejects.toThrow(
      'Invalid storage key',
    );
    await expect(store.get('daily-exception/../../x')).rejects.toThrow('Invalid storage key');
  });
});
