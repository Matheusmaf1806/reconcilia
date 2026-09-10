// Vercel serverless entrypoint. Vercel's Node runtime treats this file's
// default export as a request handler; an Express app is already a valid
// `(req, res) => {}` function, so we can export it directly.
module.exports = require('../server/app');
