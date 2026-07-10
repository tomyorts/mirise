import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '開咬(前歯が閉じない)の原因別治療法:舌癖・歯性・骨格性';

export default function Image() {
  return ogImage({ title: '開咬(前歯が閉じない)の原因別治療法:舌癖・歯性・骨格性', kicker: '難症例・外科矯正' });
}
