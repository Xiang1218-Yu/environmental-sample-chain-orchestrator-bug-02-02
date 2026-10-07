import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../dist/app.js';

const TENANT = 'tenant_test';
const PROJECT = 'project_custody';

/**
 * Build one fresh sealed container held by collector_01 at SITE-A.
 * Each call uses its own client device/sequence so samples are independent.
 */
function sealContainer(app, suffix) {
  return app.sampling.createSealedSample({
    tenantId: TENANT,
    projectId: PROJECT,
    collectorId: 'collector_01',
    protocolVersion: 'water-v3',
    medium: 'WATER',
    collectedAt: `2026-10-07T08:0${suffix}:00.000Z`,
    location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-A' },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
    clientDeviceId: `device_${suffix}`,
    clientSequence: 1,
    containerBarcode: `CNT-${suffix}`,
    sealCode: `SEAL-${suffix}`,
    totalVolumeMl: 100,
  });
}

function receiptInput(overrides = {}) {
  return {
    tenantId: TENANT,
    projectId: PROJECT,
    receiverId: 'courier_01',
    receivedAt: '2026-10-07T10:00:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: 'receipt-001',
    ...overrides,
  };
}

test('duplicated receipt request (same operation id) is applied exactly once under concurrency', async () => {
  const app = new SampleChainApplication();
  const sealed = sealContainer(app, 1);
  const transfer = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'handover-1',
  });

  // Network jitter: the same confirmation fired twice at the same time.
  const [first, second] = await Promise.all([
    app.custody.confirmReceipt(transfer.id, receiptInput()),
    app.custody.confirmReceipt(transfer.id, receiptInput()),
  ]);

  assert.equal(first.status, 'CONFIRMED');
  assert.equal(second.status, 'CONFIRMED');
  const stored = app.store.transfers.get(transfer.id);
  assert.equal(stored.status, 'CONFIRMED');
  assert.equal(stored.receiptOperationId, 'receipt-001');
  const container = app.store.containers.get(sealed.container.id);
  assert.equal(container.currentHolderId, 'courier_01');
  assert.equal(container.currentLocation, 'LAB-A');
  assert.equal(container.custodyStatus, 'RECEIVED');
  // Exactly one receipt event for the retried operation.
  const receiptAudits = app.store.audit.filter((a) => a.entityId === transfer.id && a.metadata.operationId === 'receipt-001');
  assert.equal(receiptAudits.length, 1);
});

test('two terminals confirming with different operation ids: exactly one winner', async () => {
  const app = new SampleChainApplication();
  const sealed = sealContainer(app, 2);
  const transfer = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'handover-2',
  });

  const results = await Promise.allSettled([
    app.custody.confirmReceipt(transfer.id, receiptInput({ clientOperationId: 'terminal-a' })),
    app.custody.confirmReceipt(transfer.id, receiptInput({ clientOperationId: 'terminal-b' })),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'custody.already_confirmed');
  const container = app.store.containers.get(sealed.container.id);
  assert.equal(container.currentHolderId, 'courier_01');
  assert.equal([...app.store.transfers.values()].filter((t) => t.containerId === sealed.container.id && t.status === 'CONFIRMED').length, 1);
});

test('concurrent handover of the same container cannot produce two open transfers or two holders', async () => {
  const app = new SampleChainApplication();
  const sealed = sealContainer(app, 3);
  const base = {
    tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
    fromHolderId: 'collector_01',
    fromLocation: 'SITE-A', handedOverAt: '2026-10-07T08:30:00.000Z',
    temperatureCelsius: 5, sealStatus: 'INTACT',
  };
  const results = await Promise.allSettled([
    app.custody.handOver({ ...base, toHolderId: 'courier_01', toLocation: 'LAB-A', clientOperationId: 'hop-a' }),
    app.custody.handOver({ ...base, toHolderId: 'courier_01', toLocation: 'LAB-A', clientOperationId: 'hop-b' }),
  ]);
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.ok(['custody.pending_receipt', 'custody.holder_mismatch'].includes(rejected[0].reason.code));
  const pending = [...app.store.transfers.values()].filter((t) => t.containerId === sealed.container.id && t.status === 'PENDING_RECEIPT');
  assert.equal(pending.length, 1);
  const container = app.store.containers.get(sealed.container.id);
  assert.equal(container.currentHolderId, 'courier_01');
  assert.equal(container.currentLocation, 'LAB-A');
});

