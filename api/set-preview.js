// In-memory store for preview HTML (shared via global)
if (!global.__previewStore) global.__previewStore = { html: '' };

module.exports = (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const { previewHtml, previewCss } = req.body || {};

  global.__previewStore.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: white; display: flex; flex-direction: column; align-items: center; }
    ${previewCss || ''}
  </style>
</head>
<body>
  ${previewHtml || ''}
</body>
</html>`;

  res.json({ ok: true });
};
