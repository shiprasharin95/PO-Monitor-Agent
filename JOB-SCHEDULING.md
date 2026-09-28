# PO Monitor Agent: Job Scheduling Setup

This document explains how the daily PO monitoring job was implemented, deployed, bound to SAP BTP Job Scheduling, tested, and configured.

## 1. What the scheduled job does

The scheduled process is:

```text
SAP BTP Job Scheduling Service
        |
        | HTTP POST /run
        v
Cloud Foundry application: po-monitor-demo-test
        |
        v
Fetch open PO items from S/4HANA Cloud
        |
        v
Generate an AI summary through SAP Generative AI Hub
        |
        v
Return summary, count, and PO items as JSON
```

The scheduler does not contain the PO business logic. It only calls the application's HTTP trigger endpoint.

## 2. Application and URLs

Cloud Foundry application:

```text
po-monitor-demo-test
```

Application route:

```text
https://po-monitor-demo-test.cfapps.eu20-001.hana.ondemand.com
```

UI5 application:

```text
https://po-monitor-demo-test.cfapps.eu20-001.hana.ondemand.com/po-monitor-ui/webapp/index.html
```

Health/root endpoint:

```text
GET /
```

Scheduler trigger endpoint:

```text
POST https://po-monitor-demo-test.cfapps.eu20-001.hana.ondemand.com/run
```

No request body is required for `POST /run`.

## 3. Code changes for the trigger

### `server.js`

The custom CAP bootstrap registers two routes:

- `GET /` returns a simple health message.
- `POST /run` calls `fetchAndSummarizeOpenPOs()` and returns the result.

The `POST /run` flow is:

1. Call `fetchAndSummarizeOpenPOs()`.
2. Read open purchase orders from S/4HANA.
3. Generate the AI summary.
4. Return `status`, `source`, `summary`, `count`, and `pos` as JSON.
5. Return HTTP 500 if the job fails.

The file also explicitly starts the CAP server with `cds.server()`. This was required because the first custom entrypoint only registered a bootstrap hook and exited immediately in Cloud Foundry.

### `package.json`

The production start command is:

```json
"start": "node server.js"
```

The local development command remains:

```json
"watch": "cds watch"
```

### `srv/handlers/ai-agent.js`

The scheduler uses the same agent orchestration as the CAP action:

- `fetchAndSummarizeOpenPOs()` fetches PO data and creates the summary.
- `summarizePOs()` calls SAP AI Core / Generative AI Hub through the `GENERATIVE_AI_HUB` destination.
- A fallback summary is returned if the AI call fails.
- Structured log events are written for start, fetch completion, summary completion, and fallback behavior.

## 4. Cron expression

The intended weekday schedule is expressed as:

```yaml
0 6 * * 1-5
```

This means:

```text
At minute 0 of hour 6, Monday through Friday
```

In plain language: **06:00 every weekday**.

Configure this cron expression on the SAP BTP Job Scheduling Service job that calls `POST /run`. The application does not read a cron environment variable or schedule itself.

Confirm the scheduler timezone. For example, `06:00` in `Asia/Kolkata` is different from `06:00` UTC.

## 5. Cloud Foundry deployment

The deployed app uses the direct Cloud Foundry manifest in `manifest.yml`:

```yaml
applications:
  - name: po-monitor-demo-test
    path: .
    buildpacks:
      - nodejs_buildpack
    memory: 512M
    disk_quota: 512M
    instances: 1
    command: npm start
    services:
      - cap-rest-destination
    env:
      NODE_ENV: production
```

Target the correct org and space:

```powershell
cf target -o BearingPointGmbH_sap-genai -s GenAI
```

Deploy or redeploy the application from the `agent_PO` folder:

```powershell
cf push po-monitor-demo-test
```

Check the application:

```powershell
cf app po-monitor-demo-test
```

The expected state is:

```text
instances: 1/1
state: running
```

## 6. Job Scheduling service setup

### 6.1 Check the current services

```powershell
cf services
```

The existing service instance used for this app is:

```text
Service instance: Job_Scheduling
Offering: jobscheduler
Plan: standard
Status: create succeeded
```

### 6.2 Create the service if it does not already exist

Only run this if an equivalent service instance does not exist:

```powershell
cf create-service jobscheduler standard Job_Scheduling
```

Check the operation:

```powershell
cf service Job_Scheduling
```

Wait for:

```text
status: create succeeded
```

### 6.3 Bind the service to the app

```powershell
cf bind-service po-monitor-demo-test Job_Scheduling
```

A successful command returns:

```text
OK
```

### 6.4 Restage the app

Restaging makes the new service binding available to the application:

```powershell
cf restage po-monitor-demo-test
```

Check the binding:

```powershell
cf service Job_Scheduling
```

The output should list:

```text
po-monitor-demo-test    create succeeded
```

The service was successfully bound and the app was verified at `1/1 running`.

## 7. Create the recurring job in the dashboard

The service binding alone does not create a scheduled job. Create the job in the SAP Job Scheduling dashboard.

Dashboard URL for the current service instance:

```text
https://jobscheduler-dashboard.cfapps.eu20.hana.ondemand.com/manageinstances/e4fb95e3-3c4e-44e1-9461-1bc869c433e4
```

Steps:

