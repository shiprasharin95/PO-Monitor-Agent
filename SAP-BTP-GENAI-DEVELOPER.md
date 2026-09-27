# SAP BTP & GenAI Developer Notes

## PO Monitor field mapping

The PO Monitor app reads these fields from the S/4HANA Purchase Order Item API and exposes them through `MonitorService.FetchOpenPOs()`.

| Sequence | UI label | OData field | Runtime property |
|---:|---|---|---|
| 1 | Purchase Order | `PurchaseOrder` | `purchaseOrder` |
| 2 | Item | `PurchaseOrderItem` | `item` |
| 3 | Product Type | `ProductTypeCode` | `productTypeCode` |
| 4 | Order Qty | `OrderQuantity` | `orderQuantity` |
| 5 | Open QTY | `OpenPurchaseOrderQuantity` | `openPurchaseOrderQuantity` |
| 6 | Unit | `PurchaseOrderQuantityUnit` | `orderUnit` |
| 7 | Material Number | `Material` | `material` |
| 8 | Material Description / Short Text | `PurchaseOrderItemText` | `materialDescription` |
| 9 | End of Performance Period | `PerformancePeriodEndDate` | `performancePeriodEndDate` |
| 10 | Service Performer | `ServicePerformer` | `servicePerformer` |
| 11 | WBS Element | `WBSElementExternalID` | `wbsElement` |
| 12 | Completely Delivered | `IsCompletelyDelivered` | `isCompletelyDelivered` |

`Open QTY` is intentionally placed immediately after `Order Qty` in the UI.

The performance-period end date is supplied by schedule-line data exposed by the
Purchase Order Item API. The WBS element is supplied by account-assignment data
exposed by the API.

## Implementation locations

- `srv/handlers/po-reader.js`: OData `$select` list and response mapping.
- `srv/monitor-service.cds`: CAP result type fields.
- `app/po-monitor-ui/webapp/view/Main.view.xml`: table columns and bindings.
- `README.md`: user-facing field mapping.

## Existing open-item filter

The PO reader continues to apply the verified filter:

```text
ProductTypeCode eq '2'
and IsCompletelyDelivered eq false
and PurchasingDocumentDeletionCode eq ''
```

The destination remains `S4HC_JournalEntry`.

## Runtime compatibility note

The enriched `$select` containing all requested fields was deployed and tested
against the current destination. The S/4HANA API returned HTTP 400 for that
projection. The PO reader now retries the previously verified base projection so
the application remains available with HTTP 200 while the exact schedule-line
and account-assignment navigation is confirmed.

The deployed adaptive query was verified against the current destination. It
accepts these optional fields directly on `PurchaseOrderItem`:

- `Material`
- `PurchaseOrderItemText`
- `ServicePerformer`

It rejects these fields with HTTP 400 when requested directly on
`PurchaseOrderItem`:

- `OpenPurchaseOrderQuantity`
- `PerformancePeriodEndDate`
- `WBSElementExternalID`

The latter fields are now obtained through the related endpoints confirmed in
Postman:

```text
PurchaseOrderScheduleLine
PurchaseOrderAccountAssignment
```

For each PO item, the reader sums `OpenPurchaseOrderQuantity` across schedule
lines, uses the latest non-empty `PerformancePeriodEndDate`, and combines
distinct `WBSElementExternalID` values from account assignments. The UI now
receives these values from the deployed app.

## Validation requirement

Before production deployment, verify that the connected S/4HANA API metadata exposes
all selected fields, especially `OpenPurchaseOrderQuantity`,
`PerformancePeriodEndDate`, and `WBSElementExternalID`. If the service metadata uses
a different property name, update the `$select` list and mapping together.

## Project manager email for future notifications

The PO reader now resolves the future mail recipient using this sequence:

1. Read `WBSElementExternalID` from `PurchaseOrderAccountAssignment`.
2. Split the WBS value at the first period. For example:

	```text
	CNGLX2411.1.2 -> CNGLX2411
	```

3. Query `ProjectSet('<projectName>')` from `CPD/SC_EXTERNAL_SERVICES_SRV` and read `ProjManagerId` and `ProjManagerName`.
4. Query `YY1_ProjectManagerContact` with `WorkAssignment eq '<ProjManagerId>'`.
5. Read `DefaultEmailAddress` as the project manager recipient email.

The result is returned on each PO item as `projectName`, `projectManagerId`,
`projectManagerName`, and `projectManagerEmail`.

Service performer enrichment now calls `API_BUSINESS_PARTNER/A_BusinessPartner`
with the performer ID and reads `BusinessPartnerFullName` into
`servicePerformerName`. The UI also includes a blank `workPackage` field for
future logic.

The email is resolved and carried in the PO result for later notification use. No
email is sent yet, and `LAST_NOTIFIED` is not updated by this lookup. The future
mail adapter must use `projectManagerEmail` as the recipient and update the
tracking record only after successful delivery.
