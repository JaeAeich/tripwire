// Word-level diff (LCS) for showing how a prompt part changed between versions.
export type Piece = { op: "same" | "del" | "ins"; text: string };

export function wordDiff(a: string, b: string): Piece[] {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  const n = A.length;
  const m = B.length;
  // lengths table, filled from the end
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: Piece[] = [];
  const push = (op: Piece["op"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push("same", A[i]);
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) push("del", A[i++]);
    else push("ins", B[j++]);
  }
  while (i < n) push("del", A[i++]);
  while (j < m) push("ins", B[j++]);
  return hunks(out);
}

/** Readable hunks: a run of changes (with only spaces between them) becomes all its deletions, then all its insertions. */
function hunks(ps: Piece[]): Piece[] {
  const out: Piece[] = [];
  let del = "";
  let ins = "";
  const flush = () => {
    if (del.trim()) out.push({ op: "del", text: del.trimEnd() });
    if (del.trim() && ins.trim()) out.push({ op: "same", text: " " });
    if (ins.trim()) out.push({ op: "ins", text: ins.trimEnd() });
    if (del.trim() || ins.trim()) out.push({ op: "same", text: " " });
    del = "";
    ins = "";
  };
  ps.forEach((p, k) => {
    const inHunk = del || ins;
    const nextIsChange = ps[k + 1] && ps[k + 1].op !== "same";
    if (p.op === "del") del += p.text;
    else if (p.op === "ins") ins += p.text;
    else if (inHunk && !p.text.trim() && nextIsChange) {
      del += p.text;
      ins += p.text;
    } else {
      flush();
      const last = out[out.length - 1];
      const text = last && last.op === "same" && last.text === " " ? p.text.replace(/^\s+/, "") : p.text;
      out.push({ op: "same", text });
    }
  });
  flush();
  return out;
}
