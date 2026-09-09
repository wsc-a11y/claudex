# Task 5: web — renderAuditDetail 登录句子增强

**Files:**
- Modify: `web/src/screens/Settings.tsx`(`renderAuditDetail` 函数,现约 1671-1711 行;uaLabel helper 在其上方约 1674-1682)

**Interfaces:**
- Consumes: 由 /api/audit 返回的 `AuditEvent`(shared 类型)新字段 `deviceId: string | null`、`deviceIsNew: boolean`、`port: number | null`(类型已就绪,web typecheck 应已认识它们)。
- Produces: 人类可读句子,登录事件显示来源 IP:端口 与"新设备"标记。

## Step 1: 修改 renderAuditDetail 的三个 case

当前 `renderAuditDetail` 结构(约 1671 起):

```ts
function renderAuditDetail(row: AuditEvent): string {
  const uaLabel = (ua: string | null | undefined) =>
    ua
      ? deviceLabel({ id: "", userAgent: ua, createdAt: "", lastUsedAt: null })
      : "未知设备";
  switch (row.event) {
    case "login":
      return `来自 ${uaLabel(row.userAgent)} 的登录已通过双重验证`;
    case "login_failed":
      return `登录失败尝试,来源 ${row.ip ?? "未知 IP"}`;
    ...
    case "totp_failed":
      return `双重验证码错误,来源 ${row.ip ?? "未知 IP"}`;
```

改为(在 `uaLabel` 之后、`switch` 之前插入一个地址拼接 helper;替换三个 case 的 return):

```ts
  // IP 与源端口拼成 "1.2.3.4:54321";缺 IP 返回 null,由调用方降级文案
  const addrText = (row: AuditEvent) =>
    row.ip ? `${row.ip}${row.port != null ? `:${row.port}` : ""}` : null;
  switch (row.event) {
    case "login": {
      const parts = [`来自 ${uaLabel(row.userAgent)} 的登录已通过双重验证`];
      const addr = addrText(row);
      if (addr) parts.push(`来源 ${addr}`);
      if (row.deviceIsNew) parts.push("新设备");
      return parts.join(" · ");
    }
    case "login_failed":
      return `登录失败尝试,来源 ${addrText(row) ?? "未知 IP"}`;
```

`totp_failed` case 同样替换:

```ts
    case "totp_failed":
      return `双重验证码错误,来源 ${addrText(row) ?? "未知 IP"}`;
```

其余 case 与 default 分支一律不动。

## Step 2: typecheck

Run: `pnpm --filter @claudex/web exec tsc --noEmit`
Expected: 无错误

## Step 3: 记录人工验收清单(不执行,写进报告)

1. 手机/电脑任一浏览器首次登录 → 设置→安全→Audit log 顶部新行应显示:"来自 {浏览器设备名} 的登录已通过双重验证 · 来源 {IP}:{端口} · 新设备"
2. 同浏览器再登 → 无"新设备"字样
3. 换浏览器/隐身登录 → 带"新设备"
4. 输错密码 → "登录失败尝试,来源 {IP}:{端口}"
