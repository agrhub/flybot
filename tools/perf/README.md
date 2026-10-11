# API benchmark

`benchmark.js` fills an in-memory MongoDB with generated data and times the heavier API calls. Nothing external is used: the server runs with the test helpers (`server/tests/dbHelpers.js`).

```bash
# cameras, days of photos (every 30 minutes, 06:00-18:00)
node benchmark.js 40 180
```

MongoDB keeps its files in the temp folder while the benchmark runs (about 1 GB for 40 cameras over 180 days). On a nearly full system drive, point `TMP`/`TEMP` elsewhere.

## Results, 40 cameras over 180 days (about 180,000 photos), median of 3 runs

| Call | Before | After |
|---|---|---|
| History, alarm status filter, 90 days | 2.0 s | 0.4 s |
| History, alarm status filter, all time | 4.7 s | 0.3 s |
| Report data, all widgets, 30 days | 1.3 s | 0.6 s |
| Report data, all widgets, 12 months | 1.6 s | 1.4 s |
| Overview | 0.4 s | 0.2 s |
| Insights, 30 days | 0.7 s | 0.6 s |

Each photo now stores its pest count (`Snapshot.pestCount`, kept in step with `aiResults.summary` and filled in for older photos by a startup migration). The alarm-status filter and the hourly activity read it instead of adding up every photo's summary. Timings vary with the machine, so compare runs on the same machine.
