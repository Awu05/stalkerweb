// DownloadManager.js
// Sequential "download to server disk" queue for VOD movies/episodes.
// One download runs at a time (mirrors the "one connection per token" rule
// documented in routes/proxy.js — VOD CDNs stall a second concurrent
// connection using the same resolved link) with live progress reported over
// GET /api/downloads/events.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn: spawnProcess } = require('child_process');
const EventEmitter = require('events');
const FfmpegService = require('../stalker/FfmpegService');
const { hlsConcat } = require('./hlsConcat');
const log = require('../logger');
const TAG = 'downloads';

function sanitizeFilename(name) {
  const cleaned = String(name || 'download').replace(/[/\\?%*:|"<>]/g, '_').trim();
  return cleaned.slice(0, 200) || 'download';
}

class DownloadManager extends EventEmitter {
  // getDownloadDir: () => absolute directory path, read fresh on every
  // download so a Settings change takes effect without a restart.
  constructor(appState, getDownloadDir) {
    super();
    this.appState = appState;
    this.getDownloadDir = getDownloadDir;
    this._jobs = new Map();        // id → job
    this._queue = [];              // ids waiting to run, FIFO
    this._activeId = null;
    this._controllers = new Map(); // id → AbortController (for cancel)
  }

  list() {
    return [...this._jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Whether a download is queued or running (Solo's app keeps the server up for it). */
  hasActive() {
    for (const j of this._jobs.values()) if (j.status === 'queued' || j.status === 'downloading') return true;
    return false;
  }

  // items: [{ videoId, cmd, series, seasonId, episodeId, title, seriesTitle }]
  enqueue(items) {
    const created = [];
    for (const item of items || []) {
      if (!item?.videoId || !item?.title) continue;
      const id = crypto.randomUUID();
      const job = {
        id,
        videoId:         String(item.videoId),
        cmd:             item.cmd || '',
        series:          parseInt(item.series, 10) || 0,
        seasonId:        item.seasonId || '',
        episodeId:       item.episodeId || '',
        title:           String(item.title),
        seriesTitle:     item.seriesTitle || '',
        status:          'queued', // queued | downloading | done | error | canceled
        bytesDownloaded: 0,
        totalBytes:      0,
        error:           null,
        filePath:        null,
        createdAt:       Date.now(),
      };
      this._jobs.set(id, job);
      this._queue.push(id);
      created.push(job);
    }
    if (created.length) this._emitUpdate();
    this._runNext();
    return created;
  }

  // Cancels a queued or in-flight job, or removes a finished/errored one.
  remove(id) {
    const job = this._jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      this._queue = this._queue.filter(qid => qid !== id);
      this._jobs.delete(id);
      this._emitUpdate();
      return true;
    }
    if (job.status === 'downloading') {
      this._controllers.get(id)?.abort();
      return true; // job removed once the abort unwinds, in _runNext's finally
    }
    this._jobs.delete(id);
    this._emitUpdate();
    return true;
  }

  _emitUpdate() {
    this.emit('update', this.list());
  }

  async _runNext() {
    if (this._activeId) return; // already processing one — sequential by design
    const id = this._queue.shift();
    if (!id) return;
    const job = this._jobs.get(id);
    if (!job) { this._runNext(); return; }

    this._activeId = id;
    job.status = 'downloading';
    this._emitUpdate();

    const controller = new AbortController();
    this._controllers.set(id, controller);
    let tmpPath = null;

    try {
      const { vodManager, client } = this.appState;
      if (!vodManager) throw new Error('VOD not available — connect to a portal first');

      const streamUrl = await vodManager.getStreamUrl(job.videoId, job.cmd || null, job.series, {
        seasonId: job.seasonId, episodeId: job.episodeId,
      });
      if (!streamUrl) throw new Error('Could not resolve stream URL');

      const cleanUrl = streamUrl.split('?')[0].split('#')[0];
      const isHls = /\.(m3u8?|m3u)$/i.test(cleanUrl);
      // HLS: ffmpeg remuxes it to .mp4 when it's there (the Docker server);
      // without it (the Solo app) the pieces are joined into one .ts file.
      const useFfmpeg = isHls && FfmpegService.isAvailable();

      const dir = this.getDownloadDir();
      fs.mkdirSync(dir, { recursive: true });
      const ext  = isHls ? (useFfmpeg ? 'mp4' : 'ts') : (cleanUrl.match(/\.([a-z0-9]{2,4})$/i)?.[1] || 'mp4').toLowerCase();
      const base = sanitizeFilename(job.seriesTitle ? `${job.seriesTitle} - ${job.title}` : job.title);
      let filePath = path.join(dir, `${base}.${ext}`);
      let n = 1;
      while (fs.existsSync(filePath)) filePath = path.join(dir, `${base} (${n++}).${ext}`);
      tmpPath = filePath + '.part';

      const headers = client?.streamHeadersFor ? client.streamHeadersFor(streamUrl) : {};

      if (useFfmpeg) {
        await this._downloadWithFfmpeg(streamUrl, headers, tmpPath, job, controller);
      } else if (isHls) {
        let lastEmit = 0;
        await hlsConcat(streamUrl, tmpPath, {
          headers, signal: controller.signal,
          onBytes: (n) => {
            job.bytesDownloaded += n;
            const now = Date.now();
            if (now - lastEmit > 500) { lastEmit = now; this._emitUpdate(); }
          },
        });
      } else {
        const http = client?.getHttpClient ? client.getHttpClient() : require('axios');

        const response = await http.get(streamUrl, {
          headers, responseType: 'stream', signal: controller.signal, validateStatus: () => true,
        });
        if (response.status >= 400) throw new Error(`Server returned HTTP ${response.status}`);

        job.totalBytes = parseInt(response.headers['content-length'] || '0', 10) || 0;

        const writeStream = fs.createWriteStream(tmpPath);
        let lastEmit = 0;
        await new Promise((resolve, reject) => {
          response.data.on('data', chunk => {
            job.bytesDownloaded += chunk.length;
            const now = Date.now();
            // Throttle progress broadcasts — don't flood every SSE subscriber per chunk.
            if (now - lastEmit > 500) { lastEmit = now; this._emitUpdate(); }
          });
          response.data.on('error', reject);
          writeStream.on('error', reject);
          writeStream.on('finish', resolve);
          response.data.pipe(writeStream);
        });
      }

      fs.renameSync(tmpPath, filePath);
      tmpPath = null;
      job.status     = 'done';
      job.filePath   = filePath;
      job.totalBytes = job.totalBytes || job.bytesDownloaded;
      log.info(TAG, `downloaded "${job.title}" → ${filePath}`);
    } catch (e) {
      job.status = controller.signal.aborted ? 'canceled' : 'error';
      if (job.status === 'error') {
        job.error = e.message;
        log.error(TAG, `download failed for "${job.title}": ${e.message}`);
      }
    } finally {
      if (tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      }
      this._controllers.delete(id);
      this._activeId = null;
      if (job.status === 'canceled') this._jobs.delete(id); // canceled = removed, not kept around
      this._emitUpdate();
      this._runNext();
    }
  }

  // Remuxes an HLS (.m3u8) stream straight to a local .mp4 without re-encoding.
  // Progress has no known total (HLS doesn't expose a byte size up front), so
  // we just report bytes written so far — the UI shows an indeterminate bar
  // when totalBytes stays 0, same as any other unknown-length response.
  async _downloadWithFfmpeg(streamUrl, headers, tmpPath, job, controller) {
    const probe = await FfmpegService.probeCodecs(streamUrl, headers);
    const args = FfmpegService.buildDownloadArgs(streamUrl, headers, tmpPath, probe);
    log.info(TAG, `remuxing HLS via ffmpeg: ffmpeg ${args.join(' ')}`);

    await new Promise((resolve, reject) => {
      const ffmpeg = spawnProcess('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

      const statTimer = setInterval(() => {
        fs.stat(tmpPath, (err, st) => { if (!err) { job.bytesDownloaded = st.size; this._emitUpdate(); } });
      }, 1000);

      let stderrTail = '';
      ffmpeg.stderr.on('data', d => {
        stderrTail = (stderrTail + d.toString()).slice(-4000);
      });

      const onAbort = () => { try { ffmpeg.kill('SIGKILL'); } catch { /* already dead */ } };
      controller.signal.addEventListener('abort', onAbort);

      const cleanup = () => {
        clearInterval(statTimer);
        controller.signal.removeEventListener('abort', onAbort);
      };

      ffmpeg.on('error', (err) => { cleanup(); reject(err); });
      ffmpeg.on('close', (code) => {
        cleanup();
        if (controller.signal.aborted) { reject(new Error('aborted')); return; }
        if (code === 0) { resolve(); return; }
        const tail = stderrTail.split('\n').filter(Boolean).slice(-3).join(' | ');
        reject(new Error(`ffmpeg exited with code ${code}${tail ? `: ${tail}` : ''}`));
      });
    });
  }
}

module.exports = DownloadManager;
