import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import process from 'process'
import { fileURLToPath } from 'url'

const serverJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js')

// A port held by someone else: the server must say why, and stop with an error
// (in Solo the app then starts it again on other ports), not hang or crash mutely.
describe('a port that is taken', () => {
  it('logs EADDRINUSE and exits non-zero', async () => {
    const holder = net.createServer()
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve))
    const port = holder.address().port
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-listen-'))
    try {
      const child = spawn(process.execPath, [serverJs], {
        env: { ...process.env, SOLO: '1', PORT: String(port), DATA_DIR: dataDir, ACCESS_KEY: '', CAST_PORT: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout.on('data', (c) => { out += c })
      child.stderr.on('data', (c) => { out += c })
      const code = await new Promise((resolve) => {
        const t = setTimeout(() => { child.kill(); resolve('timeout') }, 20_000)
        child.on('exit', (c) => { clearTimeout(t); resolve(c) })
      })
      expect(code).toBe(1)
      expect(out).toContain('EADDRINUSE')
      expect(out).toContain(`can't listen on 127.0.0.1:${port} (EADDRINUSE)`)
    } finally {
      holder.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})
