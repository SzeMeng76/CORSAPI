# CORSAPI - API 中转代理服务

> 基于 Cloudflare Workers 的通用 API 中转代理,LunaTV-Mobile 配套后端,深色 + 绿主色首页风格。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/djsevenx1/CORSAPI)

---

## ✨ 特性

- 🚀 **全方法 HTTP 代理** — GET / POST / PUT / DELETE 等所有方法,自动转发 headers / body
- 📺 **M3U8 端点重写** — `/m3u8?url=...` 自动把 .ts / 加密 key / MAP / 媒体轨道 全部回环到 worker,绕开原站 CDN 限速
- 🌐 **完整 CORS** — `Access-Control-*` 全套响应头,前端可直连
- 🛡 **防自反** — 阻止 worker 调自身的循环
- ⏱ **9s 超时保护** — 避免悬挂
- 🧠 **参数透传** — 除 `url` 外的 query 参数自动追加到目标 URL(`?ac=list&pg=1` 这类)
- 🎯 **源专属路径** — `/p/source1?url=...` 给不同源独立路径,避免缓存冲突
- 🎨 **深色 + 绿主色首页** — 访问根域名就有 LunaTV 风格的 UI 介绍
- 🩹 **bgm.tv fallback** — 对 `api.bgm.tv` / `lain.bgm.tv` / `bgm.tv` 自动补正确的 `App/Version (URL)` UA + `Referer`,客户端漏带头时也不 400/403

> **Credit**: 本项目二开自 [hafrey1/LunaTV-config](https://github.com/hafrey1/LunaTV-config) 的 CORSAPI 部分。

---

## 🚀 快速部署

### 方式零:Netlify Edge Functions (推荐, 一键接入)

跟 Cloudflare Workers **共享同一套 \`_worker.js\` 代码**, 不重复维护.
Netlify Edge Functions 跑在 Deno runtime, Web API (Request / Response / fetch / URL) 原生支持.
唯一缺的是 CF 的 KV —— \`_worker.js\` 已经用 \`typeof KV !== 'undefined'\` 守门, Netlify 上没 KV 就跳过缓存继续走 fetch, 一切正常.

1. 把整个仓库 (含 \`_worker.js\` / \`netlify.toml\` / \`netlify/edge-functions/\`) 推到 GitHub
2. 登录 [Netlify Dashboard](https://app.netlify.com/) → **Add new site** → **Import an existing project**
3. 选 GitHub 仓库 \`djsevenx1/CORSAPI\`, 直接 **Deploy** (不用改 build command)
4. 部署完 Netlify 分配 \`xxx.netlify.app\` 域名, 例如 \`https://corsapi.netlify.app/\`
5. (可选) **Domain settings** → **Custom domains** 绑自己的域名

部署后访问:
- \`https://corsapi.netlify.app/\` → LunaTV 风格首页
- \`https://corsapi.netlify.app/health\` → 健康检查
- \`https://corsapi.netlify.app/?url=https://api.example.com/data\` → 通用代理
- \`https://corsapi.netlify.app/m3u8?url=https://example.com/index.m3u8\` → M3U8 代理 (自动重写 .ts)

### 方式一:Cloudflare Dashboard 手贴

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. **Workers & Pages** → **Create** → **Workers** → 选 **Hello World!** 模板
3. 项目命名 → **Deploy** → **Edit Code**
4. 把本仓库 `_worker.js` 全部内容贴进去
5. **Save and Deploy**
6. (可选)Worker 设置 → **Triggers** → **Custom Domains** 绑域名

部署完成后访问 worker 域名,会看到 LunaTV 风格的深色首页。

### 方式二:Cloudflare Pages

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 下载本仓库 `_worker.js`
3. 本地新建空文件夹,把 `_worker.js` 放进去
4. **Workers & Pages** → **Create** → **Pages** → **Upload assets**
5. 项目命名 → 选刚才的文件夹 → **Deploy site**

---

## 📖 使用方法

假设你的 Worker 部署在 `https://api.example.workers.dev`。

### 通用代理

```
GET https://api.example.workers.dev/?url=https://example.com/api
```

### M3U8 代理(自动重写 .ts 链接)

```
GET https://api.example.workers.dev/m3u8?url=https://example.com/index.m3u8
```

返回的 m3u8 里所有 `.ts` / `.m3u8` / `.key` 子链接都被替换成 `https://api.example.workers.dev/?url=<encoded>`,
浏览器/mpv 拉播放列表时会按改写后的链接走 worker,绕开原站 CDN 慢速。

### 源专属路径

```
GET https://api.example.workers.dev/p/source1?url=https://api1.com/vod
GET https://api.example.workers.dev/p/source2?url=https://api2.com/vod
```

不同源走不同路径,避免浏览器 / DNS / CDN 缓存冲突。

### Query 参数自动转发

```
请求:https://api.example.workers.dev/?url=https://api.example.com/list&page=1&limit=10
转发:https://api.example.com/list?page=1&limit=10
```

---

## 🩺 健康检查

```
GET /health
```

返回 `OK` 表示正常。

---

## 🧰 配套项目

本项目作为 **[LunaTV-Mobile](https://github.com/djsevenx1/LunaTV-Mobile)** 的配套后端,
在 App 菜单填入 worker 域名即可自动接管:

| 场景 | 走法 |
|---|---|
| Bangumi 数据 (api.bgm.tv) | CF Worker → ciao-cors → 直连, 多级 fallback |
| Bangumi 图片 (lain.bgm.tv) | CF Worker, 强制补 `App/Version (URL)` UA + Referer |
| 播放器源测速 / m3u8 播放 | CF Worker, 走 `/m3u8` 端点重写 .ts |

App 端 Bangumi 失败会自动降级:
1. CF Worker 失败 → 改走 ciao-cors
2. ciao-cors 也失败 → 改走直连

---

## ⚙️ 可选配置

### KV 缓存

1. **Storage & Databases** → **Workers KV** → **Create namespace**
2. Worker 设置 → **Bindings** → **Add** → **KV namespace**
3. 变量名填 `KV`,选刚才的 namespace,保存

### 修改超时

`_worker.js`:

```javascript
const timeoutId = setTimeout(() => controller.abort(), 9000) // 默认 9 秒
```

---

## 📝 bgm.tv fallback 头说明

`api.bgm.tv` v0 API 严格校验 `User-Agent` 必须是 `App/Version (URL)` 格式,Chrome 标准 UA 会被返 400。
`lain.bgm.tv` 图片服务对 `Referer` 也有要求。

Worker 在 `applyDefaultHeadersForUpstream()` 里按目标域名补:

| 域名 | User-Agent | Referer | Accept |
|---|---|---|---|
| `api.bgm.tv` | `LunaTV-Mobile/1.0 (https://github.com/djsevenx1/LunaTV-Mobile)` | `https://bgm.tv/` | `application/json`(由客户端传) |
| `lain.bgm.tv` | 同上 | 同上 | `image/avif,image/webp,image/apng,image/*,*/*;q=0.8` |
| `bgm.tv` / `*.bgm.tv` | 同上 | 同上 | 同上 |

客户端**有**带这些头就透传,**没**带就补上,避免上游 400/403。

---

## ⚠️ 注意事项

- **免费额度** — Cloudflare Workers 免费版 10 万次/天
- **超时** — 默认 9 秒,改 `_worker.js` 里 `9000` 那个数字
- **CORS** — 完整启用,前端可直连
- **防递归** — 自动检测并阻止 worker 调自身

---

## 📜 许可证

与上游 [hafrey1/LunaTV-config](https://github.com/hafrey1/LunaTV-config) 一致。
