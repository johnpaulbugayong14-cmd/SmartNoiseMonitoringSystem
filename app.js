const connectButton = document.getElementById('connect-button');
const exportButton = document.getElementById('export-button');
const resetButton = document.getElementById('reset-button');
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

const STORAGE_KEY = 'smartLibraryQuietZone';

const statusStyles = {
  QUIET: { text: '🟢 QUIET', color: 'var(--green)' },
  MODERATE: { text: '🟡 MODERATE NOISE', color: 'var(--yellow)' },
  LOUD: { text: '🔴 EXCESSIVE NOISE', color: 'var(--red)' },
  NO_READING: { text: '⚪ No Reading', color: 'var(--muted)' },
  DISCONNECTED: { text: '🔴 DISCONNECTED', color: 'var(--red)' }
};

window.addEventListener('load', init);
connectButton.addEventListener('click', () => {
  if (readActive) {
    disconnectArduino();
  } else {
    connectArduino();
  }
});
exportButton.addEventListener('click', exportCSV);
resetButton.addEventListener('click', resetStatistics);

async function init() {
  if (!('serial' in navigator)) {
    unsupportedMessage.classList.remove('hidden');
    connectButton.disabled = true;
  }
  loadFromLocalStorage();
  createChart();
  renderActivityLog();
  updateDashboard();
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
