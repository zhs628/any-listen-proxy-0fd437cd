# 我的个人音乐代理

这是当前设备导出的独立工程。仓库和 Cloudflare 服务由你自己的账户管理，不依赖公共模板仓库。

## 首次部署

1. 创建 GitHub 私有仓库，解压工程后上传文件到仓库根目录。不要把 ZIP 文件本身上传。
2. 在 Cloudflare 的 Workers & Pages 中导入该仓库，仅授权此仓库。保留自动识别的默认设置，点击 Deploy。无需填写构建或部署命令。
3. 部署后点击 Visit（访问）打开代理首页，再点「连接到播放器」。地址会自动带回并验证；手动粘贴地址作为备用入口。

## 配置

服务名称为 any-listen-proxy-0fd437cd，允许的播放器地址为 https://any-listen-browser-zhs.zhanghaosheng628.chatgpt.site。APP_ORIGIN 和 PROXY_KEY 已写入 wrangler.jsonc。工程包含连接密钥，请保持仓库私有。修改密钥时需要同步修改 App 配置。若旧服务已经设置了同名 Secret，需先删除旧 PROXY_KEY Secret 后再由仓库配置部署。BILI_USER_AGENT、BILI_ORIGIN、BILI_REFERER 是发往 B 站的固定请求头，可在 wrangler.jsonc 中调整；登录 Cookie 默认关闭；B 站 API 默认使用 TLS HTTP/1 转发，需要设备标识时自动获取匿名 buvid3，仅在当前 Worker 内存复用 30 分钟，不保存到云端。音频仍用 Fetch 流式传输。可设置 BILI_API_TRANSPORT=fetch 回退标准通道。只有明确需要验证登录态时，才在 Cloudflare 的 Worker 设置中新增名为 BILI_COOKIE 的 Secret。它只发往精确列出的 B 站 API 路径，不会接收 App 来的 Cookie，不写入代码仓库或云端日志；通过鉴权的手动诊断会返回实际发送的 Cookie。Cloudflare 会按 Secret 方式保存该值；它不是匿名访问所必需的，也不会改变账号本身的内容权限。

## 后续使用

代理只处理请求转发，日常音源策略随 App 更新。已部署的代理可以持续使用，无需随每次 App 更新重新上传仓库。通道自身的能力或修复变化仍可能需要更新工程；不会从第三方仓库自动拉取代码。

## 维护与迁移

你可以编辑、下载、迁移自己的仓库或删除服务。撤销 GitHub 授权会停止后续构建，已部署的服务仍会继续运行。

## 诊断接口

GET /diagnostics 返回 workerBuild、诊断协议版本、能力和节点信息。GET /probe?url=…&mode=request|range|head 分别执行普通 GET、首字节 Range 或 HEAD（默认 range 兼容旧客户端）。返回逐跳完整 URL、完整出站请求头（含 Cookie）、响应头（含 Set-Cookie）、上游状态和耗时，取得响应头后取消正文。HTTP 200 仅表示报告可读取，应以 outcome 和 upstream.status 判断上游结果。transport=production 使用正式转发路径并报告匿名设备请求或内存命中；transport=fetch 可作标准通道对照。可选 transport=tls-socket 在相同 Worker 上作实验性 TLS/HTTP1 响应头对照，限制 443 端口和 32 KiB 响应头，不用于日常转发。X-Proxy-Probe-Headers 接受最多 32 项、16 KiB 的 JSON 请求头覆盖（null 删除），仅本次诊断及初始同源跳转生效；Host 和消息长度等连接控制头不能覆盖。Fetch 请求记录只代表 fetch 输入，无法观察 Cloudflare 最终线上头、出口 IP 或 TLS。Socket 更换传输可能同时改变出口、HTTP 版本与 TLS 特征，不能仅凭状态差异断言某个头触发拦截。接口使用相同的连接密钥保护。普通转发不生成诊断编号、不采集耗时、不触发额外诊断；只有主动诊断请求返回编号和耗时。诊断不保存到云端数据库；报告包含完整上游 URL、请求头和响应头，目标响应正文不读取；production 可能读取匿名设备接口的必要 JSON，但不会把正文加入报告。客户端仅保留当前会话最近 50 条记录，可在设置中导出。



## 通用代理协议 v2

GET/HEAD/POST 与 Range 流式响应保持兼容。`/health` 返回 protocolVersion、methods、capabilities、extraAllowedHosts；App 在测试连接成功时读取，按代理地址与密钥隔离保存。修改配置后请在 App 再次测试连接。旧版代理仍沿用已有转发方式。

默认允许所有公网 HTTPS 域名，无需配置 EXTRA_ALLOWED_HOSTS 或逐个添加音源/CDN。health 返回 hostPolicy=public-https 和 public-https-hosts 能力。仅接受标准 HTTPS 443、有效域名，不接受 IP 字面量、本机和内网保留域名、URL 用户名密码。每次重定向重新检查地址；跨源时清除上游鉴权及自定义请求头。个人代理仍需连接密钥。旧 EXTRA_ALLOWED_HOSTS 变量无需删除，但不再限制范围。

支持通过 X-Proxy-Upstream-Headers JSON 传入最多 32 项、16 KiB 的上游请求头，包括 Authorization、Referer、Origin、Accept 和平台自定义头；它与个人代理连接密钥独立。Cookie 和连接控制头不接受，跨源重定向丢弃整组头；每次跳转重新检查目标规则。上游 Authorization 在诊断摘要中隐藏。普通请求不自动执行诊断。

支持 POST 转发：JSON、表单及二进制请求体上限 1 MiB，Content-Type 保持一致；仅 /proxy 接受 POST，连接密钥仍独立验证。POST 在 App 中直接走代理，不先直连、不自动重试。301/302/303 跳转转为 GET 并丢弃请求体；307/308 仅允许同源跳转，防止把请求体提交到其他站点。health 返回 post-body-v1 能力、POST 方法和请求体上限。现有 GET/HEAD/Range 保持流式响应。此协议不承诺 WebSocket、DRM 或特殊签名协议通用支持。新增这类传输能力仍可能需要更新 Worker；平台业务解析和签名优先留在 App。


## 转发范围

支持所有公网 HTTPS 域名的请求，逐次验证重定向，不转发调用方 Cookie 或授权。可选的 BILI_COOKIE 只用于精确列出的 B 站 API 路径；不会发往视频 CDN，也不会跟随重定向泄漏到其他主机。支持 GET、HEAD、POST、OPTIONS 和流式 Range 响应。平台限制、网络条件和 Cloudflare 免费额度仍适用。默认关闭日志采集及响应缓存。

B 站 API 正式转发总时限 15 秒、响应正文上限 2 MiB；诊断总时限 8 秒。Worker 内嵌 MIT 许可的 PeronGH/socket-fetch 固定版本，完整许可保留在 worker.mjs 中。代码许可见 LICENSE。
