if (!global.__previewStore) global.__previewStore = { html: '' };

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(global.__previewStore.html || '<html><body>No preview set</body></html>');
};
