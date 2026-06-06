const connectButton = document.getElementById('connect-button');
const exportButton = document.getElementById('export-button');
const exportPdfButton = document.getElementById('export-pdf-button');
const resetButton = document.getElementById('reset-button');
const installButton = document.getElementById('install-button');
const unsupportedMessage = document.getElementById('unsupported-message');
const connectionStatus = document.getElementById('connection-status');
const currentNoise = document.getElementById('current-noise');
const currentStatusLabel = document.getElementById('current-status');
const violationCount = document.getElementById('violation-count');
const quietScore = document.getElementById('quiet-score');
const lastAlert = document.getElementById('last-alert');
const activityLogBody = document.getElementById('activity-log-body');
const chartCanvas = document.getElementById('noise-chart');

let serialPort = null;
let serialReader = null;
let readActive = false;
let serialBuffer = '';
let latestDb = null;
let currentStatus = 'DISCONNECTED';
let violations = 0;
let score = 100;
let lastAlertTime = '--';
let activityLog = [];
let chartData = [];
let noiseChart = null;
let deferredInstallPrompt = null;

const STORAGE_KEY = 'smartLibraryQuietZone';

const statusStyles = {
  QUIET: { text: '🟢 QUIET', color: 'var(--green)' },
  MODERATE: { text: '🟡 MODERATE NOISE', color: 'var(--yellow)' },
  LOUD: { text: '🔴 EXCESSIVE NOISE', color: 'var(--red)' },
  NO_READING: { text: '⚪ No Reading', color: 'var(--muted)' },
  DISCONNECTED: { text: '🔴 DISCONNECTED', color: 'var(--red)' }
};

window.addEventListener('load', init);
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (installButton) {
    installButton.classList.remove('hidden');
  }
});
connectButton.addEventListener('click', () => {
  if (readActive) {
    disconnectArduino();
  } else {
    connectArduino();
  }
});
exportButton.addEventListener('click', exportCSV);
if (exportPdfButton) {
  exportPdfButton.addEventListener('click', exportPDF);
}
if (installButton) {
  installButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      console.log('User accepted the install prompt');
    }
    installButton.classList.add('hidden');
    deferredInstallPrompt = null;
  });
}
resetButton.addEventListener('click', resetStatistics);

async function init() {
  if (!('serial' in navigator)) {
    unsupportedMessage.classList.remove('hidden');
    connectButton.disabled = true;
  }
  registerServiceWorker();
  loadFromLocalStorage();
  createChart();
  renderActivityLog();
  updateDashboard();
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('service-worker.js');
      console.log('Service worker registered');
    } catch (error) {
      console.warn('Service worker registration failed:', error);
    }
  }
}

async function connectArduino() {
  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 9600 });
    connectionStatus.textContent = '🟢 Connected';
    connectionStatus.classList.remove('disconnected');
    connectionStatus.classList.add('connected');
    connectButton.textContent = 'Disconnect Arduino';
    readActive = true;
    currentStatus = 'QUIET';
    updateDashboard();
    readSerialData();
  } catch (error) {
    console.error('Serial connection failed:', error);
    disconnectArduino();
  }
}

async function disconnectArduino() {
  readActive = false;
  connectButton.textContent = 'Connect Arduino';
  connectionStatus.textContent = '🔴 Disconnected';
  connectionStatus.classList.remove('connected');
  connectionStatus.classList.add('disconnected');
  currentStatus = 'DISCONNECTED';
  if (serialReader) {
    try {
      await serialReader.cancel();
    } catch (error) {
      console.warn('Reader cancel failed:', error);
    }
    serialReader.releaseLock();
    serialReader = null;
  }
  if (serialPort) {
    try {
      await serialPort.close();
    } catch (error) {
      console.warn('Port close failed:', error);
    }
    serialPort = null;
  }
  updateDashboard();
}

