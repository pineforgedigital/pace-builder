import { db } from './db.js';

/**
 * Minifies a specific plan into a tight JSON string, stripping local IDs
 * and replacing them with the raw data for Air-Gap Handover.
 */
export async function generateHandoverPayload(planId) {
  const plan = await db.pacePlans.get(planId);
  if (!plan) throw new Error("Plan not found");

  const buildSlot = async (slotData) => {
    if (!slotData || !slotData.personnelId || !slotData.radioId) return null;
    const p = await db.personnel.get(slotData.personnelId);
    const r = await db.commsLocker.get(slotData.radioId);
    if (!p || !r) return null;
    
    // Minify the data structure for the QR code
    return {
      p: { n: p.name, c: p.callSign, ph: p.phone, rv: p.rendezvousPoint },
      r: { m: r.hardwareModel, f: r.frequency, b: r.band, t: r.tones, pw: r.powerOutput },
      n: slotData.notes || ''
    };
  };

  const payload = {
    v: 1, // version
    nm: plan.planName,
    sc: plan.scenarioType,
    is: plan.infrastructureStatus,
    pri: await buildSlot(plan.primarySlot),
    alt: await buildSlot(plan.alternateSlot),
    con: await buildSlot(plan.contingencySlot),
    emg: await buildSlot(plan.emergencySlot)
  };

  return JSON.stringify(payload);
}

// Basic sanitizer to strip HTML tags
function sanitizeString(str) {
  if (!str) return '';
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>?/gm, '');
}

/**
 * Validates the JSON schema and analyzes it for the Staging Modal.
 * Identifies how many records are new vs. matched to existing local data.
 */
export async function analyzePayload(jsonString) {
  let payload;
  try {
    payload = JSON.parse(jsonString);
    if (payload.v !== 1 || !payload.nm || typeof payload.nm !== 'string') {
      throw new Error("Invalid PACE QR Payload Format");
    }
  } catch (err) {
    throw new Error("Failed to parse QR payload: " + err.message);
  }

  const personnelMap = new Map(); // track by callSign
  const radioMap = new Map(); // track by model + frequency

  const extractSlot = (slotRaw) => {
    if (!slotRaw || !slotRaw.p || !slotRaw.r) return;
    if (slotRaw.p.c) personnelMap.set(slotRaw.p.c, slotRaw.p);
    if (slotRaw.r.m && slotRaw.r.f) radioMap.set(`${slotRaw.r.m}|${slotRaw.r.f}`, slotRaw.r);
  };

  extractSlot(payload.pri);
  extractSlot(payload.alt);
  extractSlot(payload.con);
  extractSlot(payload.emg);

  // Check Personnel Matches
  const localPersonnel = await db.getAllPersonnel();
  let newPersonnel = 0, matchedPersonnel = 0;
  for (const [callSign, _] of personnelMap.entries()) {
    const match = localPersonnel.find(p => p.callSign === callSign);
    if (match) matchedPersonnel++;
    else newPersonnel++;
  }

  // Check Radio Matches
  const localRadios = await db.getAllRadios();
  let newRadios = 0, matchedRadios = 0;
  for (const [key, _] of radioMap.entries()) {
    const [model, freq] = key.split('|');
    const match = localRadios.find(r => r.hardwareModel === model && r.frequency === freq);
    if (match) matchedRadios++;
    else newRadios++;
  }

  return {
    valid: true,
    payload, // Return validated object to pass to ingestion later
    planName: sanitizeString(payload.nm),
    stats: { newPersonnel, matchedPersonnel, newRadios, matchedRadios }
  };
}

/**
 * Merges the validated payload, binding matches and creating new records.
 */
export async function ingestHandoverPayload(payload) {

  const localPersonnel = await db.getAllPersonnel();
  const localRadios = await db.getAllRadios();

  const parseSlot = async (slotRaw) => {
    if (!slotRaw || !slotRaw.p || !slotRaw.r) return null;
    
    // 1. Deduplicate Personnel by Call Sign
    let pId = null;
    const pMatch = localPersonnel.find(p => p.callSign === slotRaw.p.c);
    if (pMatch) {
      pId = pMatch.id;
    } else {
      pId = await db.addPersonnel({
        name: sanitizeString(slotRaw.p.n),
        callSign: sanitizeString(slotRaw.p.c),
        phone: sanitizeString(slotRaw.p.ph),
        rendezvousPoint: sanitizeString(slotRaw.p.rv)
      });
      // update local array cache for subsequent slots in same payload
      localPersonnel.push({ id: pId, callSign: slotRaw.p.c });
    }

    // 2. Deduplicate Radio by Model + Freq
    let rId = null;
    const rMatch = localRadios.find(r => r.hardwareModel === slotRaw.r.m && r.frequency === slotRaw.r.f);
    if (rMatch) {
      rId = rMatch.id;
    } else {
      rId = await db.addRadio({
        hardwareModel: sanitizeString(slotRaw.r.m),
        frequency: sanitizeString(slotRaw.r.f),
        band: sanitizeString(slotRaw.r.b),
        tones: sanitizeString(slotRaw.r.t),
        powerOutput: sanitizeString(slotRaw.r.pw)
      });
      localRadios.push({ id: rId, hardwareModel: slotRaw.r.m, frequency: slotRaw.r.f });
    }

    return {
      personnelId: pId,
      radioId: rId,
      notes: sanitizeString(slotRaw.n)
    };
  };

  const newPlan = {
    planName: sanitizeString(payload.nm) + " (Imported)",
    scenarioType: sanitizeString(payload.sc),
    infrastructureStatus: sanitizeString(payload.is),
    dateCreated: new Date().toISOString(),
    primarySlot: await parseSlot(payload.pri),
    alternateSlot: await parseSlot(payload.alt),
    contingencySlot: await parseSlot(payload.con),
    emergencySlot: await parseSlot(payload.emg)
  };

  await db.savePlan(newPlan);
}
