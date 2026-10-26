import crypto from "crypto"
import querystring from 'querystring'
import fs from "fs"
import http from "http"
import httpProxy from "http-proxy"
import axios from "axios"

const MIN_I64 = -0x8000000000000000n
const MAX_I64 = 0x7FFFFFFFFFFFFFFFn
const MAX_U64 = 0xFFFFFFFFFFFFFFFFn
const FORWARD_URL = Symbol()
const CONFIG_VERSION = Symbol()
const SELF_HANDLE = Symbol()
const configFilePath = process.env.APIPROXY_CONFIG_FILE ?? 'apiproxy.conf'
const proxyPort = Number(process.env.APIPROXY_PORT ?? '8080')
const proxyTimeout = Number(process.env.APIPROXY_PROXY_TIMEOUT ?? '10000')
const timeout = Number(process.env.APIPROXY_TIMEOUT ?? '15000')
const maxBodySize = Number(process.env.APIPROXY_MAX_BODY_SIZE ?? '65536')
const httpAgent = new http.Agent({ keepAlive: true })

let shardedPathRegexp, globalPathRegexp
let enumeratePathRegexp, buildEnumeratePath, invalidPath
let reservePath, buildReservePath


class ConfigError extends Error {
  name = 'ConfigError'
}


class ParseError extends Error {
  name = 'ParseError'
}


class ServersTreeNode {
  serverUrl = undefined
  children = Array(2)

  matchShardingKey(shardingKey) {
    let node = this
    for (let i = 31; i >= 0; i--) {
      if (node.serverUrl !== undefined) return node.serverUrl
      node = node.children[(shardingKey & (1 << i)) >>> i]
      if (node === undefined) break
    }
    throw new Error('sharding key matching error')
  }
}


class ServerRoute {
  constructor(route, serverUrl) {
    this.route = ServerRoute.parseRoute(route)
    this.serverUrl = ServerRoute.parseServerUrl(serverUrl)
  }

  // Parses a route specifier, which resembles an RabbitMQ route. Route
  // specifiers consist of zero or more 0s or 1s, separated by dots, ending
  // with a hash symbol ("#"). For example: "1.0.0.1.#", or "#". The
  // function returns a string, containing the original route specifier, but
  // all the dots and the hash symbol are removed.
  static parseRoute(s) {
    if (typeof s === 'string') {
      const m = s.match(/^((?:[01]\.){0,20})\#$/)
      if (m) {
        return m[1].replaceAll('.', '')
      }
    }
    throw new ParseError("invalid route")
  }

  // Parses an HTTP URL. Returns the URL as a string.
  static parseServerUrl(s) {
    try {
      const url = new URL(s)
      if (url.protocol !== 'http:') throw 0
      return url.href
    } catch {
      throw new ParseError("invalid server URL")
    }
  }
}


class ServersConfig {
  constructor(serverRoutes, version) {
    this.serversTree = ServersConfig.buildServersTree(serverRoutes)
    this.serversMinIds = new Map()  // server URL -> smallest ID (a bigint)
    this.serversSuccessors = new Map()  // server URL -> next server's URL
    this.firstServerUrl = undefined  // the URL of the first server
    this.version = version
    const tree = this.serversTree
    const minIds = this.serversMinIds
    const urls = new Set(serverRoutes.map(r => r.serverUrl))
    for (let i = MIN_I64;; i++) {
      const serverUrl = tree.matchShardingKey(calcShardingKey(i))
      if (!minIds.has(serverUrl)) {
        if (this.firstServerUrl === undefined) this.firstServerUrl = serverUrl
        minIds.set(serverUrl, i)
        if (minIds.size === urls.size) break
      }
    }
    let url = this.firstServerUrl
    if (!urls.delete(url)) {
      throw new Error('assertion error')  // This should never happen.
    }
    for (let nextUrl of [...urls].sort()) {
      this.serversSuccessors.set(url, nextUrl)
      url = nextUrl
    }
    this.serversSuccessors.set(url, null)
  }

