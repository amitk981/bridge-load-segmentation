/**
 * Bridge Load Segmentation — Main Application Controller
 *
 * Handles: tab switching, dynamic tables, API calls, form collection,
 *          CSV import, project save/load, IRC/culvert templates
 */

// ─── State ──────────────────────────────────────────────────────────────────

let memberMode = 'auto';
let currentOverlaps = [];
let currentSummary = null;
let currentSTAAD = '';

// ─── Tab Switching ──────────────────────────────────────────────────────────

function switchTab(tabId) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');

    if (tabId === 'geometry') updateVisualization();
    if (tabId === 'results' && currentOverlaps.length) updateResultsVisualization();
}

// ─── Member Mode ────────────────────────────────────────────────────────────

function setMemberMode(mode) {
    memberMode = mode;
    document.getElementById('member-auto').style.display = mode === 'auto' ? 'block' : 'none';
    document.getElementById('member-manual').style.display = mode === 'manual' ? 'block' : 'none';
    document.getElementById('auto-mode-btn').classList.toggle('active', mode === 'auto');
    document.getElementById('manual-mode-btn').classList.toggle('active', mode === 'manual');
}

// ─── Member Table ───────────────────────────────────────────────────────────

function generateAutoMembers() {
    const width = parseFloat(document.getElementById('total-width').value) || 8.5;
    const startId = parseInt(document.getElementById('auto-start-id').value) || 1001;
    const widthMode = document.getElementById('width-mode').value;

    const tbody = document.getElementById('member-tbody');
    tbody.innerHTML = '';

    if (widthMode === 'custom') {
        // Custom widths mode
        const raw = document.getElementById('custom-widths').value.trim();
        if (!raw) { alert('Please enter custom widths (comma-separated).'); return; }

        const widths = raw.split(/[\s,]+/).map(v => parseFloat(v.trim())).filter(v => !isNaN(v) && v > 0);
        if (widths.length === 0) { alert('Invalid widths. Enter numbers separated by commas.'); return; }

        const sum = widths.reduce((a, b) => a + b, 0);
        const tolerance = 0.01;

        if (Math.abs(sum - width) > tolerance) {
            const proceed = confirm(
                `Sum of custom widths (${sum.toFixed(3)}m) ≠ total width (${width}m).\n` +
                `Difference: ${(sum - width).toFixed(3)}m.\n\n` +
                `Click OK to generate anyway, or Cancel to fix.`
            );
            if (!proceed) return;
        }

        let pos = 0;
        widths.forEach((w, i) => {
            const id = startId + i;
            const start = pos.toFixed(4);
            pos += w;
            const end = pos.toFixed(4);
            addMemberRowWithData(id, start, end, w.toFixed(4), 'GENERAL', '');
        });
    } else {
        // Equal widths mode (original)
        const num = parseInt(document.getElementById('num-strips').value) || 12;
        const stripWidth = width / num;

        for (let i = 0; i < num; i++) {
            const id = startId + i;
            const start = (i * stripWidth).toFixed(4);
            const end = ((i + 1) * stripWidth).toFixed(4);
            addMemberRowWithData(id, start, end, (end - start).toFixed(4), 'GENERAL', '');
        }
    }

    updateVisualization();
}

function toggleWidthMode() {
    const mode = document.getElementById('width-mode').value;
    document.getElementById('equal-strips-group').style.display = mode === 'equal' ? 'block' : 'none';
    document.getElementById('custom-widths-group').style.display = mode === 'custom' ? 'block' : 'none';

    // Live feedback for custom widths
    if (mode === 'custom') {
        const input = document.getElementById('custom-widths');
        input.addEventListener('input', updateCustomWidthsFeedback);
        updateCustomWidthsFeedback();
    }
}

function updateCustomWidthsFeedback() {
    const raw = document.getElementById('custom-widths').value.trim();
    const totalWidth = parseFloat(document.getElementById('total-width').value) || 8.5;
    const fb = document.getElementById('custom-widths-feedback');

    if (!raw) {
        fb.innerHTML = `<span style="color:var(--text-muted)">Total width: ${totalWidth}m — enter widths that sum to this value</span>`;
        return;
    }

    const widths = raw.split(/[\s,]+/).map(v => parseFloat(v.trim())).filter(v => !isNaN(v) && v > 0);
    const sum = widths.reduce((a, b) => a + b, 0);
    const diff = Math.abs(sum - totalWidth);

    if (widths.length === 0) {
        fb.innerHTML = '<span style="color:#f87171">⚠ No valid widths found</span>';
    } else if (diff < 0.01) {
        fb.innerHTML = `<span style="color:#4ade80">✅ ${widths.length} strips, sum = ${sum.toFixed(3)}m — matches total width</span>`;
    } else {
        fb.innerHTML = `<span style="color:#facc15">⚠ ${widths.length} strips, sum = ${sum.toFixed(3)}m (${sum < totalWidth ? 'short' : 'over'} by ${diff.toFixed(3)}m vs ${totalWidth}m)</span>`;
    }
}

function addMemberRow() {
    const tbody = document.getElementById('member-tbody');
    const rows = tbody.rows.length;
    const lastId = rows > 0 ? parseInt(tbody.rows[rows - 1].cells[0].querySelector('input').value) + 1 : 1001;
    addMemberRowWithData(lastId, '', '', '', 'GENERAL', '');
}

