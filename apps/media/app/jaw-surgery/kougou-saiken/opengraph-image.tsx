import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '咬合再建とは:すり減った・崩れた噛み合わせを作り直す治療';

export default function Image() {
  return ogImage({ title: '咬合再建とは:すり減った・崩れた噛み合わせを作り直す治療', kicker: '難症例・外科矯正' });
}
