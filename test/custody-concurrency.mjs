import assert from 'node:assert/strict';
import { SampleChainApplication } from '../dist/app.js';

let sequence = 0;

function makeContainer(app, tenantId = 'tenant_a', projectId = 'project_a') {
  sequence += 1;
  const sealed = app.sampling.createSealedSample({
    tenantId,
    projectId,
    collectorId: 'collector_01',
    protocolVersion: 'water-v3',
    medium: 'WATER',
    collectedAt: '2026-10-06T08:00:00.000Z',
    location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-01' },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
    clientDeviceId: 'device_01',
    clientSequence: sequence,
    containerBarcode: `CNT-${sequence}`,
    sealCode: `SEAL-${sequence}`,
    totalVolumeMl: 100,
  });
  return sealed.container;
}

function handoverInput(container, overrides = {}) {
  return {
    tenantId: container.tenantId,
    projectId: container.projectId,
    containerId: container.id,
    fromHolderId: 'collector_01',
    toHolderId: 'courier_01',
    fromLocation: 'SITE-01',
    toLocation: 'LAB-A',
    handedOverAt: '2026-10-06T08:30:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: `op-${sequence}-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    receiverId: 'courier_01',
    receivedAt: '2026-10-06T09:00:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    ...overrides,
  };
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error.code === code, `expected ${code}`);
}

// 1. A network-duplicated handover (same operation id, same payload) is idempotent.
{
  const app = new SampleChainApplication();
  const container = makeContainer(app);
  const input = handoverInput(container, { clientOperationId: 'op-dup' });
  const versionBefore = container.version;
  const first = app.custody.handOver(input);
  const retried = app.custody.handOver(input);
  assert.equal(retried.id, first.id);
  assert.equal([...app.store.transfers.values()].length, 1);
  assert.equal(container.version, versionBefore + 1, 'retry must not apply the handover twice');
}

// 2. The same operation id with a different payload is a conflict, not a replay.
{
  const app = new SampleChainApplication();
  const container = makeContainer(app);
  const input = handoverInput(container, { clientOperationId: 'op-conflict' });
  app.custody.handOver(input);
  throwsCode(() => app.custody.handOver({ ...input, toHolderId: 'courier_99' }), 'custody.operation_conflict');
}

// 3. Another tenant reusing the operation id never receives this tenant's transfer.
{
  const app = new SampleChainApplication();
  const containerA = makeContainer(app, 'tenant_a');
  const containerB = makeContainer(app, 'tenant_b');
  const transferA = app.custody.handOver(handoverInput(containerA, { clientOperationId: 'shared-op' }));
  const transferB = app.custody.handOver(handoverInput(containerB, { clientOperationId: 'shared-op' }));
  assert.notEqual(transferB.id, transferA.id);
  assert.equal(transferB.tenantId, 'tenant_b');
  assert.equal(transferB.containerId, containerB.id);
}

// 4. Two terminals handing the same container to two receivers: exactly one holder.
{
  const app = new SampleChainApplication();
  const container = makeContainer(app);
  app.custody.handOver(handoverInput(container, { toHolderId: 'courier_01' }));
  throwsCode(() => app.custody.handOver(handoverInput(container, { toHolderId: 'courier_02', toLocation: 'LAB-B' })), 'custody.holder_mismatch');
  assert.throws(
    () => app.custody.handOver(handoverInput(container, { fromHolderId: 'courier_01', toHolderId: 'courier_02', fromLocation: 'LAB-A', toLocation: 'LAB-B' })),
    (error) => error.code === 'custody.pending_receipt' || error.code === 'custody.invalid_state');
  assert.equal(app.store.containers.get(container.id).currentHolderId, 'courier_01');
}

// 5. A backdated handover cannot move a container back to an old location.
{
  const app = new SampleChainApplication();
  const container = makeContainer(app);
  const t1 = app.custody.handOver(handoverInput(container, { handedOverAt: '2026-10-06T08:30:00.000Z' }));
  app.custody.confirmReceipt(t1.id, receipt());
  const t2 = app.custody.handOver(handoverInput(container, {
    fromHolderId: 'courier_01', toHolderId: 'courier_02', fromLocation: 'LAB-A', toLocation: 'LAB-B',
    handedOverAt: '2026-10-06T10:00:00.000Z',
  }));
  app.custody.confirmReceipt(t2.id, receipt({ receiverId: 'courier_02', receivedAt: '2026-10-06T10:30:00.000Z' }));
  throwsCode(() => app.custody.handOver(handoverInput(container, {
    fromHolderId: 'courier_02', toHolderId: 'collector_01', fromLocation: 'LAB-B', toLocation: 'SITE-01',
    handedOverAt: '2026-10-06T09:30:00.000Z',
  })), 'custody.out_of_order');
  const current = app.store.containers.get(container.id);
  assert.equal(current.currentHolderId, 'courier_02');
  assert.equal(current.currentLocation, 'LAB-B');
  assert.equal(t2.transferSequence, t1.transferSequence + 1);
}

