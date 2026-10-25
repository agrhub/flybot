/**
 * A camera shared with visitors (guest, demo access) carries what the administrator opened to them
 * (camera.demo: live, playback, location, device, realSerial). Every other camera allows it all.
 */
export const demoAllows = (camera, what) => !camera?.demo || camera.demo[what] !== false;

/** A visitor's demo camera whose device details are open: they read them, change nothing. */
export const showsDemoDevice = (camera) => camera?.access === 'demo' && !camera?.simulated && !!camera?.demo?.device;
