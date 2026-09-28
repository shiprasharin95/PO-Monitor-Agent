const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const SERVICE_PATH = '/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001';
const ENTERPRISE_PROJECT_PATH = process.env.ENTERPRISE_PROJECT_PATH || '/sap/opu/odata/sap/API_ENTERPRISE_PROJECT_SRV/A_EnterpriseProject';
const BUSINESS_PARTNER_PATH = '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner';
const PROJECT_SERVICE_PATH = '/sap/opu/odata/CPD/SC_EXTERNAL_SERVICES_SRV';
const PROJECT_CONTACT_PATH = '/sap/opu/odata/sap/YY1_PROJECTMANAGERCONTACT_CDS/YY1_ProjectManagerContact';
const SCHEDULE_LINE_FIELDS = [
  'PurchaseOrder',
  'PurchaseOrderItem',
  'ScheduleLineDeliveryDate',
  'PerformancePeriodEndDate',
  'OpenPurchaseOrderQuantity'
];
const ACCOUNT_ASSIGNMENT_FIELDS = [
  'PurchaseOrder',
  'PurchaseOrderItem',
  'WBSElementExternalID',
  'WBSElementInternalID'
];
const ownerCache = new Map();
const projectManagerCache = new Map();

function destinationRequest(basePath) {
  return url => executeHttpRequest(
    { destinationName: 'S4HC_JournalEntry' },
    { method: 'get', url: `${basePath}${url}`, headers: { Accept: 'application/json' } }
  );
}

