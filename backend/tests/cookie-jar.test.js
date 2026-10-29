import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import axios from 'axios'
import { CookieJar, Cookie } from 'tough-cookie'
import { withCookieJar } from '../lib/cookieJarAxios.js'

// A tiny portal: /echo says which Cookie header it got; /login sets a cookie
// and redirects to /next, which sets another and redirects to /echo.
function portal(req, res) {
    if (req.url === '/echo') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ cookie: req.headers.cookie || '' }))
    }
    if (req.url === '/login') {
      res.writeHead(302, { location: '/next', 'set-cookie': ['sid=abc; Path=/'] })
      return res.end()
    }
    if (req.url === '/next') {
      res.writeHead(302, { location: '/echo', 'set-cookie': ['step=2; Path=/'] })
      return res.end()
    }
    if (req.url === '/area/start') {
      res.writeHead(302, { location: '/echo' })
      return res.end()
    }
    res.statusCode = 404
    res.end()
}
let server, base
beforeAll(async () => {
  server = http.createServer(portal)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise(r => server.close(r)))

// Whether this machine can listen on ::1 at all.
const ipv6 = await new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).listen(0, '::1', () => s.close(() => resolve(true)))
})

function client(jar) {
  return withCookieJar(axios.create({ jar, withCredentials: true, maxRedirects: 10 }), jar)
}

describe('cookie jar for axios', () => {
  it('sends the cookies seeded into the jar', async () => {
    const jar = new CookieJar()
    jar.setCookieSync(new Cookie({ key: 'mac', value: '00%3A1A%3A79%3A12%3A34%3A56' }), base, { ignoreError: true })
    jar.setCookieSync(new Cookie({ key: 'stb_lang', value: 'en' }), base, { ignoreError: true })
    const { data } = await client(jar).get(`${base}/echo`)
    expect(data.cookie).toContain('mac=00%3A1A%3A79%3A12%3A34%3A56')
    expect(data.cookie).toContain('stb_lang=en')
  })

  it('keeps cookies the portal sets, across a redirect', async () => {
    const jar = new CookieJar()
    const { data } = await client(jar).get(`${base}/login`)
    // Both hops' cookies reached the final request, and both are in the jar.
    expect(data.cookie).toContain('sid=abc')
    expect(data.cookie).toContain('step=2')
    expect(jar.getCookieStringSync(base)).toContain('sid=abc')
    expect(jar.getCookieStringSync(base)).toContain('step=2')
  })

  it("sends no Cookie after a same-host redirect to a path the jar's cookies aren't for", async () => {
    const jar = new CookieJar()
    jar.setCookieSync('area=1; Path=/area', base)
    const { data } = await client(jar).get(`${base}/area/start`)
    expect(data.cookie).toBe('')
  })

  it.skipIf(!ipv6)('works with a portal on an IPv6 address, across a redirect', async () => {
    const v6 = http.createServer(portal)
    await new Promise(r => v6.listen(0, '::1', r))
    try {
      const at = `http://[::1]:${v6.address().port}`
      const jar = new CookieJar()
      const { data } = await client(jar).get(`${at}/login`)
      expect(data.cookie).toContain('sid=abc')
      expect(data.cookie).toContain('step=2')
      expect(jar.getCookieStringSync(at)).toContain('step=2')
    } finally { await new Promise(r => v6.close(r)) }
  })
})