test('a late receipt for an old transfer cannot roll holder/location backwards after a new handover', async () => {
  const app = new SampleChainApplication();
  const sealed = sealContainer(app, 4);
  // Hop 1: collector -> courier, confirmed.
  const hop1 = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'hop-1',
  });
  await app.custody.confirmReceipt(hop1.id, receiptInput({ clientOperationId: 'receipt-1' }));
  assert.equal(hop1.transferSequence, 1);

  // Hop 2: courier -> lab, still pending receipt.
  const hop2 = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
    fromHolderId: 'courier_01', toHolderId: 'lab_01',
    fromLocation: 'LAB-A', toLocation: 'LAB-BENCH',
    handedOverAt: '2026-10-07T09:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'hop-2',
  });
  assert.equal(hop2.transferSequence, 2);

  // Old, duplicated receipt for hop 1 arrives late (replay of the same operation):
  // it must be a no-op idempotent hit, not a state rollback.
  const replay = await app.custody.confirmReceipt(hop1.id, receiptInput({ clientOperationId: 'receipt-1' }));
  assert.equal(replay.id, hop1.id);
  const container = app.store.containers.get(sealed.container.id);
  assert.equal(container.currentHolderId, 'lab_01');
  assert.equal(container.currentLocation, 'LAB-BENCH');
  assert.equal(container.custodyStatus, 'HANDED_OVER');

  // A *different* stale receipt operation against hop 1 must be rejected outright.
  await assert.rejects(
    app.custody.confirmReceipt(hop1.id, receiptInput({ clientOperationId: 'stale-receipt', receivedAt: '2026-10-07T07:00:00.000Z' })),
    (error) => error.code === 'custody.superseded_by_open_transfer' || error.code === 'custody.already_confirmed',
  );
  assert.equal(container.currentHolderId, 'lab_01');
  assert.equal(container.currentLocation, 'LAB-BENCH');
});

test('seal anomaly observed at handover isolates the container and cannot be covered by an INTACT receipt', async () => {
  const app = new SampleChainApplication();
  const sealed = sealContainer(app, 5);
  const transfer = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'BROKEN', clientOperationId: 'handover-broken',
  });
  assert.equal(transfer.status, 'ISOLATED');
  const container = app.store.containers.get(sealed.container.id);
  assert.equal(container.custodyStatus, 'ISOLATED');
  assert.equal(container.sealStatus, 'BROKEN');

  // A batch confirmation trying to normalise the broken seal is rejected.
  const batch = await app.custody.confirmReceipts({
    tenantId: TENANT, projectId: PROJECT,
    items: [{ transferId: transfer.id, receipt: {
      receiverId: 'courier_01', receivedAt: '2026-10-07T10:00:00.000Z',
      temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: 'cover-up',
    } }],
  });
  assert.equal(batch.confirmed.length, 0);
  assert.equal(batch.failed.length, 1);
  assert.equal(batch.failed[0].status, 'REJECTED');
  // Terminal ISOLATED handover is immutable; an INTACT claim can never reopen it.
  assert.ok(['custody.seal_anomaly_conflict', 'custody.already_confirmed'].includes(batch.failed[0].errorCode), batch.failed[0].errorCode);
  assert.equal(app.store.containers.get(sealed.container.id).sealStatus, 'BROKEN');
  assert.equal(app.store.containers.get(sealed.container.id).custodyStatus, 'ISOLATED');
});

test('anomaly found at receipt time quarantines; later INTACT receipts cannot override it', async () => {
  const app = new SampleChainApplication();
  const sealed = sealContainer(app, 6);
  const transfer = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'handover-6',
  });
  await app.custody.confirmReceipt(transfer.id, receiptInput({ sealStatus: 'MISSING', clientOperationId: 'receipt-missing' }));
  const container = app.store.containers.get(sealed.container.id);
  assert.equal(container.sealStatus, 'MISSING');
  assert.equal(container.custodyStatus, 'ISOLATED');

  // Another terminal later claims the seal is intact — must not downgrade the anomaly.
  await assert.rejects(
    app.custody.confirmReceipt(transfer.id, receiptInput({ sealStatus: 'INTACT', clientOperationId: 'receipt-late-intact' })),
    /already confirmed|anomaly/,
  );
  assert.equal(app.store.containers.get(sealed.container.id).sealStatus, 'MISSING');
  assert.equal(app.store.containers.get(sealed.container.id).custodyStatus, 'ISOLATED');
});

