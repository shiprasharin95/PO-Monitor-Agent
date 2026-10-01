namespace po.monitor;

using { managed } from '@sap/cds/common';

entity PO_NOTIFICATION_LOG : managed {
  key purchaseOrder : String(20);
  key item          : String(10);

  recipientEmail : String(320);
  firstNotified : Timestamp;
  lastNotified  : Timestamp;
  resolved      : Boolean default false;
  resolvedDate  : Date;
}

entity PO_NOTIFICATION_CLAIM {
  key idempotencyKey : String(64);

  purchaseOrder : String(20);
  item          : String(10);
  status        : String(16);
  outcomeCode   : String(80);
  claimedAt     : Timestamp @cds.on.insert: $now;
  completedAt   : Timestamp;
}
