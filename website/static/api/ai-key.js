'use strict';

// GET /api/ai-key?session_id=cs_...: the OpenExtract AI key a paid checkout bought. See _lib/ai-key.js.
module.exports = require('./_lib/ai-key').handler;