function responseRows(response) {
  return response.data?.value || response.data?.d?.results || [];
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function escapeOData(value) {
  return String(value).replace(/'/g, "''");
}

async function resolveWbsOwner(wbsElement, wbsInternalId, request) {
  const wbs = wbsElement || wbsInternalId;
  if (!wbs) return { ownerEmail: process.env.DEFAULT_OWNER_EMAIL || '', ownerSource: 'default' };
  if (ownerCache.has(wbs)) return ownerCache.get(wbs);

  try {
    const filter = encodeURIComponent(`WBSElement eq '${escapeOData(wbs)}'`);
    const projectResponse = await request(
      `${ENTERPRISE_PROJECT_PATH}?$filter=${filter}&$select=WBSElement,PersonResponsibleUUID`
    );
    const project = responseRows(projectResponse)[0];
    const personId = project?.PersonResponsibleUUID;
    if (!personId) throw new Error('PersonResponsibleUUID not found');

    const partnerResponse = await request(
      `${BUSINESS_PARTNER_PATH}('${encodeURIComponent(personId)}')?$select=BusinessPartnerFullName,EmailAddress&$format=json`
    );
    const partner = partnerResponse.data?.d || partnerResponse.data || {};
    const result = {
      ownerEmail: partner.EmailAddress || process.env.DEFAULT_OWNER_EMAIL || '',
      ownerName: partner.BusinessPartnerFullName || '',
      ownerSource: partner.EmailAddress ? 'wbs-owner' : 'default'
    };
    ownerCache.set(wbs, result);
    return result;
  } catch (error) {
    console.warn('[PO] WBS owner resolution failed; using DEFAULT_OWNER_EMAIL.', {
      wbs,
      status: error.response?.status,
      message: error.message
    });
    const result = { ownerEmail: process.env.DEFAULT_OWNER_EMAIL || '', ownerSource: 'default' };
    ownerCache.set(wbs, result);
    return result;
  }
}

async function resolveProjectManagerEmail(wbsElements) {
  const projectNames = [...new Set(wbsElements.map(wbs => wbs.split('.')[0]).filter(Boolean))];
  const request = destinationRequest('');
  const managers = [];

  for (const projectName of projectNames) {
    if (projectManagerCache.has(projectName)) {
      managers.push(projectManagerCache.get(projectName));
      continue;
    }

    try {
      const projectUrl = `${PROJECT_SERVICE_PATH}/ProjectSet('${encodeURIComponent(projectName)}')?$select=ProjManagerId,ProjManagerName&$format=json`;
      const projectResponse = await request(projectUrl);
      const project = projectResponse.data?.d || projectResponse.data || {};
      if (!project.ProjManagerId) throw new Error('Project manager ID not returned');

      const filter = encodeURIComponent(`WorkAssignment eq '${escapeOData(project.ProjManagerId)}'`);
      const contactUrl = `${PROJECT_CONTACT_PATH}?$filter=${filter}&$select=WorkAssignment,PersonFullName,DefaultEmailAddress&$format=json`;
      const contactResponse = await request(contactUrl);
      const contacts = responseRows(contactResponse);
      const contact = contacts.find(entry => entry.DefaultEmailAddress) || contacts[0] || {};
      const manager = {
        projectName,
        projectManagerId: project.ProjManagerId,
        projectManagerName: project.ProjManagerName || contact.PersonFullName || '',
        projectManagerEmail: contact.DefaultEmailAddress || ''
      };
      projectManagerCache.set(projectName, manager);
      managers.push(manager);
    } catch (error) {
      console.warn('[PO] Project manager email lookup failed.', {
        projectName,
        status: error.response?.status,
        message: error.message
      });
    }
  }

  return managers;
}

async function fetchOpenPOs() {
  const baseRequest = destinationRequest(SERVICE_PATH);
  const itemFilter = encodeURIComponent(
    "ProductTypeCode eq '2' and IsCompletelyDelivered eq false and PurchasingDocumentDeletionCode eq ''"
  );
  const itemSelect = encodeURIComponent([
    'PurchaseOrder',
    'PurchaseOrderItem',
    'OrderQuantity',
    'PurchaseOrderQuantityUnit',
    'Material',
    'PurchaseOrderItemText',
    'ServicePerformer',
    'IsCompletelyDelivered',
    'PurchasingDocumentDeletionCode'
  ].join(','));
  const itemResponse = await baseRequest(
    `/PurchaseOrderItem?$filter=${itemFilter}&$select=${itemSelect}&$top=50`
  );
  const today = todayUtc();

  const items = responseRows(itemResponse);
  const results = [];

  for (const row of items) {
    const purchaseOrder = row.PurchaseOrder;
    const item = row.PurchaseOrderItem;
    const itemFilter = encodeURIComponent(
      `PurchaseOrder eq '${escapeOData(purchaseOrder)}' and PurchaseOrderItem eq '${String(item).padStart(5, '0')}'`
    );
    const related = fields => encodeURIComponent(fields.join(','));

    const [scheduleResponse, accountResponse] = await Promise.all([
      baseRequest(`/PurchaseOrderScheduleLine?$filter=${itemFilter}&$select=${related(SCHEDULE_LINE_FIELDS)}`),
      baseRequest(`/PurchaseOrderAccountAssignment?$filter=${itemFilter}&$select=${related(ACCOUNT_ASSIGNMENT_FIELDS)}`)
    ]);
    const schedules = responseRows(scheduleResponse);
    const assignments = responseRows(accountResponse);
    const overdueSchedules = schedules.filter(line =>
      line.ScheduleLineDeliveryDate && line.ScheduleLineDeliveryDate < today
    );

    if (!overdueSchedules.length) continue;

    const openQuantity = schedules.reduce(
      (sum, line) => sum + (Number(line.OpenPurchaseOrderQuantity) || 0),
      0
    );
    const orderQuantity = Number(row.OrderQuantity) || 0;
    const wbsElements = [...new Set(assignments.map(a => a.WBSElementExternalID).filter(Boolean))];
    const wbsInternalIds = [...new Set(assignments.map(a => a.WBSElementInternalID).filter(Boolean))];
    const owner = await resolveWbsOwner(wbsElements[0], wbsInternalIds[0], baseRequest);
    const projectManagers = await resolveProjectManagerEmail(wbsElements);
    const latestOverdue = overdueSchedules
      .map(line => line.ScheduleLineDeliveryDate)
      .sort()
      .at(-1);

    results.push({
      purchaseOrder,
      item,
      orderQuantity,
      gapQuantity: orderQuantity - openQuantity,
      openPurchaseOrderQuantity: openQuantity,
      orderUnit: row.PurchaseOrderQuantityUnit,
      material: row.Material,
      materialDescription: row.PurchaseOrderItemText,
      servicePerformer: row.ServicePerformer,
      scheduleLineDeliveryDate: latestOverdue,
      performancePeriodEndDate: overdueSchedules.map(line => line.PerformancePeriodEndDate).filter(Boolean).sort().at(-1) || null,
      wbsElement: wbsElements.join(', '),
      wbsElementInternalId: wbsInternalIds.join(', '),
      ownerEmail: owner.ownerEmail,
      ownerName: owner.ownerName || '',
      ownerSource: owner.ownerSource,
      projectManagerEmail: [...new Set(projectManagers.map(manager => manager.projectManagerEmail).filter(Boolean))].join(', '),
      projectManagerName: [...new Set(projectManagers.map(manager => manager.projectManagerName).filter(Boolean))].join(', '),
      isCompletelyDelivered: row.IsCompletelyDelivered,
      deletionCode: row.PurchasingDocumentDeletionCode
    });
  }

  return results;
}

async function fetchTrackedPOStatus(purchaseOrder, item) {
  const request = destinationRequest(SERVICE_PATH);
  const filter = encodeURIComponent(
    `PurchaseOrder eq '${escapeOData(purchaseOrder)}' and PurchaseOrderItem eq '${String(item).padStart(5, '0')}'`
  );
  const itemSelect = encodeURIComponent('PurchaseOrder,PurchaseOrderItem,IsCompletelyDelivered');
  const scheduleSelect = encodeURIComponent('OpenPurchaseOrderQuantity');
  const [itemResponse, scheduleResponse] = await Promise.all([
    request(`/PurchaseOrderItem?$filter=${filter}&$select=${itemSelect}`),
    request(`/PurchaseOrderScheduleLine?$filter=${filter}&$select=${scheduleSelect}`)
  ]);
  const itemRow = responseRows(itemResponse)[0] || {};
  const openPurchaseOrderQuantity = responseRows(scheduleResponse).reduce(
    (sum, line) => sum + (Number(line.OpenPurchaseOrderQuantity) || 0),
    0
  );

  return {
    isCompletelyDelivered: itemRow.IsCompletelyDelivered === true,
    openPurchaseOrderQuantity
  };
}

module.exports = { fetchOpenPOs, fetchTrackedPOStatus, resolveProjectManagerEmail, resolveWbsOwner };
