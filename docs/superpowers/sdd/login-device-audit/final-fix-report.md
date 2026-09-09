# Final Fix Report — login device audit

## 改动

- 文件:`server/tests/auth-device.test.ts`
- 位置:`describe("GET /api/audit device fields")` 用例中,`const row = res.json().events[0];` 之前
- 内容:插入一行前置断言 `expect(res.json().events).toHaveLength(1);`,使接口回退为空数组时失败信息更清晰(而非在 `events[0]` 取 `undefined` 后再在后续断言处报模糊错误)。
- 其余代码未改动。

## 测试输出

`pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts` — 6 passed(login device audit 3 + GET /api/audit device fields 1,以及 Task1/Task2 独立用例),全绿。
