const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');
const { fetchAndSummarizeOpenPOs } = require('./srv/handlers/ai-agent');

function hasRole(user, role) {
  return user && typeof user.is === 'function' && user.is(role);
}

function requireJobRunner(req, res, next) {
  const user = req.user || cds.context?.user;
  if (!hasRole(user, 'JobRunner')) {
    return res.status(403).json({ status: 'ERROR', message: 'JobRunner scope required.' });
  }
  return next();
}

cds.on('bootstrap', app => {
  app.get('/', (req, res) => {
    res.type('text/plain').send('PO Monitor Agent is running. Use /run to trigger the daily job.');
  });

  app.post('/run', requireJobRunner, async (req, res) => {
    try {
      const result = await fetchAndSummarizeOpenPOs({ processNotifications: true });
      return res.status(200).json({
        status: 'OK',
        source: 'job-scheduler',
        ...result
      });
    } catch (err) {
      const incidentId = randomUUID();
      console.error('[JOB] Daily run failed.', {
        incidentId,
        errorCode: String(err.code || err.name || 'JOB_ERROR').slice(0, 80)
      });
      return res.status(500).json({
        status: 'ERROR',
        message: 'Daily PO monitor job failed. Contact support with the incident ID.',
        incidentId
      });
    }
  });
});

async function startServer() {
  return cds.server();
}

module.exports = startServer;
module.exports.hasRole = hasRole;
module.exports.requireJobRunner = requireJobRunner;

if (require.main === module) {
  startServer()
    .then(server => {
      const address = server.address();
      console.log(`CAP server listening on http://localhost:${address.port}`);
    })
    .catch(err => {
      console.error('Failed to start CAP server.', {
        errorCode: String(err.code || err.name || 'STARTUP_ERROR').slice(0, 80)
      });
      process.exit(1);
    });
}

