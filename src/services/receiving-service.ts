import type { ReceivingDecision } from '../domain/types.js';
import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { Store } from '../store/store.js';

export interface ReceiveInput {
  tenantId: string;
  projectId: string;
  containerId: string;
  receivedBy: string;
  receivedAt: string;
  temperatureCelsius: number;
  sealStatus: 'INTACT' | 'BROKEN' | 'MISSING' | 'RESEALED';
  decision: ReceivingDecision;
  reason?: string;
  clientOperationId: string;
}

const SEAL_RANK = { INTACT: 0, RESEALED: 1, BROKEN: 2, MISSING: 3 } as const;

export class ReceivingService {
  constructor(private readonly store: Store) {}

  async receive(input: ReceiveInput) {
    return this.store.transaction(() => this.receiveCore(input));
  }

  /** Must be invoked while already holding the store transaction (e.g. sync replay). */
  receiveCore(input: ReceiveInput) {
    const duplicate = [...this.store.receiving.values()].find(
      (item) => item.clientOperationId === input.clientOperationId && item.tenantId === input.tenantId && item.projectId === input.projectId,
    );
    if (duplicate) return duplicate;
    const foreign = [...this.store.receiving.values()].find(
      (item) => item.clientOperationId === input.clientOperationId && item.projectId === input.projectId && item.tenantId !== input.tenantId,
    );
    if (foreign) throw new DomainError('receiving.operation_id_conflict', 'operation id is already in use by another tenant');

    const container = assertFound(this.store.containers.get(input.containerId), 'receiving.container_not_found', 'container not found');
    assertCondition(container.tenantId === input.tenantId && container.projectId === input.projectId, 'scope.forbidden', 'container is outside the requested project');
    // Formal lab decision is only possible after the transport receipt is confirmed
    // (RECEIVED), or for a container already held in quarantine (ISOLATED).
    assertCondition(
      container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'ISOLATED',
      'receiving.invalid_state',
      'container custody must be confirmed before a receiving decision',
    );
    // Same worst-seal rule as custody: an INTACT lab claim cannot wipe an anomaly
    // recorded during transport, and an anomaly stays visible on the container.
    if (input.sealStatus === 'INTACT' && container.sealStatus !== 'INTACT' && container.sealStatus !== 'RESEALED') {
      throw new DomainError('receiving.seal_anomaly_conflict', 'container seal was reported anomalous; INTACT receipt cannot override it');
    }
    const quarantined = SEAL_RANK[input.sealStatus] >= SEAL_RANK.BROKEN || container.sealStatus !== 'INTACT' && container.sealStatus !== 'RESEALED';
    if (input.decision === 'ACCEPTED' && (container.custodyStatus === 'ISOLATED' || quarantined)) {
      throw new DomainError('receiving.quarantined_cannot_accept', 'anomalous or isolated container cannot be accepted as normal');
    }
    const id = this.store.nextId('receiving');
    const record = {
      id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      containerId: input.containerId,
      decision: input.decision,
      receivedBy: input.receivedBy,
      receivedAt: input.receivedAt,
      temperatureCelsius: input.temperatureCelsius,
      sealStatus: input.sealStatus,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      clientOperationId: input.clientOperationId,
      version: 1,
    };
    this.store.receiving.set(id, record);
    // Isolation conclusion is sticky: only ACCEPTED on a clean chain releases to lab;
    // ISOLATED/REJECTED both leave the container in quarantine, never back to clean.
    container.custodyStatus = input.decision === 'ACCEPTED' ? 'RELEASED_TO_LAB' : 'ISOLATED';
    if (SEAL_RANK[input.sealStatus] > SEAL_RANK[container.sealStatus]) container.sealStatus = input.sealStatus;
    container.version += 1;
    const sample = assertFound(this.store.samples.get(container.sampleId), 'receiving.sample_not_found', 'sample not found');
    sample.status = input.decision === 'ACCEPTED' ? 'RECEIVED' : 'ISOLATED';
    sample.receivedAt = input.receivedAt;
    sample.version += 1;
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.received', entity: 'container', entityId: container.id, metadata: { decision: input.decision, sealStatus: input.sealStatus, receivingId: id, operationId: input.clientOperationId } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.received', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId: container.id, decision: input.decision }) });
    return record;
  }
}
