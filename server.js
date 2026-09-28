const cds = require('@sap/cds');
const { fetchAndSummarizeOpenPOs } = require('./srv/handlers/ai-agent');

cds.on('bootstrap', app => {
  app.get('/', (req, res) => {
    res.type('text/plain').send('PO Monitor Agent is running. Use /run to trigger the daily job.');
  });

  app.post('/run', async (req, res) => {
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

module.exports = startServer;
