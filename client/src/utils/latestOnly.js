/**
 * For a loader that can run again before its last call answered: each call gets a check that
 * is true only while it is the latest call, so an older, slower response is dropped.
 *   const track = latestOnly();
 *   const isLatest = track(); const res = await api...; if (!isLatest()) return;
 */
export function latestOnly() {
  let latest = 0;
  return () => {
    const mine = ++latest;
    return () => mine === latest;
  };
}
