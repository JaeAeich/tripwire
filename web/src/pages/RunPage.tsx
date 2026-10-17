import { useParams } from "react-router-dom";
import { useRun, useDocumentTitle } from "../lib/hooks";
import { ErrorNote, Loading } from "../components/bits";
import { EvalRun } from "./EvalRun";
import { AttributionRun } from "./AttributionRun";
import { AttackRun } from "./Attack";

export function RunPage() {
  const { id } = useParams();
  const run = useRun(id);
  useDocumentTitle(id ?? "");
  if (run.error && !run.data)
    return (
      <div className="view">
        <ErrorNote error={run.error} what={`run ${id}`} />
      </div>
    );
  if (!run.data)
    return (
      <div className="view">
        <Loading what="run" />
      </div>
    );
  if (run.data.kind === "eval") return <EvalRun run={run.data} />;
  if (run.data.kind === "attribute") return <AttributionRun run={run.data} />;
  if (run.data.kind === "attack") return <AttackRun run={run.data} />;
  return (
    <div className="view">
      <h1>{run.data.id}</h1>
      <p className="quiet">This run kind ({run.data.kind}) has no view yet.</p>
    </div>
  );
}
