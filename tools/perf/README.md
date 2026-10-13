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
| Report data, all widgets, 30 days | 1.3 s | 0.4 s |
| Report data, all widgets, 12 months | 1.6 s | 0.6 s |
| Overview | 0.4 s | 0.2 s |
| Insights, 30 days | 0.7 s | 0.3 s |

Each photo now stores its pest count (`Snapshot.pestCount`, kept in step with `aiResults.summary` and filled in for older photos in the background after start-up). The alarm-status filter reads it instead of adding up every photo's summary, and the hourly activity reads it straight from the `{ deviceSerial, pestCount, createdAt }` index without opening the photos. Long report ranges step through hundreds of days per camera and species, so day-key arithmetic is cached (`dailyStats.addDays`), and photo hours are worked out with the farm's fixed UTC+7 offset rather than `Intl` formatting. Timings vary with the machine, so compare runs on the same machine.
