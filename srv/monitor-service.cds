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
  }

  action FetchOpenPOs() returns Result;

}