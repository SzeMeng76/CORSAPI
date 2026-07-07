// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    // Pages Functions 中 KV 需要从 env 中获取
    if (env && env.KV && typeof globalThis.KV === 'undefined') {
      globalThis.KV = env.KV
    }

    return handleRequest(request)
  }
}

// 常量配置（避免重复创建）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jingjian.json',
  'full': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/LunaTV-config.json'
}

const FORMAT_CONFIG = {
  '0': { proxy: false, base58: false },
  'raw': { proxy: false, base58: false },
  '1': { proxy: true, base58: false },
  'proxy': { proxy: true, base58: false },
  '2': { proxy: false, base58: true },
  'base58': { proxy: false, base58: true },
  '3': { proxy: true, base58: true },
  'proxy-base58': { proxy: true, base58: true }
}

// Base58 编码函数
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(obj) {
  const str = JSON.stringify(obj)
  const bytes = new TextEncoder().encode(str)

  let intVal = 0n
  for (let b of bytes) {
    intVal = (intVal << 8n) + BigInt(b)
  }

  let result = ''
  while (intVal > 0n) {
    const mod = intVal % 58n
    result = BASE58_ALPHABET[Number(mod)] + result
    intVal = intVal / 58n
  }

  for (let b of bytes) {
    if (b === 0) result = BASE58_ALPHABET[0] + result
    else break
  }

  return result
}

// 🔑 从 URL 中提取唯一标识符（用于生成唯一路径）
function extractSourceId(apiUrl) {
  try {
    const url = new URL(apiUrl)
    const hostname = url.hostname

    // 提取主域名作为标识符（去掉子域名和 TLD）
    // 例如：caiji.maotaizy.cc → maotai
    //       iqiyizyapi.com → iqiyi
    //       api.maoyanapi.top → maoyan
    const parts = hostname.split('.')

    // 如果是 caiji.xxx.com 或 api.xxx.com 格式，取倒数第二部分
    if (parts.length >= 3 && (parts[0] === 'caiji' || parts[0] === 'api' || parts[0] === 'cj' || parts[0] === 'www')) {
      return parts[parts.length - 2].toLowerCase().replace(/[^a-z0-9]/g, '')
    }

    // 否则取第一部分（去掉 zyapi/zy 等后缀）
    let name = parts[0].toLowerCase()
    name = name.replace(/zyapi$/, '').replace(/zy$/, '').replace(/api$/, '')
    return name.replace(/[^a-z0-9]/g, '') || 'source'
  } catch {
    // URL 解析失败，使用随机标识
    return 'source' + Math.random().toString(36).substr(2, 6)
  }
}

// JSON api 字段前缀替换（改进版：为每个源生成唯一路径）
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))
  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]

      // 去掉旧的代理前缀（如果有）
      const urlIndex = apiUrl.indexOf('?url=')
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5)

      // 🔑 关键修改：为每个源生成唯一的路径
      if (!apiUrl.startsWith(newPrefix)) {
        const sourceId = extractSourceId(apiUrl)

        // 从 newPrefix 中提取 origin 和基础路径
        // 例如：https://xx.fn0.qzz.io/?url= → https://xx.fn0.qzz.io/p/iqiyi?url=
        const baseUrl = newPrefix.replace(/\/?\?url=$/, '') // 去掉结尾的 /?url= 或 ?url=
        apiUrl = `${baseUrl}/p/${sourceId}?url=${apiUrl}`
      }

      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

// ---------- 安全版：KV 缓存 ----------
async function getCachedJSON(url) {
  const kvAvailable = typeof KV !== 'undefined' && KV && typeof KV.get === 'function'

  if (kvAvailable) {
    const cacheKey = 'CACHE_' + url
    const cached = await KV.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached)
      } catch (e) {
        await KV.delete(cacheKey)
      }
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    const data = await res.json()
    await KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 600 })   // 缓存十分钟
    return data
  } else {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    return await res.json()
  }
}

