/**
 * One loopback reverse proxy for a single remote origin (a DSH web app or a
 * :40005 monitoring panel). The browser only ever talks to 127.0.0.1:<port>,
 * which gives every instance its own origin (localStorage / cookies stay
 * isolated) and keeps remote credentials inside the Host process.
 * @module dsh-fleet/host/proxy
 */

import http from 'node:http'

const UPSTREAM_AGENT = new http.Agent({ keepAlive: true, maxSockets: 64 })

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** Parse a Cookie header into a plain name/value map. */
function cookieValues(header) {
  const out = new Map()
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    out.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  return out
}

/** Copy request headers for the upstream, dropping hop-by-hop and rewriting authority-sensitive ones. */
function upstreamHeaders(req, upstream, remoteCookie) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name)) continue
    if (name === 'host' || name === 'cookie' || name === 'origin' || name === 'referer') continue
    headers[name] = value
  }
  headers.host = upstream.host
  if (typeof req.headers.origin === 'string') headers.origin = upstream.origin
  if (typeof req.headers.referer === 'string') {
    try {
      const referer = new URL(req.headers.referer)
      headers.referer = upstream.origin + referer.pathname + referer.search
    } catch {
      // A malformed Referer is simply not forwarded.
    }
  }
  if (remoteCookie) headers.cookie = remoteCookie
  return headers
}

const STATIC_PATH = /(?:^\/assets\/|^\/plugins\/|\/static\/|\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|webp|svg|gif|ico|map)(?:\?|$))/u

/** Response headers minus values the proxy owns (Set-Cookie never leaks out, framing is recomputed). */
function downstreamHeaders(upstreamResponse, requestUrl) {
  const headers = {}
  for (const [name, value] of Object.entries(upstreamResponse.headers)) {
    if (value === undefined) continue
    if (name === 'set-cookie') continue
    if (name === 'transfer-encoding') continue
    if (name === 'connection') continue
    if (name === 'keep-alive') continue
    headers[name] = value
  }
  // DSH serves its own assets with revalidation headers; through a dedicated
  // proxy origin they can be cached immutably (names and ?rev= carry content).
  if (typeof requestUrl === 'string' && STATIC_PATH.test(requestUrl)) {
    // Only content-addressed URLs are safe to pin for a year; a plain `app.js`
    // may change under the same name (dashboards do), so keep those short-lived.
    const addressed = /[?&](?:rev|v|version|hash|h)=/u.test(requestUrl)
    headers['cache-control'] = addressed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'
  }
  return headers
}

/** Reject an unauthenticated local caller without touching the upstream. */
function deny(res) {
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end('dsh-fleet: proxy access key required\n')
}

/**
 * Start one proxy listener.
 * @param {object} options - listener and upstream description.
 * @param {string} options.id - instance id, used for the setup cookie name.
 * @param {number} options.port - preferred loopback port, 0 for any free port.
 * @param {string} options.upstreamUrl - http origin to forward to.
 * @param {string} options.key - per-process access key for this listener.
 * @param {() => string} options.getCookie - current remote cookie ('' for panels).
 * @param {string} options.label - log label.
 * @returns {Promise<{port:number, key:string, url:string, close:()=>Promise<void>}>}
 */
export async function startProxy({ id, port, upstreamUrl, key, getCookie, label }) {
  const upstream = new URL(upstreamUrl)
  const cookieName = `dsh-fleet-${id}`
  const tls = upstream.protocol === 'https:'
  if (tls) throw new Error('dsh-fleet: https upstreams are not supported yet')

  const authorized = (req) => {
    const values = cookieValues(req.headers.cookie)
    if (values.get(cookieName) === key) return true
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      return url.searchParams.get('k') === key
    } catch {
      return false
    }
  }

  const server = http.createServer((req, res) => {
    // A valid ?k= trades the one-time key for a host-only cookie, then redirects
    // to the same path without it, exactly like the DSH browser-token exchange.
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const presented = url.searchParams.get('k')
    if (presented !== null) {
      if (presented !== key) {
        deny(res)
        return
      }
      url.searchParams.delete('k')
      const location = `${url.pathname}${url.search}`
      // Cross-site iframes (`http://localhost:<port>` embeds) need SameSite=None,
      // which browsers only accept together with Secure — allowed on localhost.
      const crossSite = (req.headers.host ?? '').startsWith('localhost')
      res.writeHead(303, {
        'cache-control': 'no-store',
        'set-cookie': `${cookieName}=${key}; Path=/; HttpOnly; SameSite=${crossSite ? 'None; Secure' : 'Lax'}`,
        location: location === '' ? '/' : location,
      })
      res.end()
      return
    }
    if (!authorized(req)) {
      deny(res)
      return
    }
    const remoteCookie = getCookie()
    const upstreamRequest = http.request({
      hostname: upstream.hostname,
      port: upstream.port === '' ? 80 : Number(upstream.port),
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, upstream, remoteCookie),
      agent: UPSTREAM_AGENT,
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, downstreamHeaders(upstreamResponse, req.url))
      upstreamResponse.pipe(res)
      upstreamResponse.on('error', () => res.destroy())
    })
    upstreamRequest.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      }
      res.end(`dsh-fleet: upstream error: ${error.message}`)
    })
    req.on('aborted', () => upstreamRequest.destroy())
    req.pipe(upstreamRequest)
  })

  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
      return
    }
    const headers = upstreamHeaders(req, upstream, getCookie())
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const upstreamRequest = http.request({
      hostname: upstream.hostname,
      port: upstream.port === '' ? 80 : Number(upstream.port),
      method: req.method,
      path: req.url,
      headers,
      agent: UPSTREAM_AGENT,
    })
    upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      let head101 = 'HTTP/1.1 101 Switching Protocols\r\n'
      const raw = upstreamResponse.rawHeaders
      for (let i = 0; i < raw.length; i += 2) head101 += `${raw[i]}: ${raw[i + 1]}\r\n`
      socket.write(`${head101}\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('error', () => upstreamSocket.destroy())
    })
    upstreamRequest.on('response', (upstreamResponse) => {
      upstreamResponse.resume()
      socket.end(`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} Upgrade Rejected\r\nconnection: close\r\n\r\n`)
    })
    upstreamRequest.on('error', () => socket.destroy())
    upstreamRequest.end()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  let actualPort = port
  const address = server.address()
  if (address !== null && typeof address === 'object') actualPort = address.port
  const openSockets = new Set()
  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
  })
  const close = () => new Promise((resolve) => {
    for (const socket of openSockets) socket.destroy()
    openSockets.clear()
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
  return {
    port: actualPort,
    key,
    url: `http://127.0.0.1:${actualPort}/?k=${key}`,
    close,
  }
}

/** Reserve a preferred loopback port, falling back to an OS-assigned one. */
export async function reservePort(preferred) {
  if (!preferred) return 0
  const probe = http.createServer()
  const ok = await new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(preferred, '127.0.0.1', () => resolve(true))
  })
  if (!ok) return 0
  await new Promise((resolve) => probe.close(() => resolve()))
  return preferred
}
