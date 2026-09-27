sap.ui.define(['sap/ui/model/json/JSONModel'], function (JSONModel) {
  'use strict';

  return {
    createMonitorModel: function () {
      return new JSONModel({ pos: [], summary: '', count: 0, busy: false });
    }
  };
});