function addMemberRowWithData(id, start, end, width, group, label) {
    const tbody = document.getElementById('member-tbody');
    const row = tbody.insertRow();

    row.innerHTML = `
        <td><input type="number" value="${id}" class="m-id"></td>
        <td><input type="number" value="${start}" step="0.001" class="m-start"></td>
        <td><input type="number" value="${end}" step="0.001" class="m-end"></td>
        <td><span class="m-width">${width || ''}</span></td>
        <td><select class="m-group">
            <option value="GENERAL" ${group === 'GENERAL' ? 'selected' : ''}>General</option>
            <option value="TOP_SLAB" ${group === 'TOP_SLAB' ? 'selected' : ''}>Top Slab</option>
            <option value="BOTTOM_SLAB" ${group === 'BOTTOM_SLAB' ? 'selected' : ''}>Bottom Slab</option>
            <option value="LEFT_WALL" ${group === 'LEFT_WALL' ? 'selected' : ''}>Left Wall</option>
            <option value="RIGHT_WALL" ${group === 'RIGHT_WALL' ? 'selected' : ''}>Right Wall</option>
            <option value="MIDDLE_WALL_1" ${group === 'MIDDLE_WALL_1' ? 'selected' : ''}>Middle Wall 1</option>
        </select></td>
        <td><input type="text" value="${label}" class="m-label"></td>
        <td><button class="btn btn-xs btn-danger" onclick="this.closest('tr').remove(); updateVisualization();">✕</button></td>
    `;
}

function collectMembers() {
    const rows = document.getElementById('member-tbody').rows;
    const members = [];
    for (const row of rows) {
        const id = parseInt(row.querySelector('.m-id').value);
        const start = parseFloat(row.querySelector('.m-start').value);
        const end = parseFloat(row.querySelector('.m-end').value);
        const group = row.querySelector('.m-group').value;
        const label = row.querySelector('.m-label').value;
        if (!isNaN(id) && !isNaN(start) && !isNaN(end)) {
            members.push({ id, start, end, group, label });
        }
    }
    return members;
}

// ─── Load Table ─────────────────────────────────────────────────────────────

function addLoadRow() {
    const tbody = document.getElementById('load-tbody');
    const rows = tbody.rows.length;
    const loadId = `L${rows + 1}`;
    addLoadRowWithData(loadId, 'LC1', 'PARTIAL_UDL', '', '', '', '', 'GY', '');
}

function addLoadRowWithData(id, lcase, type, start, end, intensity, intensityEnd, dir, notes) {
    const tbody = document.getElementById('load-tbody');
    const row = tbody.insertRow();

    const loadTypes = ['PARTIAL_UDL', 'PATCH_LOAD', 'IRC_CLASS_AA', 'IRC_70R', 'IRC_CLASS_A',
        'EARTH_PRESSURE', 'SURCHARGE', 'HYDROSTATIC', 'DEAD_LOAD', 'WEARING_COURSE', 'BRAKING', 'CUSTOM'];
    const typeOptions = loadTypes.map(t =>
        `<option value="${t}" ${t === type ? 'selected' : ''}>${t.replace(/_/g, ' ')}</option>`
    ).join('');

    const dirs = ['GX', 'GY', 'GZ', 'X', 'Y', 'Z'];
    const dirOptions = dirs.map(d =>
        `<option value="${d}" ${d === dir ? 'selected' : ''}>${d}</option>`
    ).join('');

    row.innerHTML = `
        <td><input type="text" value="${id}" class="l-id"></td>
        <td><input type="text" value="${lcase}" class="l-case" style="width:60px"></td>
        <td><select class="l-type">${typeOptions}</select></td>
        <td><input type="number" value="${start}" step="0.01" class="l-start"></td>
        <td><input type="number" value="${end}" step="0.01" class="l-end"></td>
        <td><input type="number" value="${intensity}" step="0.01" class="l-intensity"></td>
        <td><input type="number" value="${intensityEnd}" step="0.01" class="l-intensity-end" placeholder="—"></td>
        <td><select class="l-dir">${dirOptions}</select></td>
        <td><input type="text" value="${notes}" class="l-notes" style="width:120px"></td>
        <td><button class="btn btn-xs btn-danger" onclick="this.closest('tr').remove()">✕</button></td>
    `;
}

function duplicateLastLoad() {
    const tbody = document.getElementById('load-tbody');
    if (tbody.rows.length === 0) { addLoadRow(); return; }
    const last = tbody.rows[tbody.rows.length - 1];
    const rows = tbody.rows.length;
    addLoadRowWithData(
        `L${rows + 1}`,
        last.querySelector('.l-case').value,
        last.querySelector('.l-type').value,
        last.querySelector('.l-start').value,
        last.querySelector('.l-end').value,
        last.querySelector('.l-intensity').value,
        last.querySelector('.l-intensity-end').value,
        last.querySelector('.l-dir').value,
        last.querySelector('.l-notes').value,
    );
}

function collectLoads() {
    const rows = document.getElementById('load-tbody').rows;
    const loads = [];
    for (const row of rows) {
        const start = parseFloat(row.querySelector('.l-start').value);
        const end = parseFloat(row.querySelector('.l-end').value);
        const intensity = parseFloat(row.querySelector('.l-intensity').value);
        if (!isNaN(start) && !isNaN(end) && !isNaN(intensity)) {
            const ie = parseFloat(row.querySelector('.l-intensity-end').value);
            loads.push({
                id: row.querySelector('.l-id').value,
                load_case: row.querySelector('.l-case').value,
                load_type: row.querySelector('.l-type').value,
                start, end, intensity,
                intensity_end: isNaN(ie) ? null : ie,
                direction: row.querySelector('.l-dir').value,
                notes: row.querySelector('.l-notes').value,
            });
        }
    }
    return loads;
}

// ─── Settings Collection ────────────────────────────────────────────────────

