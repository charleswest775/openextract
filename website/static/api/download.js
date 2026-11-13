'use strict';

// GET /api/download?platform=windows (what /download/windows/file rewrites to): a redirect to
// the newest release's file for that platform. See _lib/download.js.
const { handler, download } = require('./_lib/download');

module.exports = handler(download);
