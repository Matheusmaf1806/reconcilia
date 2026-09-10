// Local development entrypoint. On Vercel, api/index.js imports server/app.js
// directly and Vercel's Node runtime calls it as a serverless function instead.
const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Reconcilia server running at http://localhost:${PORT}`);
});
