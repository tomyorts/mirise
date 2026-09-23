import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '矯正の転院とお金:中断時の精算・返金・資料の引き継ぎ';

export default function Image() {
  return ogImage({ title: '矯正の転院とお金:中断時の精算・返金・資料の引き継ぎ', kicker: '意思決定ガイド' });
}