// v2.0.20: m3u8 KV 缓存 (借鉴 cmliu/edgetunnel 的 KV 缓存思路)
// m3u8 内容大多静态, 同一个剧集每次播放都要重新 fetch + 解析 + 重写太浪费.
// 5 分钟 TTL 兼顾"主播切线路时及时刷新"和"重复请求秒回".
// cacheKey 含 origin, 避免 worker 换域名后返错链接.
async function getCachedM3u8(cacheKey) {
  if (typeof KV === 'undefined' || !KV || typeof KV.get !== 'function') return null
  try {
    return await KV.get(cacheKey)
  } catch {
    return null
  }
}

async function setCachedM3u8(cacheKey, text) {
  if (typeof KV === 'undefined' || !KV || typeof KV.put !== 'function') return
  try {
    await KV.put(cacheKey, text, { expirationTtl: 300 }) // 5 分钟
  } catch (e) {
    // 写缓存失败不影响主流程
  }
}

// ---------- 安全版：错误日志 ----------
async function logError(type, info) {
  // 保留错误输出，便于调试
  console.error('[ERROR]', type, info)

  // 禁止写入 KV
  return
}

// ---------- 主逻辑 ----------
async function handleRequest(request) {
  // 快速处理 OPTIONS 请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const pathname = reqUrl.pathname
  const targetUrlParam = reqUrl.searchParams.get('url')
  const formatParam = reqUrl.searchParams.get('format')
  const prefixParam = reqUrl.searchParams.get('prefix')
  const sourceParam = reqUrl.searchParams.get('source')

  const currentOrigin = reqUrl.origin
  const defaultPrefix = currentOrigin + '/?url='

  // 🩺 健康检查（最常见的性能检查，提前处理）
  if (pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  // 🔑 新增：处理源专属路径 /p/{sourceId}?url=...
  // 这样可以让 TVBox 认为每个源是不同的域名/路径
  if (pathname.startsWith('/p/') && targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin)
  }

  // 通用代理请求处理（兼容旧的 /?url=... 格式）
  if (targetUrlParam) {
    // 单独的 m3u8 端点：拉 m3u8 并重写 .ts 链接
    if (pathname === '/m3u8') {
      return handleM3u8Request(request, targetUrlParam, currentOrigin)
    }
    return handleProxyRequest(request, targetUrlParam, currentOrigin)
  }

  // JSON 格式输出处理
  if (formatParam !== null) {
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix)
  }

  // 返回首页文档
  return handleHomePage(currentOrigin, defaultPrefix)
}

// ---------- 代理请求处理子模块 ----------
async function handleProxyRequest(request, targetUrlParam, currentOrigin) {
  // 🚨 防止递归调用自身
  if (targetUrlParam.startsWith(currentOrigin)) {
    return errorResponse('Loop detected: self-fetch blocked', { url: targetUrlParam }, 400)
  }

  // 🚨 防止无效 URL
  if (!/^https?:\/\//i.test(targetUrlParam)) {
    return errorResponse('Invalid target URL', { url: targetUrlParam }, 400)
  }

  let fullTargetUrl = targetUrlParam
  // 🔑 修复：只提取 url= 参数的值，不要包含后续的 & 参数
  const urlMatch = request.url.match(/[?&]url=([^&]+)/)
  if (urlMatch) fullTargetUrl = decodeURIComponent(urlMatch[1])

  // 🔑 关键修复：提取并传递额外的 query 参数（如 ac=list, ac=detail 等）
  const reqUrl = new URL(request.url)
  const extraParams = new URLSearchParams()

  // 遍历所有 query 参数，把除了 url 之外的参数都加到目标 URL
  for (const [key, value] of reqUrl.searchParams) {
    if (key !== 'url') {
      extraParams.append(key, value)
    }
  }

  let targetURL
  try {
    targetURL = new URL(fullTargetUrl)

    // 🔑 将额外参数追加到目标 URL
    for (const [key, value] of extraParams) {
      targetURL.searchParams.append(key, value)
    }
  } catch {
    await logError('proxy', { message: 'Invalid URL', url: fullTargetUrl })
    return errorResponse('Invalid URL', { url: fullTargetUrl }, 400)
  }

  // 构造透传请求头,如果客户端没带必要的头,按目标域名补上 fallback
  // (典型:lain.bgm.tv 拒无 UA 的请求)
  const upstreamHeaders = new Headers(request.headers)
  applyDefaultHeadersForUpstream(upstreamHeaders, targetURL)

  try {
    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.arrayBuffer()
        : undefined,
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 9000)
    const response = await fetch(proxyRequest, { signal: controller.signal })
    clearTimeout(timeoutId)

    const responseHeaders = new Headers(CORS_HEADERS)
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    })
  } catch (err) {
    await logError('proxy', { message: err.message || '代理请求失败', url: fullTargetUrl })
    return errorResponse('Proxy Error', {
      message: err.message || '代理请求失败',
      target: fullTargetUrl,
      timestamp: new Date().toISOString()
    }, 502)
  }
}

