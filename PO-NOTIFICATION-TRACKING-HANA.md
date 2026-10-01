# PO Notification Tracking with SAP HANA Cloud

The tracking model is database-agnostic CAP CDS and is now configured for SAP HANA Cloud.

## Implemented

The repository now contains a HANA Cloud-ready tracking model and eligibility logic for PO notifications.

### Files

- `db/schema.cds`: defines the `PO_NOTIFICATION_LOG` entity.
- `srv/handlers/notification-tracking.js`: implements five-working-day eligibility, persistence helpers, and dry-run behavior.
- `srv/handlers/ai-agent.js`: evaluates every fetched PO item against the tracking log and returns tracking metrics.
- `package.json`: includes `@cap-js/hana@1.9.2`, compatible with the current CAP 8 runtime.
- `manifest.yml`: contains `MAIL_FROM=shipra.sharin@bearingpoint.com` as the future sender identity.

## Table model

`db/schema.cds` creates the logical entity `PO_NOTIFICATION_LOG` with:

- Composite key: `purchaseOrder` + `item`
- `firstNotified`
- `lastNotified`
- `resolved`, default `false`
- `resolvedDate`
- CAP-managed creation/update fields

The model uses `@cds.persistence.name: 'PO_NOTIFICATION_LOG'`. Verify the generated HANA DDL before production deployment.

## Processing rules

For each fetched PO item:

| State | Action |
|---|---|
| No tracking row | Eligible for first notification |
| `resolved = true` | Skip |
| `resolved = false`, less than 5 working days since `lastNotified` | Skip |
| `resolved = false`, at least 5 working days since `lastNotified` | Eligible for re-notification |

Working days currently exclude Saturday and Sunday. Public holidays are not yet applied and require an approved holiday calendar.

`recordNotification()` is intentionally called only after a real notification provider confirms successful delivery. This prevents a failed email from incorrectly starting the five-day waiting period.

## Current runtime behavior

Every `POST /run` execution now:

1. Fetches open POs from S/4HANA.
2. Reads `PO_NOTIFICATION_LOG` when HANA Cloud is available.
3. Calculates eligible and skipped items.
4. Generates the existing AI summary.
5. Returns tracking metrics in the JSON response.

Example response section:

```json
{
  "tracking": {
    "enabled": true,
    "eligible": 4,
    "skipped": 20,
    "notificationSender": "shipra.sharin@bearingpoint.com"
  }
}
```

When HANA Cloud is not bound, tracking runs in dry-run mode and does not persist rows.

## HANA Cloud setup

The project uses CAP 8 and now uses:

```powershell
npm install @cap-js/hana@1.9.2
```

The application uses CAP's standard `cds.db` API, so no SQL-specific tracking code changes are required.

Check available BTP offerings and plans:

```powershell
cf target -o BearingPointGmbH_sap-genai -s GenAI
cf marketplace
```

Create or reuse an HANA Cloud service instance using an entitled plan:

```powershell
cf create-service hana-cloud hana-free po-monitor-hana
cf service po-monitor-hana
```

The offering and plan may differ in your subaccount. Check first with:

```powershell
cf marketplace -e hana-cloud
```

After the service reports `create succeeded`, bind and restage:

```powershell
cf bind-service po-monitor-demo-test po-monitor-hana
cf restage po-monitor-demo-test
```

Verify the binding:

```powershell
cf service po-monitor-hana
```

The bound apps must include `po-monitor-demo-test`.

### Current provisioning result

The `hana-cloud / hana-free` plan is visible and available in the space. A
provisioning attempt with:

```powershell
cf create-service hana-cloud hana-free po-monitor-hana
```

was rejected by the service broker with:

```text
Failed to unmarshal parameters: unexpected end of JSON input
```

The failed instance was deleted. An existing HANA Cloud instance named
`GenAIHanaDB_accassist` belongs to `accassist-backend` and must not be reused
without explicit database-owner approval. The next manual action is to create
`po-monitor-hana` through HANA Cloud Central or ask the BTP administrator to
provision it with the broker's required parameters.

## Deploy the CDS schema to HANA Cloud

After the HANA service binding exists, deploy the CDS model:

```powershell
cds build --production
cds deploy
```

Confirm that the HANA table `PO_NOTIFICATION_LOG` exists. Do not put HANA credentials into source files, `manifest.yml`, or `mta.yaml`.

## Notification/email work still requiring manual setup

The notification flow is now implemented with the Microsoft Graph pattern from
the reference POC. It uses CAP `cds.connect.to('GraphMail')` and the BTP
Destination service; credentials are not stored in this repository.

Manual tasks still required:

