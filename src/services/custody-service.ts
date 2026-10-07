import type { CustodyTransfer, SealStatus } from '../domain/types.js';
import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { Store } from '../store/store.js';

export interface HandoverInput {
  tenantId: string;
  projectId: string;
  containerId: string;
  fromHolderId: string;
  toHolderId: string;
  fromLocation: string;
  toLocation: string;
  handedOverAt: string;
  temperatureCelsius: number;
  sealStatus: SealStatus;
  clientOperationId: string;
}

export interface ConfirmReceiptInput {
  tenantId: string;
  projectId: string;
  receiverId: string;
  receivedAt: string;
  temperatureCelsius: number;
  sealStatus: SealStatus;
  /** Idempotency key issued by the receiving terminal; retries must reuse it. */
  clientOperationId: string;
}

/**
 * Per-object outcome of a batch receipt confirmation.
 *
 * - ACKNOWLEDGED: transport receipt confirmed; `duplicate` marks an idempotent replay.
 * - QUARANTINED: seal anomaly recorded, container stays isolated; `duplicate` likewise.
 * - REJECTED: nothing changed; `errorCode`/`errorMessage` explain why (stale receipt,
 *   wrong receiver, anomalous seal covered by an INTACT claim, …).
 */
export type BatchReceiptOutcome =
  | { transferId: string; status: 'ACKNOWLEDGED'; duplicate: false; transfer: CustodyTransfer }
  | { transferId: string; status: 'ACKNOWLEDGED'; duplicate: true; transfer: CustodyTransfer }
  | { transferId: string; status: 'QUARANTINED'; duplicate: false; transfer: CustodyTransfer }
  | { transferId: string; status: 'QUARANTINED'; duplicate: true; transfer: CustodyTransfer }
  | { transferId?: string; status: 'REJECTED'; errorCode: string; errorMessage: string };

export interface BatchReceiptItem {
  transferId: string;
  receipt: Omit<ConfirmReceiptInput, 'tenantId' | 'projectId'>;
}

export interface BatchReceiptResult {
  confirmed: BatchReceiptOutcome[];
  failed: BatchReceiptOutcome[];
}

const VALID_SEAL: readonly SealStatus[] = ['INTACT', 'BROKEN', 'MISSING', 'RESEALED'];

/** Internal result of applying a receipt: the transfer plus whether this was a replay. */
interface ApplyReceiptResult {
  transfer: CustodyTransfer;
  /** True when nothing changed because the same receipt operation was already applied. */
  duplicate: boolean;
}

/** Worst-seal merge: an anomaly can never be downgraded back to INTACT. */
const SEAL_RANK: Record<SealStatus, number> = { INTACT: 0, RESEALED: 1, BROKEN: 2, MISSING: 3 };

function worseSeal(current: SealStatus | undefined, reported: SealStatus): SealStatus {
  if (current === undefined || SEAL_RANK[reported] >= SEAL_RANK[current]) return reported;
  return current;
}

export class CustodyService {
  constructor(private readonly store: Store) {}

  /**
   * Register a physical handover. Serialised through the store transaction so
   * concurrent handovers of the same container cannot both observe a free slot.
   */
  async handOver(input: HandoverInput): Promise<CustodyTransfer> {
    return this.store.transaction(() => this.handOverCore(input));
  }

