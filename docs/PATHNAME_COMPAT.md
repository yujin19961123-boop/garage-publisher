# URL 路径校验与项目子路径兼容

2026-11-17，经本次明确授权，已随 v0.4.1 同步上线。发布与验收记录见 [生产部署](PRODUCTION_GARAGE.md)。

## 问题与行为

teletask 的桌面容器使用 `url.pathname.match(/^\/pages\/…/)` 判断 iframe 内页是否有效。部署后的地址带项目路径，例如 `/teletask/pages/owned/`，原校验不匹配，容器把内页重新打开到顶层；内页又转回容器，造成无限加载。

新适配在这类匹配发生时，将同源 URL 的项目路径前缀临时扣除，仅用归一化后的路径执行原正则。原 URL 对象、`href`、query、hash 和正则本身不变；正则的捕获组、标志和原页面名判断继续可用。没有全局修改 `URL`、`Location`、字符串方法或浏览器 API。

另对 `new URL('/pages/...', location.href)` 这类浏览器 URL 构造补齐项目路径，避免跳到站点根目录的 `/pages/...` 而返回404。此处只处理原生 `URL` 且基地址明确来自浏览器 `location.href/origin` 的构造，动态参数只求值一次。外部基地址、局部遮蔽的 `URL/location`、未知资源根目录及内部路由字符串不改。

匹配范围有意受限：

- 识别原生 `new URL(...)`、由它初始化的 `const` 变量及未被局部遮蔽的浏览器 `location`。
- 路径校验仅处理其 `.pathname` 与直接正则字面量之间的 `match/search/matchAll` 或 `test/exec` 调用；浏览器 URL 构造按上方独立规则处理。
- 正则必须从根路径开始，并明确匹配上传包中存在的顶层目录，目录名边界必须完整。现有已带项目路径的校验、未知目录及普通业务对象不改。
- 仅归一化当前文档同源 URL，并按完整项目目录边界扣前缀。其他项目、跨域 URL、内部 Hash 路由字符串保持原值。

这不能代替任意框架的 base path 配置，也不自动推断动态构造的正则、可变 URL 别名或所有自定义路由状态。

## 新上传与已发布内容

新上传在私有处理副本内应用该规则，随后沿原有发布、完整性清单及原子切换流程保存版本；不修改用户原始 ZIP。

为了让已经发布的 teletask 直接恢复，静态托管也提供同样的窄范围响应兼容：仅对项目路径下不超过 2 MiB 的 `.js/.mjs` 文件进行语法分析，存在上述模式时生成兼容响应。无匹配、解析不支持或超限时保持原文件响应，不阻断原本可用的脚本；大型旧脚本可通过重新上传走完整的发布适配。

该响应兼容不重写历史文件、不重算或修改版本清单、不创建发布任务、不切换版本。转换后使用新内容长度处理 GET、HEAD 和 Range，并避免用旧文件的 Last-Modified 返回错误的 304。未使用项目路径的子域托管保持原行为。

## 本地验证

后端全量测试需传入本地 `TEST_DATABASE_URL`，数据库用例使用随机隔离 schema 并自行清理；`go vet` 已通过。`pathname_test.go` 覆盖捕获组、原始 URL/query/hash、跨域和相近前缀、不相关业务路径、局部 URL 遮蔽、一次求值、重复适配、HTTP 条件响应/HEAD/Range、磁盘内容不可变及真实托管入口。既有 Hash 路由与资源适配回归同时通过。

启动本地服务后运行：

```powershell
# 只测试临时 ZIP 项目。
node scripts/test-pathname-compat.mjs

# 额外只读验证当前 teletask 页面、Following 内容切换和刷新。
node scripts/test-pathname-compat.mjs /teletask/pages/owned/
```

脚本只连接本机，创建唯一命名的专用临时项目，使用真实 ZIP 验证首次发布、iframe 内页跳转、子页刷新以及第二次发布后原地址显示新版。结束核对所有者与项目名称后删除临时项目，并比较原有项目和当前版本指向；不重发或覆盖现有 teletask。

本地结果 `.local/pathname-compat-report.json` 为 `success:true, cleanup:true`，没有脚本错误或失败资源。现有本地 teletask 的 187 个发布文件（含完整性清单）逐项 SHA-256、当前版本及版本数量与验证前一致，记录于 `.local/teletask-path-invariants.json`。Owned 和 Following 桌面截图已查看，加载层消失且内容正常显示。

授权上线后，真实 HTTPS 的既有 teletask 页面、Following 内容切换、刷新及新 ZIP 发布/原地址更新也通过；根路径原生 URL 构造已纳入 ZIP 回归。线上报告 `.local/pathname-online-report.json` 为 `success:true, cleanup:true`，无脚本或资源错误，临时项目及文件已清理。现有账号、项目、版本、排序、分享地址和当前原型文件校验保持一致，其他网站未改动。历史文件不需要为了本次兼容而重传。
