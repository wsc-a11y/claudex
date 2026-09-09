# Task 5 Report: renderAuditDetail 登录句子增强

## 状态

完成。typecheck 通过(无输出,exit 0)。

## 改动位置说明

单文件:`web/src/screens/Settings.tsx` 的 `renderAuditDetail` 函数(约 1671-1711 行)。

具体改动:

1. 在 `uaLabel` helper 之后、`switch` 之前新增地址拼接 helper:
   ```ts
   // IP 与源端口拼成 "1.2.3.4:54321";缺 IP 返回 null,由调用方降级文案
   const addrText = (row: AuditEvent) =>
     row.ip ? `${row.ip}${row.port != null ? `:${row.port}` : ""}` : null;
   ```

2. 替换 `login` case:用 `parts` 数组拼装句子,追加"来源 {addr}"与"新设备"标记,以" · "连接:
   ```ts
   case "login": {
     const parts = [`来自 ${uaLabel(row.userAgent)} 的登录已通过双重验证`];
     const addr = addrText(row);
     if (addr) parts.push(`来源 ${addr}`);
     if (row.deviceIsNew) parts.push("新设备");
     return parts.join(" · ");
   }
   ```

3. 替换 `login_failed` case:
   ```ts
   case "login_failed":
     return `登录失败尝试,来源 ${addrText(row) ?? "未知 IP"}`;
   ```

4. 替换 `totp_failed` case:
   ```ts
   case "totp_failed":
     return `双重验证码错误,来源 ${addrText(row) ?? "未知 IP"}`;
   ```

其余 case(`logout`、`password_changed`、`session_deleted`、`permission_*`、`push_*`、`project_*`)与 `default` 分支一律未动。

## typecheck 输出

`pnpm --filter @claudex/web exec tsc --noEmit` — 无输出,无错误(exit 0)。

## 人工验收清单(不执行,照抄 brief Step 3)

1. 手机/电脑任一浏览器首次登录 → 设置→安全→Audit log 顶部新行应显示:"来自 {浏览器设备名} 的登录已通过双重验证 · 来源 {IP}:{端口} · 新设备"
2. 同浏览器再登 → 无"新设备"字样
3. 换浏览器/隐身登录 → 带"新设备"
4. 输错密码 → "登录失败尝试,来源 {IP}:{端口}"

## Concerns

无。改动为纯前端文案,与 brief 逐字一致;依赖的 `deviceId`、`deviceIsNew`、`port` 字段已在 shared 类型就绪(web typecheck 通过确认了这一点)。
