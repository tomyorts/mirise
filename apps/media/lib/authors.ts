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

// TODO: ローンチ前に実名・資格・外部プロフィールURLを確定する(名義と実態の一致が必須)
export const AUTHORS: Record<string, Author> = {
  director: {
    id: 'director',
    name: '院長(氏名確定待ち)',
    title: 'ミライズ矯正歯科南青山 院長・歯科医師',
    qualifications: ['歯科医師', '(認定資格・所属学会を確定して記載)'],
    bio: '矯正歯科・顎変形症・外科矯正・サージェリーファースト・デジタル矯正・咬合再建を専門とする。(経歴を確定して記載)',
    sameAs: [],
    specialties: [
      '顎変形症・外科的矯正治療',
      'サージェリーファースト',
      'デジタル矯正・3Dシミュレーション',
      '咬合再建・再治療',
    ],
    career: [
      '(卒業大学・取得年を確定して記載)',
      '(勤務歴・研鑽歴を確定して記載)',
      'ミライズ矯正歯科南青山 院長',
    ],
  },
};

export function getAuthor(id: string): Author | undefined {
  return AUTHORS[id];
}
