export type DisclosureProps = {
  treatmentName: string;
  cost: string;
  duration: string;
  insuranceNote: string;
  risks: string[];
  unapprovedDeviceNote?: string;
};

// 自由診療の定型ブロック(限定解除要件対応: docs/media/04 チェックB)
// 費用はdisclosureマスタから渡す。折りたたみ・縮小表示は禁止。
export default function DisclosureBlock(p: DisclosureProps) {
  return (
    <section className="disclosure-block">
      <h2>この治療の費用・期間・リスクについて</h2>
      <dl>
        <dt>治療名</dt>
        <dd>{p.treatmentName}</dd>
        <dt>費用の目安(税込)</dt>
        <dd>{p.cost}</dd>
        <dt>標準的な期間・回数</dt>
        <dd>{p.duration}</dd>
        <dt>公的医療保険の適用</dt>
        <dd>{p.insuranceNote}</dd>
        <dt>主なリスク・副作用</dt>
        <dd>
          <ul>
            {p.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          治療効果・経過には個人差があります。
        </dd>
        {p.unapprovedDeviceNote && (
          <>
            <dt>未承認医療機器に関する事項</dt>
            <dd>{p.unapprovedDeviceNote}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
