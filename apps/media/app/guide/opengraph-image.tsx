import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '意思決定ガイド';

export default function Image() {
  return ogImage({ title: '矯正治療の意思決定ガイド', kicker: '意思決定ガイド' });
}
