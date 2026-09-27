const { fetchAndSummarizeOpenPOs } = require('./handlers/ai-agent');

module.exports = srv => {
  srv.on('FetchOpenPOs', async () => {
    return fetchAndSummarizeOpenPOs();
  });
};
