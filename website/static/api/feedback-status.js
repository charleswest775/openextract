'use strict';

// POST /api/feedback-status: whether a report the app sent has been fixed. See _lib/feedback.js.
const { handler, lookUpReport } = require('./_lib/feedback');

module.exports = handler(lookUpReport);
