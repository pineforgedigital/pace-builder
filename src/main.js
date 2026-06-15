import * as db from './db.js';
import * as views from './views.js';
import { initLocationEngine } from './locationEngine.js';
import 'leaflet/dist/leaflet.css';
import { inject as injectAnalytics } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';

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
    link.addEventListener('click', (e) => {
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


