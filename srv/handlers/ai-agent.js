const { OrchestrationClient } = require('@sap-ai-sdk/orchestration');
const { fetchOpenPOs, fetchTrackedPOStatus, resolveCommercialProject, resolveCostCenterResponsible, resolveWbsOwner } = require('./po-reader');
const { attachTrackingState, autoResolveTrackedItems, checkTrackingLog, isHanaTrackingAvailable, recordNotification } = require('./notification-tracking');
const { sendPONotification, sanitizePOForAI } = require('./notification-service');

const AI_MODEL = process.env.AI_AGENT_MODEL || 'gpt-4o-mini';
const MAX_REACT_STEPS = 8;
const AGENT_SYSTEM_PROMPT = `
You are an autonomous SAP procurement monitoring agent running on SAP BTP.
For each daily run, use the registered tools in this order: fetch overdue purchase order items, resolve each item's WBS owner (using DEFAULT_OWNER_EMAIL as fallback), check each item's tracking log, then send first notifications or reminders only for eligible unresolved items. HANA tracking suppresses reminders until five working days have elapsed. Summarize the number of purchase orders found, notifications sent, suppressed items, and resolved items.
Only select a tool that is explicitly allowed in the current context. The application executes tools and supplies their observations. Never claim a tool ran unless its result appears in observations. Do not invent data or expose private chain-of-thought. Return only one JSON object: {"tool":"<allowed tool name>","arguments":{}}.
`.trim();

const REACT_TOOLS = {
  fetch_overdue_pos: 'Fetch overdue service PO items that are not deleted or completely delivered from S/4HANA.',
  resolve_wbs_owner: 'Resolve the WBS owner for every fetched item; use the configured default owner when needed.',
  check_tracking_log: 'Check HANA notification history and apply resolved and five-working-day rules.',
  send_notification: 'Send notifications for all eligible items and record only successful deliveries.'
};

const SUMMARY_SYSTEM_PROMPT = `
Return only a JSON object with string fields businessSummary and notableConcentration. Use only supplied PO facts. businessSummary must be one short sentence about the main material/service pattern. notableConcentration must be one short sentence naming no more than three purchase orders or notable exceptions. Do not include counts, quantity totals, or extra fields.
`.trim();

function logAgentEvent(event, details = {}) {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    ...details
  };
  console.log(JSON.stringify(payload));
}

async function fetchAndSummarizeOpenPOs({ processNotifications = false } = {}) {
  if (processNotifications) return runReActAgent();

  logAgentEvent('open-po-agent-start');
  let pos = await fetchOpenPOs();
  pos = await attachTrackingState(pos);
  logAgentEvent('open-po-fetch-complete', { count: pos.length });

  const summary = await summarizePOs(pos, {
    notificationsSent: 0
  });
  const trackingAvailable = isHanaTrackingAvailable()
    && pos.every(po => po.notificationStatus !== 'tracking-unavailable');
  logAgentEvent('open-po-summary-complete', { summaryLength: summary.length, count: pos.length });

  return {
    summary,
    count: pos.length,
    pos,
    tracking: {
      enabled: trackingAvailable,
      eligible: pos.filter(po => po.notificationEligible === true).length,
      skipped: pos.filter(po => po.notificationEligible === false).length,
      notified: 0,
      failed: 0,
      autoResolved: 0,
      suppressed: pos.filter(po => po.notificationStatus === 'suppressed-under-5-working-days').length,
      resolved: pos.filter(po => po.notificationStatus === 'resolved').length,
      items: pos.map(po => ({
        purchaseOrder: po.purchaseOrder,
        item: po.item,
        status: po.notificationStatus || 'not-processed',
        recipient: po.ownerEmail || null,
        ownerSource: po.ownerSource || null,
        isReminder: false,
        lastNotified: po.lastNotified || null,
        error: null
      })),
      failures: [],
      reason: 'Read-only UI request; notification workflow not run.',
      notificationSender: process.env.MAIL_FROM || 'cap-notifications@bearingpoint.com',
      trackingStore: trackingAvailable ? 'hana-cloud' : 'dry-run'
    }
  };
}

function createAgentClient(maxTokens = 300) {
  return new OrchestrationClient(
    {
      promptTemplating: {
        model: { name: AI_MODEL, params: { max_tokens: maxTokens, temperature: 0 } },
        prompt: {
          template: [
            { role: 'system', content: AGENT_SYSTEM_PROMPT },
            { role: 'user', content: 'Current run context: {{?context}}\nReturn the next tool selection as the required JSON object.' }
          ]
        }
      }
    },
    undefined,
    { destinationName: 'GENERATIVE_AI_HUB' }
  );
}

