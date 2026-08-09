#!/usr/bin/env node
/**
 * inject-icons.js
 *
 * Usage:
 *   node scripts/inject-icons.js input.json output.json --mapping <mapping.json|local_dir|http_url> [--base-url <baseUrl>] [--field icon]
 *
 * Examples:
 *   node scripts/inject-icons.js momo.json momo.with-icons.json --mapping ./my-icons --base-url "https://raw.githubusercontent.com/se1vis/icons/main/icons"
 *   node scripts/inject-icons.js momo.json momo.with-icons.json --mapping ./icons.json
 *   node scripts/inject-icons.js momo.json momo.with-icons.json --mapping https://raw.githubusercontent.com/se1vis/icons/main/icons.json
 *
 * Notes:
 *  - If mapping is a local directory, the script will use filenames (without extension) as keys.
 *  - If --base-url is provided when mapping is a directory, icon URLs are constructed as `${baseUrl}/${encodeURIComponent(filename)}`.
 *  - Matching tries exact, case-insensitive, and a normalized "slug" form.
 */

const fs = require('fs');
const path = require('path');
const url = require('url');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('Usage: node scripts/inject-icons.js input.json output.json --mapping <mapping.json|local_dir|http_url> [--base-url <baseUrl>] [--field icon]');
  process.exit(2);
}
const inputPath = argv[0];
const outputPath = argv[1];

let mappingSrc = null;
let baseUrl = null;
let field = 'icon';

for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--mapping' && argv[i+1]) { mappingSrc = argv[++i]; continue; }
  if (argv[i] === '--base-url' && argv[i+1]) { baseUrl = argv[++i]; continue; }
  if (argv[i] === '--field' && argv[i+1]) { field = argv[++i]; continue; }
}

if (!mappingSrc) {
  console.error('Missing --mapping argument (path, dir, or URL).');
  process.exit(3);
}

function slugify(s) {
  if (!s) return '';
  return s.toString().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .toLowerCase()
    .replace(/[:@]/g, '') // remove some punctuation useful in names
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-') // keep latin/numbers/CJK, others -> -
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

async function loadMapping(src) {
  // local dir -> build mapping from filenames
  if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
    const files = fs.readdirSync(src).filter(f => /\.(png|jpg|jpeg|svg|webp|ico)$/i.test(f));
    const map = {};
    for (const f of files) {
      const name = path.basename(f, path.extname(f));
      const key1 = name;
      const key2 = name.toLowerCase();
      const key3 = slugify(name);
      let value;
      if (baseUrl) {
        const cleaned = baseUrl.replace(/\/+$/,'');
        value = `${cleaned}/${encodeURIComponent(f)}`;
      } else {
        value = path.resolve(src, f);
      }
      map[key1] = value;
      if (key2 !== key1) map[key2] = value;
      if (key3 !== key2 && key3 !== key1) map[key3] = value;
    }
    return map;
  }

  // local file?
  if (fs.existsSync(src) && fs.statSync(src).isFile()) {
    const content = fs.readFileSync(src, 'utf8');
    return JSON.parse(content);
  }

  // assume URL
  if (/^https?:\/\//.test(src)) {
    if (typeof fetch === 'undefined') {
      // node <18
      try {
        const nodeFetch = require('node-fetch');
        const res = await nodeFetch(src);
        if (!res.ok) throw new Error('Fetch failed: ' + res.status);
        return await res.json();
      } catch (e) {
        throw new Error('fetch not available and node-fetch failed: ' + e);
      }
    } else {
      const res = await fetch(src);
      if (!res.ok) throw new Error('Fetch failed: ' + res.status);
      return await res.json();
    }
  }

  throw new Error('Mapping source not found: ' + src);
}

