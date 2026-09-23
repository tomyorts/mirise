import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// サイト既定のOGP画像(記事・カテゴリで上書きされない全ページの共有カード)。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'キョウセイの前に|矯正治療の意思決定ガイド';

export default function Image() {
  return ogImage({
    title: '矯正治療を「始める前」「決める前」に、\n知っておくべきことを専門医が整理します。',
    kicker: '矯正治療の意思決定支援メディア',
  });
}
