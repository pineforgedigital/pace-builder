import pdfMake from 'pdfmake/build/pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts';
import QRCode from 'qrcode';
import { db } from './db.js';
import { generateHandoverPayload } from './qrEngine.js';

// Configure virtual file system for fonts
if (pdfFonts && pdfFonts.pdfMake) {
  pdfMake.vfs = pdfFonts.pdfMake.vfs;
} else if (pdfFonts && pdfFonts.vfs) {
  pdfMake.vfs = pdfFonts.vfs;
}

/**
 * Resolves Personnel and Radio data for a specific slot.
 */
async function resolveSlotData(slotConfig) {
  if (!slotConfig) {
    return { personnel: null, radio: null, notes: '' };
  }
  
  const personnel = slotConfig.personnelId ? await db.personnel.get(slotConfig.personnelId) : null;
  const radio = slotConfig.radioId ? await db.commsLocker.get(slotConfig.radioId) : null;
  
  return { personnel, radio, notes: slotConfig.notes || '' };
}

/**
 * Formats a slot row for the PDF matrix table.
 */
function buildMatrixRow(slotName, resolvedData) {
  const p = resolvedData.personnel;
  const r = resolvedData.radio;
  
  return [
    { text: slotName, style: 'slotName' },
    p ? `${p.name}\n(${p.role || 'Operator'})` : 'N/A',
    p ? { text: p.callSign, style: 'callSign' } : 'N/A',
    r ? r.hardwareModel : 'N/A',
    r ? `${r.frequency} / ${r.supportedBand || 'UNKNOWN'}` : 'N/A',
    r ? `${r.tones || 'None'}\nPwr: ${r.powerOutput || 'N/A'}` : 'N/A'
  ];
}

/**
 * Generates and downloads the PACE PDF.
 */
