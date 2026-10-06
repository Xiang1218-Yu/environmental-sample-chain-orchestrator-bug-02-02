import { assertCondition, assertFound } from '../domain/errors.js';
export class AliquotService {
    store;
    constructor(store) {
        this.store = store;
    }
    createMany(input) {
        const prior = [...this.store.aliquots.values()].filter((item) => item.sourceOperationId === input.operationId && item.projectId === input.projectId);
        if (prior.length > 0)
            return prior;
        const container = assertFound(this.store.containers.get(input.parentContainerId), 'aliquot.container_not_found', 'parent container not found');
        assertCondition(container.tenantId === input.tenantId && container.projectId === input.projectId, 'scope.forbidden', 'container is outside the requested project');
        assertCondition(container.custodyStatus === 'RELEASED_TO_LAB', 'aliquot.container_not_released', 'container has not been released to the laboratory');
        assertCondition(container.sealStatus === 'INTACT' || container.sealStatus === 'RESEALED', 'aliquot.seal_invalid', 'container seal is not acceptable for aliquoting');
        assertCondition(input.items.length > 0, 'aliquot.empty_request', 'at least one aliquot is required');
        const normalized = input.items.map((item) => ({ ...item, volumeMl: this.toMilliliters(item.volumeMl, item.unit) }));
        const total = normalized.reduce((sum, item) => sum + item.volumeMl, 0);
        assertCondition(total > 0 && total <= container.availableVolumeMl, 'aliquot.insufficient_volume', 'requested aliquot volume exceeds available volume');
        const duplicateBarcode = normalized.find((item, index) => normalized.findIndex((candidate) => candidate.barcode === item.barcode) !== index);
        assertCondition(!duplicateBarcode, 'aliquot.duplicate_barcode', 'aliquot barcodes must be unique within an operation');
        for (const item of normalized) {
            const existing = [...this.store.aliquots.values()].find((aliquot) => aliquot.projectId === input.projectId && aliquot.barcode === item.barcode);
            if (existing)
                throw new Error(`aliquot barcode already exists: ${item.barcode}`);
        }
        const created = [];
        for (const item of normalized) {
            const aliquot = {
                id: this.store.nextId('aliquot'),
                tenantId: input.tenantId,
                projectId: input.projectId,
                parentContainerId: input.parentContainerId,
                barcode: item.barcode,
                volumeMl: item.volumeMl,
                unit: 'ML',
                protocolVersion: input.protocolVersion,
                createdBy: input.createdBy,
                createdAt: this.store.now(),
                status: 'AVAILABLE',
                sourceOperationId: input.operationId,
                version: 1,
            };
            this.store.aliquots.set(aliquot.id, aliquot);
            created.push(aliquot);
        }
        container.availableVolumeMl -= total;
        container.version += 1;
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'aliquot.created', entity: 'container', entityId: container.id, metadata: { operationId: input.operationId, count: created.length, volumeMl: total } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'aliquot.created', aggregateId: container.id, payload: JSON.stringify({ operationId: input.operationId, aliquotIds: created.map((item) => item.id), volumeMl: total }) });
        return created;
    }
    allocate(aliquotId, batchId) {
        const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'aliquot not found');
        assertCondition(aliquot.status === 'AVAILABLE', 'aliquot.not_available', 'aliquot is not available');
        aliquot.status = 'ALLOCATED';
        aliquot.version += 1;
        this.store.addAudit({ tenantId: aliquot.tenantId, projectId: aliquot.projectId, action: 'aliquot.allocated', entity: 'aliquot', entityId: aliquot.id, metadata: { batchId } });
        return aliquot;
    }
    toMilliliters(value, unit) {
        assertCondition(Number.isFinite(value) && value > 0, 'aliquot.invalid_volume', 'aliquot volume must be positive');
        if (unit === 'L')
            return value * 1000;
        if (unit === 'G')
            return value;
        return value;
    }
}
