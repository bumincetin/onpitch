#!/usr/bin/env node
// Live build dashboard for the OnPitch MVP.
//
//   node scripts/progress.mjs          -> serves http://localhost:4321 (auto-refreshing)
//   node scripts/progress.mjs --once   -> prints an ASCII snapshot and exits
//
// Reads real state off disk on every request: the agent workflow journals, the repo tree,
// and .onpitch-progress.json. Nothing is cached, so a refresh always shows the truth.

import { createServer } from 'node:http'
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const PORT = Number(process.env.PORT || 4321)

const WORKFLOWS =
  process.env.ONPITCH_WORKFLOWS ||
  join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.claude/projects/c--Users-bumin-Desktop-onpitch',
    '58da4564-c6b2-4ef6-a951-bb35ca9d3ab0/subagents/workflows'
  )

// Weighted so the bar reflects effort, not step count.
const STAGES = [
  { key: 'contract', label: 'Schema contract', weight: 3 },
  { key: 'build', label: 'Build fan-out', weight: 22 },
  { key: 'review', label: 'Review + verify + fix', weight: 15 },
  { key: 'compile', label: 'Typecheck + build', weight: 8 },
  { key: 'review2', label: 'Second review pass', weight: 12 },
  { key: 'features', label: 'New features', weight: 12 },
  { key: 'deslop', label: 'De-slop the prose', weight: 8 },
  { key: 'mobile', label: 'Mobile app (Expo)', weight: 15 },
  { key: 'report', label: 'Final report', weight: 5 },
]

// ---------------------------------------------------------------- disk readers

function head(path, bytes) {
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    closeSync(fd)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  }
}

function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (['node_modules', '.git', '.next', '__pycache__', '.venv', 'scripts'].includes(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out, depth + 1)
    else out.push(p)
  }
  return out
}

function countLines(p) {
  try {
    const s = readFileSync(p, 'utf8')
    return s.length ? s.split('\n').length : 0
  } catch {
    return 0
  }
}

// Labels are not in the journal, so recover them from each agent's prompt.
const LABEL_PATTERNS = [
  [/=== ADVERSARIAL VERIFICATION — area "([^"]+)"/, (m) => `verify: ${m[1]}`],
  [/=== APPLY FIXES — area "([^"]+)"/, (m) => `fix: ${m[1]}`],
  [/DIMENSION: ([^.\n]+)/, (m) => `review: ${m[1].trim().slice(0, 46)}`],
  [/Expo mobile foundation/, () => 'mobile: foundation'],
  // Transcripts are JSON, so a newline in the prompt is the two characters \ and n.
  [/OWN under apps\/mobile\/:(?:\\n|[\r\n])+-\s*(\S+)/, (m) => `mobile: ${m[1]}`],
  [/OWN[^:]{0,40}:(?:\\n|[\r\n])+-\s*apps\/web\/(\S+)/, (m) => `web: ${m[1]}`],
  [/you are the SCHEMA CONTRACT agent/, () => 'schema contract'],
  [/Write \S*supabase\/migrations\/(\d{4}_[a-z0-9_]+)\.sql/, (m) => `sql: ${m[1]}`],
  [/Own these files:\s*\n-\s*\S*?\/((?:app|lib|components|types|services)\/[^\s,]+)/, (m) => `build: ${m[1]}`],
  [/You own the project scaffold/, () => 'build: scaffold + ui'],
  [/Own the external Python microservice/, () => 'build: anomaly service'],
]

function labelFor(text) {
  for (const [re, fn] of LABEL_PATTERNS) {
    const m = text.match(re)
    // A capture can run past the end of a line into the next escaped newline; cut it there.
    if (m) return fn(m).replace(/\\n.*$/, '').trim()
  }
  return 'agent'
}

