import { addLocationCache } from './db.js';

let backgroundInterval = null;
const PING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function initLocationEngine() {
  if (!navigator.geolocation) {
    console.debug('Background GPS Ping Failed: Geolocation API not supported by this browser.');
    return;
  }

  // Attempt an initial ping immediately
  attemptPing();

  // Set up the recurring interval
  backgroundInterval = setInterval(attemptPing, PING_INTERVAL_MS);
}

function attemptPing() {
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      try {
        await addLocationCache({
          timestamp: position.timestamp || Date.now(),
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          source: 'auto-ping'
        });
        console.debug('Background GPS Ping Successful');
      } catch (err) {
        console.debug('Background GPS Ping Failed: Could not write to database.', err);
      }
    },
    (error) => {
      console.debug('Background GPS Ping Failed', error);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    }
  );
}

export function stopLocationEngine() {
  if (backgroundInterval) {
    clearInterval(backgroundInterval);
    backgroundInterval = null;
  }
}
