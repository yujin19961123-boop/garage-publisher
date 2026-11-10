# 生产部署

本指南使用仓库中的单域 Docker Compose 配置。示例配置沿用 `garage.byjin.cn`，自行部署时请替换为你控制的域名。实际服务器信息、验收截图和凭证不随源码发布。

## 部署方式与信任边界

`infra/production/compose.yml` 启用 `SHARED_ORIGIN=true`：管理后台在 `/`，原型在 `/<项目标识>/`，个人合集在 `/_share/<标识>/`。后台和原型共享浏览器源，上传页面中的 JavaScript 可以使用查看者登录态访问后台。该模式仅适用于可信团队产物，不能当作安全沙箱；分享链接也不是访问控制机制。

需要运行不可信产物时，应采用独立源部署，设置 `SHARED_ORIGIN=false`，并分别配置后台和原型主机名、DNS、TLS 证书及 Host 白名单。根目录 Compose 与 `infra/nginx.production.conf.example` 可作为双域配置参考。不同项目之间仍共享原型主机的浏览器源。

## 准备

服务器需要 Docker、Compose 和可终止 HTTPS 的宿主 Nginx。生产 Compose 的 web 默认只监听 `127.0.0.1:18080`，数据库和后端不映射宿主端口。

1. 将源码放到独立目录，例如 `/opt/garage-publisher/source`。
2. 将 `infra/production/.env.example` 复制到源码目录外的 `/opt/garage-publisher/.env`，将权限设为 `0600`。
3. 设置不同的强数据库密码和管理员密码；数据库密码使用 URL 安全字符。设置 `ADMIN_DOMAIN` 为自己的主机名，`HTTP_PORT` 为可用的本机端口。
4. 配置该域名的 DNS、HTTPS 证书及专属反向代理。不要覆盖服务器的全局 Nginx 配置或其他站点。

已有数据库中，修改 `INIT_ADMIN_PASSWORD` 不会重置账号；修改数据库连接密码也不会自动更改已有数据库角色密码。

## 构建与启动

```sh
cd /opt/garage-publisher/source
docker compose --env-file /opt/garage-publisher/.env -f infra/production/compose.yml config --quiet
docker compose --env-file /opt/garage-publisher/.env -f infra/production/compose.yml up --build -d
docker compose --env-file /opt/garage-publisher/.env -f infra/production/compose.yml ps
docker compose --env-file /opt/garage-publisher/.env -f infra/production/compose.yml logs --tail=100 app web
curl -H 'Host: your-domain.example' http://127.0.0.1:18080/healthz
```

将上面的 Host 替换为实际 `ADMIN_DOMAIN`，端口与 `HTTP_PORT` 保持一致。`config` 不带 `--quiet` 会展开密码，不要将其完整输出贴到公开日志。镜像构建需要访问镜像仓库和依赖源。

## Nginx 与 HTTPS

参考 `infra/production/host-nginx.bootstrap.conf.example` 和 `host-nginx.conf.example`，替换域名、ACME webroot、证书路径和反向代理端口。引导配置只用于首次签发证书，已有 HTTPS 站点不应被 HTTP 引导配置覆盖。配置检查通过后才重载 Nginx。

宿主 Nginx 将该域名转发到 `127.0.0.1:18080`，保留 Host 和协议头。上传两层代理均应允许 101 MiB 请求体并配置 600 秒超时，应用 ZIP 上限为 100 MiB。容器内 Nginx 仅在后台路径返回管理界面，其余项目和合集路径由后端处理。

证书应由服务器现有 ACME 工具管理并验证续期。仓库内 `renew-garage-certificate.py` 及相关 systemd 单元是针对指定域名和宝塔面板订单结构的专用示例，包含固定域名与目录；必须逐项核对和修改，不能直接当作通用续期程序安装，也不能无过滤续期其他站点。

## 验收

验证 HTTPS、HTTP 跳转、健康检查、管理员登录、成员权限，以及真实原型的发布、同链接更新、失败保护、合集和删除。必须在浏览器实际检查图片、字体、动态加载和主要跳转；首页返回 200 不代表原型可用。

