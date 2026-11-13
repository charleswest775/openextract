'use strict';

// GET /api/latest: { version } of the newest published release, for the home page's version
// label. See _lib/download.js.
const { handler, latest } = require('./_lib/download');

module.exports = handler(latest);
