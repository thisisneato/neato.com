// Builds sitemap.xml from scratch on every run, so nothing needs updating by hand.
//
//  - WHICH URLs:  whatever Framer has live, read from neato.com/sitemap.xml
//                 (new pages and posts show up automatically, unpublished ones drop out)
//  - BLOG DATES:  later of the post's "Date" field and its last CMS edit
//  - /blog DATE:  newest blog post date
//  - OTHER PAGES: date carried over from the previous sitemap.xml; a page seen for
//                 the first time gets that day's date. To bump a page after a real
//                 change, add it to sitemap-overrides.json, e.g. {"/how-2p-works": "2026-10-13"}
//
// Also writes blog-updates.json, same as the old fetch script.

import { connect } from "framer-api";
import { existsSync, readFileSync, writeFileSync } from "fs";

const SITE = "https://neato.com";
const LIVE_SITEMAP_URL = process.env.LIVE_SITEMAP_URL || `${SITE}/sitemap.xml`;
const OUTPUT_FILE = "sitemap.xml";
const OVERRIDES_FILE = "sitemap-overrides.json";
const DATE_FIELD_NAME = "Date";

// Live pages that should NOT be in the sitemap (paths, no trailing slash).
const EXCLUDE = new Set(["/test", "/justynehometest", "/contact-na3", "/nacs"]);

// Safety net: if Framer's sitemap or the CMS comes back short, stop instead of
// committing a sitemap with pages missing.
const MIN_LIVE_URLS = 50;
const MIN_POSTS = 10;

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const latest = (...dates) => dates.filter(Boolean).sort().pop() || null;
const today = new Date().toISOString().slice(0, 10);

const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const pathOf = (url) => {
  const p = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, "");
  return p === "" ? "/" : p;
};
const urlOf = (path) => (path === "/" ? `${SITE}/` : `${SITE}${path}`);

function readLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => unescapeXml(m[1]));
}

function readPreviousDates() {
  const dates = new Map();
  if (!existsSync(OUTPUT_FILE)) return dates;
  const xml = readFileSync(OUTPUT_FILE, "utf8");
  for (const m of xml.matchAll(/<url>\s*<loc>\s*([^<]+?)\s*<\/loc>\s*<lastmod>\s*([^<]+?)\s*<\/lastmod>/g)) {
    dates.set(pathOf(unescapeXml(m[1])), day(m[2]));
  }
  return dates;
}

function readOverrides() {
  if (!existsSync(OVERRIDES_FILE)) return {};
  return JSON.parse(readFileSync(OVERRIDES_FILE, "utf8"));
}

async function fetchBlogPosts() {
  const framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY);
  try {
    const collection = await framer.getCollection(process.env.FRAMER_BLOG_COLLECTION_ID);
    if (!collection) {
      throw new Error(
        "Blog collection not found for FRAMER_BLOG_COLLECTION_ID. " +
        "Run the discovery workflow again if you need to re-check the id."
      );
    }

    let dateFieldId = null;
    try {
      const fields = await collection.getFields();
      dateFieldId = fields.find((f) => f.name === DATE_FIELD_NAME && f.type === "date")?.id ?? null;
    } catch {
      // Fall back to updatedAt only.
    }
    if (!dateFieldId) console.warn(`No "${DATE_FIELD_NAME}" field found; using last-edited dates only.`);

    const items = await collection.getItems();
    return items
      .filter((item) => !item.draft)
      .map((item) => {
        const raw = dateFieldId ? item.fieldData?.[dateFieldId] : null;
        const date = raw && typeof raw === "object" ? raw.value : raw;
        return {
          slug: item.slug,
          date: date || null,
          createdAt: item.createdAt || null,
          updatedAt: item.updatedAt || null,
        };
      });
  } finally {
    await framer.disconnect();
  }
}

async function fetchLiveUrls() {
  const res = await fetch(LIVE_SITEMAP_URL, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`Couldn't load ${LIVE_SITEMAP_URL}: HTTP ${res.status}`);
  const locs = readLocs(await res.text());
  if (locs.length < MIN_LIVE_URLS) {
    throw new Error(`${LIVE_SITEMAP_URL} only listed ${locs.length} URLs; not writing a new sitemap.`);
  }
  return locs;
}

const [posts, liveUrls] = await Promise.all([fetchBlogPosts(), fetchLiveUrls()]);
if (posts.length < MIN_POSTS) {
  throw new Error(`Framer returned only ${posts.length} published posts; not writing a new sitemap.`);
}

writeFileSync(
  "blog-updates.json",
  JSON.stringify({ posts, fetchedAt: new Date().toISOString() }, null, 2) + "\n"
);

const postDates = new Map(posts.map((p) => [p.slug, latest(day(p.date), day(p.updatedAt))]));
const newestPost = latest(...postDates.values());
const previous = readPreviousDates();
const overrides = readOverrides();

const entries = [];
for (const path of new Set(liveUrls.map(pathOf))) {
  if (EXCLUDE.has(path)) continue;

  let lastmod;
  if (path.startsWith("/blog/") && postDates.has(path.slice(6))) {
    lastmod = postDates.get(path.slice(6));
  } else if (path === "/blog") {
    lastmod = newestPost;
  } else {
    lastmod = overrides[path] || previous.get(path) || today;
  }
  entries.push({ path, lastmod });
}

// Stable order so the file only changes when content does:
// home, other pages A–Z, then blog posts newest first.
const isPost = (e) => e.path.startsWith("/blog/");
entries.sort((a, b) => {
  if (a.path === "/") return -1;
  if (b.path === "/") return 1;
  if (isPost(a) !== isPost(b)) return isPost(a) ? 1 : -1;
  if (isPost(a) && a.lastmod !== b.lastmod) return a.lastmod < b.lastmod ? 1 : -1;
  return a.path < b.path ? -1 : 1;
});

// Built line by line: nothing can end up before the XML declaration.
const lines = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...entries.map(
    (e) => `<url><loc>${escapeXml(urlOf(e.path))}</loc><lastmod>${e.lastmod}</lastmod></url>`
  ),
  "</urlset>",
];
const xml = lines.join("\n") + "\n";

if (!xml.startsWith("<?xml")) throw new Error("Generated sitemap doesn't start with <?xml");
writeFileSync(OUTPUT_FILE, xml);

const before = new Set(previous.keys());
const after = new Set(entries.map((e) => e.path));
const added = [...after].filter((p) => !before.has(p));
const removed = [...before].filter((p) => !after.has(p));
console.log(`Wrote ${OUTPUT_FILE}: ${entries.length} URLs (${posts.length} published posts in Framer).`);
if (added.length) console.log(`Added: ${added.join(", ")}`);
if (removed.length) console.log(`Removed: ${removed.join(", ")}`);