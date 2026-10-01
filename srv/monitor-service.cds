@requires: 'POMonitorUser'
service MonitorService {

  type PO {
    purchaseOrder         : String;
    item                  : String;
    orderQuantity         : Decimal;
    gapQuantity           : Decimal;
    openPurchaseOrderQuantity : Decimal;
    orderUnit             : String;
    material              : String;
    materialDescription   : String;
    performancePeriodEndDate : Date;
    scheduleLineDeliveryDate : Date;
    servicePerformer      : String;
    servicePerformerName  : String;
    wbsElement            : String;
    workPackage           : String;
    projectId             : String;
    projectName           : String;
    workPackageId         : String;
    workPackageName       : String;
    costCenter            : String;
    costCenterResponsible : String;
    projectManagerId      : String;
    projectManagerName    : String;
    projectManagerEmail   : String;
    ownerEmail            : String;
    ownerName             : String;
    ownerSource           : String;
    lastNotified          : Timestamp;
    resolved              : Boolean;
    notificationEligible  : Boolean;
    notificationStatus    : String;
    isCompletelyDelivered : Boolean;
    deletionCode          : String;
  }

  type Result {
    summary : String;
    count   : Integer;
    pos     : array of PO;
    tracking : Tracking;
  }

  type NotificationFailure {
    purchaseOrder : String;
    item          : String;
    recipient     : String;
    error         : String;
  }

  type NotificationOutcome {
    purchaseOrder : String;
    item          : String;
    status        : String;
    recipient     : String;
    ownerSource   : String;
    isReminder    : Boolean;
    lastNotified  : Timestamp;
    error         : String;
  }

  type Tracking {
    enabled             : Boolean;
    eligible            : Integer;
    skipped             : Integer;
    notified            : Integer;
    failed              : Integer;
    autoResolved        : Integer;
    suppressed          : Integer;
    resolved            : Integer;
    items               : array of NotificationOutcome;
    failures            : array of NotificationFailure;
    reason              : String;
    notificationSender  : String;
    trackingStore       : String;
  }

  action FetchOpenPOs() returns Result;

}