// 6. A late duplicate receipt for an old transfer cannot regress the container.
{
  const app = new SampleChainApplication();
  const container = makeContainer(app);
  const t1 = app.custody.handOver(handoverInput(container, { handedOverAt: '2026-10-06T08:30:00.000Z' }));
  app.custody.confirmReceipt(t1.id, receipt());
  const t2 = app.custody.handOver(handoverInput(container, {
    fromHolderId: 'courier_01', toHolderId: 'courier_02', fromLocation: 'LAB-A', toLocation: 'LAB-B',
    handedOverAt: '2026-10-06T10:00:00.000Z',
  }));
  app.custody.confirmReceipt(t2.id, receipt({ receiverId: 'courier_02', receivedAt: '2026-10-06T10:30:00.000Z' }));
  const before = app.store.containers.get(container.id);
  const versionBefore = before.version;
  const replayed = app.custody.confirmReceipt(t1.id, receipt({ receivedAt: '2026-10-06T23:59:00.000Z' }));
  assert.equal(replayed.id, t1.id, 'replay must return the requested transfer, not a newer one');
  const after = app.store.containers.get(container.id);
  assert.equal(after.currentHolderId, 'courier_02');
  assert.equal(after.currentLocation, 'LAB-B');
  assert.equal(after.version, versionBefore, 'old receipt must not touch container state');
}

// 7. A receipt arriving after lab acceptance must not regress RELEASED_TO_LAB.
{
  const app = new SampleChainApplication();
  const container = makeContainer(app);
  const t1 = app.custody.handOver(handoverInput(container));
  app.receiving.receive({
    tenantId: container.tenantId, projectId: container.projectId, containerId: container.id,
    receivedBy: 'lab_01', receivedAt: '2026-10-06T08:45:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'recv-1',
  });
  assert.equal(app.store.containers.get(container.id).custodyStatus, 'RELEASED_TO_LAB');
  const settled = app.custody.confirmReceipt(t1.id, receipt({ receivedAt: '2026-10-06T08:50:00.000Z' }));
  assert.equal(settled.status, 'CONFIRMED');
  assert.equal(app.store.containers.get(container.id).custodyStatus, 'RELEASED_TO_LAB', 'late receipt must not pull the container back');
}

// 8. A container isolated for a broken seal stays isolated; batch confirm cannot normalize it.
{
  const app = new SampleChainApplication();
  const container = makeContainer(app);
  const isolated = app.custody.handOver(handoverInput(container, { sealStatus: 'BROKEN' }));
  assert.equal(isolated.status, 'ISOLATED');
  const [result] = app.custody.confirmReceiptBatch([{ transferId: isolated.id, ...receipt({ sealStatus: 'INTACT' }) }]);
  assert.equal(result.outcome, 'ALREADY_SETTLED');
  assert.equal(result.status, 'ISOLATED');
  assert.equal(result.applied, false);
  const current = app.store.containers.get(container.id);
  assert.equal(current.custodyStatus, 'ISOLATED');
  assert.equal(current.sealStatus, 'BROKEN');
  throwsCode(() => app.custody.handOver(handoverInput(container, {
    fromHolderId: 'courier_01', toHolderId: 'courier_02', fromLocation: 'LAB-A', toLocation: 'LAB-B', handedOverAt: '2026-10-06T11:00:00.000Z',
  })), 'custody.invalid_state');
}

// 9. A broken seal found at receipt isolates; a later "intact" duplicate cannot overwrite it.
{
  const app = new SampleChainApplication();
  const container = makeContainer(app);
  const transfer = app.custody.handOver(handoverInput(container));
  const settled = app.custody.confirmReceipt(transfer.id, receipt({ sealStatus: 'BROKEN' }));
  assert.equal(settled.status, 'ISOLATED');
  const replayed = app.custody.confirmReceipt(transfer.id, receipt({ sealStatus: 'INTACT' }));
  assert.equal(replayed.status, 'ISOLATED');
  const current = app.store.containers.get(container.id);
  assert.equal(current.custodyStatus, 'ISOLATED');
  assert.equal(current.sealStatus, 'BROKEN');
  assert.ok(app.store.audit.some((entry) => entry.action === 'custody.receipt_conflict_ignored' && entry.entityId === transfer.id));
}

