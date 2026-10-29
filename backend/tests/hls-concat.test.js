/* global ReadableStream, AbortController */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hlsConcat } from '../downloads/hlsConcat.js';

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
  // Answers from a list per URL, one per request: a Buffer, a status number,
  // 'cut' (part of the body, then an error) or 'stall' (part, then nothing).
  function flakyFetch(script, seen = []) {
    const calls = {};
    return async (url, { signal } = {}) => {
      seen.push(url);
      const list = script[url];
      if (list === undefined) return { ok: false, status: 404, url };
      const step = list[Math.min(calls[url] = (calls[url] ?? -1) + 1, list.length - 1)];
      if (typeof step === 'number') return { ok: false, status: step, url, body: null };
      if (typeof step === 'string') {
        if (step.startsWith('#')) return { ok: true, status: 200, url, text: async () => step };
        return {
          ok: true, status: 200, url,
          body: new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([0xee, 0xee]));   // bytes that must not stay in the file
              if (step === 'cut') setTimeout(() => c.error(new Error('connection reset')), 5);
              signal?.addEventListener('abort', () => { try { c.error(new Error('aborted')); } catch { /* closed */ } });
            },
          }),
        };
      }
      return { ok: true, status: 200, url, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(step)); c.close(); } }) };
    };
  }
  const quick = { retryDelaysMs: [0, 0] };

  it('fetches a piece that failed again, from its start — no bytes twice', async () => {
    const a = Buffer.from([1, 2, 3]); const b = Buffer.from([4, 5, 6, 7]); const c = Buffer.from([8]);
    const fetchImpl = flakyFetch({ 'http://h.example/v.m3u8': [media(['a.ts', 'b.ts', 'c.ts'])],
      'http://h.example/a.ts': [503, a], 'http://h.example/b.ts': ['cut', b], 'http://h.example/c.ts': [c] });
    const out = path.join(dir, 'o.ts'); let n = 0;
    await hlsConcat('http://h.example/v.m3u8', out, { fetchImpl, onBytes: (k) => { n += k; }, ...quick });
    expect(fs.readFileSync(out)).toEqual(Buffer.concat([a, b, c]));
    expect(n).toBe(8);   // the failed try's bytes taken back
  });

  it('gives up on a piece after 3 tries, saying which, and leaves no file', async () => {
    const seen = [];
    const fetchImpl = flakyFetch({ 'http://h.example/v.m3u8': [media(['a.ts', 'b.ts', 'c.ts'])],
      'http://h.example/a.ts': [Buffer.from([1])], 'http://h.example/b.ts': [500, 'cut', 502], 'http://h.example/c.ts': [Buffer.from([3])] }, seen);
    const out = path.join(dir, 'o.ts');
    await expect(hlsConcat('http://h.example/v.m3u8', out, { fetchImpl, ...quick })).rejects.toThrow(/segment 2 of 3 failed 3 times \(HTTP 502\)/);
    expect(seen.filter((u) => u.endsWith('/b.ts'))).toHaveLength(3);
    expect(seen).not.toContain('http://h.example/c.ts');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('gives up on a request that sends nothing for a while, and tries the piece again', async () => {
    const b = Buffer.from([4, 5]);
    const fetchImpl = flakyFetch({ 'http://h.example/v.m3u8': [media(['a.ts', 'b.ts'])],
      'http://h.example/a.ts': [Buffer.from([1])], 'http://h.example/b.ts': ['stall', b] });
    const out = path.join(dir, 'o.ts');
    const t0 = Date.now();
    await hlsConcat('http://h.example/v.m3u8', out, { fetchImpl, idleMs: 50, ...quick });
    expect(fs.readFileSync(out)).toEqual(Buffer.from([1, 4, 5]));
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