export async function generatePacePDF(planId) {
  // 1. Fetch the Plan
  const plan = await db.pacePlans.get(planId);
  if (!plan) throw new Error("PACE Plan not found");

  // 2. Resolve relational data for all slots
  const primaryData = await resolveSlotData(plan.primarySlot);
  const alternateData = await resolveSlotData(plan.alternateSlot);
  const contingencyData = await resolveSlotData(plan.contingencySlot);
  const emergencyData = await resolveSlotData(plan.emergencySlot);

  // 3. Document Definition
  const content = [];

  // Header
  content.push({ text: 'UNCLASSIFIED // FOR OFFICIAL USE ONLY', style: 'classification' });
  content.push({ text: 'COMMUNICATIONS PLAN (PACE)', style: 'header' });

  // Metadata Block
  content.push({
    style: 'metadata',
    table: {
      widths: ['*', '*', '*'],
      body: [
        [
          { stack: [{ text: 'PLAN NAME', style: 'metaLabel' }, { text: plan.planName || 'N/A', style: 'metaValue' }] },
          { stack: [{ text: 'SCENARIO TYPE', style: 'metaLabel' }, { text: plan.scenarioType || 'N/A', style: 'metaValue' }] },
          { stack: [{ text: 'DATE CREATED', style: 'metaLabel' }, { text: new Date(plan.dateCreated).toLocaleString(), style: 'metaValue' }] }
        ],
        [
          { stack: [{ text: 'NET CONTROL STATION (NCS)', style: 'metaLabel' }, { text: plan.ncs || 'N/A', style: 'metaValue' }] },
          { stack: [{ text: 'COMM WINDOW / SCHEDULE', style: 'metaLabel' }, { text: plan.schedule || 'N/A', style: 'metaValue' }] },
          { stack: [{ text: 'AUTHENTICATION / CRYPTO', style: 'metaLabel' }, { text: plan.crypto || 'N/A', style: 'metaValue' }] }
        ],
        [
          { stack: [{ text: 'NO-COMM FALLBACK PROCEDURE', style: 'metaLabel' }, { text: plan.fallback || 'N/A', style: 'metaValue' }], colSpan: 3 },
          {},
          {}
        ]
      ]
    },
    layout: {
      hLineWidth: function (i, node) { return (i === 0 || i === node.table.body.length) ? 2 : 1; },
      vLineWidth: function (i, node) { return 0; },
      hLineColor: function (i, node) { return '#333333'; },
      paddingLeft: function(i, node) { return 0; },
      paddingRight: function(i, node) { return 0; },
      paddingTop: function(i, node) { return 5; },
      paddingBottom: function(i, node) { return 5; }
    }
  });

  // Conditional Infrastructure Warning
  const infraLower = (plan.infrastructureStatus || '').toLowerCase();
  if (infraLower.includes('repeater')) {
    content.push({
      text: 'WARNING: Infrastructure status indicates reliance on repeaters. Ensure simplex backups are established and tested.',
      style: 'warning'
    });
  } else if (plan.infrastructureStatus) {
    content.push({
      text: `Infrastructure Status: ${plan.infrastructureStatus}`,
      margin: [0, 10, 0, 10]
    });
  }

  // The Matrix
  content.push({
    style: 'matrix',
    table: {
      headerRows: 1,
      widths: ['auto', '*', 'auto', '*', '*', 'auto'],
      body: [
        // Headers
        [
          { text: 'SLOT', style: 'tableHeader' },
          { text: 'OPERATOR', style: 'tableHeader' },
          { text: 'CALL SIGN', style: 'tableHeader' },
          { text: 'HARDWARE', style: 'tableHeader' },
          { text: 'FREQ / BAND', style: 'tableHeader' },
          { text: 'TONES / CONFIG', style: 'tableHeader' }
        ],
        // Rows
        buildMatrixRow('P - Primary', primaryData),
        buildMatrixRow('A - Alternate', alternateData),
        buildMatrixRow('C - Contingency', contingencyData),
        buildMatrixRow('E - Emergency', emergencyData)
      ]
    },
    layout: {
      fillColor: function (rowIndex, node, columnIndex) {
        return (rowIndex === 0) ? '#2d2d2d' : (rowIndex % 2 === 0) ? '#f5f5f5' : null;
      },
      hLineWidth: function (i, node) { return (i === 0 || i === 1 || i === node.table.body.length) ? 2 : 1; },
      vLineWidth: function (i, node) { return 0; },
      hLineColor: function (i, node) { return '#2d2d2d'; },
      paddingTop: function(i, node) { return 8; },
      paddingBottom: function(i, node) { return 8; }
    }
  });

  // Notes Section
  content.push({ text: 'Operational Notes & RV Points:', style: 'notesHeader' });
  const notesBody = [];
  
  const formatNote = (slotName, data) => {
    let noteText = data.notes || '';
    let rvText = data.personnel?.rendezvousPoint || '';
    if (!noteText && !rvText) return null;
    let combined = `${slotName}: `;
    if (noteText) combined += `${noteText} `;
    if (rvText) combined += `[RV: ${rvText}]`;
    return combined.trim();
  };

  const pNote = formatNote('Primary', primaryData);
  if (pNote) notesBody.push(pNote);
  
  const aNote = formatNote('Alternate', alternateData);
  if (aNote) notesBody.push(aNote);
  
  const cNote = formatNote('Contingency', contingencyData);
  if (cNote) notesBody.push(cNote);
  
  const eNote = formatNote('Emergency', emergencyData);
  if (eNote) notesBody.push(eNote);
  
  if (notesBody.length > 0) {
    content.push({ ul: notesBody, margin: [0, 5, 0, 0] });
  } else {
    content.push({ text: 'None', italics: true, margin: [0, 5, 0, 0] });
  }

  // Generate QR Code for Air-Gap Handover
  try {
    const payloadStr = await generateHandoverPayload(planId);
    const qrDataUrl = await QRCode.toDataURL(payloadStr, { width: 400, margin: 1 });
    
    content.push({
      columns: [
        { 
          text: 'Air-Gap Handover:\nScan with Pace Builder app to securely import this PACE plan without an internet connection.', 
          width: '*', 
          style: 'qrCaption', 
          margin: [0, 50, 0, 0] 
        },
        { image: qrDataUrl, width: 180, alignment: 'right' }
      ],
      margin: [0, 30, 0, 0]
    });
  } catch (err) {
    console.error("Failed to generate QR for PDF", err);
  }

  // Classification Footer
  content.push({ text: 'UNCLASSIFIED // FOR OFFICIAL USE ONLY', style: 'classification', margin: [0, 20, 0, 0] });

  const docDefinition = {
    content: content,
    styles: {
      classification: {
        fontSize: 10,
        bold: true,
        alignment: 'center',
        color: '#d32f2f',
        margin: [0, 0, 0, 10]
      },
      header: {
        fontSize: 22,
        bold: true,
        alignment: 'center',
        color: '#1a1a1a',
        margin: [0, 0, 0, 20]
      },
      metadata: {
        margin: [0, 0, 0, 20]
      },
      metaLabel: {
        fontSize: 8,
        color: '#555555',
        bold: true,
        margin: [0, 0, 0, 2]
      },
      metaValue: {
        fontSize: 11,
        color: '#000000',
        bold: true
      },
      warning: {
        fontSize: 12,
        bold: true,
        color: 'black',
        background: '#fff3e0',
        margin: [0, 10, 0, 20],
        padding: 8
      },
      matrix: {
        margin: [0, 0, 0, 25]
      },
      tableHeader: {
        bold: true,
        fontSize: 10,
        color: 'white',
        margin: [0, 2, 0, 2]
      },
      slotName: {
        bold: true,
        color: '#1a1a1a'
      },
      callSign: {
        bold: true,
        background: '#e0e0e0'
      },
      notesHeader: {
        fontSize: 14,
        bold: true,
        color: '#1a1a1a',
        margin: [0, 10, 0, 8]
      },
      qrCaption: {
        fontSize: 9,
        italics: true,
        color: '#555555'
      }
    },
    defaultStyle: {
      fontSize: 10,
      color: '#333333'
    }
  };

  // 4. Trigger Download
  const safeName = plan.planName.replace(/[^a-z0-9]/gi, '_');
  const filename = `PACE_Plan_${safeName}.pdf`;
  
  pdfMake.createPdf(docDefinition).download(filename);
}

