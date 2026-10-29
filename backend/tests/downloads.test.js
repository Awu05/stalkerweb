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
