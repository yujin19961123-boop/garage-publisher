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

GitHub Actions 会在 Linux 和 Windows 上执行后端测试与静态检查，并在 Linux 上构建前端和验证上传。依赖真实用户产物的可选测试在没有本地样例时会跳过。

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
