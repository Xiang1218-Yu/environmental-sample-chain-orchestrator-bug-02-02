import type { CustodyStatus, CustodyTransfer, SampleContainer, SealStatus } from '../domain/types.js';
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

export interface ReceiptConfirmationInput {
  receiverId: string;
  receivedAt: string;
  temperatureCelsius: number;
  sealStatus: SealStatus;
}

export interface BatchReceiptItem extends ReceiptConfirmationInput {
  transferId: string;
}

export type BatchReceiptOutcome = 'CONFIRMED' | 'ISOLATED' | 'ALREADY_SETTLED' | 'REJECTED';

export interface BatchReceiptResult {
  transferId: string;
  containerId: string | null;
  outcome: BatchReceiptOutcome;
  status: CustodyTransfer['status'] | null;
  applied: boolean;
  errorCode?: string;
  errorMessage?: string;
}

// Normal custody progression. ISOLATED is a terminal sink handled separately,
// so an isolation verdict can never be advanced out of by a later receipt.
const CUSTODY_RANK: Record<Exclude<CustodyStatus, 'ISOLATED'>, number> = {
  SEALED: 0,
  HANDED_OVER: 1,
  RECEIVED: 2,
  RELEASED_TO_LAB: 3,
};

const SEAL_VALUES: readonly SealStatus[] = ['INTACT', 'BROKEN', 'MISSING', 'RESEALED'];

export class CustodyService {
  constructor(private readonly store: Store) {}

