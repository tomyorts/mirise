import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '抜歯矯正と非抜歯矯正の判断基準:スペース分析でここまで分かる';

export default function Image() {
  return ogImage({ title: '抜歯矯正と非抜歯矯正の判断基準:スペース分析でここまで分かる', kicker: '治療法を知る' });
}
