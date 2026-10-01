const Approuter = require('@sap/approuter');
const xsAppConfig = require('./xs-app.json');

const approuter = new Approuter();

approuter.start({
  xsappConfig: xsAppConfig
});
