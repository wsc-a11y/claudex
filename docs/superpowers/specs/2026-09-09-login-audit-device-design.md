# 登录设备审计增强(方案 A)设计文档

- 日期:2026-09-09
- 状态:**用户已批准方案 A**,待审阅本 spec 后进入实施计划
- 用户拍板的三项决策:
  1. 设备区分用**设备号**(非纯 IP、非浏览器指纹)
  2. **纯记录,不做实时登录提醒**
  3. **不新增界面**,只补字段并增强现有 Audit log 的展示句子

## 背景与目标

用户在 claudex 自己的部署(Windows + Tailscale 直连,5179 绑 0.0.0.0)上,担心局域网内被陌生人登录。诉求:每次**真实登录**(输入凭据)记录来源设备/网络信息,形成日后可报警、可交给警方定位的证据链第一环。

现状(探索结论):

- `audit_events` 表已存在(migration 8),已记录 login / login_failed / totp_failed / totp_rate_limited / login_rate_limited 等事件,每条含 `created_at / ip / user_agent / detail`(auth/routes.ts 各落点通过局部 `reqCtx` helper 统一带 ip+UA)。
- 设置 → 安全 → Audit log 卡已有 UI;`renderAuditDetail`(web/src/screens/Settings.tsx:1671)把每行渲染成人话句子,但 **login 句子不显示 IP**。
- **没有任何"免密直接进入"路径**:进入已认证状态只有两条路——输凭据,或携带有效 JWT cookie(30 天)。cookie 直入不产生 audit 行,天然满足"不包括免密码直接进入"的要求,**无需新逻辑**。
- `GET /api/audit`(server/src/audit/routes.ts)返回 `AuditListResponse`(shared/src/models.ts:1297),`AuditEvent` zod 见 models.ts:1281-1295。

## 非目标(明确不做)

- 不做浏览器指纹、不做设备号防伪
- 不做新登录实时提醒(Alerts 推送)
- 不记录 cookie 自动进入
- 不新增任何界面/页面
- 不信任任何转发头(X-Forwarded-For 等),来源 IP 一律取 socket remoteAddress——部署形态决定溯源能力,见"证据链边界"

## 机制设计

### 1. 设备号 cookie

- 名称 `claudex_device_id`,值 `nanoid(16)`(项目已用 nanoid)
- **签发点**:仅 3 处登录成功路径——login 且 2FA 关闭(auth/routes.ts:193-196)、verify-totp 成功(266-269)、verify-recovery-code 成功(~336-339)。若请求已带该 cookie 则不再重签
- 属性:`httpOnly=false`(匿名标识而非凭据,前端无需读)、`SameSite=Lax`、`path=/`、`maxAge` 10 年、`secure` 判定逻辑复用现有 `cookieOpts`(auth/routes.ts:82-93,非安全上下文自动 false)
- 读取:从 `req.headers.cookie` 解析。浏览器对同源登录请求自动携带,**前端零改动**
- 语义:每台浏览器/设备一个号。删 cookie / 换浏览器 = 新号,下次登录以"新设备"现身(安全侧偏严,对用户是正向信号)

### 2. 数据库迁移 29

`server/src/db/index.ts` 的 MIGRATIONS 追加(id=28 之后):

```sql
ALTER TABLE audit_events ADD COLUMN device_id TEXT;
ALTER TABLE audit_events ADD COLUMN device_is_new INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audit_events ADD COLUMN port INTEGER;
```

- 不加索引(单用户规模,行数小,全扫无碍)
- 不改写历史行(旧行三列 NULL,API/UI 需 null 安全)

### 3. 记录点与数据流

- 扩展 auth 路由的 `reqCtx` helper(auth/routes.ts:120):返回对象加 `port = req.socket?.remotePort`(源端口,配合路由器 NAT/DHCP 会话表取证)
- 新 helper(放 auth 路由内):`readDeviceId(req)` 解析 cookie;`deviceIsNew(db, userId, deviceId)` 查库:`SELECT 1 FROM audit_events WHERE user_id = ? AND device_id = ? AND event IN ('login','recovery_code_used') LIMIT 1`,无历史 = 新。**注意**:恢复码登录成功的审计事件名是 `recovery_code_used`(auth/routes.ts:341),不是 `login`,判定必须覆盖两种成功事件
- 三类事件写入:
  - **成功登录**(login no-2fa / totp 成功 / recovery 成功):append 前调用 `deviceIsNew`(同号曾登录成功过则 false),行携带 `device_id + device_is_new + port`,user_id 已定
  - **失败类**(login_failed / totp_failed / recovery_code_failed / *_rate_limited):带 `device_id`(请求有则记,无则 null)+ `port`,`device_is_new` 保持 0(user_id 未知无法判定)
  - **其余非认证事件**(logout、password_changed 等):仅随 reqCtx 获得 port,device_id 可为 null(不强制)

