// Lines of a camera's remote log (CameraLogCard)

const keyOf = (l) => `${new Date(l.at).getTime()}|${l.tag || ''}|${l.msg}`;

/**
 * New lines into the list: duplicates dropped (the stream and the fallback check may bring the same line), oldest
 * first, at most `max` kept (the newest).
 */
export function mergeLogLines(existing, incoming, max = 3000) {
  const seen = new Set(existing.map(keyOf));
  const added = [];
  for (const l of incoming || []) {
    if (!l || typeof l.msg !== 'string') continue;
    const k = keyOf(l);
    if (seen.has(k)) continue;
    seen.add(k);
    added.push(l);
  }
  if (!added.length) return existing;
  const all = existing.concat(added);
  const last = existing[existing.length - 1];
  // Usually the new lines come after the old ones: sort only when they do not
  if (last && added.some(l => new Date(l.at) < new Date(last.at))) {
    all.sort((a, b) => new Date(a.at) - new Date(b.at));
  }
  return all.length > max ? all.slice(all.length - max) : all;
}
