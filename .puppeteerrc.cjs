// We always launch via CHROME_PATH (system Chrome locally, apt-installed
// Chromium in Docker) — never Puppeteer's own bundled browser — so skip the
// download entirely. Avoids a slow/unreliable fetch on every `npm install`.
module.exports = {
  skipDownload: true,
};
