import * as db from './db.js';
import * as views from './views.js';
import { initLocationEngine } from './locationEngine.js';
import 'leaflet/dist/leaflet.css';
import { inject as injectAnalytics } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';
import { registerSW } from 'virtual:pwa-register';

// PWA Auto-Update & Connection Polling
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(swUrl, r) {
    // 1. Constantly ping for the latest version while online (every 60 seconds)
    r && setInterval(async () => {
      if (!(!r.installing && navigator)) return;
      if (('connection' in navigator) && !navigator.onLine) return;
      
      try {
        const resp = await fetch(swUrl, { cache: 'no-store', headers: { 'cache': 'no-store', 'cache-control': 'no-cache' } });
        if (resp?.status === 200) await r.update();
      } catch (err) { /* offline or failed ping */ }
    }, 60000);

    // 2. Ping immediately when internet connection is re-established
    window.addEventListener('online', async () => {
      if (Notification && Notification.permission === 'granted') {
        new Notification('🟢 UPLINK ESTABLISHED', {
          body: 'Signal acquired. Checking for PACE Builder updates...',
          icon: '/favicon.svg'
        });
      }

      if (r) {
        try {
          const resp = await fetch(swUrl, { cache: 'no-store', headers: { 'cache': 'no-store', 'cache-control': 'no-cache' } });
          if (resp?.status === 200) await r.update();
        } catch (err) { /* failed ping */ }
      }
    });
  },
  onNeedRefresh() {
    // Force a reload when the SW detects and downloads a new version
    window.location.reload(true);
  }
});

window.sysAlert = (message, title = "System Alert") => {
  return new Promise((resolve) => {
    const modal = document.getElementById('sys-alert-modal');
    document.getElementById('sys-alert-title').textContent = title;
    document.getElementById('sys-alert-message').textContent = message;
    const btnOk = document.getElementById('sys-alert-ok');
    const onOk = () => { btnOk.removeEventListener('click', onOk); modal.close(); resolve(); };
    btnOk.addEventListener('click', onOk);
    modal.showModal();
    btnOk.focus();
  });
};

window.sysConfirm = (message, title = "Confirm Action") => {
  return new Promise((resolve) => {
    const modal = document.getElementById('sys-confirm-modal');
    document.getElementById('sys-confirm-title').textContent = title;
    document.getElementById('sys-confirm-message').textContent = message;
    const btnOk = document.getElementById('sys-confirm-ok');
    const btnCancel = document.getElementById('sys-confirm-cancel');
    const cleanup = () => {
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      modal.close();
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    modal.showModal();
  });
};

// Application State
const appState = {
  isOnline: navigator.onLine,
  currentView: 'dashboard',
  isDirty: false // Guard flag for unsaved form data
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  setupNetworkListeners();
  setupNavigation();
  initLocationEngine();
  loadView('dashboard');
  if (window.lucide) window.lucide.createIcons();

  // Inject Vercel Telemetry
  try {
    if (import.meta.env.PROD) {
      injectAnalytics();
      injectSpeedInsights();
    }
  } catch (error) {
    console.warn("Vercel telemetry disabled in local/offline environment.", error);
  }
});

// Network Status Monitor
function setupNetworkListeners() {
  const indicator = document.getElementById('network-status');
  
  const updateStatus = () => {
    appState.isOnline = navigator.onLine;
    if (indicator) {
      indicator.className = appState.isOnline ? 'status-online' : 'status-offline';
      indicator.textContent = appState.isOnline ? 'ONLINE' : 'OFFLINE';
    }
  };

  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);
  updateStatus(); // Initial check
}

// Navigation Event Handlers
function setupNavigation() {
  document.querySelectorAll('[data-target]').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const targetView = e.currentTarget.getAttribute('data-target');
      
      // State Guard Check
      if (appState.isDirty) {
        const confirmLeave = await window.sysConfirm("You have unsaved planning data. Leave anyway?");
        if (!confirmLeave) return;
        appState.isDirty = false;
      }
      
      loadView(targetView);
    });
  });
}

// Router Mechanism
async function loadView(viewName) {
  const contentArea = document.getElementById('app-content');
  if (!contentArea) return;
  
  appState.currentView = viewName;
  
  switch(viewName) {
    case 'dashboard':
      await views.renderDashboard(contentArea);
      break;
    case 'personnel':
      await views.renderPersonnel(contentArea);
      break;
    case 'comms':
      await views.renderComms(contentArea);
      break;
    case 'plans':
      await views.renderPacePlans(contentArea);
      break;
    case 'reports':
      await views.renderReportingEngine(contentArea);
      break;
    case 'map':
      await views.renderMap(contentArea);
      break;
    case 'settings':
      await views.renderSettings(contentArea);
      break;
    default:
      contentArea.innerHTML = `<h2>Error</h2><p>View not found.</p>`;
  }
  
  if (window.lucide) window.lucide.createIcons();
}

// ============================================================================
// NOTIFICATION SYSTEM & COMM WINDOW TRACKER
// ============================================================================
if (Notification && Notification.permission === 'default') {
  Notification.requestPermission();
}

setInterval(() => {
  if (Notification && Notification.permission === 'granted') {
    const alarms = JSON.parse(localStorage.getItem('pace_alarms') || '[]');
    const now = new Date().getTime();
    let updatedAlarms = [];
    let fired = false;

    alarms.forEach(alarm => {
      if (now >= alarm.timestamp) {
        new Notification('⚠️ COMM WINDOW ACTIVE', {
          body: `Scheduled Comms Window for ${alarm.planName} is now active.`,
          icon: '/favicon.svg'
        });
        fired = true;
      } else {
        updatedAlarms.push(alarm); // keep future alarms
      }
    });

    if (fired) {
      localStorage.setItem('pace_alarms', JSON.stringify(updatedAlarms));
    }
  }
}, 30000); // Check every 30 seconds
