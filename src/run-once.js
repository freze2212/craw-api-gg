import { runScrapeJob } from './scheduler.js';

const result = await runScrapeJob('cli');
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok === false ? 1 : 0);