function parseToolSelection(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI agent returned no valid tool-selection JSON.');

  const action = JSON.parse(text.slice(start, end + 1));
  if (!Object.hasOwn(REACT_TOOLS, action.tool) || !action.arguments || typeof action.arguments !== 'object') {
    throw new Error('AI agent selected an unknown tool or returned invalid arguments.');
  }
  return action;
}

async function runReActAgent() {
  logAgentEvent('open-po-agent-start', { architecture: 'react', model: AI_MODEL });
  let autoResolved = 0;
  let autoResolveFailure = null;
  try {
    autoResolved = await autoResolveTrackedItems(fetchTrackedPOStatus);
  } catch (error) {
    autoResolveFailure = error;
    logAgentEvent('hana-tracking-unavailable', { stage: 'auto-resolution', error: error.message });
  }

  const client = createAgentClient();
  const observations = [];
  const entries = new Map();
  let pos = [];
  let fetched = false;
  let step = 0;

  while (step < MAX_REACT_STEPS) {
    const rows = [...entries.values()];
    const pendingOwners = rows.filter(entry => !entry.ownerResolved);
    const pendingTracking = rows.filter(entry => !entry.tracking);
    const pendingDelivery = rows.filter(entry => entry.tracking?.eligible && !entry.deliveryAttempted);
    const nextTool = !fetched
      ? 'fetch_overdue_pos'
      : pendingOwners.length ? 'resolve_wbs_owner'
        : pendingTracking.length ? 'check_tracking_log'
          : pendingDelivery.length ? 'send_notification'
            : null;

    if (!nextTool) break;

    const context = {
      runDate: new Date().toISOString().slice(0, 10),
      allowedTools: [{ name: nextTool, description: REACT_TOOLS[nextTool] }],
      pendingItems: nextTool === 'resolve_wbs_owner'
        ? pendingOwners.map(({ po }) => ({ purchaseOrder: po.purchaseOrder, item: po.item, wbsElement: po.wbsElement }))
        : nextTool === 'check_tracking_log'
          ? pendingTracking.map(({ po }) => ({ purchaseOrder: po.purchaseOrder, item: po.item }))
          : nextTool === 'send_notification'
            ? pendingDelivery.map(({ po }) => ({ purchaseOrder: po.purchaseOrder, item: po.item }))
            : [],
      observations: observations.slice(-4)
    };
    const response = await client.chatCompletion({ placeholderValues: { context: JSON.stringify(context) } });
    const action = parseToolSelection(response.getContent());
    if (action.tool !== nextTool) {
      throw new Error(`AI agent selected ${action.tool}; the only permitted next tool is ${nextTool}.`);
    }

    let observation;
    if (action.tool === 'fetch_overdue_pos') {
      pos = await fetchOpenPOs({ resolveOwners: false });
      for (const po of pos) entries.set(`${po.purchaseOrder}:${po.item}`, {
        po,
        ownerResolved: false,
        tracking: null,
        deliveryAttempted: false,
        delivery: null
      });
      fetched = true;
      observation = { count: pos.length, items: pos.map(po => ({ purchaseOrder: po.purchaseOrder, item: po.item })) };
      logAgentEvent('open-po-fetch-complete', { count: pos.length });
    } else if (action.tool === 'resolve_wbs_owner') {
      observation = [];
      for (const entry of pendingOwners) {
        const wbsElements = [...new Set((entry.po.wbsElement || '').split(',').map(value => value.trim()).filter(Boolean))];
        const costCenters = [...new Set((entry.po.costCenter || '').split(',').map(value => value.trim()).filter(Boolean))];
        const wbsElement = wbsElements[0];
        const owner = await resolveWbsOwner(
          wbsElement,
          entry.po.wbsElementInternalId?.split(',')[0]?.trim()
        );
        Object.assign(entry.po, owner);
        if (wbsElements.length) {
          const projectDetails = await Promise.all(wbsElements.map(wbs => resolveCommercialProject(wbs, undefined, {
            purchaseOrder: entry.po.purchaseOrder,
            item: entry.po.item
          })));
          for (const field of ['projectId', 'projectName', 'workPackageId', 'workPackageName', 'projectManagerId', 'projectManagerName', 'projectManagerEmail']) {
            entry.po[field] = [...new Set(projectDetails.map(details => details[field]).filter(Boolean))].join(', ');
          }
        } else if (costCenters.length) {
          const responsibleNames = await Promise.all(costCenters.map(costCenter => resolveCostCenterResponsible(costCenter, undefined, {
            purchaseOrder: entry.po.purchaseOrder,
            item: entry.po.item
          })));
          entry.po.costCenterResponsible = [...new Set(responsibleNames.filter(Boolean))].join(', ');
        }
        entry.ownerResolved = true;
        observation.push({
          purchaseOrder: entry.po.purchaseOrder,
          item: entry.po.item,
          ownerSource: owner.ownerSource,
          projectId: entry.po.projectId || '',
          costCenterResponsible: entry.po.costCenterResponsible || ''
        });
      }
    } else if (action.tool === 'check_tracking_log') {
      observation = [];
      for (const entry of pendingTracking) {
        try {
          entry.tracking = await checkTrackingLog(entry.po.purchaseOrder, entry.po.item);
        } catch (error) {
          entry.tracking = { status: 'tracking-unavailable', eligible: false, resolved: false, lastNotified: null };
          logAgentEvent('hana-tracking-unavailable', { stage: 'item-check', purchaseOrder: entry.po.purchaseOrder, item: entry.po.item, error: error.message });
        }
        Object.assign(entry.po, {
          lastNotified: entry.tracking.lastNotified,
          resolved: entry.tracking.resolved,
          notificationEligible: entry.tracking.eligible,
          notificationStatus: entry.tracking.status
        });
        observation.push({ purchaseOrder: entry.po.purchaseOrder, item: entry.po.item, status: entry.tracking.status });
      }
    } else {
      observation = [];
      for (const entry of pendingDelivery) {
        entry.deliveryAttempted = true;
        try {
          if (autoResolveFailure) throw new Error('Auto-resolution failed; notifications withheld.');
          if (!entry.po.ownerEmail) throw new Error('No WBS owner or DEFAULT_OWNER_EMAIL is available.');
          const delivery = await sendPONotification(entry.po, {
            isReminder: Boolean(entry.tracking.lastNotified)
          });
          await recordNotification(entry.po.purchaseOrder, entry.po.item, delivery.recipient);
          entry.delivery = { status: 'sent', recipient: delivery.recipient };
        } catch (error) {
          entry.delivery = { status: 'failed', error: error.message };
          logAgentEvent('po-notification-failed', {
            purchaseOrder: entry.po.purchaseOrder,
            item: entry.po.item,
            error: error.message
          });
        }
        observation.push({ purchaseOrder: entry.po.purchaseOrder, item: entry.po.item, ...entry.delivery });
      }
    }

    observations.push({ tool: action.tool, result: observation });
    const auditResult = action.tool === 'resolve_wbs_owner'
      ? observation.map(({ purchaseOrder, item, ownerSource }) => ({ purchaseOrder, item, ownerSource }))
      : Array.isArray(observation) ? { itemCount: observation.length } : observation;
    logAgentEvent('react-tool-observed', { tool: action.tool, step: step + 1, result: auditResult });
    step += 1;
  }

  const remaining = [...entries.values()].some(entry =>
    !entry.ownerResolved || !entry.tracking || (entry.tracking.eligible && !entry.deliveryAttempted)
  );
  if (!fetched || remaining) {
    throw new Error('AI agent did not complete the required tool workflow within the step limit.');
  }

  const processed = [...entries.values()];
  const sent = processed.filter(entry => entry.delivery?.status === 'sent');
  const failed = processed.filter(entry => entry.delivery?.status === 'failed');
  const suppressed = processed.filter(entry => entry.tracking?.status === 'suppressed');
  const resolved = processed.filter(entry => entry.tracking?.status === 'resolved');
  const trackingEnabled = isHanaTrackingAvailable()
    && processed.every(entry => entry.tracking?.status !== 'tracking-unavailable');
  const tracking = {
    enabled: trackingEnabled,
    eligible: processed.filter(entry => entry.tracking?.eligible).length,
    skipped: processed.filter(entry => !entry.tracking?.eligible).length,
    notified: sent.length,
    failed: failed.length,
    autoResolved,
    suppressed: suppressed.length,
    resolved: resolved.length,
    items: processed.map(entry => ({
      purchaseOrder: entry.po.purchaseOrder,
      item: entry.po.item,
      status: entry.delivery?.status || entry.tracking?.status || 'not-processed',
      recipient: entry.delivery?.recipient || entry.po.ownerEmail || process.env.DEFAULT_OWNER_EMAIL || null,
      ownerSource: entry.po.ownerSource || null,
      isReminder: Boolean(entry.delivery?.status === 'sent' && entry.tracking?.lastNotified),
      lastNotified: entry.tracking?.lastNotified || null,
      error: entry.delivery?.error || null
    })),
    failures: failed.map(entry => ({
      purchaseOrder: entry.po.purchaseOrder,
      item: entry.po.item,
      recipient: entry.po.ownerEmail || process.env.DEFAULT_OWNER_EMAIL || '',
      error: entry.delivery.error
    })),
    reason: autoResolveFailure?.message || (!trackingEnabled ? 'HANA tracking unavailable; notifications withheld.' : null),
    notificationSender: process.env.MAIL_FROM || 'cap-notifications@bearingpoint.com',
    trackingStore: trackingEnabled ? 'hana-cloud' : 'dry-run'
  };
  const summary = await summarizePOs(pos, {
    uniquePurchaseOrdersFound: new Set(pos.map(po => po.purchaseOrder)).size,
    notificationsSent: sent.length,
    suppressedItems: suppressed.length,
    resolvedItems: resolved.length + autoResolved
  });
  logAgentEvent('open-po-agent-complete', { count: pos.length, ...tracking });

  return { summary, count: pos.length, pos, tracking };
}

