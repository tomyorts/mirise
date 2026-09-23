import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '外科矯正の全体像:手術までの流れ・入院期間・仕事復帰の目安';

export default function Image() {
  return ogImage({ title: '外科矯正の全体像:手術までの流れ・入院期間・仕事復帰の目安', kicker: '難症例・外科矯正' });
}
