/**
 * GitLab 管理台（GitLab Console）— 主进程（Node 沙箱）
 *
 * 架构与对象存储插件一致：全部业务集中在唯一工具页（index.html）——连接
 * 管理、项目浏览、MR 评审、流水线、Issue 都在该页内完成；GitLab REST API
 * 调用则由主进程的本地无状态代理转发（页面跨域直连不可行）：
 * - 插件启用时即在 127.0.0.1:17932 启动代理。
 * - 工具页把 {cfg, method, path, query, body} 发给代理，代理拼
 *   {baseUrl}/api/v4{path} 并带 PRIVATE-TOKEN 头转发，返回 {status, data}
 *   与分页响应头。代理不保存任何配置（随请求传入、用后即弃）。
 */

const http = require('http')
const https = require('https')
const { URL } = require('url') // vm 沙箱无 URL 全局，从白名单 url 模块取

const PROXY_PORT = 17932
const PROXY_HOST = '127.0.0.1'
const MAX_BODY = 32 * 1024 * 1024

let server = null

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => { total += c.length; if (total > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
function sendJson(res, obj, status) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(status || 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Length': body.length })
  res.end(body)
}

function gitlabRequest(cfg, method, apiPath, query, bodyObj) {
  return new Promise((resolve, reject) => {
    const base = String(cfg.baseUrl || '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(base)) return reject(new Error('GitLab 地址无效（需 http:// 或 https:// 开头）'))
    if (!cfg.token) return reject(new Error('缺少 Access Token'))
    let url
    try { url = new URL(base + '/api/v4' + apiPath) } catch (e) { return reject(new Error('GitLab 地址无效：' + e.message)) }
    if (query) for (const [k, v] of Object.entries(query)) { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)) }
    const isHttps = url.protocol === 'https:'
    const bodyBuf = bodyObj !== undefined && bodyObj !== null ? Buffer.from(JSON.stringify(bodyObj)) : null
    const req = (isHttps ? https : http).request({
      method, hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: Object.assign({ 'PRIVATE-TOKEN': cfg.token, 'User-Agent': 'NewShell-GitLabConsole/1.0' }, bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
      rejectUnauthorized: cfg.allowInsecure ? false : undefined,
      timeout: 30000
    }, (resp) => {
      const chunks = []
      let total = 0
      resp.on('data', (c) => { total += c.length; if (total <= MAX_BODY) chunks.push(c) })
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data = text
        try { data = JSON.parse(text) } catch (_) { /* 非 JSON 原样返回 */ }
        resolve({
          status: resp.statusCode, data,
          page: {
            page: resp.headers['x-page'] || '', perPage: resp.headers['x-per-page'] || '',
            total: resp.headers['x-total'] || '', totalPages: resp.headers['x-total-pages'] || '',
            nextPage: resp.headers['x-next-page'] || '', prevPage: resp.headers['x-prev-page'] || ''
          }
        })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时（30 秒）')) })
    req.on('error', reject)
    if (bodyBuf) req.write(bodyBuf)
    req.end()
  })
}

function startServer() {
  if (server) return
  server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*' })
        res.end()
        return
      }
      const u = new URL(req.url, 'http://' + PROXY_HOST + ':' + PROXY_PORT)
      if (u.pathname === '/ping' && req.method === 'GET') return sendJson(res, { ok: true, plugin: 'gitlab-console' })
      if (u.pathname === '/api' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)).toString('utf8'))
        if (!payload.cfg) return sendJson(res, { error: '缺少连接配置' }, 400)
        if (!payload.path || !String(payload.path).startsWith('/')) return sendJson(res, { error: '缺少 API 路径' }, 400)
        const result = await gitlabRequest(payload.cfg, payload.method || 'GET', payload.path, payload.query, payload.body)
        return sendJson(res, result)
      }
      sendJson(res, { error: 'not found' }, 404)
    } catch (e) {
      if (!res.headersSent) sendJson(res, { error: e.message || String(e) }, 502)
      else { try { res.end() } catch (_) { /* ignore */ } }
    }
  })
  server.on('error', (e) => { console.error('[GitLabConsole] proxy server error:', e.message) })
  server.listen(PROXY_PORT, PROXY_HOST, () => console.log(`[GitLabConsole] proxy on http://${PROXY_HOST}:${PROXY_PORT}`))
}

function activate(context) {
  console.log(`[GitLabConsole] Activating v${context.manifest.version}...`)
  try {
    context.ui.registerToolPage({ id: 'console', title: 'GitLab 管理台', icon: '🦊', renderer: 'index.html' })
  } catch (err) {
    console.warn('[GitLabConsole] registerToolPage skipped:', err && err.message)
  }
  startServer()
}

async function deactivate() {
  if (server) { server.close(); server = null }
  console.log('[GitLabConsole] Deactivated')
}

module.exports = { activate, deactivate }
