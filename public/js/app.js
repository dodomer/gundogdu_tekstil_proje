// ===================================
// Gündoğdu Tekstil - Dashboard App
// ===================================

const API_BASE = '/api';

// State
let currentTable = null;
let currentPage = 1;
let tableStructure = [];

// ===================================
// Initialization
// ===================================
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  checkHealth();
  loadDashboard();
});

// ===================================
// Navigation
// ===================================
function initNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const section = item.dataset.section;
      
      // Update active nav
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      
      // Update active section
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.getElementById(`section-${section}`).classList.add('active');
      
      // Update page title
      const titles = {
        dashboard: 'Dashboard',
        tables: 'Tablolar',
        query: 'SQL Sorgu'
      };
      document.getElementById('page-title').textContent = titles[section];
      
      // Load section data
      if (section === 'tables') {
        loadTablesList();
      }
    });
  });
}

// ===================================
// API Helpers
// ===================================
async function fetchAPI(endpoint, options = {}) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
      },
      ...options
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'API hatası');
    }
    
    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}

// ===================================
// Health Check
// ===================================
async function checkHealth() {
  try {
    const health = await fetchAPI('/health');
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.getElementById('db-status');
    
    if (health.status === 'OK') {
      statusDot.classList.add('connected');
      statusDot.classList.remove('error');
      statusText.textContent = 'Veritabanı Bağlı';
    } else {
      statusDot.classList.add('error');
      statusText.textContent = 'Bağlantı Hatası';
    }
  } catch (error) {
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.getElementById('db-status');
    statusDot.classList.add('error');
    statusText.textContent = 'Sunucu Hatası';
  }
}

// ===================================
// Dashboard
// ===================================
async function loadDashboard() {
  try {
    const stats = await fetchAPI('/dashboard/stats');
    renderStats(stats);
    renderTablesList(stats.tablolar, stats);
  } catch (error) {
    document.getElementById('stats-container').innerHTML = `
      <div class="stat-card">
        <div class="stat-icon">❌</div>
        <div class="stat-info">
          <span class="stat-value">Hata</span>
          <span class="stat-label">${error.message}</span>
        </div>
      </div>
    `;
  }
}

function renderStats(stats) {
  const container = document.getElementById('stats-container');
  
  const statCards = [
    { icon: '📊', value: stats.tabloSayisi, label: 'Toplam Tablo' },
    { icon: '🗄️', value: stats.veritabani, label: 'Veritabanı' }
  ];
  
  // Add table counts as cards
  stats.tablolar.forEach(table => {
    const count = stats[table];
    if (typeof count === 'number') {
      statCards.push({
        icon: '📋',
        value: count.toLocaleString('tr-TR'),
        label: table
      });
    }
  });
  
  container.innerHTML = statCards.map(stat => `
    <div class="stat-card">
      <div class="stat-icon">${stat.icon}</div>
      <div class="stat-info">
        <span class="stat-value">${stat.value}</span>
        <span class="stat-label">${stat.label}</span>
      </div>
    </div>
  `).join('');
}

function renderTablesList(tables, stats) {
  const container = document.getElementById('tables-list');
  
  if (!tables || tables.length === 0) {
    container.innerHTML = '<p class="loading-text">Henüz tablo yok.</p>';
    return;
  }
  
  container.innerHTML = tables.map(table => `
    <div class="table-item" onclick="goToTable('${table}')">
      <span class="name">📋 ${table}</span>
      <span class="count">${stats[table] !== undefined ? stats[table] + ' kayıt' : ''}</span>
    </div>
  `).join('');
}

// ===================================
// Tables Section
// ===================================
async function loadTablesList() {
  try {
    const tables = await fetchAPI('/tables');
    const select = document.getElementById('table-select');
    
    select.innerHTML = '<option value="">-- Tablo Seçin --</option>';
    tables.forEach(table => {
      select.innerHTML += `<option value="${table.TABLE_NAME}">${table.TABLE_NAME}</option>`;
    });
    
    if (currentTable) {
      select.value = currentTable;
    }
  } catch (error) {
    console.error('Error loading tables:', error);
  }
}

