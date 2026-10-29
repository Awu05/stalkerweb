/* global ReadableStream, AbortController */
import { describe, it, expect, afterEach, vi } from 'vitest';
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

  it('follows a playlist that is still growing until #EXT-X-ENDLIST: every piece, in order, once', async () => {
    // An EVENT playlist: two pieces more each time it's read, then the end.
    let reads = 0;
    const seen = [];
    const all = ['s0.ts', 's1.ts', 's2.ts', 's3.ts', 's4.ts', 's5.ts', 's6.ts'];
    const fetchImpl = async (url, { signal } = {}) => {
      seen.push(url);
      if (signal?.aborted) throw new Error('aborted');
      const name = url.split('/').pop();
      if (name === 'live.m3u8') {
        const n = Math.min(all.length, 3 + 2 * reads++);
        const text = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n'
          + all.slice(0, n).map((u) => `#EXTINF:1,\n${u}\n`).join('') + (n === all.length ? '#EXT-X-ENDLIST\n' : '');
        return { ok: true, status: 200, url, text: async () => text };
      }
      const i = all.indexOf(name);
      if (i < 0) return { ok: false, status: 404, url };
      return { ok: true, status: 200, url, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([i])); c.close(); } }) };
    };
    const out = path.join(dir, 'o.ts');
    await hlsConcat('http://h.example/live.m3u8', out, { fetchImpl, pollMs: 5 });
    expect(fs.readFileSync(out)).toEqual(Buffer.from([0, 1, 2, 3, 4, 5, 6]));
    for (const u of all) expect(seen.filter((x) => x.endsWith(`/${u}`))).toHaveLength(1);
    expect(reads).toBe(3);
  });

  it('follows a live playlist whose window slides, by its media sequence', async () => {
    let reads = 0;
    const fetchImpl = async (url) => {
      const name = url.split('/').pop();
      if (name === 'live.m3u8') {
        const from = reads++;   // the window moves on one each read
        const text = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${from}\n`
          + [0, 1, 2].map((k) => `#EXTINF:1,\ns${from + k}.ts\n`).join('') + (from === 4 ? '#EXT-X-ENDLIST\n' : '');
        return { ok: true, status: 200, url, text: async () => text };
      }
      const k = Number(/^s(\d+)\.ts$/.exec(name)[1]);
      return { ok: true, status: 200, url, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([k])); c.close(); } }) };
    };
    const out = path.join(dir, 'o.ts');
    await hlsConcat('http://h.example/live.m3u8', out, { fetchImpl, pollMs: 5 });
    expect(fs.readFileSync(out)).toEqual(Buffer.from([0, 1, 2, 3, 4, 5, 6]));
  });

  it('gives up on a live playlist that stops growing, and leaves no file', async () => {
    const fetchImpl = fakeFetch({ 'http://h.example/live.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\na.ts\n', 'http://h.example/a.ts': Buffer.from([1]) });
    const out = path.join(dir, 'o.ts');
    await expect(hlsConcat('http://h.example/live.m3u8', out, { fetchImpl, pollMs: 5, stallMs: 60 })).rejects.toThrow(/stopped growing/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('gives up on a live playlist that never ends', async () => {
    let reads = 0;
    const fetchImpl = async (url) => {
      if (url.endsWith('.m3u8')) {
        const n = ++reads;
        return { ok: true, status: 200, url, text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:1\n' + Array.from({ length: n }, (_, k) => `#EXTINF:1,\ns${k}.ts\n`).join('') };
      }
      return { ok: true, status: 200, url, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }) };
    };
    await expect(hlsConcat('http://h.example/live.m3u8', path.join(dir, 'o.ts'), { fetchImpl, pollMs: 5, maxMs: 80 })).rejects.toThrow(/never ended/);
  });

  it('fetches #EXT-X-BYTERANGE pieces by their range', async () => {
    const file = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const ranges = [];
    const fetchImpl = async (url, { headers = {} } = {}) => {
      if (url.endsWith('.m3u8')) {
        return { ok: true, status: 200, url, text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:4\n'
          + '#EXTINF:4,\n#EXT-X-BYTERANGE:3@2\nall.ts\n'     // bytes 2 to 4
          + '#EXTINF:4,\n#EXT-X-BYTERANGE:4\nall.ts\n'       // on from there: 5 to 8
          + '#EXTINF:4,\n#EXT-X-BYTERANGE:2@0\nall.ts\n'     // 0 and 1
          + '#EXT-X-ENDLIST\n' };
      }
      const r = /^bytes=(\d+)-(\d+)$/.exec(headers.Range ?? '');
      ranges.push(headers.Range);
      const part = r ? file.subarray(Number(r[1]), Number(r[2]) + 1) : file;
      return { ok: true, status: r ? 206 : 200, url, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(part)); c.close(); } }) };
    };
    const out = path.join(dir, 'o.ts');
    await hlsConcat('http://h.example/v.m3u8', out, { fetchImpl });
    expect(ranges).toEqual(['bytes=2-4', 'bytes=5-8', 'bytes=0-1']);
    expect(fs.readFileSync(out)).toEqual(Buffer.from([2, 3, 4, 5, 6, 7, 8, 0, 1]));
  });

  it('takes a byte range out of the whole file when the server ignores Range', async () => {
    const file = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const fetchImpl = async (url) => {
      if (url.endsWith('.m3u8')) return { ok: true, status: 200, url, text: async () => '#EXTM3U\n#EXTINF:4,\n#EXT-X-BYTERANGE:3@4\nall.ts\n#EXT-X-ENDLIST\n' };
      return { ok: true, status: 200, url, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(file.subarray(0, 5))); c.enqueue(new Uint8Array(file.subarray(5))); c.close(); } }) };
    };
    const out = path.join(dir, 'o.ts');
    await hlsConcat('http://h.example/v.m3u8', out, { fetchImpl });
    expect(fs.readFileSync(out)).toEqual(Buffer.from([4, 5, 6]));
  });

  it('refuses a title whose sound is a separate track, rather than save it silent', async () => {
    const seen = [];
    const fetchImpl = fakeFetch({
      'http://h.example/m.m3u8': '#EXTM3U\n'
        + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=9000,AUDIO="aud"\nvideo/hi.m3u8\n',
      'http://h.example/video/hi.m3u8': media(['s.ts']), 'http://h.example/video/s.ts': Buffer.from([9]),
    }, seen);
    const out = path.join(dir, 'o.ts');
    await expect(hlsConcat('http://h.example/m.m3u8', out, { fetchImpl })).rejects.toThrow(/sound is a separate track.*without FFmpeg/i);
    expect(seen).not.toContain('http://h.example/video/s.ts');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('saves a title whose audio group is in the video itself (no URI)', async () => {
    const fetchImpl = fakeFetch({
      'http://h.example/m.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=9000,AUDIO="aud"\nhi.m3u8\n',
      'http://h.example/hi.m3u8': media(['s.ts']), 'http://h.example/s.ts': Buffer.from([9]),
    });
    const out = path.join(dir, 'o.ts');
    await hlsConcat('http://h.example/m.m3u8', out, { fetchImpl });
    expect(fs.readFileSync(out)).toEqual(Buffer.from([9]));
  });

  it('says how big the file will be: from the pieces so far, or exactly from byte ranges', async () => {
    const fetchImpl = fakeFetch({ 'http://h.example/v.m3u8': media(['a.ts', 'b.ts', 'c.ts', 'd.ts']),
      'http://h.example/a.ts': Buffer.alloc(10), 'http://h.example/b.ts': Buffer.alloc(30),
      'http://h.example/c.ts': Buffer.alloc(20), 'http://h.example/d.ts': Buffer.alloc(20) });
    const totals = [];
    await hlsConcat('http://h.example/v.m3u8', path.join(dir, 'o.ts'), { fetchImpl, onTotal: (t) => totals.push(t) });
    // After each piece: the average so far, times the 4 pieces; at the end, the size.
    expect(totals).toEqual([40, 80, 80, 80]);

    const ranged = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n#EXT-X-BYTERANGE:3@0\nall.ts\n#EXTINF:4,\n#EXT-X-BYTERANGE:5\nall.ts\n#EXT-X-ENDLIST\n';
    const t2 = [];
    await hlsConcat('http://h.example/r.m3u8', path.join(dir, 'r.ts'), {
      fetchImpl: fakeFetch({ 'http://h.example/r.m3u8': ranged, 'http://h.example/all.ts': Buffer.alloc(8) }), onTotal: (t) => t2.push(t) });
    expect(t2[0]).toBe(8);   // known before a byte comes
  });

  it('writes the rest of a chunk the file took only part of', async () => {
    const real = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const h = await real(...args);
      const write = h.write.bind(h);
      // At most 2 bytes a write, as a full disk or a pipe may do.
      h.write = (buf, off, len, pos) => write(buf, off, Math.min(len, 2), pos);
      return h;
    });
    const a = Buffer.from([1, 2, 3, 4, 5]);
    const fetchImpl = fakeFetch({ 'http://h.example/v.m3u8': media(['a.ts', 'b.ts']), 'http://h.example/a.ts': a, 'http://h.example/b.ts': Buffer.from([6, 7, 8]) });
    const out = path.join(dir, 'o.ts');
    await hlsConcat('http://h.example/v.m3u8', out, { fetchImpl });
    vi.restoreAllMocks();
    expect(fs.readFileSync(out)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it('says so when a live window moved on past pieces it had no time to fetch', async () => {
    let reads = 0;
    const fetchImpl = async (url) => {
      const name = url.split('/').pop();
      if (name === 'live.m3u8') {
        const from = [0, 5][reads++] ?? 5;   // s3, s4 were listed only while s0…s2 were fetched
        const text = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${from}\n`
          + [0, 1, 2].map((k) => `#EXTINF:1,\ns${from + k}.ts\n`).join('') + (from === 5 ? '#EXT-X-ENDLIST\n' : '');
        return { ok: true, status: 200, url, text: async () => text };
      }
      const k = Number(/^s(\d+)\.ts$/.exec(name)[1]);
      return { ok: true, status: 200, url, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([k])); c.close(); } }) };
    };
    const gaps = [];
    const out = path.join(dir, 'o.ts');
    await hlsConcat('http://h.example/live.m3u8', out, { fetchImpl, pollMs: 5, onGap: (n) => gaps.push(n) });
    expect(fs.readFileSync(out)).toEqual(Buffer.from([0, 1, 2, 5, 6, 7]));
    expect(gaps).toEqual([2]);
  });
});
