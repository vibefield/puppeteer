#!/usr/bin/env node
/** Build, verify, and visualize one canonical ground-truth document per agent. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGroundTruth, loadGroundTruth } from '@vibecook/puppeteer-surface';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const vendorsRoot = join(packageRoot, 'vendors');
const personasRoot = join(dirname(packageRoot), 'imposter', 'personas');
const commands = new Set(['build', 'check', 'render']);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function pretty(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

function evidenceBadges(evidence = {}) {
  const refs = [
    ...new Set(
      Object.values(evidence)
        .flat()
        .filter((value) => typeof value === 'string'),
    ),
  ];
  if (refs.length === 0) return '';
  return `<div class="evidence-refs">${refs
    .map((ref) => `<a class="evidence-ref" href="#claim-${slug(ref)}">${escapeHtml(ref)}</a>`)
    .join('')}</div>`;
}

function schemaSection(label, schema) {
  if (!schema) return '';
  return `<details class="schema"><summary>${escapeHtml(label)}</summary><pre>${pretty(schema)}</pre></details>`;
}

function renderBehavior(model) {
  const behavior = model.behavior;
  const nodesByLane = new Map(behavior.lanes.map((lane) => [lane.id, []]));
  for (const node of behavior.nodes) nodesByLane.get(node.lane)?.push(node);
  const lanes = behavior.lanes
    .map((lane) => {
      const nodes = (nodesByLane.get(lane.id) ?? []).sort((left, right) => left.order - right.order);
      return `<section class="lane"><header><strong>${escapeHtml(lane.label)}</strong><code>${escapeHtml(
        lane.id,
      )}</code>${lane.description ? `<span>${escapeHtml(lane.description)}</span>` : ''}</header><div class="lane-track">${nodes
        .map(
          (node) =>
            `<a class="behavior-node confidence-${slug(node.confidence)}" href="#event-${slug(node.event)}" title="${escapeHtml(
              node.description ?? node.event,
            )}"><span>${escapeHtml(node.label ?? node.event)}</span><small>${escapeHtml(node.event)}</small>${
              node.match ? `<code>${escapeHtml(JSON.stringify(node.match))}</code>` : ''
            }</a>`,
        )
        .join('<span class="flow-arrow">→</span>')}</div></section>`;
    })
    .join('');
  const relations = behavior.relations
    .map(
      (relation) =>
        `<tr><td><code>${escapeHtml(relation.from)}</code></td><td><span class="relation-kind">${escapeHtml(
          relation.kind,
        )}</span></td><td><code>${escapeHtml(relation.to)}</code></td><td>${escapeHtml(
          relation.label ?? '',
        )}</td><td><span class="confidence ${slug(relation.confidence)}">${escapeHtml(
          relation.confidence,
        )}</span></td></tr>`,
    )
    .join('');
  return `<section id="behavior" class="panel"><div class="section-heading"><div><span class="eyebrow">Native topology</span><h2>${escapeHtml(
    behavior.title,
  )}</h2></div><span class="count">${behavior.nodes.length} nodes · ${behavior.relations.length} relations</span></div>${
    behavior.description ? `<p class="lede">${escapeHtml(behavior.description)}</p>` : ''
  }<div class="lanes">${lanes}</div><details class="relation-table"><summary>Relation ledger</summary><div class="table-wrap"><table><thead><tr><th>From</th><th>Kind</th><th>To</th><th>Label</th><th>Confidence</th></tr></thead><tbody>${relations}</tbody></table></div></details></section>`;
}

function renderChannels(model) {
  const rows = Object.entries(model.channels.channels)
    .map(
      ([name, channel]) =>
        `<tr><td><code>${escapeHtml(name)}</code></td><td><span class="channel-kind">${escapeHtml(
          channel.kind,
        )}</span></td><td><pre>${pretty(
          Object.fromEntries(Object.entries(channel).filter(([key]) => key !== 'kind')),
        )}</pre></td></tr>`,
    )
    .join('');
  return `<section id="channels" class="panel"><div class="section-heading"><div><span class="eyebrow">Transport map</span><h2>Channels</h2></div><span class="count">${
    Object.keys(model.channels.channels).length
  }</span></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Kind</th><th>Contract</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderEvents(model) {
  const cards = model.events
    .map((event) => {
      const search = [event.event, event.direction, event.transport, event.confidence, ...(event.channels ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const variants = event.variants?.length
        ? `<details class="variants"><summary>${event.variants.length} evidenced variants</summary>${event.variants
            .map(
              (variant) =>
                `<div class="variant"><code>${escapeHtml(JSON.stringify(variant.match))}</code><span class="confidence ${slug(
                  variant.confidence,
                )}">${escapeHtml(variant.confidence)}</span>${evidenceBadges(variant.evidence)}</div>`,
            )
            .join('')}</details>`
        : '';
      return `<article id="event-${slug(event.event)}" class="event-card" data-search="${escapeHtml(
        search,
      )}" data-direction="${escapeHtml(event.direction ?? 'legacy')}" data-confidence="${escapeHtml(
        event.confidence,
      )}"><details><summary><span class="event-name">${escapeHtml(event.event)}</span><span class="event-meta"><span class="direction">${escapeHtml(
        event.direction ?? 'legacy',
      )}</span><span class="confidence ${slug(event.confidence)}">${escapeHtml(event.confidence)}</span></span></summary><div class="event-body"><dl><div><dt>Channel</dt><dd>${event.channels
        .map((channel) => `<a href="#channels"><code>${escapeHtml(channel)}</code></a>`)
        .join(
          ' ',
        )}</dd></div><div><dt>Transport</dt><dd>${escapeHtml(event.transport ?? '—')}</dd></div><div><dt>Trigger</dt><dd>${escapeHtml(
        event.trigger ?? '—',
      )}</dd></div></dl>${event.notes ? `<p>${escapeHtml(event.notes)}</p>` : ''}${evidenceBadges(
        event.evidence,
      )}${variants}${schemaSection('Payload schema', event.payloadSchema)}${schemaSection(
        'Result schema',
        event.resultSchema,
      )}${schemaSection('Carrier schema', event.recordSchema)}</div></details></article>`;
    })
    .join('');
  const directions = [...new Set(model.events.map((event) => event.direction ?? 'legacy'))].sort();
  return `<section id="events" class="panel"><div class="section-heading"><div><span class="eyebrow">Wire catalog</span><h2>Events</h2></div><span id="event-count" class="count">${model.events.length}</span></div><div class="toolbar"><label><span>Search</span><input id="event-search" type="search" placeholder="event, channel, transport…" /></label><label><span>Direction</span><select id="direction-filter"><option value="">all</option>${directions
    .map((direction) => `<option value="${escapeHtml(direction)}">${escapeHtml(direction)}</option>`)
    .join(
      '',
    )}</select></label><label><span>Confidence</span><select id="confidence-filter"><option value="">all</option><option>verified-headless</option><option>verified-interactive</option><option>unverified</option></select></label><button id="expand-visible" type="button">Expand visible</button><button id="collapse-events" type="button">Collapse</button></div><div id="event-list" class="event-list">${cards}</div><p id="empty-events" class="empty" hidden>No events match these filters.</p></section>`;
}

function renderEvidence(model) {
  const evidence = model.evidenceIndex ?? model.legacyEvidenceIndex;
  if (!evidence) return '';
  const claims = evidence.claims ?? [];
  const records = (evidence.records ?? [])
    .map(
      (record) =>
        `<tr><td><code>${escapeHtml(record.id)}</code></td><td>${escapeHtml(record.kind ?? '')}</td><td><code>${escapeHtml(
          record.sha256 ? `sha256:${record.sha256}` : (record.path ?? ''),
        )}</code></td></tr>`,
    )
    .join('');
  const claimCards = claims
    .map(
      (claim) =>
        `<article id="claim-${slug(claim.id)}" class="claim-card"><header><code>${escapeHtml(
          claim.id,
        )}</code><span>${escapeHtml(claim.kind)}</span><span class="confidence ${slug(claim.confidence)}">${escapeHtml(
          claim.confidence,
        )}</span></header><dl><div><dt>Record</dt><dd>${escapeHtml(claim.record ?? '—')}</dd></div><div><dt>Artifact</dt><dd>${escapeHtml(
          claim.artifact ?? '—',
        )}</dd></div><div><dt>Captured</dt><dd>${escapeHtml(claim.capturedAt ?? '—')}</dd></div></dl>${
          claim.notes ? `<p>${escapeHtml(claim.notes)}</p>` : ''
        }</article>`,
    )
    .join('');
  return `<section id="evidence" class="panel"><div class="section-heading"><div><span class="eyebrow">Provenance</span><h2>Evidence</h2></div><span class="count">v${evidence.evidenceVersion} · ${claims.length} claims</span></div><details open><summary>Digest-pinned records</summary><div class="table-wrap"><table><thead><tr><th>ID</th><th>Kind</th><th>Path / digest</th></tr></thead><tbody>${records}</tbody></table></div></details>${
    claims.length ? `<details><summary>Claim index</summary><div class="claim-list">${claimCards}</div></details>` : ''
  }</section>`;
}

const CSS = `
:root{color-scheme:light;--bg:#f4f2ec;--paper:#fff;--paper2:#f7f6f2;--ink:#25272b;--muted:#6c7077;--line:#ddd9cf;--accent:#9f4c28;--teal:#176b61;--blue:#355b8c;--amber:#8a6418;--red:#a13f45;--shadow:0 12px 36px rgba(30,32,36,.07)}
:root[data-theme=dark]{color-scheme:dark;--bg:#141619;--paper:#1d2024;--paper2:#25292e;--ink:#e8e6e0;--muted:#a1a6ad;--line:#383c42;--accent:#da815a;--teal:#63b7a9;--blue:#83a8da;--amber:#d2ad58;--red:#df858a;--shadow:0 14px 40px rgba(0,0,0,.25)}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#141619;--paper:#1d2024;--paper2:#25292e;--ink:#e8e6e0;--muted:#a1a6ad;--line:#383c42;--accent:#da815a;--teal:#63b7a9;--blue:#83a8da;--amber:#d2ad58;--red:#df858a;--shadow:0 14px 40px rgba(0,0,0,.25)}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:1rem}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}code,pre,input,select{font-family:"SFMono-Regular",Consolas,monospace}a{color:var(--teal);text-decoration:none}a:hover{text-decoration:underline}.shell{width:min(1420px,100%);margin:auto;padding:2.5rem 1.5rem 6rem}.hero,.panel{background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}.hero{padding:2rem;margin-bottom:1.25rem}.hero-row,.section-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font:700 11px/1.3 "SFMono-Regular",monospace;color:var(--accent)}h1,h2{margin:.28rem 0 0;line-height:1.12}h1{font-size:clamp(2rem,5vw,4.2rem);letter-spacing:-.04em}h2{font-size:1.45rem}.version{color:var(--muted);font-weight:450}.theme{border:1px solid var(--line);background:var(--paper2);color:var(--ink);border-radius:999px;padding:.45rem .75rem;cursor:pointer}.lede{max-width:75ch;color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.7rem;margin-top:1.5rem}.stat{padding:.85rem;background:var(--paper2);border:1px solid var(--line);border-radius:9px}.stat strong{display:block;font-size:1.35rem}.stat span,.count{color:var(--muted);font-size:.82rem}.nav{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1.2rem}.nav a{border:1px solid var(--line);border-radius:999px;padding:.35rem .7rem;background:var(--paper2)}.panel{padding:1.5rem;margin:1.25rem 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.6rem .7rem;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.08em}td pre{margin:0;white-space:pre-wrap;font-size:.76rem}.channel-kind,.relation-kind,.direction,.confidence{display:inline-flex;padding:.12rem .42rem;border-radius:5px;background:var(--paper2);border:1px solid var(--line);font-size:.75rem}.verified-headless{color:var(--teal)}.verified-interactive{color:var(--blue)}.unverified{color:var(--amber)}.lanes{display:grid;gap:.7rem;margin-top:1rem}.lane{display:grid;grid-template-columns:180px 1fr;border:1px solid var(--line);border-radius:9px;overflow:hidden}.lane>header{padding:.7rem;background:var(--paper2);display:flex;flex-direction:column}.lane>header span{color:var(--muted);font-size:.78rem}.lane-track{display:flex;align-items:center;gap:.4rem;padding:.7rem;overflow:auto}.behavior-node{display:flex;flex-direction:column;min-width:145px;padding:.55rem .65rem;border:1px solid var(--line);border-left:3px solid currentColor;border-radius:7px;background:var(--paper)}.behavior-node small{color:var(--muted)}.behavior-node code{font-size:.66rem}.flow-arrow{color:var(--muted)}details>summary{cursor:pointer}.relation-table{margin-top:1rem}.toolbar{display:flex;align-items:end;gap:.65rem;flex-wrap:wrap;margin:1rem 0}.toolbar label{display:flex;flex-direction:column;gap:.2rem}.toolbar label span{color:var(--muted);font-size:.75rem}.toolbar input,.toolbar select,.toolbar button{min-height:38px;border:1px solid var(--line);border-radius:7px;background:var(--paper2);color:var(--ink);padding:.4rem .6rem}.toolbar input{width:min(330px,70vw)}.toolbar button{cursor:pointer}.event-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem}.event-card{border:1px solid var(--line);border-radius:9px;background:var(--paper2);scroll-margin-top:1rem}.event-card[hidden]{display:none}.event-card>details>summary{display:flex;justify-content:space-between;align-items:center;gap:.7rem;padding:.75rem}.event-name{font:600 .86rem "SFMono-Regular",monospace;overflow-wrap:anywhere}.event-meta{display:flex;gap:.35rem}.event-body{padding:.1rem .8rem .8rem;border-top:1px solid var(--line)}dl{margin:.7rem 0}dl>div{display:grid;grid-template-columns:90px 1fr;gap:.5rem}dt{color:var(--muted)}dd{margin:0}.evidence-refs{display:flex;gap:.3rem;flex-wrap:wrap;margin:.65rem 0}.evidence-ref{font:500 .7rem "SFMono-Regular",monospace;border:1px solid var(--line);border-radius:999px;padding:.15rem .4rem}.schema,.variants{margin:.55rem 0}.schema pre{max-height:520px;overflow:auto;padding:.75rem;border:1px solid var(--line);border-radius:7px;background:var(--paper);font-size:.73rem}.variant{padding:.45rem 0;border-bottom:1px solid var(--line)}.claim-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem;margin-top:.7rem}.claim-card{border:1px solid var(--line);border-radius:8px;padding:.7rem;scroll-margin-top:1rem}.claim-card header{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}.claim-card header>span:nth-child(2){color:var(--muted)}.claim-card p{color:var(--muted)}.empty{text-align:center;color:var(--muted);padding:2rem}.source{margin-top:1rem;color:var(--muted);font-size:.82rem;overflow-wrap:anywhere}
@media(max-width:800px){.stats{grid-template-columns:repeat(2,1fr)}.event-list,.claim-list{grid-template-columns:1fr}.lane{grid-template-columns:1fr}.hero-row,.section-heading{align-items:stretch}.event-card>details>summary{align-items:flex-start;flex-direction:column}.event-meta{flex-wrap:wrap}}
`;

const JS = `
const root=document.documentElement;let saved;try{saved=localStorage.getItem('surface-theme')}catch{}if(saved)root.dataset.theme=saved;
document.querySelector('.theme').addEventListener('click',()=>{const dark=root.dataset.theme==='dark'||(!root.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches);root.dataset.theme=dark?'light':'dark';try{localStorage.setItem('surface-theme',root.dataset.theme)}catch{}});
const search=document.querySelector('#event-search'),direction=document.querySelector('#direction-filter'),confidence=document.querySelector('#confidence-filter'),cards=[...document.querySelectorAll('.event-card')],count=document.querySelector('#event-count'),empty=document.querySelector('#empty-events');
function filter(){const q=search.value.trim().toLowerCase();let shown=0;for(const card of cards){const visible=(!q||card.dataset.search.includes(q))&&(!direction.value||card.dataset.direction===direction.value)&&(!confidence.value||card.dataset.confidence===confidence.value);card.hidden=!visible;if(visible)shown++}count.textContent=shown+' / '+cards.length;empty.hidden=shown!==0}
search.addEventListener('input',filter);direction.addEventListener('change',filter);confidence.addEventListener('change',filter);
document.querySelector('#expand-visible').addEventListener('click',()=>cards.filter(card=>!card.hidden).forEach(card=>card.firstElementChild.open=true));document.querySelector('#collapse-events').addEventListener('click',()=>cards.forEach(card=>card.firstElementChild.open=false));
`;

export function renderGroundTruth(model) {
  const evidence = model.evidenceIndex ?? model.legacyEvidenceIndex;
  const channelCount = Object.keys(model.channels.channels).length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="generator" content="@vibecook/puppeteer-surface groundtruth" /><title>${escapeHtml(
    `${model.manifest.vendor}@${model.manifest.vendorVersion} ground truth`,
  )}</title><style>${CSS}</style></head><body><main class="shell"><header class="hero"><div class="hero-row"><div><span class="eyebrow">Agent surface ground truth</span><h1>${escapeHtml(
    model.manifest.vendor,
  )} <span class="version">${escapeHtml(model.manifest.vendorVersion)}</span></h1><p class="lede">One canonical, evidence-backed description of the agent's native transports, events, payload contracts, and behavior topology.</p></div><button class="theme" type="button">Toggle theme</button></div><div class="stats"><div class="stat"><strong>${model.events.length}</strong><span>events</span></div><div class="stat"><strong>${channelCount}</strong><span>channels</span></div><div class="stat"><strong>${model.behavior.nodes.length}</strong><span>behavior nodes</span></div><div class="stat"><strong>${model.behavior.relations.length}</strong><span>relations</span></div><div class="stat"><strong>${evidence?.claims?.length ?? 0}</strong><span>evidence claims</span></div></div><nav class="nav"><a href="#channels">Channels</a><a href="#behavior">Behavior</a><a href="#events">Events</a>${
    evidence ? '<a href="#evidence">Evidence</a>' : ''
  }</nav><p class="source"><code>${escapeHtml(model.format)}</code> · ASM v${model.manifest.asmVersion} · generated ${escapeHtml(
    model.manifest.generatedAt,
  )}${model.manifest.source ? ` · ${escapeHtml(model.manifest.source)}` : ''}</p></header>${renderChannels(
    model,
  )}${renderBehavior(model)}${renderEvents(model)}${renderEvidence(model)}</main><script>${JS}</script></body></html>\n`;
}

function modelRoots(agentRoot) {
  const roots = [];
  const modelsRoot = join(agentRoot, 'model');
  if (!existsSync(modelsRoot)) return roots;
  if (existsSync(join(modelsRoot, 'manifest.json'))) return [modelsRoot];
  for (const entry of readdirSync(modelsRoot, { withFileTypes: true })) {
    const root = join(modelsRoot, entry.name);
    if (entry.isDirectory() && existsSync(join(root, 'manifest.json'))) roots.push(root);
  }
  return roots.sort((left, right) => basename(left).localeCompare(basename(right), undefined, { numeric: true }));
}

function agentRootForModel(modelRoot) {
  const resolvedModelRoot = resolve(modelRoot);
  const agentRoot =
    basename(resolvedModelRoot) === 'model'
      ? dirname(resolvedModelRoot)
      : basename(dirname(resolvedModelRoot)) === 'model'
        ? dirname(dirname(resolvedModelRoot))
        : undefined;
  if (!agentRoot) throw new Error(`${modelRoot}: authoring models must live in an agent model/ directory`);
  return { agentRoot, modelRoot: resolvedModelRoot };
}

function buildAgentGroundTruth(agentRoot, modelRoot) {
  const document = buildGroundTruth(modelRoot);
  if (document.manifest.vendor !== basename(agentRoot)) {
    throw new Error(
      `${modelRoot}: manifest vendor ${document.manifest.vendor} does not match agent root ${basename(agentRoot)}`,
    );
  }
  if (
    basename(modelRoot) !== 'model' &&
    basename(modelRoot) !== `${document.manifest.vendor}@${document.manifest.vendorVersion}`
  ) {
    throw new Error(
      `${modelRoot}: versioned authoring directory must match ${document.manifest.vendor}@${document.manifest.vendorVersion}`,
    );
  }
  return document;
}

function groundTruthArtifactsUnder(root, current = root) {
  const artifacts = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) artifacts.push(...groundTruthArtifactsUnder(root, path));
    else if (entry.name === 'groundtruth.json' || entry.name === 'groundtruth.html') artifacts.push(path);
  }
  return artifacts;
}

/** Agent roots own canonical output; their model/ children are authoring inputs only. */
export function discoverGroundTruthRoots() {
  const roots = [];
  for (const vendor of readdirSync(vendorsRoot, { withFileTypes: true })) {
    const root = join(vendorsRoot, vendor.name);
    if (vendor.isDirectory() && modelRoots(root).length > 0) roots.push(root);
  }
  if (existsSync(personasRoot)) {
    for (const persona of readdirSync(personasRoot, { withFileTypes: true })) {
      const personaPath = join(personasRoot, persona.name, 'persona.json');
      if (!persona.isDirectory() || !existsSync(personaPath)) continue;
      const document = JSON.parse(readFileSync(personaPath, 'utf8'));
      if (document.asm?.package || typeof document.asm?.path !== 'string') continue;
      const root = dirname(personaPath);
      if (modelRoots(root).length > 0) roots.push(root);
    }
  }
  return roots.sort();
}