// 按目标域名补默认请求头 (客户端漏带 UA/Referer 时,补上,避免上游 400/403)
function applyDefaultHeadersForUpstream(headers, targetURL) {
  const host = targetURL.hostname.toLowerCase()
  // Bangumi 图片/数据系列:lain.bgm.tv / api.bgm.tv / bgm.tv
  if (host === 'lain.bgm.tv' || host === 'api.bgm.tv' || host === 'bgm.tv' || host.endsWith('.bgm.tv')) {
    // ⚠️ api.bgm.tv v0 API 强制要求 UA 是 "App/Version (URL)" 格式,
    // Chrome 标准 UA 会返 400
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', 'LunaTV-Mobile/1.0 (https://github.com/djsevenx1/LunaTV-Mobile)')
    }
    if (!headers.has('Referer')) {
      headers.set('Referer', 'https://bgm.tv/')
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8')
    }
  }
}

// ---------- M3U8 代理：拉 m3u8 并把 .ts 子链接也走 Worker ----------
async function handleM3u8Request(request, targetUrlParam, currentOrigin) {
  if (targetUrlParam.startsWith(currentOrigin)) {
    return errorResponse('Loop detected: self-fetch blocked', { url: targetUrlParam }, 400)
  }
  if (!/^https?:\/\//i.test(targetUrlParam)) {
    return errorResponse('Invalid target URL', { url: targetUrlParam }, 400)
  }

  let fullTargetUrl = targetUrlParam
  const urlMatch = request.url.match(/[?&]url=([^&]+)/)
  if (urlMatch) fullTargetUrl = decodeURIComponent(urlMatch[1])

  // 携带额外 query
  const reqUrl = new URL(request.url)
  const extraParams = new URLSearchParams()
  for (const [key, value] of reqUrl.searchParams) {
    if (key !== 'url') extraParams.append(key, value)
  }

  let targetURL
  try {
    targetURL = new URL(fullTargetUrl)
    for (const [key, value] of extraParams) {
      targetURL.searchParams.append(key, value)
    }
  } catch {
    return errorResponse('Invalid URL', { url: fullTargetUrl }, 400)
  }

  // v2.0.20: KV 缓存查询 (含 origin 避免跨域名错链, ?nocache=1 跳过)
  const cacheKey = `M3U8_${currentOrigin}_${targetURL.toString()}`
  const nocache = reqUrl.searchParams.get('nocache') === '1'
  if (!nocache) {
    const cached = await getCachedM3u8(cacheKey)
    if (cached !== null) {
      return new Response(cached, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'public, max-age=60',
          'X-Cache': 'HIT',
          'X-Cache-TTL': '300',
          // 借鉴: HTTP/3 Alt-Svc, 让客户端升级到 QUIC (CF 默认开, 几乎零成本)
          'Alt-Svc': 'h3=":443"; ma=86400',
          ...CORS_HEADERS,
        },
      })
    }
  }

  const baseOrigin = currentOrigin
  const m3u8Base = `${baseOrigin}/?url=`

  // 判断一个 segment 链接是否需要包代理
  // 1) 绝对 http(s) 链接：包一层 ?url= 走本 worker
  // 2) 相对路径 / 协议相对 //开头：用 m3u8 自身 base 拼成绝对再包
  const wrapSegment = (rawLine) => {
    const line = rawLine.trim()
    if (!line) return line
    // 注释行 / EXT 行不动
    if (line.startsWith('#')) return line
    // 已经是 http 绝对
    if (/^https?:\/\//i.test(line)) {
      return m3u8Base + encodeURIComponent(line)
    }
    // 协议相对 //host/path
    if (line.startsWith('//')) {
      const abs = targetURL.protocol + line
      return m3u8Base + encodeURIComponent(abs)
    }
    // 相对路径
    try {
      const abs = new URL(line, targetURL).toString()
      return m3u8Base + encodeURIComponent(abs)
    } catch {
      return line
    }
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 9000)
    const upstream = await fetch(targetURL.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36' },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const text = await upstream.text()

    // 简单判断 master playlist (含 #EXT-X-STREAM-INF) → 递归把所有 variant m3u8 也包一层
    const isMaster = /#EXT-X-STREAM-INF/i.test(text)

    const lines = text.split(/\r?\n/)
    const out = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 对 URI="..." 属性里的链接也包一层
      if (/^#EXT-X-KEY/i.test(line) || /^#EXT-X-MAP/i.test(line) || /^#EXT-X-MEDIA/i.test(line) || /^#EXT-X-I-FRAME-STREAM-INF/i.test(line)) {
        out.push(line.replace(/URI="([^"]+)"/g, (m, u) => {
          let abs
          try { abs = new URL(u, targetURL).toString() } catch { abs = u }
          return `URI="${m3u8Base + encodeURIComponent(abs)}"`
        }))
        continue
      }
      // variant stream 行
      if (isMaster && /^#EXT-X-STREAM-INF/i.test(line)) {
        out.push(line)
        // 紧跟的下一行就是 variant 链接
        if (i + 1 < lines.length) {
          out.push(wrapSegment(lines[i + 1]))
          i++
        }
        continue
      }
      out.push(wrapSegment(line))
    }

    const outText = out.join('\n')

    // v2.0.20: 写缓存 (后台 fire-and-forget, 不阻塞响应)
    if (!nocache) {
      ctxWaitUntil(setCachedM3u8(cacheKey, outText))
    }

    return new Response(outText, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'X-Cache': nocache ? 'BYPASS' : 'MISS',
        'Alt-Svc': 'h3=":443"; ma=86400',
        ...CORS_HEADERS,
      },
    })
  } catch (err) {
    await logError('m3u8', { message: err.message, url: fullTargetUrl })
    return errorResponse('M3U8 Proxy Error', {
      message: err.message,
      target: fullTargetUrl,
    }, 502)
  }
}

