// 治療の「流れ」を視覚化する工程フロー図(縦タイムライン)。
// 本文で既に述べた工程・目安を図解するための表示専用コンポーネント。
// 新たな臨床的主張は持たせない(数値は本文・監修に従う)。
export type FlowStep = { label: string; note?: string };

export default function ProcessFlow({
  steps,
  title,
  caption,
}: {
  steps: FlowStep[];
  title?: string;
  caption?: string;
}) {
  return (
    <figure className="proc-flow">
      {title && <p className="proc-flow-title">{title}</p>}
      <ol className="proc-steps">
        {steps.map((s, i) => (
          <li className="proc-step" key={i}>
            <span className="proc-num" aria-hidden="true">
              {i + 1}
            </span>
            <span className="proc-body">
              <span className="proc-label">{s.label}</span>
              {s.note && <span className="proc-note">{s.note}</span>}
            </span>
          </li>
        ))}
      </ol>
      {caption && <figcaption className="proc-cap">{caption}</figcaption>}
    </figure>
  );
}
