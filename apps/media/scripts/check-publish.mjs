// ビルド後の安全チェック(公開事故の防止)。
// 「公開(検索エンジンの対象)」になっているページに、未確定を表す
// ◯◯ や「要確認」が残っていたらビルドを失敗させる。
// これにより、数値を入れ忘れたまま記事が公開されることを防ぐ。
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const OUT = join(process.cwd(), 'out');
const PLACEHOLDER = /[◯○●]|要確認/;

function walk(dir, cb) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    (statSync(p).isDirectory() ? walk(p, cb) : cb(p));
  }
}

const offenders = [];
walk(OUT, (p) => {
  if (!p.endsWith('.html')) return;
  const html = readFileSync(p, 'utf8');
  // noindex が付いていない = 公開(インデックス対象)。robotsメタで判定。
  const isIndexable = !/name="robots"[^>]*content="[^"]*noindex/i.test(html);
  if (isIndexable && PLACEHOLDER.test(html)) {
    offenders.push(relative(OUT, p));
  }
});

if (offenders.length > 0) {
  console.error('\n❌ 公開チェック失敗: 未確定(◯◯ または「要確認」)が残ったまま公開設定になっているページがあります。');
  console.error('   content/review.ts で該当記事の数値を確定するか、publish を false に戻してください。\n');
  offenders.forEach((f) => console.error('   - ' + f));
  console.error('');
  process.exit(1);
}
console.log(`check-publish: OK(公開ページに未確定の数値なし。検査 ${OUT} 配下のHTML)`);
