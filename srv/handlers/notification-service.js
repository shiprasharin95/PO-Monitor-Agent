const cds = require('@sap/cds');

function getGraphMail() {
  return cds.connect.to('GraphMail');
}

function buildNotificationBody(po) {
  return [
    'Open purchase order follow-up required',
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

async function sendPONotification(po) {
  const recipient = po.projectManagerEmail
    || process.env.DEFAULT_OWNER_EMAIL
    || 'shipra.sharin@bearingpoint.com';

  const senderMailbox = cds.env.requires.GraphMail.senderMailbox || process.env.MAIL_FROM || 'cap-notifications@bearingpoint.com';
  if (!senderMailbox) {
    throw new Error('GraphMail sender mailbox is not configured.');
  }

  const graphMail = await getGraphMail();
  await graphMail.send({
    method: 'POST',
    path: `/users/${encodeURIComponent(senderMailbox)}/sendMail`,
    data: {
      message: {
        subject: `Overdue purchase order ${po.purchaseOrder}/${po.item} requires action`,
        body: { contentType: 'Text', content: buildNotificationBody(po) },
        toRecipients: [{ emailAddress: { address: recipient } }]
      },
      saveToSentItems: true
    }
  });

  return { recipient, senderMailbox };
}

module.exports = { sendPONotification, buildNotificationBody };
