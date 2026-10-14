#!/usr/bin/env node
// Calendar sync: pulls iCal (.ics) feeds from Airbnb, VRBO, Google Calendar, etc.
// and writes ../availability.json, which the booking page reads.
//
// Usage:   node scripts/sync-availability.mjs
// Feeds:   edit scripts/calendars.json (a JSON array of .ics URLs), or set
//          ICAL_URLS="url1,url2" in the environment.
// Needs Node 18+. No dependencies.
//
// GoDaddy shared hosting is static, so run this on a schedule somewhere that can
// reach the internet (your computer's cron/launchd, or a free GitHub Action) and
// upload the resulting availability.json. See README.md.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.OUT || path.join(here, "availability.json");

async function feedUrls() {
  if (process.env.ICAL_URLS) return process.env.ICAL_URLS.split(",").map((s) => s.trim()).filter(Boolean);
  try { return JSON.parse(await readFile(path.join(here, "calendars.json"), "utf8")); }
  catch { return []; }
}

const toIso = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const addDay = (iso) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/); // unfold
  const events = []; let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur?.recurring) console.warn(`warn recurring event on ${cur.start} is not expanded; add each stay as its own event`);
      if (cur?.start) events.push(cur); cur = null;
    }
    else if (cur) {
      if (/^RRULE:/.test(line)) { cur.recurring = true; continue; }
      const m = line.match(/^(DTSTART|DTEND|STATUS)([^:]*):(.*)$/);
      if (!m) continue;
      if (m[1] === "STATUS") cur.cancelled = /CANCELLED/i.test(m[3]);
      else { const v = m[3].match(/^(\d{8})/); if (v) cur[m[1] === "DTSTART" ? "start" : "end"] = toIso(v[1]); }
    }
  }
  return events.filter((e) => !e.cancelled).map((e) => ({ start: e.start, end: e.end && e.end > e.start ? e.end : addDay(e.start) }));
}

const urls = await feedUrls();
if (!urls.length) { console.error("No calendar URLs. Add them to scripts/calendars.json or ICAL_URLS."); process.exit(1); }

const blocked = [];
for (const url of urls) {
  try {
    const res = await fetch(url.replace(/^webcal:/, "https:"));
    if (!res.ok) throw new Error(res.status);
    const evs = parseIcs(await res.text());
    blocked.push(...evs);
    console.log(`ok   ${evs.length} blocks  ${url.slice(0, 60)}…`);
  } catch (err) {
    console.error(`FAIL ${url.slice(0, 60)}… (${err.message}) — keeping previous availability.json`);
    process.exit(2); // don't overwrite good data with a partial sync
  }
}

blocked.sort((a, b) => a.start.localeCompare(b.start));
await writeFile(out, JSON.stringify({ updated: new Date().toISOString(), blocked }, null, 2) + "\n");
console.log(`Wrote ${blocked.length} blocked ranges to availability.json`);