  handOver(input: HandoverInput): CustodyTransfer {
    this.assertHandoverInput(input);
    // Idempotent replay is scoped to the owning tenant and must carry the same
    // payload; a retried operation id never resolves to another tenant's record.
    const replay = [...this.store.transfers.values()].find((item) =>
      item.tenantId === input.tenantId && item.projectId === input.projectId && item.clientOperationId === input.clientOperationId);
    if (replay) {
      assertCondition(
        replay.containerId === input.containerId && replay.fromHolderId === input.fromHolderId && replay.toHolderId === input.toHolderId,
        'custody.operation_conflict',
        'client operation id was already used with a different handover payload');
      return replay;
    }
    const container = assertFound(this.store.containers.get(input.containerId), 'custody.container_not_found', 'container not found');
    this.assertScope(container.tenantId, container.projectId, input.tenantId, input.projectId);
    assertCondition(container.currentHolderId === input.fromHolderId, 'custody.holder_mismatch', 'container is held by a different user');
    assertCondition(container.custodyStatus === 'SEALED' || container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'RELEASED_TO_LAB', 'custody.invalid_state', 'container cannot be handed over in its current state');
    const pending = [...this.store.transfers.values()].filter((item) => item.containerId === input.containerId && item.status === 'PENDING_RECEIPT');
    assertCondition(pending.length === 0, 'custody.pending_receipt', 'container already has a pending receipt');
    const prior = this.latestTransfer(input.containerId);
    if (prior) {
      // A backdated handover must not rewrite a newer one to an old location.
      assertCondition(input.handedOverAt > prior.handedOverAt, 'custody.out_of_order', 'handover time must be later than the previous handover for this container');
    }
    const transfer: CustodyTransfer = {
      id: this.store.nextId('transfer'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      containerId: input.containerId,
      transferSequence: (prior?.transferSequence ?? 0) + 1,
      fromHolderId: input.fromHolderId,
      toHolderId: input.toHolderId,
      fromLocation: input.fromLocation,
      toLocation: input.toLocation,
      handedOverAt: input.handedOverAt,
      temperatureCelsius: input.temperatureCelsius,
      sealStatus: input.sealStatus,
      status: input.sealStatus === 'INTACT' ? 'PENDING_RECEIPT' : 'ISOLATED',
      clientOperationId: input.clientOperationId,
      version: 1,
    };
    this.store.transfers.set(transfer.id, transfer);
    container.currentHolderId = input.toHolderId;
    container.currentLocation = input.toLocation;
    container.custodyStatus = transfer.status === 'ISOLATED' ? 'ISOLATED' : 'HANDED_OVER';
    container.sealStatus = input.sealStatus;
    container.temperatureLog.push({ recordedAt: input.handedOverAt, celsius: input.temperatureCelsius, source: 'HANDHELD' });
    container.version += 1;
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'custody.handed_over', entity: 'container', entityId: container.id, metadata: { transferId: transfer.id, sequence: transfer.transferSequence, sealStatus: input.sealStatus } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'custody.handed-over', aggregateId: container.id, payload: JSON.stringify({ transferId: transfer.id, transferSequence: transfer.transferSequence, containerId: container.id }) });
    return transfer;
  }

  confirmReceipt(transferId: string, input: ReceiptConfirmationInput): CustodyTransfer {
    return this.settleReceipt(transferId, input).transfer;
  }

  // Each item settles independently: a partial failure never rolls back the
  // items that confirmed, and every object is reported as confirmed or not.
  confirmReceiptBatch(items: BatchReceiptItem[]): BatchReceiptResult[] {
    return items.map((item) => {
      const { transferId, ...receipt } = item;
      try {
        const { transfer, applied } = this.settleReceipt(transferId, receipt);
        return {
          transferId,
          containerId: transfer.containerId,
          outcome: applied ? (transfer.status === 'CONFIRMED' ? 'CONFIRMED' : 'ISOLATED') : 'ALREADY_SETTLED',
          status: transfer.status,
          applied,
        };
      } catch (error) {
        if (error instanceof DomainError) {
          const transfer = this.store.transfers.get(transferId);
          return {
            transferId,
            containerId: transfer?.containerId ?? null,
            outcome: 'REJECTED' as const,
            status: transfer?.status ?? null,
            applied: false,
            errorCode: error.code,
            errorMessage: error.message,
          };
        }
        throw error;
      }
    });
  }

  private settleReceipt(transferId: string, input: ReceiptConfirmationInput): { transfer: CustodyTransfer; applied: boolean } {
    this.assertReceiptInput(input);
    const transfer = assertFound(this.store.transfers.get(transferId), 'custody.transfer_not_found', 'transfer not found');
    if (transfer.status !== 'PENDING_RECEIPT') {
      // Terminal transfers are immutable: a duplicated or late receipt can
      // never flip an isolation back to normal or rewrite the first receipt.
      this.auditConflictingReplay(transfer, input);
      return { transfer, applied: false };
    }
    const container = assertFound(this.store.containers.get(transfer.containerId), 'custody.container_not_found', 'container not found');
    const latest = this.latestTransfer(transfer.containerId);
    assertCondition(latest !== undefined && latest.id === transfer.id, 'custody.stale_receipt', 'a newer handover exists for this container; the old receipt cannot move it');
    assertCondition(transfer.toHolderId === input.receiverId, 'custody.receiver_mismatch', 'receiver does not match the transfer');
    assertCondition(input.receivedAt >= transfer.handedOverAt, 'custody.receipt_before_handover', 'receipt time cannot be earlier than the handover time');
    transfer.receivedAt = input.receivedAt;
    transfer.receivedBy = input.receiverId;
    transfer.receiptSealStatus = input.sealStatus;
    transfer.status = input.sealStatus === 'INTACT' ? 'CONFIRMED' : 'ISOLATED';
    transfer.version += 1;
    if (transfer.status === 'ISOLATED') {
      container.custodyStatus = 'ISOLATED';
      container.sealStatus = input.sealStatus;
    } else {
      this.advanceCustodyStatus(container, 'RECEIVED');
      this.applySealStatus(container, input.sealStatus);
    }
    container.temperatureLog.push({ recordedAt: input.receivedAt, celsius: input.temperatureCelsius, source: 'LAB_RECEIPT' });
    container.version += 1;
    this.store.addAudit({ tenantId: transfer.tenantId, projectId: transfer.projectId, action: 'custody.received', entity: 'transfer', entityId: transfer.id, metadata: { sequence: transfer.transferSequence, sealStatus: input.sealStatus, receivedBy: input.receiverId } });
    this.store.addOutbox({ tenantId: transfer.tenantId, projectId: transfer.projectId, topic: 'custody.received', aggregateId: container.id, payload: JSON.stringify({ transferId, containerId: container.id, status: transfer.status }) });
    return { transfer, applied: true };
  }

  private latestTransfer(containerId: string): CustodyTransfer | undefined {
    return [...this.store.transfers.values()]
      .filter((item) => item.containerId === containerId)
      .sort((a, b) => b.transferSequence - a.transferSequence)[0];
  }

  private advanceCustodyStatus(container: SampleContainer, next: Exclude<CustodyStatus, 'ISOLATED'>): void {
    const current = container.custodyStatus;
    if (current === 'ISOLATED') return;
    if (CUSTODY_RANK[next] > CUSTODY_RANK[current]) container.custodyStatus = next;
  }

  private applySealStatus(container: SampleContainer, next: SealStatus): void {
    const abnormalFinding = container.sealStatus === 'BROKEN' || container.sealStatus === 'MISSING';
    const nextIsNormal = next === 'INTACT' || next === 'RESEALED';
    // An abnormal seal finding is sticky and cannot be confirmed back to normal.
    if (abnormalFinding && nextIsNormal) return;
    container.sealStatus = next;
  }

  private auditConflictingReplay(transfer: CustodyTransfer, input: ReceiptConfirmationInput): void {
    const conflicts = (transfer.receivedBy !== undefined && transfer.receivedBy !== input.receiverId)
      || (transfer.receiptSealStatus !== undefined && transfer.receiptSealStatus !== input.sealStatus);
    if (!conflicts) return;
    this.store.addAudit({ tenantId: transfer.tenantId, projectId: transfer.projectId, action: 'custody.receipt_conflict_ignored', entity: 'transfer', entityId: transfer.id, metadata: { sequence: transfer.transferSequence, status: transfer.status, attemptedReceiverId: input.receiverId, attemptedSealStatus: input.sealStatus } });
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
    assertCondition(SEAL_VALUES.includes(input.sealStatus), 'custody.invalid_seal', 'unknown seal status');
  }

  private assertReceiptInput(input: ReceiptConfirmationInput): void {
    assertCondition(input.receiverId.length > 0, 'custody.invalid_receiver', 'receiver is required');
    assertCondition(input.receivedAt.length > 0, 'custody.invalid_time', 'receipt time is required');
    assertCondition(Number.isFinite(input.temperatureCelsius), 'custody.invalid_temperature', 'temperature must be finite');
    assertCondition(SEAL_VALUES.includes(input.sealStatus), 'custody.invalid_seal', 'unknown seal status');
  }
}
