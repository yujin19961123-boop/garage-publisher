# Garage · 原型工作台

面向团队的静态网页原型发布与分享工具，使用 React、TypeScript、Go 和 PostgreSQL 构建。

成员上传已导出的网页原型，获得固定分享地址；后续更新沿用该地址。支持单个 HTML、完整文件夹、文件夹内的全部内容或 ZIP。浏览器自动打包文件，服务端自动识别首页，无需成员自己部署。

支持 Windows 本地启动和 Docker 部署。生产可将后台和原型放在同一域名，也可分开部署；部署方法见 [生产部署说明](docs/PRODUCTION_GARAGE.md)。仓库仅包含源码、示例配置和测试，不包含生产账号、用户原型或数据库。

**开发约定：默认只在本地修改和测试；只有用户明确说“同步上线”后，才更新服务器。** 完整协作规则见 [AGENTS.md](AGENTS.md)。

## 已有功能

- 管理员创建、停用成员账号及重置密码；成员登录后管理自己的项目。
- 管理员查看成员文件占用、成功登录次数及最近登录时间；登录数据自统计功能启用后累计，详见[成员使用统计](docs/MEMBER_STATS.md)。
- 创建项目并上传发布，更新已有项目时保留分享地址；改名不改地址。
- 项目默认按最近更新排序；支持桌面拖拽、触屏长按和键盘调整，按账号保存并同步个人合集顺序。
- 项目名称生成拼音标识，重名依次追加 `111`、`222` 等三位以内数字。
- 上传失败、校验失败或适配失败时，已有线上版本保持可访问。
- 项目卡片的“版本管理”入口可查看上传记录，并切换最多 5 个保留版本（包含当前版本）。满额后只能覆盖更新，原分享地址不变。
- “分享全部原型”生成个人固定合集链接，仅展示自己的已发布项目，新增和更新实时反映。
- 所有者可永久删除项目；发布中的项目需完成后再删。删除后合集移除、旧地址失效且不再分配给同名新项目，文件清理失败会自动重试。
- 管理员可查看全部项目，但不能编辑、更新或删除其他成员项目。
- 支持常见 Vite 产物及 Next.js 静态导出，自动适配可识别的资源与页面路径。

详细说明：[文件上传](docs/UPLOAD_INPUTS.md)、[Next.js 静态导出](docs/NEXT_STATIC.md)、[全部原型分享](docs/SHARE_PAGE.md)、[项目排序](docs/PROJECT_ORDER.md)、[合集底部互动](docs/SHARE_PLAY.md)、[版本管理](docs/VERSIONS.md)、[删除项目](docs/DELETE_PROJECT.md)、[开发基线](docs/DEVELOPMENT_BASELINE.md)、[测试指南](docs/VALIDATION.md)。开发基线包含历史设计，当前行为以代码和对应功能说明为准。

## 项目结构

```text
backend/     Go API、发布处理、静态托管和单元测试
frontend/    React + TypeScript 管理界面
infra/       Docker、Nginx 和生产部署示例
scripts/     Windows 启停、打包和验收脚本
docs/        功能、部署及测试说明
```

## 上传和资源适配

Next.js 支持上传完整静态导出文件夹（通常为 `out`），平台自动识别并适配项目路径；需要 `next start` 的服务不在当前托管范围。支持方式和访问边界见 [Next.js 静态原型](docs/NEXT_STATIC.md)。

上传内容必须是已导出的静态网页。单个 `.html` 文件可任意命名，所需本地资源应内联。文件夹、多文件和 ZIP 需包含 `index.html` 及所需资源，支持以下结构：

```text
index.html                 dist/                       导出文件夹/
assets/                      index.html                  dist/
                             assets/                       index.html
                                                           assets/
```

根目录存在首页时直接使用；否则仅沿唯一的外层文件夹逐层识别首页。存在多个候选文件夹时不会任意挑选。系统元数据会忽略，路径穿越、链接、加密 ZIP、重复路径和 `.env` 等隐藏敏感文件仍会被拒绝。

