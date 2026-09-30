const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const SERVICE_PATH = '/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001';
const ENTERPRISE_PROJECT_PATH = process.env.ENTERPRISE_PROJECT_PATH || '/sap/opu/odata/sap/API_ENTERPRISE_PROJECT_SRV/A_EnterpriseProject';
const BUSINESS_PARTNER_PATH = '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner';
const PROJECT_SERVICE_PATH = '/sap/opu/odata/CPD/SC_EXTERNAL_SERVICES_SRV';
const PROJECT_CONTACT_PATH = '/sap/opu/odata/sap/YY1_PROJECTMANAGERCONTACT_CDS/YY1_ProjectManagerContact';
const COST_CENTER_PATH = process.env.COST_CENTER_PATH || '/sap/opu/odata4/sap/api_cost_center/srvd_a2x/sap/costcenter/0001/A_CostCenter_2';
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
  'WBSElementInternalID',
  'CostCenter'
];
const BASIC_ACCOUNT_ASSIGNMENT_FIELDS = ACCOUNT_ASSIGNMENT_FIELDS.filter(field => field !== 'CostCenter');
const ownerCache = new Map();
const workPackageCache = new Map();
const projectCache = new Map();
const managerEmailCache = new Map();
const costCenterResponsibleCache = new Map();

function isUnsupportedCostCenterProjection(error) {
  const message = String(error.response?.data?.error?.message || error.message || '');
  return error.response?.status === 400 && /CostCenter|property/i.test(message);
}

function destinationRequest(basePath) {
  return url => {
    const requestPath = url.startsWith('/sap/') ? url : `${basePath}${url}`;
    return executeHttpRequest(
      { destinationName: 'S4HC_JournalEntry' },
      { method: 'get', url: requestPath, headers: { Accept: 'application/json' } }
    );
  };
}

function responseRows(response) {
  return response.data?.value || response.data?.d?.results || [];
}

function nextPagePath(nextLink, currentPath) {
  if (!nextLink) return null;
  if (/^https?:\/\//i.test(nextLink)) {
    const url = new URL(nextLink);
    return `${url.pathname}${url.search}`;
  }
  if (nextLink.startsWith('/')) return nextLink;

  const currentPathWithoutQuery = currentPath.split('?')[0];
  const directory = currentPathWithoutQuery.slice(0, currentPathWithoutQuery.lastIndexOf('/') + 1);
  return `${directory}${nextLink}`;
}

