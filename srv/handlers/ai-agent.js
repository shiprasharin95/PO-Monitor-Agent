const { OrchestrationClient } = require('@sap-ai-sdk/orchestration');
const { fetchOpenPOs, fetchTrackedPOStatus } = require('./po-reader');
const { autoResolveTrackedItems, findCandidates, recordNotification } = require('./notification-tracking');
const { sendPONotification } = require('./notification-service');

const SYSTEM_PROMPT = `
You are an SAP Procurement Monitoring Agent using a bounded ReAct-style reasoning process.
Given tool results, reason about overdue service PO items, notification decisions, owner resolution,
and edge cases. Return a concise structured run summary with:
1. total qualifying PO items
2. total unique POs
3. notification counts (eligible, sent, failed, suppressed, auto-resolved)
4. highest gap quantity
5. required follow-up
Do not invent values not present in the tool results.
`.trim();

function logAgentEvent(event, details = {}) {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    ...details
  };
  console.log(JSON.stringify(payload));
}

async function fetchAndSummarizeOpenPOs() {
  logAgentEvent('open-po-agent-start');
  const autoResolved = await autoResolveTrackedItems(fetchTrackedPOStatus);
  const pos = await fetchOpenPOs();
  logAgentEvent('open-po-fetch-complete', { count: pos.length });

  const tracking = await findCandidates(pos);
  logAgentEvent('po-notification-tracking-complete', {
    enabled: tracking.enabled,
    eligible: tracking.eligible.length,
    skipped: tracking.skipped.length
  });

  const sent = [];
  const failed = [];
  for (const po of tracking.eligible) {
    try {
      const delivery = await sendPONotification(po);
      await recordNotification(po.purchaseOrder, po.item);
      sent.push({ purchaseOrder: po.purchaseOrder, item: po.item, recipient: delivery.recipient });
    } catch (error) {
      failed.push({
        purchaseOrder: po.purchaseOrder,
        item: po.item,
        recipient: po.ownerEmail || process.env.DEFAULT_OWNER_EMAIL || '',
        error: error.message
      });
      logAgentEvent('po-notification-failed', {
        purchaseOrder: po.purchaseOrder,
        item: po.item,
        error: error.message
      });
    }
  }

  const summary = await summarizePOs(pos, {
    eligible: tracking.eligible.length,
    suppressed: tracking.skipped.length,
    sent: sent.length,
    failed: failed.length,
    autoResolved
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
      notificationSender: process.env.MAIL_FROM || 'shipra.sharin@bearingpoint.com',
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
              { role: 'user', content: 'Tool results: {{?poData}}\nRun context: {{?runContext}}\nReturn your Thought, Action, Observation, and provisional Final.' }
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
              { role: 'user', content: 'Tool results: {{?poData}}\nRun context: {{?runContext}}\nPrior ReAct reasoning: {{?reasoning}}\nNow return only the final structured run summary.' }
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
  const highest = pos.reduce(
    (max, p) => ((parseFloat(p.orderQuantity) || 0) > (parseFloat(max.orderQuantity) || 0) ? p : max),
    pos[0]
  );

  return `Reviewed ${uniquePos} purchase orders across ${pos.length} open items. Total order quantity is ${totalQty}. Highest quantity is PO ${highest.purchaseOrder}/${highest.item} with ${highest.orderQuantity} ${highest.orderUnit}. This summary is generated from the fallback logic because the AI orchestration call was unavailable.`;
}

module.exports = { summarizePOs, fetchAndSummarizeOpenPOs };
