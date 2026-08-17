import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '受け口は矯正だけで治せるか:骨格性と歯性の見分け方';

export default function Image() {
  return ogImage({ title: '受け口は矯正だけで治せるか:骨格性と歯性の見分け方', kicker: '難症例・外科矯正' });
}
