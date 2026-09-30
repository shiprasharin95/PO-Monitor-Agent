sap.ui.define([
  'sap/ui/core/mvc/Controller',
  'sap/ui/model/json/JSONModel',
  'sap/m/MessageToast',
  'sap/m/MessageBox',
  'sap/m/Popover',
  'sap/m/CheckBox',
  'sap/m/VBox'
], function (Controller, JSONModel, MessageToast, MessageBox, Popover, CheckBox, VBox) {
  'use strict';

  return Controller.extend('demo.controller.Main', {
    onInit: function () {
      this.getView().setModel(new JSONModel({
        pos: [],
        allPos: [],
        summary: '',
        visibleCount: 0,
        busy: false,
        search: '',
        quantityFilter: 'all',
        columns: {
          purchaseOrder: true,
          item: true,
          orderQuantity: true,
          openQuantity: true,
          unit: true,
          material: true,
          materialDescription: true,
          performancePeriod: true,
          servicePerformer: true,
          servicePerformerName: true,
          projectId: true,
          projectName: true,
          workPackageId: true,
          workPackageName: true,
          costCenter: true,
          costCenterResponsible: true,
          projectManagerName: true,
          projectManagerEmail: true,
          lastNotified: false,
          resolved: false,
          notificationStatus: false,
          completelyDelivered: false
        }
      }), 'monitor');
    },

    onGoPress: function () {
      const oModel = this.getView().getModel('monitor');
      oModel.setProperty('/busy', true);

      fetch('/odata/v4/monitor/FetchOpenPOs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
        .then(async response => {
          if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `Request failed with status ${response.status}`);
          }
          return response.json();
        })
        .then(data => {
          oModel.setData({
            pos: data.pos || [],
            allPos: data.pos || [],
            summary: data.summary || '',
            visibleCount: (data.pos || []).length,
            busy: false,
            search: '',
            quantityFilter: 'all',
            columns: oModel.getProperty('/columns')
          });
          MessageToast.show(`Retrieved ${data.count || 0} open PO(s)`);
        })
        .catch(err => {
          oModel.setProperty('/busy', false);
          MessageBox.error(`Failed to retrieve open POs: ${err.message}`);
        });
    },

    onSearch: function (oEvent) {
      this.getView().getModel('monitor').setProperty('/search', oEvent.getParameter('newValue') || '');
      this._applyFilters();
    },

    onQuantityFilterChange: function (oEvent) {
      this.getView().getModel('monitor').setProperty('/quantityFilter', oEvent.getSource().getSelectedKey());
      this._applyFilters();
    },

    _applyFilters: function () {
      const oModel = this.getView().getModel('monitor');
      const search = (oModel.getProperty('/search') || '').toLowerCase().trim();
      const quantityFilter = oModel.getProperty('/quantityFilter') || 'all';
      const allPos = oModel.getProperty('/allPos') || [];
      const filtered = allPos.filter(po => {
        const orderQuantity = Number(po.orderQuantity);
        const openQuantity = Number(po.openPurchaseOrderQuantity);
        const quantityMatches = quantityFilter === 'all'
          || (quantityFilter === 'fully-open' && openQuantity === orderQuantity)
          || (quantityFilter === 'partially-open' && openQuantity > 0 && openQuantity < orderQuantity)
          || (quantityFilter === 'zero-open' && openQuantity === 0);
        const searchable = [
          po.purchaseOrder,
          po.item,
          po.material,
          po.materialDescription,
          po.servicePerformer,
          po.servicePerformerName,
          po.projectId,
          po.projectName,
          po.workPackageId,
          po.workPackageName,
          po.costCenter,
          po.costCenterResponsible,
          po.wbsElement,
          po.projectManagerName,
          po.projectManagerEmail
        ].join(' ').toLowerCase();
        return quantityMatches && (!search || searchable.includes(search));
      });

      oModel.setProperty('/pos', filtered);
      oModel.setProperty('/visibleCount', filtered.length);
    },

    onColumnSettings: function (oEvent) {
      if (!this._columnPopover) {
        const oModel = this.getView().getModel('monitor');
        const definitions = [
          ['purchaseOrder', 'Purchase Order'],
          ['item', 'Item'],
          ['material', 'Material Number'],
          ['materialDescription', 'Material Description'],
          ['orderQuantity', 'Order Qty'],
          ['openQuantity', 'Open QTY'],
          ['unit', 'Unit'],
          ['servicePerformer', 'Service Performer'],
          ['servicePerformerName', 'Service Performer Name'],
          ['performancePeriod', 'End of Performance Period'],
          ['projectId', 'Project ID'],
          ['projectName', 'Project Name'],
          ['workPackageId', 'WBS /Work Package ID'],
          ['workPackageName', 'WBS/Work Package Name'],
          ['costCenter', 'Cost Center'],
          ['costCenterResponsible', 'Cost Center Responsible'],
          ['projectManagerName', 'Project Manager Name'],
          ['projectManagerEmail', 'Project Manager Email'],
          ['lastNotified', 'Last Notified'],
          ['resolved', 'Resolved'],
          ['notificationStatus', 'Notification Status'],
          ['completelyDelivered', 'Completely Delivered']
        ];
        const checkboxes = definitions.map(([key, label]) => new CheckBox({
          text: label,
          selected: `{monitor>/columns/${key}}`,
          select: event => oModel.setProperty(`/columns/${key}`, event.getParameter('selected'))
        }));

        this._columnPopover = new Popover({
          title: 'Column settings',
          placement: 'Bottom',
          content: [new VBox({ items: checkboxes }).addStyleClass('sapUiSmallMargin')]
        });
        this.getView().addDependent(this._columnPopover);
      }

      this._columnPopover.openBy(oEvent.getSource());
    }
  });
});