/**
 * Generates and downloads a Tactical Report PDF.
 */
export async function generateReportPDF(reportType, rawPayload, compiledScript) {
  const content = [];

  // Header
  content.push({ text: `TACTICAL TRANSMISSION: ${reportType}`, style: 'header' });

  // Metadata Block
  content.push({
    style: 'metadata',
    table: {
      widths: ['*', '*'],
      body: [
        [
          { text: `Report Type:\n${reportType}`, style: 'metaCell' },
          { text: `Date Generated:\n${new Date().toLocaleString()}`, style: 'metaCell' }
        ]
      ]
    },
    layout: 'lightHorizontalLines'
  });

  // Raw Data Block
  content.push({ text: 'Raw Payload Data:', style: 'notesHeader' });
  const dataList = [];
  for (const [key, value] of Object.entries(rawPayload)) {
    if (value) {
      const displayKey = key.replace(/([A-Z])/g, ' $1').toUpperCase();
      dataList.push(`${displayKey}: ${value}`);
    }
  }
  content.push({ ul: dataList.length > 0 ? dataList : ['No data provided.'], margin: [0, 5, 0, 20] });

  // Phonetic Script Block
  content.push({ text: 'Phonetic Transmission Script:', style: 'notesHeader' });
  content.push({
    text: compiledScript,
    style: 'teleprompter'
  });

  const docDefinition = {
    content: content,
    styles: {
      header: {
        fontSize: 20,
        bold: true,
        alignment: 'center',
        margin: [0, 0, 0, 20]
      },
      metadata: {
        margin: [0, 0, 0, 15]
      },
      metaCell: {
        fontSize: 10,
        bold: true
      },
      notesHeader: {
        fontSize: 14,
        bold: true,
        margin: [0, 10, 0, 5]
      },
      teleprompter: {
        fontSize: 12,
        bold: true,
        background: '#eeeeee',
        padding: 10,
        margin: [0, 5, 0, 0]
      }
    },
    defaultStyle: {
      fontSize: 10
    }
  };

  const filename = `${reportType}_REPORT_${Date.now()}.pdf`;
  pdfMake.createPdf(docDefinition).download(filename);
}