### 4. API 与 shared 契约

`shared/src/models.ts` `AuditEvent` 增加三个 nullable 字段(向后兼容,旧行/旧客户端安全):

```ts
deviceId: z.string().nullable(),
deviceIsNew: z.boolean().nullable(),
port: z.number().int().nullable(),
```

`GET /api/audit`(audit/routes.ts + 其查询映射)把三列带出;空行填 null。

### 5. UI:仅增强现有渲染句子

`web/src/screens/Settings.tsx` `renderAuditDetail` 三个 case:

- `login`:`来自 {deviceLabel(UA)} 的登录已通过双重验证 · {ip}:{port} {新设备}`(有 deviceId 且 deviceIsNew 时加"新设备"标记;ip/port 为空时省略对应段)
- `login_failed`:`登录失败尝试,来源 {ip}:{port}`(UA 未知时维持现状)
- `totp_failed`:同上补充 port

不加新卡片、不加页面、不动 AuditLogCard 结构与筛选。

### 6. 取证字段汇总(每条 auth 事件最终记录)

| 字段 | 来源 | 说明 |
|---|---|---|
| created_at | 现有 | 时间戳 |
| event / detail | 现有 | 事件种类与上下文 |
| ip | 现有 | socket remoteAddress,无转发头信任 |
| **port(新)** | req.socket.remotePort | 源端口,可与路由器 NAT 会话表对时间窗 |
| **device_id(新)** | claudex_device_id cookie | 浏览器匿名号;首次见 = 新设备 |
| **device_is_new(新)** | 历史 login 行比对 | 仅成功登录时有意义 |
| user_agent | 现有 | 浏览器/OS 描述,UI 已解析成人话 |

## 证据链边界(如实声明,已在对话中告知用户)

- 记录的是"服务器所见来源"。当前 Tailscale 直连形态:IP 为 100.x,**与 tailnet 设备一一对应**,可在 Tailscale 后台指认到具体设备(MAC/OS/设备名)——这是当前形态下最强的第一环
- 若改回 frpc/隧道:所有来源显示同一隧道地址,IP 溯源失效(用户已改弃此形态)
- 局域网直连(不走 Tailscale)来源为 172.19.x 私网段,需路由器 DHCP/NAT 日志接力(port 字段配合时间窗)
- 拿不到:MAC 地址(不出网)、地理位置;设备号可被删除(以"新设备"再次出现,反而醒目)

## 测试计划

server(vitest,复用 tests/helpers.ts 的 app 构造模式):

1. 首次登录成功(2FA 关闭路径)→ 响应含 `Set-Cookie: claudex_device_id`;同 cookie 再登成功 → 不再重签
2. 库内断言:首次 login 行 `device_id` 非空且 `device_is_new=1`;同号第二次登录行 `device_is_new=0`;换新号登录行 `device_is_new=1`
3. login_failed 行:ip/port 非空,带 cookie 时 device_id 有值,device_is_new=0
4. port 断言非空整数(Fastify inject 若拿不到真实 remotePort,降级断言为非 null)
5. 迁移幂等:老库(migration 28 顶)升级后旧行三列为 NULL;GET /api/audit 对含 NULL 旧行不炸
6. 现有 audit 相关测试全绿(不回归)

web:typecheck 通过;renderAuditDetail 新文案人工验证(web 无组件测试框架,不硬造)

## 交付物与文件清单

| 文件 | 改动 |
|---|---|
| server/src/db/index.ts | MIGRATIONS 追加 id=29 |
| server/src/auth/routes.ts | reqCtx 加 port;device cookie 读写;成功三处签 cookie + deviceIsNew 判定与写入;失败类带 device_id |
| server/src/auth/index.ts 或新 auth/device.ts | 设备号生成/解析/查询 helper |
| server/src/audit/routes.ts(+ store 映射) | /api/audit 返回三新列 |
| shared/src/models.ts | AuditEvent 增三字段 |
| web/src/screens/Settings.tsx | renderAuditDetail 三个 case 文案增强 |
| docs/FEATURES.md | Security→Audit 条目更新:登录记录含来源端口/设备号/新设备标记 |

## 自检记录(写后即检)

- [x] 无 TBD/占位
- [x] 机制与非目标一致(不新增界面、不提醒、不防伪)
- [x] 范围聚焦单个实施计划(server 迁移 + auth 记录 + UI 文案 + FEATURES)
- [x] 歧义清零:device_is_new 仅成功 login 时计算;失败类恒 0;换 cookie=新设备
