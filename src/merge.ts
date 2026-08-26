// Line-based three-way merge (git style). Non-overlapping changes from both
// sides are always combined automatically. Overlapping changes are reported as
// conflicts; how they are written into the text depends on the resolution:
//   "detect" - a probe pass that only collects the conflicts (text unusable)
//   "mine"   - the local lines win, cleanly (no markers)
//   "theirs" - the remote lines win, cleanly (no markers)

export type Resolution = "detect" | "mine" | "theirs";

export interface MergeConflict {
  base: string[]; // common ancestor lines at this spot (may be empty)
  local: string[]; // our lines
  remote: string[]; // the other side's lines
}

export interface MergeResult {
  text: string;
  conflicts: MergeConflict[];
}

const MAX_CELLS = 4_000_000;

// Matched line index pairs between two line arrays (LCS).
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return []; // too large: treat as fully changed
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function mergeThreeWay(
  base: string,
  local: string,
  remote: string,
  resolution: Resolution = "detect",
): MergeResult {
  const b = base.length ? base.split("\n") : [];
  const l = local.split("\n");
  const r = remote.split("\n");

  const toLocal = new Map<number, number>(lcsPairs(b, l));
  const toRemote = new Map<number, number>(lcsPairs(b, r));

  // Stable anchors: base lines that survived unchanged in both sides.
  const anchors: number[] = [];
  for (let i = 0; i < b.length; i++) {
    if (toLocal.has(i) && toRemote.has(i)) anchors.push(i);
  }

  const out: string[] = [];
  const conflicts: MergeConflict[] = [];

  const emitChunk = (
    bStart: number,
    bEnd: number,
    lStart: number,
    lEnd: number,
    rStart: number,
    rEnd: number,
  ) => {
    const bc = b.slice(bStart, bEnd);
    const lc = l.slice(lStart, lEnd);
    const rc = r.slice(rStart, rEnd);
    const localChanged = !arrEq(bc, lc);
    const remoteChanged = !arrEq(bc, rc);
    if (!localChanged && !remoteChanged) out.push(...bc);
    else if (localChanged && !remoteChanged) out.push(...lc);
    else if (!localChanged && remoteChanged) out.push(...rc);
    else if (arrEq(lc, rc)) out.push(...lc);
    else {
      // Overlapping change: record it and write the chosen side cleanly.
      conflicts.push({ base: bc, local: lc, remote: rc });
      if (resolution === "theirs") out.push(...rc);
      else out.push(...lc); // "mine" and "detect" both keep local as the placeholder
    }
  };

  let prevBase = -1;
  let prevLocal = -1;
  let prevRemote = -1;
  for (const a of anchors) {
    const la = toLocal.get(a) as number;
    const ra = toRemote.get(a) as number;
    emitChunk(prevBase + 1, a, prevLocal + 1, la, prevRemote + 1, ra);
    out.push(b[a]);
    prevBase = a;
    prevLocal = la;
    prevRemote = ra;
  }
  emitChunk(prevBase + 1, b.length, prevLocal + 1, l.length, prevRemote + 1, r.length);

  return { text: out.join("\n"), conflicts };
}
