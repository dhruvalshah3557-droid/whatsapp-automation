import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const N8N_URL = (process.env.N8N_URL || 'https://dhruval.n8n-hub.site').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const workflowsDir = join(__dirname, '..', 'workflows');

if (!N8N_API_KEY) {
  console.error('Set N8N_API_KEY (n8n Settings -> API -> Create API key) to import workflows.');
  process.exit(1);
}

const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.json'));

for (const file of files) {
  const workflow = JSON.parse(readFileSync(join(workflowsDir, file), 'utf8'));
  delete workflow.active;
  const res = await fetch(`${N8N_URL}/api/v1/workflows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': N8N_API_KEY,
    },
    body: JSON.stringify(workflow),
  });
  const body = await res.json().catch(() => ({}));
  const msg = res.ok ? 'IMPORTED' : 'FAILED';
  const detail = res.ok ? `id=${body.id}` : JSON.stringify(body);
  console.log(`${msg}  ${file}  (${res.status})  ${detail}`);
}
