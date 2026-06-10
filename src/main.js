import * as db from './db.js';
import * as views from './views.js';
import { initLocationEngine } from './locationEngine.js';
import 'leaflet/dist/leaflet.css';

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
        const confirmLeave = confirm("You have unsaved planning data. Leave anyway?");
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
    default:
      contentArea.innerHTML = `<h2>Error</h2><p>View not found.</p>`;
  }
  
  if (window.lucide) window.lucide.createIcons();
}