1. Register an Azure AD application with Microsoft Graph `Mail.Send` application permission and admin consent.
2. Create an Exchange shared/dedicated sender mailbox and confirm `cap-notifications@bearingpoint.com` is allowed to send from it.
3. Create an Exchange Application Access Policy restricting the app to that mailbox.
4. The app uses the existing BTP destination named `AzureMailService`:

  ```text
  URL: https://graph.microsoft.com/v1.0
  Authentication: OAuth2ClientCredentials
  Token Service URL: https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token
  Scope: https://graph.microsoft.com/.default
  Proxy Type: Internet
  ```

5. Ensure the existing `cap-rest-destination` service binding can resolve this destination.
6. Recipients are only the resolved project manager (`projectManagerEmail`). If that address is missing, the item is skipped and no email is sent; there is no owner or default-mailbox fallback.
7. Verify the enterprise-project entity path in `ENTERPRISE_PROJECT_PATH`; the current default is `A_EnterpriseProject`.
8. Never put Graph client secrets or OAuth credentials in this repository.

The sender identity is configured as:

```text
MAIL_FROM=cap-notifications@bearingpoint.com
```

This identifies the sender but does not provide mail delivery by itself. The
Graph destination must be configured and authorized to send from this mailbox.

## Daily notification run implemented

`POST /run` now performs the following sequence:

1. Auto-resolve tracked items whose current S/4HANA status is delivered or has zero open quantity.
2. Use the ReAct loop with SAP AI Core Orchestration (`gpt-4o-mini` by default; override with `AI_AGENT_MODEL`) to select the next permitted tool.
3. Fetch service PO items that are not deleted or completely delivered and have an overdue schedule line; retain the earlier behavior without filtering on open quantity versus order quantity, including items where both quantities are equal. Follow OData continuation links.
4. Resolve WBS ownership and project-manager details through Enterprise Project and related OData APIs. A missing project-manager email means the notification is skipped; no default recipient is substituted.
5. Check HANA tracking for each item; skip resolved items, suppress reminders before five weekdays have elapsed, and permit a first notification or reminder when eligible.
6. Send GraphMail only to the project manager; skip items with no project-manager email. Reminder emails are labeled as reminders.
7. Record `LAST_NOTIFIED` only after a successful Graph response.
8. Return counts for found items, eligible, sent, failed, skipped, suppressed, resolved, and automatically resolved items. Tool actions are logged without model chain-of-thought.

Failed email delivery is reported per PO item and does not create a tracking record. HANA tracking and GraphMail are retained as the existing BTP integrations; PostgreSQL and SMTP/Nodemailer from the reference architecture are not used by this project.

### Historical live verification

The following results are from a previous deployment, before the current ReAct workflow changes. They are not verification of the current source revision.

The deployed test run verified:

- 21 overdue service PO items were selected using `ScheduleLineDeliveryDate < today`.
- HANA tracking was enabled.
- 21 items were eligible and none were suppressed.
- No tracking rows were created because email delivery was not successful.
- Notifications are sent only when a project-manager email is resolved; missing addresses are skipped without a fallback recipient.

The next live run should show `notified > 0` only after the project-manager API path and
`AzureMailService` are configured and visible to the app's bound Destination service.

## Auto-resolution

The scheduled run checks unresolved HANA records against S/4HANA before fetching candidates. It marks a record resolved when the item is completely delivered or its summed schedule-line open quantity is zero. An item absent from the open-only candidate query is not by itself treated as resolved.

The normal PO read and the status re-query both select `OpenPurchaseOrderQuantity`; verify that the field remains available in the target S/4HANA API metadata.

## Testing

Validate the model and code locally:

```powershell
npx cds compile db/schema.cds --to json
npm ls @cap-js/hana --depth=0
```

Required business-rule tests:

- New item is eligible.
- Unresolved item before five working days is skipped.
- Unresolved item at five working days is eligible.
- Weekend days are excluded.
- Resolved item is skipped.
- Failed delivery does not update `lastNotified`.

After HANA deployment, test the endpoint:

```powershell
curl.exe -X POST "https://po-monitor-demo-test.cfapps.eu20-001.hana.ondemand.com/run"
```

Check logs:

```powershell
cf logs po-monitor-demo-test --recent
```

## Production checklist

- [x] Add CAP HANA adapter compatible with CAP 8.
- [x] Add `PO_NOTIFICATION_LOG` CDS model.
- [x] Add five-working-day eligibility logic.
- [x] Add tracking metrics to `/run`.
- [x] Configure sender identity.
- [ ] Create or obtain HANA Cloud BTP service.
- [ ] Bind HANA Cloud to the application.
- [ ] Deploy and verify the CDS schema.
- [ ] Configure an approved mail provider and recipients.
- [ ] Implement the mail adapter.
- [ ] Implement and test auto-resolution.
- [ ] Protect `/run` with XSUAA or authenticated scheduler communication.