// 10. Batch confirm: partial failure distinguishes confirmed from unconfirmed objects.
{
  const app = new SampleChainApplication();
  const containerA = makeContainer(app);
  const containerB = makeContainer(app);
  const transferA = app.custody.handOver(handoverInput(containerA));
  const transferB = app.custody.handOver(handoverInput(containerB));
  const results = app.custody.confirmReceiptBatch([
    { transferId: transferA.id, ...receipt() },
    { transferId: 'transfer_missing', ...receipt() },
    { transferId: transferB.id, ...receipt({ receiverId: 'courier_99' }) },
  ]);
  assert.deepEqual(results.map((item) => item.outcome), ['CONFIRMED', 'REJECTED', 'REJECTED']);
  assert.equal(results[0].applied, true);
  assert.equal(results[1].errorCode, 'custody.transfer_not_found');
  assert.equal(results[1].status, null);
  assert.equal(results[2].errorCode, 'custody.receiver_mismatch');
  assert.equal(results[2].status, 'PENDING_RECEIPT', 'unconfirmed object stays visibly pending');
  // Retrying the same batch (network jitter) is idempotent per item.
  const retried = app.custody.confirmReceiptBatch([
    { transferId: transferA.id, ...receipt() },
    { transferId: transferB.id, ...receipt({ receiverId: 'courier_99' }) },
  ]);
  assert.equal(retried[0].outcome, 'ALREADY_SETTLED');
  assert.equal(retried[0].applied, false);
  assert.equal(retried[1].outcome, 'REJECTED');
  // The failed item can still be confirmed with the right receiver.
  const [fixed] = app.custody.confirmReceiptBatch([{ transferId: transferB.id, ...receipt() }]);
  assert.equal(fixed.outcome, 'CONFIRMED');
}

// 11. Two terminals confirming the same transfer: applied exactly once.
{
  const app = new SampleChainApplication();
  const container = makeContainer(app);
  const transfer = app.custody.handOver(handoverInput(container));
  const first = app.custody.confirmReceipt(transfer.id, receipt());
  const second = app.custody.confirmReceipt(transfer.id, receipt());
  assert.equal(second.id, first.id);
  assert.equal(second.version, first.version);
  const receipts = app.store.audit.filter((entry) => entry.action === 'custody.received' && entry.entityId === transfer.id);
  assert.equal(receipts.length, 1);
  assert.equal(first.receivedBy, 'courier_01');
  assert.equal(first.receiptSealStatus, 'INTACT');
  assert.equal(first.sealStatus, 'INTACT', 'handover-time seal record is preserved');
}

// 12. A receipt cannot predate its handover.
{
  const app = new SampleChainApplication();
  const container = makeContainer(app);
  const transfer = app.custody.handOver(handoverInput(container, { handedOverAt: '2026-10-06T08:30:00.000Z' }));
  throwsCode(() => app.custody.confirmReceipt(transfer.id, receipt({ receivedAt: '2026-10-06T08:00:00.000Z' })), 'custody.receipt_before_handover');
}

// 13. Transfer sequences stay unique and strictly increasing per container.
{
  const app = new SampleChainApplication();
  const container = makeContainer(app);
  const t1 = app.custody.handOver(handoverInput(container, { handedOverAt: '2026-10-06T08:30:00.000Z' }));
  app.custody.confirmReceipt(t1.id, receipt());
  const t2 = app.custody.handOver(handoverInput(container, {
    fromHolderId: 'courier_01', toHolderId: 'courier_02', fromLocation: 'LAB-A', toLocation: 'LAB-B',
    handedOverAt: '2026-10-06T10:00:00.000Z',
  }));
  app.custody.confirmReceipt(t2.id, receipt({ receiverId: 'courier_02', receivedAt: '2026-10-06T10:30:00.000Z' }));
  const sequences = [...app.store.transfers.values()]
    .filter((item) => item.containerId === container.id)
    .map((item) => item.transferSequence);
  assert.deepEqual(sequences, [1, 2]);
}

console.log('custody concurrency checks passed');
