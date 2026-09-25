# Plastic Wan - 20260926 Models 页并发编辑不再覆盖别人的修改

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）对 Admin 前端 Models 页报了四条 high，确认都成立：

1. **模型编辑用的是最新 revision**（`src/pages/models.tsx`）。`ModelEditDialog` 只在打开时初始化一次表单，`saveModel` 提交的却是 `providers` 查询里最新的 `revision`。后台刷新带来别人的修改之后，用旧快照填的表单也能通过 `If-Match` 检查。冲突时 `write.failed` 刷新查询，提示语是「It has been read again - try once more」，用户照着再点一次 Save，就会用新 revision 提交旧表单，覆盖掉别人的修改。
2. **Header 行用可编辑的名字做 key**（`header-fields.tsx`）。`key={`${row.name}-${index}`}` 在每次按键时都会变，React 卸载再重建这一行，输入框失焦，只能打进第一个字符。
3. **删除后再加同名 header 时值丢失**（`header-fields.tsx`）。`removedHeaderNames` 只看 `existing` 行，所以删掉已保存的 `x-a` 再新增一行 `x-a` 时，`x-a` 仍在删除列表里；`headerPayload` 又是先写行、后写删除，新值被 `null` 覆盖。
4. **连接卡片的草稿只在挂载时初始化**（`provider-connection-card.tsx`）。父组件只按 alias 做 key，刷新后 `provider` 与 `revision` 变成新的，草稿却还是旧的。冲突后刷新尤其危险：服务端新增的 header 不在旧草稿的行里，`removedHeaderNames(新 header_names, 旧行)` 会把它当成用户删除；下一次只改 key 的保存会带着新 revision 把这个 header 删掉。

## 主要变更

### 1. 模型编辑提交打开时的 revision，冲突即关闭

`editing` state 增加 `revision`，点 Edit 时记录当时的值；`saveModel` 的 `mutationFn` 使用这个 revision。冲突时：

```ts
      if (isConfigConflict(error)) {
        setEditing(null);
        saveModel.reset();
        toast.error('config.jsonc changed while you were editing. Nothing was saved - open the model again to edit the current version.');
      }
```

对话框关闭，重新打开时从刷新后的定义开始编辑。本次修改会丢失，但不会悄悄覆盖别人的修改。

### 2. Header 纯逻辑移到 `lib/header-rows.ts`

`HeaderRow`、`headerRowsFromNames`、`headerPayload`、`headerValues`、`removedHeaderNames` 从组件文件移到 `src/lib/header-rows.ts`，和 `lib/model-manager.ts` 的做法一致。根目录 vitest 解析不了 `@/` 别名，组件文件没法直接做单元测试。三个调用方（`provider-connection-card`、`provider-wizard`、`model-picker-dialog`）都改为从新路径导入，组件文件不再导出这些函数，也没有留兼容的 re-export。

- `HeaderRow` 增加 `id`，由模块内计数器 `newRowId()` 生成。`headerRowsFromNames` 和「Add header」都会分配 id，组件用 `key={row.id}`。
- `removedHeaderNames` 把新行里（trim 后）的名字也算作「保留」：重新加回一个已删除的名字属于替换，不属于删除。
- `headerPayload` 先写删除、再写行，同名时总是新值生效。

### 3. 连接卡片记住草稿的基线

```ts
  const [baseline, setBaseline] = useState({ provider, revision });
```

- `baseUrlChanged` / `apiChanged` / `removedHeaderNames` / 「base_url 变化时不能删 header」的检查都对比 `baseline.provider`；`updateProvider` 使用 `baseline.revision`。
- `stale = revision !== baseline.revision`。草稿没有改动时，由一个 effect 直接把基线和各字段同步到新数据；草稿有改动时禁用 Save，并显示「config.jsonc changed since you started editing…」和一个 Reload 按钮，点 Reload 丢弃改动并从新数据重建草稿。
- 保存成功后用响应里的 provider 与 `result.revision` 重置草稿和基线（`resetDrafts`）。

### 4. 文档

- `agent-doc/admin-panel.md`「Models 页写端点」补充前端的 revision 规则：表单起步时的 revision、冲突后的处理、连接卡片的基线与 Reload、header 行的稳定 key。
- `agent-doc/verification.md` 的 e2e 覆盖契约补上 Models 页的并发编辑。

### 5. 测试

- 新增 `apps/admin-next/src/lib/header-rows.test.ts`（由根 vitest 的 `apps/admin-next/src/**/*.test.ts` 收录），覆盖：
  - 行 id 与名字无关，每次生成都不同；
  - 删掉 `x-api-key` 后新行重新加回，payload 发出的是新值，不是删除；
  - 删除与同名新值并存时新值生效。
- `apps/admin-next/e2e/08-models.e2e.ts` 新增三条，在真实 `AdminServer` 上跑。「另一位管理员」用 `page.evaluate` 在页面里直接调用写接口模拟，请求自动带上 Cookie 与同源 Origin：
  - `a header name can be typed key by key without losing focus`：用 `pressSequentially('x-typed')` 逐键输入，值必须完整。
  - `a model edit that loses a revision race is closed instead of overwriting`：编辑框打开后另一方把模型改名为 `Renamed elsewhere`。点 Save 后出现「Nothing was saved」提示，对话框关闭，API 里仍是 `Renamed elsewhere`。
  - `a connection edit built on an old revision cannot delete a header added meanwhile`：卡片里输入 key 后，另一方新增 header `x-added-elsewhere`。点 Save 因旧 revision 被拒；刷新后出现 stale 提示、Save 被禁用；点 Reload 后第二行显示新 header，API 里的 header 仍然存在。

## 验证

```bash
pnpm vitest run apps/admin-next/src/lib/header-rows.test.ts
# Tests 3 passed (3)

pnpm run admin:build
cd apps/admin-next && pnpm exec playwright test e2e/00-auth.e2e.ts e2e/08-models.e2e.ts
# 15 passed

pnpm run check
# 通过（后端 tsc + admin-next tsc）

pnpm run lint
# No fixes applied

pnpm test
# Test Files 46 passed (46) / Tests 517 passed (517)

git diff --check
# 无输出
```

反向验证：`git stash` 掉 `apps/admin-next/src/components` 与 `apps/admin-next/src/pages`，重新 `admin:build` 后再跑同样的 e2e：

```bash
# ✘ a header name can be typed key by key without losing focus          （toHaveValue 失败）
# ✘ a model edit that loses a revision race is closed instead of overwriting
# ✘ a connection edit built on an old revision cannot delete a header added meanwhile
# 3 failed | 12 passed  —— 随后 stash pop 并重新构建
```

全量 e2e（`pnpm exec playwright test`）里 `04-writes.e2e.ts › cancel pending sessions reports the audit result` 失败。原因是 `18b03fc` 把按钮从 “Cancel pending” 改成了 “Cancel ongoing”，这条 e2e 没有跟着改，和本次修改无关，这次没有动它。

还没做的：

- 扫描里 Admin 前端的其他问题（`infobar.tsx` 的可见性同步、`__root.tsx` 登出失败时仍显示已登出）不在本次范围内。
- `model-picker-dialog` 的追加模型仍然使用最新 revision。追加不会覆盖已有定义，扫描也没有报告这一处，这次没有改。

## 提交

```txt
92c0d0d Keep Models page edits from overwriting concurrent changes
```
