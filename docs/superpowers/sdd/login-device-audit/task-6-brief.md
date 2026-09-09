# Task 6: FEATURES.md 更新 + 全量回归

**Files:**
- Modify: `docs/FEATURES.md`

## Step 1: 定位 FEATURES.md 中 Security/Audit 条目

Run: `grep -n -i "audit\|Security" docs/FEATURES.md | head -20`

阅读命中区域的上下文,确定该区是表格行还是段落式,找出描述 `audit_events` 表/审计日志现状的那一条(约在文件 350 行附近,Settings→Security 卡)。

## Step 2: 追加登录设备审计现状描述

保持该区原有格式(✅ 层级/表格列),在 audit 相关条目上追加/扩充一句描述,内容(可润色但语义必须完整覆盖):

登录审计含来源端口与设备号:audit_events 新增 device_id(claudex_device_id cookie)/device_is_new(首次登录成功的新设备标记)/port(源端口);成功登录签发设备号并判定新设备,失败与限流事件携带 device_id;Audit log 句子显示 IP:端口与新设备标记。

如原格式是表格(行形如 `| ✅ | 描述 | 位置 |`),请把该条目的描述列更新/追加。若不是表格,追加到描述审计的句子里。不要改动其他任何条目、不要删旧内容。

## Step 3: 全量回归

Run: `pnpm -r typecheck`
Expected: 全绿

Run: `pnpm --filter @claudex/server test`
Expected: 结果应与此前基线一致——除已知 Windows 环境类失败外全绿。已知基线:pty(2)、worktree(1)、resolveSlugToPath(2)共 5 个失败,外加 auth.test.ts 的 0o600 文件权限断言 1 个(Windows stat.mode 语义,测试注释自述 "On POSIX")。这些是 pre-existing,不要修。若出现**超出基线**的失败,报告详情,不要自行修改相关代码。

## Step 4: 验证 docs/FEATURES.md 的改动是本次会话唯一 doc 改动

Run: `ls docs/superpowers/specs/2026-09-09-login-audit-device-design.md docs/superpowers/plans/2026-09-09-login-device-audit.md`(确认存在即可,不删)。

## 完成后写报告

`d:\claudex\docs\superpowers\sdd\login-device-audit\task-6-report.md`
报告格式:状态 / FEATURES.md 改动位置与原文+新文摘录 / typecheck 输出 / 全量测试输出摘要(总通过/失败数与失败清单,注明是否与基线一致)/ Concerns。

回复我只返回:状态、FEATURES 改动一句话、测试一句话总结、concerns。