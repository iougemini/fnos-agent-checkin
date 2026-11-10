# Trae + WorkBuddy + Qoder 每日签到 · 飞牛 OS 版

把三个平台的每日签到放到飞牛（fnOS）或任意 Docker 主机上长期跑：**不用开着电脑、不用装客户端、不用守时间**。各登录一次把账号托管进去，服务自己续期令牌、按你设的时间签到，可选 Telegram / QQ 通知。

这是 [ggzhzc/workbuddy-trae-checkin](https://github.com/ggzhzc/workbuddy-trae-checkin) 的非官方移植：原来的 Cloudflare Worker 改成 Node.js 常驻进程。本仓库以 [GNU GPL-3.0-only](LICENSE) 发布。分发修改后的版本时，必须继续以 GPL-3.0 提供对应源代码。上游仓库没有附带许可证文件，不能把它说成 GPL；使用其中的代码谱系时，仍要遵守上游自己的说明。业务接口是非官方逆向，风险见文末。

| 原来的 Cloudflare | 现在 |
| --- | --- |
| Worker 短时运行 | 容器里的 Node + Hono，一直开着 |
| KV | SQLite 文件，挂在卷 `/data` |
| Cron Trigger（UTC 写死两轮） | 容器内定时，**默认**北京时间 08:10 和 10:20，可在控制台「定时」里改 |
| Secret | 环境变量做默认值；通知和定时在控制台保存后以数据库为准 |

加密方式没改：账号令牌和通知配置仍是 **AES-256-GCM**，每条记录独立 salt 和 IV，密钥由 `MASTER_KEY` 经 **HKDF-SHA256** 派生。接口不返回令牌。定时配置 `cron:config` 不含令牌，以明文 JSON 存在同一个库里。

| | Trae | WorkBuddy | Qoder |
| --- | --- | --- | --- |
| 加账号 | 抖音扫码，把回调链接粘回来 | 微信扫码 | 官网设备授权（国内版或国际版） |
| 签到 | 每日积分领取 | 每日签到 | 每日活动领取（credits） |

三个平台共用一套部署、一个数据库，数据按 `trae:` / `wb:` / `qoder:` 前缀隔开。

预构建镜像：`ghcr.io/iougemini/fnos-agent-checkin`。

> ## 如果你还没有账号，可以走我的邀请
>
> #### Qoder
> 国际版：https://qoder.com/activities?referral_code=y1wWIQOR6olp8KHMBxEFh9KtjCbx8vqU
> 国内版：https://qoder.cn/activities?referral_code=N8YsiGW8QA53bVmKZNxhE0w4BhtMjMOF
> #### Trae
> 国内版：https://www.trae.cn/events/code-fission/YAYKECXBPSBP?utm_source=copy_link&utm_medium=code_fission
> #### WorkBuddy
> 国际版：https://workbuddy.ai/invite?code=4MYB7B3W
> 国内版：https://www.workbuddy.cn/events/invite?inviteCode=4b2ij9c32825p

## 快速开始

飞牛需要能访问外网（拉镜像、签到接口、通知）。浏览器访问飞牛的局域网地址即可。

至少准备两个环境变量：

| 变量 | 作用 |
| --- | --- |
| `MASTER_KEY` | 加密密钥。32 字节随机数的 base64 |
| `ADMIN_TOKEN` | 控制台登录密码 |

生成 `MASTER_KEY`：

```bash
openssl rand -base64 32
```

浏览器控制台也可以：

```js
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
```

结果一般是 **44 个字符、以 `=` 结尾**。存进密码管理器。**`MASTER_KEY` 丢了，库里的令牌全部解不开，只能重新扫码。** 换密钥不会迁移旧数据。

### A. 飞牛 Docker Compose，在 NAS 上构建

适合改过代码、或还没有现成镜像的时候。目录里要有 `docker-compose.yml`、`Dockerfile`、`package.json`、`src/`。

1. 把项目放到飞牛，例如 `/vol1/1000/docker/checkin`。
2. `cp .env.example .env`，填好 `MASTER_KEY` 和 `ADMIN_TOKEN`。
3. 打开飞牛 **Docker → Compose**（有的版本叫「编排」或「项目」），新建项目，路径指向该目录，或把 `docker-compose.yml` 粘进编辑器。飞牛若另有环境变量表，把 `.env` 按同名填进去。
4. 启动：

```bash
docker compose up -d --build
docker compose logs -f checkin
```

5. 浏览器打开 `http://飞牛的局域网IP:8787`，密码是 `ADMIN_TOKEN`。

### B. 拉取预构建镜像

用仓库里的 `docker-compose.ghcr.yml`：

```yaml
image: ghcr.io/iougemini/fnos-agent-checkin:latest
```

```bash
cp .env.example .env
# 编辑 MASTER_KEY、ADMIN_TOKEN
docker compose -f docker-compose.ghcr.yml up -d
```

如果拉取失败，多半是包还是私有的，或镜像名大小写不对。

`docker-compose.image.yml` 适合本机已有 `fnos-agent-checkin:latest`（例如 `docker load` 导入），不走 GHCR。

### C. 飞牛应用中心导入 `.fpk`

从 [Release](https://github.com/iougemini/fnos-agent-checkin/releases) 下载 `fnos-agent-checkin-<版本>.fpk`，在飞牛 **应用中心 → 手动安装** 选这个文件。

安装包里没有镜像，安装时会从 GHCR 拉取。安装向导会要求填写：

| 向导字段 | 对应变量 | 说明 |
| --- | --- | --- |
| 控制台登录密码 | `ADMIN_TOKEN` | 必填 |
| 加密密钥 | `MASTER_KEY` | 必填，用 `openssl rand -base64 32` 生成 |
| 服务端口 | 宿主机端口 | 默认 `8787`，容器内仍是 8787 |
| 定时任务口令 | `CRON_SECRET` | 可选，留空则用控制台密码 |

Telegram / QQ / 定时时间装好后在网页控制台再配。以后改密码、密钥或端口：到该应用的 **设置**。Docker Compose 部署方式不变，仍用 `.env`。

默认端口 **8787**。只改映射的主机端口时，容器内保持 8787。防火墙放行对应 TCP 端口。

---

## 环境变量

`CRON_*` 以及通知、Qoder 通行证都是**还没在控制台保存过**时的默认值。定时一旦在「定时」里保存，就以数据库 `cron:config` 为准，不再读这些 `CRON_ENABLED` / `CRON_CATCHUP` / `CRON_JITTER_*`。通知同理：页面保存后以加密配置为准，不再读 `TG_*` / `QQ_*`。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MASTER_KEY` | 是 | 32 字节 base64。加密账号令牌和通知配置 |
| `ADMIN_TOKEN` | 是 | 控制台密码。请求头 `X-Admin-Token`，或 `Authorization: Bearer` |
| `CRON_SECRET` | 否 | `POST /cron` 的口令。留空则用 `ADMIN_TOKEN`。这项不进「定时」弹窗 |
| `CRON_ENABLED` | 否 | 默认 `1`。只在还没保存过定时配置时决定是否开启 |
| `CRON_CATCHUP` | 否 | 默认 `1`。启动补跑今天已过点但还没成功的轮次。补跑不等待抖动 |
| `CRON_JITTER_MIN_SEC` / `CRON_JITTER_MAX_SEC` | 否 | 默认 `0` 和 `900`。只作用于到点触发的定时，含两端。下限大于上限时自动对调 |
| `TZ` | 否 | 建议 `Asia/Shanghai`。定时按此时区解释 |
| `PORT` | 否 | 容器内端口，默认 `8787` |
| `DATA_DIR` | 否 | 数据目录，默认 `/data` |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | 否 | Telegram 默认值 |
| `TG_API_BASE` | 否 | Telegram API 根地址。留空用 `https://api.telegram.org`。反代填 `https://你的域名`，实际请求是 `<TG_API_BASE>/bot<token>/sendMessage` |
| `QQ_APP_ID` / `QQ_APP_SECRET` / `QQ_OPENID` / `QQ_SANDBOX` | 否 | QQ 机器人默认值 |
| `QODER_MACHINE_TOKEN` / `QODER_MACHINE_CODE` / `QODER_MACHINE_TYPE` | 否 | 国际版 Qoder 的设备通行证**回退值**。账号自己还没保存通行证时才会用。国内版账号不用这三项 |

没配 `MASTER_KEY` 或 `ADMIN_TOKEN` 时容器仍会启动。`/health` 的 `ready` 为 `false`。

---

## 定时

登录后点顶栏 **定时**。可以：

- 开关「开启定时签到」「启动补跑」（补跑不等待随机延迟）
- 编辑北京时间 `HH:MM`，1 到 8 个，不能重复。默认 **08:10** 和 **10:20**
- 设置随机延迟下限和上限，单位秒，默认 **0** 和 **900**

**保存** 后立刻生效，不用重建容器。

只有到点触发的定时会随机等待。下面三种不等待：

- 手动 `POST /cron`
- 控制台「全部签到」
- 启动补跑，以及保存时顺手补跑今天已过点、还没成功的时间

10:20 这轮的默认意义是：Qoder 的活动常常 10:00 后才下发，前一轮已经领过的账号会跳过。你改掉时间之后，仍是每个时间点把三个平台都跑一遍。

外部计划任务可以二选一，不必和内置定时叠在一起：

```bash
curl -sS -X POST "http://127.0.0.1:8787/cron" \
  -H "X-Cron-Secret: 你的CRON_SECRET"
```

```bash
curl -sS -X POST "http://127.0.0.1:8787/cron?key=你的CRON_SECRET"
```

口令错了返回 401。通知失败不影响签到结果。

`GET /health` 不需要登录，能看到当前生效的时间点。

---

## 打开控制台、添加账号

浏览器打开 `http://<飞牛IP>:8787`，输入 `ADMIN_TOKEN`。

顶栏「今日已签」是三个平台合计。「全部签到」三个平台一起跑。标签上的数字是当天已签数量。

### Trae（抖音扫码）

「添加账号」→ 抖音扫码确认 → 浏览器会停在一个打不开的 `127.0.0.1:17388` 页面（正常）→ 复制地址栏整段链接，粘到控制台右侧输入框，要带上 `?` 后面的参数。

### WorkBuddy（微信扫码）

「添加账号」→ 新窗口打开官方登录页 → 微信扫码确认 → 账号自动出现。二维码大约 5–6 分钟有效。官方登录页不能内嵌。

### Qoder（国内版 / 国际版）

两个按钮各走各的站点，账号上会记下区域。定时会把库里的国内版和国际版一起跑。旧账号没有区域字段时仍按国内版。

| | 国内版 | 国际版 |
| --- | --- | --- |
| 按钮 | 添加账号（国内版） | 添加账号（国际版） |
| 授权页 | `https://qoder.com.cn` | `https://qoder.com` |
| 接口 | `https://openapi.qoder.com.cn` | `https://openapi.qoder.sh` |

国际版如果提示只有营销活动或缺少设备通行证，不用删账号。在装了**国际版** Qoder 的电脑上运行 `runtime-info`，环境参数是 **3**（国内版是 0，不能混用），把 JSON 贴到该账号的「设备通行证」再签到。

```bash
# Linux
/opt/Qoder/resources/umid/runtime-info 3

# macOS
printf '%s\n' '{"account":"用户ID"}' | /Applications/Qoder.app/Contents/Resources/umid/runtime-info 3 --account-stdin

# Windows PowerShell
'{"account":"用户ID"}' | & "$env:LOCALAPPDATA/Programs/Qoder/resources/umid/runtime-info.exe" 3 --account-stdin
```

JSON 需要 `machineToken` 和 `machineType`，有 `machineCode` 就一并保存。也可以写成 `QODER_MACHINE_*`，只对还没单独保存通行证的国际版账号生效。同一套设备身份一天通常只能领一次。

---

## 通知

顶栏「通知」里 Telegram 和 QQ 各自独立，填完点「发测试」。每轮定时或「全部签到」跑完推一条汇总。都不配就跳过。

### Telegram

1. 找 [@BotFather](https://t.me/BotFather) 发 `/newbot`，拿到 Bot Token。
2. 先给 bot 发一条消息，再打开 `https://api.telegram.org/bot<token>/getUpdates` 取 chat id。用了反代时，把主机换成同一个 API 根地址。

**API 地址**留空就是官方。填 `https://user-proxy.example` 后，请求发到 `https://user-proxy.example/bot<token>/sendMessage`。不要把 `/bot` 和 token 写进去。

### QQ 官方机器人

到 [q.qq.com](https://q.qq.com) 创建机器人，填写 AppID 和 AppSecret。OpenID：

```bash
curl -O http://飞牛IP:8787/qq/openid-helper.mjs
node openid-helper.mjs <AppID> <AppSecret>
```

60 秒内用手机 QQ 给机器人发一条私聊。Windows 用 `curl.exe`。

---

## 数据放在哪

Compose 使用命名卷 **`fnos-agent-checkin-data`**，挂到容器 `/data`，库文件是 `/data/checkin.sqlite`。

- 重启、重建容器都不会丢掉这个卷。
- `docker compose down` 默认也不删卷。`docker compose down -v` 或在飞牛里删存储卷才会没。
- 备份卷的同时备份 `MASTER_KEY`。

想在文件管理里直接看到库，可以把卷改成绑定目录，并删掉 compose 底部的 `volumes:` 段：

```yaml
volumes:
  - /vol1/1000/docker/checkin/data:/data
```

账号正文和通知配置是密文。定时配置和账号列表索引（id、备注名）是明文，不含令牌。

---

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 页面提示未配置 `ADMIN_TOKEN` / `MASTER_KEY` | Compose：检查 `.env` 名字是否完全一致并重建容器。应用中心 `.fpk`：到应用 **设置** 填安装/配置向导里的密码与密钥 |
| `MASTER_KEY` 必须是 32 字节 | 重新生成，确认是 base64，不要多空格、不要带引号 |
| 容器一直重启 | 看日志。常见是 8787 被占用，或镜像没拉下来 |
| 拉取镜像 401 / 找不到包 | 包还是私有的，或镜像名大小写不对 |
| 列表是空的 | 还没加账号，或定时还没到 |
| Trae 扫码后停在「无法访问此网站」 | 正常。复制地址栏整段链接回来粘贴 |
| 粘贴后提示没找到 authCodeInfo | `?` 后面没复制全 |
| 显示限流 | 等冷却结束，或手动再跑 |
| 令牌失效 | 删掉该账号，重新添加 |
| 改了 `MASTER_KEY` 之后账号都打不开 | 旧密文解不开。改回原来的密钥，或删库重新扫码 |
| 定时没跑 | 看控制台「定时」是否开启，以及 `GET /health`。日志搜 `[cron]` |
| 改了定时却还是旧时间 | 确认点过保存。保存前用的是环境变量默认值 |
| 飞牛重启后没有马上签 | 开机时若开启了补跑，会补今天已过点的轮次，且不等待抖动 |

---

## 说明

这不是 Trae、WorkBuddy、Qoder 的官方客户端。接口来自逆向，对方升级后可能失效。只做签到，不做长期任务或兑换。建议只挂自己的账号。

令牌在签到那一刻会在进程内存里是明文。数据库里的账号和通知是密文。不要把 8787 暴露到公网；要暴露就放到你信任的反代和访问控制后面。

---

## 致谢

签到流程、控制台和三个平台的对接，来自 [ggzhzc/workbuddy-trae-checkin](https://github.com/ggzhzc/workbuddy-trae-checkin)。感谢上游把 Trae、WorkBuddy、Qoder 的每日签到收成一个 Cloudflare Worker。

本仓库是在此之上的非官方 Docker / 飞牛移植：换成常驻进程、SQLite、可在网页里改的定时。以 **GPL-3.0-only** 发布；再发布改过的版本时，要让接收者能拿到同样以 GPL-3.0 授权的源代码。上游仓库没有许可证文件，这里不把上游称为 GPL；沿用它的代码时，请同时尊重该项目的说明。