test('batch confirmation partitions confirmed/quarantined/duplicated from rejected objects', async () => {
  const app = new SampleChainApplication();
  // Container A: healthy, will confirm.
  const a = sealContainer(app, 'a');
  const hopA = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: a.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'hop-a',
  });
  // Container B: seal broken at receipt -> quarantined, still acknowledged.
  const b = sealContainer(app, 'b');
  const hopB = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: b.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:31:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'hop-b',
  });
  // Container C: healthy but confirmation names the wrong receiver -> rejected.
  const c = sealContainer(app, 'c');
  const hopC = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: c.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:32:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'hop-c',
  });

  const batch = await app.custody.confirmReceipts({
    tenantId: TENANT, projectId: PROJECT,
    items: [
      { transferId: hopA.id, receipt: { receiverId: 'courier_01', receivedAt: '2026-10-07T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: 'rcpt-a' } },
      { transferId: hopB.id, receipt: { receiverId: 'courier_01', receivedAt: '2026-10-07T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'BROKEN', clientOperationId: 'rcpt-b' } },
      { transferId: hopC.id, receipt: { receiverId: 'someone_else', receivedAt: '2026-10-07T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: 'rcpt-c' } },
    ],
  });

  assert.equal(batch.confirmed.length, 2);
  assert.equal(batch.failed.length, 1);
  const statuses = batch.confirmed.map((o) => o.status).sort();
  assert.deepEqual(statuses, ['ACKNOWLEDGED', 'QUARANTINED']);
  assert.equal(batch.failed[0].transferId, hopC.id);
  assert.equal(batch.failed[0].errorCode, 'custody.receiver_mismatch');

  // A and B committed despite C failing; C is untouched.
  assert.equal(app.store.containers.get(a.container.id).custodyStatus, 'RECEIVED');
  assert.equal(app.store.containers.get(b.container.id).custodyStatus, 'ISOLATED');
  assert.equal(app.store.containers.get(c.container.id).custodyStatus, 'HANDED_OVER');
  assert.equal(app.store.transfers.get(hopC.id).status, 'PENDING_RECEIPT');

  // Replaying the batch retries A and B idempotently (duplicate=true) and C still fails.
  const replay = await app.custody.confirmReceipts({
    tenantId: TENANT, projectId: PROJECT,
    items: [
      { transferId: hopA.id, receipt: { receiverId: 'courier_01', receivedAt: '2026-10-07T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: 'rcpt-a' } },
      { transferId: hopB.id, receipt: { receiverId: 'courier_01', receivedAt: '2026-10-07T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'BROKEN', clientOperationId: 'rcpt-b' } },
      { transferId: hopC.id, receipt: { receiverId: 'someone_else', receivedAt: '2026-10-07T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: 'rcpt-c' } },
    ],
  });
  assert.equal(replay.confirmed.length, 2);
  assert.ok(replay.confirmed.every((o) => o.duplicate === true));
  assert.equal(replay.failed.length, 1);

  // Every rejection left a trace.
  assert.ok(app.store.audit.some((record) => record.action === 'custody.receipt_rejected' && record.entityId === hopC.id));
});

test('handover idempotency keys are tenant scoped and never leak another tenant record', async () => {
  const app = new SampleChainApplication();
  const sealed = sealContainer(app, 7);
  await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'shared-op-id',
  });
  // Same project name under a different tenant reusing the same id: must conflict,
  // never return the first tenant's transfer.
  await assert.rejects(
    app.custody.handOver({
      tenantId: 'tenant_other', projectId: PROJECT, containerId: sealed.container.id,
      fromHolderId: 'collector_01', toHolderId: 'courier_01',
      fromLocation: 'SITE-A', toLocation: 'LAB-A',
      handedOverAt: '2026-10-07T08:35:00.000Z', temperatureCelsius: 5,
      sealStatus: 'INTACT', clientOperationId: 'shared-op-id',
    }),
    (error) => error.code === 'scope.forbidden' || error.code === 'custody.operation_id_conflict',
  );
});

test('lab receiving cannot accept anomalous containers and requires a confirmed transport receipt', async () => {
  const app = new SampleChainApplication();
  const sealed = sealContainer(app, 8);
  // Still HANDED_OVER (no receipt confirmed): receiving decision is refused.
  await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'hop-8',
  });
  await assert.rejects(
    app.receiving.receive({
      tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
      receivedBy: 'lab_01', receivedAt: '2026-10-07T10:00:00.000Z',
      temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'recv-early',
    }),
    (error) => error.code === 'receiving.invalid_state',
  );

  const sealed2 = sealContainer(app, 9);
  const hop = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed2.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'hop-9',
  });
  await app.custody.confirmReceipt(hop.id, receiptInput({ sealStatus: 'BROKEN', clientOperationId: 'rcpt-broken-9' }));
  // Quarantined container cannot be mass-accepted as normal.
  await assert.rejects(
    app.receiving.receive({
      tenantId: TENANT, projectId: PROJECT, containerId: sealed2.container.id,
      receivedBy: 'lab_01', receivedAt: '2026-10-07T10:05:00.000Z',
      temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'recv-cover',
    }),
    (error) => error.code === 'receiving.seal_anomaly_conflict' || error.code === 'receiving.quarantined_cannot_accept',
  );
  assert.equal(app.store.containers.get(sealed2.container.id).custodyStatus, 'ISOLATED');

  // Retrying the same receiving operation id is idempotent.
  const sealed3 = sealContainer(app, 10);
  const hop3 = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed3.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'hop-10',
  });
  await app.custody.confirmReceipt(hop3.id, receiptInput({ clientOperationId: 'rcpt-10' }));
  const r1 = await app.receiving.receive({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed3.container.id,
    receivedBy: 'lab_01', receivedAt: '2026-10-07T10:10:00.000Z',
    temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'recv-10',
  });
  const r2 = await app.receiving.receive({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed3.container.id,
    receivedBy: 'lab_01', receivedAt: '2026-10-07T10:10:00.000Z',
    temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'recv-10',
  });
  assert.equal(r1.id, r2.id);
  assert.equal(app.store.receiving.size, 1);
});

test('offline CONFIRM_RECEIPT envelopes replay idempotently and stay traceable by sequence', async () => {
  const app = new SampleChainApplication();
  const sealed = sealContainer(app, 11);
  const hop = await app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE-A', toLocation: 'LAB-A',
    handedOverAt: '2026-10-07T08:30:00.000Z', temperatureCelsius: 5,
    sealStatus: 'INTACT', clientOperationId: 'handover-11',
  });
  const envelope = (operationId, sequence) => ({
    tenantId: TENANT, projectId: PROJECT, deviceId: 'device_11',
    clientSequence: sequence, operationId, entityId: hop.id, baseVersion: 1,
    type: 'CONFIRM_RECEIPT',
    payloadHash: 'hash-1',
    payload: {
      receiverId: 'courier_01', receivedAt: '2026-10-07T10:00:00.000Z',
      temperatureCelsius: 5, sealStatus: 'INTACT',
    },
    occurredAt: '2026-10-07T10:00:00.000Z',
  });

  assert.equal(await app.sync.apply(envelope('sync-receipt-1', 2)), 'APPLIED');
  // Duplicate delivery after network retry: deduped, not applied twice.
  assert.equal(await app.sync.apply(envelope('sync-receipt-1', 2)), 'APPLIED');
  const transfer = app.store.transfers.get(hop.id);
  assert.equal(transfer.status, 'CONFIRMED');
  assert.equal(transfer.receiptOperationId, 'sync-receipt-1');
  assert.equal(transfer.transferSequence, 1);
  // A competing receipt operation arriving later must not override the first one.
  await assert.rejects(app.sync.apply(envelope('sync-receipt-2', 3)), /already confirmed/);

  // Full chain trace: transfer, receipt audit and outbox all reference the sequence.
  assert.ok(app.store.audit.some((a) => a.action === 'custody.received' && a.entityId === hop.id && a.metadata.sequence === 1));
});