function readWorkflow(dir) {
  const full = join(WORKFLOWS, dir)
  let journal = ''
  try {
    journal = readFileSync(join(full, 'journal.jsonl'), 'utf8')
  } catch {
    return null
  }
  const started = new Map()
  const done = new Set()
  for (const line of journal.split('\n')) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'started') started.set(ev.agentId, true)
    if (ev.type === 'result') done.add(ev.agentId)
  }

  const agents = []
  for (const id of started.keys()) {
    const f = join(full, `agent-${id}.jsonl`)
    let size = 0
    let mtime = 0
    try {
      const st = statSync(f)
      size = st.size
      mtime = st.mtimeMs
    } catch {}
    agents.push({
      id,
      label: labelFor(head(f, 90_000)),
      done: done.has(id),
      kb: Math.round(size / 1024),
      mtime,
    })
  }
  agents.sort((a, b) => (a.done === b.done ? b.kb - a.kb : a.done ? 1 : -1))

  let mtime = 0
  try {
    mtime = statSync(join(full, 'journal.jsonl')).mtimeMs
  } catch {}

  return { dir, agents, started: started.size, done: done.size, mtime }
}

function readWorkflows() {
  let dirs = []
  try {
    dirs = readdirSync(WORKFLOWS).filter((d) => d.startsWith('wf_'))
  } catch {
    return []
  }
  return dirs
    .map(readWorkflow)
    .filter(Boolean)
    .sort((a, b) => a.mtime - b.mtime)
}