  /** Must be invoked while already holding the store transaction (e.g. sync replay). */
  handOverCore(input: HandoverInput): CustodyTransfer {
    this.assertHandoverInput(input);
    const duplicate = this.findTransfer(input.clientOperationId, input.tenantId, input.projectId);
    if (duplicate) return duplicate;
    // Same idempotency key under the same project but a different tenant is a collision,
    // never a reusable receipt — returning it would leak another tenant's custody chain.
    const foreign = [...this.store.transfers.values()].find(
      (item) => item.clientOperationId === input.clientOperationId && item.projectId === input.projectId && item.tenantId !== input.tenantId,
    );
    if (foreign) throw new DomainError('custody.operation_id_conflict', 'operation id is already in use by another tenant');

    const container = assertFound(this.store.containers.get(input.containerId), 'custody.container_not_found', 'container not found');
    this.assertScope(container.tenantId, container.projectId, input.tenantId, input.projectId);
    assertCondition(container.currentHolderId === input.fromHolderId, 'custody.holder_mismatch', 'container is held by a different user');
    assertCondition(
      container.custodyStatus === 'SEALED' || container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'RELEASED_TO_LAB',
      'custody.invalid_state',
      'container cannot be handed over in its current state',
    );
    // A quarantine conclusion is sticky: isolated containers leave the chain only
    // through the receiving/isolation workflow, never through a new handover.
    assertCondition(container.sealStatus === 'INTACT' || container.sealStatus === 'RESEALED', 'custody.seal_quarantined', 'container seal is quarantined and cannot be handed over');
    const pending = this.openTransfer(container.id);
    assertCondition(pending === undefined, 'custody.pending_receipt', 'container already has a pending receipt');

    const sequence = this.nextSequence(container.id);
    const sealStatus = worseSeal(container.sealStatus, input.sealStatus);
    const transfer: CustodyTransfer = {
      id: this.store.nextId('transfer'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      containerId: input.containerId,
      transferSequence: sequence,
      fromHolderId: input.fromHolderId,
      toHolderId: input.toHolderId,
      fromLocation: input.fromLocation,
      toLocation: input.toLocation,
      handedOverAt: input.handedOverAt,
      temperatureCelsius: input.temperatureCelsius,
      sealStatus,
      status: sealStatus === 'INTACT' ? 'PENDING_RECEIPT' : 'ISOLATED',
      clientOperationId: input.clientOperationId,
      version: 1,
    };
    this.store.transfers.set(transfer.id, transfer);
    // Physical custody moves at handover; exactly one holder exists at all times.
    container.currentHolderId = input.toHolderId;
    container.currentLocation = input.toLocation;
    container.sealStatus = sealStatus;
    container.custodyStatus = transfer.status === 'ISOLATED' ? 'ISOLATED' : 'HANDED_OVER';
    container.temperatureLog.push({ recordedAt: input.handedOverAt, celsius: input.temperatureCelsius, source: 'HANDHELD' });
    container.version += 1;
    this.store.addAudit({
      tenantId: input.tenantId, projectId: input.projectId, action: 'custody.handed_over', entity: 'container', entityId: container.id,
      metadata: { transferId: transfer.id, sequence: transfer.transferSequence, sealStatus, operationId: input.clientOperationId },
    });
    this.store.addOutbox({
      tenantId: input.tenantId, projectId: input.projectId, topic: 'custody.handed-over', aggregateId: container.id,
      payload: JSON.stringify({ transferId: transfer.id, transferSequence: transfer.transferSequence, containerId: container.id }),
    });
    return transfer;
  }

  /**
   * Confirm receipt of one handover. Idempotent on (tenant, project, clientOperationId):
   * retries of the very same network request return the same terminal transfer.
   * An old receipt can never move the container backwards, and an anomalous seal can
   * never be cleared by an INTACT re-confirmation.
   */
  async confirmReceipt(transferId: string, input: ConfirmReceiptInput): Promise<CustodyTransfer> {
    return this.store.transaction(() => this.confirmReceiptCore(transferId, input)).then((result) => result.transfer);
  }

  /** Must be invoked while already holding the store transaction (e.g. sync replay). */
  confirmReceiptCore(transferId: string, input: ConfirmReceiptInput): ApplyReceiptResult {
    this.assertReceiptInput(input);
    const transfer = assertFound(this.store.transfers.get(transferId), 'custody.transfer_not_found', 'transfer not found');
    this.assertScope(transfer.tenantId, transfer.projectId, input.tenantId, input.projectId);

    const sameReceipt = [...this.store.transfers.values()].find(
      (item) => item.receiptOperationId === input.clientOperationId && item.tenantId === input.tenantId && item.projectId === input.projectId,
    );
    if (sameReceipt) {
      // Retried receipt for a different transfer is a payload conflict, not an idempotent hit.
      if (sameReceipt.id !== transfer.id) throw new DomainError('custody.operation_id_conflict', 'receipt operation id was already applied to another transfer');
      return { transfer: sameReceipt, duplicate: true };
    }

    const container = assertFound(this.store.containers.get(transfer.containerId), 'custody.container_not_found', 'container not found');

    // Only the currently open (latest, pending) transfer may be confirmed. Terminal
    // transfers are immutable, and a newer handover means this receipt is stale: it
    // must not move holder/location/seal backwards.
    const open = this.openTransfer(container.id);
    if (transfer.status !== 'PENDING_RECEIPT') {
      // A different operation id on an already-terminal transfer is a competing
      // confirmation that lost the race — reject rather than mint a second receipt.
      if (open !== undefined) throw new DomainError('custody.superseded_by_open_transfer', 'transfer is terminal while a newer handover is open');
      throw new DomainError('custody.already_confirmed', 'transfer was already confirmed by another operation');
    }
    assertCondition(open?.id === transfer.id, 'custody.stale_receipt', 'a newer handover exists; old receipt cannot apply');
    assertCondition(transfer.toHolderId === input.receiverId, 'custody.receiver_mismatch', 'receiver does not match the transfer');

    // Quarantine conclusion cannot be covered: if anything (handover observation,
    // container record) already shows an anomaly, an INTACT claim must not clear it.
    const observedAnomaly = transfer.sealStatus !== 'INTACT' || container.sealStatus !== 'INTACT';
    if (observedAnomaly && input.sealStatus === 'INTACT') {
      throw new DomainError('custody.seal_anomaly_conflict', 'seal was already reported anomalous; INTACT receipt cannot override it');
    }
    const sealStatus = worseSeal(container.sealStatus, input.sealStatus);

    transfer.receivedAt = input.receivedAt;
    transfer.receiptOperationId = input.clientOperationId;
    transfer.sealStatus = sealStatus;
    transfer.status = sealStatus === 'INTACT' ? 'CONFIRMED' : 'ISOLATED';
    transfer.version += 1;

    container.custodyStatus = transfer.status === 'CONFIRMED' ? 'RECEIVED' : 'ISOLATED';
    container.sealStatus = sealStatus;
    container.temperatureLog.push({ recordedAt: input.receivedAt, celsius: input.temperatureCelsius, source: 'LAB_RECEIPT' });
    container.version += 1;

    this.store.addAudit({
      tenantId: transfer.tenantId, projectId: transfer.projectId,
      action: transfer.status === 'CONFIRMED' ? 'custody.received' : 'custody.quarantined',
      entity: 'transfer', entityId: transfer.id,
      metadata: { sequence: transfer.transferSequence, sealStatus, operationId: input.clientOperationId },
    });
    this.store.addOutbox({
      tenantId: transfer.tenantId, projectId: transfer.projectId,
      topic: transfer.status === 'CONFIRMED' ? 'custody.received' : 'custody.quarantined',
      aggregateId: container.id,
      payload: JSON.stringify({ transferId, containerId: container.id, status: transfer.status }),
    });
    return { transfer, duplicate: false };
  }

  /**
   * Batch receipt confirmation. Each object is applied in its own transaction so one
   * failure never rolls the others back. The response partitions objects into those
   * that were confirmed/quarantined (including idempotent duplicates) and those that
   * were rejected, with a machine-readable reason per rejected object.
   */
  async confirmReceipts(input: { tenantId: string; projectId: string; items: BatchReceiptItem[] }): Promise<BatchReceiptResult> {
    const result: BatchReceiptResult = { confirmed: [], failed: [] };
    for (const item of input.items) {
      try {
        const receipt: ConfirmReceiptInput = {
          tenantId: input.tenantId,
          projectId: input.projectId,
          ...item.receipt,
        };
        // Each object commits independently: one rejected receipt must never roll
        // back the objects that were already confirmed earlier in the batch.
        const applied = await this.store.transaction(() => this.confirmReceiptCore(item.transferId, receipt));
        result.confirmed.push(this.toOutcome(applied));
      } catch (error) {
        const rejection = this.toRejection(item.transferId, error);
        result.failed.push(rejection);
        // Keep the rejection auditable in its own transaction (the failed one was rolled back).
        await this.store.transaction(() => {
          this.store.addAudit({
            tenantId: input.tenantId, projectId: input.projectId, action: 'custody.receipt_rejected',
            entity: 'transfer', entityId: item.transferId,
            metadata: { errorCode: rejection.status === 'REJECTED' ? rejection.errorCode : 'custody.confirmation_failed', operationId: item.receipt.clientOperationId },
          });
        });
      }
    }
    return result;
  }

  private toOutcome(applied: ApplyReceiptResult): BatchReceiptOutcome {
    const { transfer, duplicate } = applied;
    return transfer.status === 'ISOLATED'
      ? { transferId: transfer.id, status: 'QUARANTINED', duplicate, transfer }
      : { transferId: transfer.id, status: 'ACKNOWLEDGED', duplicate, transfer };
  }

  private toRejection(transferId: string, error: unknown): BatchReceiptOutcome {
    if (error instanceof DomainError) {
      return { transferId, status: 'REJECTED', errorCode: error.code, errorMessage: error.message };
    }
    return { transferId, status: 'REJECTED', errorCode: 'custody.confirmation_failed', errorMessage: error instanceof Error ? error.message : 'unknown error' };
  }

  private findTransfer(operationId: string, tenantId: string, projectId: string): CustodyTransfer | undefined {
    return [...this.store.transfers.values()].find(
      (item) => item.clientOperationId === operationId && item.tenantId === tenantId && item.projectId === projectId,
    );
  }

  private openTransfer(containerId: string): CustodyTransfer | undefined {
    return [...this.store.transfers.values()]
      .filter((item) => item.containerId === containerId && item.status === 'PENDING_RECEIPT')
      .sort((a, b) => b.transferSequence - a.transferSequence)[0];
  }

  private nextSequence(containerId: string): number {
    const latest = [...this.store.transfers.values()]
      .filter((item) => item.containerId === containerId)
      .sort((a, b) => b.transferSequence - a.transferSequence)[0];
    return (latest?.transferSequence ?? 0) + 1;
  }

  private assertScope(actualTenant: string, actualProject: string, tenantId: string, projectId: string): void {
    assertCondition(actualTenant === tenantId && actualProject === projectId, 'scope.forbidden', 'object does not belong to the requested project');
  }

  private assertHandoverInput(input: HandoverInput): void {
    assertCondition(input.fromHolderId !== input.toHolderId, 'custody.same_holder', 'handover must change holder');
    assertCondition(input.fromLocation !== input.toLocation, 'custody.same_location', 'handover must change location');
    assertCondition(Number.isFinite(input.temperatureCelsius), 'custody.invalid_temperature', 'temperature must be finite');
    assertCondition(input.handedOverAt.length > 0, 'custody.invalid_time', 'handover time is required');
    assertCondition(input.clientOperationId.length > 0, 'custody.invalid_operation', 'operation id is required');
    assertCondition(input.toHolderId.length > 0, 'custody.invalid_receiver', 'receiver is required');
    assertCondition(VALID_SEAL.includes(input.sealStatus), 'custody.invalid_seal', 'unknown seal status');
  }

  private assertReceiptInput(input: ConfirmReceiptInput): void {
    assertCondition(input.receiverId.length > 0, 'custody.invalid_receiver', 'receiver is required');
    assertCondition(input.receivedAt.length > 0, 'custody.invalid_time', 'receipt time is required');
    assertCondition(Number.isFinite(input.temperatureCelsius), 'custody.invalid_temperature', 'temperature must be finite');
    assertCondition(input.clientOperationId.length > 0, 'custody.invalid_operation', 'operation id is required');
    assertCondition(VALID_SEAL.includes(input.sealStatus), 'custody.invalid_seal', 'unknown seal status');
  }
}
