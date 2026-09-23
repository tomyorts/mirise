import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '矯正歯科の選び方:広告ではなく「診断の質」を見る7つの視点';

export default function Image() {
  return ogImage({ title: '矯正歯科の選び方:広告ではなく「診断の質」を見る7つの視点', kicker: '意思決定ガイド' });
}
