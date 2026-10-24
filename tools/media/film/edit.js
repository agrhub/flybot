// The edit of the screen recordings: for each recorded scene, the takes it shows (record-app.mjs, media/rec/<shot>),
// in order. from: second of the take to start at; dur: seconds of film (the last clip takes what is left);
// speed: take seconds per film second; zoom: [film second in the clip, centre x, centre y, scale] in page pixels
// (1920 x 1080), eased between keys. badges: chips over the window (guest, owner, sim).
export const EDIT = {
    guest: {
        badges: ['guest'],
        clips: [{ shot: 'guest-login', from: 7.8, speed: 1.5, zoom: [[0, 960, 600, 1.8], [5.2, 960, 600, 1.8], [6.6, 960, 540, 1]] }]
    },
    dashboard: {
        badges: ['guest', 'sim'],
        clips: [{ shot: 'dashboard', from: 14, speed: 1.75, zoom: [[0, 960, 540, 1], [3, 900, 600, 1.25], [15, 900, 600, 1.25]] }]
    },
    cameras: {
        badges: ['guest', 'sim'],
        clips: [{ shot: 'cameras', from: 14, speed: 6 }]
    },
    sticky: {
        badges: ['guest', 'sim'],
        clips: [{ shot: 'sticky-photo', from: 41, speed: 2.5, zoom: [[0, 960, 540, 1], [8.5, 960, 540, 1], [10, 790, 360, 1.7], [13, 790, 360, 1.7]] }]
    },
    trace: {
        badges: ['guest', 'sim'],
        // The overview, then the trace list once loaded (the wait in between is cut)
        clips: [
            { shot: 'sentinel-trace', from: 8, dur: 2.5, speed: 3 },
            { shot: 'sentinel-trace', from: 25, speed: 2.8 }
        ]
    },
    approve: {
        badges: ['guest', 'sim'],
        clips: [{ shot: 'approvals', from: 2, speed: 1.1, zoom: [[0, 960, 540, 1], [3, 1000, 560, 1.3], [12, 1000, 620, 1.3]] }]
    },
    assistant: {
        badges: ['guest'],
        // The question typed and sent, then (after the wait, cut) the answer
        clips: [
            { shot: 'assistant', from: 21, dur: 6, speed: 1.6, zoom: [[0, 1450, 640, 1.25], [6, 1450, 640, 1.25]] },
            { shot: 'assistant', from: 36.2, speed: 0.4, zoom: [[0, 1700, 420, 1.8], [8, 1700, 420, 1.8]] }
        ]
    },
    esp32: {
        badges: ['owner'],
        clips: [
            { shot: 'esp32-live', from: 100, dur: 8, speed: 1 },
            { shot: 'camera-log', from: 3, dur: 3.5, speed: 1.5 },
            { shot: 'firmware', from: 4, speed: 3 }
        ]
    },
    mapreports: {
        badges: ['guest', 'sim'],
        clips: [
            { shot: 'map', from: 6, dur: 5, speed: 2 },
            // The click on the weekly report, then the report with its figures (the load in between is cut)
            { shot: 'reports', from: 13, dur: 1.2, speed: 2 },
            { shot: 'reports', from: 42.5, speed: 2 }
        ]
    }
};
