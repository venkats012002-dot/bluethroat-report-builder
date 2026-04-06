const express = require('express');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 3456;
const ASSETS_DIR = path.join(__dirname, 'assets');

app.use(express.json({ limit: '50mb' }));

// Convert relative asset paths to base64 data URIs
function inlineAssets(html) {
  return html.replace(/src="assets\/([^"]+)"/g, (match, filename) => {
    const filePath = path.join(ASSETS_DIR, filename);
    if (!fs.existsSync(filePath)) return match;

    const data = fs.readFileSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    let mime = 'image/png';
    if (ext === '.svg') mime = 'image/svg+xml';
    else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';

    return `src="data:${mime};base64,${data.toString('base64')}"`;
  });
}

// API route
app.post('/api/export-pdf', async (req, res) => {
  const { previewHtml, previewCss } = req.body || {};
  if (!previewHtml) return res.status(400).send('No HTML provided');

  // Inline all asset references as base64
  const inlinedHtml = inlineAssets(previewHtml);

  const fullHtml = `<!DOCTYPE html>
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
<body>${inlinedHtml}</body>
</html>`;

  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml), {
      waitUntil: 'load',
      timeout: 30000
    });
    await new Promise(r => setTimeout(r, 2000));
    await page.setViewport({ width: 595, height: 842 });

    const pdf = await page.pdf({
      width: '595px',
      height: '842px',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=report.pdf');
    res.send(pdf);
  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).send('PDF export failed: ' + err.message);
  } finally {
    if (browser) await browser.close();
  }
});

// Serve static files — specific paths only, not api/
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`Report Builder running at http://localhost:${PORT}`);
});
