import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '矯正のやり直し(再治療)を考えたら:後戻りの原因と再出発の進め方';

export default function Image() {
  return ogImage({ title: '矯正のやり直し(再治療)を考えたら:後戻りの原因と再出発の進め方', kicker: '難症例・外科矯正' });
}
