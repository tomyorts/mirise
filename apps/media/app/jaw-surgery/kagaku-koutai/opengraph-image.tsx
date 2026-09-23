import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "下顎後退(顎が小さい・引っこんでいる)の治療|矯正でできることと手術が検討される場合";

export default function Image() {
  return ogImage({ title: "下顎後退(顎が小さい・引っこんでいる)の治療|矯正でできることと手術が検討される場合", kicker: '難症例・外科矯正' });
}