function readOverrides() {
  try {
    return JSON.parse(readFileSync(join(REPO, '.onpitch-progress.json'), 'utf8'))
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------- state

function snapshot() {
  const files = walk(REPO)
  const rel = files.map((f) => f.replace(REPO, '').replace(/\\/g, '/').replace(/^\//, ''))
  const code = files.filter((f) => ['.ts', '.tsx', '.sql', '.py', '.mjs', '.css'].includes(extname(f)))
  const loc = code.reduce((n, f) => n + countLines(f), 0)

  const stats = {
    files: rel.length,
    loc,
    migrations: rel.filter((f) => f.startsWith('supabase/migrations/')).length,
    routes: rel.filter((f) => /app\/api\/.*route\.ts$/.test(f)).length,
    pages: rel.filter((f) => /apps\/web\/app\/.*page\.tsx$/.test(f)).length,
    mobile: rel.filter((f) => /^apps\/mobile\/app\/.*\.tsx$/.test(f)).length,
    shared: rel.filter((f) => f.startsWith('packages/shared/src/')).length,
    components: rel.filter((f) => /components\//.test(f)).length,
    edge: rel.filter((f) => /^supabase\/functions\/[^_].*index\.ts$/.test(f)).length,
    python: rel.filter((f) => f.startsWith('services/anomaly/') && f.endsWith('.py')).length,
    docs: rel.filter((f) => f.startsWith('docs/') || f === 'README.md').length,
    deps: existsSync(join(REPO, 'node_modules')),
  }

  const wfs = readWorkflows()
  const over = readOverrides()

  // Each workflow run maps onto the stage it drives. Expected agent counts are what the
  // scripts actually launch, so a stage only reads 100% when its agents have all returned.
  const RUNS = over.runs || [
    { stage: 'build', expected: 15 },
    { stage: 'review', expected: 24 },
    { stage: 'featuresMobile', expected: 9 },
    { stage: 'review2', expected: 24 },
    { stage: 'deslop', expected: 8 },
  ]

  const frac = {}
  wfs.forEach((wf, i) => {
    const run = RUNS[i]
    if (!run) return
    frac[run.stage] = Math.min(wf.done / Math.max(run.expected, wf.started, 1), 1)
  })

  const st = {}
  st.contract = existsSync(join(REPO, 'supabase/migrations/0001_schema.sql')) ? 1 : 0
  st.build = frac.build ?? 0
  st.review = frac.review ?? 0
  // One workflow builds the web features and the mobile app, so it advances both bars.
  st.features = over.features ?? frac.featuresMobile ?? 0
  st.mobile = over.mobile ?? frac.featuresMobile ?? 0
  st.review2 = over.review2 ?? frac.review2 ?? 0
  st.deslop = over.deslop ?? frac.deslop ?? 0
  // Stages I drive by hand rather than infer from a journal.
  for (const k of ['compile', 'report']) st[k] = over[k] ?? 0

  const overall = STAGES.reduce((n, s) => n + s.weight * (st[s.key] || 0), 0)

  return {
    stages: STAGES.map((s) => ({ ...s, pct: Math.round((st[s.key] || 0) * 100) })),
    overall: Math.round(overall),
    stats,
    // The newest workflow that still has an agent running, else the newest overall.
    active: wfs.filter((w) => w.done < w.started).pop() || wfs[wfs.length - 1] || null,
    notes: over.notes || [],
    typecheck: over.typecheck || null,
    at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------- render

function bar(pct, width = 34) {
  const n = Math.round((pct / 100) * width)
  return '█'.repeat(n) + '░'.repeat(width - n)
}

function ascii(s) {
  const L = []
  L.push('')
  L.push('  ONPITCH — build progress')
  L.push('  ' + '─'.repeat(58))
  for (const st of s.stages) {
    const mark = st.pct === 100 ? '✔' : st.pct > 0 ? '▸' : ' '
    L.push(`  ${mark} ${st.label.padEnd(24)} ${bar(st.pct)} ${String(st.pct).padStart(3)}%`)
  }
  L.push('  ' + '─'.repeat(58))
  L.push(`    OVERALL${' '.repeat(19)} ${bar(s.overall)} ${String(s.overall).padStart(3)}%`)
  L.push('')
  L.push(
    `  ${s.stats.files} files · ${s.stats.loc.toLocaleString()} lines · ` +
      `${s.stats.migrations} migrations · ${s.stats.routes} routes · ${s.stats.pages} pages`
  )
  if (s.active) {
    const running = s.active.agents.filter((a) => !a.done)
    L.push(`  agents: ${s.active.done}/${s.active.started} done, ${running.length} running`)
    for (const a of running.slice(0, 8)) L.push(`    ⣾ ${a.label.padEnd(40)} ${a.kb}KB`)
  }
  L.push('')
  return L.join('\n')
}

function html(s) {
  const rows = s.stages
    .map(
      (st) => `
    <div class="stage ${st.pct === 100 ? 'done' : st.pct > 0 ? 'active' : ''}">
      <div class="slabel"><span class="dot"></span>${st.label}</div>
      <div class="track"><div class="fill" style="width:${st.pct}%"></div></div>
      <div class="spct">${st.pct}%</div>
    </div>`
    )
    .join('')

  const agents = s.active
    ? s.active.agents
        .map(
          (a) => `<tr class="${a.done ? 'ok' : 'run'}">
            <td class="st">${a.done ? '✔' : '<span class="spin">⣾</span>'}</td>
            <td class="lbl">${a.label.replace(/</g, '&lt;')}</td>
            <td class="kb">${a.kb} KB</td></tr>`
        )
        .join('')
    : '<tr><td colspan="3" class="muted">no active workflow</td></tr>'

  const notes = s.notes.length
    ? `<ul class="notes">${s.notes.map((n) => `<li>${String(n).replace(/</g, '&lt;')}</li>`).join('')}</ul>`
    : ''

  const tc = s.typecheck
    ? `<div class="tc ${s.typecheck.errors === 0 ? 'green' : 'amber'}">
         tsc --noEmit · ${s.typecheck.errors} error${s.typecheck.errors === 1 ? '' : 's'}
         <span class="muted">${s.typecheck.at || ''}</span></div>`
    : ''

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OnPitch — build progress</title>
<style>
  :root{--bg:#faf9f7;--fg:#1a1a19;--muted:#8a8780;--line:#e5e2dc;--card:#fff;
        --accent:#16a34a;--accent2:#22c55e;--run:#d97706;--shadow:0 1px 3px rgba(0,0,0,.06)}
  @media (prefers-color-scheme:dark){
    :root{--bg:#141413;--fg:#f2f0ed;--muted:#8a8780;--line:#2a2926;--card:#1c1b19;
          --accent:#22c55e;--accent2:#4ade80;--run:#f59e0b;--shadow:none}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
  .wrap{max-width:860px;margin:0 auto;padding:32px 20px 60px}
  h1{font-size:19px;margin:0 0 2px;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:12px;margin-bottom:26px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;
        padding:20px;margin-bottom:18px;box-shadow:var(--shadow)}
  .big{font-size:44px;font-weight:600;letter-spacing:-.03em;line-height:1}
  .bigrow{display:flex;align-items:baseline;gap:12px;margin-bottom:14px}
  .bigsub{color:var(--muted);font-size:12px}
  .track{background:var(--line);border-radius:99px;height:8px;overflow:hidden}
  .track.hero{height:12px}
  .fill{height:100%;border-radius:99px;
        background:linear-gradient(90deg,var(--accent),var(--accent2));
        transition:width .6s cubic-bezier(.4,0,.2,1)}
  .stage{display:grid;grid-template-columns:200px 1fr 46px;gap:14px;align-items:center;
         padding:7px 0}
  .slabel{color:var(--muted);display:flex;align-items:center;gap:8px;font-size:13px}
  .stage.done .slabel,.stage.active .slabel{color:var(--fg)}
  .dot{width:7px;height:7px;border-radius:99px;background:var(--line);flex:none}
  .stage.done .dot{background:var(--accent)}
  .stage.active .dot{background:var(--run);animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .spct{text-align:right;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:14px}
  .stat b{display:block;font-size:21px;font-weight:600;letter-spacing:-.02em}
  .stat span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  td{padding:5px 6px;border-bottom:1px solid var(--line)}
  tr:last-child td{border-bottom:0}
  .st{width:20px;color:var(--accent)}
  tr.run .st{color:var(--run)}
  tr.run .lbl{color:var(--fg)}
  .lbl{color:var(--muted)}
  .kb{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;width:72px}
  .muted{color:var(--muted)}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
     margin:0 0 12px;font-weight:600}
  .spin{display:inline-block;animation:sp 1s steps(8) infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  .notes{margin:0;padding-left:18px;color:var(--muted);font-size:12.5px}
  .notes li{margin:3px 0}
  .tc{font-size:12.5px;padding:8px 10px;border-radius:6px;margin-top:12px}
  .tc.green{background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)}
  .tc.amber{background:color-mix(in srgb,var(--run) 12%,transparent);color:var(--run)}
  .foot{color:var(--muted);font-size:11px;text-align:center;margin-top:24px}
</style></head><body>
<div class="wrap">
  <h1>OnPitch</h1>
  <div class="sub">amateur football platform · MVP build</div>

  <div class="card">
    <div class="bigrow"><div class="big">${s.overall}%</div>
      <div class="bigsub">complete</div></div>
    <div class="track hero"><div class="fill" style="width:${s.overall}%"></div></div>
  </div>

  <div class="card">${rows}${tc}</div>

  <div class="card">
    <h2>Codebase</h2>
    <div class="grid">
      <div class="stat"><b>${s.stats.files}</b><span>files</span></div>
      <div class="stat"><b>${s.stats.loc.toLocaleString()}</b><span>lines</span></div>
      <div class="stat"><b>${s.stats.migrations}</b><span>migrations</span></div>
      <div class="stat"><b>${s.stats.routes}</b><span>api routes</span></div>
      <div class="stat"><b>${s.stats.pages}</b><span>pages</span></div>
      <div class="stat"><b>${s.stats.components}</b><span>components</span></div>
      <div class="stat"><b>${s.stats.mobile}</b><span>mobile screens</span></div>
      <div class="stat"><b>${s.stats.shared}</b><span>shared modules</span></div>
      <div class="stat"><b>${s.stats.edge}</b><span>edge fns</span></div>
      <div class="stat"><b>${s.stats.docs}</b><span>docs</span></div>
    </div>
  </div>

  <div class="card">
    <h2>Agents ${s.active ? `· ${s.active.done}/${s.active.started} done` : ''}</h2>
    <table>${agents}</table>
  </div>

  ${notes ? `<div class="card"><h2>Notes</h2>${notes}</div>` : ''}

  <div class="foot">refreshes every 3s · ${s.at.replace('T', ' ').slice(0, 19)}Z</div>
</div>
<script>
  setTimeout(function(){ location.reload() }, 3000)
</script>
</body></html>`
}

// ---------------------------------------------------------------- main

if (process.argv.includes('--once')) {
  console.log(ascii(snapshot()))
  process.exit(0)
}

createServer((req, res) => {
  const s = snapshot()
  if (req.url === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(s, null, 2))
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html(s))
}).listen(PORT, () => {
  console.log(`\n  OnPitch progress dashboard -> http://localhost:${PORT}\n`)
})
