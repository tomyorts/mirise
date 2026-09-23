// 医療広告ガイドライン観点の表現リント(レポートモード)。
// ビルド後の out/ 全HTMLを走査し、リスクのある表現を文脈付きで列挙する。
// 否定文脈(「絶対安全とは言えません」等)の正当な使用もあり得るため、
// 機械では落とさず、ヒットを人間(編集者・監修者)が確認する運用。
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const OUT = join(process.cwd(), 'out');
const PATTERNS = [
  ['効果の保証', /必ず(治|改善|きれい|よくな|成功)/g],
  ['安全の断定', /絶対(に)?(安全|治|成功)/g],
  ['否定形の保証', /(後戻り|痛み|失敗)(は)?(しません|ありません|ございません)/g],
  ['最上級・優良誤認', /(最先端|日本一|No\.?1(?![0-9])|ナンバーワン|唯一の|最高の|最良の|最も(優れ|効果)|世界初|地域で一番)/g],
  ['比較優良', /他院(より|と比べ|に比べ)/g],
  ['未出典の実績数値', /(満足度|成功率|治癒率)\s*[0-9九八七六五四三二一〇十百]+/g],
  ['自院への誘導', /当院/g],
  ['安易さの強調', /(簡単に|すぐに|楽に)治/g],
];

const htmls = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    statSync(p).isDirectory() ? walk(p) : p.endsWith('index.html') && htmls.push(p);
  }
})(OUT);

const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '');

let hits = 0;
for (const f of htmls) {
  const text = strip(readFileSync(f, 'utf8'));
  const page = relative(OUT, f).replace(/\/?index\.html$/, '') || '(top)';
  for (const [label, re] of PATTERNS) {
    // 運営者情報・相談窓口ページの「当院」は運営元開示として正当(記事本文のみ検査)
    if (label === '自院への誘導' && /^(about|consult)(\/|$)/.test(page)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const ctx = text.slice(Math.max(0, m.index - 28), m.index + m[0].length + 28).replace(/\s+/g, ' ');
      console.log(`[${label}] /${page}/\n    …${ctx}…`);
      hits++;
    }
  }
}
console.log(hits === 0 ? '\n✅ compliance-lint: ヒットなし' : `\n⚠ compliance-lint: ${hits} 件(文脈を確認してください。否定・注意喚起の文脈は問題ありません)`);