function collectSettings() {
    return {
        project_name: document.getElementById('project-name').value,
        bridge_name: document.getElementById('bridge-name').value,
        engineer: document.getElementById('engineer').value,
        project_date: document.getElementById('project-date').value,
        comments: document.getElementById('comments').value,
        structure_type: document.getElementById('structure-type').value,
        total_width: parseFloat(document.getElementById('total-width').value) || 8.5,
        reference_axis: document.getElementById('reference-axis').value,
        custom_datum: parseFloat(document.getElementById('custom-datum').value) || 0,
        culvert_height: parseFloat(document.getElementById('culvert-height').value) || 0,
        fill_depth: parseFloat(document.getElementById('fill-depth').value) || 0,
        decimal_precision: parseInt(document.getElementById('decimal-precision').value) || 2,
        units: document.getElementById('units').value,
        overhang_policy: document.getElementById('overhang-policy').value,
        start_member_number: parseInt(document.getElementById('start-member').value) || 1001,
        member_increment: 1,
    };
}

// ─── API Calls ──────────────────────────────────────────────────────────────

async function runCalculation() {
    const btn = document.getElementById('calc-btn');
    btn.innerHTML = '<svg class="icon"><use href="#i-play"/></svg> Calculating...';
    btn.disabled = true;

    try {
        const body = { settings: collectSettings(), members: collectMembers(), loads: collectLoads() };
        const resp = await fetch('/api/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json();

        // Validation messages
        const valContainer = document.getElementById('validation-messages');
        if (data.validation && data.validation.length) {
            valContainer.innerHTML = data.validation.map(m =>
                `<div class="validation-msg ${m.level}"><span>${m.level === 'error' ? '❌' : '⚠️'}</span> ${m.message}</div>`
            ).join('');
            valContainer.style.display = 'block';
        } else {
            valContainer.style.display = 'none';
        }

        if (data.success) {
            currentOverlaps = data.overlaps;
            currentSummary = data.summary;
            currentSTAAD = data.staad_text;

            // Update summary cards
            document.getElementById('sum-members').textContent = data.summary.total_members;
            document.getElementById('sum-loads').textContent = data.summary.total_loads;
            document.getElementById('sum-affected').textContent = data.summary.affected_members;
            document.getElementById('sum-rows').textContent = data.summary.total_overlap_rows;

            // Populate results table
            const tbody = document.getElementById('results-tbody');
            tbody.innerHTML = '';
            for (const r of data.overlaps) {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${r.load_id}</td><td>${r.load_case}</td><td>${r.member_id}</td>
                    <td>${r.overlap_start_global}</td><td>${r.overlap_end_global}</td>
                    <td>${r.front_distance}</td><td>${r.back_distance}</td>
                    <td>${r.loaded_length}</td><td>${r.intensity}</td>
                    <td>${r.direction}</td><td>${r.staad_format}</td>
                `;
                tbody.appendChild(tr);
            }

            document.getElementById('results-card').style.display = 'block';
            document.getElementById('results-viz-card').style.display = 'block';
            document.getElementById('results-frame-card').style.display = 'block';
            document.getElementById('staad-preview').textContent = data.staad_text;

            updateResultsVisualization();
            // Render STAAD.Pro-style frame visualization
            setTimeout(() => renderResultsFrameViz(), 100);
        }
    } catch (e) {
        alert('Calculation error: ' + e.message);
    } finally {
        btn.innerHTML = '<svg class="icon"><use href="#i-play"/></svg> Calculate Overlaps';
        btn.disabled = false;
    }
}

async function downloadExcel() {
    try {
        const body = { settings: collectSettings(), members: collectMembers(), loads: collectLoads() };
        const resp = await fetch('/api/export/excel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error('Export failed');
        const blob = await resp.blob();
        downloadBlob(blob, `${collectSettings().project_name.replace(/ /g, '_')}_Load_Segmentation.xlsx`);
    } catch (e) { alert('Excel export error: ' + e.message); }
}

async function downloadSTAAD() {
    try {
        const body = { settings: collectSettings(), members: collectMembers(), loads: collectLoads() };
        const resp = await fetch('/api/export/staad', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error('Export failed');
        const blob = await resp.blob();
        downloadBlob(blob, `${collectSettings().project_name.replace(/ /g, '_')}_STAAD.txt`);
    } catch (e) { alert('STAAD export error: ' + e.message); }
}

async function downloadCSV() {
    try {
        const body = { settings: collectSettings(), members: collectMembers(), loads: collectLoads() };
        const resp = await fetch('/api/export/csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error('Export failed');
        const blob = await resp.blob();
        downloadBlob(blob, 'overlap_results.csv');
    } catch (e) { alert('CSV export error: ' + e.message); }
}

function copySTAAD() {
    const text = document.getElementById('staad-preview').textContent;
    navigator.clipboard.writeText(text).then(() => {
        const btn = event.target;
        btn.textContent = 'Copied';
    });
}

// ─── IRC Template Loaders ───────────────────────────────────────────────────

async function addIRCTemplate(templateType) {
    try {
        const resp = await fetch('/api/templates/irc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template: templateType, position_offset: 0, load_case: 'LC1' }),
        });
        const data = await resp.json();
        if (data.success) {
            for (const lo of data.loads) {
                addLoadRowWithData(
                    lo.id, lo.load_case, lo.load_type,
                    lo.start.toFixed(3), lo.end.toFixed(3),
                    lo.intensity.toFixed(2),
                    lo.intensity_end !== null ? lo.intensity_end.toFixed(2) : '',
                    lo.direction, lo.notes
                );
            }
        }
    } catch (e) { alert('Template error: ' + e.message); }
}

async function addCulvertTemplate(templateType) {
    try {
        const height = parseFloat(document.getElementById('culvert-height').value) || 3.0;
        const width = parseFloat(document.getElementById('total-width').value) || 8.5;
        const fillDepth = parseFloat(document.getElementById('fill-depth').value) || 1.0;

        const resp = await fetch('/api/templates/culvert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                template: templateType, load_case: 'LC1',
                height, width, fill_depth: fillDepth, water_height: height,
            }),
        });
        const data = await resp.json();
        if (data.success) {
            for (const lo of data.loads) {
                addLoadRowWithData(
                    lo.id, lo.load_case, lo.load_type,
                    lo.start.toFixed(3), lo.end.toFixed(3),
                    lo.intensity.toFixed(2),
                    lo.intensity_end !== null && lo.intensity_end !== undefined ? lo.intensity_end.toFixed(2) : '',
                    lo.direction, lo.notes
                );
            }
        }
    } catch (e) { alert('Template error: ' + e.message); }
}

// ─── Project Save / Load ────────────────────────────────────────────────────

async function saveProject() {
    const data = { settings: collectSettings(), members: collectMembers(), loads: collectLoads() };
    const resp = await fetch('/api/project/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const blob = await resp.blob();
    downloadBlob(blob, 'project.json');
}

async function loadProject(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    const resp = await fetch('/api/project/load', { method: 'POST', body: formData });
    const result = await resp.json();

    if (result.success) {
        const data = result.data;
        // Restore settings
        if (data.settings) {
            const s = data.settings;
            document.getElementById('project-name').value = s.project_name || '';
            document.getElementById('bridge-name').value = s.bridge_name || '';
            document.getElementById('engineer').value = s.engineer || '';
            document.getElementById('total-width').value = s.total_width || 8.5;
            document.getElementById('structure-type').value = s.structure_type || 'BRIDGE_DECK';
            document.getElementById('reference-axis').value = s.reference_axis || 'LEFT_EDGE';
            document.getElementById('culvert-height').value = s.culvert_height || 0;
            document.getElementById('fill-depth').value = s.fill_depth || 0;
            document.getElementById('decimal-precision').value = s.decimal_precision || 2;
            document.getElementById('units').value = s.units || 'm';
        }
        // Restore members
        if (data.members) {
            document.getElementById('member-tbody').innerHTML = '';
            for (const m of data.members) {
                addMemberRowWithData(m.id, m.start, m.end, (m.end - m.start).toFixed(4), m.group || 'GENERAL', m.label || '');
            }
        }
        // Restore loads
        if (data.loads) {
            document.getElementById('load-tbody').innerHTML = '';
            for (const lo of data.loads) {
                addLoadRowWithData(lo.id, lo.load_case, lo.load_type, lo.start, lo.end,
                    lo.intensity, lo.intensity_end || '', lo.direction, lo.notes || '');
            }
        }
        updateVisualization();
    }
    event.target.value = '';
}

// ─── CSV Import ─────────────────────────────────────────────────────────────

function importMembersCSV() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = (e) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
            const lines = ev.target.result.split('\n');
            const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
            document.getElementById('member-tbody').innerHTML = '';
            for (let i = 1; i < lines.length; i++) {
                const vals = lines[i].split(',').map(v => v.trim());
                if (vals.length >= 3) {
                    const obj = {};
                    headers.forEach((h, idx) => obj[h] = vals[idx]);
                    addMemberRowWithData(
                        obj.id || (1001 + i - 1), obj.start || 0, obj.end || 0,
                        '', obj.group || 'GENERAL', obj.label || ''
                    );
                }
            }
            updateVisualization();
        };
        reader.readAsText(e.target.files[0]);
    };
    input.click();
}

function importLoadsCSV() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = (e) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
            const lines = ev.target.result.split('\n');
            const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
            for (let i = 1; i < lines.length; i++) {
                const vals = lines[i].split(',').map(v => v.trim());
                if (vals.length >= 5) {
                    const obj = {};
                    headers.forEach((h, idx) => obj[h] = vals[idx]);
                    addLoadRowWithData(
                        obj.id || `L${i}`, obj.load_case || 'LC1', obj.load_type || 'PARTIAL_UDL',
                        obj.start, obj.end, obj.intensity, obj.intensity_end || '',
                        obj.direction || 'GY', obj.notes || ''
                    );
                }
            }
        };
        reader.readAsText(e.target.files[0]);
    };
    input.click();
}

// ─── CSV Export ─────────────────────────────────────────────────────────────

function exportMembersCSV() {
    const members = collectMembers();
    if (members.length === 0) { alert('No members to export.'); return; }

    let csv = 'id,start,end,group,label\n';
    for (const m of members) {
        csv += `${m.id},${m.start},${m.end},${m.group || 'GENERAL'},"${m.label || ''}"\n`;
    }
    downloadBlob(new Blob([csv], { type: 'text/csv' }), 'members.csv');
}

function exportLoadsCSV() {
    const loads = collectLoads();
    if (loads.length === 0) { alert('No loads to export.'); return; }

    let csv = 'id,load_case,load_type,start,end,intensity,intensity_end,direction,notes\n';
    for (const lo of loads) {
        csv += `${lo.id},${lo.load_case},${lo.load_type},${lo.start},${lo.end},${lo.intensity},${lo.intensity_end !== null ? lo.intensity_end : ''},${lo.direction},"${lo.notes || ''}"\n`;
    }
    downloadBlob(new Blob([csv], { type: 'text/csv' }), 'loads.csv');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ─── Initialization ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // Set today's date
    document.getElementById('project-date').value = new Date().toISOString().split('T')[0];

    // Load default example data
    generateAutoMembers();
    loadDefaultLoads();
});

function prefillBoxCulvertMembers() {
    const tbody = document.getElementById('member-tbody');
    tbody.innerHTML = '';

    const members = [
        { id: 1000, start: 0,      end: 0.45,   group: 'TOP_SLAB',  label: 'Left Wall' },
        { id: 1001, start: 0.45,   end: 0.950,  group: 'TOP_SLAB',  label: 'Left Haunch' },
        { id: 1002, start: 0.950,  end: 5.45,   group: 'TOP_SLAB',  label: 'Cell 1 Span' },
        { id: 1003, start: 5.45,   end: 9.950,  group: 'TOP_SLAB',  label: 'Cell 2 Span' },
        { id: 1004, start: 9.950,  end: 10.450, group: 'TOP_SLAB',  label: 'Mid Wall' },
        { id: 1005, start: 10.450, end: 10.8,   group: 'TOP_SLAB',  label: 'Mid Haunch R' },
        { id: 1006, start: 10.8,   end: 11.150, group: 'TOP_SLAB',  label: 'Mid Haunch L' },
        { id: 1007, start: 11.150, end: 11.650, group: 'TOP_SLAB',  label: 'Right Haunch' },
        { id: 1008, start: 11.650, end: 16.150, group: 'TOP_SLAB',  label: 'Cell 3 Span' },
        { id: 1009, start: 16.150, end: 20.650, group: 'TOP_SLAB',  label: 'Cell 4 Span' },
        { id: 1010, start: 20.650, end: 21.150, group: 'TOP_SLAB',  label: 'Right Haunch' },
        { id: 1011, start: 21.150, end: 21.60,  group: 'TOP_SLAB',  label: 'Right Wall' },
    ];

    for (const m of members) {
        const width = (m.end - m.start).toFixed(4);
        addMemberRowWithData(m.id, m.start, m.end, width, m.group, m.label);
    }

    // Update total width to match
    document.getElementById('total-width').value = 21.6;
    updateVisualization();
}

function loadDefaultLoads() {
    // Preload example loads: bridge deck scenario
    addLoadRowWithData('L1', 'LC1', 'PARTIAL_UDL', '0.90', '2.40', '-25', '', 'GY', 'Patch load 1');
    addLoadRowWithData('L2', 'LC1', 'PARTIAL_UDL', '2.10', '5.60', '-18', '', 'GY', 'Patch load 2');
    addLoadRowWithData('L3', 'LC2', 'PARTIAL_UDL', '6.20', '8.10', '-12', '', 'GY', 'Patch load 3');
}


// ─── Smart Tools Functions ──────────────────────────────────────────────────

async function calcImpactFactor() {
    try {
        const resp = await fetch('/api/smart/impact-factor', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vehicle_class: document.getElementById('if-vehicle-class').value,
                span: parseFloat(document.getElementById('if-span').value),
                fill_depth: parseFloat(document.getElementById('if-fill').value),
                bridge_type: document.getElementById('if-bridge-type').value,
            }),
        });
        const data = await resp.json();
        if (data.success) {
            const r = data.result;
            document.getElementById('if-value').textContent = r.impact_factor.toFixed(4);
            document.getElementById('if-percent').textContent = r.impact_percent.toFixed(1) + '%';
            document.getElementById('if-formula').innerHTML = `<strong>Formula:</strong> ${r.formula_used}${r.notes ? '<br>' + r.notes : ''}`;
            document.getElementById('if-result').style.display = 'block';
        } else {
            alert('Error: ' + data.error);
        }
    } catch (e) { alert('Error: ' + e.message); }
}

async function genLoadCombinations() {
    try {
        const map = {};
        const fields = { DL: 'lc-dl', SIDL: 'lc-sidl', WC: 'lc-wc', LL: 'lc-ll', EP: 'lc-ep', WP: 'lc-wp', SC: 'lc-sc' };
        for (const [key, id] of Object.entries(fields)) {
            const val = parseInt(document.getElementById(id).value);
            if (val > 0) map[key] = val;
        }
        const resp = await fetch('/api/smart/load-combinations', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                load_case_map: map,
                include_sls: document.getElementById('lc-sls').value === 'true',
            }),
        });
        const data = await resp.json();
        if (data.success) {
            document.getElementById('lc-staad-text').textContent = data.staad_text;
            document.getElementById('lc-result').style.display = 'block';
        } else {
            alert('Error: ' + data.error);
        }
    } catch (e) { alert('Error: ' + e.message); }
}

async function calcDispersion() {
    try {
        const resp = await fetch('/api/smart/dispersion', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contact_width: parseFloat(document.getElementById('disp-width').value),
                contact_length: parseFloat(document.getElementById('disp-length').value),
                intensity: parseFloat(document.getElementById('disp-intensity').value),
                fill_depth: parseFloat(document.getElementById('disp-fill').value),
                wearing_course: parseFloat(document.getElementById('disp-wc').value),
            }),
        });
        const data = await resp.json();
        if (data.success) {
            const r = data.result;
            document.getElementById('disp-new-w').textContent = r.dispersed_width.toFixed(3);
            document.getElementById('disp-new-l').textContent = r.dispersed_length.toFixed(3);
            document.getElementById('disp-new-i').textContent = Math.abs(r.dispersed_intensity).toFixed(2);
            document.getElementById('disp-formula').innerHTML = '<strong>Calculation:</strong><br>' + r.formula.replace(/\n/g, '<br>');
            document.getElementById('disp-result').style.display = 'block';
        } else {
            alert('Error: ' + data.error);
        }
    } catch (e) { alert('Error: ' + e.message); }
}

async function calcQuantities() {
    try {
        const resp = await fetch('/api/smart/quantities', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clear_span: parseFloat(document.getElementById('qty-span').value),
                clear_height: parseFloat(document.getElementById('qty-height').value),
                top_slab_thickness: parseFloat(document.getElementById('qty-top').value),
                bottom_slab_thickness: parseFloat(document.getElementById('qty-bot').value),
                wall_thickness: parseFloat(document.getElementById('qty-wall').value),
                culvert_length: parseFloat(document.getElementById('qty-length').value),
                num_cells: parseInt(document.getElementById('qty-cells').value),
                haunch_size: parseFloat(document.getElementById('qty-haunch').value),
            }),
        });
        const data = await resp.json();
        if (data.success) {
            const r = data.result;
            document.getElementById('qty-concrete').textContent = r.total_concrete_volume;
            document.getElementById('qty-formwork').textContent = r.total_formwork_area;
            document.getElementById('qty-steel').textContent = r.steel_estimate_kg;
            document.getElementById('qty-weight').textContent = r.concrete_weight_tonnes;
            const tbody = document.getElementById('qty-tbody');
            tbody.innerHTML = '';
            r.items.forEach(item => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${item.component}</td><td>${item.length}</td><td>${item.width}</td><td>${item.thickness}</td><td>${item.volume}</td><td>${item.formwork_area}</td>`;
                tbody.appendChild(tr);
            });
            document.getElementById('qty-result').style.display = 'block';
        } else {
            alert('Error: ' + data.error);
        }
    } catch (e) { alert('Error: ' + e.message); }
}

