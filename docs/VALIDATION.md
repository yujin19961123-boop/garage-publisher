# 测试指南

## 不需要数据库的检查

使用 Go 1.26+ 和 Node.js 24+，在项目根目录执行：

```sh
cd frontend
npm ci
npm run build
cd ..
node scripts/test-upload-inputs.mjs
cd backend
go test ./...
go vet ./...
```

后端测试覆盖 ZIP 解压及路径安全、入口识别、HTML/CSS/JavaScript 资源适配、Vite 动态加载、Next 静态页面、导航、固定地址、合集、删除和密码校验。上传测试覆盖文件夹、散文件、ZIP、目录分批读取、非法路径、容量限制和取消。

GitHub Actions 会在 Linux 和 Windows 上执行后端测试与静态检查，并在 Linux 上构建前端、验证上传及源码包的嵌入资源完整性。独立的 PostgreSQL 服务运行版本数据库集成测试，避免这些用例因缺少连接而跳过。依赖真实用户产物的可选测试在没有本地样例时会跳过。

Windows 本地工具位于 `.tools/go/bin`，可通过环境变量将 `GOCACHE`、`GOMODCACHE` 指向 `.tools` 下的对应缓存目录。

## 本地服务集成检查

先按 README 准备 `.env` 并启动本地服务。仅在独立测试环境中运行这些脚本，它们会创建账号、项目或发布记录，部分脚本会保留测试数据：

```powershell
$env:TEST_PORT='8080'
node scripts/e2e.mjs
node scripts/test-names.mjs
node scripts/test-auto-paths.mjs
node scripts/test-share-page.mjs
node scripts/test-delete-project.mjs
```

脚本从根目录 `.env` 读取测试管理员账号，不要使用生产凭证。删除脚本清理自己创建的项目，不代表其他脚本也自动清理全部数据。

## 真实浏览器验收

上传完整的静态原型，检查页面、图片、字体、动态导入、桌面和移动入口，以及浏览器刷新、前进后退。更新后确认原地址显示新版，删除的资源返回 404；上传无效包时原有版本继续可访问。另验证成员隔离、管理员只读边界、匿名合集和项目删除。

`test-preview-browser.mjs`、`test-next-preview.mjs` 和 `test-dist.mjs` 针对特定本地样例，需准备匹配的页面内容、项目路径、Chrome 和 ZIP；相关用户产物不包含在仓库中，不能直接作为全新克隆的通用验收。浏览器报告、截图和本地 ZIP 保存在被忽略的 `.local/` 中。

生产检查另见 [部署指南](PRODUCTION_GARAGE.md)。容器完整构建、HTTPS、续期、备份恢复、磁盘耗尽和长期存储增长需在对应环境独立验证，单元测试不替代这些检查。

## 项目版本管理验收

版本管理的本地端到端脚本为：

```powershell
node scripts/test-version-management.mjs
```

先启动已包含版本接口的本地后端和最新构建的界面，确保本地 `.env` 管理员可登录。脚本固定本地地址，使用实际 Chrome，通过浏览器内请求访问 API，创建并最终删除唯一临时项目，不新增账号、不改其他项目、不连接生产。

检查真实 ZIP 连续上传、5版保留与文件清理、同链接切换与资源路由、保留顺序、失败保护、当前版本冲突和重复切换、忙碌时禁止切换、超过20条记录的分页，以及真实版本面板的桌面/手机截图与键盘取消确认。详细范围与权限覆盖边界见 [项目版本说明](VERSIONS.md)。报告保存为 `.local/versions-result.json`。

实际本地运行已通过：`.local/versions-result.json` 为 `success:true`、`cleanup:true`，9个步骤全部成功。包含连续真实 ZIP、旧版本目录清理、同 URL 切换与资源/路由、坏包保护、冲突和无操作、忙碌阻止、23条发布记录跨页、桌面/手机截图以及 Escape 取消与 Enter 确认。临时项目已清理、测试会话已退出；未新增账号、未改变既有项目、未访问生产。

版本策略为**包含当前在内最多5版**；切换不产生新版本、不占名额、不重排上传顺序。异步清理可能使磁盘目录短暂超过5份，待清理任务存在时新上传返回 `409 CLEANUP_PENDING`，已有版本仍可查看和切换。测试脚本会等待清理结束，不将这个短暂状态误判为故障。

### 版本数据库集成测试

后端13项 `TestVersions...` 本地测试已全部通过，覆盖旧数据幂等编号和完整性清单补建、保留上限与当前版保护、清理排除当前与活动发布、其他所有者权限、过期当前冲突、缺失/过期/忙碌拒绝、同大小文件篡改、清理路径边界、20条分页、失败任务重试、恢复原路由模式和清单写入中断恢复。

这些用例必须显式提供 `TEST_DATABASE_URL`。只接受主机为 `localhost`、`127.0.0.1` 或 `::1` 的 PostgreSQL URL，并再次验证解析后的实际主机及备用主机；拒绝远程数据库。每个测试创建独立随机 `version_test_...` schema，固定其 `search_path`，使用临时文件目录，结束只清理自己的 schema，不在业务 `public` schema 中造数。连接账号需要创建、删除测试 schema 的权限。

在本地临时配置 `TEST_DATABASE_URL` 后运行：

```powershell
# TEST_DATABASE_URL 通过本地环境安全注入，不粘贴实际密码到聊天或日志。
.\.tools\go\bin\go.exe -C backend test -run TestVersions -v ./...
```

不设置 `TEST_DATABASE_URL` 时，默认 `go test ./...` **跳过这些数据库用例**；默认测试成功不能代替数据库集成测试成功。未连接生产、未执行生产迁移或部署。相关迁移、保留与清理规则见 [项目版本说明](VERSIONS.md)。

### 版本界面异常场景

```powershell
node scripts/test-version-ui-mock.mjs
```

此脚本只加载本地界面，拦截全部 API，不写数据库，也不创建账号或项目。8项检查已通过：发布与版本管理使用独立弹窗，版本自动加载；版本管理内没有上传和删除，切换期间锁定关闭与重复确认；响应丢失后重新确认当前版本并同步详情；读取失败保留记录且可重试；Escape 取消；刷新不循环；390/320宽度的长记录不溢出；管理员查看他人项目时不显示版本操作。结果保存至 `.local/versions-ui-mock-result.json`。这些模拟检查不能替代上面的真实 ZIP 或数据库验收。