// Calls the configured SAP AI Core Orchestration model for a grounded run summary.
async function summarizePOs(pos, runContext = {}) {
  const rows = Array.isArray(pos) ? pos : [];
  const lines = [
    `Total PO Count: ${new Set(rows.map(po => po.purchaseOrder)).size} unique purchase orders.`,
    `Total Item Count: ${rows.length} open PO items.`
  ];
  const highest = rows.reduce((currentHighest, po) => {
    const quantity = Number(po.openPurchaseOrderQuantity);
    return Number.isFinite(quantity)
      && (!currentHighest || quantity > Number(currentHighest.openPurchaseOrderQuantity))
      ? po
      : currentHighest;
  }, null);

  if (highest) {
    lines.push(`Highest Quantity PO: PO ${highest.purchaseOrder}/${highest.item} has the highest single-item open quantity with ${highest.openPurchaseOrderQuantity} ${highest.orderUnit || ''} open.`.replace(/\s+open\.$/, ' open.'));
  }

  if (!rows.length) {
    lines.push('Business Summary: No overdue open purchase order items were found.');
    return lines.join('\n');
  }

  try {
    const client = new OrchestrationClient(
      {
        promptTemplating: {
          model: { name: AI_MODEL, params: { max_tokens: 180, temperature: 0 } },
          prompt: {
            template: [
              { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
              { role: 'user', content: 'PO data: {{?poData}}\nRun metrics: {{?runContext}}\nReturn the requested summary.' }
            ]
          }
        }
      },
      undefined,
      { destinationName: 'GENERATIVE_AI_HUB' }
    );

    const safeRows = sanitizePOForAI(rows);
    const response = await client.chatCompletion({
      placeholderValues: {
        poData: JSON.stringify(safeRows),
        runContext: JSON.stringify(runContext)
      }
    });
    const content = response.getContent().trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const description = JSON.parse(content);
    const businessSummary = String(description.businessSummary || '').replace(/\s+/g, ' ').trim();
    const notableConcentration = String(description.notableConcentration || '').replace(/\s+/g, ' ').trim();
    if (!businessSummary || !notableConcentration) throw new Error('AI summary omitted a required description.');

    lines.push(`Business Summary: ${businessSummary}`);
    lines.push(`Notable Concentration: ${notableConcentration}`);
    return lines.join('\n');
  } catch (err) {
    logAgentEvent('ai-summary-fallback', { error: err.message, count: rows.length });
    const repeatedOrders = [...rows.reduce((counts, po) => counts.set(po.purchaseOrder, (counts.get(po.purchaseOrder) || 0) + 1), new Map())]
      .filter(([, count]) => count > 1)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([purchaseOrder]) => `PO ${purchaseOrder}`);
    lines.push('Business Summary: Open overdue items require procurement follow-up.');
    lines.push(`Notable Concentration: ${repeatedOrders.length ? repeatedOrders.join(', ') : 'No repeated purchase orders.'}`);
    return lines.join('\n');
  }
}

module.exports = { summarizePOs, fetchAndSummarizeOpenPOs };