async function runDesignChecks() {
    try {
        const resp = await fetch('/api/smart/design-checks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                check_bearing: true,
                total_vertical_load: parseFloat(document.getElementById('dc-load').value),
                base_width: parseFloat(document.getElementById('dc-base-w').value),
                eccentricity: parseFloat(document.getElementById('dc-ecc').value),
                allowable_bearing: parseFloat(document.getElementById('dc-sbc').value),
                check_uplift: true,
                clear_span: parseFloat(document.getElementById('qty-span')?.value || '4.0'),
                clear_height: parseFloat(document.getElementById('qty-height')?.value || '3.0'),
                top_slab_thickness: parseFloat(document.getElementById('qty-top')?.value || '0.3'),
                bottom_slab_thickness: parseFloat(document.getElementById('qty-bot')?.value || '0.35'),
                wall_thickness: parseFloat(document.getElementById('qty-wall')?.value || '0.3'),
                fill_depth: parseFloat(document.getElementById('dc-fill').value),
                water_table_depth: parseFloat(document.getElementById('dc-wt').value),
                required_fos: parseFloat(document.getElementById('dc-fos').value),
            }),
        });
        const data = await resp.json();
        if (data.success) {
            const cards = document.getElementById('dc-cards');
            cards.innerHTML = '';
            if (data.results.bearing) {
                const b = data.results.bearing;
                const cls = b.status === 'PASS' ? 'accent' : '';
                cards.innerHTML += `
                    <div class="summary-card ${cls}"><span class="summary-value">${b.max_base_pressure} kN/m²</span><span class="summary-label">Max Pressure</span></div>
                    <div class="summary-card"><span class="summary-value">${b.min_base_pressure} kN/m²</span><span class="summary-label">Min Pressure</span></div>
                    <div class="summary-card ${cls}"><span class="summary-value" style="color:${b.status === 'PASS' ? '#4ade80' : '#f87171'}">${b.status}</span><span class="summary-label">Bearing (${(b.utilization_ratio * 100).toFixed(0)}%)</span></div>
                `;
            }
            if (data.results.uplift) {
                const u = data.results.uplift;
                const cls = u.status === 'PASS' ? 'accent' : '';
                cards.innerHTML += `
                    <div class="summary-card"><span class="summary-value">${u.stabilizing_force}</span><span class="summary-label">Stabilizing (kN/m)</span></div>
                    <div class="summary-card"><span class="summary-value">${u.destabilizing_force}</span><span class="summary-label">Destabilizing (kN/m)</span></div>
                    <div class="summary-card ${cls}"><span class="summary-value" style="color:${u.status === 'PASS' ? '#4ade80' : '#f87171'}">${u.status} (FOS=${u.factor_of_safety})</span><span class="summary-label">Uplift Check</span></div>
                `;
            }
            document.getElementById('dc-result').style.display = 'block';
        } else {
            alert('Error: ' + data.error);
        }
    } catch (e) { alert('Error: ' + e.message); }
}