function selectedModelRoot(agentRoot) {
  const roots = modelRoots(agentRoot);
  if (roots.length === 0) throw new Error(`${agentRoot}: no authoring model`);
  const groundTruthPath = join(agentRoot, 'groundtruth.json');
  if (!existsSync(groundTruthPath)) return roots.at(-1);
  const document = loadGroundTruth(groundTruthPath);
  const selected = roots.find((root) => {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    return manifest.vendor === document.manifest.vendor && manifest.vendorVersion === document.manifest.vendorVersion;
  });
  if (!selected) {
    throw new Error(
      `${groundTruthPath}: no authoring model for ${document.manifest.vendor}@${document.manifest.vendorVersion}`,
    );
  }
  return selected;
}

export function canonicalJson(agentRoot) {
  const resolvedAgentRoot = resolve(agentRoot);
  return `${JSON.stringify(buildAgentGroundTruth(resolvedAgentRoot, selectedModelRoot(resolvedAgentRoot)), null, 2)}\n`;
}

/** Fold one versioned authoring model into its agent root's sole canonical file. */
export function writeGroundTruthArtifacts(modelRoot) {
  const { agentRoot, modelRoot: resolvedModelRoot } = agentRootForModel(modelRoot);
  const jsonPath = join(agentRoot, 'groundtruth.json');
  const document = buildAgentGroundTruth(agentRoot, resolvedModelRoot);
  writeFileSync(jsonPath, `${JSON.stringify(document, null, 2)}\n`);
  const htmlPath = join(agentRoot, 'groundtruth.html');
  writeFileSync(htmlPath, renderGroundTruth(document));
  return { jsonPath, htmlPath };
}

