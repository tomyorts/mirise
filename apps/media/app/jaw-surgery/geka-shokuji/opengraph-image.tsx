import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '顎の手術後の食事と生活:顎間固定中の栄養と回復の実際';

export default function Image() {
  return ogImage({ title: '顎の手術後の食事と生活:顎間固定中の栄養と回復の実際', kicker: '難症例・外科矯正' });
}
