# 我的个人音乐代理

这是从当前设备上的 Any Listen 导出的独立工程。仓库和 Cloudflare 服务均由你自己的账户管理，没有上游模板仓库、自动拉取更新或共享部署服务。

## 首次部署

1. 注册或登录 GitHub，创建 Private（私有）仓库，勾选 Add a README file。
2. 解压下载的 ZIP，将解压后的文件上传到仓库根目录。不要把 ZIP 文件本身上传到仓库。
3. 注册或登录 Cloudflare。在 Workers & Pages 中 Create application → Import a repository，连接 GitHub，仅授权此仓库。选择你的仓库。
4. 服务名称使用 any-listen-proxy-0fd437cd，与 wrangler.jsonc 中的 name 保持一致。项目根目录保持默认，构建命令留空，部署命令填写 npm run deploy。
5. 部署后，打开该 Worker 的 Settings → Variables and Secrets，新增类型为 Secret 的 PROXY_KEY，值为 App 中复制的连接密钥。保存并部署新版本。这是 Worker 的运行时 Secret，不是 Builds 的构建变量。
6. 复制该服务的 https://….workers.dev 地址回到 App，测试并连接。

## 配置与密钥

允许访问的播放器地址为 https://any-listen-browser-zhs.zhanghaosheng628.chatgpt.site，可自行修改 wrangler.jsonc 中的 APP_ORIGIN。连接密钥没有写入工程文件，请单独保存在 Cloudflare Secret 中。修改 PROXY_KEY 后，App 中也需使用相同的密钥。

## 维护与迁移

你可以编辑自己的代码、下载仓库、迁移账户、撤销 Cloudflare 的仓库权限，或者删除服务。撤销 GitHub 授权会停止后续自动构建，已部署的服务仍可继续运行。App 的后续更新不会自动修改你的仓库或云端服务；更新代理时，需要自行上传新工程并部署。

## 代理范围

仅转发允许列表中的 HTTPS 音乐请求；每次重定向都会重新检查目标地址。不转发调用方的 Cookie 或账户授权。支持 GET、HEAD、OPTIONS 和流式 Range 响应。上游登录、风控、地区限制、网络可达性及 Cloudflare 免费额度仍适用。

音频播放地址可能包含代理密钥，因此默认关闭日志采集，并禁止响应缓存。不要公开带有连接密钥的地址或开启 URL 访问日志。

## 本地开发（可选）

安装 Node.js 后运行 npm install，再通过 npx wrangler login 登录你自己的 Cloudflare 账户，使用 npm run deploy 部署。PROXY_KEY 可通过 npx wrangler secret put PROXY_KEY 设置。

代码许可见 LICENSE。