async function fetchAllRows(request, url) {
  const rows = [];
  let page = url;

  while (page) {
    const response = await request(page);
    rows.push(...responseRows(response));
    page = nextPagePath(
      response.data?.['@odata.nextLink'] || response.data?.d?.__next,
      page
    );
  }

  return rows;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function escapeOData(value) {
  return String(value).replace(/'/g, "''");
}

async function resolveWbsOwner(wbsElement, wbsInternalId, request = destinationRequest(SERVICE_PATH)) {
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

function singleEntity(response) {
  return response.data?.d || response.data?.value?.[0] || response.data || {};
}

async function getWorkPackage(wbsElement, request) {
  if (!wbsElement) return null;
  if (!workPackageCache.has(wbsElement)) {
    const workPackageId = encodeURIComponent(wbsElement).replace(/'/g, "''");
    const url = `${PROJECT_SERVICE_PATH}/WorkpackageSet('${workPackageId}')?$format=json`;
    workPackageCache.set(wbsElement, request(url).then(singleEntity).catch(error => {
      workPackageCache.delete(wbsElement);
      throw error;
    }));
  }
  return workPackageCache.get(wbsElement);
}

async function getProject(projectId, request) {
  if (!projectId) return null;
  if (!projectCache.has(projectId)) {
    const encodedProjectId = encodeURIComponent(projectId).replace(/'/g, "''");
    const url = `${PROJECT_SERVICE_PATH}/ProjectSet('${encodedProjectId}')?$select=ProjManagerId,ProjManagerName&$format=json`;
    projectCache.set(projectId, request(url).then(singleEntity).catch(error => {
      projectCache.delete(projectId);
      throw error;
    }));
  }
  return projectCache.get(projectId);
}

async function getProjectManagerEmail(managerId, request) {
  if (!managerId) return '';
  if (!managerEmailCache.has(managerId)) {
    const filter = encodeURIComponent(`WorkAssignment eq '${escapeOData(managerId)}'`);
    const url = `${PROJECT_CONTACT_PATH}?$filter=${filter}&$select=WorkAssignment,PersonFullName,DefaultEmailAddress&$format=json`;
    managerEmailCache.set(managerId, fetchAllRows(request, url).then(contacts =>
      contacts.find(contact => contact.DefaultEmailAddress)?.DefaultEmailAddress || ''
    ).catch(error => {
      managerEmailCache.delete(managerId);
      throw error;
    }));
  }
  return managerEmailCache.get(managerId);
}

async function resolveCommercialProject(wbsElement, request = destinationRequest(''), context = {}) {
  if (!wbsElement) return {};

  try {
    const workPackage = await getWorkPackage(wbsElement, request);
    if (!workPackage) {
      console.warn('[PO] WorkpackageSet returned no record; retaining PO item.', {
        purchaseOrder: context.purchaseOrder,
        item: context.item,
        wbsElement
      });
    }
    if (!workPackage?.ProjectID) {
      return {
        projectId: workPackage?.ProjectID || '',
        projectName: workPackage?.ProjectName || '',
        workPackageId: workPackage?.WorkPackageID || wbsElement,
        workPackageName: workPackage?.WorkPackageName || ''
      };
    }

    let project = null;
    try {
      project = await getProject(workPackage.ProjectID, request);
    } catch (error) {
      console.warn('[PO] ProjectSet lookup failed; retaining WorkpackageSet details.', {
        purchaseOrder: context.purchaseOrder,
        item: context.item,
        wbsElement,
        projectId: workPackage.ProjectID,
        status: error.response?.status,
        message: error.message
      });
    }
    let projectManagerEmail = '';
    try {
      projectManagerEmail = await getProjectManagerEmail(project?.ProjManagerId, request);
    } catch (error) {
      console.warn('[PO] Project manager email lookup failed; retaining PO item.', {
        purchaseOrder: context.purchaseOrder,
        item: context.item,
        wbsElement,
        projectId: workPackage.ProjectID,
        projectManagerId: project?.ProjManagerId,
        status: error.response?.status,
        message: error.message
      });
    }
    if (!project?.ProjManagerId || !project?.ProjManagerName) {
      console.warn('[PO] ProjectSet did not return all project manager details.', {
        purchaseOrder: context.purchaseOrder,
        item: context.item,
        wbsElement,
        projectId: workPackage.ProjectID,
        hasProjectManagerId: Boolean(project?.ProjManagerId),
        hasProjectManagerName: Boolean(project?.ProjManagerName)
      });
    }

    return {
      projectId: workPackage.ProjectID || '',
      projectName: workPackage.ProjectName || '',
      workPackageId: workPackage.WorkPackageID || wbsElement,
      workPackageName: workPackage.WorkPackageName || '',
      projectManagerId: project?.ProjManagerId || '',
      projectManagerName: project?.ProjManagerName || '',
      projectManagerEmail
    };
  } catch (error) {
    console.warn('[PO] Commercial Project enrichment failed; retaining PO item.', {
      purchaseOrder: context.purchaseOrder,
      item: context.item,
      wbsElement,
      status: error.response?.status,
      message: error.message
    });
    return {
      projectId: '',
      projectName: '',
      workPackageId: wbsElement,
      workPackageName: '',
      projectManagerId: '',
      projectManagerName: '',
      projectManagerEmail: ''
    };
  }
}

async function resolveCostCenterResponsible(costCenter, request = destinationRequest(''), context = {}) {
  if (!costCenter) return '';
  if (costCenterResponsibleCache.has(costCenter)) return costCenterResponsibleCache.get(costCenter);

  try {
    const filter = encodeURIComponent(`CostCenter eq '${escapeOData(costCenter)}'`);
    const select = encodeURIComponent('CostCenter,CostCtrResponsiblePersonName');
    const rows = await fetchAllRows(request, `${COST_CENTER_PATH}?$filter=${filter}&$select=${select}&$format=json`);
    const responsible = rows.find(row => row.CostCtrResponsiblePersonName)?.CostCtrResponsiblePersonName || '';
    costCenterResponsibleCache.set(costCenter, responsible);
    return responsible;
  } catch (error) {
    console.warn('[PO] Cost Center responsible lookup failed; retaining PO item.', {
      purchaseOrder: context.purchaseOrder,
      item: context.item,
      costCenter,
      status: error.response?.status,
      message: error.message
    });
    return '';
  }
}

async function fetchOpenPOs({ resolveOwners = true } = {}) {
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
  const items = await fetchAllRows(
    baseRequest,
    `/PurchaseOrderItem?$filter=${itemFilter}&$select=${itemSelect}&$top=50`
  );
  const today = todayUtc();
  const results = [];

  for (const row of items) {
    const purchaseOrder = row.PurchaseOrder;
    const item = row.PurchaseOrderItem;
    const itemFilter = encodeURIComponent(
      `PurchaseOrder eq '${escapeOData(purchaseOrder)}' and PurchaseOrderItem eq '${String(item).padStart(5, '0')}'`
    );
    const related = fields => encodeURIComponent(fields.join(','));

    const [schedules, assignments] = await Promise.all([
      fetchAllRows(baseRequest, `/PurchaseOrderScheduleLine?$filter=${itemFilter}&$select=${related(SCHEDULE_LINE_FIELDS)}`),
      fetchAllRows(baseRequest, `/PurchaseOrderAccountAssignment?$filter=${itemFilter}&$select=${related(ACCOUNT_ASSIGNMENT_FIELDS)}`)
        .catch(async error => {
          if (!isUnsupportedCostCenterProjection(error)) throw error;

          console.warn('[PO] Cost Center projection unavailable; retrying base account assignments.', {
            purchaseOrder,
            item,
            status: error.response?.status,
            message: error.message
          });
          return fetchAllRows(baseRequest, `/PurchaseOrderAccountAssignment?$filter=${itemFilter}&$select=${related(BASIC_ACCOUNT_ASSIGNMENT_FIELDS)}`);
        })
    ]);
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
    const owner = resolveOwners
      ? await resolveWbsOwner(wbsElements[0], wbsInternalIds[0], baseRequest)
      : { ownerEmail: '', ownerName: '', ownerSource: '' };
    const projectDetails = resolveOwners
      ? await Promise.all(wbsElements.map(wbs => resolveCommercialProject(wbs, destinationRequest(''), { purchaseOrder, item })))
      : [];
    const costCenter = [...new Set(assignments.map(assignment => assignment.CostCenter).filter(Boolean))];
    const costCenterResponsible = !wbsElements.length && costCenter.length
      ? await Promise.all(costCenter.map(center => resolveCostCenterResponsible(center, undefined, { purchaseOrder, item })))
      : [];
    const projectManagerIds = [...new Set(projectDetails.map(project => project.projectManagerId).filter(Boolean))];
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
      projectId: [...new Set(projectDetails.map(project => project.projectId).filter(Boolean))].join(', '),
      projectName: [...new Set(projectDetails.map(project => project.projectName).filter(Boolean))].join(', '),
      workPackageId: [...new Set(projectDetails.map(project => project.workPackageId).filter(Boolean))].join(', '),
      workPackageName: [...new Set(projectDetails.map(project => project.workPackageName).filter(Boolean))].join(', '),
      costCenter: costCenter.join(', '),
      costCenterResponsible: [...new Set(costCenterResponsible.filter(Boolean))].join(', '),
      ownerEmail: owner.ownerEmail,
      ownerName: owner.ownerName || '',
      ownerSource: owner.ownerSource,
      projectManagerId: projectManagerIds.join(', '),
      projectManagerEmail: [...new Set(projectDetails.map(project => project.projectManagerEmail).filter(Boolean))].join(', '),
      projectManagerName: [...new Set(projectDetails.map(project => project.projectManagerName).filter(Boolean))].join(', '),
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
  const [itemRows, scheduleRows] = await Promise.all([
    fetchAllRows(request, `/PurchaseOrderItem?$filter=${filter}&$select=${itemSelect}`),
    fetchAllRows(request, `/PurchaseOrderScheduleLine?$filter=${filter}&$select=${scheduleSelect}`)
  ]);
  const itemRow = itemRows[0] || {};
  const openPurchaseOrderQuantity = scheduleRows.reduce(
    (sum, line) => sum + (Number(line.OpenPurchaseOrderQuantity) || 0),
    0
  );

  return {
    isCompletelyDelivered: itemRow.IsCompletelyDelivered === true,
    openPurchaseOrderQuantity
  };
}

module.exports = {
  fetchOpenPOs,
  fetchTrackedPOStatus,
  resolveCommercialProject,
  resolveCostCenterResponsible,
  resolveWbsOwner
};
