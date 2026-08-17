import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "顎間固定中の生活:期間はどのくらい?食事・会話・睡眠・仕事はどうなるか";

export default function Image() {
  return ogImage({ title: "顎間固定中の生活:期間はどのくらい?食事・会話・睡眠・仕事はどうなるか", kicker: '難症例・外科矯正' });
}