发布时在临时副本中自动适配常见资源路径：HTML 的资源引用、CSS 的 `url()` 与 `@import`、JavaScript 字符串和模板中的本地资源，以及常见 Vite 动态预加载入口。支持常见的 `/assets/`、图片目录、`/?...` 和 `/#...` 内部入口。外部网址保持不变，原始 ZIP 或本地文件不修改。

推荐新产物使用 Vite `base: './'` 和 React HashRouter。平台适配常见导出结构，但不承诺修复任意运行时拼接地址、BrowserRouter 逻辑或第三方接口；BrowserRouter 仍需按项目路径配置。仅上传源码、SSR 或依赖后端运行环境的应用不在支持范围内。

当前上限：ZIP 100 MiB、实际解压总量 500 MiB、单文件 100 MiB、10,000 个条目。上传入口显示实际限制。

## Windows 本地启动（无需 Docker）

本地使用 Node.js 24+、Go 1.26 工具链和 PostgreSQL。项目工具位于 `.tools/go/bin` 与 `.tools/pg-runtime/pgsql/bin`，无需手动修改系统 PATH。换电脑时先下载工具：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\download-tools.ps1
```

首次使用时复制并编辑 `.env.example`，设置数据库和初始管理员密码。已有 `.env` 时不要直接覆盖。随后执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

脚本初始化仅监听 `127.0.0.1:5432` 的数据库，编译前后端并隐藏启动服务。缺少前端依赖时会执行 `npm ci`，需要网络。初始管理员账号密码读取本机 `.env`，修改初始化变量不会重置已存在账号的密码。

默认本地模式保持双域：

- 后台：[http://console.localhost:8080](http://console.localhost:8080)
- 原型：`http://localhost:8080/<项目拼音>/`
- 合集：`http://localhost:8080/_share/<个人标识>/`

数据和日志保存在 `.local/`，停止服务会保留数据：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-local.ps1
```

不要删除 `.local/`。重启沿用现有账号和内容；端口 5432、8080、8081 应未被其他程序占用。修改数据库密码时，需要同时更新数据库角色密码及连接配置。本地工具用于开发，生产使用 HTTPS 和独立的生产配置。

## Docker 本地启动

先启动 Docker Desktop Linux 引擎。首次构建需要下载镜像及依赖。

```powershell
# 仅首次创建配置；已有 .env 时不要覆盖。
Copy-Item .env.example .env
# 编辑 .env，设置数据库与管理员密码。
docker compose up --build -d
docker compose ps
docker compose logs --tail 100 app
```

打开本地后台，使用 `.env` 中初始管理员账号登录。管理员仅在账号不存在时初始化。成员密码当前至少 6 位，允许纯数字；生产管理员和数据库应使用长随机密码。

```powershell
docker compose down
```

数据库及发布文件位于持久化命名卷。不要执行 `docker compose down -v`，该参数会删除持久数据。默认本地 Compose 不是 garage 的生产配置，生产步骤见 [生产部署说明](docs/PRODUCTION_GARAGE.md)。

## 开发配置与测试

开发需要 Go 1.26、Node.js 24+ 和 PostgreSQL。可用本地启停脚本准备环境，或只启动容器数据库：

```powershell
docker compose -f docker-compose.yml -f infra/compose.dev.yml up -d postgres
```

后端从进程环境读取配置；直接 `go run .` 前应自行设置环境变量，并确保数据库和数据目录可用。

| 变量 | 本地示例 | garage 生产配置 |
|---|---|---|
| `DATABASE_URL` | `postgres://prototype:<password>@localhost:5432/prototype?sslmode=disable` | 由生产环境提供，数据库不开放公网 |
| `LISTEN_ADDR` | `:8081` | 内部服务监听地址 |
| `DATA_DIR` | `./data` | 持久化数据目录 |
| `PUBLIC_DOMAIN` | `localhost` | `garage.byjin.cn` |
| `PUBLIC_PORT` | `8080` | `443` |
| `PUBLIC_SCHEME` | `http` | `https` |
| `PUBLIC_URL_MODE` | `path` | `path` |
| `SHARED_ORIGIN` | `false`（默认） | `true`，显式启用后台与原型同源 |
| `CONSOLE_URL` | `http://console.localhost:8080` | `https://garage.byjin.cn` |
| `ADMIN_HOSTS` | `console.localhost,127.0.0.1` | `garage.byjin.cn`，不含协议或端口 |
| `INIT_ADMIN_USERNAME` | 自行设置 | 首次初始化账号 |
| `INIT_ADMIN_PASSWORD` | 自行设置 | 首次初始化密码，不覆盖已有账号 |

