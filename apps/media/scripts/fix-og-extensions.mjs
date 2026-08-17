// ビルド後処理: メタデータ規約で生成されるOGP画像は拡張子なしのファイル
// (out/**/opengraph-image)として出力される。Apache/WordPressのサブディレクトリ配信では
// 拡張子がないと image/png として配信されないため、.png にリネームし、
// HTML内の参照(og:image / twitter:image)も .png へ書き換える。
import { readdirSync, statSync, renameSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const OUT = join(process.cwd(), 'out');

function walk(dir, cb) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, cb);
    else cb(p, name);
  }
}

let renamed = 0;
let htmlPatched = 0;

walk(OUT, (p, name) => {
  if (name === 'opengraph-image' || name === 'twitter-image') {
    renameSync(p, `${p}.png`);
    renamed++;
  }
});

walk(OUT, (p, name) => {
  if (!name.endsWith('.html')) return;
  const src = readFileSync(p, 'utf8');
  // 「opengraph-image」「twitter-image」の直後(? または ")の前に .png を差し込む
  const next = src
    .replace(/(opengraph-image)(\?|")/g, '$1.png$2')
    .replace(/(twitter-image)(\?|")/g, '$1.png$2');
  if (next !== src) {
    writeFileSync(p, next);
    htmlPatched++;
  }
});

console.log(`fix-og-extensions: renamed ${renamed} image files, patched ${htmlPatched} html files`);