function goToTable(tableName) {
  // Navigate to tables section
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector('[data-section="tables"]').classList.add('active');
  
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById('section-tables').classList.add('active');
  
  document.getElementById('page-title').textContent = 'Tablolar';
  
  // Load table list and select the table
  loadTablesList().then(() => {
    document.getElementById('table-select').value = tableName;
    loadTableData();
  });
}

async function loadTableData() {
  const tableName = document.getElementById('table-select').value;
  if (!tableName) {
    document.getElementById('table-head').innerHTML = '';
    document.getElementById('table-body').innerHTML = '';
    document.getElementById('table-info').innerHTML = '';
    document.getElementById('pagination').innerHTML = '';
    return;
  }
  
  currentTable = tableName;
  
  try {
    // Get table structure
    tableStructure = await fetchAPI(`/tables/${tableName}/structure`);
    
    // Get table data
    const result = await fetchAPI(`/tables/${tableName}/data?page=${currentPage}&limit=20`);
    
    renderTableHead(tableStructure);
    renderTableBody(result.data, tableStructure);
    renderPagination(result.pagination);
    
    document.getElementById('table-info').innerHTML = `
      <strong>${tableName}</strong> - Toplam ${result.pagination.total} kayıt
    `;
  } catch (error) {
    document.getElementById('table-info').innerHTML = `
      <span style="color: var(--danger);">Hata: ${error.message}</span>
    `;
  }
}

function renderTableHead(structure) {
  const thead = document.getElementById('table-head');
  thead.innerHTML = `
    <tr>
      ${structure.map(col => `<th>${col.Field}</th>`).join('')}
      <th>İşlemler</th>
    </tr>
  `;
}

function renderTableBody(data, structure) {
  const tbody = document.getElementById('table-body');
  
  if (data.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${structure.length + 1}" style="text-align: center; color: var(--text-muted);">
          Kayıt bulunamadı
        </td>
      </tr>
    `;
    return;
  }
  
  tbody.innerHTML = data.map(row => {
    const idColumn = structure[0].Field;
    const id = row[idColumn];
    
    return `
      <tr>
        ${structure.map(col => {
          let value = row[col.Field];
          if (value === null) value = '<em style="color: var(--text-muted);">NULL</em>';
          else if (typeof value === 'object') value = JSON.stringify(value);
          else if (String(value).length > 50) value = String(value).substring(0, 50) + '...';
          return `<td>${value}</td>`;
        }).join('')}
        <td class="action-btns">
          <button class="btn btn-sm btn-secondary" onclick="editRecord(${JSON.stringify(row).replace(/"/g, '&quot;')})">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteRecord('${id}')">🗑️</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderPagination(pagination) {
  const container = document.getElementById('pagination');
  const { page, totalPages } = pagination;
  
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }
  
  let html = '';
  
  // Previous button
  html += `<button ${page === 1 ? 'disabled' : ''} onclick="goToPage(${page - 1})">◀ Önceki</button>`;
  
  // Page numbers
  const maxVisible = 5;
  let startPage = Math.max(1, page - Math.floor(maxVisible / 2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);
  
  if (endPage - startPage < maxVisible - 1) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }
  
  if (startPage > 1) {
    html += `<button onclick="goToPage(1)">1</button>`;
    if (startPage > 2) html += `<span>...</span>`;
  }
  
  for (let i = startPage; i <= endPage; i++) {
    html += `<button class="${i === page ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }
  
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) html += `<span>...</span>`;
    html += `<button onclick="goToPage(${totalPages})">${totalPages}</button>`;
  }
  
  // Next button
  html += `<button ${page === totalPages ? 'disabled' : ''} onclick="goToPage(${page + 1})">Sonraki ▶</button>`;
  
  container.innerHTML = html;
}

function goToPage(page) {
  currentPage = page;
  loadTableData();
}

// ===================================
// CRUD Operations
// ===================================
function showAddModal() {
  if (!currentTable || tableStructure.length === 0) {
    alert('Lütfen önce bir tablo seçin.');
    return;
  }
  
  document.getElementById('modal-title').textContent = 'Yeni Kayıt Ekle';
  const form = document.getElementById('record-form');
  form.dataset.mode = 'add';
  
  renderFormFields({});
  document.getElementById('modal').classList.add('active');
}

function editRecord(row) {
  document.getElementById('modal-title').textContent = 'Kaydı Düzenle';
  const form = document.getElementById('record-form');
  form.dataset.mode = 'edit';
  form.dataset.id = row[tableStructure[0].Field];
  
  renderFormFields(row);
  document.getElementById('modal').classList.add('active');
}

function renderFormFields(data) {
  const container = document.getElementById('form-fields');
  
  container.innerHTML = tableStructure.map((col, index) => {
    // Skip auto-increment primary key for new records
    const isAutoIncrement = col.Extra.includes('auto_increment');
    const value = data[col.Field] !== undefined ? data[col.Field] : '';
    
    return `
      <div class="form-group">
        <label for="field-${col.Field}">
          ${col.Field}
          ${col.Null === 'NO' ? '<span style="color: var(--danger);">*</span>' : ''}
          ${isAutoIncrement ? '<span style="color: var(--text-muted);">(Otomatik)</span>' : ''}
        </label>
        <input 
          type="text" 
          id="field-${col.Field}" 
          name="${col.Field}"
          value="${value === null ? '' : value}"
          ${isAutoIncrement && !data[col.Field] ? 'disabled placeholder="Otomatik oluşturulacak"' : ''}
        >
      </div>
    `;
  }).join('');
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
  document.getElementById('record-form').reset();
}

document.getElementById('record-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const form = e.target;
  const mode = form.dataset.mode;
  const formData = new FormData(form);
  const data = {};
  
  // Collect form data
  for (const col of tableStructure) {
    const input = document.getElementById(`field-${col.Field}`);
    if (input && !input.disabled && input.value !== '') {
      data[col.Field] = input.value;
    }
  }
  
  try {
    if (mode === 'add') {
      await fetchAPI(`/tables/${currentTable}/data`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
      alert('Kayıt başarıyla eklendi!');
    } else {
      const id = form.dataset.id;
      await fetchAPI(`/tables/${currentTable}/data/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data)
      });
      alert('Kayıt başarıyla güncellendi!');
    }
    
    closeModal();
    loadTableData();
    loadDashboard(); // Refresh stats
  } catch (error) {
    alert('Hata: ' + error.message);
  }
});

