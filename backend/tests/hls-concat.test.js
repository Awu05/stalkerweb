import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
const { hlsConcat } = require('../downloads/hlsConcat');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlsc-'));
afterEach(() => { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true }); });

// A fake fetch over { url: string | Buffer }.
function fakeFetch(files, seen = []) {
  return async (url, { signal } = {}) => {
    seen.push(url);
    if (signal?.aborted) throw new Error('aborted');
    const body = files[url];
    if (body === undefined) return { ok: false, status: 404, url };
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return {
      ok: true, status: 200, url,
      text: async () => buf.toString('utf8'),
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(buf)); c.close(); } }),
    };
  };
}
const media = (uris, extra = '') => `#EXTM3U\n#EXT-X-TARGETDURATION:4\n${extra}${uris.map((u) => `#EXTINF:4,\n${u}\n`).join('')}#EXT-X-ENDLIST\n`;

describe('hlsConcat', () => {
  it("joins a VOD playlist's segments, in order, into one file", async () => {
    const a = Buffer.from([1, 2, 3]); const b = Buffer.from([4, 5]); const c = Buffer.from([6]);
    const fetchImpl = fakeFetch({ 'http://h.example/v.m3u8': media(['a.ts', 'b.ts', 'c.ts']),
      'http://h.example/a.ts': a, 'http://h.example/b.ts': b, 'http://h.example/c.ts': c });
    const out = path.join(dir, 'o.ts'); let n = 0;
    await hlsConcat('http://h.example/v.m3u8', out, { fetchImpl, onBytes: (k) => { n += k; } });
    expect(fs.readFileSync(out)).toEqual(Buffer.concat([a, b, c]));
    expect(n).toBe(6);
  });

  it('downloads the highest-bandwidth variant of a master playlist', async () => {
    const seen = [];
    const fetchImpl = fakeFetch({
      'http://h.example/m.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9000\nhigh/hi.m3u8\n',
      'http://h.example/high/hi.m3u8': media(['s.ts']), 'http://h.example/high/s.ts': Buffer.from([9]),
    }, seen);
    const out = path.join(dir, 'o.ts');
    await hlsConcat('http://h.example/m.m3u8', out, { fetchImpl });
    expect(fs.readFileSync(out)).toEqual(Buffer.from([9]));
    expect(seen).not.toContain('http://h.example/low.m3u8');
  });

  it('refuses an encrypted playlist with a clear message', async () => {
    const fetchImpl = fakeFetch({ 'http://h.example/e.m3u8': media(['a.ts'], '#EXT-X-KEY:METHOD=AES-128,URI="k"\n') });
    await expect(hlsConcat('http://h.example/e.m3u8', path.join(dir, 'o.ts'), { fetchImpl })).rejects.toThrow(/encrypted/i);
  });

  it('accepts METHOD=NONE', async () => {
    const fetchImpl = fakeFetch({ 'http://h.example/e.m3u8': media(['a.ts'], '#EXT-X-KEY:METHOD=NONE\n'), 'http://h.example/a.ts': Buffer.from([7]) });
    const out = path.join(dir, 'o.ts');
    await hlsConcat('http://h.example/e.m3u8', out, { fetchImpl });
    expect(fs.readFileSync(out)).toEqual(Buffer.from([7]));
  });

  it('resolves relative segment URLs against the playlist', async () => {
    const fetchImpl = fakeFetch({ 'http://h.example/a/b/v.m3u8': media(['../s1.ts', '/root/s2.ts', 'http://other.example/s3.ts']),
      'http://h.example/a/s1.ts': Buffer.from([1]), 'http://h.example/root/s2.ts': Buffer.from([2]), 'http://other.example/s3.ts': Buffer.from([3]) });
    const out = path.join(dir, 'o.ts');
    await hlsConcat('http://h.example/a/b/v.m3u8', out, { fetchImpl });
    expect(fs.readFileSync(out)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('stops when aborted, fetching no more segments', async () => {
    const ctrl = new AbortController();
    const seen = [];
    const fetchImpl = fakeFetch({ 'http://h.example/v.m3u8': media(['a.ts', 'b.ts']), 'http://h.example/a.ts': Buffer.from([1]), 'http://h.example/b.ts': Buffer.from([2]) }, seen);
    const out = path.join(dir, 'o.ts');
    await expect(hlsConcat('http://h.example/v.m3u8', out, { fetchImpl, signal: ctrl.signal, onBytes: () => ctrl.abort() })).rejects.toThrow();
    expect(seen).not.toContain('http://h.example/b.ts');
  });
});
