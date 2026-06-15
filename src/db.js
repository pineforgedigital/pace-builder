import Dexie from 'dexie';

// -----------------------------------------------------------------------------
// Database Initialization
// -----------------------------------------------------------------------------
export const db = new Dexie('PaceBuilderDB');

db.version(1).stores({
  personnel: '++id, name, callSign',
  commsLocker: '++id, hardwareModel, frequency, band',
  pacePlans: '++id, scenarioType, dateCreated'
});

db.version(2).stores({
  locationCache: '++id, timestamp, latitude, longitude, accuracy, source'
});

db.version(3).stores({
  tacticalReports: '++id, timestamp, reportType'
});

db.version(4).stores({
  commsLocker: '++id, hardwareModel, frequency, supportedBand'
});

db.version(5).stores({
  personnel: '++id, name, callSign, role'
});

db.version(6).stores({
  globalSettings: 'key, value'
});

db.version(7).stores({
  mapFeatures: '++id, type, name, coordinates, timestamp'
});

export async function addMapFeature(feature) {
  feature.timestamp = Date.now();
  return await db.mapFeatures.add(feature);
}

export async function deleteMapFeature(id) {
  return await db.mapFeatures.delete(id);
}

export async function getAllMapFeatures() {
  return await db.mapFeatures.toArray();
}

export async function saveSetting(key, value) {
  return await db.globalSettings.put({ key, value });
}

export async function getSetting(key) {
  const record = await db.globalSettings.get(key);
  return record ? record.value : null;
}

// -----------------------------------------------------------------------------
// Disaster Scenario Enumerations
// -----------------------------------------------------------------------------
export const THREAT_SCENARIOS = Object.freeze([
  "Severe Weather (Tornado/Hurricane)",
  "Evacuation / Bug-Out (Wildfire/Flood)",
  "Grid-Down / Blackout",
  "Immediate Life Safety"
]);

// -----------------------------------------------------------------------------
// Data Access Layer: Personnel
// -----------------------------------------------------------------------------
export async function getAllPersonnel() {
  return await db.personnel.toArray();
}

export async function addPersonnel(person) {
  // Expected: name, callSign, phone, rendezvousPoint, role, bloodType, allergies, iceContact
  return await db.personnel.add(person);
}

export async function updatePersonnel(id, member) {
  return await db.personnel.update(id, member);
}

export async function deletePersonnel(id) {
  // Cascade delete from PACE plans
  const plans = await db.pacePlans.toArray();
  const updates = [];
  for (const plan of plans) {
    let modified = false;
    ['primarySlot', 'alternateSlot', 'contingencySlot', 'emergencySlot'].forEach(slot => {
      if (plan[slot] && plan[slot].personnelId === id) {
        plan[slot].personnelId = null;
        modified = true;
      }
    });
    if (modified) updates.push(db.pacePlans.put(plan));
  }
  await Promise.all(updates);
  return await db.personnel.delete(id);
}

// -----------------------------------------------------------------------------
// Data Access Layer: Comms Locker
// -----------------------------------------------------------------------------
export async function getAllRadios() {
  return await db.commsLocker.toArray();
}

export async function addRadio(radio) {
  // Expected radio shape: { hardwareModel, frequency, band, tones, powerOutput }
  return await db.commsLocker.add(radio);
}

export async function updateRadio(id, radio) {
  return await db.commsLocker.update(id, radio);
}

export async function deleteRadio(id) {
  // Cascade delete from PACE plans
  const plans = await db.pacePlans.toArray();
  const updates = [];
  for (const plan of plans) {
    let modified = false;
    ['primarySlot', 'alternateSlot', 'contingencySlot', 'emergencySlot'].forEach(slot => {
      if (plan[slot] && plan[slot].radioId === id) {
        plan[slot].radioId = null;
        modified = true;
      }
    });
    if (modified) updates.push(db.pacePlans.put(plan));
  }
  await Promise.all(updates);
  return await db.commsLocker.delete(id);
}

// -----------------------------------------------------------------------------
// Data Access Layer: PACE Plans
// -----------------------------------------------------------------------------
export async function getAllPlans() {
  return await db.pacePlans.toArray();
}

export async function getPlanById(id) {
  return await db.pacePlans.get(id);
}

export async function savePlan(plan) {
  // Expected plan shape: { planName, scenarioType, infrastructureStatus, primarySlot, alternateSlot, contingencySlot, emergencySlot, dateCreated }
  // If plan has an id, Dexie's put() acts as an upsert (update if exists, add if not).
  return await db.pacePlans.put(plan);
}

export async function deletePlan(id) {
  return await db.pacePlans.delete(id);
}

// -----------------------------------------------------------------------------
// Data Access Layer: Location Cache
// -----------------------------------------------------------------------------
export async function addLocationCache(entry) {
  return await db.locationCache.add(entry);
}

export async function getLatestLocationCache() {
  return await db.locationCache.orderBy('timestamp').last();
}

// -----------------------------------------------------------------------------
// Data Access Layer: Tactical Reports
// -----------------------------------------------------------------------------
export async function addTacticalReport(report) {
  return await db.tacticalReports.add(report);
}

export async function getAllTacticalReports() {
  return await db.tacticalReports.toArray();
}

// -----------------------------------------------------------------------------
// Data Portability
// -----------------------------------------------------------------------------
export async function exportDatabase() {
  const data = {
    personnel: await db.personnel.toArray(),
    commsLocker: await db.commsLocker.toArray(),
    pacePlans: await db.pacePlans.toArray(),
    locationCache: await db.locationCache.toArray(),
    tacticalReports: await db.tacticalReports.toArray()
  };
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pace_backup.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function importDatabase(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.personnel || !data.commsLocker || !data.pacePlans) {
          throw new Error("Invalid backup file format.");
        }
        await db.transaction('rw', db.personnel, db.commsLocker, db.pacePlans, db.locationCache, db.tacticalReports, async () => {
          await db.personnel.clear();
          await db.commsLocker.clear();
          await db.pacePlans.clear();
          await db.locationCache.clear();
          await db.tacticalReports.clear();
          
          if (data.personnel.length > 0) await db.personnel.bulkAdd(data.personnel);
          if (data.commsLocker.length > 0) await db.commsLocker.bulkAdd(data.commsLocker);
          if (data.pacePlans.length > 0) await db.pacePlans.bulkAdd(data.pacePlans);
          if (data.locationCache && data.locationCache.length > 0) await db.locationCache.bulkAdd(data.locationCache);
          if (data.tacticalReports && data.tacticalReports.length > 0) await db.tacticalReports.bulkAdd(data.tacticalReports);
        });
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}
