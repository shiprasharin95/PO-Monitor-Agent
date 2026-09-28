const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE } = cds.ql;

function getLogEntity() {
  return cds.entities('po.monitor').PO_NOTIFICATION_LOG;
}

function hasHanaBinding() {
  if (!process.env.VCAP_SERVICES) return false;

  try {
    const services = JSON.parse(process.env.VCAP_SERVICES);
    return Object.values(services).some(instances =>
      instances.some(instance =>
        instance.label === 'hana' ||
        instance.label === 'hana-cloud' ||
        instance.name === 'po-monitor-hana'
      )
    );
  } catch (err) {
    return false;
  }
}

function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function addWorkingDays(date, numberOfDays) {
  const result = new Date(date);
  let remaining = numberOfDays;

  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (!isWeekend(result)) remaining -= 1;
  }

  return result;
}

function isEligibleForNotification(log, now = new Date()) {
  if (!log) return true;
  if (log.resolved) return false;
  if (!log.lastNotified) return true;

  return now >= addWorkingDays(new Date(log.lastNotified), 5);
}

async function getLog(tx, purchaseOrder, item) {
  return tx.run(
    SELECT.one.from(getLogEntity()).where({ purchaseOrder, item })
  );
}

async function attachTrackingState(pos, now = new Date()) {
  if (!cds.db || !hasHanaBinding()) {
    return pos.map(po => ({
      ...po,
      lastNotified: null,
      resolved: null,
      notificationEligible: null,
      notificationStatus: 'tracking-unavailable'
    }));
  }

  try {
    const logs = await cds.db.run(SELECT.from(getLogEntity()));
    const logByKey = new Map(logs.map(log => [`${log.purchaseOrder}:${log.item}`, log]));

    return pos.map(po => {
      const log = logByKey.get(`${po.purchaseOrder}:${po.item}`);
      const eligible = isEligibleForNotification(log, now);
      return {
        ...po,
        lastNotified: log?.lastNotified || null,
        resolved: log ? Boolean(log.resolved) : false,
        notificationEligible: eligible,
        notificationStatus: log?.resolved
          ? 'resolved'
          : eligible ? 'eligible' : 'suppressed-under-5-working-days'
      };
    });
  } catch (error) {
    console.error('[PO] Could not load notification tracking state for UI.', error);
    return pos.map(po => ({
      ...po,
      lastNotified: null,
      resolved: null,
      notificationEligible: null,
      notificationStatus: 'tracking-unavailable'
    }));
  }
}

async function findCandidates(pos, now = new Date()) {
  if (!cds.db || !hasHanaBinding()) {
    return {
      enabled: false,
      reason: 'HANA Cloud service is not bound; tracking is running in dry-run mode.',
      eligible: [],
      skipped: pos
    };
  }

  const tx = cds.db;
  const eligible = [];
  const skipped = [];

  for (const po of pos) {
    const log = await getLog(tx, po.purchaseOrder, po.item);

    if (isEligibleForNotification(log, now)) {
      eligible.push(po);
    } else {
      skipped.push(po);
    }
  }

  return { enabled: true, eligible, skipped };
}

async function getUnresolvedLogs() {
  if (!cds.db || !hasHanaBinding()) return [];
  return cds.db.run(SELECT.from(getLogEntity()).where({ resolved: false }));
}

async function autoResolveTrackedItems(fetchStatus, resolvedDate = new Date()) {
  const logs = await getUnresolvedLogs();
  let resolvedCount = 0;

  for (const log of logs) {
    const status = await fetchStatus(log.purchaseOrder, log.item);
    if (status?.isCompletelyDelivered === true || Number(status?.openPurchaseOrderQuantity) === 0) {
      await markResolved(log.purchaseOrder, log.item, resolvedDate);
      resolvedCount += 1;
    }
  }

  return resolvedCount;
}

async function recordNotification(purchaseOrder, item, recipientEmail, notifiedAt = new Date()) {
  if (!cds.db || !hasHanaBinding()) {
    throw new Error('Cannot record notification: HANA Cloud service is not bound.');
  }

  const tx = cds.db;
  const existing = await getLog(tx, purchaseOrder, item);

  if (!existing) {
    await tx.run(INSERT.into(getLogEntity()).entries({
      purchaseOrder,
      item,
      recipientEmail,
      firstNotified: notifiedAt,
      lastNotified: notifiedAt,
      resolved: false,
      resolvedDate: null
    }));
    return;
  }

  await tx.run(
    UPDATE(getLogEntity())
      .set({ recipientEmail, lastNotified: notifiedAt, resolved: false, resolvedDate: null })
      .where({ purchaseOrder, item })
  );
}

async function markResolved(purchaseOrder, item, resolvedDate = new Date()) {
  if (!cds.db || !hasHanaBinding()) {
    throw new Error('Cannot mark notification resolved: HANA Cloud service is not bound.');
  }

  await cds.db.run(
    UPDATE(getLogEntity())
      .set({ resolved: true, resolvedDate })
      .where({ purchaseOrder, item })
  );
}

module.exports = {
  addWorkingDays,
  attachTrackingState,
  autoResolveTrackedItems,
  findCandidates,
  isEligibleForNotification,
  markResolved,
  recordNotification
};
