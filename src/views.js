import * as db from './db.js';
import { generatePacePDF, generateReportPDF } from './pdfEngine.js';
import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';
import { generateHandoverPayload, analyzePayload, ingestHandoverPayload } from './qrEngine.js';
import L from 'leaflet';
import html2canvas from 'html2canvas';

export function getBandFromFrequency(freqStr) {
  if (typeof freqStr !== 'string') return 'UNKNOWN';
  const cleaned = freqStr.replace(/[^0-9.]/g, '');
  if (!cleaned || cleaned.split('.').length > 2) return 'UNKNOWN';
  
  const val = parseFloat(cleaned);
  if (isNaN(val)) return 'UNKNOWN';
  
  if (val >= 1.8 && val <= 30.0) return 'HF';
  if (val >= 136.0 && val <= 174.0) return 'VHF';
  if (val >= 400.0 && val <= 480.0) return 'UHF';
  return 'UNKNOWN';
}

function downloadCSV(filename, dataArray, headers) {
  if (!dataArray || dataArray.length === 0) {
    window.sysAlert("No data available to export.");
    return;
  }
  
  let csvContent = headers.join(',') + '\n';
  
  dataArray.forEach(row => {
    let rowValues = headers.map(header => {
      let cell = row[header] === undefined || row[header] === null ? '' : row[header].toString();
      cell = cell.replace(/"/g, '""');
      if (cell.search(/("|,|\n)/g) >= 0) {
        cell = `"${cell}"`;
      }
      return cell;
    });
    csvContent += rowValues.join(',') + '\n';
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- Cleanup Mechanism ---
let activeListeners = [];
function addCleanupListener(element, type, handler) {
  element.addEventListener(type, handler);
  activeListeners.push({ element, type, handler });
}
function cleanupListeners() {
  for (const { element, type, handler } of activeListeners) {
    element.removeEventListener(type, handler);
  }
  activeListeners = [];
}

// --- Dashboard ---
export async function renderDashboard(container) {
  cleanupListeners();
  container.innerHTML = `<h2>Loading Dashboard...</h2>`;
  
  const personnel = await db.getAllPersonnel();
  const radios = await db.getAllRadios();
  const plans = await db.getAllPlans();
  
  // Operational Readiness Engine
  let alertsHtml = '';
  const flaggedPlans = plans.filter(p => !p.primarySlot?.radioId || !p.alternateSlot?.radioId || !p.contingencySlot?.radioId || !p.emergencySlot?.radioId);
  if (flaggedPlans.length > 0) {
    alertsHtml = flaggedPlans.map(p => `
      <div class="badge-warning compliance-card">
        <span class="compliance-header"><i data-lucide="alert-triangle" class="tactical-icon-lg"></i> <strong>Warning:</strong> '${p.planName}' is missing fallbacks.</span>
        <button class="btn btn-secondary nav-jump compliance-action" data-target="plans">Review Plan</button>
      </div>
    `).join('');
    alertsHtml = `<div class="alerts-container">${alertsHtml}</div>`;
  }

  // Recent Plans
  const recentPlans = [...plans].sort((a, b) => new Date(b.dateCreated) - new Date(a.dateCreated)).slice(0, 3);
  let recentPlansHtml = '<p class="empty-state-text">No plans created yet.</p>';
  if (recentPlans.length > 0) {
    recentPlansHtml = `
      <table>
        <thead>
          <tr>
            <th>Plan Name</th>
            <th>Scenario</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${recentPlans.map(p => {
            let badgeClass = 'badge-stable';
            const infra = (p.infrastructureStatus || '').toLowerCase();
            if (infra.includes('compromised') || infra.includes('down')) badgeClass = 'badge-critical';
            else if (infra.includes('repeater') || infra.includes('degraded')) badgeClass = 'badge-warning';
            
            return `
              <tr>
                <td><strong>${p.planName}</strong></td>
                <td>${p.scenarioType}</td>
                <td><span class="badge ${badgeClass}">${p.infrastructureStatus || 'OK'}</span></td>
                <td><button type="button" class="btn btn-secondary export-pdf-btn" data-id="${p.id}"><i data-lucide="download" class="tactical-icon-sm"></i> Export</button></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  container.innerHTML = `
    <h2>Dashboard</h2>
    ${alertsHtml}
    
    <div class="grid-2">
      <div class="panel panel-accent">
        <h3>Asset Overview</h3>
        <div class="metric-grid">
          <div class="metric-card nav-jump" data-target="comms">
            <i data-lucide="radio" class="tactical-icon-lg metric-icon"></i>
            <span class="metric-value">${radios.length}</span>
            <span class="metric-label">Radios</span>
          </div>
          <div class="metric-card nav-jump" data-target="personnel">
            <i data-lucide="users" class="tactical-icon-lg metric-icon"></i>
            <span class="metric-value">${personnel.length}</span>
            <span class="metric-label">Personnel</span>
          </div>
          <div class="metric-card nav-jump" data-target="plans">
            <i data-lucide="file-text" class="tactical-icon-lg metric-icon"></i>
            <span class="metric-value">${plans.length}</span>
            <span class="metric-label">Plans</span>
          </div>
        </div>
        
        <h3 style="margin-top: 2rem;">Quick Actions</h3>
        <div class="quick-actions-col">
          <button class="btn btn-secondary nav-jump" data-target="personnel">Manage Personnel</button>
          <button class="btn btn-secondary nav-jump" data-target="comms">Manage Comms</button>
          <button class="btn btn-primary nav-jump" data-target="plans">Create PACE Plan</button>
        </div>
      </div>
      
      <div class="panel panel-accent">
        <h3>Recent Active Plans</h3>
        ${recentPlansHtml}
      </div>
    </div>
    
    <div class="panel">
      <h3>Data Portability & Handover</h3>
      <div class="portability-actions">
        <button class="btn btn-secondary" id="btn-scan-qr"><i data-lucide="scan" class="tactical-icon"></i> Scan Handover</button>
      </div>
    </div>

    <!-- QR Scan Modal -->
    <dialog id="modal-qr-scan">
      <h3>Scan Air-Gap Handover</h3>
      <p class="dialog-subtitle">Scan a PACE Builder QR Code to securely import the plan and its operational assets.</p>
      <div id="qr-reader" class="scanner-container"></div>
      <div class="dialog-actions">
        <button type="button" class="btn cancel-btn" id="btn-cancel-scan">Cancel Scan</button>
      </div>
    </dialog>
    
    <!-- Staging Modal -->
    <dialog id="modal-qr-staging">
      <h3>Incoming Payload Staging</h3>
      <div id="staging-content" class="staging-content-wrapper"></div>
      <div class="dialog-actions">
        <button type="button" class="btn cancel-btn" id="btn-cancel-staging">Cancel Import</button>
        <button type="button" class="btn btn-primary" id="btn-confirm-import">Import Plan</button>
      </div>
    </dialog>
  `;
  
  container.querySelectorAll('.nav-jump').forEach(btn => {
    addCleanupListener(btn, 'click', (e) => {
      // Need to find the closest button in case icon is clicked
      const target = e.target.closest('.nav-jump').getAttribute('data-target');
      document.querySelector(`nav a[data-target="${target}"]`).click();
    });
  });

  // Export PDF Buttons on Dashboard
  container.querySelectorAll('.export-pdf-btn').forEach(btn => {
    addCleanupListener(btn, 'click', async (e) => {
      const actualBtn = e.target.closest('.export-pdf-btn');
      const planId = parseInt(actualBtn.getAttribute('data-id'));
      actualBtn.textContent = 'Exporting...';
      actualBtn.disabled = true;
      try {
        await generatePacePDF(planId);
      } catch (error) {
        console.error("PDF Generation failed:", error);
        window.sysAlert("Failed to generate PDF. Check console.");
      } finally {
        actualBtn.innerHTML = '<i data-lucide="download" class="tactical-icon-sm"></i> Export';
        actualBtn.disabled = false;
        if (window.lucide) window.lucide.createIcons();
      }
    });
  });



  // Scanner & Staging Logic
  const btnScanQR = container.querySelector('#btn-scan-qr');
  const modalScanQR = container.querySelector('#modal-qr-scan');
  const btnCancelScan = container.querySelector('#btn-cancel-scan');
  
  const modalStaging = container.querySelector('#modal-qr-staging');
  const stagingContent = container.querySelector('#staging-content');
  const btnCancelStaging = container.querySelector('#btn-cancel-staging');
  const btnConfirmImport = container.querySelector('#btn-confirm-import');
  
  let html5QrCode = null;
  let currentValidatedPayload = null;

  const stopScanner = async () => {
    if (html5QrCode && html5QrCode.isScanning) {
      try { await html5QrCode.stop(); } catch (err) { console.warn(err); }
    }
    modalScanQR.close();
  };

  addCleanupListener(btnScanQR, 'click', () => {
    modalScanQR.showModal();
    html5QrCode = new Html5Qrcode("qr-reader");
    html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      async (decodedText) => {
        // Success callback
        await stopScanner();
        try {
          const analysis = await analyzePayload(decodedText);
          currentValidatedPayload = analysis.payload;
          
          stagingContent.innerHTML = `
            <p><strong>Plan Name:</strong> ${analysis.planName}</p>
            <div class="staging-stats-card">
              <p class="staging-stats-header"><strong>Personnel Integration:</strong><br>
              <span class="text-success">${analysis.stats.newPersonnel} New</span> | 
              <span class="text-warning">${analysis.stats.matchedPersonnel} Matched</span></p>
              
              <p class="staging-stats-header no-margin"><strong>Hardware Integration:</strong><br>
              <span class="text-success">${analysis.stats.newRadios} New</span> | 
              <span class="text-warning">${analysis.stats.matchedRadios} Matched</span></p>
            </div>
            <p class="staging-disclaimer">
              *Matched records will be bound to your existing database via Call Sign and Hardware Frequencies to prevent duplicates.
            </p>
          `;
          modalStaging.showModal();
        } catch (err) {
          window.sysAlert(err.message);
        }
      },
      (errorMessage) => {
        console.warn(`QR Scanner Network/Hardware Alert: ${errorMessage}`);
      }
    ).catch(err => {
      console.error(err);
      window.sysAlert("Unable to access camera.");
      modalScanQR.close();
    });
  });

  addCleanupListener(btnCancelScan, 'click', async () => {
    await stopScanner();
  });
  
  addCleanupListener(btnCancelStaging, 'click', () => {
    modalStaging.close();
    currentValidatedPayload = null;
  });
  
  addCleanupListener(btnConfirmImport, 'click', async () => {
    if (!currentValidatedPayload) return;
    try {
      await ingestHandoverPayload(currentValidatedPayload);
      modalStaging.close();
      currentValidatedPayload = null;
      window.sysAlert("PACE Plan successfully imported!");
      renderDashboard(container); // Refresh to show new plan
    } catch (err) {
      console.error(err);
      window.sysAlert("Error during ingestion: " + err.message);
    }
  });
}

// --- Personnel Roster ---
export async function renderPersonnel(container) {
  cleanupListeners();
  
  const personnel = await db.getAllPersonnel();
  
  let tableHtml = '';
  if (personnel.length === 0) {
    tableHtml = `
      <div class="empty-state empty-state-box">
        <p class="empty-state-text">No personnel records found. Add operators to begin building your operational roster.</p>
        <button type="button" class="btn btn-primary cta-add-personnel">+ Add New Member</button>
      </div>
    `;
  } else {
    let tableRows = personnel.map(p => {
      const roleClass = `role-${(p.role || 'other').toLowerCase().replace(' ', '-')}`;
      return `
      <tr>
        <td><strong>${p.name}</strong><br><span class="role-badge ${roleClass}">${p.role || 'Other'}</span></td>
        <td><span class="badge badge-stable">${p.callSign}</span></td>
        <td>${p.phone || 'N/A'}<br><small>ICE: ${p.iceContact || 'N/A'}</small></td>
        <td>${p.bloodType || 'UNKNOWN'}<br><small>Allergies: ${p.allergies || 'None'}</small></td>
        <td>
          <button class="btn btn-secondary btn-edit-personnel btn-sm" data-id="${p.id}" style="margin-right: 5px;">Edit</button>
          <button class="btn btn-danger btn-delete-personnel btn-sm" data-id="${p.id}">Delete</button>
        </td>
      </tr>
      `;
    }).join('');
    
    tableHtml = `
      <table>
        <thead>
          <tr>
            <th>Name & Role</th>
            <th>Call Sign</th>
            <th>Comms & ICE</th>
            <th>Medical</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    `;
  }

  container.innerHTML = `
    <h2>Personnel Roster</h2>
    <div class="panel">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
        <h3 style="margin: 0;">Saved Members</h3>
        ${personnel.length > 0 ? '<button class="btn btn-secondary btn-sm" id="btn-export-personnel"><i data-lucide="download"></i> Export CSV</button>' : ''}
      </div>
      ${tableHtml}
    </div>
    
    <div class="panel">
      <h3>Add New Member</h3>
      <form id="form-personnel">
        <div class="grid-2">
          <div class="form-group"><label>Name</label><input type="text" id="p-name" required></div>
          <div class="form-group"><label>Call Sign</label><input type="text" id="p-callsign" required></div>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label>Role / Billet</label>
            <select id="p-role" required>
              <option value="Team Lead">Team Lead</option>
              <option value="Medic">Medic</option>
              <option value="RTO">RTO</option>
              <option value="Scout">Scout</option>
              <option value="Rifleman">Rifleman</option>
              <option value="Other">Other</option>
            </select>
          </div>
          <div class="form-group">
            <label>Blood Type</label>
            <select id="p-blood">
              <option value="UNKNOWN">UNKNOWN</option>
              <option value="O-POS">O-POS</option>
              <option value="O-NEG">O-NEG</option>
              <option value="A-POS">A-POS</option>
              <option value="A-NEG">A-NEG</option>
              <option value="B-POS">B-POS</option>
              <option value="B-NEG">B-NEG</option>
              <option value="AB-POS">AB-POS</option>
              <option value="AB-NEG">AB-NEG</option>
            </select>
          </div>
        </div>
        <div class="grid-2">
          <div class="form-group"><label>Phone</label><input type="text" id="p-phone"></div>
          <div class="form-group"><label>ICE Contact</label><input type="text" id="p-ice"></div>
        </div>
        <div class="grid-2">
          <div class="form-group"><label>Allergies</label><input type="text" id="p-allergies" placeholder="e.g., NKA"></div>
          <div class="form-group"><label>Rendezvous Point</label><input type="text" id="p-rv"></div>
        </div>
        <button type="submit" class="btn btn-primary" id="btn-submit-personnel">Save Member</button>
      </form>
    </div>
  `;

  const form = container.querySelector('#form-personnel');
  addCleanupListener(form, 'submit', async (e) => {
    e.preventDefault();
    const editId = form.dataset.editId ? parseInt(form.dataset.editId) : null;
    const pData = {
      name: document.getElementById('p-name').value,
      callSign: document.getElementById('p-callsign').value,
      role: document.getElementById('p-role').value,
      bloodType: document.getElementById('p-blood').value,
      phone: document.getElementById('p-phone').value,
      iceContact: document.getElementById('p-ice').value,
      allergies: document.getElementById('p-allergies').value,
      rendezvousPoint: document.getElementById('p-rv').value
    };
    
    if (editId) {
      await db.updatePersonnel(editId, pData);
      delete form.dataset.editId;
    } else {
      await db.addPersonnel(pData);
    }
    renderPersonnel(container); // Re-render
  });

  container.querySelectorAll('.btn-delete-personnel').forEach(btn => {
    addCleanupListener(btn, 'click', async (e) => {
      const id = parseInt(e.target.getAttribute('data-id'));
      if (await window.sysConfirm('Delete this person? This will safely remove them from any existing PACE plans.')) {
        await db.deletePersonnel(id);
        renderPersonnel(container);
      }
    });
  });

  container.querySelectorAll('.btn-edit-personnel').forEach(btn => {
    addCleanupListener(btn, 'click', async (e) => {
      const id = parseInt(e.target.getAttribute('data-id'));
      const person = personnel.find(p => p.id === id);
      if (person) {
        document.getElementById('p-name').value = person.name || '';
        document.getElementById('p-callsign').value = person.callSign || '';
        document.getElementById('p-role').value = person.role || 'Other';
        document.getElementById('p-blood').value = person.bloodType || 'UNKNOWN';
        document.getElementById('p-phone').value = person.phone || '';
        document.getElementById('p-ice').value = person.iceContact || '';
        document.getElementById('p-allergies').value = person.allergies || '';
        document.getElementById('p-rv').value = person.rendezvousPoint || '';
        
        form.dataset.editId = id;
        const submitBtn = document.getElementById('btn-submit-personnel');
        submitBtn.textContent = 'Update Member';
        submitBtn.classList.add('pulse');
        setTimeout(() => submitBtn.classList.remove('pulse'), 1000);
        form.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  const ctaBtn = container.querySelector('.cta-add-personnel');
  if (ctaBtn) {
    addCleanupListener(ctaBtn, 'click', () => {
      document.getElementById('p-name').focus();
    });
  }

  const exportBtn = container.querySelector('#btn-export-personnel');
  if (exportBtn) {
    addCleanupListener(exportBtn, 'click', () => {
      downloadCSV('pace_personnel_roster.csv', personnel, ['id', 'name', 'callSign', 'role', 'bloodType', 'phone', 'iceContact', 'allergies', 'rendezvousPoint']);
    });
  }
}

// --- Comms Locker ---
export async function renderComms(container) {
  cleanupListeners();
  
  const radios = await db.getAllRadios();
  
  let tableHtml = '';
  if (radios.length === 0) {
    tableHtml = `
      <div class="empty-state empty-state-box">
        <p class="empty-state-text">No radios found in the locker. Add hardware to begin building your Comms Locker.</p>
        <button type="button" class="btn btn-primary cta-add-radio">+ Add New Radio</button>
      </div>
    `;
  } else {
    let tableRows = radios.map(r => {
      let powerBadge = 'badge-stable';
      const pwr = parseInt(r.powerOutput);
      if (pwr >= 50) powerBadge = 'badge-warning';
      
      return `
      <tr>
        <td><strong>${r.hardwareModel}</strong></td>
        <td>${r.frequency}</td>
        <td><span class="band-badge ${(r.supportedBand || r.band || 'unknown').toLowerCase()}">${r.supportedBand || r.band || 'UNKNOWN'}</span></td>
        <td>${r.tones}</td>
        <td><span class="badge ${powerBadge}">${r.powerOutput}</span></td>
        <td>
          <button class="btn btn-secondary btn-edit-radio btn-sm" data-id="${r.id}" style="margin-right: 5px;">Edit</button>
          <button class="btn btn-danger btn-delete-radio btn-sm" data-id="${r.id}">Delete</button>
        </td>
      </tr>
      `;
    }).join('');

    tableHtml = `
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Frequency</th>
            <th>Band</th>
            <th>Tones</th>
            <th>Power</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    `;
  }

  container.innerHTML = `
    <h2>Comms Locker</h2>
    <div class="panel">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
        <h3 style="margin: 0;">Inventory</h3>
        ${radios.length > 0 ? '<button class="btn btn-secondary btn-sm" id="btn-export-comms"><i data-lucide="download"></i> Export CSV</button>' : ''}
      </div>
      ${tableHtml}
    </div>
    
    <div class="panel">
      <h3>Add New Radio</h3>
      <form id="form-radio">
        <div class="form-group">
          <label>Hardware Model</label>
          <input type="text" id="r-model" required>
        </div>
        <div class="form-group">
          <label>Frequency</label>
          <input type="text" id="r-freq" required>
        </div>
        <div class="form-group">
          <label>Supported Band</label>
          <select id="r-supported-band" required>
            <option value="HF">HF</option>
            <option value="VHF">VHF</option>
            <option value="UHF">UHF</option>
          </select>
        </div>
        <div class="form-group">
          <label>Tones</label>
          <input type="text" id="r-tones">
        </div>
        <div class="form-group">
          <label>Power Output</label>
          <input type="text" id="r-power">
        </div>
        <button type="submit" class="btn btn-primary" id="btn-submit-radio">Save Radio</button>
      </form>
    </div>
  `;

  const form = container.querySelector('#form-radio');
  addCleanupListener(form, 'submit', async (e) => {
    e.preventDefault();
    const editId = form.dataset.editId ? parseInt(form.dataset.editId) : null;
    const rData = {
      hardwareModel: document.getElementById('r-model').value,
      frequency: document.getElementById('r-freq').value,
      supportedBand: document.getElementById('r-supported-band').value,
      tones: document.getElementById('r-tones').value,
      powerOutput: document.getElementById('r-power').value
    };
    
    if (editId) {
      await db.updateRadio(editId, rData);
      delete form.dataset.editId;
    } else {
      await db.addRadio(rData);
    }
    renderComms(container); // Re-render
  });

  container.querySelectorAll('.btn-delete-radio').forEach(btn => {
    addCleanupListener(btn, 'click', async (e) => {
      const id = parseInt(e.target.getAttribute('data-id'));
      if (await window.sysConfirm('Delete this radio? This will safely remove it from any existing PACE plans.')) {
        await db.deleteRadio(id);
        renderComms(container);
      }
    });
  });

  container.querySelectorAll('.btn-edit-radio').forEach(btn => {
    addCleanupListener(btn, 'click', async (e) => {
      const id = parseInt(e.target.getAttribute('data-id'));
      const radio = radios.find(r => r.id === id);
      if (radio) {
        document.getElementById('r-model').value = radio.hardwareModel || '';
        document.getElementById('r-freq').value = radio.frequency || '';
        document.getElementById('r-supported-band').value = radio.supportedBand || radio.band || 'HF';
        document.getElementById('r-tones').value = radio.tones || '';
        document.getElementById('r-power').value = radio.powerOutput || '';
        
        form.dataset.editId = id;
        const submitBtn = document.getElementById('btn-submit-radio');
        submitBtn.textContent = 'Update Radio';
        submitBtn.classList.add('pulse');
        setTimeout(() => submitBtn.classList.remove('pulse'), 1000);
        form.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  const ctaBtn = container.querySelector('.cta-add-radio');
  if (ctaBtn) {
    addCleanupListener(ctaBtn, 'click', () => {
      document.getElementById('r-model').focus();
    });
  }

  const exportBtn = container.querySelector('#btn-export-comms');
  if (exportBtn) {
    addCleanupListener(exportBtn, 'click', () => {
      downloadCSV('pace_comms_locker.csv', radios, ['id', 'hardwareModel', 'frequency', 'supportedBand', 'tones', 'powerOutput']);
    });
  }
}

// --- PACE Plans ---
export async function renderPacePlans(container) {
  cleanupListeners();
  
  const plans = await db.getAllPlans();
  const defaultNCS = await db.getSetting('defaultNCS') || '';
  const defaultSchedule = await db.getSetting('defaultSchedule') || '';
  const defaultCrypto = await db.getSetting('defaultCrypto') || '';

  let planListHtml = '';
  if (plans.length === 0) {
    planListHtml = `
      <div class="empty-state empty-state-box-sm">
        <p class="empty-state-text">No PACE plans created yet. Use the wizard to generate your first plan.</p>
        <button type="button" class="btn btn-primary cta-add-plan">Create New Plan</button>
      </div>
    `;
  } else {
    planListHtml = '<ul>' + plans.map(p => `
      <li class="plan-list-item">
        <span><strong>${p.planName}</strong><br><small class="text-muted">${p.scenarioType}</small></span>
        <div class="plan-actions">
          <button type="button" class="btn btn-secondary btn-edit-plan btn-sm" data-id="${p.id}"><i data-lucide="edit" class="tactical-icon-sm"></i> Edit</button>
          <button type="button" class="btn share-qr-btn inverted btn-sm" data-id="${p.id}"><i data-lucide="qr-code" class="tactical-icon-sm"></i> Share QR</button>
          <button type="button" class="btn btn-secondary export-pdf-btn btn-sm" data-id="${p.id}"><i data-lucide="download" class="tactical-icon-sm"></i> Export PDF</button>
          <button type="button" class="btn btn-secondary btn-set-alarm btn-sm" data-id="${p.id}" data-name="${p.planName}"><i data-lucide="bell" class="tactical-icon-sm"></i> Set Alarm</button>
          <button type="button" class="btn btn-danger btn-delete-plan btn-sm" data-id="${p.id}">Delete</button>
        </div>
      </li>
    `).join('') + '</ul>';
  }

  const scenariosOptions = db.THREAT_SCENARIOS.map(s => `<option value="${s}">${s}</option>`).join('');

  container.innerHTML = `
    <h2>PACE Plans</h2>
    <div class="grid-2">
      <!-- Left: List -->
      <div class="panel">
        <h3>Active Plans</h3>
        ${planListHtml}
      </div>
      
      <!-- Right: Wizard -->
      <div class="panel">
        <h3>Create New Plan</h3>
        <form id="form-pace">
          <div class="grid-2">
            <div class="form-group">
              <label>Plan Name</label>
              <input type="text" id="pace-name" required>
            </div>
            <div class="form-group">
              <label>Scenario Type</label>
              <select id="pace-scenario">${scenariosOptions}</select>
            </div>
          </div>
          <div class="grid-2">
            <div class="form-group">
              <label>Net Control Station (NCS)</label>
              <input type="text" id="pace-ncs" placeholder="e.g. TOC / Command" value="${defaultNCS}">
            </div>
            <div class="form-group">
              <label>Comm Window / Schedule</label>
              <input type="text" id="pace-schedule" placeholder="e.g. Every 4 hrs at top of hour" value="${defaultSchedule}">
            </div>
          </div>
          <div class="grid-2">
            <div class="form-group">
              <label>Authentication / Crypto</label>
              <input type="text" id="pace-crypto" placeholder="e.g. Daily challenge / AES Key" value="${defaultCrypto}">
            </div>
            <div class="form-group">
              <label>No-Comm / Fallback Procedure</label>
              <input type="text" id="pace-fallback" placeholder="e.g. Rally at Checkpoint Alpha">
            </div>
          </div>
          <div class="form-group">
            <label>Infrastructure Status</label>
            <input type="text" id="pace-infra" placeholder="Status of repeaters, cell towers, etc.">
          </div>
          
          <hr class="divider">
          
          <div id="pace-slots-container"></div>
          
          <button type="submit" class="btn btn-primary" id="btn-submit-plan">Save Plan</button>
        </form>
      </div>
    </div>
    
    <!-- Modals -->
    <dialog id="modal-personnel">
      <h3>Add New Member</h3>
      <form id="modal-form-personnel">
        <div class="form-group"><label>Name</label><input type="text" id="m-p-name" required></div>
        <div class="form-group"><label>Call Sign</label><input type="text" id="m-p-callsign" required></div>
        <div class="form-group"><label>Role / Billet</label><select id="m-p-role" required><option value="Team Lead">Team Lead</option><option value="Medic">Medic</option><option value="RTO">RTO</option><option value="Scout">Scout</option><option value="Rifleman">Rifleman</option><option value="Other">Other</option></select></div>
        <div class="form-group"><label>Blood Type</label><select id="m-p-blood"><option value="UNKNOWN">UNKNOWN</option><option value="O-POS">O-POS</option><option value="O-NEG">O-NEG</option><option value="A-POS">A-POS</option><option value="A-NEG">A-NEG</option><option value="B-POS">B-POS</option><option value="B-NEG">B-NEG</option><option value="AB-POS">AB-POS</option><option value="AB-NEG">AB-NEG</option></select></div>
        <div class="form-group"><label>Phone</label><input type="text" id="m-p-phone"></div>
        <div class="form-group"><label>ICE Contact</label><input type="text" id="m-p-ice"></div>
        <div class="form-group"><label>Allergies</label><input type="text" id="m-p-allergies" placeholder="e.g., NKA"></div>
        <div class="form-group"><label>Rendezvous Point</label><input type="text" id="m-p-rv"></div>
        <div class="dialog-actions">
          <button type="button" class="btn cancel-btn">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Member</button>
        </div>
      </form>
    </dialog>
    
    <dialog id="modal-radio">
      <h3>Add New Radio</h3>
      <form id="modal-form-radio">
        <div class="form-group"><label>Hardware Model</label><input type="text" id="m-r-model" required></div>
        <div class="form-group"><label>Frequency</label><input type="text" id="m-r-freq" required></div>
        <div class="form-group"><label>Supported Band</label><select id="m-r-supported-band" required><option value="HF">HF</option><option value="VHF">VHF</option><option value="UHF">UHF</option></select></div>
        <div class="form-group"><label>Tones</label><input type="text" id="m-r-tones"></div>
        <div class="form-group"><label>Power Output</label><input type="text" id="m-r-power"></div>
        <div class="dialog-actions">
          <button type="button" class="btn cancel-btn">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Radio</button>
        </div>
      </form>
    </dialog>
    
    <dialog id="modal-qr-share" class="dialog-sm text-center">
      <h3>Air-Gap Handover</h3>
      <p class="dialog-subtitle">Scan this QR code with another PACE Builder to securely transfer this operational plan.</p>
      <canvas id="qr-canvas" class="qr-canvas-display"></canvas>
      <div class="dialog-actions dialog-actions-center">
        <button type="button" class="btn cancel-btn">Close Window</button>
      </div>
    </dialog>
  `;

  // Render the Slots
  const slotsContainer = container.querySelector('#pace-slots-container');
  const slots = ['Primary', 'Alternate', 'Contingency', 'Emergency'];
  
  slotsContainer.innerHTML = slots.map(slot => `
    <div class="pace-slot" data-slot="${slot.toLowerCase()}">
      <h4>${slot}</h4>
      <div class="grid-2 slot-grid">
        <div class="form-group">
          <label>Personnel</label>
          <select class="personnel-select" required></select>
        </div>
        <div class="form-group">
          <label>Radio Hardware</label>
          <select class="radio-select" required></select>
        </div>
      </div>
      <div class="grid-2 slot-grid">
        <div class="form-group">
          <label>Assigned Frequency</label>
          <input type="text" class="frequency-input" placeholder="e.g. 146.520 MHz" required>
        </div>
        <div class="form-group">
          <label>Notes</label>
          <input type="text" class="slot-notes">
        </div>
      </div>
      <div class="validation-container"></div>
    </div>
  `).join('');

  const modalPersonnel = container.querySelector('#modal-personnel');
  const modalRadio = container.querySelector('#modal-radio');
  
  let currentSelectToUpdate = null; // Track which select opened the modal

  // Function to populate dropdowns
  async function populateDropdowns() {
    const personnel = await db.getAllPersonnel();
    const radios = await db.getAllRadios();
    
    const personnelOptions = `
      <option value="" disabled selected>Select...</option>
      <option value="add_new">+ Add New Member</option>
      ${personnel.map(p => `<option value="${p.id}">${p.name} (${p.callSign})</option>`).join('')}
    `;
    
    // For now, no operational tier exists, so show all radios.
    const radioOptions = `
      <option value="" disabled selected>Select...</option>
      <option value="add_new">+ Add New Radio</option>
      ${radios.map(r => `<option value="${r.id}">${r.hardwareModel} - ${r.frequency}</option>`).join('')}
    `;

    container.querySelectorAll('.personnel-select').forEach(sel => {
      const val = sel.value;
      sel.innerHTML = personnelOptions;
      if(val && val !== 'add_new') sel.value = val;
    });

    container.querySelectorAll('.radio-select').forEach(sel => {
      const val = sel.value;
      sel.innerHTML = radioOptions;
      if(val && val !== 'add_new') sel.value = val;
    });
  }

  await populateDropdowns();

  // Listeners for dropdowns to trigger Modals
  container.querySelectorAll('.personnel-select').forEach(sel => {
    addCleanupListener(sel, 'change', (e) => {
      if (e.target.value === 'add_new') {
        currentSelectToUpdate = e.target;
        modalPersonnel.showModal();
        e.target.value = ''; // Reset temporarily
      }
    });
  });

  container.querySelectorAll('.radio-select').forEach(sel => {
    addCleanupListener(sel, 'change', (e) => {
      if (e.target.value === 'add_new') {
        currentSelectToUpdate = e.target;
        modalRadio.showModal();
        e.target.value = ''; // Reset temporarily
      }
    });
  });

  // Real-time Validation Hook
  const validateSlot = async (slotEl) => {
    const radioSelect = slotEl.querySelector('.radio-select');
    const freqInput = slotEl.querySelector('.frequency-input');
    const validationContainer = slotEl.querySelector('.validation-container');
    
    validationContainer.innerHTML = ''; // Reset
    
    const radioId = parseInt(radioSelect.value);
    const freqStr = freqInput.value;
    
    if (isNaN(radioId) || !freqStr.trim()) return;
    
    const radios = await db.getAllRadios();
    const radio = radios.find(r => r.id === radioId);
    if (!radio) return;
    
    const requiredBand = getBandFromFrequency(freqStr);
    const radioBand = radio.supportedBand || radio.band || 'UNKNOWN';
    
    if (requiredBand !== radioBand || requiredBand === 'UNKNOWN') {
      validationContainer.innerHTML = `<div class="validation-warning-banner">Hardware Mismatch Detected: Assigned radio hardware cannot transmit on this frequency band.</div>`;
    }
  };

  container.querySelectorAll('.pace-slot').forEach(slotEl => {
    const rSelect = slotEl.querySelector('.radio-select');
    const fInput = slotEl.querySelector('.frequency-input');
    addCleanupListener(rSelect, 'change', () => validateSlot(slotEl));
    addCleanupListener(fInput, 'input', () => validateSlot(slotEl));
  });

  // Modal Cancel Buttons
  container.querySelectorAll('.cancel-btn').forEach(btn => {
    addCleanupListener(btn, 'click', (e) => {
      e.target.closest('dialog').close();
      currentSelectToUpdate = null;
    });
  });

  // Modal Submit Handlers
  const formModalPersonnel = container.querySelector('#modal-form-personnel');
  addCleanupListener(formModalPersonnel, 'submit', async (e) => {
    e.preventDefault();
    const id = await db.addPersonnel({
      name: document.getElementById('m-p-name').value,
      callSign: document.getElementById('m-p-callsign').value,
      role: document.getElementById('m-p-role').value,
      bloodType: document.getElementById('m-p-blood').value,
      phone: document.getElementById('m-p-phone').value,
      iceContact: document.getElementById('m-p-ice').value,
      allergies: document.getElementById('m-p-allergies').value,
      rendezvousPoint: document.getElementById('m-p-rv').value
    });
    formModalPersonnel.reset();
    modalPersonnel.close();
    await populateDropdowns();
    if (currentSelectToUpdate) currentSelectToUpdate.value = id;
    currentSelectToUpdate = null;
  });

  const formModalRadio = container.querySelector('#modal-form-radio');
  addCleanupListener(formModalRadio, 'submit', async (e) => {
    e.preventDefault();
    const id = await db.addRadio({
      hardwareModel: document.getElementById('m-r-model').value,
      frequency: document.getElementById('m-r-freq').value,
      supportedBand: document.getElementById('m-r-supported-band').value,
      tones: document.getElementById('m-r-tones').value,
      powerOutput: document.getElementById('m-r-power').value
    });
    formModalRadio.reset();
    modalRadio.close();
    await populateDropdowns();
    if (currentSelectToUpdate) currentSelectToUpdate.value = id;
    currentSelectToUpdate = null;
  });

  // Main Form Submit
  const paceForm = container.querySelector('#form-pace');
  addCleanupListener(paceForm, 'submit', async (e) => {
    e.preventDefault();
    const editId = paceForm.dataset.editId ? parseInt(paceForm.dataset.editId) : null;
    
    // Check for active warnings
    const warnings = container.querySelectorAll('.validation-warning-banner');
    if (warnings.length > 0) {
      console.warn(`[PACE Builder Alert] Plan saved with ${warnings.length} hardware-to-frequency mismatch(es). Verify operational viability.`);
    }
    
    const getSlotData = (slotName) => {
      const slotEl = container.querySelector(`.pace-slot[data-slot="${slotName}"]`);
      return {
        personnelId: parseInt(slotEl.querySelector('.personnel-select').value),
        radioId: parseInt(slotEl.querySelector('.radio-select').value),
        assignedFrequency: slotEl.querySelector('.frequency-input').value,
        notes: slotEl.querySelector('.slot-notes').value
      };
    };

    const plan = {
      planName: document.getElementById('pace-name').value,
      scenarioType: document.getElementById('pace-scenario').value,
      infrastructureStatus: document.getElementById('pace-infra').value,
      ncs: document.getElementById('pace-ncs').value,
      schedule: document.getElementById('pace-schedule').value,
      crypto: document.getElementById('pace-crypto').value,
      fallback: document.getElementById('pace-fallback').value,
      dateCreated: new Date().toISOString(),
      primarySlot: getSlotData('primary'),
      alternateSlot: getSlotData('alternate'),
      contingencySlot: getSlotData('contingency'),
      emergencySlot: getSlotData('emergency')
    };

    if (editId) {
      plan.id = editId;
    }

    const submitBtn = paceForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'PROCESSING...';

    try {
      await db.savePlan(plan);
      renderPacePlans(container); // Re-render to update the list
      window.sysAlert(editId ? "PACE Plan Updated Successfully!" : "PACE Plan Saved Successfully!");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });

  // Edit Plan Handlers
  container.querySelectorAll('.btn-edit-plan').forEach(btn => {
    addCleanupListener(btn, 'click', async (e) => {
      const actualBtn = e.target.closest('.btn-edit-plan');
      const id = parseInt(actualBtn.getAttribute('data-id'));
      const plan = plans.find(p => p.id === id);
      if (plan) {
        document.getElementById('pace-name').value = plan.planName || '';
        document.getElementById('pace-scenario').value = plan.scenarioType || 'Grid-Down / Blackout';
        document.getElementById('pace-ncs').value = plan.ncs || '';
        document.getElementById('pace-schedule').value = plan.schedule || '';
        document.getElementById('pace-crypto').value = plan.crypto || '';
        document.getElementById('pace-fallback').value = plan.fallback || '';
        document.getElementById('pace-infra').value = plan.infrastructureStatus || '';
        
        const setSlotData = (slotName, slotData) => {
          if (!slotData) return;
          const slotEl = container.querySelector(`.pace-slot[data-slot="${slotName}"]`);
          if (slotEl) {
            slotEl.querySelector('.personnel-select').value = slotData.personnelId || '';
            slotEl.querySelector('.radio-select').value = slotData.radioId || '';
            slotEl.querySelector('.frequency-input').value = slotData.assignedFrequency || '';
            slotEl.querySelector('.slot-notes').value = slotData.notes || '';
          }
        };
        
        setSlotData('primary', plan.primarySlot);
        setSlotData('alternate', plan.alternateSlot);
        setSlotData('contingency', plan.contingencySlot);
        setSlotData('emergency', plan.emergencySlot);
        
        paceForm.dataset.editId = id;
        const submitBtn = document.getElementById('btn-submit-plan');
        submitBtn.textContent = 'Update Plan';
        submitBtn.classList.add('pulse');
        setTimeout(() => submitBtn.classList.remove('pulse'), 1000);
        paceForm.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  // Export PDF Buttons
  container.querySelectorAll('.export-pdf-btn').forEach(btn => {
    addCleanupListener(btn, 'click', async (e) => {
      const actualBtn = e.target.closest('.export-pdf-btn');
      const planId = parseInt(actualBtn.getAttribute('data-id'));
      actualBtn.textContent = 'Exporting...';
      actualBtn.disabled = true;
      try {
        await generatePacePDF(planId);
      } catch (error) {
        console.error("PDF Generation failed:", error);
        window.sysAlert("Failed to generate PDF. Check console.");
      } finally {
        actualBtn.innerHTML = '<i data-lucide="download" class="tactical-icon-sm"></i> Export PDF';
        actualBtn.disabled = false;
        if (window.lucide) window.lucide.createIcons();
      }
    });
  });

  // Delete Plan Buttons
  container.querySelectorAll('.btn-delete-plan').forEach(btn => {
    addCleanupListener(btn, 'click', async (e) => {
      const actualBtn = e.target.closest('.btn-delete-plan');
      const planId = parseInt(actualBtn.getAttribute('data-id'));
      if (await window.sysConfirm('Delete this PACE plan permanently?')) {
        await db.deletePlan(planId);
        renderPacePlans(container);
      }
    });
  });

  // Set Alarm Buttons
  container.querySelectorAll('.btn-set-alarm').forEach(btn => {
    addCleanupListener(btn, 'click', (e) => {
      const actualBtn = e.target.closest('.btn-set-alarm');
      const planId = parseInt(actualBtn.getAttribute('data-id'));
      const planName = actualBtn.getAttribute('data-name');
      
      const dialog = document.createElement('dialog');
      dialog.className = 'global-modal';
      dialog.style.maxWidth = '400px';
      
      dialog.innerHTML = `
        <h3 style="margin-top:0;">Set Comm Window Alarm</h3>
        <p class="text-muted" style="margin-bottom: 1.5rem;">Schedule a local alarm for <strong>${planName}</strong>. The PACE Builder app must remain active to sound the alarm.</p>
        <div class="form-group">
          <label>Alarm Time</label>
          <input type="datetime-local" id="alarm-datetime" style="width: 100%;">
        </div>
        <div style="display: flex; gap: 1rem; justify-content: space-between; margin-top: 1.5rem;">
          <button class="btn cancel-btn" id="btn-cancel-alarm" style="flex: 1;">Cancel</button>
          <button class="btn btn-primary" id="btn-save-alarm" style="flex: 1;">Set Alarm</button>
        </div>
      `;
      
      document.body.appendChild(dialog);
      dialog.showModal();
      
      dialog.querySelector('#btn-cancel-alarm').addEventListener('click', () => {
        dialog.close();
        dialog.remove();
      });
      
      dialog.querySelector('#btn-save-alarm').addEventListener('click', () => {
        const dtInput = dialog.querySelector('#alarm-datetime').value;
        if (!dtInput) {
          window.sysAlert("Please select a valid date and time.");
          return;
        }
        
        const timestamp = new Date(dtInput).getTime();
        if (timestamp < new Date().getTime()) {
          window.sysAlert("Alarm time must be in the future.");
          return;
        }

        if (Notification.permission !== 'granted') {
          Notification.requestPermission().then(perm => {
            if (perm !== 'granted') window.sysAlert("Notification permissions are required to set an alarm.");
          });
        }
        
        const alarms = JSON.parse(localStorage.getItem('pace_alarms') || '[]');
        alarms.push({ planId, planName, timestamp });
        localStorage.setItem('pace_alarms', JSON.stringify(alarms));
        
        dialog.close();
        dialog.remove();
        window.sysAlert(`Alarm set for ${new Date(timestamp).toLocaleTimeString()}.`, "Alarm Scheduled");
      });
    });
  });

  // Share QR Buttons
  const modalQRShare = container.querySelector('#modal-qr-share');
  const qrCanvas = container.querySelector('#qr-canvas');
  container.querySelectorAll('.share-qr-btn').forEach(btn => {
    addCleanupListener(btn, 'click', async (e) => {
      const actualBtn = e.target.closest('.share-qr-btn');
      const planId = parseInt(actualBtn.getAttribute('data-id'));
      try {
        const payload = await generateHandoverPayload(planId);
        // Generate high contrast canvas
        await QRCode.toCanvas(qrCanvas, payload, { 
          width: 300,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });
        modalQRShare.showModal();
      } catch (err) {
        console.error("QR Generation failed:", err);
        window.sysAlert("Error generating SITREP PDF.");
      }
    });
  });

  // Empty state CTA Focus
  const ctaPlanBtn = container.querySelector('.cta-add-plan');
  if (ctaPlanBtn) {
    addCleanupListener(ctaPlanBtn, 'click', () => {
      document.getElementById('pace-name').focus();
    });
  }
}

// --- Reusable Tactical Location Module ---
export function createLocationWidget(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="location-widget-container panel">
      <h3>Location Telemetry</h3>
      <div class="location-toggle-group">
        <button type="button" class="btn location-toggle-btn active" data-mode="live-gps"><i data-lucide="crosshair" class="tactical-icon-sm"></i> Live GPS</button>
        <button type="button" class="btn location-toggle-btn" data-mode="last-ping"><i data-lucide="history" class="tactical-icon-sm"></i> Last Ping</button>
        <button type="button" class="btn location-toggle-btn" data-mode="manual-text"><i data-lucide="type" class="tactical-icon-sm"></i> Manual Text</button>
        <button type="button" class="btn location-toggle-btn" data-mode="map-drop"><i data-lucide="map-pin" class="tactical-icon-sm"></i> Offline Map Drop</button>
      </div>
      <div class="location-content-area" id="${containerId}-content-area">
        <!-- Dynamic content injected here -->
      </div>
    </div>
  `;

  if (window.lucide) window.lucide.createIcons();

  const contentArea = container.querySelector('.location-content-area');
  const toggleBtns = container.querySelectorAll('.location-toggle-btn');
  let currentMap = null;

  const renderMode = async (mode) => {
    // Cleanup previous mode
    if (currentMap) {
      currentMap.remove();
      currentMap = null;
    }

    // Reset buttons
    toggleBtns.forEach(b => b.classList.remove('active', 'btn-primary'));
    const activeBtn = Array.from(toggleBtns).find(b => b.getAttribute('data-mode') === mode);
    if (activeBtn) activeBtn.classList.add('active', 'btn-primary');

    switch (mode) {
      case 'live-gps':
        contentArea.innerHTML = `<p class="text-muted">Acquiring high-accuracy lock...</p>`;
        if (!navigator.geolocation) {
          contentArea.innerHTML = `<p class="text-warning">Geolocation is not supported by this browser.</p>`;
          return;
        }
        navigator.geolocation.getCurrentPosition(
          async (pos) => {
            const lat = pos.coords.latitude.toFixed(6);
            const lng = pos.coords.longitude.toFixed(6);
            contentArea.innerHTML = `
              <div class="coordinate-readout">
                LAT: ${lat}<br>
                LNG: ${lng}<br>
                <small class="text-muted">Accuracy: &plusmn;${Math.round(pos.coords.accuracy)}m</small>
              </div>
            `;
            await db.addLocationCache({
              timestamp: pos.timestamp || Date.now(),
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
              source: 'manual-gps'
            });
          },
          (err) => {
            contentArea.innerHTML = `<p class="text-warning">Failed to acquire lock: ${err.message}</p>`;
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
        break;

      case 'last-ping':
        contentArea.innerHTML = `<p class="text-muted">Retrieving cache...</p>`;
        const lastLoc = await db.getLatestLocationCache();
        if (lastLoc) {
          const timeAgo = Math.floor((Date.now() - lastLoc.timestamp) / 60000);
          contentArea.innerHTML = `
            <div class="coordinate-readout">
              LAT: ${lastLoc.latitude.toFixed(6)}<br>
              LNG: ${lastLoc.longitude.toFixed(6)}<br>
              <small class="text-muted">Cached ${timeAgo}m ago (Source: ${lastLoc.source})</small>
            </div>
          `;
        } else {
          contentArea.innerHTML = `<p class="text-muted">No cached locations found.</p>`;
        }
        break;

      case 'manual-text':
        contentArea.innerHTML = `
          <div class="form-group" style="margin: 0;">
            <label>Location Descriptor (Address, Cross-Streets, MGRS)</label>
            <input type="text" placeholder="e.g. 123 Main St / 14S QK 1234 5678" class="manual-location-input">
          </div>
        `;
        break;

      case 'map-drop':
        contentArea.innerHTML = `
          <div id="${containerId}-map" class="map-viewport-container"></div>
        `;
        // Must delay initialization slightly to ensure the container is painted
        setTimeout(() => {
          const mapEl = document.getElementById(`${containerId}-map`);
          if (!mapEl) return;
          
          currentMap = L.map(mapEl).setView([39.8283, -98.5795], 4); // Center US
          let marker = null;

          const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors'
          });

          // Offline Fail-Safe
          tileLayer.on('tileerror', (error, tile) => {
             mapEl.classList.add('offline-map-grid');
          });

          tileLayer.addTo(currentMap);

          currentMap.on('click', (e) => {
            if (marker) currentMap.removeLayer(marker);
            marker = L.marker(e.latlng).addTo(currentMap);
            // Optionally dispatch an event or save the dropped pin
            const lat = e.latlng.lat.toFixed(6);
            const lng = e.latlng.lng.toFixed(6);
            console.log(`Pin dropped at LAT: ${lat}, LNG: ${lng}`);
          });
        }, 50);
        break;
    }
  };

  toggleBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      renderMode(e.currentTarget.getAttribute('data-mode'));
    });
  });

  // Initial render
  renderMode('live-gps');
}

// --- Phonetic Teleprompter Compiler ---
const phoneticMap = {
  '1': 'ONE (WUN)', '2': 'TWO (TOO)', '3': 'THREE (TREE)', '4': 'FOUR (FOWER)',
  '5': 'FIVE (FIFE)', '6': 'SIX (SIX)', '7': 'SEVEN (SEVEN)', '8': 'EIGHT (AIT)',
  '9': 'NINE (NINER)', '0': 'ZERO (ZERO)'
};

function phoneticizeNumbers(text) {
  if (!text) return '[OMITTED]';
  return text.toString().replace(/[0-9]/g, match => phoneticMap[match] || match);
}

export function compileRadioScript(type, data) {
  let script = `THIS IS [CALLSIGN] WITH A ${type} REPORT.\n\n`;
  if (type === 'SITREP') {
    script += `LINE ONE (SITUATION): ${phoneticizeNumbers(data.line1)}\n`;
    script += `LINE TWO (PROGRESS): ${phoneticizeNumbers(data.line2)}\n`;
    script += `LINE THREE (COMMS): ${phoneticizeNumbers(data.line3)}\n`;
    script += `LOCATION: ${phoneticizeNumbers(data.location)}\n`;
  } else if (type === 'SALUTE') {
    script += `SIZE: ${phoneticizeNumbers(data.size)}\n`;
    script += `ACTIVITY: ${phoneticizeNumbers(data.activity)}\n`;
    script += `LOCATION: ${phoneticizeNumbers(data.location)}\n`;
    script += `UNIT: ${phoneticizeNumbers(data.unit)}\n`;
    script += `TIME: ${phoneticizeNumbers(data.time)}\n`;
    script += `EQUIPMENT: ${phoneticizeNumbers(data.equipment)}\n`;
  } else if (type === 'MEDEVAC') {
    script += `LINE ONE (LOCATION): ${phoneticizeNumbers(data.location)}\n`;
    script += `LINE TWO (FREQ/CALLSIGN): ${phoneticizeNumbers(data.line2)}\n`;
    script += `LINE THREE (PRECEDENCE): ${phoneticizeNumbers(data.line3)}\n`;
    script += `LINE FOUR (EQUIPMENT): ${phoneticizeNumbers(data.line4)}\n`;
    script += `LINE FIVE (PATIENT TYPE): ${phoneticizeNumbers(data.line5)}\n`;
    script += `LINES 6-9: AS REQUIRED / TO FOLLOW.\n`;
  }
  return script + `\nOVER.`;
}

// --- Tactical Reporting Engine UI ---
export async function renderReportingEngine(container) {
  container.innerHTML = `
    <h2>Tactical Reporting</h2>
    
    <div class="report-type-selector">
      <button class="btn report-tab-btn active" data-type="SITREP">SITREP</button>
      <button class="btn report-tab-btn" data-type="SALUTE">SALUTE</button>
      <button class="btn report-tab-btn" data-type="MEDEVAC">9-LINE MEDEVAC</button>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3 id="report-form-title">SITREP Data</h3>
        <form id="tactical-report-form">
          <!-- Dynamically injected -->
        </form>
      </div>
      
      <div class="panel">
        <h3>Transmission Script</h3>
        <div class="teleprompter-box" id="teleprompter-output">
          AWAITING INPUT...
        </div>
        <div class="grid-2" style="margin-top: 1rem; gap: 1rem;">
          <button id="btn-export-report-pdf" class="btn btn-secondary btn-massive" style="border: 2px solid var(--primary-accent);"><i data-lucide="download" class="tactical-icon-sm"></i> EXPORT PDF</button>
          <button id="btn-log-report" class="btn btn-primary btn-massive">LOG & SAVE</button>
        </div>
      </div>
    </div>
  `;

  const tabs = container.querySelectorAll('.report-tab-btn');
  const form = document.getElementById('tactical-report-form');
  const title = document.getElementById('report-form-title');
  const teleprompter = document.getElementById('teleprompter-output');
  const logBtn = document.getElementById('btn-log-report');

  let currentType = 'SITREP';

  const formsMap = {
    'SITREP': `
      <div class="tactical-form-group">
        <label>Line 1: Situation Summary</label>
        <textarea name="line1" rows="2" class="w-100" placeholder="Current tactical situation"></textarea>
      </div>
      <div class="tactical-form-group">
        <label>Line 2: Operations Progress</label>
        <textarea name="line2" rows="2" class="w-100" placeholder="Progress against objectives"></textarea>
      </div>
      <div class="tactical-form-group">
        <label>Line 3: Comms Status / PACE Check</label>
        <input type="text" name="line3" class="w-100" placeholder="Current comms link">
      </div>
      <div class="tactical-form-group">
        <label>Location Update</label>
        <div id="report-location-widget"></div>
      </div>
    `,
    'SALUTE': `
      <div class="tactical-form-group">
        <label>Size</label>
        <input type="text" name="size" class="w-100" placeholder="Number of personnel/vehicles">
      </div>
      <div class="tactical-form-group">
        <label>Activity</label>
        <input type="text" name="activity" class="w-100" placeholder="What are they doing?">
      </div>
      <div class="tactical-form-group">
        <label>Location</label>
        <div id="report-location-widget"></div>
      </div>
      <div class="tactical-form-group">
        <label>Unit / Uniform</label>
        <input type="text" name="unit" class="w-100" placeholder="Distinctive markings">
      </div>
      <div class="tactical-form-group">
        <label>Time</label>
        <input type="time" name="time" class="w-100">
      </div>
      <div class="tactical-form-group">
        <label>Equipment</label>
        <input type="text" name="equipment" class="w-100" placeholder="Weapons, gear observed">
      </div>
    `,
    'MEDEVAC': `
      <div class="tactical-form-group">
        <label>Line 1: Location of Pickup</label>
        <div id="report-location-widget"></div>
      </div>
      <div class="tactical-form-group">
        <label>Line 2: Frequency / Callsign</label>
        <input type="text" name="line2" class="w-100" placeholder="LZ Frequency & Callsign">
      </div>
      <div class="tactical-form-group">
        <label>Line 3: Patients by Precedence</label>
        <div class="tactical-toggle-group">
          <button type="button" class="tactical-toggle-btn" data-name="line3" data-val="Urgent">URGENT</button>
          <button type="button" class="tactical-toggle-btn" data-name="line3" data-val="Priority">PRIORITY</button>
          <button type="button" class="tactical-toggle-btn" data-name="line3" data-val="Routine">ROUTINE</button>
        </div>
        <input type="hidden" name="line3" value="">
      </div>
      <div class="tactical-form-group">
        <label>Line 4: Special Equipment</label>
        <div class="tactical-toggle-group">
          <button type="button" class="tactical-toggle-btn" data-name="line4" data-val="None">NONE</button>
          <button type="button" class="tactical-toggle-btn" data-name="line4" data-val="Hoist">HOIST</button>
          <button type="button" class="tactical-toggle-btn" data-name="line4" data-val="Extraction">EXTRACTION</button>
        </div>
        <input type="hidden" name="line4" value="">
      </div>
      <div class="tactical-form-group">
        <label>Line 5: Patient Type</label>
        <div class="tactical-toggle-group">
          <button type="button" class="tactical-toggle-btn" data-name="line5" data-val="Litter">LITTER</button>
          <button type="button" class="tactical-toggle-btn" data-name="line5" data-val="Ambulatory">AMBULATORY</button>
        </div>
        <input type="hidden" name="line5" value="">
      </div>
    `
  };

  const updateCompiler = () => {
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    
    // Extract Location from the Widget (It outputs formatted strings with <br>)
    const locReadout = document.querySelector('#report-location-widget .coordinate-readout');
    if (locReadout) {
      data.location = locReadout.innerText.replace(/\\n/g, ' ').replace(/LAT:/g, '').replace(/LNG:/g, '').trim();
    } else {
      const manualInput = document.querySelector('.manual-location-input');
      if (manualInput && manualInput.value) {
        data.location = manualInput.value;
      }
    }

    const script = compileRadioScript(currentType, data);
    teleprompter.textContent = script;
    
    // Auto-Save Draft
    localStorage.setItem(`pace_draft_${currentType.toLowerCase()}`, JSON.stringify(data));
  };

  const initForm = (type) => {
    currentType = type;
    title.textContent = `${type} Data`;
    form.innerHTML = formsMap[type];
    
    createLocationWidget('report-location-widget');

    // Restore Draft
    const draft = localStorage.getItem(`pace_draft_${type.toLowerCase()}`);
    if (draft) {
      try {
        const parsed = JSON.parse(draft);
        Object.keys(parsed).forEach(key => {
          const el = form.querySelector(`[name="${key}"]`);
          if (el) el.value = parsed[key];
        });
        
        // Restore toggles
        form.querySelectorAll('.tactical-toggle-btn').forEach(btn => {
          const name = btn.getAttribute('data-name');
          const val = btn.getAttribute('data-val');
          if (parsed[name] && Array.isArray(parsed[name]) && parsed[name].includes(val)) {
            btn.classList.add('active');
          }
        });
      } catch (e) {
        console.error("Draft restore failed", e);
      }
    }

    // Bind Toggle Buttons
    form.querySelectorAll('.tactical-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const t = e.currentTarget;
        t.classList.toggle('active');
        
        // Update hidden input
        const name = t.getAttribute('data-name');
        const hiddenInput = form.querySelector(`input[name="${name}"]`);
        const activeVals = Array.from(form.querySelectorAll(`.tactical-toggle-btn[data-name="${name}"].active`))
          .map(b => b.getAttribute('data-val'));
        hiddenInput.value = activeVals.join(', ');
        
        updateCompiler();
      });
    });

    // Form Change Listener
    form.addEventListener('input', updateCompiler);
    
    // Listen for clicks inside the location widget to update compiler when location changes
    const locWidget = document.getElementById('report-location-widget');
    if (locWidget) {
      locWidget.addEventListener('click', () => {
        setTimeout(updateCompiler, 500); // give widget time to update DOM
      });
    }

    updateCompiler();
  };

  tabs.forEach(tab => {
    addCleanupListener(tab, 'click', (e) => {
      tabs.forEach(t => t.classList.remove('active'));
      e.currentTarget.classList.add('active');
      initForm(e.currentTarget.getAttribute('data-type'));
    });
  });

  addCleanupListener(logBtn, 'click', async () => {
    logBtn.disabled = true;
    const originalText = logBtn.textContent;
    logBtn.textContent = 'PROCESSING...';
    
    try {
      const formData = new FormData(form);
      const data = Object.fromEntries(formData.entries());
      const compiled = teleprompter.textContent;
      
      await db.addTacticalReport({
        timestamp: Date.now(),
        reportType: currentType,
        rawPayload: data,
        compiledScript: compiled
      });
      
      // Clear draft
      localStorage.removeItem(`pace_draft_${currentType.toLowerCase()}`);
      window.sysAlert(`${currentType} Report Logged!`);
      initForm(currentType); // Reset form
    } finally {
      logBtn.disabled = false;
      logBtn.textContent = originalText;
    }
  });

  const exportBtn = document.getElementById('btn-export-report-pdf');
  addCleanupListener(exportBtn, 'click', async () => {
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    const compiled = teleprompter.textContent;
    
    exportBtn.textContent = 'EXPORTING...';
    exportBtn.disabled = true;
    try {
      await generateReportPDF(currentType, data, compiled);
    } catch (error) {
      console.error("PDF Export failed:", error);
      window.sysAlert("Failed to export PDF.");
    } finally {
      exportBtn.innerHTML = '<i data-lucide="download" class="tactical-icon-sm"></i> EXPORT PDF';
      exportBtn.disabled = false;
      if (window.lucide) window.lucide.createIcons();
    }
  });

  initForm('SITREP');
}

// --- Global Settings ---
export async function renderSettings(container) {
  cleanupListeners();

  const defaultNCS = await db.getSetting('defaultNCS') || '';
  const defaultSchedule = await db.getSetting('defaultSchedule') || '';
  const defaultCrypto = await db.getSetting('defaultCrypto') || '';
  const userCallSign = await db.getSetting('userCallSign') || '';
  const pdfClassification = await db.getSetting('pdfClassification') || 'UNCLASSIFIED // FOR OFFICIAL USE ONLY';
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0';

  container.innerHTML = `
    <h2>Global Settings</h2>
    <div class="panel">
      <h3>Operational Defaults</h3>
      <p class="text-muted" style="margin-bottom: 1rem;">These values will automatically pre-fill when you create a new PACE Plan or Tactical Report.</p>
      
      <form id="form-settings">
        <div class="grid-2">
          <div class="form-group">
            <label>User Call Sign</label>
            <input type="text" id="set-callsign" value="${userCallSign}">
          </div>
          <div class="form-group">
            <label>Default Net Control Station (NCS)</label>
            <input type="text" id="set-ncs" value="${defaultNCS}">
          </div>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label>Default Comm Window / Schedule</label>
            <input type="text" id="set-schedule" value="${defaultSchedule}">
          </div>
          <div class="form-group">
            <label>Default Crypto / Authentication</label>
            <input type="text" id="set-crypto" value="${defaultCrypto}">
          </div>
        </div>
        <div class="form-group" style="margin-top: 1rem;">
          <label>Default Document Classification</label>
          <select id="set-classification">
            <option value="UNCLASSIFIED" ${pdfClassification === 'UNCLASSIFIED' ? 'selected' : ''}>UNCLASSIFIED</option>
            <option value="UNCLASSIFIED // FOR OFFICIAL USE ONLY" ${pdfClassification === 'UNCLASSIFIED // FOR OFFICIAL USE ONLY' ? 'selected' : ''}>UNCLASSIFIED // FOR OFFICIAL USE ONLY</option>
            <option value="CONFIDENTIAL" ${pdfClassification === 'CONFIDENTIAL' ? 'selected' : ''}>CONFIDENTIAL</option>
            <option value="SECRET" ${pdfClassification === 'SECRET' ? 'selected' : ''}>SECRET</option>
            <option value="TOP SECRET" ${pdfClassification === 'TOP SECRET' ? 'selected' : ''}>TOP SECRET</option>
          </select>
        </div>
        <button type="submit" class="btn btn-primary" id="btn-save-settings" style="margin-top: 1.5rem;">Save Settings</button>
      </form>
    </div>

    <div class="panel" style="margin-top: 2rem;">
      <h3>Data Management</h3>
      <p class="text-muted" style="margin-bottom: 1rem;">Export your offline data to a JSON backup, or restore a previous state. Warning: Wiping data is irreversible.</p>
      <div class="portability-actions" style="margin-bottom: 1.5rem;">
        <button class="btn" id="btn-backup"><i data-lucide="save" class="tactical-icon"></i> Backup Data</button>
        <button class="btn" id="btn-restore"><i data-lucide="upload-cloud" class="tactical-icon"></i> Restore Data</button>
        <input type="file" id="input-restore" accept=".json" style="display: none;">
      </div>
      <div style="border-top: 1px solid var(--surface-border); padding-top: 1.5rem;">
        <button class="btn" id="btn-wipe-data" style="background: #aa0000; color: white; border: 1px solid #ff0000;"><i data-lucide="alert-triangle" class="tactical-icon"></i> WIPE ALL DATA</button>
      </div>
    </div>

    <div class="panel" style="margin-top: 2rem;">
      <h3>Legal & Privacy</h3>
      <p class="text-muted" style="margin-bottom: 1rem;">View our data policies and terms of usage.</p>
      <div style="display: flex; gap: 1rem;">
        <button class="btn btn-secondary" id="btn-privacy">Privacy Policy</button>
        <button class="btn btn-secondary" id="btn-tos">Terms of Service</button>
      </div>
    </div>
    
    <div style="text-align: center; margin-top: 3rem; color: var(--text-muted); font-size: 0.85rem; letter-spacing: 0.05em; opacity: 0.6;">
      BUILT AND DESIGNED BY <strong style="color: var(--primary-accent);">PINEFORGE DIGITAL</strong><br>
      <span style="font-family: monospace; font-size: 0.75rem; margin-top: 0.5rem; display: inline-block;">v${appVersion}</span>
    </div>
  `;

  const form = container.querySelector('#form-settings');
  addCleanupListener(form, 'submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-save-settings');
    btn.textContent = 'Saving...';
    btn.disabled = true;

    await db.saveSetting('userCallSign', document.getElementById('set-callsign').value);
    await db.saveSetting('defaultNCS', document.getElementById('set-ncs').value);
    await db.saveSetting('defaultSchedule', document.getElementById('set-schedule').value);
    await db.saveSetting('defaultCrypto', document.getElementById('set-crypto').value);
    await db.saveSetting('pdfClassification', document.getElementById('set-classification').value);

    setTimeout(() => {
      btn.textContent = 'Saved!';
      btn.className = 'btn btn-primary';
      setTimeout(() => {
        btn.textContent = 'Save Settings';
        btn.disabled = false;
        btn.className = 'btn btn-primary';
      }, 2000);
    }, 1000);
  });

  const btnBackup = container.querySelector('#btn-backup');
  addCleanupListener(btnBackup, 'click', async () => {
    await db.exportDatabase();
  });

  const btnRestore = container.querySelector('#btn-restore');
  const inputRestore = container.querySelector('#input-restore');
  addCleanupListener(btnRestore, 'click', () => {
    inputRestore.click();
  });

  addCleanupListener(inputRestore, 'change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await db.importDatabase(file);
      window.sysAlert("Database restored successfully.");
      renderSettings(container);
    } catch (err) {
      console.error(err);
      window.sysAlert("Failed to restore database. Invalid or corrupted JSON file.");
    }
  });

  const btnWipe = container.querySelector('#btn-wipe-data');
  addCleanupListener(btnWipe, 'click', () => {
    const dialog = document.createElement('dialog');
    dialog.className = 'global-modal';
    dialog.style.maxWidth = '400px';
    
    dialog.innerHTML = `
      <h3 style="color: #ff5500; margin-top: 0; font-family: var(--font-heading);">EMERGENCY DATA WIPE</h3>
      <p style="color: var(--text-muted); font-size: 0.95rem; margin-bottom: 1.5rem;">This will irreversibly destroy all local PACE Plans, Tactical Reports, Personnel, and Radio data. This action cannot be undone.</p>
      <p style="color: var(--text-main); font-size: 0.95rem; font-weight: bold; margin-bottom: 0.5rem; text-align: center;">Type CONFIRM below to execute:</p>
      <input type="text" id="wipe-confirm-input" style="width: 100%; margin-bottom: 1.5rem; text-align: center; text-transform: uppercase;" autocomplete="off" placeholder="...">
      <div style="display: flex; gap: 1rem; justify-content: space-between;">
        <button class="btn cancel-btn" id="btn-cancel-wipe" style="flex: 1;">Cancel</button>
        <button class="btn" id="btn-execute-wipe" style="flex: 1; background: #a00; color: white; border: 1px solid #f00;" disabled>EXECUTE WIPE</button>
      </div>
    `;
    
    document.body.appendChild(dialog);
    dialog.showModal();
    
    const input = dialog.querySelector('#wipe-confirm-input');
    const btnExecute = dialog.querySelector('#btn-execute-wipe');
    
    input.addEventListener('input', (e) => {
      if (e.target.value.toUpperCase() === 'CONFIRM') {
        btnExecute.disabled = false;
      } else {
        btnExecute.disabled = true;
      }
    });
    
    dialog.querySelector('#btn-cancel-wipe').addEventListener('click', () => {
      dialog.close();
      dialog.remove();
    });
    
    btnExecute.addEventListener('click', async () => {
      dialog.close();
      dialog.remove();
      await db.wipeDatabase();
    });
  });

  const showLegalModal = (title, htmlContent) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'global-modal';
    dialog.style.maxWidth = '600px';
    dialog.style.maxHeight = '80vh';
    dialog.style.overflowY = 'auto';
    dialog.style.padding = '2rem';
    
    dialog.innerHTML = `
      <h3 style="margin-top:0; color: var(--text-main); font-family: var(--font-heading); border-bottom: 1px solid var(--surface-border); padding-bottom: 1rem; margin-bottom: 1rem;">${title}</h3>
      <div style="color: var(--text-muted); font-size: 0.95rem; line-height: 1.6; margin-bottom: 2rem;">
        ${htmlContent}
      </div>
      <div style="display: flex; justify-content: flex-end;">
        <button class="btn btn-primary btn-close">Close</button>
      </div>
    `;
    
    document.body.appendChild(dialog);
    dialog.showModal();
    
    dialog.querySelector('.btn-close').addEventListener('click', () => {
      dialog.close();
      dialog.remove();
    });
  };

  const privacyBtn = container.querySelector('#btn-privacy');
  if(privacyBtn) {
    addCleanupListener(privacyBtn, 'click', () => {
      showLegalModal("Privacy Policy", `
        <p><strong>Offline-First Data Storage</strong></p>
        <p>PACE Builder is designed with strict data privacy in mind. This application functions entirely offline-first. All operational data, personnel files, comms settings, and PACE plans you generate are stored <strong>locally on your device</strong> within your browser's IndexedDB database.</p>
        <p><strong>Data Collection & Tracking</strong></p>
        <p>We do not remotely track, collect, upload, or have access to any of the sensitive operational data you input into this application. "What happens on your device, stays on your device."</p>
        <p>We use standard web analytics (like Vercel Analytics) to track anonymized page views and general performance metrics purely for maintenance and improvement of the application wrapper itself. This data never includes user input.</p>
      `);
    });
  }

  const tosBtn = container.querySelector('#btn-tos');
  if(tosBtn) {
    addCleanupListener(tosBtn, 'click', () => {
      showLegalModal("Terms of Service", `
        <p><strong>1. Acceptance of Terms</strong></p>
        <p>By using PACE Builder, you agree to these Terms. If you do not agree, do not use the tool.</p>
        <p><strong>2. No Liability for Tactical Use</strong></p>
        <p>PACE Builder is provided "as-is" as a planning and administrative utility. The developers assume <strong>NO LIABILITY</strong> for mission failure, communication loss, injury, or death resulting from the use of this application in real-world scenarios. You are solely responsible for validating all comms plans and ensuring your equipment functions properly in the field.</p>
        <p><strong>3. Data Security Responsibility</strong></p>
        <p>Because all data is stored locally on your device, you are entirely responsible for the physical security of your device and the operational security of the exported PDFs/files.</p>
      `);
    });
  }
}

// --- Tactical Map ---
export async function renderMap(container) {
  cleanupListeners();

  container.innerHTML = `
    <h2>Tactical Map</h2>
    <div class="panel" style="padding: 0; position: relative; overflow: hidden; border-radius: 8px;">
      <div class="map-toolbar">
        <button id="tool-pan" class="active" title="Pan Map"><i data-lucide="mouse-pointer-2"></i></button>
        <button id="tool-waypoint" title="Drop Waypoint"><i data-lucide="map-pin"></i></button>
        <button id="tool-line" title="Draw Phase Line"><i data-lucide="activity"></i></button>
        <div style="width: 1px; height: 20px; background: rgba(255,255,255,0.2); margin: 0 4px;"></div>
        <button id="tool-export" title="Export Image"><i data-lucide="camera"></i></button>
      </div>
      <div id="map-container" style="width: 100%; height: 60vh; min-height: 400px; background-color: #222; position: relative;">
        <!-- Permanent Map Key -->
        <div id="map-export-key" style="position: absolute; bottom: 20px; left: 20px; z-index: 1000; background: rgba(0,0,0,0.8); border: 1px solid var(--primary); border-radius: 8px; padding: 10px; color: #fff; font-family: monospace; font-size: 11px; max-width: 300px; max-height: 80%; overflow: hidden; display: none;">
          <h4 style="margin: 0 0 5px 0; color: var(--primary); font-family: 'Outfit', sans-serif;">Tactical Feature Key</h4>
          <div id="map-export-key-content"></div>
        </div>
      </div>
    </div>

    <!-- Map Feature Modal -->
    <dialog id="modal-map-feature">
      <h3 id="modal-map-title">Name Tactical Feature</h3>
      <form id="form-map-feature">
        <div class="form-group">
          <label>Designation / Name</label>
          <input type="text" id="map-feature-name" required autocomplete="off">
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn cancel-btn" id="btn-cancel-feature">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Feature</button>
        </div>
      </form>
    </dialog>

    <!-- Map Feature Action Modal -->
    <dialog id="modal-feature-action">
      <h3 id="modal-action-title">Feature Options</h3>
      <div class="dialog-actions" style="justify-content: center; gap: 10px; margin-top: 20px;">
        <button type="button" class="btn btn-secondary" id="btn-action-rename">Rename</button>
        <button type="button" class="btn btn-danger" id="btn-action-delete">Delete</button>
        <button type="button" class="btn cancel-btn" id="btn-action-cancel">Cancel</button>
      </div>
    </dialog>
  `;

  if (window.lucide) window.lucide.createIcons();

  // We need to wait a tick for the DOM to render the #map-container before initializing Leaflet
  setTimeout(async () => {
    const mapElement = document.getElementById('map-container');
    if (!mapElement) return;

    // Default center (null island)
    let centerLat = 0;
    let centerLng = 0;
    let initialZoom = 2;

    // Fetch location cache from db
    const locations = await db.db.locationCache.orderBy('timestamp').reverse().toArray();

    if (locations && locations.length > 0) {
      centerLat = locations[0].latitude;
      centerLng = locations[0].longitude;
      initialZoom = 14;
    }

    if (!L) {
      console.warn('Leaflet not loaded.');
      mapElement.innerHTML = '<div style="padding: 2rem; text-align: center;">Map engine not available offline.</div>';
      return;
    }

    const map = L.map('map-container', { doubleClickZoom: false, preferCanvas: true }).setView([centerLat, centerLng], initialZoom);

    // Use a high-contrast dark tile layer for the premium tactical UI
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
      crossOrigin: true
    }).addTo(map);

    // Plot all cached GPS pings as small subtle circles instead of big markers
    locations.forEach(loc => {
      const date = new Date(loc.timestamp).toLocaleString();
      L.circleMarker([loc.latitude, loc.longitude], {
        radius: 4,
        color: '#f97316',
        fillColor: '#f97316',
        fillOpacity: 0.5,
        weight: 1
      })
      .addTo(map)
      .bindPopup(`<b>GPS Ping</b><br>${date}<br>Acc: ${Math.round(loc.accuracy)}m`);
    });

    const mapFeatureGroup = L.featureGroup().addTo(map);

    const keyOverlay = document.getElementById('map-export-key');
    const keyContent = document.getElementById('map-export-key-content');

    const updateMapKey = async () => {
      const currentFeatures = await db.getAllMapFeatures();
      if (currentFeatures.length > 0) {
        let html = '<table style="width: 100%; border-collapse: collapse;">';
        currentFeatures.forEach(f => {
          let coordsStr = '';
          if (f.type === 'waypoint') {
            coordsStr = `${f.coordinates[0].toFixed(5)}, ${f.coordinates[1].toFixed(5)}`;
          } else if (f.type === 'line') {
            coordsStr = `${f.coordinates.length} pts`;
          }
          html += `<tr><td style="padding-right: 10px;"><strong>${f.name}</strong></td><td>${coordsStr}</td></tr>`;
        });
        html += '</table>';
        keyContent.innerHTML = html;
        keyOverlay.style.display = 'block';
      } else {
        keyOverlay.style.display = 'none';
      }
    };

    // Drawing Engine State
    let currentMode = 'pan'; // pan, waypoint, line
    let activePolyline = null;
    let activePoints = [];

    const btnPan = document.getElementById('tool-pan');
    const btnWaypoint = document.getElementById('tool-waypoint');
    const btnLine = document.getElementById('tool-line');

    const finishPhaseLine = async () => {
      if (currentMode === 'line' && activePoints.length > 1) {
        const name = await promptFeatureName("Enter Phase Line Name:");
        if (name) {
          const feature = { type: 'line', name, coordinates: [...activePoints] };
          const id = await db.addMapFeature(feature);
          feature.id = id;
          
          const line = L.polyline(feature.coordinates, { color: '#ea580c', weight: 4 }).addTo(mapFeatureGroup).bindTooltip(feature.name, { permanent: true, direction: 'center' });
          bindFeatureClick(line, feature);
          updateMapKey();
        }
      }
      
      if (activePolyline) {
        map.removeLayer(activePolyline);
        activePolyline = null;
      }
      activePoints = [];
    };

    const updateToolbar = async (mode) => {
      if (currentMode === 'line' && mode !== 'line' && activePoints.length > 1) {
        await finishPhaseLine();
      } else if (mode !== 'line' && activePolyline) {
        map.removeLayer(activePolyline);
        activePolyline = null;
        activePoints = [];
      }

      currentMode = mode;
      btnPan.classList.toggle('active', mode === 'pan');
      btnWaypoint.classList.toggle('active', mode === 'waypoint');
      btnLine.classList.toggle('active', mode === 'line');
      
      mapElement.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
    };

    addCleanupListener(btnPan, 'click', () => updateToolbar('pan'));
    addCleanupListener(btnWaypoint, 'click', () => updateToolbar('waypoint'));
    addCleanupListener(btnLine, 'click', () => updateToolbar('line'));

    const btnExport = document.getElementById('tool-export');
    addCleanupListener(btnExport, 'click', async () => {
      btnExport.innerHTML = '<i data-lucide="loader" class="spin"></i>';
      if (window.lucide) window.lucide.createIcons();
      
      const keyOverlay = document.getElementById('map-export-key');
      const keyContent = document.getElementById('map-export-key-content');
      
      try {
        if (mapFeatureGroup.getLayers().length > 0) {
          map.fitBounds(mapFeatureGroup.getBounds(), { padding: [50, 50], animate: false });
          await new Promise(r => setTimeout(r, 1000));
        }

        const canvas = await html2canvas(mapElement, {
          useCORS: true,
          allowTaint: false,
          backgroundColor: '#222'
        });
        
        const link = document.createElement('a');
        link.download = `tactical_map_export_${Date.now()}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
      } catch (err) {
        console.error(err);
        await window.sysAlert("Failed to export map image. Please ensure you are online for external map tiles to render.", "Export Error");
      } finally {
        btnExport.innerHTML = '<i data-lucide="camera"></i>';
        if (window.lucide) window.lucide.createIcons();
      }
    });

    // Render Saved Features
    const savedFeatures = await db.getAllMapFeatures();
    
    const bindFeatureClick = (layer, feature) => {
      layer.on('click', async (e) => {
        if (currentMode !== 'pan') return;
        L.DomEvent.stopPropagation(e);
        
        const action = await promptFeatureAction(feature.name);
        if (action === 'delete') {
          if (await window.sysConfirm(`Permanently delete tactical feature: ${feature.name}?`)) {
            await db.deleteMapFeature(feature.id);
            mapFeatureGroup.removeLayer(layer);
            updateMapKey();
          }
        } else if (action === 'rename') {
          const newName = await promptFeatureName("Rename Feature:", feature.name);
          if (newName && newName !== feature.name) {
            feature.name = newName;
            await db.updateMapFeature(feature.id, feature);
            layer.setTooltipContent(newName);
            updateMapKey();
          }
        }
      });
    };

    const createTacticalIcon = () => {
      return L.divIcon({
        className: 'custom-tactical-marker',
        html: '<div style="background-color: #f97316; width: 16px; height: 16px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 8px rgba(249,115,22,0.8);"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });
    };

    savedFeatures.forEach(f => {
      if (f.type === 'waypoint') {
        const marker = L.marker(f.coordinates, { icon: createTacticalIcon() }).addTo(mapFeatureGroup).bindTooltip(f.name, { permanent: true, direction: 'top' });
        bindFeatureClick(marker, f);
      } else if (f.type === 'line') {
        const line = L.polyline(f.coordinates, { color: '#ea580c', weight: 4 }).addTo(mapFeatureGroup).bindTooltip(f.name, { permanent: true, direction: 'center' });
        bindFeatureClick(line, f);
      }
    });

    updateMapKey(); // Initial render

    const modalFeature = container.querySelector('#modal-map-feature');
    const formFeature = container.querySelector('#form-map-feature');
    const inputFeature = container.querySelector('#map-feature-name');
    const titleFeature = container.querySelector('#modal-map-title');
    const btnCancelFeature = container.querySelector('#btn-cancel-feature');

    const promptFeatureName = (title, initialValue = "") => {
      return new Promise((resolve) => {
        titleFeature.textContent = title;
        inputFeature.value = initialValue;
        modalFeature.showModal();
        setTimeout(() => inputFeature.focus(), 50);
        
        const cleanup = () => {
          formFeature.removeEventListener('submit', onSubmit);
          btnCancelFeature.removeEventListener('click', onCancel);
          modalFeature.close();
        };

        const onSubmit = (e) => {
          e.preventDefault();
          const val = inputFeature.value.trim();
          cleanup();
          resolve(val || null);
        };

        const onCancel = () => {
          cleanup();
          resolve(null);
        };

        formFeature.addEventListener('submit', onSubmit);
        btnCancelFeature.addEventListener('click', onCancel);
      });
    };

    const promptFeatureAction = (featureName) => {
      return new Promise((resolve) => {
        const modal = container.querySelector('#modal-feature-action');
        modal.querySelector('#modal-action-title').textContent = `${featureName}`;
        
        const btnRename = modal.querySelector('#btn-action-rename');
        const btnDelete = modal.querySelector('#btn-action-delete');
        const btnCancel = modal.querySelector('#btn-action-cancel');
        
        const cleanup = () => {
          btnRename.removeEventListener('click', onRename);
          btnDelete.removeEventListener('click', onDelete);
          btnCancel.removeEventListener('click', onCancel);
          modal.close();
        };
        
        const onRename = () => { cleanup(); resolve('rename'); };
        const onDelete = () => { cleanup(); resolve('delete'); };
        const onCancel = () => { cleanup(); resolve(null); };
        
        btnRename.addEventListener('click', onRename);
        btnDelete.addEventListener('click', onDelete);
        btnCancel.addEventListener('click', onCancel);
        
        modal.showModal();
      });
    };

    // Map Click Handler for Drawing
    map.on('click', async (e) => {
      if (currentMode === 'pan') return;

      if (currentMode === 'waypoint') {
        const name = await promptFeatureName("Enter Waypoint Name:");
        if (!name) return;
        
        const feature = { type: 'waypoint', name, coordinates: [e.latlng.lat, e.latlng.lng] };
        const id = await db.addMapFeature(feature);
        feature.id = id;
        
        const marker = L.marker(feature.coordinates, { icon: createTacticalIcon() }).addTo(mapFeatureGroup).bindTooltip(feature.name, { permanent: true, direction: 'top' });
        bindFeatureClick(marker, feature);
        updateMapKey();
        
        updateToolbar('pan'); // auto-switch back to pan
      }
      else if (currentMode === 'line') {
        activePoints.push([e.latlng.lat, e.latlng.lng]);
        
        if (!activePolyline) {
          activePolyline = L.polyline(activePoints, { color: '#ea580c', weight: 4, dashArray: '10, 10' }).addTo(map);
        } else {
          activePolyline.setLatLngs(activePoints);
        }
      }
    });

    // Right-Click (ContextMenu) to finish lines
    map.on('contextmenu', async (e) => {
      if (currentMode === 'line' && activePoints.length > 1) {
        await finishPhaseLine();
        updateToolbar('pan');
      }
    });

  }, 100);
}
