namespace po.monitor;

using { managed } from '@sap/cds/common';

@cds.persistence.name: 'PO_NOTIFICATION_LOG'
entity PO_NOTIFICATION_LOG : managed {
  key purchaseOrder : String(20);
  key item          : String(10);

  firstNotified : Timestamp;
  lastNotified  : Timestamp;
  resolved      : Boolean default false;
  resolvedDate  : Date;
}
