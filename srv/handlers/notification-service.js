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

function sanitizePOForAI(pos = []) {
  const grouped = new Map();
  const safeCode = value => {
    const code = String(value || '').trim();
    return /^[A-Za-z0-9._-]{1,64}$/.test(code) ? code : 'unknown';
  };
  const safeQuantity = value => {
    const quantity = Number(value);
    return Number.isFinite(quantity) && quantity >= 0 ? quantity : 0;
  };

  for (const po of pos) {
    const materialCode = safeCode(po?.material);
    const orderUnit = safeCode(po?.orderUnit);
    const key = JSON.stringify([materialCode, orderUnit]);
    const group = grouped.get(key) || {
      materialCode,
      orderUnit,
      itemCount: 0,
      totalOrderQuantity: 0,
      totalOpenQuantity: 0
    };
    group.itemCount += 1;
    group.totalOrderQuantity += safeQuantity(po?.orderQuantity);
    group.totalOpenQuantity += safeQuantity(po?.openPurchaseOrderQuantity);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .sort((left, right) => right.totalOpenQuantity - left.totalOpenQuantity)
    .slice(0, 50);
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
  const recipientEmail = normalizeEmail(po.projectManagerEmail);
  if (!recipientEmail) {
    throw new Error('No project-manager email is available for notification delivery.');
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
