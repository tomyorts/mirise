import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'マウスピース矯正で受け口(骨格性)は治りますか?';

export default function Image() {
  return ogImage({ title: 'マウスピース矯正で受け口(骨格性)は治りますか?', kicker: 'よくある質問' });
}
