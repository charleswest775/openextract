'use strict';

// POST /api/feedback: a report sent from the app's feedback form. See _lib/feedback.js.
const { handler, receiveReport } = require('./_lib/feedback');

module.exports = handler(receiveReport);
