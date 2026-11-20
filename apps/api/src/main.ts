import { loadConfig } from './config.js';
import { createApp } from './bootstrap.js';

const config = loadConfig();
const app = await createApp();
await app.listen(config.API_PORT, '0.0.0.0');
console.log(`api listening on :${config.API_PORT}`);
