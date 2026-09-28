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