  // If the given path is "sharded", returns the URL of the server that is
  // responsible for it. If the given path is "global", returns an URL of a
  // randomly selected server, assuming that any server can do the job.
  // Returns `undefined` if none of these things works.
  findServerUrl(path) {
    let shardingKey
    const m = shardedPathRegexp && path.match(shardedPathRegexp)
    if (m) {
      try {
        shardingKey = calcShardingKey(...m.slice(1).map(x => parseI64(x)))
      } catch (e) {
        if (e instanceof ParseError) { /* ignore */ } else throw e
      }
    } else if (globalPathRegexp && path.match(globalPathRegexp)) {
      const random = BigInt(Math.floor(Math.random() * 1000000000))
      shardingKey = calcShardingKey(random)
    }
    return (
      shardingKey === undefined
        ? undefined
        : this.serversTree.matchShardingKey(shardingKey)
    )
  }

  // Builds a binary tree of servers, ensuring that every possible sharding
  // key is covered by exactly one server.
  static buildServersTree(serverRoutes) {
    let rootNode = new ServersTreeNode()
    for (let serverRoute of serverRoutes) {
      let currentNode = rootNode
      for (let zeroOrOne of serverRoute.route) {
        let children = currentNode.children
        if (children[zeroOrOne] === undefined) {
          children[zeroOrOne] = new ServersTreeNode()
        }
        currentNode = children[zeroOrOne]
      }
      if (currentNode.serverUrl === undefined) {
        currentNode.serverUrl = serverRoute.serverUrl
      } else {
        throw new ConfigError(`duplicated route "${this.dots(serverRoute.route)}"`)
      }
    }
    ServersConfig.verifyTreeNode(rootNode)
    return rootNode
  }

  static verifyTreeNode(node, route='') {
    const isLeafNode = node.serverUrl !== undefined
    for (let i of '01') {
      const child = node.children[i]
      if (isLeafNode) {
        // Leaf nodes should have no children.
        if (child !== undefined) {
          throw new ConfigError(`duplicated route "${this.dots(route + i)}"`)
        }
      } else {
        // Non-leaf nodes should have exactly 2 children.
        if (child === undefined) {
          throw new ConfigError(`missing route "${this.dots(route + i)}"`)
        }
        ServersConfig.verifyTreeNode(child, route + i)
      }
    }
  }

