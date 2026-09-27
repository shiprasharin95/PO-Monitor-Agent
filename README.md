# PO-Monitor-Agent

PO UnBooked Quantity Monitor Agent

## Overview

A minimal CAP application: user presses **GO**, the backend calls S/4HANA Cloud
(via the `S4HC_JournalEntry` BTP destination) to retrieve **open Purchase Order
items**, then sends that data to **SAP AI Core Orchestration (GENERATIVE_AI_HUB
destination, model `gpt-5.4`)** to produce a short business summary. Both the
PO table and the AI summary are displayed in the UI5 app.

## PO fields displayed

The PO line-item query and UI table include these fields in order:

| UI label | S/4HANA OData field |
|---|---|
| Purchase Order | `PurchaseOrder` |
| Item | `PurchaseOrderItem` |
| Product Type | `ProductTypeCode` |
| Order Qty | `OrderQuantity` |
| Open QTY | `OpenPurchaseOrderQuantity` |
| Unit | `PurchaseOrderQuantityUnit` |
| Material Number | `Material` |
| Material Description | `PurchaseOrderItemText` |
| End of Performance Period | `PerformancePeriodEndDate` |
| Service Performer | `ServicePerformer` |
| WBS Element | `WBSElementExternalID` |
| Completely Delivered | `IsCompletelyDelivered` |

The performance-period end date comes from schedule-line data exposed by the
Purchase Order Item API, and the WBS element comes from account-assignment data
exposed by the API.

The reader first tries the enriched field projection. If the connected S/4HANA
API rejects one of those fields with HTTP 400, it retries the previously verified
base projection so the application remains available. In that fallback case the
new columns are present in the UI but have no values until the correct
schedule-line/account-assignment navigation is configured.

The deployed reader reads `Material`, `PurchaseOrderItemText`, and
`ServicePerformer` directly from `PurchaseOrderItem`. It reads the remaining
fields from the related endpoints:

- `PurchaseOrderScheduleLine`: sums `OpenPurchaseOrderQuantity` and uses the
   latest non-empty `PerformancePeriodEndDate`.
- `PurchaseOrderAccountAssignment`: combines distinct
   `WBSElementExternalID` values.

Only data retrieval + summarization is implemented. No email sending, no job
scheduling.

## ⚠️ Security note

Real credentials (S4HC user/password, AI Core client secret) were shared in
plain text in this conversation. Treat them as compromised:
- **Rotate the AI Core client secret** and the S4HC technical user password.
- Never commit `default-env.json` (it's git-ignored) or paste secrets into
  chat/tickets again.

This project does **not** hardcode any secret in source code. Destination
credentials are resolved at runtime:
- On Cloud Foundry: via the bound `destination` service instance (destinations
  `S4HC_JournalEntry` and `GENERATIVE_AI_HUB` must already exist in the
  subaccount's Destination service, as you described).
- Locally: via a `destinations` env var, provided through a local
  `default-env.json` file (see `default-env.json.example`).

## Project structure

```
srv/monitor-service.cds        - MonitorService with FetchOpenPOs action
srv/monitor-service.js         - wires po-reader + ai-agent
srv/handlers/po-reader.js      - calls S4HC_JournalEntry -> API_PURCHASEORDER_PROCESS_SRV
srv/handlers/ai-agent.js       - calls GENERATIVE_AI_HUB (Orchestration, gpt-5.4)
app/po-monitor-ui/webapp/...   - freestyle UI5 app (GO button + table + summary)
xs-security.json, mta.yaml     - deployment scaffolding (destinations are NOT created here,
                                  they must already exist as you set them up in cockpit)
```

## Run locally

1. Copy `default-env.json.example` to `default-env.json` and fill in **your own**
   S4HC URL/user/password and AI Core Orchestration URL/client id/secret
   (rotated values, not the ones pasted earlier).
2. Install dependencies (already done if you ran this before):
   ```
   npm install
   ```
3. Start the server:
   ```
   npm run watch
   ```
4. Open the app, e.g. `http://localhost:4004/po-monitor-ui/webapp/index.html`.
5. Click **GO**. The table fills with open PO items and the AI summary appears
   above it.

## Notes on the "open PO" filter

`po-reader.js` defines an open PO item as: not deleted
(`DeletionIndicator eq ''`) and not yet finally invoiced
(`FinalInvoiceIndicator eq ''`). Adjust the `$filter` in
`srv/handlers/po-reader.js` if your definition of "open" differs.

## Deploying

`for deployment you don't need to use deployments explicitly` referred to the
AI model (no AI Core deployment ID needed — Orchestration resolves `gpt-5.4`
at request time). For deploying the CAP app itself to Cloud Foundry, build and
deploy via MTA as usual:
```
mbt build
cf deploy mta_archives/po-monitor-demo_1.0.0.mtar
```
Make sure the `S4HC_JournalEntry` and `GENERATIVE_AI_HUB` destinations exist in
the target subaccount before deploying.