async function deleteRecord(id) {
  if (!confirm('Bu kaydı silmek istediğinize emin misiniz?')) {
    return;
  }
  
  try {
    await fetchAPI(`/tables/${currentTable}/data/${id}`, {
      method: 'DELETE'
    });
    alert('Kayıt silindi!');
    loadTableData();
    loadDashboard();
  } catch (error) {
    alert('Hata: ' + error.message);
  }
}

// ===================================
// Query Section
// ===================================
async function runQuery() {
  const sql = document.getElementById('sql-input').value.trim();
  
  if (!sql) {
    alert('Lütfen bir SQL sorgusu girin.');
    return;
  }
  
  try {
    const result = await fetchAPI('/query', {
      method: 'POST',
      body: JSON.stringify({ sql })
    });
    
    renderQueryResult(result);
    document.getElementById('query-result-card').style.display = 'block';
  } catch (error) {
    alert('Sorgu hatası: ' + error.message);
    document.getElementById('query-result-card').style.display = 'none';
  }
}

function renderQueryResult(data) {
  const thead = document.getElementById('query-result-head');
  const tbody = document.getElementById('query-result-body');
  
  if (!data || data.length === 0) {
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td style="text-align: center; color: var(--text-muted);">Sonuç yok</td></tr>';
    return;
  }
  
  const columns = Object.keys(data[0]);
  
  thead.innerHTML = `<tr>${columns.map(col => `<th>${col}</th>`).join('')}</tr>`;
  
  tbody.innerHTML = data.map(row => `
    <tr>
      ${columns.map(col => {
        let value = row[col];
        if (value === null) value = '<em style="color: var(--text-muted);">NULL</em>';
        else if (typeof value === 'object') value = JSON.stringify(value);
        return `<td>${value}</td>`;
      }).join('')}
    </tr>
  `).join('');
}

// ===================================
// Refresh Data
// ===================================
function refreshData() {
  checkHealth();
  
  const activeSection = document.querySelector('.section.active').id;
  
  if (activeSection === 'section-dashboard') {
    loadDashboard();
  } else if (activeSection === 'section-tables') {
    loadTableData();
  }
}

