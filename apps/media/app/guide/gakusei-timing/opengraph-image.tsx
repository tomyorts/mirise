import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "中高生・大学生の矯正はいつ始める?受験・就活・手術との両立とタイミング設計";

export default function Image() {
  return ogImage({ title: "中高生・大学生の矯正はいつ始める?受験・就活・手術との両立とタイミング設計", kicker: '意思決定ガイド' });
}