async function calcReinforcement() {
    try {
        const resp = await fetch('/api/smart/reinforcement', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fck: parseFloat(document.getElementById('rh-fck').value),
                fy: parseFloat(document.getElementById('rh-fy').value),
                elements: [{
                    name: 'Slab',
                    bm: parseFloat(document.getElementById('rh-bm').value),
                    thickness: parseFloat(document.getElementById('rh-thick').value),
                    clear_cover: parseFloat(document.getElementById('rh-cover').value),
                    bar_dia: parseInt(document.getElementById('rh-dia').value),
                }],
            }),
        });
        const data = await resp.json();
        if (data.success && data.results.length > 0) {
            const r = data.results[0];
            document.getElementById('rh-ast').textContent = r.ast_required;
            document.getElementById('rh-spacing').textContent = r.bar_dia + 'mm @ ' + r.spacing + 'mm';
            document.getElementById('rh-provided').textContent = r.ast_provided;
            document.getElementById('rh-formula').innerHTML = '<strong>Calculation:</strong><br>' + r.formula.replace(/\n/g, '<br>');
            if (r.status !== 'OK') {
                document.getElementById('rh-formula').innerHTML += `<br><span style="color:#f87171">⚠️ ${r.status}</span>`;
            }
            document.getElementById('rh-result').style.display = 'block';
        } else {
            alert('Error: ' + (data.error || 'No results'));
        }
    } catch (e) { alert('Error: ' + e.message); }
}

