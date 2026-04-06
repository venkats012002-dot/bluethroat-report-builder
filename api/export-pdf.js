const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const { previewHtml, previewCss } = req.body || {};
  if (!previewHtml) return res.status(400).send('No HTML provided');

  // Images are already base64 inlined by the client
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
<body>${previewHtml}</body>
</html>`;

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 595, height: 842 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml), {
      waitUntil: 'load',
      timeout: 30000
    });
    await new Promise(r => setTimeout(r, 2000));

    const pdf = await page.pdf({
      width: '595px',
      height: '842px',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=report.pdf');
    res.end(Buffer.from(pdf));
  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).send('PDF export failed: ' + err.message);
  } finally {
    if (browser) await browser.close();
  }
};
