// A real `redis-server` behind an Upstash-REST-shaped endpoint, for
// scripts/chunk-store-test.ts.
//
// scripts/upstash-fake.mjs reimplements the store's compare-and-set in
// JavaScript, which proves the contract but never compiles the Lua — so a
// script real Redis would reject (an unescaped newline in the pattern, say)
// passed the suite. This runs the actual script on the actual server.
//
// The translation is generic: whatever command array the Upstash client posts
// is forwarded verbatim as RESP and whatever comes back is returned as
// `{ result }` or `{ error }`. There is no per-command logic here at all, which
// is what makes it worth trusting.
//
// Skipped, not failed, when `redis-server` is not on PATH: it is a local
// convenience, and CI without it still gets the fake.

import { createServer } from 'node:http'
import { createServer as createSocketServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

/** Whether a real server can be started at all. */
export function hasRedisServer() {
  const found = spawn('sh', ['-c', 'command -v redis-server'], { stdio: 'ignore' })
  return once(found, 'exit').then(([code]) => code === 0)
}

async function freePort() {
  const probe = createSocketServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

/* -------------------------------------------------------------------------- */
/* RESP                                                                       */
/* -------------------------------------------------------------------------- */

function encodeCommand(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)]
  for (const arg of args) {
    const value = Buffer.from(String(arg), 'utf8')
    parts.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'))
  }
  return Buffer.concat(parts)
}

/** One RESP2 reply out of `buf` starting at `at`, or null if it is not all here
 *  yet. Errors come back as `{ error }` so they can be forwarded as-is. */
function parseReply(buf, at) {
  const end = buf.indexOf('\r\n', at)
  if (end < 0) return null
  const type = String.fromCharCode(buf[at])
  const head = buf.toString('utf8', at + 1, end)
  const after = end + 2
  switch (type) {
    case '+':
      return { value: head, next: after }
    case '-':
      return { value: { error: head }, next: after }
    case ':':
      return { value: Number(head), next: after }
    case '$': {
      const length = Number(head)
      if (length < 0) return { value: null, next: after }
      if (buf.length < after + length + 2) return null
      return { value: buf.toString('utf8', after, after + length), next: after + length + 2 }
    }
    case '*': {
      const count = Number(head)
      if (count < 0) return { value: null, next: after }
      const items = []
      let cursor = after
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf, cursor)
        if (!item) return null
        items.push(item.value)
        cursor = item.next
      }
      return { value: items, next: cursor }
    }
    default:
      throw new Error(`redis-rest: unsupported RESP type ${type}`)
  }
}

/** One connection, one command at a time. The shim serves a test, not a load. */
function connect(port) {
  const socket = createConnection({ port, host: '127.0.0.1' })
  let buf = Buffer.alloc(0)
  const waiting = []
  socket.on('data', (data) => {
    buf = Buffer.concat([buf, data])
    for (;;) {
      if (!waiting.length || !buf.length) return
      let reply
      try {
        reply = parseReply(buf, 0)
      }
      catch (error) {
        waiting.shift().reject(error)
        return
      }
      if (!reply) return
      buf = buf.subarray(reply.next)
      waiting.shift().resolve(reply.value)
    }
  })
  return {
    ready: once(socket, 'connect'),
    send(args) {
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject })
        socket.write(encodeCommand(args))
      })
    },
    close: () => new Promise(resolve => socket.end(resolve)),
  }
}

/* -------------------------------------------------------------------------- */
/* REST                                                                       */
/* -------------------------------------------------------------------------- */

const encode = (value) => {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64')
  if (Array.isArray(value)) return value.map(encode)
  return value
}

/**
 * Start a real Redis and the REST endpoint in front of it. Resolves to
 * `{ url, token, close }`, or to null when `redis-server` is not installed.
 */
export async function startRealRedis({ token = 'real-token' } = {}) {
  if (!(await hasRedisServer())) return null

  const redisPort = await freePort()
  // `--save ''` keeps it purely in memory: no dump file next to the repo.
  const server = spawn('redis-server', ['--port', String(redisPort), '--save', '', '--appendonly', 'no'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const up = new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error('redis-rest: redis-server did not start in time')), 10_000)
    server.stdout.on('data', (data) => {
      if (String(data).includes('Ready to accept connections')) {
        clearTimeout(fail)
        resolve()
      }
    })
    server.once('error', reject)
    server.once('exit', code => reject(new Error(`redis-rest: redis-server exited with ${code}`)))
  })
  await up

  const client = connect(redisPort)
  await client.ready

  const http = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const reply = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' })
      let commands
      try {
        commands = JSON.parse(body || 'null')
      }
      catch {
        return reply(400, { error: 'bad json' })
      }
      const base64 = String(req.headers['upstash-encoding'] ?? '') === 'base64'
      const one = async (command) => {
        try {
          const result = await client.send(command)
          if (result && typeof result === 'object' && !Array.isArray(result) && 'error' in result) {
            return { error: result.error }
          }
          return { result: base64 ? encode(result) : result }
        }
        catch (error) {
          return { error: String(error?.message ?? error) }
        }
      }
      const work = req.url?.endsWith('/pipeline')
        ? Promise.all((commands ?? []).map(one))
        : one(commands ?? [])
      work.then(payload => reply(200, payload), error => reply(500, { error: String(error?.message ?? error) }))
    })
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')

  return {
    url: `http://127.0.0.1:${http.address().port}`,
    token,
    async close() {
      await new Promise(resolve => http.close(resolve))
      await client.close()
      server.kill('SIGKILL')
      await once(server, 'exit').catch(() => {})
    },
  }
}