test('transfer sequences are gapless and monotonic per container across retries', async () => {
  const app = new SampleChainApplication();
  const sealed = sealContainer(app, 12);
  const makeHop = (opId, from, to, fromLoc, toLoc, at) => app.custody.handOver({
    tenantId: TENANT, projectId: PROJECT, containerId: sealed.container.id,
    fromHolderId: from, toHolderId: to, fromLocation: fromLoc, toLocation: toLoc,
    handedOverAt: at, temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: opId,
  });
  const h1 = await makeHop('h1', 'collector_01', 'courier_01', 'SITE-A', 'LAB-A', '2026-10-07T08:30:00.000Z');
  // Retry of the same handover operation returns the same transfer/sequence.
  const h1Retry = await makeHop('h1', 'collector_01', 'courier_01', 'SITE-A', 'LAB-A', '2026-10-07T08:30:00.000Z');
  assert.equal(h1Retry.id, h1.id);
  await app.custody.confirmReceipt(h1.id, receiptInput({ clientOperationId: 'r1' }));

  const h2 = await makeHop('h2', 'courier_01', 'lab_01', 'LAB-A', 'LAB-BENCH', '2026-10-07T09:30:00.000Z');
  assert.equal(h2.transferSequence, 2);
  const sequences = [...app.store.transfers.values()].filter((t) => t.containerId === sealed.container.id).map((t) => t.transferSequence);
  assert.deepEqual(sequences, [1, 2]);
});
