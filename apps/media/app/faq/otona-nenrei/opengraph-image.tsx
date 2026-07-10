import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '大人の矯正に年齢の上限はありますか?';

export default function Image() {
  return ogImage({ title: '大人の矯正に年齢の上限はありますか?', kicker: 'よくある質問' });
}