async function readSerialData() {
  if (!serialPort || !serialPort.readable) {
    disconnectArduino();
    return;
  }

  const decoder = new TextDecoderStream();
  const readableStreamClosed = serialPort.readable.pipeTo(decoder.writable);
  serialReader = decoder.readable.getReader();

  try {
    while (readActive) {
      const { value, done } = await serialReader.read();
      if (done) break;
      if (typeof value !== 'string') continue;
      serialBuffer += value;
      const lines = serialBuffer.split(/\r?\n/);
      serialBuffer = lines.pop();
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine) {
          processSerialLine(trimmedLine);
        }
      }
    }
  } catch (error) {
    console.error('Serial read error:', error);
  } finally {
    if (serialReader) {
      serialReader.releaseLock();
      serialReader = null;
    }
    disconnectArduino();
  }
}

function processSerialLine(line) {
  if (line.startsWith('DB:')) {
    const value = parseInt(line.slice(3).trim(), 10);
    if (!Number.isNaN(value)) {
      latestDb = value;
      addChartPoint(value);
      currentNoise.textContent = `${value} dB`;
      saveToLocalStorage();
    }
  } else if (['QUIET', 'MODERATE', 'LOUD'].includes(line)) {
    currentStatus = line;
    if (line === 'LOUD') {
      addViolation();
    }
    updateDashboard();
  }
}

function updateDashboard() {
  const status = statusStyles[currentStatus] || statusStyles.DISCONNECTED;
  currentStatusLabel.textContent = status.text;
  currentStatusLabel.style.color = status.color;
  currentNoise.textContent = latestDb !== null ? `${latestDb} dB` : '-- dB';
  violationCount.textContent = violations;
  quietScore.textContent = `${score}%`;
  lastAlert.textContent = lastAlertTime;
  if (!readActive) {
    currentNoise.textContent = latestDb !== null ? `${latestDb} dB` : '-- dB';
  }
}

function createChart() {
  const labels = chartData.map(item => item.time);
  const values = chartData.map(item => item.db);
  noiseChart = new Chart(chartCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Decibels',
        data: values,
        borderColor: 'rgba(77, 124, 252, 0.95)',
        backgroundColor: 'rgba(77, 124, 252, 0.18)',
        fill: true,
        tension: 0.35,
        pointRadius: 2,
        pointHoverRadius: 6,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#121a28',
          titleColor: '#ffffff',
          bodyColor: '#cbd6ff'
        }
      },
      scales: {
        x: {
          ticks: { color: 'rgba(255,255,255,0.72)', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
          grid: { color: 'rgba(255,255,255,0.06)' }
        },
        y: {
          min: 0,
          max: 100,
          ticks: { color: 'rgba(255,255,255,0.72)' },
          title: {
            display: true,
            text: 'Decibels (dB)',
            color: 'rgba(255,255,255,0.72)',
            font: { size: 12 }
          },
          grid: { color: 'rgba(255,255,255,0.06)' }
        }
      }
    }
  });
}

function updateChart() {
  if (!noiseChart) return;
  noiseChart.data.labels = chartData.map(item => item.time);
  noiseChart.data.datasets[0].data = chartData.map(item => item.db);
  noiseChart.update('none');
}

function addChartPoint(dbValue) {
  const timestamp = formatTime(new Date());
  chartData.push({ time: timestamp, db: dbValue });
  if (chartData.length > 100) {
    chartData.shift();
  }
  saveToLocalStorage();
  updateChart();
}

function addViolation() {
  violations += 1;
  score = Math.max(0, score - 1);
  lastAlertTime = formatTime(new Date());
  const eventDb = latestDb !== null ? latestDb : 'N/A';
  activityLog.unshift({ time: lastAlertTime, db: eventDb, status: 'LOUD' });
  if (activityLog.length > 100) {
    activityLog = activityLog.slice(0, 100);
  }
  saveToLocalStorage();
  renderActivityLog();
  updateDashboard();
}

