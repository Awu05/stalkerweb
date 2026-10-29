/* global ReadableStream */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// Loaded the way DownloadManager loads FfmpegService (one shared CJS instance),
// so stubbing isAvailable here is what the manager sees.
const require = createRequire(import.meta.url);
const DownloadManager = require('../downloads/DownloadManager');
const FfmpegService = require('../stalker/FfmpegService');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const waitDone = (m) => new Promise((resolve) => {
  const check = () => { const j = m.list()[0]; if (j && (j.status === 'done' || j.status === 'error')) resolve(j); };
  m.on('update', check); check();
});

describe('DownloadManager HLS without ffmpeg', () => {
  it('saves an HLS title as .ts', async () => {
    vi.spyOn(FfmpegService, 'isAvailable').mockReturnValue(false);
    const files = { 'http://h.example/v.m3u8': '#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n', 'http://h.example/a.ts': Buffer.from([1, 2, 3]) };
    vi.stubGlobal('fetch', async (url) => {
      const b = Buffer.from(files[url]);
      return { ok: true, status: 200, url, text: async () => b.toString(), body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } }) };
    });
    const m = new DownloadManager({ vodManager: { getStreamUrl: async () => 'http://h.example/v.m3u8' }, client: null }, () => dir);
    m.enqueue([{ videoId: '1', title: 'Hls Movie' }]);
    const job = await waitDone(m);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(job.filePath).toBe(path.join(dir, 'Hls Movie.ts'));
    expect(fs.readFileSync(job.filePath)).toEqual(Buffer.from([1, 2, 3]));
    expect(fs.existsSync(job.filePath + '.part')).toBe(false);
    expect(JSON.parse(JSON.stringify(m.list()[0])).filePath).toBe(job.filePath);
  });

  it('leaves no file behind when the HLS download fails', async () => {
    vi.spyOn(FfmpegService, 'isAvailable').mockReturnValue(false);
    vi.stubGlobal('fetch', async (url) => ({ ok: true, status: 200, url, text: async () => '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\na.ts\n' }));
    const m = new DownloadManager({ vodManager: { getStreamUrl: async () => 'http://h.example/enc.m3u8' }, client: null }, () => dir);
    m.enqueue([{ videoId: '2', title: 'Enc Movie' }]);
    const job = await waitDone(m);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/encrypted/i);
    expect(fs.existsSync(path.join(dir, 'Enc Movie.ts.part'))).toBe(false);
  });

  it('stops and leaves no file when a running HLS download is canceled', async () => {
    vi.spyOn(FfmpegService, 'isAvailable').mockReturnValue(false);
    const sub = fs.mkdtempSync(path.join(dir, 'cancel-'));
    let firstPiece;
    const started = new Promise((r) => { firstPiece = r; });
    vi.stubGlobal('fetch', async (url, { signal } = {}) => {
      if (url.endsWith('.m3u8')) return { ok: true, status: 200, url, text: async () => '#EXTM3U\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST\n' };
      if (url.endsWith('/a.ts')) return { ok: true, status: 200, url, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }) };
      // The second piece sends a little, then nothing until it's stopped.
      return { ok: true, status: 200, url, body: new ReadableStream({ start(c) {
        c.enqueue(new Uint8Array([4]));
        signal?.addEventListener('abort', () => { try { c.error(new Error('aborted')); } catch { /* closed */ } });
        firstPiece();
      } }) };
    });
    const m = new DownloadManager({ vodManager: { getStreamUrl: async () => 'http://h.example/v.m3u8' }, client: null }, () => sub);
    const [job] = m.enqueue([{ videoId: '5', title: 'Stopped Movie' }]);
    await started;
    await new Promise((r) => setTimeout(r, 20));   // its bytes are in the .part file
    expect(fs.readdirSync(sub)).toEqual(['Stopped Movie.ts.part']);
    expect(job.totalBytes).toBe(6);   // the first piece's size times two: the bar has a total
    const gone = new Promise((resolve) => m.on('update', () => { if (!m.list().length) resolve(); }));
    expect(m.remove(job.id)).toBe(true);
    await gone;
    expect(fs.readdirSync(sub)).toEqual([]);
    expect(m.hasActive()).toBe(false);
  });

  it('gives an HLS download a total, and marks pieces a live window lost', async () => {
    vi.spyOn(FfmpegService, 'isAvailable').mockReturnValue(false);
    const sub = fs.mkdtempSync(path.join(dir, 'total-'));
    let reads = 0;
    vi.stubGlobal('fetch', async (url) => {
      if (url.endsWith('.m3u8')) {
        const from = reads++ ? 4 : 0;   // s2, s3 were gone by the second read
        const text = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${from}\n#EXTINF:1,\ns${from}.ts\n#EXTINF:1,\ns${from + 1}.ts\n${from ? '#EXT-X-ENDLIST\n' : ''}`;
        return { ok: true, status: 200, url, text: async () => text };
      }
      return { ok: true, status: 200, url, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }) };
    });
    const m = new DownloadManager({ vodManager: { getStreamUrl: async () => 'http://h.example/live.m3u8' }, client: null }, () => sub);
    m.enqueue([{ videoId: '6', title: 'Live Thing' }]);
    const job = await waitDone(m);
    expect(job.status).toBe('done');
    expect(job.totalBytes).toBe(40);
    expect(job.missedPieces).toBe(2);
    expect(fs.readFileSync(job.filePath).length).toBe(40);
  });

  it("says whether a download is queued or running (for Solo's keep-alive)", () => {
    const m = new DownloadManager({}, () => dir);
    expect(m.hasActive()).toBe(false);
    const [job] = m.enqueue([{ videoId: '4', title: 'Busy' }]);
    m._queue = [];
    for (const [status, busy] of [['queued', true], ['downloading', true], ['done', false], ['error', false], ['canceled', false]]) {
      job.status = status;
      expect(m.hasActive(), status).toBe(busy);
    }
  });

  it('removes a finished download whose file was already moved away', () => {
    const m = new DownloadManager({}, () => dir);
    const [job] = m.enqueue([{ videoId: '3', title: 'Gone' }]);
    m._queue = [];
    Object.assign(job, { status: 'done', filePath: path.join(dir, 'moved.ts') });
    expect(() => m.remove(job.id)).not.toThrow();
    expect(m.list()).toHaveLength(0);
  });
});
