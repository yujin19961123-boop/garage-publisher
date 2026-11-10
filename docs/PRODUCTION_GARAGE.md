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

`scripts/test-production-garage.mjs` 是针对指定站点的验收脚本，会创建、发布并删除临时项目，只在明确选择目标站点及配置本地凭证后使用。通用检查方法见 [测试指南](VALIDATION.md)。不要将本地样例的通过结果当成其他产物或生产环境的验收。

## 数据与维护

数据库和发布内容分别位于 Compose 的 `postgres_data` 和 `release_data` 命名卷。备份必须在同一恢复点包含 PostgreSQL 逻辑备份和发布文件，可暂停新发布或使用一致性快照，并在异机完成恢复演练。备份保持私有。

升级前备份、记录源码和镜像版本，升级时保留命名卷。临时停止使用相同配置执行 `docker compose ... stop`；不要执行 `down -v` 或全局容器清理。监控磁盘、服务错误、发布失败、证书和备份。历史发布内容尚无完整自动过期策略，需要安排存储巡检。

当前为单机 MVP，不提供高可用、在线构建、后端托管或历史版本回滚界面。账号停用不会自动下线已发布原型，更新程序也不会重新处理已有产物；需要项目所有者重新上传发布才能应用新的资源适配。