  static dots(s) {
    return s.split('').join('.')
  }
}


// Converts an I64 bigint to an U64 bigint, using two's complement.
function i2u(value) {
  if (typeof value !== 'bigint' || value > MAX_I64 || value < MIN_I64) {
    throw new Error('out of i64 range')
  }
  return value >= 0n ? value : value + MAX_U64 + 1n
}


// Return a random bigint between the given `min` and `max`. Min and max
// must be I64 integers.
function getRandomI64(min, max) {
  const span = max - min
  if (span < 0n || min < MIN_I64 || max > MAX_I64) {
    throw new Error('invalid interval')
  }
  const rnd = crypto.randomBytes(8)
  const view = new DataView(rnd.buffer)
  return min + view.getBigUint64() % (span + 1n)
}


// Parses a bigint, limited to i64's range. Numbers bigger than MAX_I64, but
// not bigger than MAX_U64, are converted to negative numbers using two's
// complement.
function parseI64(s) {
  let n
  if (s === '' || s === undefined) {
    throw new ParseError("not an integer")
  }
  try {
    n = BigInt(s)
  } catch {
    throw new ParseError("not an integer")
  }
  if (n > MAX_I64 && n <= MAX_U64) {
    n -= (MAX_U64 + 1n)
  }
  if (n > MAX_I64 || n < MIN_I64) {
    throw new ParseError("out of i64 range")
  }
  return n
}


// Converts an I64 bigint to 8 bytes.
function i64toData(n) {
  if (n > MAX_I64 || n < MIN_I64) {
    throw new Error("out of i64 range")
  }
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setBigInt64(0, n)
  return view
}


// Returns the highest 32 bits (as a number) of the MD5 digest of the passed
// arguments. The arguments must be i64 bigints. For example, if `first` is
// equal to `123n`, and `second` is equal to to `[ 456n ]`, the returned
// sharding key will be 138687728 (0b1000010001000011010011110000).
function calcShardingKey(first, second) {
  const m = crypto.createHash('md5')
  m.update(i64toData(first))
  if (second !== undefined) {
    m.update(i64toData(second))
  }
  return m.digest().readUInt32BE()
}


// Waits until the body of the request `req` is received, then calls
// `processFunc` with it. If the body is bigger than `maxBodySize`, a 413
// response is sent instead, so that the whole body does not have to be
// kept in memory.
function processRequestBody(req, res, processFunc) {
  let chunks = []
  let size = 0
  req.on("data", chunk => {
    size += chunk.length
    if (size > maxBodySize) {
      if (!res.headersSent) {
        res.writeHead(413, {'Content-Type': 'text/plain', 'Connection': 'close'})
        res.end('The request body is too large.\n')
      }
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on("end", () => {
    if (size <= maxBodySize) {
      processFunc(Buffer.concat(chunks))
    }
  })
}


// Tries to reserve a random ID, tries again on 409 errors.
async function reserveRandomId(serversConfig, reqHeaders, reqBody, res) {
  let reserveResponse
  for (let i = 0; i < 100 && reserveResponse === undefined; i++) {
    const path = buildReservePath()
    const forwardUrl = serversConfig.findServerUrl(path)
    try {
      reserveResponse = await axios.post(path, reqBody, {
        httpAgent,
        baseURL: forwardUrl,
        headers: reqHeaders,
        maxRedirects: 0,
        validateStatus: null,
        timeout: proxyTimeout,
        responseType: 'arraybuffer',
      })
    } catch (e) {
      if (axios.isAxiosError(e)) break
      else throw e
    }
    if (reserveResponse.status === 409) {
      reserveResponse = undefined  // try again
    }
  }
  if (reserveResponse) {
    const { status, headers, data } = reserveResponse
    res.writeHead(status, {'Content-Type': headers['content-type'] ?? ''})
    res.end(data)
  } else {
    res.writeHead(500, {'Content-Type': 'text/plain'})
    res.end(`All reservation attempts have failed.\n`)
  }
}


// Tries to parse a successfully received "ObjectReferencesPage" JSON
// object. Returns `undefined` if not successful.
function parseEnumerateResponse(statusCode, contentType, body) {
  let obj
  if (statusCode === 200) {
    try {
      if (contentType !== 'application/json') {
        throw 'wrong content type'
      }
      obj = JSON.parse(body.toString())
      if (obj.type !== 'ObjectReferencesPage') {
        throw 'wrong object type'
      }
      if (typeof obj.uri !== 'string') {
        throw 'wrong URI'
      }
      if (typeof obj.next !== 'string' && typeof obj.next !== 'undefined') {
        throw 'wrong link'
      }
    } catch {
      console.error('API error: invalid ObjectReferencesPage response')
      obj = undefined
    }
  }
  return obj
}


// Return a new path, which has `v=${version}` correctly added to `path`.
function addVersionParam(path, version) {
  const param = `v=${version}`
  if (path.includes('?')) {
    if (path.endsWith('?')) {
      return `${path}${param}`
    }
    return `${path}&${param}`
  }
  return `${path}?${param}`
}


// Loads the servers configuration for the proxy server form a file. Returns
// `undefined` if the configuration file can not be read, or it contains an
// invalid configuration.
function loadServersConfig(filePath) {
  try {
    let buffer, text
    try {
      buffer = fs.readFileSync(filePath)
      text = buffer.toString('utf8')
    } catch {
      throw new ConfigError("can not read the configuration file")
    }
    let serverRoutes = []
    for (let line of text.split('\n')) {
      if (line.trim().length !== 0) {
        const [route, serverUrl] = line.split(/\s+/, 2)
        try {
          serverRoutes.push(new ServerRoute(route, serverUrl))
        } catch (e) {
          if (e instanceof ParseError) {
            console.log(`Ignored configuration line: ${line}`)
          } else throw e
        }
      }
    }
    const m = crypto.createHash('md5')
    m.update(buffer)
    return new ServersConfig(serverRoutes, m.digest('hex'))
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Configuration error: ${e.message}`)
      return undefined
    } else throw e
  }
}


// Initialise global constants from environment variables.
function initGlobalConstants() {
  if (process.env.MIN_CREDITOR_ID && process.env.MAX_CREDITOR_ID) {
    // When MIN_CREDITOR_ID and MAX_CREDITOR_ID are both defined, the proxy
    // must be configured to forward creditors' Web API requests.
    if (process.env.MIN_DEBTOR_ID || process.env.MAX_DEBTOR_ID) {
      throw new Error('Creditors and debtors intervals can not be both set.')
    }
    const min = parseI64(process.env.MIN_CREDITOR_ID)
    const max = parseI64(process.env.MAX_CREDITOR_ID)
    shardedPathRegexp = /^\/creditors\/(\d{1,20})\//
    globalPathRegexp = /^\/creditors\/\.(wallet|list)$/
    enumeratePathRegexp = /^\/creditors\/(\d{1,20})\/enumerate(?:\?.*)?$/
    buildEnumeratePath = (id, v) => `/creditors/${id}/enumerate?v=${v}`
    invalidPath = '/creditors/.invalid-path'
    reservePath = '/creditors/.creditor-reserve'
    buildReservePath = () => `/creditors/${i2u(getRandomI64(min, max))}/reserve`

  } else if (process.env.MIN_DEBTOR_ID && process.env.MAX_DEBTOR_ID) {
    // When MIN_DEBTOR_ID and MAX_DEBTOR_ID are both defined, the proxy must
    // be configured to forward debtors' Web API requests.
    if (process.env.MIN_CREDITOR_ID || process.env.MAX_CREDITOR_ID) {
      throw new Error('Creditors and debtors intervals can not be both set.')
    }
    const min = parseI64(process.env.MIN_DEBTOR_ID)
    const max = parseI64(process.env.MAX_DEBTOR_ID)
    shardedPathRegexp = /^\/debtors\/(\d{1,20})\//
    globalPathRegexp = /^\/debtors\/\.(debtor|list)$/
    enumeratePathRegexp = /^\/debtors\/(\d{1,20})\/enumerate(?:\?.*)?$/
    buildEnumeratePath = (id, v) => `/debtors/${id}/enumerate?v=${v}`
    invalidPath = '/debtors/.invalid-path'
    reservePath = '/debtors/.debtor-reserve'
    buildReservePath = () => `/debtors/${i2u(getRandomI64(min, max))}/reserve`

  } else {
    // When neither creditors' nor debtors' interval is defined, the proxy
    // must be configured to forward accounts' Web API internal requests.
    if (process.env.MIN_CREDITOR_ID || process.env.MAX_CREDITOR_ID) {
      throw new Error('incomplete creditors interval')
    }
    if (process.env.MIN_DEBTOR_ID || process.env.MAX_DEBTOR_ID) {
      throw new Error('incomplete debtors interval')
    }
    shardedPathRegexp = /^\/accounts\/(\d{1,20})\/(\d{1,20})\//
  }
}


// Terminate all waiting listeners and exit.
function closeGracefully(signal) {
  console.log(`Received signal to terminate: ${signal}`)
  fs.unwatchFile(configFilePath)
  server.close(() => {
    process.exitCode = 0
  })
}


// The HTTP client that will forward requests to the Web API servers.
const proxy = httpProxy.createProxyServer({
  agent: httpAgent,
  proxyTimeout,
  timeout,
})

proxy.on('error', (err, req, res) => {
  res.writeHead(502, {'Content-Type': 'text/plain'})
  res.end(`${err}\n`)
})

proxy.on('proxyRes', (proxyRes, req, res) => {
  if (res[SELF_HANDLE]) {
    // This is an "enumerate" response. Those are tricky, because they have
    // to be modified, so that they form a chain that may spans over
    // multiple servers. Also, if the configuration of the proxy server
    // changes suddenly, the whole chain must be invalidated.
    let chunks = []
    proxyRes.on('data', chunk => {
      chunks.push(chunk)
    })
    proxyRes.on('end', async () => {
      const { statusCode, headers } = proxyRes
      const path = req.url
      const body = Buffer.concat(chunks)
      const data = parseEnumerateResponse(
        statusCode, headers['content-type'], body
      )
      if (data) {
        const forwardUrl = res[FORWARD_URL]
        const configVersion = res[CONFIG_VERSION]
        const queryString = path.split('?', 2)[1] ?? ''
        const query = querystring.parse(queryString, {maxKeys: 1})
        const v = query['v'] ?? configVersion
        data.uri = addVersionParam(data.uri, v)
        if (v === configVersion && configVersion === serversConfig?.version) {
          if (typeof data.next === 'string') {
            const baseUrl = new URL(req.url, forwardUrl).href
            let next_path
            try {
              next_path = new URL(data.next, baseUrl).pathname
            } catch {
              next_path = ''
            }
            if (serversConfig.findServerUrl(next_path) !== forwardUrl) {
              // This may happen if the records managed by one database have
              // been split to two databases, but the leftover records have
              // not been deleted yet. In this case, we want to "break" the
              // traversal of the paginated list.
              data.items = []
              data.next = invalidPath
            } else {
              data.next = addVersionParam(data.next, v)
            }
          } else {
            const url = serversConfig.serversSuccessors.get(forwardUrl)
            const minId = serversConfig.serversMinIds.get(url)
            if (typeof minId === 'bigint') {
              data.next = buildEnumeratePath(i2u(minId), v)
            }
          }
        } else {
          // This will happen when the configuration file has been changed
          // before the paginated list has been traversed to the end. The
          // intend is to cause a 4xx or 5xx HTTP error on the client, thus
          // "breaking" the traversal of the paginated list.
          data.items = []
          data.next = invalidPath
        }
        res.writeHead(200, {'Content-Type': 'application/json'})
        res.end(JSON.stringify(data))
      } else {
        res.writeHead(statusCode, {'Content-Type': headers['content-type'] ?? ''})
        res.end(body)
      }
    })
  }
})


// The HTTP server that will accept client connections.
const server = http.createServer(async (req, res) => {
  const path = req.url
  if (path === '/healthz' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'text/plain'})
    res.end('The proxy is ready!\n')
    return
  }
  let forwardUrl
  if (serversConfig) {
    if (path === reservePath && req.method === 'POST') {
      const config = serversConfig
      processRequestBody(req, res, (body) => {
        reserveRandomId(config, req.headers, body, res)
      })
      return
    }
    forwardUrl = serversConfig.findServerUrl(path)
  }
  if (forwardUrl) {
    const selfHandleResponse = Boolean(
      enumeratePathRegexp && path.match(enumeratePathRegexp)
    )
    if (selfHandleResponse) {
      res[SELF_HANDLE] = true
      res[FORWARD_URL] = forwardUrl
      res[CONFIG_VERSION] = serversConfig.version
    }
    proxy.web(req, res, { target: forwardUrl, selfHandleResponse })
  } else {
    res.writeHead(502, {'Content-Type': 'text/plain'})
    res.end('The request can not be forwarded to an Web API server.\n')
  }
})


initGlobalConstants()

let serversConfig = loadServersConfig(configFilePath)
fs.watchFile(configFilePath, (curr, prev) => {
  if (curr.birthtimeMs > 0) {
    console.log(`Reloading the configuration file...`)
    if (serversConfig = loadServersConfig(configFilePath)) {
      const v = serversConfig.version
      console.log(`Configuration version ${v} has been successfully applied.`)
    }
  }
})
server.listen(proxyPort)
console.log(`Swaptacular API proxy is listening on port ${proxyPort}.`)

process.once('SIGINT', closeGracefully)
process.once('SIGTERM', closeGracefully)
