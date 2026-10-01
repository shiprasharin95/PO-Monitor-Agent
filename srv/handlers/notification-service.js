const cds = require('@sap/cds');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateRecipientEmail(email, { allowExternal = false } = {}) {
  const recipient = normalizeEmail(email);
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error('Invalid recipient email address.');
  }

  const configuredDomains = (process.env.ALLOWED_NOTIFICATION_DOMAINS || 'bearingpoint.com,sap.com')
    .split(',')
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean);

  const configuredAllowList = (process.env.ALLOWED_NOTIFICATION_RECIPIENTS || '')
    .split(',')
    .map(value => normalizeEmail(value))
    .filter(Boolean);

  const isAllowedDomain = configuredDomains.some(domain => recipient.endsWith(`@${domain}`));
  const isConfiguredRecipient = configuredAllowList.includes(recipient);

  if (!allowExternal && !isAllowedDomain && !isConfiguredRecipient) {
    throw new Error(`Recipient email is not allowed: ${recipient}`);
  }

  return recipient;
}

function sanitizeText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizePOForAI(pos = []) {
  const allowedFields = new Set([
    'purchaseOrder', 'item', 'orderQuantity', 'gapQuantity', 'openPurchaseOrderQuantity',
    'orderUnit', 'material', 'materialDescription', 'performancePeriodEndDate',
    'scheduleLineDeliveryDate', 'servicePerformer', 'servicePerformerName', 'wbsElement',
    'workPackage', 'projectId', 'projectName', 'workPackageId', 'workPackageName',
    'costCenter', 'costCenterResponsible', 'projectManagerId', 'projectManagerName',
    'projectManagerEmail', 'ownerEmail', 'ownerName', 'ownerSource', 'lastNotified',
    'resolved', 'notificationEligible', 'notificationStatus', 'isCompletelyDelivered',
    'deletionCode'
  ]);

  return pos.map(po => {
    const sanitized = {};
    for (const [key, value] of Object.entries(po || {})) {
      if (!allowedFields.has(key)) continue;
      if (typeof value === 'string') {
        sanitized[key] = sanitizeText(value);
      } else if (value !== undefined && value !== null) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  });
}

function getGraphMail() {
  return cds.connect.to('GraphMail');
}

function buildNotificationBody(po, { isReminder = false } = {}) {
  return [
    isReminder ? 'Reminder: open purchase order follow-up required' : 'Open purchase order follow-up required',
    '',
    `Purchase Order: ${po.purchaseOrder}`,
    `Item: ${po.item}`,
    `WBS Element: ${po.wbsElement || 'Not available'}`,
    `Gap Quantity: ${po.gapQuantity ?? 'Not available'} ${po.orderUnit || ''}`.trim(),
    `Schedule Line Delivery Date: ${po.scheduleLineDeliveryDate || 'Not available'}`,
    '',
    'Required action: Please review the overdue open purchase order item and arrange delivery or update the order status.'
  ].join('\n');
}

async function sendPONotification(po, { isReminder = false } = {}) {
  const recipientEmail = po.projectManagerEmail || po.ownerEmail;
  if (!recipientEmail) {
    throw new Error('No project-manager or owner email is available for notification delivery.');
  }

  const recipient = validateRecipientEmail(recipientEmail);

  const senderMailbox = validateRecipientEmail(
    cds.env.requires.GraphMail.senderMailbox || process.env.MAIL_FROM || 'cap-notifications@bearingpoint.com',
    { allowExternal: true }
  );

  const graphMail = await getGraphMail();
  await graphMail.send({
    method: 'POST',
    path: `/users/${encodeURIComponent(senderMailbox)}/sendMail`,
    data: {
      message: {
        subject: `${isReminder ? 'Reminder: ' : ''}Overdue purchase order ${po.purchaseOrder}/${po.item} requires action`,
        body: { contentType: 'Text', content: buildNotificationBody(po, { isReminder }) },
        toRecipients: [{ emailAddress: { address: recipient } }]
      },
      saveToSentItems: true
    }
  });

  return { recipient, senderMailbox };
}

module.exports = { sendPONotification, buildNotificationBody, validateRecipientEmail, sanitizePOForAI };
