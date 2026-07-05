// Netlify Edge Functions 入口
//
// 跟 Cloudflare Workers 共享同一个 _worker.js 的 handleRequest 逻辑,
// 不重复维护. Netlify Edge Functions 跑在 Deno runtime, Web API (Request,
// Response, fetch, URL, AbortController, TextEncoder) 都是原生支持,
// 唯一缺的是 CF 的 KV —— 已经在 _worker.js 里用 typeof KV !== 'undefined'
// 守门, 没 KV 就跳过缓存继续走 fetch, Netlify 上能正常工作.
//
// 部署: 把整个仓库 (含 _worker.js 和 netlify/ 目录) 推到 GitHub,
//       Netlify 接入后会自动识别 netlify.toml + netlify/edge-functions/ 部署.

import { handleRequest } from '../../_worker.js'

export default async (request, context) => {
  return handleRequest(request)
}

// 接管所有路径, 跟 CF Worker 的 "所有请求都走 fetch handler" 行为一致
export const config = { path: '/*' }