// v2.0.20: ctx.waitUntil 的安全 fallback
// Pages Functions 没 ctx, Netlify 也没, 直接执行函数即可
function ctxWaitUntil(promise) {
  try {
    if (typeof ctx !== 'undefined' && ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(promise)
      return
    }
  } catch {}
  // 没 ctx 就当普通 promise, 不 await (fire-and-forget)
  promise.catch(() => {})
}

// ---------- JSON 格式输出处理子模块 ----------
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) {
      return errorResponse('Invalid format parameter', { format: formatParam }, 400)
    }

    const selectedSource = JSON_SOURCES[sourceParam] || JSON_SOURCES['full']
    const data = await getCachedJSON(selectedSource)

    const newData = config.proxy
      ? addOrReplacePrefix(data, prefixParam || defaultPrefix)
      : data

    if (config.base58) {
      const encoded = base58Encode(newData)
      return new Response(encoded, {
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...CORS_HEADERS },
      })
    } else {
      return new Response(JSON.stringify(newData), {
        headers: { 'Content-Type': 'application/json;charset=UTF-8', ...CORS_HEADERS },
      })
    }
  } catch (err) {
    await logError('json', { message: err.message })
    return errorResponse(err.message, {}, 500)
  }
}

// ---------- 首页文档处理 (LunaTV 风格: 深色 + 绿主色 #22C55E) ----------
async function handleHomePage(currentOrigin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CORSAPI - API 中转代理服务</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --luna-green: #22C55E;
      --luna-green-deep: #10B981;
      --bg: #0F1117;
      --card: #1F2937;
      --border: #374151;
      --text: #FFFFFF;
      --sub: #9ca3af;
      --muted: #6b7280;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.6;
      padding: 24px 16px;
    }
    .container {
      max-width: 880px;
      margin: 0 auto;
    }
    /* 顶部条 (跟 LunaTV Web 顶栏同款) */
    .topbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 4px 24px 4px;
    }
    .logo {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: linear-gradient(135deg, var(--luna-green), var(--luna-green-deep));
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      color: #052e16;
      font-size: 14px;
    }
    .brand {
      font-size: 16px;
      font-weight: 700;
      color: var(--text);
    }
    .pill {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: rgba(34, 197, 94, 0.12);
      color: var(--luna-green);
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
    }
    .pill .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--luna-green);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    /* 头部 */
    .hero {
      padding: 32px 28px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 20px;
    }
    .hero h1 {
      font-size: 28px;
      font-weight: 800;
      margin-bottom: 8px;
      color: var(--text);
    }
    .hero h1 .accent {
      color: var(--luna-green);
    }
    .hero p {
      color: var(--sub);
      font-size: 14px;
      margin-bottom: 16px;
    }
    .url-card {
      background: #0b0e14;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      font-family: 'SF Mono', Consolas, Monaco, monospace;
      font-size: 13px;
      color: var(--luna-green);
      word-break: break-all;
      margin-bottom: 8px;
    }
    .url-card .label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
      font-family: -apple-system, sans-serif;
    }
    /* 章节 */
    .section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 16px;
    }
    .section-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 16px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 14px;
    }
    .section-title::before {
      content: "";
      width: 3px;
      height: 14px;
      background: linear-gradient(180deg, var(--luna-green), var(--luna-green-deep));
      border-radius: 2px;
    }
    .section p {
      color: var(--sub);
      font-size: 14px;
      margin-bottom: 10px;
    }
    .section p:last-child {
      margin-bottom: 0;
    }
    pre {
      background: #0b0e14;
      color: #d1d5db;
      padding: 14px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      overflow-x: auto;
      font-family: 'SF Mono', Consolas, Monaco, monospace;
      font-size: 12.5px;
      line-height: 1.6;
      margin: 10px 0;
      white-space: pre;
    }
    pre .g { color: var(--luna-green); }
    pre .d { color: var(--muted); }
    code {
      background: rgba(34, 197, 94, 0.12);
      color: var(--luna-green);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', Consolas, Monaco, monospace;
      font-size: 12.5px;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 8px 0;
    }
    li {
      color: var(--sub);
      font-size: 14px;
      padding: 6px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    li::before {
      content: "";
      width: 5px;
      height: 5px;
      background: var(--luna-green);
      border-radius: 50%;
      flex-shrink: 0;
    }
    /* 网格 */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
      margin-top: 8px;
    }
    .feat {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 13.5px;
      color: var(--sub);
    }
    .feat b {
      color: var(--luna-green);
      font-weight: 600;
    }
    /* 底部 */
    .footer {
      text-align: center;
      padding: 20px 0 4px 0;
      color: var(--muted);
      font-size: 12.5px;
    }
    .footer a {
      color: var(--luna-green);
      text-decoration: none;
    }
    .footer a:hover {
      text-decoration: underline;
    }
    @media (max-width: 600px) {
      body { padding: 16px 12px; }
      .hero { padding: 22px 18px; }
      .hero h1 { font-size: 22px; }
      .section { padding: 16px 18px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- 顶部条 -->
    <div class="topbar">
      <div class="logo">L</div>
      <span class="brand">CORSAPI</span>
      <span class="pill"><span class="dot"></span>运行中</span>
    </div>

    <!-- 头部 -->
    <div class="hero">
      <h1>API 中转代理服务 <span class="accent">/ LunaTV 配套</span></h1>
      <p>通用 API 中转代理,用于加速和转发跨域 API 请求。部署在 ${detectPlatform()} 上。</p>
      <div class="url-card">
        <div class="label">基本用法 · 在 API 请求前添加代理 + <code>?url=</code></div>
        ${defaultPrefix}https://api.example.com/endpoint
      </div>
      <div class="url-card">
        <div class="label">M3U8 代理 · 拉 m3u8 并把 .ts 段链接也走 worker</div>
        ${currentOrigin}/m3u8?url=https://example.com/index.m3u8
      </div>
    </div>

    <!-- 端点 -->
    <div class="section">
      <div class="section-title">端点</div>
      <ul>
        <li><code>GET /?url=&lt;encoded&gt;</code> 通用代理,透传 method/headers/body</li>
        <li><code>GET /m3u8?url=&lt;encoded&gt;</code> m3u8 代理,自动重写 .ts 链接为 <code>worker/?url=...</code></li>
        <li><code>GET /p/{source}?url=&lt;encoded&gt;</code> 源专属路径,避免缓存冲突</li>
        <li><code>GET /health</code> 健康检查</li>
        <li><code>GET /?format=1&amp;source=full</code> 输出 LunaTV JSON 配置 (proxy 模式)</li>
      </ul>
    </div>

    <!-- 用法示例 -->
    <div class="section">
      <div class="section-title">用法示例</div>
      <p>代理一个 API 请求:</p>
      <pre>原始: <span class="d">https://api.example.com/data?id=123</span>
代理: <span class="g">${currentOrigin}/?url=https://api.example.com/data?id=123</span></pre>
      <p>额外 query 参数自动转发到目标 URL:</p>
      <pre>请求: <span class="g">${currentOrigin}/?url=https://api.example.com/list&page=1&limit=10</span>
转发: <span class="d">https://api.example.com/list?page=1&limit=10</span></pre>
    </div>

    <!-- 特性 -->
    <div class="section">
      <div class="section-title">功能特性</div>
      <div class="grid">
        <div class="feat"><b>HTTP 全方法</b><br>GET / POST / PUT / DELETE 等</div>
        <div class="feat"><b>自动参数转发</b><br>query 透传给目标</div>
        <div class="feat"><b>CORS 完整</b><br>Access-Control-* 全套</div>
        <div class="feat"><b>超时保护</b><br>9 秒,避免悬挂</div>
        <div class="feat"><b>自反循环检测</b><br>防止 worker 套 worker</div>
        <div class="feat"><b>bgm.tv fallback</b><br>UA / Referer 自动补</div>
        <div class="feat"><b>M3U8 KV 缓存</b><br>5 分钟复用, 减少 worker CPU</div>
        <div class="feat"><b>HTTP/3 (QUIC)</b><br>Alt-Svc 头提示升级, CF 默认开</div>
      </div>
    </div>

    <!-- 配套 -->
    <div class="section">
      <div class="section-title">配套 App</div>
      <p>推荐配合 <code>LunaTV-Mobile</code> 使用,在 App 菜单填入 worker 域名即可自动接管 Bangumi 数据/图片代理 + 源加速 + m3u8 端点重写。</p>
      <pre>Bangumi 数据源  → <span class="g">CF Worker 加速</span>
Bangumi 图片源  → <span class="g">CF Worker 加速</span>
播放器源测速   → 走 worker (测得延迟 ≈ 实际播放延迟)
m3u8 播放      → 走 <span class="g">/m3u8?url=</span>, .ts 子链接自动重写到 worker</pre>
    </div>

    <div class="footer">
      <a href="https://github.com/djsevenx1/CORSAPI" target="_blank">djsevenx1/CORSAPI</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/djsevenx1/LunaTV-Mobile" target="_blank">LunaTV-Mobile</a>
      <br>
      <span style="margin-top: 6px; display: inline-block;">Powered by ${detectPlatform()}</span>
    </div>
  </div>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
  })
}

// ---------- 统一错误响应处理 ----------
function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}


// ---------- 平台检测 (首页 "Powered by ..." 用) ----------
// Cloudflare Workers 没 Deno 全局, Netlify Edge Functions (Deno) 有
function detectPlatform() {
  if (typeof Deno !== 'undefined') return 'Netlify Edge Functions (Deno)'
  return 'Cloudflare Workers'
}

// ---------- 命名导出 ----------
// 供 netlify/edge-functions/corsapi.js 复用同一个 handleRequest
// 不重复维护两套逻辑. Cloudflare 走上面 export default { fetch } 入口,
// Netlify 走 netlify/edge-functions/corsapi.js 导入这个 handleRequest
export { handleRequest, detectPlatform }