`scripts/test-production-garage.mjs` 是针对指定站点的验收脚本，只在明确选择目标站点及配置本地凭证后使用。脚本先快照既有账号及项目的 ID、名称、地址、所有者和当前发布指向，只创建、发布、切换和删除本次随机名称的临时项目；测试 v1/v2、切回 v1 再恢复 v2、失败保留 v2、独立版本管理入口与合集，最后核对既有集合和字段不变。合集数量按当前账号原有已发布项目计算，不要求平台为空，也不清理已有项目。若测试期间其他成员正常修改项目，快照检查会失败，应人工核对原因，不能为了通过而恢复或删除其他人的数据。通用检查方法见 [测试指南](VALIDATION.md)。

发包使用 `node scripts/package-production.mjs`，仅收集受控后端源文件、模块文件、前端源文件和构建配置。后端 HTML/CSS/JavaScript 等 `go:embed` 静态资源必须随包提供，脚本自动核对各引用以及解压后的文件内容，不把 `.local`、`.env`、`.tools`、依赖目录或符号链接带入源码包。该校验用于发现漏文件，不能替代实际 Docker 构建及上线验收。

## 数据与维护

数据库和发布内容分别位于 Compose 的 `postgres_data` 和 `release_data` 命名卷。备份必须在同一恢复点包含 PostgreSQL 逻辑备份和发布文件，可暂停新发布或使用一致性快照，并在异机完成恢复演练。备份保持私有。

升级前先安排维护窗口并等待本站进行中的发布结束，停止本站 app，阻止继续写入；保留 PostgreSQL 运行以导出逻辑备份，同时备份 `release_data` 内容。在应用启动迁移前保存同一恢复点的数据库、文件及旧源码/镜像版本。以下仅为本站示例，路径应替换为实际当前源码目录，备份目录放在源码外并设为私有：

```sh
cd /opt/garage-publisher/source
umask 077
mkdir -p /opt/garage-publisher/backups/REPLACE_WITH_TIMESTAMP
docker compose --env-file /opt/garage-publisher/.env -f infra/production/compose.yml stop app
docker compose --env-file /opt/garage-publisher/.env -f infra/production/compose.yml exec -T postgres pg_dump -U prototype -d prototype -Fc > /opt/garage-publisher/backups/REPLACE_WITH_TIMESTAMP/database.dump
docker compose --env-file /opt/garage-publisher/.env -f infra/production/compose.yml run --rm -T --no-deps --entrypoint tar app -C /data -czf - . > /opt/garage-publisher/backups/REPLACE_WITH_TIMESTAMP/release-data.tar.gz
```

逐条检查命令成功、备份文件可读且非空后，再按本次变更构建并启动本站服务；失败不继续升级。仅停止 app 时，网页文件入口仍在，但 API 与原型访问暂不可用。备份需异机保存并恢复演练；不能仅检查文件存在便声称可恢复。备份中包含账号与原型数据，不公开其内容。

当前版本策略为每项目最多5个有效成功版本，包含当前版本；切换不新增名额、不改变上传顺序。超额产物异步清理，磁盘短时可能超过5份，清理未完成时阻止新上传，但仍可查看或切换可用版本。清理重新检查并保护当前版本与活动发布，失败保留任务重试；发布记录继续保留。已有数据启动时执行幂等编号及完整性清单迁移，因此升级前的数据库与文件备份尤其重要。详情见 [版本管理](VERSIONS.md)。仍需监控磁盘、服务错误、发布失败、清理失败、证书和备份。

升级时保留命名卷。禁止 `down -v`、清卷或全局容器清理；不得操作其他 Compose 项目。程序回退要结合数据库迁移兼容性判断，不能仅换旧镜像或只恢复数据库。临时停止继续使用相同本站配置的 `stop`。

当前为单机 MVP，不提供高可用、在线构建或后端托管。所有者可在独立“版本管理”界面切换保留范围内的成功版本；不提供已清理产物的恢复或任意历史版本存档。账号停用不会自动下线已发布原型，更新程序也不会重新适配已有产物；需要项目所有者重新上传发布才能应用新的资源适配。