function saveToLocalStorage() {
  const payload = {
    violations,
    score,
    lastAlertTime,
    activityLog,
    chartData
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadFromLocalStorage() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;
  try {
    const data = JSON.parse(saved);
    violations = Number.isFinite(data.violations) ? data.violations : 0;
    score = Number.isFinite(data.score) ? data.score : 100;
    lastAlertTime = data.lastAlertTime || '--';
    activityLog = Array.isArray(data.activityLog) ? data.activityLog.slice(0, 100) : [];
    chartData = Array.isArray(data.chartData) ? data.chartData.slice(-100) : [];
  } catch (error) {
    console.warn('Unable to restore local storage state:', error);
    violations = 0;
    score = 100;
    lastAlertTime = '--';
    activityLog = [];
    chartData = [];
  }
}

function renderActivityLog() {
  activityLogBody.innerHTML = '';
  if (activityLog.length === 0) {
    activityLogBody.innerHTML = '<tr><td colspan="3" class="empty-row">No loud noise alerts yet.</td></tr>';
    return;
  }

  for (const entry of activityLog) {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${entry.time}</td><td>${entry.db}</td><td>${entry.status}</td>`;
    activityLogBody.appendChild(row);
  }
}

function exportCSV() {
  const header = ['Time', 'dB', 'Status'];
  const rows = activityLog.map(entry => [entry.time, entry.db, entry.status]);
  const csv = [header, ...rows].map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'library_noise_report.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function exportPDF() {
  if (!window.jspdf) {
    alert('PDF library not loaded.');
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let y = 14;
  doc.setFontSize(16);
  doc.text('Smart Noise Monitoring Report', 14, y);
  y += 8;
  doc.setFontSize(10);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, y);
  y += 8;

  // Add chart image if available
  try {
    if (noiseChart && typeof noiseChart.toBase64Image === 'function') {
      const img = noiseChart.toBase64Image();
      doc.addImage(img, 'PNG', 14, y, 180, 60);
      y += 68;
    }
  } catch (err) {
    console.warn('Could not add chart image to PDF:', err);
  }

  // Summary
  doc.setFontSize(12);
  doc.text('Summary', 14, y);
  y += 6;
  const avg = chartData.length ? Math.round(chartData.reduce((s, i) => s + i.db, 0) / chartData.length) : 'N/A';
  const lines = [
    `Total violations: ${violations}`,
    `Quiet score: ${score}%`,
    `Average dB: ${avg}`
  ];
  doc.setFontSize(10);
  for (const line of lines) {
    doc.text(line, 14, y);
    y += 6;
  }
  y += 4;

  // Activity log
  doc.setFontSize(12);
  doc.text('Activity Log', 14, y);
  y += 6;
  doc.setFontSize(10);
  if (activityLog.length === 0) {
    doc.text('No loud noise alerts recorded.', 14, y);
    y += 6;
  } else {
    for (let i = 0; i < activityLog.length; i++) {
      if (y > 270) { doc.addPage(); y = 14; }
      const entry = activityLog[i];
      const row = `${entry.time} | ${entry.db} dB | ${entry.status}`;
      doc.text(row, 14, y);
      y += 6;
    }
  }

  // Recommendations
  if (y > 240) { doc.addPage(); y = 14; }
  doc.setFontSize(12);
  doc.text('Recommendations', 14, y);
  y += 6;
  const recs = [];
  if (violations > 10) recs.push('Increase enforcement and place visible quiet zone signage.');
  if (avg !== 'N/A' && avg > 65) recs.push('Consider acoustic treatment and optimize sensor placement.');
  if (score < 80) recs.push('Run awareness campaigns and schedule staff reminders.');
  if (recs.length === 0) recs.push('Current status looks good. Maintain monitoring.');
  doc.setFontSize(10);
  for (const r of recs) {
    if (y > 280) { doc.addPage(); y = 14; }
    doc.text(`- ${r}`, 14, y);
    y += 6;
  }

  doc.save('noise_report.pdf');
}

function resetStatistics() {
  const confirmed = window.confirm('Reset all statistics, activity history, chart data, and stored settings?');
  if (!confirmed) return;
  violations = 0;
  score = 100;
  lastAlertTime = '--';
  activityLog = [];
  chartData = [];
  latestDb = null;
  currentStatus = readActive ? 'NO_READING' : 'DISCONNECTED';
  saveToLocalStorage();
  renderActivityLog();
  updateChart();
  updateDashboard();
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
