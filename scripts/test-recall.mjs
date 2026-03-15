import Database from 'better-sqlite3';
import { load } from 'sqlite-vec';
import { homedir } from 'node:os';

const db = new Database(`${homedir()}/.openclaw/plugins/lossless-context/messages.db`);
load(db);

// Query: recall memories about 'SeaClaw'
const queryText = 'SeaClaw dashboard development';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    input: queryText,
    model: 'text-embedding-3-small',
  }),
});
const { data } = await embedRes.json();
const queryEmbedding = data[0].embedding;
const embBuf = Buffer.from(new Float32Array(queryEmbedding).buffer);

const results = db.prepare(`
  SELECT 
    m.id,
    m.role,
    substr(m.content, 1, 200) as preview,
    m.created_at,
    vec_distance_cosine(v.embedding, ?) as distance
  FROM messages m
  JOIN messages_vec v ON m.id = v.id
  ORDER BY distance ASC
  LIMIT 10
`).all(embBuf);

console.log('Query:', queryText);
console.log('');
for (const r of results) {
  const date = new Date(r.created_at).toISOString().split('T')[0];
  console.log(`[${r.role}] ${date} (dist: ${r.distance.toFixed(3)})`);
  console.log(`  ${r.preview}...`);
  console.log('');
}

db.close();
