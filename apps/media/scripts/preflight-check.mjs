// 公開前の総点検(ビルド後の out/ を検査)。
// 1. 内部リンク切れ 2. sitemapの網羅 3. OGP画像メタの有無 4. title/description重複
// ビルドには組み込まず、必要時に `node scripts/preflight-check.mjs` で実行する。
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';

const OUT = join(process.cwd(), 'out');
const BASE = '/media';
const htmls = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') && htmls.push(p);
  }
})(OUT);
// 404ページはsitemap非掲載・タイトル共通が正しい挙動なので検査対象外
const isErrorPage = (f) => /(^|\/)404(\.html|\/index\.html)$/.test(relative(OUT, f));

let fail = 0;
const warn = (msg) => { console.log('  ⚠ ' + msg); fail++; };

// 1. 内部リンク
console.log('■ 内部リンク切れ');
const seen = new Set();
for (const f of htmls) {
  const html = readFileSync(f, 'utf8');
  for (const m of html.matchAll(/href="(\/media\/[^"#?]*)/g)) {
    const path = m[1];
    if (seen.has(path)) continue;
    seen.add(path);
    const rel = path.slice(BASE.length).replace(/\/$/, '');
    const target = rel.includes('.') ? join(OUT, rel) : join(OUT, rel, 'index.html');
    if (!existsSync(target)) warn(`リンク切れ: ${path} (初出: ${relative(OUT, f)})`);
  }
}
console.log(`  検査したユニークリンク: ${seen.size}`);

// 2. sitemap網羅
console.log('■ sitemap の網羅');
const sitemap = readFileSync(join(OUT, 'sitemap.xml'), 'utf8');
const smPaths = new Set([...sitemap.matchAll(/<loc>[^<]*?(\/media\/[^<]*?)<\/loc>/g)].map((m) => m[1]));
const pagePaths = htmls
  .filter((f) => f.endsWith('index.html') && !isErrorPage(f))
  .map((f) => BASE + '/' + relative(OUT, f).replace(/index\.html$/, ''))
  .map((p) => p.replace(/\/+$/, '/'));
for (const p of pagePaths) {
  const bare = p.replace(/\/$/, '') + '/';
  if (!smPaths.has(bare) && !smPaths.has(p)) warn(`sitemap に無いページ: ${p}`);
}
console.log(`  ページ ${pagePaths.length} 件 / sitemap ${smPaths.size} 件`);

// 3. OGP
console.log('■ OGP画像メタ');
for (const f of htmls) {
  if (!f.endsWith('index.html') || isErrorPage(f)) continue;
  const html = readFileSync(f, 'utf8');
  if (!/property="og:image"/.test(html)) warn(`og:image が無い: ${relative(OUT, f)}`);
}

// 4. title/description の重複
console.log('■ title / description の重複');
const titles = new Map();
const descs = new Map();
for (const f of htmls) {
  if (!f.endsWith('index.html') || isErrorPage(f)) continue;
  const html = readFileSync(f, 'utf8');
  const t = html.match(/<title>([^<]*)<\/title>/)?.[1];
  const d = html.match(/name="description" content="([^"]*)"/)?.[1];
  const r = relative(OUT, f);
  if (t) titles.has(t) ? warn(`title重複: "${t.slice(0, 40)}…" (${titles.get(t)} / ${r})`) : titles.set(t, r);
  if (d) descs.has(d) ? warn(`description重複: (${descs.get(d)} / ${r})`) : descs.set(d, r);
}

console.log(fail === 0 ? '\n✅ preflight: 問題なし' : `\n❌ preflight: ${fail} 件の指摘`);
process.exit(fail === 0 ? 0 : 1);
