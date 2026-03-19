import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import handler from './api/recommend.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/recommend', handler);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Show Finder running → http://localhost:${PORT}`);
});