export function renderGroundTruthFile(jsonPath) {
  const htmlPath = join(dirname(jsonPath), `${basename(jsonPath, '.json')}.html`);
  writeFileSync(htmlPath, renderGroundTruth(loadGroundTruth(jsonPath)));
  return htmlPath;
}

export function checkGroundTruth(agentRoots = discoverGroundTruthRoots()) {
  const issues = [];
  for (const input of agentRoots) {
    const agentRoot = resolve(input);
    const allowedArtifacts = new Set([join(agentRoot, 'groundtruth.json'), join(agentRoot, 'groundtruth.html')]);
    for (const path of groundTruthArtifactsUnder(agentRoot)) {
      if (!allowedArtifacts.has(path)) issues.push(`${path}: canonical artifacts belong at the agent root`);
    }
    const jsonPath = join(agentRoot, 'groundtruth.json');
    if (!existsSync(jsonPath)) {
      issues.push(`${jsonPath}: missing canonical ground truth`);
      continue;
    }
    let expectedDocument;
    try {
      expectedDocument = buildAgentGroundTruth(agentRoot, selectedModelRoot(agentRoot));
    } catch (error) {
      issues.push((error instanceof Error ? error : new Error(String(error))).message);
      continue;
    }
    const expectedJson = `${JSON.stringify(expectedDocument, null, 2)}\n`;
    if (readFileSync(jsonPath, 'utf8') !== expectedJson) issues.push(`${jsonPath}: stale canonical ground truth`);
    const htmlPath = join(agentRoot, 'groundtruth.html');
    const expectedHtml = renderGroundTruth(expectedDocument);
    if (!existsSync(htmlPath)) issues.push(`${htmlPath}: missing visualization`);
    else if (readFileSync(htmlPath, 'utf8') !== expectedHtml) issues.push(`${htmlPath}: stale visualization`);
  }
  return issues;
}

