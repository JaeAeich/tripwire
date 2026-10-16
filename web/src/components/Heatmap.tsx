import { Link } from "react-router-dom";
import { pct, pts } from "../lib/format";
import { compareHref } from "../lib/routes";
import type { Cell, Role, Rule } from "../lib/types";

const ROLE_WORD: Record<Role, string> = {
  culprit: "causes it to break (clear)",
  "load-bearing": "holds the promise up (clear)",
  unclear: "no clear effect",
};

function fill(c: Cell): string {
  const mag = Math.min(1, Math.abs(c.delta));
  if (c.role === "culprit") return `color-mix(in srgb, var(--accent) ${Math.round(18 + 40 * mag)}%, transparent)`;
  if (c.role === "load-bearing") return `color-mix(in srgb, var(--cool) ${Math.round(16 + 36 * mag)}%, transparent)`;
  return `color-mix(in srgb, var(--soft) ${Math.round(3 + 10 * mag)}%, transparent)`;
}

const clamp = (x: number) => Math.max(-1, Math.min(1, x));

export function cellLabel(c: Cell, rule?: Rule) {
  return `${c.section} × ${c.rule}${rule ? ` ${rule.title}` : ""}: violations ${pct(c.base_rate)} with the full prompt, ${pct(
    c.ablated_rate,
  )} without ${c.section}. Change ${pts(c.delta)} points, 95% interval ${pts(clamp(c.ci[0]))} to ${pts(
    clamp(c.ci[1]),
  )}. ${ROLE_WORD[c.role]}.`;
}

export function Heatmap({
  runId,
  matrix,
  sections,
  rules,
  ruleIds,
}: {
  runId: string;
  matrix: Cell[];
  sections: string[];
  rules: Record<string, Rule>;
  ruleIds: string[];
}) {
  const at = (s: string, r: string) => matrix.find((m) => m.section === s && m.rule === r);
  return (
    <div className="heatmap-wrap">
      <table className="heatmap">
        <caption className="sr">
          Change in violation rate when each prompt section is removed. Rows are prompt parts, columns are promises.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="hm-corner">
              <span className="quiet">part \ promise</span>
            </th>
            {ruleIds.map((r) => (
              <th key={r} scope="col" title={rules[r]?.text}>
                <span className="mono">{r}</span>
                <span className="hm-rule-title">{rules[r]?.title ?? ""}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map((s) => (
            <tr key={s}>
              <th scope="row">{s}</th>
              {ruleIds.map((r) => {
                const c = at(s, r);
                if (!c)
                  return (
                    <td key={r} className="hm-empty">
                      <span aria-label="not measured">·</span>
                    </td>
                  );
                return (
                  <td key={r}>
                    <Link
                      to={compareHref(runId, s, r)}
                      className={`hm-cell role-${c.role}`}
                      style={{ background: fill(c) }}
                      aria-label={cellLabel(c, rules[r])}
                    >
                      <span className="hm-delta">
                        {Math.round(c.base_rate * 100)}→{pct(c.ablated_rate)}
                      </span>
                      <span className="hm-tip" role="tooltip">
                        <span className="hm-tip-row">
                          <span>full prompt</span>
                          <b>{pct(c.base_rate)}</b>
                        </span>
                        <span className="hm-tip-row">
                          <span>without {s}</span>
                          <b>{pct(c.ablated_rate)}</b>
                        </span>
                        <span className="hm-tip-row">
                          <span>95% interval</span>
                          <b>
                            {pts(clamp(c.ci[0]))} to {pts(clamp(c.ci[1]))}
                          </b>
                        </span>
                        <span className="hm-tip-row">
                          <span>trials</span>
                          <b>
                            {c.n[0]} / {c.n[1]}
                          </b>
                        </span>
                        <span className={`hm-tip-role role-${c.role}`}>{ROLE_WORD[c.role]}</span>
                      </span>
                    </Link>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="legend" aria-label="Legend">
        <li>
          <span className="swatch role-culprit" /> causes it to break: the promise breaks less without it
        </li>
        <li>
          <span className="swatch role-load-bearing" /> holds it up: the promise breaks more without it
        </li>
        <li>
          <span className="swatch role-unclear" /> no clear effect (could be noise)
        </li>
        <li className="quiet">cells: % broken with the full prompt → without the section</li>
      </ul>
    </div>
  );
}
