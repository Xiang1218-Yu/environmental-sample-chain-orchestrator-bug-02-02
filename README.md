# Environmental Sample Chain Orchestrator

一个从 0-1 构建的环境样本链路编排项目基线，用来管理采样、容器封签、跨机构交接、实验室接收、分装、实验批次、仪器结果修订、质量复核和证据包导出。

## 当前实现

- `src/domain/types.ts`：领域对象、状态和同步模型
- `src/store/store.ts`：内存 Store、全局 ID、审计、Outbox 和事务快照回滚
- `src/services/sampling-service.ts`：采样记录与封存容器
- `src/services/custody-service.ts`：交出、接收、封签和温度轨迹
- `src/services/receiving-service.ts`：实验室接收、接受/隔离/拒收
- `src/services/aliquot-service.ts`：批量分装、单位换算、容量扣减和幂等操作
- `src/services/batch-service.ts`：实验批次成员、协议冻结和运行生命周期
- `src/services/result-service.ts`：仪器运行、外部运行号幂等和结果 revision
- `src/services/quality-service.ts`：质量结论、质控门槛和批次批准
- `src/services/evidence-service.ts`：一致性证据包、清单哈希和冻结
- `src/services/sync-service.ts`：离线 Envelope、客户端序列、payload 冲突和重放
- `src/demo/smoke.ts`：一条可运行的端到端样例

## 运行

```bash
npm install
npm run build
npm test
npm run smoke
```

## 交接流程并发与一致性保证

`custody.handOver` / `custody.confirmReceipt` / `custody.confirmReceipts` 都在 Store
互斥事务内执行（同步重放走 `*Core` 变体，避免重入加锁），保证以下不变量：

- **唯一持有人/位置**：任一时刻容器只有一个 `currentHolderId` 与 `currentLocation`；
  同一容器只允许存在一个 `PENDING_RECEIPT` 交接，并发交接最多一个成功。
- **交接序号单调可追溯**：`transferSequence` 在事务内按容器严格递增，每次交接、确认、
  隔离和拒绝都写审计与 Outbox；网络重试凭 `(tenantId, projectId, clientOperationId)`
  幂等，重复的交接/回执返回同一条记录，不产生第二条。
- **旧回执不倒退状态**：只有“当前最新且待接收”的交接可被确认；终态交接不可变，
  较新交接存在时旧回执抛 `custody.stale_receipt` / `custody.already_confirmed`，
  持有人、位置和封签都不会回退。
- **隔离结论不可覆盖**：封签按严重度合并（`INTACT < RESEALED < BROKEN < MISSING`），
  异常只会升不会降；已观察到异常后再报 `INTACT` 抛 `custody.seal_anomaly_conflict`，
  隔离容器不能通过再次交接逃逸，实验室也不能把异常容器 `ACCEPTED` 成正常。
- **批量部分失败可区分**：`confirmReceipts` 对每个对象独立提交，返回
  `confirmed`（`ACKNOWLEDGED`/`QUARANTINED`，含 `duplicate` 标记）与 `failed`
  （`REJECTED` + 机器可读错误码），拒绝同样落审计；单个对象失败不回滚其他对象。
- **离线重放**：`SyncEnvelope.type` 支持 `CONFIRM_RECEIPT`，离线终端的确认按
  同一套不变量重放，重复投递返回原结果。

