export type Author = {
  id: string;
  name: string;
  title: string;
  qualifications: string[];
  bio: string;
  sameAs: string[]; // researchmap・学会・公式サイトプロフィール等(エンティティ確立: docs/media/06)
  specialties?: string[]; // 専門領域(E-E-A-Tプロフィール表示用)
  career?: string[]; // 経歴(監修時に確定)
};

// 監修者情報は医院公式サイト staff ページ(mirise-ortho.com/staff/)より取得。
// 公開時は掲載内容と本人による最終確認をもって確定とする。
export const AUTHORS: Record<string, Author> = {
  director: {
    id: 'director',
    name: '富田大介',
    title: 'ミライズ矯正歯科南青山 院長・歯科医師',
    qualifications: [
      '歯科医師',
      '公益社団法人 日本矯正歯科学会 認定医・代議員',
      '特定非営利活動法人 日本顎変形症学会 認定医(矯正歯科)',
      '東京科学大学(旧東京医科歯科大学)大学院 医歯学総合研究科 咬合機能矯正学分野 非常勤講師',
      'Stanford University Visiting Instructor(客員講師)',
    ],
    bio: '富田大介。ミライズ矯正歯科南青山 院長。昭和大学歯学部を卒業後、東京医科歯科大学大学院(咬合機能矯正学分野)で研鑽を積み、大学病院・総合医療センターで顎変形症や外科的矯正治療に従事。日本矯正歯科学会 認定医、日本顎変形症学会 認定医(矯正歯科)。サージェリーファースト、デジタル矯正・3Dシミュレーション、咬合再建を専門とする。',
    sameAs: [
      'https://uit.stanford.edu/service/techtraining/instructors/daisuke-tomita',
    ],
    specialties: [
      '顎変形症・外科的矯正治療',
      'サージェリーファースト',
      'デジタル矯正・3Dシミュレーション',
      '咬合再建・再治療',
    ],
    career: [
      '東京都出身',
      '昭和大学(現・昭和医科大学)歯学部 卒業(2004年)',
      '東京医科歯科大学大学院 医歯学総合研究科 咬合機能矯正学分野 専攻課程修了(2008年)',
      '元 東京医科歯科大学 歯学部附属病院 矯正歯科外来 医長補佐',
      '元 横浜市立大学附属市民総合医療センター 歯科・口腔外科・矯正歯科 常勤特別職指導診療医',
      'ハーバード大学医学大学院 Executive Education 修了(2023年)',
      '東京科学大学(旧東京医科歯科大学)大学院 咬合機能矯正学分野 非常勤講師',
      'ミライズ矯正歯科南青山 院長 / ミライズウェルメディカルグループ 代表',
    ],
  },
};

export function getAuthor(id: string): Author | undefined {
  return AUTHORS[id];
}