function buildInputs(values) {
  if (!values.length) return discoverGroundTruthRoots().map((agentRoot) => selectedModelRoot(agentRoot));
  return values.map((value) => {
    const input = resolveInput(value);
    return existsSync(join(input, 'manifest.json')) ? input : selectedModelRoot(input);
  });
}

function checkInputs(values) {
  if (!values.length) return discoverGroundTruthRoots();
  return [
    ...new Set(
      values.map((value) => {
        const input = resolveInput(value);
        return existsSync(join(input, 'manifest.json')) ? agentRootForModel(input).agentRoot : input;
      }),
    ),
  ];
}

function resolveInput(value) {
  const fromWorkingDirectory = resolve(value);
  return existsSync(fromWorkingDirectory) ? fromWorkingDirectory : resolve(repositoryRoot, value);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const [maybeCommand, ...rest] = process.argv.slice(2);
  const command = commands.has(maybeCommand) ? maybeCommand : 'check';
  const values = (commands.has(maybeCommand) ? rest : process.argv.slice(2)).filter((value) => value !== '--');
  if (command === 'render') {
    const paths = values.length
      ? values.map(resolveInput)
      : discoverGroundTruthRoots().map((root) => join(root, 'groundtruth.json'));
    for (const path of paths) console.log(`wrote ${renderGroundTruthFile(path)}`);
  } else if (command === 'build') {
    for (const modelRoot of buildInputs(values)) {
      const written = writeGroundTruthArtifacts(modelRoot);
      console.log(`wrote ${written.jsonPath}`);
      console.log(`wrote ${written.htmlPath}`);
    }
  } else {
    const roots = checkInputs(values);
    const issues = checkGroundTruth(roots);
    if (issues.length) {
      console.error(`surface ground truth: ${issues.length} issue(s)`);
      for (const issue of issues) console.error(`  - ${issue}`);
      process.exit(1);
    }
    console.log(`surface ground truth: ${roots.length} canonical agents clean`);
  }
}
