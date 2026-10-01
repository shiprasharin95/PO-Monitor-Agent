const cds = require('@sap/cds');
const { fetchAndSummarizeOpenPOs } = require('./srv/handlers/ai-agent');

function hasRole(user, role) {
  return user && typeof user.is === 'function' && user.is(role);
}

function requireJobRunner(req, res, next) {
  const user = req.user || cds.context?.user;
  if (!user || (!hasRole(user, 'POJobRunner') && !hasRole(user, 'POMonitorUser'))) {
    return res.status(403).json({ status: 'ERROR', message: 'POMonitorUser or POJobRunner role required.' });
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
      console.error('[JOB] Daily run failed:', err);
      return res.status(500).json({
        status: 'ERROR',
        message: err.message || 'Daily PO monitor job failed.'
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
      console.error('Failed to start CAP server:', err);
      process.exit(1);
    });
}