连接 URL 中的特殊字符需要 URL 编码。使用 `.env` 配置脚本时，数据库密码建议采用长随机字母、数字、连字符和下划线组合。

```powershell
Set-Location backend
go test ./...
go vet ./...
go run .
```

另一个终端可启动前端开发服务，代理端口以 `frontend/vite.config.ts` 为准：

```powershell
Set-Location frontend
npm ci
npm run dev
```

纯文件上传测试无需启动服务，也不会创建项目：

```powershell
node scripts/test-upload-inputs.mjs
```

验收应使用真实浏览器：创建并发布文件夹或 ZIP，检查页面、图片、字体、桌面和移动入口、动态加载的页面及主要跳转；更新后原地址显示新版；新版移除的文件应返回 404。再验证无效上传保留旧版、成员间权限、合集内容和删除后的链接失效。不要仅以首页 HTML 返回 200 判定原型可用。

## 生产部署与信任边界

当前 garage 方案将后台、原型和合集放在同一浏览器源：

```text
https://garage.byjin.cn/                 管理后台
https://garage.byjin.cn/api/v1/...       管理 API
https://garage.byjin.cn/<项目拼音>/       原型
https://garage.byjin.cn/_share/<标识>/    个人合集
```

Nginx 提供后台根页面和后台静态资源，将管理 API、原型及合集请求转给应用。设置 `SHARED_ORIGIN=true`，并按 [生产部署说明](docs/PRODUCTION_GARAGE.md) 配置 TLS、持久化目录、数据库、初始化账号和验收。不要直接套用仓库内旧双域 Nginx 示例作为当前 garage 配置。

**单域模式仅适用于可信团队产物。** 上传的 HTML/JavaScript 虽不会在服务器作为程序执行，但会在查看者浏览器运行；同源原型能够访问同源存储，并以查看者登录态发起请求。HttpOnly Cookie 和 CSRF 无法将同源上传脚本变成安全沙箱。只向可信成员开放上传，不上传真实客户数据、账号密钥或需要严格保密的业务内容。分享链接可被转发，不是访问授权机制。

如需要隔离后台与原型，可使用默认双域方案：后台 `console.<域名>`，公共原型位于另一主机，`SHARED_ORIGIN=false`，分别配置 Host 白名单和证书。各原型之间仍共享公共主机的浏览器源。这是可选隔离部署，不是当前 garage 单域配置。旧 `p-<随机标识>` 子域链接在应用层保留兼容，远程访问仍取决于对应 DNS 与证书。

## 运维与限制

`GET /healthz` 提供健康检查；日志包含服务和发布错误。应监控磁盘、任务错误、证书和备份失败，数据库不得对公网开放。备份必须同时包含数据库与对应发布文件，并完成恢复演练。

当前为单机 MVP，应用、数据库或主机故障会影响访问。更新后需要刷新，已打开页面不会自动热更新。不提供在线编辑、在线构建或后端托管，也不保证 Service Worker/PWA 缓存行为。版本管理最多保留 5 个版本。覆盖后的旧文件会异步清理，发布记录仍可查看。清理失败会重试，待清理任务存在时暂停新上传，仍需监控磁盘与任务状态。删除项目同样使用持久清理任务。