async function calcSkew() {
    try {
        const resp = await fetch('/api/smart/skew', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                skew_angle: parseFloat(document.getElementById('sk-angle').value),
                normal_span: parseFloat(document.getElementById('sk-span').value),
            }),
        });
        const data = await resp.json();
        if (data.success) {
            const r = data.result;
            document.getElementById('sk-skew-span').textContent = r.skew_span;
            document.getElementById('sk-moment').textContent = '×' + r.moment_correction_factor;
            document.getElementById('sk-shear').textContent = '×' + r.shear_correction_factor;
            document.getElementById('sk-result').style.display = 'block';
            const notesEl = document.getElementById('sk-notes');
            if (r.notes) {
                notesEl.textContent = r.notes;
                notesEl.style.display = 'block';
            } else {
                notesEl.style.display = 'none';
            }
        } else {
            alert('Error: ' + data.error);
        }
    } catch (e) { alert('Error: ' + e.message); }
}

async function genSTAADFile(download) {
    try {
        const body = {
            project_name: document.getElementById('project-name')?.value || 'Box Culvert',
            clear_span: parseFloat(document.getElementById('std-span').value),
            clear_height: parseFloat(document.getElementById('std-height').value),
            top_slab_thickness: parseFloat(document.getElementById('std-top').value),
            bottom_slab_thickness: parseFloat(document.getElementById('std-bot').value),
            wall_thickness: parseFloat(document.getElementById('std-wall').value),
            num_cells: parseInt(document.getElementById('std-cells').value),
            fck: parseFloat(document.getElementById('std-fck').value),
            download: download,
        };
        if (download) {
            // Download as file
            const resp = await fetch('/api/smart/staad-file', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'box_culvert.std';
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } else {
            const resp = await fetch('/api/smart/staad-file', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await resp.json();
            if (data.success) {
                document.getElementById('std-preview').textContent = data.staad_content;
                document.getElementById('std-result').style.display = 'block';
            } else {
                alert('Error: ' + data.error);
            }
        }
    } catch (e) { alert('Error: ' + e.message); }
}

async function genBBS() {
    try {
        const resp = await fetch('/api/smart/bbs', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clear_span: parseFloat(document.getElementById('bbs-span').value),
                clear_height: parseFloat(document.getElementById('bbs-height').value),
                top_slab_thickness: 0.3,
                bottom_slab_thickness: 0.35,
                wall_thickness: 0.3,
                culvert_length: parseFloat(document.getElementById('bbs-length').value),
                num_cells: parseInt(document.getElementById('bbs-cells').value),
                main_bar_dia: parseInt(document.getElementById('bbs-main').value),
                dist_bar_dia: parseInt(document.getElementById('bbs-dist').value),
                main_spacing: parseInt(document.getElementById('bbs-ms').value),
                dist_spacing: parseInt(document.getElementById('bbs-ds').value),
            }),
        });
        const data = await resp.json();
        if (data.success) {
            const r = data.result;
            document.getElementById('bbs-total').textContent = r.total_steel_weight + ' kg';
            document.getElementById('bbs-wastage').textContent = r.total_with_wastage + ' kg';
            const tbody = document.getElementById('bbs-tbody');
            tbody.innerHTML = '';
            r.items.forEach(item => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${item.bar_mark}</td><td>${item.member}</td><td>${item.bar_dia}mm</td><td>${item.shape}</td><td>${item.cut_length}m</td><td>${item.quantity}</td><td>${item.total_length}m</td><td>${item.total_weight}</td>`;
                tbody.appendChild(tr);
            });
            document.getElementById('bbs-result').style.display = 'block';
        } else {
            alert('Error: ' + data.error);
        }
    } catch (e) { alert('Error: ' + e.message); }
}

function copyText(elementId) {
    const text = document.getElementById(elementId).textContent;
    navigator.clipboard.writeText(text).then(() => {
        const btn = event.target;
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
    });
}


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: CRITICAL SAFETY - Smart Tools JS
// ═══════════════════════════════════════════════════════════════════════════════

async function calcCrackWidth() {
    try {
        const res = await fetch('/api/smart/crack-width', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bm_sls: +document.getElementById('cw-bm').value,
                slab_thickness: +document.getElementById('cw-thick').value,
                clear_cover: +document.getElementById('cw-cover').value,
                bar_diameter: +document.getElementById('cw-dia').value,
                bar_spacing: +document.getElementById('cw-spacing').value,
                exposure: document.getElementById('cw-exposure').value,
                fck: +document.getElementById('cw-fck').value,
                fy: +document.getElementById('cw-fy').value,
            }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        const r = data.result;
        document.getElementById('cw-wk').textContent = r.crack_width;
        document.getElementById('cw-perm').textContent = r.permissible_crack;
        document.getElementById('cw-status').textContent = r.status;
        document.getElementById('cw-status').style.color = r.status === 'PASS' ? '#10b981' : '#ef4444';
        document.getElementById('cw-sigma').textContent = r.sigma_sr;
        document.getElementById('cw-formula').textContent = r.formula + (r.notes ? '\n\n' + r.notes : '');
        document.getElementById('cw-result').style.display = 'block';
    } catch (e) { alert('Error: ' + e.message); }
}

async function calcShearCheck() {
    try {
        const res = await fetch('/api/smart/shear-check', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shear_force: +document.getElementById('sc-vu').value,
                slab_thickness: +document.getElementById('sc-thick').value,
                clear_cover: +document.getElementById('sc-cover').value,
                bar_diameter: +document.getElementById('sc-dia').value,
                ast_provided: +document.getElementById('sc-ast').value,
                stirrup_dia: +document.getElementById('sc-stirrup').value,
                fck: +document.getElementById('sc-fck').value,
                fy: +document.getElementById('sc-fy').value,
            }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        const r = data.result;
        document.getElementById('sc-tauv').textContent = r.tau_v;
        document.getElementById('sc-tauc').textContent = r.tau_c;
        document.getElementById('sc-taucmax').textContent = r.tau_c_max;
        document.getElementById('sc-status').textContent = r.shear_status;
        const isOk = r.shear_status.includes('NO SHEAR');
        document.getElementById('sc-status').style.color = r.shear_status.includes('INADEQUATE') ? '#ef4444' : (isOk ? '#10b981' : '#f59e0b');
        document.getElementById('sc-formula').textContent = r.formula + '\n\n' + r.notes;
        document.getElementById('sc-result').style.display = 'block';
    } catch (e) { alert('Error: ' + e.message); }
}

async function calcBrakingForce() {
    try {
        const res = await fetch('/api/smart/braking-force', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vehicle_class: document.getElementById('bf-vehicle').value,
                num_lanes: +document.getElementById('bf-lanes').value,
                bridge_width: +document.getElementById('bf-width').value,
                fill_depth: +document.getElementById('bf-fill').value,
            }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        const r = data.result;
        document.getElementById('bf-force').textContent = r.braking_force;
        document.getElementById('bf-perm').textContent = r.braking_per_meter;
        document.getElementById('bf-applied').textContent = r.applied ? 'YES' : 'NO';
        document.getElementById('bf-applied').style.color = r.applied ? '#f59e0b' : '#10b981';
        document.getElementById('bf-formula').textContent = r.formula + '\n\n' + r.notes;
        document.getElementById('bf-result').style.display = 'block';
    } catch (e) { alert('Error: ' + e.message); }
}


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2: PROFESSIONAL COMPLETENESS - Smart Tools JS
// ═══════════════════════════════════════════════════════════════════════════════

async function calcTempShrinkage() {
    try {
        const res = await fetch('/api/smart/temp-shrinkage', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                slab_thickness: +document.getElementById('ts-slab').value,
                fck: +document.getElementById('ts-fck').value,
                temp_rise: +document.getElementById('ts-rise').value,
                temp_fall: +document.getElementById('ts-fall').value,
                temp_diff: +document.getElementById('ts-diff').value,
                shrinkage_strain: +document.getElementById('ts-shrink').value / 1e6,
            }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        const r = data.result;
        document.getElementById('ts-rise-f').textContent = r.axial_force_rise;
        document.getElementById('ts-fall-f').textContent = r.axial_force_fall;
        document.getElementById('ts-moment').textContent = r.moment_differential;
        document.getElementById('ts-shrink-f').textContent = r.shrinkage_force;
        document.getElementById('ts-formula').textContent = r.formula + '\n\n' + r.notes;
        document.getElementById('ts-result').style.display = 'block';
    } catch (e) { alert('Error: ' + e.message); }
}

async function calcEffectiveWidth() {
    try {
        const res = await fetch('/api/smart/effective-width', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contact_width: +document.getElementById('ew-contact').value,
                span: +document.getElementById('ew-span').value,
                load_position: +document.getElementById('ew-pos').value,
                slab_width: +document.getElementById('ew-slabw').value,
                fill_depth: +document.getElementById('ew-fill').value,
                slab_type: document.getElementById('ew-type').value,
            }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        const r = data.result;
        document.getElementById('ew-beff').textContent = r.effective_width;
        document.getElementById('ew-disp').textContent = r.dispersion_width;
        document.getElementById('ew-formula').textContent = r.formula + (r.notes ? '\n\n' + r.notes : '');
        document.getElementById('ew-result').style.display = 'block';
    } catch (e) { alert('Error: ' + e.message); }
}

async function calcDeflection() {
    try {
        const res = await fetch('/api/smart/deflection', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                span: +document.getElementById('df-span').value,
                slab_thickness: +document.getElementById('df-thick').value,
                support_condition: document.getElementById('df-support').value,
                fck: +document.getElementById('df-fck').value,
            }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        const r = data.result;
        document.getElementById('df-actual').textContent = r.actual_ld;
        document.getElementById('df-allow').textContent = r.allowable_ld;
        document.getElementById('df-status').textContent = r.status;
        document.getElementById('df-status').style.color = r.status === 'PASS' ? '#10b981' : '#ef4444';
        document.getElementById('df-formula').textContent = r.formula + '\n\n' + r.notes;
        document.getElementById('df-result').style.display = 'block';
    } catch (e) { alert('Error: ' + e.message); }
}

async function calcSoilSprings() {
    try {
        const res = await fetch('/api/smart/soil-springs', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                base_width: +document.getElementById('ss-width').value,
                soil_type: document.getElementById('ss-soil').value,
                custom_ks: +document.getElementById('ss-ks').value,
                num_nodes: +document.getElementById('ss-nodes').value,
            }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        const r = data.result;
        document.getElementById('ss-ks-val').textContent = r.ks_value.toLocaleString();
        document.getElementById('ss-spring').textContent = r.spring_stiffness.toLocaleString();
        document.getElementById('ss-formula').textContent = r.formula + '\n\n' + r.notes;
        document.getElementById('ss-result').style.display = 'block';
    } catch (e) { alert('Error: ' + e.message); }
}

async function calcClearCover() {
    try {
        const res = await fetch('/api/smart/clear-cover', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                exposure: document.getElementById('cc-exposure').value,
                element: document.getElementById('cc-element').value,
            }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        const r = data.result;
        document.getElementById('cc-cover').textContent = r.min_cover_mm + 'mm';
        document.getElementById('cc-grade').textContent = r.min_grade;
        document.getElementById('cc-wc').textContent = r.max_wc_ratio;
        document.getElementById('cc-cement').textContent = r.min_cement + ' kg/m³';
        document.getElementById('cc-notes').textContent = r.notes;
        document.getElementById('cc-result').style.display = 'block';
    } catch (e) { alert('Error: ' + e.message); }
}


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: PREMIUM - Smart Tools JS
// ═══════════════════════════════════════════════════════════════════════════════

async function calcSettlement() {
    try {
        const res = await fetch('/api/smart/settlement', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                base_pressure: +document.getElementById('st-pressure').value,
                base_width: +document.getElementById('st-width').value,
                soil_type: document.getElementById('st-soil').value,
                Es_soil: +document.getElementById('st-es').value,
            }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        const r = data.result;
        document.getElementById('st-total').textContent = r.total_settlement;
        document.getElementById('st-imm').textContent = r.immediate_settlement;
        document.getElementById('st-cons').textContent = r.consolidation_settlement;
        document.getElementById('st-status').textContent = r.status;
        document.getElementById('st-status').style.color = r.status === 'PASS' ? '#10b981' : '#ef4444';
        document.getElementById('st-formula').textContent = r.formula + '\n\n' + r.notes;
        document.getElementById('st-result').style.display = 'block';
    } catch (e) { alert('Error: ' + e.message); }
}
