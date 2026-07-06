export type Author = {
  id: string;
  name: string;
  title: string;
  qualifications: string[];
  bio: string;
  sameAs: string[]; // researchmap・学会・公式サイトプロフィール等(エンティティ確立: docs/media/06)
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
  },
};