1. Open the dashboard URL.
2. Sign in with the SAP BTP account that has access to the service instance.
3. Open the `Job_Scheduling` instance.
4. Choose **Create Job**.
5. Use a name such as `daily-po-monitor`.
6. Configure the action URL:

   ```text
   https://po-monitor-demo-test.cfapps.eu20-001.hana.ondemand.com/run
   ```

7. Select HTTP method `POST`.
8. Configure the recurring schedule:

   ```text
   0 6 * * 1-5
   ```

9. Select the intended timezone, for example `Asia/Kolkata`.
10. Save and activate the job.

Depending on the dashboard version, the labels may be **Create Job**, **Actions**, **Run Now**, **Executions**, **History**, or **Logs**.

## 8. Run the job once manually

There are two different manual tests.

### Direct endpoint test

This tests the application, but it is not recorded as a Job Scheduler execution:

```powershell
curl.exe -X POST "https://po-monitor-demo-test.cfapps.eu20-001.hana.ondemand.com/run"
```

A successful response has HTTP status `200` and includes JSON similar to:

```json
{
  "status": "OK",
  "source": "job-scheduler",
  "summary": "...",
  "count": 24,
  "pos": []
}
```

### Dashboard test

To test the complete scheduler integration:

1. Open the configured `daily-po-monitor` job.
2. Select **Run Now** or **Trigger**.
3. Open **Executions**, **History**, or **Logs**.
4. Confirm the execution is successful and the HTTP response is `200`.

Only a run started by the Job Scheduling dashboard or its recurring schedule appears in scheduler execution history.

## 9. Where to see the result

### Scheduler dashboard

The dashboard normally shows execution metadata:

- Start time
- End time
- Execution status
- HTTP status
- Error details, if any

It may not display the full PO JSON response body.

### Cloud Foundry logs

View recent application logs:

```powershell
cf logs po-monitor-demo-test --recent
```

Useful structured events include:

```text
open-po-agent-start
open-po-fetch-complete
open-po-summary-complete
ai-summary-fallback
```

The application also logs the HTTP request, for example:

```text
POST /run 200
```

### Application response

The complete summary and PO data are returned directly by:

```text
POST /run
```

The UI displays the result through the CAP action endpoint:

```text
POST /odata/v4/monitor/FetchOpenPOs
```

## 10. S/4HANA and AI destinations

The application depends on destinations configured in BTP:

```text
S4HC_JournalEntry
GENERATIVE_AI_HUB
```

The PO reader uses the S/4HANA destination to call the Purchase Order Item OData v4 API. The AI handler uses the Generative AI Hub destination with `OrchestrationClient`.

The destination service instance bound to the app is:

```text
cap-rest-destination
```

The destinations themselves are configured separately in the BTP cockpit and are not stored as secrets in this repository.

## 11. Security status and production considerations

The current test app is publicly reachable. At the time of testing:

- `GET /` returned HTTP 200 without login.
- `POST /run` returned HTTP 200 without login.
- `package.json` still uses CAP mocked authentication.
- The direct `manifest.yml` deployment binds `cap-rest-destination`, not XSUAA.

This is acceptable only for controlled testing. A public unauthenticated `/run` endpoint allows anyone who knows the URL to trigger S/4HANA and AI calls.

Before production use:

1. Bind an XSUAA service to the app.
2. Change CAP authentication from mocked authentication to XSUAA authentication.
3. Protect the CAP service and `/run` endpoint.
4. Create a role collection containing the `POMonitorUser` role.
5. Assign the role collection only to approved users or groups.
6. Configure authenticated scheduler-to-application communication.
7. Test that anonymous requests receive `401` or `403`.

`xs-security.json` already contains the application scope and role template definitions, but defining them does not protect the app until the XSUAA service is provisioned, bound, and used by the runtime.

## 12. Troubleshooting

### App crashes immediately after deployment

Check:

```powershell
cf logs po-monitor-demo-test --recent
```

The custom `server.js` must call `cds.server()` and keep the HTTP listener alive. A script that only registers `cds.on('bootstrap', ...)` and exports the server function will exit in Cloud Foundry.

### Scheduler receives an error

Check:

```powershell
cf logs po-monitor-demo-test --recent
```

Then verify:

- The app is `1/1 running`.
- The scheduler URL is exactly the HTTPS `/run` URL.
- The method is `POST`.
- The scheduler job is active.
- The `S4HC_JournalEntry` destination works.
- The `GENERATIVE_AI_HUB` destination works.

### UI URL appears blank or shows only the root text

The root URL `/` is only a health endpoint. Use the UI URL:

```text
https://po-monitor-demo-test.cfapps.eu20-001.hana.ondemand.com/po-monitor-ui/webapp/index.html
```

### Scheduler dashboard shows no execution

A direct `curl` request does not create dashboard history. Use the dashboard's **Run Now** action or wait for the configured schedule.

## 13. Current implementation status

Completed:

- Custom `POST /run` trigger implemented.
- CAP server startup fixed for Cloud Foundry.
- App deployed as `po-monitor-demo-test`.
- Existing `Job_Scheduling` service identified.
- `Job_Scheduling` bound to `po-monitor-demo-test`.
- App restaged successfully.
- Direct `/run` execution tested successfully with HTTP 200.
- PO fetch and AI summary verified.

Still required in the dashboard:

- Create the `daily-po-monitor` recurring job.
- Activate it.
- Use **Run Now** to produce a scheduler-native execution record.

The Job Scheduling service binding and the scheduler job are separate steps: binding connects the service to the app; creating the dashboard job defines when the service calls `/run`.
