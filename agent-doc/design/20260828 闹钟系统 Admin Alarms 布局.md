# Admin Alarms 页面布局

Status: Confirmed

## 设计原则

- 即将执行的 Alarm 优先可见，同时保留完整历史审计。
- 取消是受控状态转换，不删除记录、不尝试中止已经 firing 的 Invocation。
- Alarm 与 Invocation 是不同审计对象；通过链接进入现有 Tool Session 详情。

## 整体结构

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Plastic Wan Admin  Overview  Tool sessions  Alarms  Messages ...          │
├────────────────────────────────────────────────────────────────────────────┤
│ Alarms                                                                     │
│ Audit scheduled follow-ups and cancel pending alarms.                      │
│                                                                            │
│ [State: All ▼] [Chat ID: __________] [Target user ID: ________] [Apply]   │
│                                                                            │
│ ┌─────────┬──────────────────┬────────────┬─────────────┬────────┬────────┐ │
│ │ Status  │ Scheduled        │ Chat/Topic │ Target user │ Summary│ Action │ │
│ ├─────────┼──────────────────┼────────────┼─────────────┼────────┼────────┤ │
│ │ pending │ 2026-08-29 14:30 │ Group / 42 │ Alice / 123 │ ...    │ Cancel │ │
│ │   expanded detail: created/fired/cancelled timestamps, reason,          │ │
│ │   full summary, Alarm ID, Invocation: Tool session #456 →               │ │
│ ├─────────┼──────────────────┼────────────┼─────────────┼────────┼────────┤ │
│ │ fired   │ ...              │ ...        │ ...         │ ...    │   —    │ │
│ └─────────┴──────────────────┴────────────┴─────────────┴────────┴────────┘ │
│                         [Load more]                                        │
└────────────────────────────────────────────────────────────────────────────┘
```

## 页面级布局

1. 标题与说明。
2. 单行筛选区：状态、Telegram Chat ID、Target User ID、Apply/Reset。
3. 可展开表格。
4. 使用现有 infinite query 的 `Load more` 分页。

## 表格字段

| 字段 | 行内显示 | 展开详情 |
| --- | --- | --- |
| Status | Ant Design `Tag` | 状态原因、Invocation outcome |
| Scheduled | 本地格式化绝对时间 | UTC 原值 |
| Chat/Topic | title 或 Chat ID；Topic ID 非 0 时追加 | conversation ID、Telegram Chat ID、thread ID |
| Target user | 显示名快照与 User ID | User ID 原值 |
| Summary | 单行截断 | 完整 1–500 字符内容 |
| Invocation | 有关联时显示 Tool session 链接 | Invocation ID 与终态 |
| Action | 仅 pending 显示 Cancel | 无 |

## 交互

| 输入 | 行为 |
| --- | --- |
| State | All / pending / firing / fired / cancelled 精确筛选 |
| Chat ID | 仅接受 Telegram Chat 整数 ID |
| Target user ID | 仅接受正整数 Telegram User ID |
| Apply | 应用筛选并从第一页重新查询 |
| Reset | 清空筛选并恢复默认排序 |
| Expand row | 展示完整 summary 与所有诊断时间/原因，不发新请求 |
| Invocation link | 导航至 `/invocations/$invocationId` |
| Cancel | 打开 `Popconfirm`；确认后调用删除端点，成功刷新列表 |

### 取消 Popconfirm

```text
┌────────────────────────────────────────┐
│ Cancel this pending alarm?             │
│ It will remain visible in audit history│
│                         [No] [Cancel]   │
└────────────────────────────────────────┘
```

确认期间按钮显示 busy。成功显示 toast；若已被 Scheduler claim，API 返回 409，保留当前行并提示刷新后的实际状态。

## 状态变体

- **Loading**：复用 `queryState()` 的加载占位。
- **Empty**：表格 empty 文案 `No alarms match these filters.`。
- **Error**：复用查询错误占位；取消错误用 toast 展示稳定消息。
- **Busy**：仅正在取消的行按钮 loading/disabled，不锁整页。
- **Pending priority**：无状态筛选时，所有 pending 按 `scheduled_at, id` 升序置顶；其余状态按最近状态时间、ID 倒序。

## 响应式约束

窄视口允许表格水平滚动；筛选区自动换行。Summary 保持最小列宽，操作列固定右侧（若现有页面没有固定列惯例，可仅水平滚动，不新增全局样式）。

## 组件树

```text
AlarmsPage
├─ FilterForm
├─ AlarmTable
│  ├─ StatusTag
│  ├─ InvocationLink
│  ├─ ExpandedAlarmDetail
│  └─ Popconfirm(CancelButton)
└─ LoadMoreButton
```

## 页面入口

- 导航：`Alarms`
- 路由：`/alarms`
- 查询：`GET /api/alarms`
- 取消：`DELETE /api/alarms/:id`
- Invocation：`/invocations/$invocationId`
