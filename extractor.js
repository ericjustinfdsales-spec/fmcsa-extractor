// ===== extractor.js =====
// Run FMCSA scraping headlessly (no Chrome needed). Designed for GitHub Actions or any server.
// Node >= 18 (global fetch available).
// Reads MCs from mc_list.txt (one per line). Outputs CSV to ./output/fmcsa_batch_<timestamp>.csv
// Config via env vars: CONCURRENCY=6 DELAY=300 BATCH_SIZE=500 WAIT_SECONDS=0 MODE=both|urls


import fs from 'fs';
import path from 'path';


// ---- Config ----
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const DELAY = Number(process.env.DELAY || 300); // ms between waves
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 500);
const WAIT_SECONDS = Number(process.env.WAIT_SECONDS || 0);
const MODE = String(process.env.MODE || 'both'); // 'both' or 'urls'


const EXTRACT_TIMEOUT_MS = 20000;
const FETCH_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;


const INPUT_FILE = path.resolve('mc_list.txt');
const OUTPUT_DIR = path.resolve('output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });


function now(){ return new Date().toISOString(); }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }


function mcToSnapshotUrl(mc){
const m = String(mc||'').replace(/\s+/g,'');
return `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=MC_MX&query_string=${encodeURIComponent(m)}`;
}


function absoluteUrl(base, href){
try { return new URL(href, base).href; } catch { return href; }
}


async function fetchWithTimeout(url, ms, opts={}){
const ctrl = new AbortController();
const id = setTimeout(()=>ctrl.abort(), ms);
try{
const resp = await fetch(url, { ...opts, signal: ctrl.signal });
return resp;
} finally { clearTimeout(id); }
}


async function fetchRetry(url, tries=MAX_RETRIES, timeout=FETCH_TIMEOUT_MS, label='fetch'){
let lastErr;
for (let i=0;i<tries;i++){
try{
const resp = await fetchWithTimeout(url, timeout, { redirect: 'follow' });
if (!resp.ok) throw new Error(`${label} HTTP ${resp.status}`);
return await resp.text();
}catch(err){
lastErr = err;
const backoff = BACKOFF_BASE_MS * Math.pow(2,i);
console.log(`[${now()}] ${label} attempt ${i+1}/${tries} failed → ${err && err.message}. Backoff ${backoff}ms`);
await sleep(backoff);
}
}
throw lastErr || new Error(`${label} failed`);
}


function htmlToText(s){
if (!s) return '';
return s.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
}


function extractPhoneAnywhere(html){
const m = html.match(/\(?\d{3}\)?[\s\-.]*\d{3}[\s\-.]*\d{4}/);
return m ? m[0] : '';
}


async function extractOne(url){
const timer = setTimeout(()=>{ throw new Error('Extraction timed out'); }, EXTRACT_TIMEOUT_MS);
try{
const html = await fetchRetry(url, MAX_RETRIES, FETCH_TIMEOUT_MS, 'snapshot');


// MC number
let mcNumber = '';
const pats = [
/MC[-\s]?(\d{3,7})/i,
/MC\/MX\/FF Number\(s\):\s*MC[-\s]?(\d{3,7})/i,
/MC\/MX Number:\s*MC[-\s]?(\d{3,7})/i,
/MC\/MX Number:\s*(\d{3,7})/i,
];
for (const p of pats){ const m = html.match(p); if (m && m[1]) { mcNumber = 'MC-' + m[1]; break; } }
if (!mcNumber){ const any = html.match(/MC[-\s]?(\d{3,7})/i); if (any && any[1]) mcNumber = 'MC-' + any[1]; }


// Phone guess from snapshot
let phone = extractPhoneAnywhere(html);
run().catch(e=>{ console.error('Fatal:', e); process.exit(1); });