function tryMatch(mapping, name) {
  if (!name) return null;
  const candidates = [];
  candidates.push(name);
  candidates.push(String(name).toLowerCase());
  candidates.push(slugify(name));

  // also try removing emoji and punctuation
  const stripped = String(name).replace(/[\p{Emoji_Presentation}\p{Emoji}\p{Extended_Pictographic}]/gu, '').trim();
  if (stripped && stripped !== name) {
    candidates.push(stripped);
    candidates.push(stripped.toLowerCase());
    candidates.push(slugify(stripped));
  }

  for (const c of candidates) {
    if (!c) continue;
    if (mapping[c]) return mapping[c];
  }

  // try partial contains: mapping key contains candidate or candidate contains mapping key
  for (const [k,v] of Object.entries(mapping)) {
    const kk = String(k).toLowerCase();
    const nn = String(name).toLowerCase();
    if (kk && nn && (kk.includes(nn) || nn.includes(kk))) return v;
  }

  return null;
}

function isCandidateObject(obj) {
  if (!obj || typeof obj !== 'object') return false;
  // common keys for proxies/groups in momo.json: name, tag, title, label
  const keys = ['name','tag','title','label','label_name','desc'];
  return keys.some(k => Object.prototype.hasOwnProperty.call(obj, k));
}

function walkAndInject(obj, mapping, stats) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const it of obj) walkAndInject(it, mapping, stats);
    return;
  }
  // If this object is a candidate (has name/tag/etc), try to inject
  if (isCandidateObject(obj)) {
    const keysToTry = [];
    if (obj.name) keysToTry.push(obj.name);
    if (obj.tag) keysToTry.push(obj.tag);
    if (obj.title) keysToTry.push(obj.title);
    if (obj.label) keysToTry.push(obj.label);
    // add other heuristics: some configs use 'proxy' or 'outbound' as name string
    if (obj.proxy) keysToTry.push(obj.proxy);
    if (obj.tag_name) keysToTry.push(obj.tag_name);

    let matched = null;
    let matchedKey = null;
    for (const k of keysToTry) {
      const m = tryMatch(mapping, k);
      if (m) { matched = m; matchedKey = k; break; }
    }

    // Sometimes the object has no name but has a 'proxies' array (proxy-groups)
    // For these, use the object's tag or other identifying keys above; already covered.

    if (matched) {
      obj[field] = matched;
      stats.count += 1;
      stats.injected.push({ which: matchedKey, url: matched });
    } else {
      // not matched: record candidate for user to map later
      const candidateName = keysToTry.find(Boolean) || JSON.stringify(obj).slice(0,60);
      stats.missing.add(candidateName);
    }
  }

  // continue walking
  for (const k of Object.keys(obj)) {
    try {
      walkAndInject(obj[k], mapping, stats);
    } catch (e) {
      // ignore
    }
  }
}

(async () => {
  try {
    const mapping = await loadMapping(mappingSrc);
    // mapping keys normalization: ensure object keys as-is plus lower+slug exist
    const normMap = {};
    for (const [k,v] of Object.entries(mapping)) {
      normMap[k] = v;
      normMap[String(k).toLowerCase()] = v;
      normMap[slugify(k)] = v;
    }

    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const stats = { count: 0, injected: [], missing: new Set() };

    walkAndInject(input, normMap, stats);

    fs.writeFileSync(outputPath, JSON.stringify(input, null, 2), 'utf8');

    console.log('Wrote', outputPath);
    console.log('Injected icons:', stats.count);
    if (stats.injected.length) {
      console.log('Examples of injected:');
      for (const e of stats.injected.slice(0,10)) {
        console.log('  ', e.which, '->', e.url);
      }
    }
    if (stats.missing.size) {
      console.log('Candidates not matched (add to your mapping):');
      for (const m of Array.from(stats.missing).slice(0,40)) {
        console.log('  ', m);
      }
      console.log('Total unmatched candidates:', stats.missing.size);
    } else {
      console.log('All found or none candidates present.');
    }

  } catch (e) {
    console.error('Error:', e.message || e);
    process.exit(4);
  }
})();