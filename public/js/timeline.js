// Maps between the source recording's timeline and the edited output timeline.
// Transcript, chapters and blur regions are stored against the source timeline so
// edits (trim / cuts) can change freely without re-transcribing. Shared by server and browser.
(function (root) {
  function keepSegments(edits, sourceDuration) {
    const dur = Number(sourceDuration) || Infinity;
    const start = Math.max(0, Number(edits?.trimStart) || 0);
    const end = Math.min(dur, Number(edits?.trimEnd) || dur);
    const cuts = (edits?.cuts || [])
      .map(([a, b]) => [Math.max(start, Number(a)), Math.min(end, Number(b))])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    const keeps = [];
    let cursor = start;
    for (const [a, b] of cuts) {
      if (a > cursor) keeps.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (end > cursor) keeps.push([cursor, end]);
    // Drop slivers that would produce zero-length segments in ffmpeg.
    return keeps.filter(([a, b]) => b - a >= 0.05);
  }

  function toOutput(t, keeps) {
    let offset = 0;
    for (const [a, b] of keeps) {
      if (t >= a && t <= b) return offset + (t - a);
      if (t < a) return null;
      offset += b - a;
    }
    return null;
  }

  function toSource(t, keeps) {
    let offset = 0;
    for (const [a, b] of keeps) {
      const len = b - a;
      if (t <= offset + len) return a + (t - offset);
      offset += len;
    }
    const last = keeps[keeps.length - 1];
    return last ? last[1] : t;
  }

  const isNoEdit = (keeps, sourceDuration) => keeps.length === 1 && keeps[0][0] === 0
    && (!Number.isFinite(keeps[0][1]) || Math.abs(keeps[0][1] - (Number(sourceDuration) || Infinity)) < 0.05);

  const api = { keepSegments, toOutput, toSource, isNoEdit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FCTimeline = api;
})(typeof window !== 'undefined' ? window : globalThis);
