const { OrchestrationClient } = require('@sap-ai-sdk/orchestration');
const { fetchOpenPOs, fetchTrackedPOStatus } = require('./po-reader');
const { attachTrackingState, autoResolveTrackedItems, findCandidates, recordNotification } = require('./notification-tracking');
const { sendPONotification } = require('./notification-service');

const SYSTEM_PROMPT = `
You are an SAP Procurement Monitoring Agent summarizing overdue open purchase order items.
Return a concise plain-text business summary in this format:
Total PO Count: <unique purchase-order count> unique purchase orders.
Total Item Count: <item count> open PO items.
Highest Quantity PO: PO <purchase order> has the highest single-item open quantity with <quantity> <unit> open.
Business Summary: <one short sentence on the main material/service pattern>.
Notable Concentration: <one short sentence naming no more than three purchase orders or notable exceptions>.
Use openPurchaseOrderQuantity for the highest quantity, not orderQuantity or gapQuantity. Omit the highest-quantity line if no item has a numeric open quantity.
Keep the entire summary to at most five lines and 70 words. Do not list every purchase order or repeat the item data.
Do not include notification delivery, eligibility, suppression, or auto-resolution counts.
Do not return JSON or a highestGapQuantity field.
Only report facts supported by the tool results; do not invent values.
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
  logAgentEvent('open-po-agent-start');
  let autoResolved = 0;
  let trackingFailure = null;
  if (processNotifications) {
    try {
      autoResolved = await autoResolveTrackedItems(fetchTrackedPOStatus);
    } catch (error) {
      trackingFailure = error;
      logAgentEvent('hana-tracking-unavailable', { stage: 'auto-resolution', error: error.message });
    }
  }

  let pos = await fetchOpenPOs();
  if (!processNotifications) pos = await attachTrackingState(pos);
  logAgentEvent('open-po-fetch-complete', { count: pos.length });

  let tracking;
  if (processNotifications && !trackingFailure) {
    try {
      tracking = await findCandidates(pos);
    } catch (error) {
      trackingFailure = error;
      logAgentEvent('hana-tracking-unavailable', { stage: 'eligibility-check', error: error.message });
    }
  }

  if (!tracking) {
    tracking = !processNotifications
      ? {
      enabled: pos.every(po => po.notificationStatus !== 'tracking-unavailable'),
      eligible: pos.filter(po => po.notificationEligible === true),
      skipped: pos.filter(po => po.notificationEligible === false),
      reason: 'Read-only UI request; notification workflow not run.'
      }
      : {
        enabled: false,
        eligible: [],
        skipped: pos,
        reason: `HANA tracking unavailable; notifications withheld to avoid duplicate mail. ${trackingFailure?.message || ''}`.trim()
      };
  }
  logAgentEvent('po-notification-tracking-complete', {
    enabled: tracking.enabled,
    eligible: tracking.eligible.length,
    skipped: tracking.skipped.length
  });

  const sent = [];
  const failed = [];
  if (processNotifications) {
    for (const po of tracking.eligible) {
      try {
        const delivery = await sendPONotification(po);
        await recordNotification(po.purchaseOrder, po.item, delivery.recipient);
        sent.push({ purchaseOrder: po.purchaseOrder, item: po.item, recipient: delivery.recipient });
      } catch (error) {
        failed.push({
          purchaseOrder: po.purchaseOrder,
          item: po.item,
          recipient: po.projectManagerEmail || process.env.DEFAULT_OWNER_EMAIL || 'shipra.sharin@bearingpoint.com',
          error: error.message
        });
        logAgentEvent('po-notification-failed', {
          purchaseOrder: po.purchaseOrder,
          item: po.item,
          error: error.message
        });
      }
    }
  }

  const summary = await summarizePOs(pos, {
    overdueItemsScanned: pos.length,
    uniquePurchaseOrdersScanned: new Set(pos.map(po => po.purchaseOrder)).size,
    positiveGapItems: pos.filter(po => Number(po.gapQuantity) > 0).length,
    positiveGapPurchaseOrders: new Set(pos.filter(po => Number(po.gapQuantity) > 0).map(po => po.purchaseOrder)).size
  });
  logAgentEvent('open-po-summary-complete', { summaryLength: summary.length, count: pos.length });

  return {
    summary,
    count: pos.length,
    pos,
    tracking: {
      enabled: tracking.enabled,
      eligible: tracking.eligible.length,
      skipped: tracking.skipped.length,
      notified: sent.length,
      failed: failed.length,
      autoResolved,
      failures: failed,
      reason: tracking.reason || null,
      notificationSender: process.env.MAIL_FROM || 'cap-notifications@bearingpoint.com',
      trackingStore: tracking.enabled ? 'hana-cloud' : 'dry-run'
    }
  };
}

// Calls the GENERATIVE_AI_HUB destination (SAP AI Core Orchestration service, model gpt-5.4)
async function summarizePOs(pos, runContext = {}) {
  if (!Array.isArray(pos) || !pos.length) {
    return 'No open purchase orders were found in the connected S/4HANA Cloud system.';
  }

  try {
    const client = new OrchestrationClient(
      {
        promptTemplating: {
          model: { name: 'gpt-5.4', params: { max_tokens: 400, temperature: 0.2 } },
          prompt: {
            template: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: 'Tool results: {{?poData}}\nRun context: {{?runContext}}\nDraft the requested plain-text business summary.' }
            ]
          }
        }
      },
      undefined,
      { destinationName: 'GENERATIVE_AI_HUB' }
    );

    const reasoningResponse = await client.chatCompletion({
      placeholderValues: {
        poData: JSON.stringify(pos),
        runContext: JSON.stringify(runContext)
      }
    });

    const reasoning = reasoningResponse.getContent();
    const finalClient = new OrchestrationClient(
      {
        promptTemplating: {
          model: { name: 'gpt-5.4', params: { max_tokens: 400, temperature: 0.2 } },
          prompt: {
            template: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: 'Tool results: {{?poData}}\nRun context: {{?runContext}}\nPrior analysis: {{?reasoning}}\nReturn only the final plain-text business summary in the requested format.' }
            ]
          }
        }
      },
      undefined,
      { destinationName: 'GENERATIVE_AI_HUB' }
    );

    const finalResponse = await finalClient.chatCompletion({
      placeholderValues: {
        poData: JSON.stringify(pos),
        runContext: JSON.stringify(runContext),
        reasoning
      }
    });

    return finalResponse.getContent();
  } catch (err) {
    logAgentEvent('ai-summary-fallback', { error: err.message, count: pos.length });
    return buildFallbackSummary(pos);
  }
}

function buildFallbackSummary(pos) {
  const totalQty = pos.reduce((sum, p) => sum + (parseFloat(p.orderQuantity) || 0), 0);
  const uniquePos = new Set(pos.map(p => p.purchaseOrder)).size;
  const positiveGapItems = pos.filter(p => Number(p.gapQuantity) > 0).length;
  const highest = pos.reduce(
    (max, p) => ((parseFloat(p.orderQuantity) || 0) > (parseFloat(max.orderQuantity) || 0) ? p : max),
    pos[0]
  );

  return `Reviewed ${pos.length} overdue PO items across ${uniquePos} purchase orders; ${positiveGapItems} items have a positive gap. Total order quantity is ${totalQty}. Highest quantity is PO ${highest.purchaseOrder}/${highest.item} with ${highest.orderQuantity} ${highest.orderUnit}. This summary is generated from the fallback logic because the AI orchestration call was unavailable.`;
}

module.exports = { summarizePOs, fetchAndSummarizeOpenPOs };
