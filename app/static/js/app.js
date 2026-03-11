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
let currentSweepResult = null;
let resultsDirty = false;
let liveCalcTimer = null;
let isAutoCalculating = false;
let appMessageTimer = null;
let liveSweepTimer = null;
let isAutoSweeping = false;

const STANDARD_BOX_FIELDS = [
    {
        id: 'std-clear-span',
        label: 'Clear Span (m)',
        type: 'number',
        step: '0.01',
        min: '0',
        targetId: 'clear-span',
        hint: 'Inner clear span of one cell.',
    },
    {
        id: 'std-clear-height',
        label: 'Clear Height (m)',
        type: 'number',
        step: '0.01',
        min: '0',
        targetId: 'culvert-height',
        hint: 'Inner clear height of the cell.',
    },
    {
        id: 'std-top-slab',
        label: 'Top Slab Thickness (m)',
        type: 'number',
        step: '0.01',
        min: '0',
        targetId: 'slab-thickness',
        hint: 'Top slab thickness from standard or drawing.',
    },
    {
        id: 'std-bottom-slab',
        label: 'Bottom Slab Thickness (m)',
        type: 'number',
        step: '0.01',
        min: '0',
        targetId: 'bottom-slab-thickness',
        hint: 'Bottom slab thickness from standard or drawing.',
    },
    {
        id: 'std-ext-wall',
        label: 'External Wall Thickness (m)',
        type: 'number',
        step: '0.01',
        min: '0',
        targetId: 'wall-thickness',
        hint: 'External wall thickness from standard or drawing.',
    },
    {
        id: 'std-int-wall',
        label: 'Internal Wall Thickness (m)',
        type: 'number',
        step: '0.01',
        min: '0',
        targetId: 'mid-wall-thickness',
        hint: 'Internal wall thickness for multi-cell.',
    },
    {
        id: 'std-haunch',
        label: 'Haunch Size (m)',
        type: 'number',
        step: '0.01',
        min: '0',
        targetId: 'haunch-size',
        hint: 'Haunch/fillet at slab-wall junction.',
    },
    {
        id: 'std-fill-depth',
        label: 'Fill Depth (m)',
        type: 'number',
        step: '0.01',
        min: '0',
        targetId: 'fill-depth',
        hint: 'Fill above top slab (0 = no fill).',
    },
];

const GEOMETRY_TEMPLATES = {
    NONE: { label: 'None (use structure inputs)', auto_apply: false },
    JOINT_21_6: {
        label: 'Joint-Based 21.6m (custom breakpoints)',
        custom_breakpoints: [
            0, 0.45, 0.95, 5.45, 9.95, 10.45, 10.8, 11.15, 11.65, 16.15, 20.65, 21.15, 21.6
        ],
        custom_wall_ranges: [
            [0, 0.45],
            [9.95, 10.45],
            [21.15, 21.6],
        ],
    },
    MORTH_USER: {
        label: 'MoRTH RCC Box (enter drawing dims)',
        auto_apply: false,
        fields: [
            ...STANDARD_BOX_FIELDS,
            {
                id: 'morth-num-cells',
                label: 'Number of Cells',
                type: 'number',
                step: '1',
                min: '1',
                targetId: 'num-cells',
                hint: 'Use 1 for single-cell, 2+ for multi-cell.',
            },
        ],
    },
    MORTH_RCC_1C: {
        label: 'MoRTH RCC Box — Single Cell (fields)',
        auto_apply: true,
        structure_type: 'BOX_CULVERT_1CELL',
        settings: { 'num-cells': 1 },
        fields: STANDARD_BOX_FIELDS,
    },
    MORTH_RCC_2C: {
        label: 'MoRTH RCC Box — Two Cell (fields)',
        auto_apply: true,
        structure_type: 'BOX_CULVERT_2CELL',
        settings: { 'num-cells': 2 },
        fields: STANDARD_BOX_FIELDS,
    },
    MORTH_RCC_3C: {
        label: 'MoRTH RCC Box — Three Cell (fields)',
        auto_apply: true,
        structure_type: 'BOX_CULVERT_3CELL',
        settings: { 'num-cells': 3 },
        fields: STANDARD_BOX_FIELDS,
    },
    IRC_SP13_1C: {
        label: 'IRC SP-13 Box Culvert — Single Cell (fields)',
        auto_apply: true,
        structure_type: 'BOX_CULVERT_1CELL',
        settings: { 'num-cells': 1 },
        fields: STANDARD_BOX_FIELDS,
    },
    IRC_SP13_2C: {
        label: 'IRC SP-13 Box Culvert — Two Cell (fields)',
        auto_apply: true,
        structure_type: 'BOX_CULVERT_2CELL',
        settings: { 'num-cells': 2 },
        fields: STANDARD_BOX_FIELDS,
    },
};

const GEOMETRY_TEMPLATE_ORDER = [
    'NONE',
    'JOINT_21_6',
    'MORTH_USER',
    'MORTH_RCC_1C',
    'MORTH_RCC_2C',
    'MORTH_RCC_3C',
    'IRC_SP13_1C',
    'IRC_SP13_2C',
];

function formatNumber(value, decimals = 3) {
    if (!Number.isFinite(value)) return '';
    const fixed = value.toFixed(decimals);
    return fixed.replace(/\.?0+$/, '');
}

function formatBreakpoints(values) {
    if (!Array.isArray(values)) return '';
    return values.map(v => formatNumber(v, 3)).filter(Boolean).join(', ');
}

function formatWallRanges(ranges) {
    if (!Array.isArray(ranges)) return '';
    return ranges
        .map(pair => {
            if (!Array.isArray(pair) || pair.length !== 2) return '';
            return `${formatNumber(pair[0], 3)}-${formatNumber(pair[1], 3)}`;
        })
        .filter(Boolean)
        .join(', ');
}

function setInputValueById(id, value) {
    if (!id) return;
    const nodes = document.querySelectorAll(`[id="${id}"]`);
    if (!nodes.length) return;
    nodes.forEach(node => {
        if (node && 'value' in node) node.value = value;
    });
}

function populateGeometryTemplateOptions() {
    const select = document.getElementById('geometry-template');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '';
    GEOMETRY_TEMPLATE_ORDER.forEach(key => {
        const tpl = GEOMETRY_TEMPLATES[key];
        if (!tpl) return;
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = tpl.label || key;
        select.appendChild(opt);
    });
    if (current && GEOMETRY_TEMPLATES[current]) {
        select.value = current;
    } else if (GEOMETRY_TEMPLATE_ORDER.length) {
        select.value = GEOMETRY_TEMPLATE_ORDER[0];
    }
}

function renderGeometryTemplateFields(templateKey) {
    const container = document.getElementById('geometry-template-fields');
    const grid = document.getElementById('geometry-template-fields-grid');
    const applyBtn = document.getElementById('geometry-template-apply');
    if (!container || !grid || !applyBtn) return;

    const template = GEOMETRY_TEMPLATES[templateKey];
    const fields = template && Array.isArray(template.fields) ? template.fields : [];

    grid.innerHTML = '';
    if (!fields.length) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    fields.forEach(field => {
        const wrapper = document.createElement('div');
        wrapper.className = 'form-group';

        const label = document.createElement('label');
        label.textContent = field.label || field.id;
        wrapper.appendChild(label);

        let input;
        if (field.type === 'select') {
            input = document.createElement('select');
            (field.options || []).forEach(opt => {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label || opt.value;
                input.appendChild(o);
            });
        } else {
            input = document.createElement('input');
            input.type = field.type || 'text';
            if (field.step) input.step = field.step;
            if (field.min !== undefined) input.min = field.min;
            if (field.max !== undefined) input.max = field.max;
            if (field.placeholder) input.placeholder = field.placeholder;
        }

        input.id = `geometry-template-field-${field.id}`;
        if (field.targetId) input.dataset.targetId = field.targetId;

        if (field.targetId) {
            const target = document.querySelector(`[id="${field.targetId}"]`);
            if (target && target.value !== undefined && target.value !== '') {
                input.value = target.value;
            } else if (field.default !== undefined) {
                input.value = field.default;
            }
        } else if (field.default !== undefined) {
            input.value = field.default;
        }

        wrapper.appendChild(input);

        if (field.hint) {
            const hint = document.createElement('span');
            hint.className = 'field-hint';
            hint.textContent = field.hint;
            wrapper.appendChild(hint);
        }

        grid.appendChild(wrapper);
    });

    applyBtn.onclick = () => applyGeometryTemplateFields(templateKey);
}

function applyGeometryTemplate(templateKey) {
    const template = GEOMETRY_TEMPLATES[templateKey];
    if (!template) return;

    if (template.custom_breakpoints) {
        setInputValueById('custom-breakpoints', formatBreakpoints(template.custom_breakpoints));
    }
    if (template.custom_wall_ranges) {
        setInputValueById('custom-wall-ranges', formatWallRanges(template.custom_wall_ranges));
    }
    if (template.settings) {
        Object.entries(template.settings).forEach(([id, value]) => {
            setInputValueById(id, value);
        });
    }
    if (template.structure_type) {
        setInputValueById('structure-type', template.structure_type);
    }
}

function applyGeometryTemplateFields(templateKey) {
    const template = GEOMETRY_TEMPLATES[templateKey];
    if (!template || !Array.isArray(template.fields) || !template.fields.length) return;

    template.fields.forEach(field => {
        const input = document.getElementById(`geometry-template-field-${field.id}`);
        if (!input || !field.targetId) return;
        const raw = String(input.value || '').trim();
        if (!raw) return;
        setInputValueById(field.targetId, raw);
    });

    onDataChanged('settings');
    if (memberMode === 'auto') generateBoxCulvertMembers();
}

function handleGeometryTemplateSelection(templateKey) {
    renderGeometryTemplateFields(templateKey);
    const template = GEOMETRY_TEMPLATES[templateKey];
    if (!template || template.auto_apply === false) {
        onDataChanged('settings');
        return;
    }
    applyGeometryTemplate(templateKey);
    if (memberMode === 'auto') generateBoxCulvertMembers();
    onDataChanged('settings');
}

// ─── Tab Switching ──────────────────────────────────────────────────────────

function switchTab(tabId) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
    clearAppMessages();

    if (tabId === 'geometry') updateVisualization();
    if (tabId === 'results') {
        updateRunReadinessPanel();
        updateResultsVisualization();
        if (currentOverlaps.length && !resultsDirty) setTimeout(() => renderResultsFrameViz(), 50);
        if (currentSweepResult && typeof renderLongitudinalSweepViz === 'function') {
            setTimeout(() => renderLongitudinalSweepViz(), 60);
        }
    }
}

// ─── Member Mode ────────────────────────────────────────────────────────────

function setMemberMode(mode) {
    memberMode = mode;
    document.getElementById('member-auto').style.display = mode === 'auto' ? 'block' : 'none';
    document.getElementById('member-manual').style.display = mode === 'manual' ? 'block' : 'none';
    document.getElementById('auto-mode-btn').classList.toggle('active', mode === 'auto');
    document.getElementById('manual-mode-btn').classList.toggle('active', mode === 'manual');

    if (mode === 'auto') {
        const stype = document.getElementById('structure-type')?.value || '';
        if (stype.startsWith('BOX_CULVERT_')) generateBoxCulvertMembers();
    }
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
        if (!raw) {
            notifyUser('Please enter custom widths (comma-separated).', 'warning', {
                hint: 'Provide strip widths that add up to Total Width.',
            });
            return;
        }

        const widths = raw.split(/[\s,]+/).map(v => parseFloat(v.trim())).filter(v => !isNaN(v) && v > 0);
        if (widths.length === 0) {
            notifyUser('Invalid widths. Enter numbers separated by commas.', 'warning', {
                hint: 'Use positive numeric values like 0.8,1.2,1.5.',
            });
            return;
        }

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

    onDataChanged('members');
}

function generateBoxCulvertMembers() {
    // ── Read all Structure Configuration inputs ──
    const clearSpan  = parseFloat(document.getElementById('clear-span').value) || 4.0;
    const numCells   = parseInt(document.getElementById('num-cells').value, 10) || 1;
    const extWall    = parseFloat(document.getElementById('wall-thickness').value) || 0.3;
    const intWall    = parseFloat(document.getElementById('mid-wall-thickness').value) || 0.3;
    let   haunch     = parseFloat(document.getElementById('haunch-size').value) || 0.0;
    const clearHt    = parseFloat(document.getElementById('culvert-height').value) || 3.0;
    const topThk     = parseFloat(document.getElementById('slab-thickness').value) || 0.3;
    const botThk     = parseFloat(document.getElementById('bottom-slab-thickness').value) || 0.35;
    const startId    = parseInt(document.getElementById('auto-start-id').value) || 1001;

    if (2 * haunch >= clearSpan) haunch = clearSpan / 2.0 - 0.01;

    const customBreakpointsRaw = document.getElementById('custom-breakpoints')?.value || '';
    const customWallRangesRaw = document.getElementById('custom-wall-ranges')?.value || '';
    const customBreakpoints = parseNumericList(customBreakpointsRaw);
    const customWallRanges = parseWallRanges(customWallRangesRaw);

    if (customBreakpoints.length >= 2) {
        generateMembersFromBreakpoints(customBreakpoints, customWallRanges, startId);
        return;
    }

    const tbody = document.getElementById('member-tbody');
    tbody.innerHTML = '';

    let currentId = startId;
    const totalWidth = numCells * clearSpan + 2 * extWall + Math.max(0, numCells - 1) * intWall;

    // ────────────────────────────────────────────────────────────
    // Helper: adds a row to the member table
    // For horizontal members: start/end = x positions along width
    // For vertical members:   start/end = y positions along height
    // ────────────────────────────────────────────────────────────
    function addRow(startVal, endVal, group, label) {
        const w = endVal - startVal;
        if (w <= 0) return;
        addMemberRowWithData(
            currentId++,
            startVal.toFixed(4), endVal.toFixed(4),
            w.toFixed(4), group, label
        );
    }

    // ══════════════════════════════════════════════════════════════
    // 1. TOP SLAB  (horizontal, left-to-right across the width)
    //    Layout: [ExtWall | Haunch? | Span | Haunch? | IntWall | … | ExtWall]
    // ══════════════════════════════════════════════════════════════
    let x = 0;
    x += extWall;  // skip left wall thickness (wall is a separate vertical member)

    for (let i = 1; i <= numCells; i++) {
        if (i > 1) x += intWall;  // skip intermediate wall thickness
        if (haunch > 0) {
            addRow(x, x + haunch, 'TOP_SLAB', `TS Cell${i} L-Haunch`);
            x += haunch;
        }
        const spanNet = clearSpan - 2 * haunch;
        addRow(x, x + spanNet, 'TOP_SLAB', `TS Cell${i} Span`);
        x += spanNet;
        if (haunch > 0) {
            addRow(x, x + haunch, 'TOP_SLAB', `TS Cell${i} R-Haunch`);
            x += haunch;
        }
    }

    // ══════════════════════════════════════════════════════════════
    // 2. BOTTOM SLAB  (horizontal, same layout as top slab)
    // ══════════════════════════════════════════════════════════════
    x = extWall;
    for (let i = 1; i <= numCells; i++) {
        if (i > 1) x += intWall;
        if (haunch > 0) {
            addRow(x, x + haunch, 'BOTTOM_SLAB', `BS Cell${i} L-Haunch`);
            x += haunch;
        }
        const spanNet = clearSpan - 2 * haunch;
        addRow(x, x + spanNet, 'BOTTOM_SLAB', `BS Cell${i} Span`);
        x += spanNet;
        if (haunch > 0) {
            addRow(x, x + haunch, 'BOTTOM_SLAB', `BS Cell${i} R-Haunch`);
            x += haunch;
        }
    }

    // ══════════════════════════════════════════════════════════════
    // 3. WALLS  (vertical members, start/end = transverse X position)
    // ══════════════════════════════════════════════════════════════
    // Let's reset purely for calculating wall positions transversely
    // Left Wall
    addRow(0, extWall, 'LEFT_WALL', 'Left Wall');

    // Intermediate Walls
    x = extWall;
    for (let i = 1; i < numCells; i++) {
        x += clearSpan;
        addRow(x, x + intWall, `MIDDLE_WALL_${i}`, `Mid Wall ${i}`);
        x += intWall;
    }

    // Right Wall
    addRow(totalWidth - extWall, totalWidth, 'RIGHT_WALL', 'Right Wall');

    // ── Update total width and UI state ──
    document.getElementById('total-width').value = totalWidth.toFixed(4);
    document.getElementById('culvert-height').value = clearHt;

    // Switch width mode to custom
    document.getElementById('width-mode').value = 'custom';
    toggleWidthMode();
    
    // Only use TOP_SLAB widths for the custom-widths input array,
    // otherwise it sums everything (top + bottom + walls) and shows an error.
    const topSlabRows = Array.from(tbody.querySelectorAll('tr')).filter(row => {
        const sel = row.querySelector('.m-group');
        return sel && sel.value === 'TOP_SLAB';
    });
    
    // Fallback: if no TOP_SLAB, use all members
    const rowsToUse = topSlabRows.length > 0 ? topSlabRows : Array.from(tbody.querySelectorAll('tr'));
    const widthsList = rowsToUse.map(row => row.querySelector('.m-width').textContent).join(', ');
    
    document.getElementById('custom-widths').value = widthsList;
    updateCustomWidthsFeedback();

    onDataChanged('members');
}

function generateMembersFromBreakpoints(breakpoints, wallRanges, startId) {
    const tbody = document.getElementById('member-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const points = uniqueSorted(breakpoints, 1e-6);
    if (points.length < 2) {
        notifyUser('Custom breakpoints need at least two values.', 'warning');
        return;
    }

    const minX = points[0];
    const xs = points.map(x => x - minX);
    const totalWidth = xs[xs.length - 1];

    const segments = [];
    for (let i = 0; i < xs.length - 1; i++) {
        const s = xs[i];
        const e = xs[i + 1];
        if (e > s) segments.push({ start: s, end: e, width: e - s });
    }

    let wallRangesNorm = (wallRanges || []).map(([a, b]) => {
        const s = Math.min(a, b) - minX;
        const e = Math.max(a, b) - minX;
        return [s, e];
    });
    if (!wallRangesNorm.length && segments.length >= 2) {
        wallRangesNorm = [
            [segments[0].start, segments[0].end],
            [segments[segments.length - 1].start, segments[segments.length - 1].end],
        ];
    }
    wallRangesNorm.sort((a, b) => a[0] - b[0]);

    const isWallSegment = (seg) => {
        for (let i = 0; i < wallRangesNorm.length; i++) {
            const [ws, we] = wallRangesNorm[i];
            if (seg.start >= ws - 1e-6 && seg.end <= we + 1e-6) return i;
        }
        return null;
    };

    const wallIndexToGroup = (idx) => {
        if (idx === 0) return 'LEFT_WALL';
        if (idx === wallRangesNorm.length - 1) return 'RIGHT_WALL';
        return `MIDDLE_WALL_${Math.min(3, idx)}`;
    };

    const slabSegments = [];
    const wallSegments = [];
    let midWallCount = 0;

    segments.forEach(seg => {
        const widx = isWallSegment(seg);
        if (widx === null) {
            slabSegments.push(seg);
            return;
        }
        let group = wallIndexToGroup(widx);
        if (group.startsWith('MIDDLE_WALL_')) midWallCount += 1;
        const label = group === 'LEFT_WALL' ? 'Left Wall'
            : group === 'RIGHT_WALL' ? 'Right Wall'
                : `Mid Wall ${midWallCount}`;
        wallSegments.push({ ...seg, group, label });
    });

    let currentId = startId;
    slabSegments.forEach(seg => {
        addMemberRowWithData(currentId++, seg.start.toFixed(4), seg.end.toFixed(4), seg.width.toFixed(4), 'TOP_SLAB', 'Slab Segment');
    });
    slabSegments.forEach(seg => {
        addMemberRowWithData(currentId++, seg.start.toFixed(4), seg.end.toFixed(4), seg.width.toFixed(4), 'BOTTOM_SLAB', 'Slab Segment');
    });
    wallSegments.forEach(seg => {
        addMemberRowWithData(currentId++, seg.start.toFixed(4), seg.end.toFixed(4), seg.width.toFixed(4), seg.group, seg.label);
    });

    document.getElementById('total-width').value = totalWidth.toFixed(4);
    document.getElementById('width-mode').value = 'custom';
    toggleWidthMode();

    const widthsList = slabSegments.map(s => s.width.toFixed(4)).join(', ');
    const customWidths = document.getElementById('custom-widths');
    if (customWidths) customWidths.value = widthsList;
    updateCustomWidthsFeedback();

    onDataChanged('members');
}

function importJointCoordinates() {
    const textarea = document.getElementById('joint-coordinates');
    if (!textarea) return;
    const raw = String(textarea.value || '').trim();
    if (!raw) {
        notifyUser('Paste joint coordinates first.', 'warning', {
            hint: 'Use STAAD.Pro JOINT COORDINATES lines like: 1 0.000 10.775 0;'
        });
        return;
    }

    const inferSettings = document.getElementById('joint-infer-settings')?.checked ?? true;
    const parsed = parseJointCoordinates(raw);

    if (parsed.xs.length < 2) {
        notifyUser('No valid joint coordinates found.', 'error', {
            hint: 'Expected lines with id x y z or x y z values.'
        });
        return;
    }

    const tol = 1e-4;
    // Separate by Y-level if possible to avoid super-meshing top and bottom slabs
    let xs = uniqueSorted(parsed.xs, tol);
    
    if (parsed.ys.length > 0) {
        const maxY = Math.max(...parsed.ys);
        const topXs = uniqueSorted(parsed.joints.filter(j => approxEqual(j.y, maxY, 0.1)).map(j => j.x), tol);
        if (topXs.length >= 2) {
            xs = topXs; // Favor the top slab mesh for generic transverse members
        }
    }

    if (xs.length < 2) {
        notifyUser('Not enough distinct X positions to build members.', 'error');
        return;
    }

    const xMin = xs[0];
    const shifted = xs.map(x => x - xMin);
    const totalWidth = shifted[shifted.length - 1];

    const segments = [];
    for (let i = 0; i < shifted.length - 1; i++) {
        const start = shifted[i];
        const end = shifted[i + 1];
        if (end - start > tol) segments.push({ start, end, width: end - start });
    }

    if (!segments.length) {
        notifyUser('No valid segment spans found.', 'error');
        return;
    }

    // Infer basic structure settings from X/Y coordinates
    if (inferSettings) {
        const widths = segments.map(s => roundTo(s.width, 3));
        const widthCounts = countByKey(widths);

        const clearSpan = inferClearSpan(widthCounts);
        const numCells = clearSpan ? widths.filter(w => approxEqual(w, clearSpan, 0.02)).length : 1;

        const leftWall = roundTo(segments[0].width, 3);
        const rightWall = roundTo(segments[segments.length - 1].width, 3);
        const wallThickness = approxEqual(leftWall, rightWall, 0.02) ? roundTo((leftWall + rightWall) / 2, 3) : leftWall;
        const midWallThickness = inferMidWall(widthCounts, wallThickness);
        const haunchSize = inferHaunch(widthCounts, wallThickness, midWallThickness, clearSpan);

        const totalWidthEl = document.getElementById('total-width');
        if (totalWidthEl) totalWidthEl.value = totalWidth.toFixed(3);

        if (clearSpan) {
            const clearSpanEl = document.getElementById('clear-span');
            if (clearSpanEl) clearSpanEl.value = clearSpan.toFixed(3);
        }

        const numCellsEl = document.getElementById('num-cells');
        if (numCellsEl) numCellsEl.value = Math.max(1, numCells);

        const wallEl = document.getElementById('wall-thickness');
        if (wallEl) wallEl.value = wallThickness.toFixed(3);

        const midWallEl = document.getElementById('mid-wall-thickness');
        if (midWallEl && Number.isFinite(midWallThickness)) midWallEl.value = midWallThickness.toFixed(3);

        const haunchEl = document.getElementById('haunch-size');
        if (haunchEl && Number.isFinite(haunchSize)) haunchEl.value = haunchSize.toFixed(3);

        const stypeEl = document.getElementById('structure-type');
        if (stypeEl) {
            const capped = Math.min(4, Math.max(1, numCells));
            stypeEl.value = `BOX_CULVERT_${capped}CELL`;
        }

        const topThk = parseFloat(document.getElementById('slab-thickness')?.value);
        const botThk = parseFloat(document.getElementById('bottom-slab-thickness')?.value);
        const ys = uniqueSorted(parsed.ys, tol);
        if (ys.length >= 2 && Number.isFinite(topThk) && Number.isFinite(botThk)) {
            const totalH = ys[ys.length - 1] - ys[0];
            const clearH = totalH - topThk - botThk;
            if (clearH > 0) {
                const chEl = document.getElementById('culvert-height');
                if (chEl) chEl.value = clearH.toFixed(3);
            }
        }

        onDataChanged('settings');
    } else {
        const totalWidthEl = document.getElementById('total-width');
        if (totalWidthEl) totalWidthEl.value = totalWidth.toFixed(3);
    }

    // Build members from segments
    const startId = parseInt(document.getElementById('auto-start-id')?.value, 10) || 1001;
    const extWall = parseFloat(document.getElementById('wall-thickness')?.value) || segments[0].width;
    const midWall = parseFloat(document.getElementById('mid-wall-thickness')?.value) || extWall;
    const haunch = parseFloat(document.getElementById('haunch-size')?.value) || 0;
    const clearSpanVal = parseFloat(document.getElementById('clear-span')?.value) || null;

    const rows = [];
    const slabSegments = [];
    const wallSegments = [];
    let midWallIndex = 1;

    segments.forEach((seg, idx) => {
        if (idx === 0) {
            wallSegments.push({ ...seg, group: 'LEFT_WALL', label: 'Left Wall' });
        } else if (idx === segments.length - 1) {
            wallSegments.push({ ...seg, group: 'RIGHT_WALL', label: 'Right Wall' });
        } else if (approxEqual(seg.width, midWall, 0.02)) {
            const wallGroup = `MIDDLE_WALL_${Math.min(3, midWallIndex)}`;
            wallSegments.push({ ...seg, group: wallGroup, label: `Mid Wall ${midWallIndex}` });
            midWallIndex += 1;
        } else {
            slabSegments.push(seg);
        }
    });

    const classifySlabLabel = (seg) => {
        if (haunch > 0 && approxEqual(seg.width, haunch, 0.02)) return 'Haunch';
        if (clearSpanVal && approxEqual(seg.width, clearSpanVal, 0.05)) return 'Span';
        return 'Slab Segment';
    };

    let currentId = startId;
    slabSegments.forEach(seg => {
        rows.push({
            id: currentId++,
            start: seg.start,
            end: seg.end,
            group: 'TOP_SLAB',
            label: classifySlabLabel(seg),
        });
    });

    slabSegments.forEach(seg => {
        rows.push({
            id: currentId++,
            start: seg.start,
            end: seg.end,
            group: 'BOTTOM_SLAB',
            label: classifySlabLabel(seg),
        });
    });

    wallSegments.forEach(seg => {
        rows.push({
            id: currentId++,
            start: seg.start,
            end: seg.end,
            group: seg.group,
            label: seg.label,
        });
    });

    const tbody = document.getElementById('member-tbody');
    if (tbody) tbody.innerHTML = '';
    rows.forEach(m => {
        const width = (m.end - m.start).toFixed(4);
        addMemberRowWithData(m.id, m.start.toFixed(4), m.end.toFixed(4), width, m.group, m.label);
    });

    // Switch to manual mode so imported geometry is not overwritten
    setMemberMode('manual');
    document.getElementById('width-mode').value = 'custom';
    toggleWidthMode();

    const widthsList = slabSegments.map(s => s.width.toFixed(4)).join(', ');
    const customWidths = document.getElementById('custom-widths');
    if (customWidths) customWidths.value = widthsList;
    updateCustomWidthsFeedback();

    onDataChanged('members');
    notifyUser('Imported joint coordinates and generated members.', 'success', {
        hint: 'Review the Members table and diagrams, then adjust groups if needed.'
    });
}

function parseJointCoordinates(raw) {
    const xs = [];
    const ys = [];
    const joints = [];
    const lines = String(raw || '').split(/\r?\n/);
    lines.forEach(line => {
        const nums = line.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/g);
        if (!nums || nums.length < 3) return;
        const vals = nums.map(v => Number.parseFloat(v));
        let x;
        let y;
        if (vals.length >= 4) {
            x = vals[1];
            y = vals[2];
        } else {
            x = vals[0];
            y = vals[1];
        }
        if (Number.isFinite(x) && Number.isFinite(y)) {
            xs.push(x);
            ys.push(y);
            joints.push({x, y});
        }
    });
    return { xs, ys, joints };
}

function parseNumericList(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];
    return text
        .replace(/;/g, ',')
        .replace(/\s+/g, ',')
        .split(',')
        .map(v => v.trim())
        .filter(v => v.length > 0)
        .map(v => Number.parseFloat(v))
        .filter(Number.isFinite);
}

function parseWallRanges(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];
    return text
        .replace(/;/g, ',')
        .split(',')
        .map(v => v.trim())
        .filter(v => v.length > 0)
        .map(pair => {
            const [a, b] = pair.split('-').map(x => Number.parseFloat(x.trim()));
            if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
            return [a, b];
        })
        .filter(Boolean);
}

function uniqueSorted(values, tol = 1e-6) {
    const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
    const out = [];
    sorted.forEach(v => {
        if (!out.length || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
    });
    return out;
}

function roundTo(val, places) {
    const p = Math.pow(10, places);
    return Math.round(val * p) / p;
}

function approxEqual(a, b, tol = 0.01) {
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
}

function countByKey(values) {
    const map = new Map();
    values.forEach(v => {
        const key = v.toFixed(3);
        map.set(key, (map.get(key) || 0) + 1);
    });
    return map;
}

function inferClearSpan(counts) {
    let best = null;
    counts.forEach((count, key) => {
        const val = Number.parseFloat(key);
        if (!Number.isFinite(val) || val < 1.0) return;
        if (!best || count > best.count || (count === best.count && val > best.value)) {
            best = { value: val, count };
        }
    });
    return best ? best.value : null;
}

function inferMidWall(counts, extWall) {
    let best = null;
    counts.forEach((count, key) => {
        const val = Number.parseFloat(key);
        if (!Number.isFinite(val) || val <= 0 || val >= 1.0) return;
        if (approxEqual(val, extWall, 0.02)) return;
        if (!best || count > best.count) best = { value: val, count };
    });
    return best ? best.value : extWall;
}

function inferHaunch(counts, extWall, midWall, clearSpan) {
    let best = null;
    counts.forEach((count, key) => {
        const val = Number.parseFloat(key);
        if (!Number.isFinite(val) || val <= 0) return;
        if (approxEqual(val, extWall, 0.02) || approxEqual(val, midWall, 0.02)) return;
        if (clearSpan && approxEqual(val, clearSpan, 0.05)) return;
        if (count >= 2 && (!best || val < best.value)) best = { value: val, count };
    });
    return best ? best.value : 0;
}

function syncStructureConfig() {
    const type = document.getElementById('structure-type').value;
    const numCellsInput = document.getElementById('num-cells');
    
    // Auto-update Number of Cells based on dropdown
    if (type.startsWith('BOX_CULVERT_')) {
        const cellsMatch = type.match(/\d+/);
        if (cellsMatch) {
            numCellsInput.value = cellsMatch[0];
            onDataChanged('settings');
            
            // Auto-trigger Box Culvert generation to instantly update Geometry tab
            generateBoxCulvertMembers();
        }
    }
}

function toggleWidthMode() {
    const mode = document.getElementById('width-mode').value;
    document.getElementById('equal-strips-group').style.display = mode === 'equal' ? 'block' : 'none';
    document.getElementById('custom-widths-group').style.display = mode === 'custom' ? 'block' : 'none';

    // Live feedback for custom widths
    if (mode === 'custom') {
        const input = document.getElementById('custom-widths');
        if (!input.dataset.feedbackBound) {
            input.addEventListener('input', updateCustomWidthsFeedback);
            input.dataset.feedbackBound = '1';
        }
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
    onDataChanged('members');
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
            <option value="MIDDLE_WALL_2" ${group === 'MIDDLE_WALL_2' ? 'selected' : ''}>Middle Wall 2</option>
            <option value="MIDDLE_WALL_3" ${group === 'MIDDLE_WALL_3' ? 'selected' : ''}>Middle Wall 3</option>
        </select></td>
        <td><input type="text" value="${label}" class="m-label"></td>
        <td><button class="btn btn-xs btn-danger" onclick="removeMemberRow(this)">✕</button></td>
    `;
}

function collectMembers() {
    return collectMemberRowsDetailed()
        .filter(r => r.valid)
        .map(r => r.member);
}

// ─── Load Table ─────────────────────────────────────────────────────────────

function addLoadRow() {
    const tbody = document.getElementById('load-tbody');
    const rows = tbody.rows.length;
    const loadId = `L${rows + 1}`;
    addLoadRowWithData(loadId, 'LC1', 'PARTIAL_UDL', '', '', '', '', 'GY', '');
    onDataChanged('loads');
}

function addLoadRowWithData(id, lcase, type, start, end, intensity, intensityEnd, dir, notes) {
    const tbody = document.getElementById('load-tbody');
    const row = tbody.insertRow();

    const loadTypes = [
        'PARTIAL_UDL', 'PATCH_LOAD',
        'IRC_CLASS_AA', 'IRC_70R', 'IRC_CLASS_A',
        'SINGLE_AXLE_BOGIE', 'DOUBLE_AXLE_BOGIE',
        'EARTH_PRESSURE', 'SURCHARGE', 'HYDROSTATIC',
        'DEAD_LOAD', 'WEARING_COURSE', 'BRAKING', 'CUSTOM',
    ];
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
        <td><button class="btn btn-xs btn-danger" onclick="removeLoadRow(this)">✕</button></td>
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
    onDataChanged('loads');
}

function collectLoads() {
    return collectLoadRowsDetailed()
        .filter(r => r.valid)
        .map(r => r.load);
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
        geometry_template: document.getElementById('geometry-template')?.value || 'NONE',
        total_width: parseFloat(document.getElementById('total-width').value),
        reference_axis: document.getElementById('reference-axis').value,
        custom_datum: parseFloat(document.getElementById('custom-datum').value) || 0,
        culvert_height: parseFloat(document.getElementById('culvert-height').value),
        clear_span: parseFloat(document.getElementById('clear-span').value) || 4.0,
        num_cells: parseInt(document.getElementById('num-cells').value, 10) || 1,
        fill_depth: parseFloat(document.getElementById('fill-depth').value) || 0,
        slab_thickness: parseFloat(document.getElementById('slab-thickness').value),
        bottom_slab_thickness: parseFloat(document.getElementById('bottom-slab-thickness').value),
        wall_thickness: parseFloat(document.getElementById('wall-thickness').value),
        mid_wall_thickness: parseFloat(document.getElementById('mid-wall-thickness').value) || 0.3,
        haunch_size: parseFloat(document.getElementById('haunch-size').value) || 0.0,
        custom_breakpoints: parseNumericList(document.getElementById('custom-breakpoints')?.value || ''),
        custom_wall_ranges: parseWallRanges(document.getElementById('custom-wall-ranges')?.value || ''),
        decimal_precision: parseInt(document.getElementById('decimal-precision').value, 10),
        units: document.getElementById('units').value,
        overhang_policy: document.getElementById('overhang-policy').value,
        start_member_number: parseInt(document.getElementById('start-member').value) || 1001,
        member_increment: 1,
    };
}

function removeMemberRow(btn) {
    btn.closest('tr').remove();
    onDataChanged('members');
}

function removeLoadRow(btn) {
    btn.closest('tr').remove();
    onDataChanged('loads');
}

function updateMemberWidthCell(row) {
    if (!row) return;
    const start = parseFloat(row.querySelector('.m-start')?.value);
    const end = parseFloat(row.querySelector('.m-end')?.value);
    const widthEl = row.querySelector('.m-width');
    if (!widthEl) return;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        widthEl.textContent = (end - start).toFixed(4);
    } else {
        widthEl.textContent = '';
    }
}

function updateAllMemberWidths() {
    const rows = document.querySelectorAll('#member-tbody tr');
    rows.forEach(updateMemberWidthCell);
}

function collectMemberRowsDetailed() {
    const rows = Array.from(document.querySelectorAll('#member-tbody tr'));
    return rows.map((row, idx) => {
        const errors = [];
        const rowNo = idx + 1;
        const idEl = row.querySelector('.m-id');
        const startEl = row.querySelector('.m-start');
        const endEl = row.querySelector('.m-end');
        const groupEl = row.querySelector('.m-group');
        const labelEl = row.querySelector('.m-label');

        const idRaw = String(idEl?.value || '').trim();
        const startRaw = String(startEl?.value || '').trim();
        const endRaw = String(endEl?.value || '').trim();

        const id = Number.parseInt(idRaw, 10);
        const start = Number.parseFloat(startRaw);
        const end = Number.parseFloat(endRaw);
        const group = String(groupEl?.value || 'GENERAL').trim().toUpperCase();
        const label = String(labelEl?.value || '');

        if (!idRaw) errors.push({ message: `Members row ${rowNo}: Member ID is required.`, element: idEl });
        else if (!Number.isInteger(id)) errors.push({ message: `Members row ${rowNo}: Member ID must be an integer.`, element: idEl });

        if (!startRaw) errors.push({ message: `Members row ${rowNo}: Start is required.`, element: startEl });
        else if (!Number.isFinite(start)) errors.push({ message: `Members row ${rowNo}: Start must be a number.`, element: startEl });

        if (!endRaw) errors.push({ message: `Members row ${rowNo}: End is required.`, element: endEl });
        else if (!Number.isFinite(end)) errors.push({ message: `Members row ${rowNo}: End must be a number.`, element: endEl });

        if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
            errors.push({ message: `Members row ${rowNo}: End must be greater than Start.`, element: endEl });
        }

        updateMemberWidthCell(row);

        return {
            row,
            index: rowNo,
            valid: errors.length === 0,
            errors,
            member: {
                id,
                start,
                end,
                group,
                label,
            },
        };
    });
}

function collectLoadRowsDetailed() {
    const rows = Array.from(document.querySelectorAll('#load-tbody tr'));
    return rows.map((row, idx) => {
        const errors = [];
        const rowNo = idx + 1;
        const idEl = row.querySelector('.l-id');
        const caseEl = row.querySelector('.l-case');
        const typeEl = row.querySelector('.l-type');
        const startEl = row.querySelector('.l-start');
        const endEl = row.querySelector('.l-end');
        const intensityEl = row.querySelector('.l-intensity');
        const intensityEndEl = row.querySelector('.l-intensity-end');
        const dirEl = row.querySelector('.l-dir');
        const notesEl = row.querySelector('.l-notes');

        const idRaw = String(idEl?.value || '').trim();
        const caseRaw = String(caseEl?.value || '').trim();
        const startRaw = String(startEl?.value || '').trim();
        const endRaw = String(endEl?.value || '').trim();
        const intensityRaw = String(intensityEl?.value || '').trim();
        const intensityEndRaw = String(intensityEndEl?.value || '').trim();

        const start = Number.parseFloat(startRaw);
        const end = Number.parseFloat(endRaw);
        const intensity = Number.parseFloat(intensityRaw);
        const intensityEnd = intensityEndRaw === '' ? null : Number.parseFloat(intensityEndRaw);

        if (!idRaw) errors.push({ message: `Loads row ${rowNo}: Load ID is required.`, element: idEl });
        if (!caseRaw) errors.push({ message: `Loads row ${rowNo}: Case is required.`, element: caseEl });

        if (!startRaw) errors.push({ message: `Loads row ${rowNo}: Start is required.`, element: startEl });
        else if (!Number.isFinite(start)) errors.push({ message: `Loads row ${rowNo}: Start must be a number.`, element: startEl });

        if (!endRaw) errors.push({ message: `Loads row ${rowNo}: End is required.`, element: endEl });
        else if (!Number.isFinite(end)) errors.push({ message: `Loads row ${rowNo}: End must be a number.`, element: endEl });

        if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
            errors.push({ message: `Loads row ${rowNo}: End must be greater than Start.`, element: endEl });
        }

        if (!intensityRaw) errors.push({ message: `Loads row ${rowNo}: Intensity is required.`, element: intensityEl });
        else if (!Number.isFinite(intensity)) errors.push({ message: `Loads row ${rowNo}: Intensity must be a number.`, element: intensityEl });

        if (intensityEndRaw !== '' && !Number.isFinite(intensityEnd)) {
            errors.push({ message: `Loads row ${rowNo}: Int. End must be a number when provided.`, element: intensityEndEl });
        }

        return {
            row,
            index: rowNo,
            valid: errors.length === 0,
            errors,
            load: {
                id: idRaw || `L${rowNo}`,
                load_case: caseRaw || 'LC1',
                load_type: String(typeEl?.value || 'PARTIAL_UDL'),
                start,
                end,
                intensity,
                intensity_end: intensityEnd,
                direction: String(dirEl?.value || 'GY'),
                notes: String(notesEl?.value || ''),
            },
        };
    });
}

function collectMembersForProjectFile() {
    return Array.from(document.querySelectorAll('#member-tbody tr')).map(row => ({
        id: row.querySelector('.m-id')?.value ?? '',
        start: row.querySelector('.m-start')?.value ?? '',
        end: row.querySelector('.m-end')?.value ?? '',
        group: row.querySelector('.m-group')?.value ?? 'GENERAL',
        label: row.querySelector('.m-label')?.value ?? '',
    }));
}

function collectLoadsForProjectFile() {
    return Array.from(document.querySelectorAll('#load-tbody tr')).map(row => ({
        id: row.querySelector('.l-id')?.value ?? '',
        load_case: row.querySelector('.l-case')?.value ?? '',
        load_type: row.querySelector('.l-type')?.value ?? 'PARTIAL_UDL',
        start: row.querySelector('.l-start')?.value ?? '',
        end: row.querySelector('.l-end')?.value ?? '',
        intensity: row.querySelector('.l-intensity')?.value ?? '',
        intensity_end: row.querySelector('.l-intensity-end')?.value ?? '',
        direction: row.querySelector('.l-dir')?.value ?? 'GY',
        notes: row.querySelector('.l-notes')?.value ?? '',
    }));
}

function clearInputHighlights() {
    document.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function clearAppMessages() {
    const container = document.getElementById('app-messages');
    if (!container) return;
    container.innerHTML = '';
    container.style.display = 'none';
}

function notifyUser(message, level = 'error', options = {}) {
    const targetId = options.targetId || 'app-messages';
    const container = document.getElementById(targetId);
    if (!container) return;

    const icons = { error: '❌', warning: '⚠️', info: 'ℹ️', success: '✅' };
    const icon = icons[level] || icons.error;
    const lines = String(message || '').split('\n').filter(v => v.trim() !== '');
    const title = lines[0] || 'Message';
    const details = lines.slice(1);
    const hint = options.hint ? String(options.hint) : '';

    const detailsHtml = details.length
        ? `<div class="validation-detail">${details.map(line => escapeHtml(line)).join('<br>')}</div>`
        : '';
    const hintHtml = hint
        ? `<div class="validation-detail"><strong>Action:</strong> ${escapeHtml(hint)}</div>`
        : '';

    const html = `
        <div class="validation-msg ${level}">
            <span>${icon}</span>
            <div>
                <div>${escapeHtml(title)}</div>
                ${detailsHtml}
                ${hintHtml}
            </div>
        </div>
    `;

    if (options.append) {
        container.insertAdjacentHTML('beforeend', html);
    } else {
        container.innerHTML = html;
    }
    container.style.display = 'block';

    const autoHideMs = options.sticky ? 0 : Number(options.autoHideMs ?? 9000);
    if (targetId === 'app-messages' && autoHideMs > 0) {
        if (appMessageTimer) clearTimeout(appMessageTimer);
        appMessageTimer = setTimeout(() => clearAppMessages(), autoHideMs);
    }
}

function renderValidationMessages(items) {
    const valContainer = document.getElementById('validation-messages');
    if (!valContainer) return;

    if (!Array.isArray(items) || !items.length) {
        valContainer.innerHTML = '';
        valContainer.style.display = 'none';
        return;
    }

    valContainer.innerHTML = items.map(m => {
        const level = m.level || 'warning';
        const icon = level === 'error' ? '❌' : '⚠️';
        return `<div class="validation-msg ${level}"><span>${icon}</span> ${m.message}</div>`;
    }).join('');
    valContainer.style.display = 'block';
}

function evaluateDataFlow(highlight = true) {
    const settings = collectSettings();
    const memberRows = collectMemberRowsDetailed();
    const loadRows = collectLoadRowsDetailed();
    const members = memberRows.filter(r => r.valid).map(r => r.member);
    const loads = loadRows.filter(r => r.valid).map(r => r.load);

    const errors = [];
    const warnings = [];

    if (highlight) clearInputHighlights();

    const addError = (message, element = null) => {
        errors.push({ level: 'error', message });
        if (highlight && element) element.classList.add('input-error');
    };

    const addWarning = (message) => {
        warnings.push({ level: 'warning', message });
    };

    if (!(settings.total_width > 0)) {
        addError('Project Settings: Total Width must be greater than 0.', document.getElementById('total-width'));
    }
    if (!Number.isFinite(settings.culvert_height)) {
        addError('Project Settings: Culvert Height must be a number.', document.getElementById('culvert-height'));
    }
    if (!Number.isFinite(settings.fill_depth)) {
        addError('Project Settings: Fill Depth must be a number.', document.getElementById('fill-depth'));
    }
    if (!Number.isFinite(settings.slab_thickness)) {
        addError('Project Settings: Top Slab Thickness must be a number.', document.getElementById('slab-thickness'));
    }
    if (!Number.isFinite(settings.bottom_slab_thickness)) {
        addError('Project Settings: Bottom Slab Thickness must be a number.', document.getElementById('bottom-slab-thickness'));
    }
    if (!Number.isFinite(settings.wall_thickness)) {
        addError('Project Settings: Wall Thickness must be a number.', document.getElementById('wall-thickness'));
    }
    if (!Number.isInteger(settings.decimal_precision) || settings.decimal_precision < 0 || settings.decimal_precision > 6) {
        addError('Project Settings: Decimal Precision must be an integer between 0 and 6.', document.getElementById('decimal-precision'));
    }
    if (settings.reference_axis === 'CUSTOM' && !Number.isFinite(settings.custom_datum)) {
        addError('Project Settings: Custom Datum must be a number when reference axis is CUSTOM.', document.getElementById('custom-datum'));
    }

    memberRows.forEach(r => r.errors.forEach(e => addError(e.message, e.element)));
    loadRows.forEach(r => r.errors.forEach(e => addError(e.message, e.element)));

    if (memberRows.length === 0) addError('Members tab: add at least one member row.');
    if (loadRows.length === 0) addError('Loads tab: add at least one load row.');

    for (const lo of loads) {
        if (lo.start < 0 || lo.end > settings.total_width) {
            addWarning(`Load ${lo.id} extends beyond total width (${settings.total_width}m). Check overhang policy.`);
        }
    }

    const sweepErrors = validateLongitudinalSweepInputs(settings, members, loads);
    return {
        settings,
        memberRows,
        loadRows,
        members,
        loads,
        errors,
        warnings,
        sweepErrors,
        overlapReady: errors.length === 0,
        sweepReady: errors.length === 0 && sweepErrors.length === 0,
    };
}

function updateRunReadinessPanel() {
    const flow = evaluateDataFlow(true);

    const overlapEl = document.getElementById('flow-ready-overlap');
    const sweepEl = document.getElementById('flow-ready-sweep');
    const membersEl = document.getElementById('flow-members-valid');
    const loadsEl = document.getElementById('flow-loads-valid');
    const blockersEl = document.getElementById('flow-blockers');

    if (overlapEl) {
        overlapEl.textContent = flow.overlapReady ? 'Ready' : 'Blocked';
        overlapEl.className = `flow-status ${flow.overlapReady ? 'ok' : 'bad'}`;
    }
    if (sweepEl) {
        sweepEl.textContent = flow.sweepReady ? 'Ready' : 'Blocked';
        sweepEl.className = `flow-status ${flow.sweepReady ? 'ok' : 'bad'}`;
    }
    if (membersEl) membersEl.textContent = `${flow.members.length}/${flow.memberRows.length}`;
    if (loadsEl) loadsEl.textContent = `${flow.loads.length}/${flow.loadRows.length}`;

    if (blockersEl) {
        const items = [
            ...flow.errors.map(e => `• ${e.message}`),
            ...flow.sweepErrors.map(e => `• ${e}`),
        ];
        const uniqueItems = Array.from(new Set(items));
        if (uniqueItems.length) {
            blockersEl.innerHTML = `<div class="flow-blockers">${uniqueItems.join('<br>')}</div>`;
        } else {
            blockersEl.innerHTML = '<div class="flow-ok">All required fields are valid. Ready to run.</div>';
        }
    }

    return flow;
}

function setResultsStale(stale) {
    resultsDirty = stale;
    const banner = document.getElementById('results-stale-banner');
    if (!banner) return;
    banner.style.display = stale ? 'block' : 'none';
}

function scheduleLiveCalculation() {
    const autoRun = document.getElementById('auto-run-toggle');
    if (!autoRun || !autoRun.checked || isAutoCalculating) return;
    if (liveCalcTimer) clearTimeout(liveCalcTimer);
    liveCalcTimer = setTimeout(() => runCalculation({ auto: true }), 500);
}

function scheduleLiveSweep() {
    const mlResult = document.getElementById('ml-result');
    if (!mlResult || mlResult.style.display === 'none') return;
    if (isAutoSweeping) return;
    const btn = document.getElementById('ml-run-btn');
    if (btn && btn.disabled) return;

    const flow = evaluateDataFlow(false);
    if (!flow.sweepReady) return;

    if (liveSweepTimer) clearTimeout(liveSweepTimer);
    liveSweepTimer = setTimeout(() => runLongitudinalSweep({ auto: true }), 550);
}

function onDataChanged(source) {
    if (source === 'members' || source === 'settings') {
        updateAllMemberWidths();
        if (typeof updateVisualization === 'function') updateVisualization();
    }

    if (typeof updateResultsVisualization === 'function') updateResultsVisualization();
    updateRunReadinessPanel();

    if (currentOverlaps.length) {
        setResultsStale(true);
    }

    scheduleLiveCalculation();
    scheduleLiveSweep();
}

function renderIndustryOutputSummary(summary, overlaps) {
    const card = document.getElementById('industry-output-card');
    const caseBody = document.getElementById('industry-case-tbody');
    const loadBody = document.getElementById('industry-load-tbody');
    if (!card || !caseBody || !loadBody) return;

    if (!summary || !Array.isArray(overlaps) || !overlaps.length) {
        card.style.display = 'none';
        return;
    }

    const caseStats = {};
    const loadStats = {};

    overlaps.forEach(r => {
        if (!(r.loaded_length > 0)) return;

        if (!caseStats[r.load_case]) {
            caseStats[r.load_case] = {
                loaded: 0,
                members: new Set(),
                rows: 0,
                maxAbsIntensity: 0,
            };
        }
        caseStats[r.load_case].loaded += Number(r.loaded_length) || 0;
        caseStats[r.load_case].members.add(r.member_id);
        caseStats[r.load_case].rows += 1;
        caseStats[r.load_case].maxAbsIntensity = Math.max(
            caseStats[r.load_case].maxAbsIntensity,
            Math.abs(Number(r.intensity) || 0),
            Math.abs(Number(r.intensity_end) || 0),
        );

        if (!loadStats[r.load_id]) {
            loadStats[r.load_id] = {
                caseId: r.load_case,
                loaded: 0,
                members: new Set(),
                rows: 0,
                maxAbsIntensity: 0,
            };
        }
        loadStats[r.load_id].loaded += Number(r.loaded_length) || 0;
        loadStats[r.load_id].members.add(r.member_id);
        loadStats[r.load_id].rows += 1;
        loadStats[r.load_id].maxAbsIntensity = Math.max(
            loadStats[r.load_id].maxAbsIntensity,
            Math.abs(Number(r.intensity) || 0),
            Math.abs(Number(r.intensity_end) || 0),
        );
    });

    const caseRows = Object.entries(caseStats).sort((a, b) => a[0].localeCompare(b[0]));
    const loadRows = Object.entries(loadStats).sort((a, b) => a[0].localeCompare(b[0]));

    caseBody.innerHTML = caseRows.map(([caseId, s]) => `
        <tr>
            <td>${caseId}</td>
            <td>${s.loaded.toFixed(3)}</td>
            <td>${s.members.size}</td>
            <td>${s.rows}</td>
            <td>${s.maxAbsIntensity.toFixed(3)}</td>
        </tr>
    `).join('');

    loadBody.innerHTML = loadRows.map(([loadId, s]) => `
        <tr>
            <td>${loadId}</td>
            <td>${s.caseId}</td>
            <td>${s.loaded.toFixed(3)}</td>
            <td>${s.members.size}</td>
            <td>${s.maxAbsIntensity.toFixed(3)}</td>
        </tr>
    `).join('');

    card.style.display = 'block';
}

// ─── API Calls ──────────────────────────────────────────────────────────────

async function runCalculation(options = {}) {
    const auto = !!options.auto;
    const btn = document.getElementById('calc-btn');
    const originalBtn = btn.innerHTML;
    if (!auto) {
        btn.innerHTML = '<svg class="icon"><use href="#i-play"/></svg> Calculating...';
        btn.disabled = true;
    } else {
        isAutoCalculating = true;
    }

    try {
        const flow = updateRunReadinessPanel();
        if (!flow.overlapReady) {
            const localMessages = [...flow.errors, ...flow.warnings];
            renderValidationMessages(localMessages);
            return;
        }

        const body = { settings: flow.settings, members: flow.members, loads: flow.loads };
        const resp = await fetch('/api/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json();

        const serverMessages = [];
        if (Array.isArray(data.validation)) {
            serverMessages.push(...data.validation.map(m => ({
                level: m.level || 'warning',
                message: m.message || 'Validation message',
            })));
        }
        if (Array.isArray(data.details)) {
            serverMessages.push(...data.details.map(msg => ({ level: 'error', message: msg })));
        }

        if (!resp.ok || !data.success) {
            if (serverMessages.length) {
                renderValidationMessages(serverMessages);
            } else if (!auto) {
                notifyUser('Calculation error: ' + (data.error || 'Unknown error'), 'error', {
                    targetId: 'validation-messages',
                    sticky: true,
                    hint: 'Fix listed blockers, then run Calculate Overlaps again.',
                });
            }
            return;
        }

        renderValidationMessages(serverMessages.length ? serverMessages : flow.warnings);

        currentOverlaps = data.overlaps;
        currentSummary = data.summary;
        currentSTAAD = data.staad_text;
        setResultsStale(false);

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

        renderIndustryOutputSummary(data.summary, data.overlaps);
        updateResultsVisualization();
        setTimeout(() => renderResultsFrameViz(), 100);
    } catch (e) {
        if (!auto) {
            notifyUser('Calculation error: ' + e.message, 'error', {
                targetId: 'validation-messages',
                sticky: true,
                hint: 'Review Project Settings, Members, and Loads for missing/invalid values.',
            });
        }
    } finally {
        if (!auto) {
            btn.innerHTML = originalBtn;
            btn.disabled = false;
        }
        isAutoCalculating = false;
    }
}

async function runLongitudinalSweep(options = {}) {
    const auto = !!options.auto;
    const btn = document.getElementById('ml-run-btn');
    const originalBtn = btn.innerHTML;
    if (!auto) {
        btn.disabled = true;
        btn.innerHTML = '<svg class="icon"><use href="#i-play"/></svg> Running...';
    } else {
        isAutoSweeping = true;
    }

    try {
        const flow = updateRunReadinessPanel();
        if (!flow.overlapReady) {
            renderValidationMessages(flow.errors);
            throw new Error('Fix overlap input errors before running sweep.');
        }

        const settings = flow.settings;
        const members = flow.members;
        const loads = flow.loads;
        const sweepErrors = validateLongitudinalSweepInputs(settings, members, loads);
        if (sweepErrors.length) {
            renderValidationMessages(sweepErrors.map(message => ({ level: 'error', message })));
            throw new Error('Missing/invalid inputs:\n- ' + sweepErrors.join('\n- '));
        }

        const movingLoadText = document.getElementById('ml-std-input')?.value || '';
        const body = {
            settings,
            members,
            loads,
            increment: parseFloat(document.getElementById('ml-increment').value) || 0.1,
            moving_load_text: movingLoadText.trim() ? movingLoadText : '',
        };

        const resp = await fetch('/api/smart/longitudinal-critical', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!data.success) {
            const detailText = Array.isArray(data.details) && data.details.length
                ? '\n- ' + data.details.join('\n- ')
                : '';
            throw new Error((data.error || 'Sweep failed') + detailText);
        }

        const model = data.result.model;
        const inference = data.result.inference || {};
        const vehiclesDetected = (inference.vehicles_from_loads || []).join(', ') || '—';
        const matchedLoads = (inference.matched_load_ids || []).join(', ') || '—';
        const movingInfo = inference.moving_load || { used: false };
        let infoHtml =
            `<strong>Model:</strong> span=${model.clear_span}m, cells=${model.num_cells}, total length=${model.total_length}m, increment=${model.sweep_increment}m`;

        if (movingInfo.used) {
            const typeIds = Array.isArray(movingInfo.type_ids) && movingInfo.type_ids.length
                ? movingInfo.type_ids.join(', ')
                : '—';
            infoHtml += `<br><strong>STAAD Moving Load Types:</strong> ${typeIds}`;
            if (Array.isArray(movingInfo.warnings) && movingInfo.warnings.length) {
                infoHtml += `<br><strong>STAAD Warnings:</strong> ${movingInfo.warnings.join('; ')}`;
            }
        } else {
            infoHtml += `<br><strong>Detected vehicles from Loads:</strong> ${vehiclesDetected}` +
                `<br><strong>Matched Load IDs:</strong> ${matchedLoads}`;
        }
        document.getElementById('ml-model-info').innerHTML = infoHtml;

        const groupLabel = {
            TOP_SLAB: 'Top Slab',
            BOTTOM_SLAB: 'Bottom Slab',
            SIDE_WALL: 'Side Walls',
            INTERMEDIATE_WALL: 'Intermediate Walls',
        };

        const cardsHtmlWithActions = data.result.vehicles.map(v => {
            const rows = v.group_results.map(g => `
                <tr>
                    <td>${groupLabel[g.group] || g.group}</td>
                    <td>${g.max_sagging_moment.value.toFixed(3)}</td>
                    <td>${g.max_sagging_moment.lead_position.toFixed(3)}</td>
                    <td>${g.max_sagging_moment.member_id}</td>
                    <td>${g.max_hogging_moment.value.toFixed(3)}</td>
                    <td>${g.max_hogging_moment.lead_position.toFixed(3)}</td>
                    <td>${g.max_hogging_moment.member_id}</td>
                    <td>${g.max_shear_force.value.toFixed(3)}</td>
                    <td>${g.max_shear_force.lead_position.toFixed(3)}</td>
                    <td>${g.max_shear_force.member_id}</td>
                    <td>
                        <button class="btn btn-xs btn-ghost" onclick="selectSweepViz('${v.vehicle_code}', '${g.group}', 'max_sagging_moment')">Sag</button>
                        <button class="btn btn-xs btn-ghost" onclick="selectSweepViz('${v.vehicle_code}', '${g.group}', 'max_hogging_moment')">Hog</button>
                        <button class="btn btn-xs btn-ghost" onclick="selectSweepViz('${v.vehicle_code}', '${g.group}', 'max_shear_force')">She</button>
                    </td>
                </tr>
            `).join('');

            return `
                <div class="card" style="margin-top:12px">
                    <h3 style="margin-bottom:8px">${v.vehicle_name}</h3>
                    <p class="helper-text" style="margin-bottom:8px">
                        ${v.notes} Train length: ${v.train_length.toFixed(3)}m, sweep positions: ${v.num_positions}.
                    </p>
                    <div class="table-container">
                        <table>
                            <thead>
                                <tr>
                                    <th>Member Group</th>
                                    <th>Max Sagging M</th>
                                    <th>Lead Position (m)</th>
                                    <th>Member ID</th>
                                    <th>Max Hogging M</th>
                                    <th>Lead Position (m)</th>
                                    <th>Member ID</th>
                                    <th>Max Shear</th>
                                    <th>Lead Position (m)</th>
                                    <th>Member ID</th>
                                    <th>Diagram</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                </div>
            `;
        }).join('');

        document.getElementById('ml-results-container').innerHTML = cardsHtmlWithActions;
        document.getElementById('ml-result').style.display = 'block';
        currentSweepResult = data.result;
        setupLongitudinalSweepVisualization(data.result);
    } catch (e) {
        if (!auto) {
            notifyUser('Longitudinal sweep error: ' + e.message, 'error', {
                targetId: 'validation-messages',
                sticky: true,
                hint: 'Fix missing sweep fields and rerun with a valid increment.',
            });
        }
    } finally {
        if (!auto) {
            btn.disabled = false;
            btn.innerHTML = originalBtn;
        }
        isAutoSweeping = false;
    }
}

function setupLongitudinalSweepVisualization(result) {
    if (!result || !Array.isArray(result.vehicles) || !result.vehicles.length) return;

    const panel = document.getElementById('ml-viz-panel');
    const vehicleSel = document.getElementById('ml-viz-vehicle');
    const groupSel = document.getElementById('ml-viz-group');
    const effectSel = document.getElementById('ml-viz-effect');
    if (!panel || !vehicleSel || !groupSel || !effectSel) return;

    const prevVehicle = vehicleSel.value;
    vehicleSel.innerHTML = result.vehicles
        .map(v => `<option value="${v.vehicle_code}">${v.vehicle_name}</option>`)
        .join('');
    if (Array.from(vehicleSel.options).some(o => o.value === prevVehicle)) {
        vehicleSel.value = prevVehicle;
    }

    if (!vehicleSel.dataset.bound) {
        vehicleSel.addEventListener('change', () => {
            updateSweepVizGroupOptions();
            renderLongitudinalSweepViz();
        });
        groupSel.addEventListener('change', () => renderLongitudinalSweepViz());
        effectSel.addEventListener('change', () => renderLongitudinalSweepViz());
        vehicleSel.dataset.bound = '1';
    }

    panel.style.display = 'block';
    updateSweepVizGroupOptions();
    renderLongitudinalSweepViz();
}

function updateSweepVizGroupOptions() {
    const vehicleSel = document.getElementById('ml-viz-vehicle');
    const groupSel = document.getElementById('ml-viz-group');
    if (!vehicleSel || !groupSel || !currentSweepResult) return;

    const vehicle = currentSweepResult.vehicles.find(v => v.vehicle_code === vehicleSel.value)
        || currentSweepResult.vehicles[0];
    if (!vehicle) return;

    const prev = groupSel.value;
    const labelMap = {
        TOP_SLAB: 'Top Slab',
        BOTTOM_SLAB: 'Bottom Slab',
        SIDE_WALL: 'Side Walls',
        INTERMEDIATE_WALL: 'Intermediate Walls',
    };
    groupSel.innerHTML = (vehicle.group_results || [])
        .map(g => `<option value="${g.group}">${labelMap[g.group] || g.group}</option>`)
        .join('');

    if (Array.from(groupSel.options).some(o => o.value === prev)) {
        groupSel.value = prev;
    }
}

function selectSweepViz(vehicleCode, group, effectKey) {
    const vehicleSel = document.getElementById('ml-viz-vehicle');
    const groupSel = document.getElementById('ml-viz-group');
    const effectSel = document.getElementById('ml-viz-effect');
    if (!vehicleSel || !groupSel || !effectSel) return;

    vehicleSel.value = vehicleCode;
    updateSweepVizGroupOptions();
    groupSel.value = group;
    effectSel.value = effectKey;
    renderLongitudinalSweepViz();

    const canvas = document.getElementById('ml-viz-canvas');
    if (canvas) canvas.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function getSweepEffectLabel(effectKey) {
    const labels = {
        max_sagging_moment: 'Max Sagging Moment',
        max_hogging_moment: 'Max Hogging Moment',
        max_shear_force: 'Max Shear Force',
    };
    return labels[effectKey] || effectKey;
}

function resolveSweepMemberSegment(memberId, model) {
    const cells = Math.max(1, Number(model.num_cells) || 1);
    const span = Number(model.clear_span) || 1;
    const height = Number(model.clear_height) || 3;
    const id = Number(memberId);
    if (!Number.isInteger(id) || id <= 0) return null;

    if (id <= cells) {
        const i = id - 1;
        return { x1: i * span, x2: (i + 1) * span, y1: height, y2: height, orientation: 'H' };
    }
    if (id <= 2 * cells) {
        const i = id - cells - 1;
        return { x1: i * span, x2: (i + 1) * span, y1: 0, y2: 0, orientation: 'H' };
    }

    const wallStart = 2 * cells + 1;
    const wallEnd = wallStart + cells;
    if (id >= wallStart && id <= wallEnd) {
        const i = id - wallStart;
        const x = i * span;
        return { x1: x, x2: x, y1: 0, y2: height, orientation: 'V' };
    }
    return null;
}

function renderLongitudinalSweepViz() {
    const canvas = document.getElementById('ml-viz-canvas');
    const caption = document.getElementById('ml-viz-caption');
    const vehicleSel = document.getElementById('ml-viz-vehicle');
    const groupSel = document.getElementById('ml-viz-group');
    const effectSel = document.getElementById('ml-viz-effect');
    if (!canvas || !caption || !vehicleSel || !groupSel || !effectSel || !currentSweepResult) return;

    const model = currentSweepResult.model || {};
    const totalLength = Math.max(0.1, Number(model.total_length) || 1);
    const cells = Math.max(1, Number(model.num_cells) || 1);
    const clearSpan = Number(model.clear_span) || (totalLength / cells);
    const clearHeight = Number(model.clear_height) || 3;
    const topThk = Number(model.top_slab_thickness) || 0.3;
    const botThk = Number(model.bottom_slab_thickness) || 0.35;
    const wallThk = Number(model.wall_thickness) || 0.3;

    const vehicle = currentSweepResult.vehicles.find(v => v.vehicle_code === vehicleSel.value)
        || currentSweepResult.vehicles[0];
    if (!vehicle) return;

    const groupData = (vehicle.group_results || []).find(g => g.group === groupSel.value)
        || (vehicle.group_results || [])[0];
    if (!groupData) return;

    const effectKey = effectSel.value;
    const critical = groupData[effectKey];
    if (!critical) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const margin = { left: 60, right: 36, top: 60, bottom: 60 };
    const drawW = Math.max(1, W - margin.left - margin.right);
    const topY = margin.top + 56;
    const bottomY = H - margin.bottom - 36;

    const tx = (x) => margin.left + (x / totalLength) * drawW;
    const ty = (y) => bottomY - (y / clearHeight) * (bottomY - topY);

    // ── Background with gradient ──
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#111827');
    grad.addColorStop(1, '#0b1220');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // ── Grid ──
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 0.5;
    const tickStep = totalLength <= 8 ? 0.5 : totalLength <= 20 ? 1.0 : 2.0;
    for (let x = 0; x <= totalLength + 1e-9; x += tickStep) {
        const px = tx(x);
        ctx.beginPath();
        ctx.moveTo(px, margin.top + 18);
        ctx.lineTo(px, H - margin.bottom + 10);
        ctx.stroke();
    }

    // ── Draw frame with slab thickness bands ──
    // Top slab band
    ctx.fillStyle = 'rgba(34,197,94,0.08)';
    ctx.fillRect(tx(0), ty(clearHeight), (tx(totalLength) - tx(0)), -(topThk / clearHeight) * (bottomY - topY));
    // Bottom slab band
    ctx.fillStyle = 'rgba(34,197,94,0.08)';
    const botBandH = (botThk / clearHeight) * (bottomY - topY);
    ctx.fillRect(tx(0), ty(0), (tx(totalLength) - tx(0)), botBandH);

    // Top slab line
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(tx(0), ty(clearHeight));
    ctx.lineTo(tx(totalLength), ty(clearHeight));
    ctx.stroke();

    // Bottom slab line
    ctx.beginPath();
    ctx.moveTo(tx(0), ty(0));
    ctx.lineTo(tx(totalLength), ty(0));
    ctx.stroke();

    // ── Vertical walls ──
    for (let i = 0; i <= cells; i++) {
        const x = i * clearSpan;
        const isSide = i === 0 || i === cells;
        ctx.strokeStyle = isSide ? '#22c55e' : '#f97316';
        ctx.lineWidth = isSide ? 2.5 : 2;
        ctx.beginPath();
        ctx.moveTo(tx(x), ty(0));
        ctx.lineTo(tx(x), ty(clearHeight));
        ctx.stroke();
    }

    // ── Support triangles at wall bases ──
    for (let i = 0; i <= cells; i++) {
        const x = i * clearSpan;
        const sx = tx(x);
        const sy = ty(0);
        const sz = 8;

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx - sz, sy + sz * 1.3);
        ctx.lineTo(sx + sz, sy + sz * 1.3);
        ctx.closePath();
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.8;
        ctx.stroke();

        // Ground hatching
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (let h = -sz; h <= sz; h += 4) {
            ctx.moveTo(sx + h, sy + sz * 1.3);
            ctx.lineTo(sx + h - 4, sy + sz * 1.3 + 5);
        }
        ctx.stroke();
    }

    // ── Joint markers at frame corners ──
    const jointPositions = [];
    for (let i = 0; i <= cells; i++) {
        const x = i * clearSpan;
        jointPositions.push({ x, y: 0 });
        jointPositions.push({ x, y: clearHeight });
    }

    jointPositions.forEach((j, idx) => {
        ctx.beginPath();
        ctx.arc(tx(j.x), ty(j.y), 4, 0, Math.PI * 2);
        ctx.fillStyle = '#0d1117';
        ctx.fill();
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 2;
        ctx.stroke();
    });

    // ── Cell labels ──
    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i < cells; i++) {
        const x1 = i * clearSpan;
        const x2 = (i + 1) * clearSpan;
        const cx = (x1 + x2) / 2;
        const cy = clearHeight / 2;

        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        const rectW = (tx(x2) - tx(x1)) * 0.6;
        const rectH = 22;
        ctx.fillRect(tx(cx) - rectW / 2, ty(cy) - rectH / 2, rectW, rectH);

        ctx.fillStyle = '#9ca3af';
        ctx.fillText(`Cell ${i + 1}`, tx(cx), ty(cy) + 4);
    }

    // ── Dimension line: clear span ──
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth = 1;
    const dimLineY = ty(0) + 40;
    for (let i = 0; i < cells; i++) {
        const x1 = tx(i * clearSpan);
        const x2 = tx((i + 1) * clearSpan);

        ctx.beginPath();
        ctx.moveTo(x1, dimLineY);
        ctx.lineTo(x2, dimLineY);
        ctx.stroke();

        // End ticks
        ctx.setLineDash([]);
        [x1, x2].forEach(px => {
            ctx.beginPath();
            ctx.moveTo(px, dimLineY - 4);
            ctx.lineTo(px, dimLineY + 4);
            ctx.stroke();
        });

        // Label
        ctx.font = '600 10px Inter, sans-serif';
        ctx.fillStyle = '#9ca3af';
        ctx.textAlign = 'center';
        ctx.fillText(`${clearSpan.toFixed(2)}m`, (x1 + x2) / 2, dimLineY + 14);
        ctx.setLineDash([4, 3]);
    }
    ctx.setLineDash([]);

    // ── Dimension line: clear height (right side) ──
    const dimVX = tx(totalLength) + 20;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dimVX, ty(0));
    ctx.lineTo(dimVX, ty(clearHeight));
    ctx.stroke();

    ctx.setLineDash([]);
    [ty(0), ty(clearHeight)].forEach(py => {
        ctx.beginPath();
        ctx.moveTo(dimVX - 4, py);
        ctx.lineTo(dimVX + 4, py);
        ctx.stroke();
    });

    ctx.save();
    ctx.translate(dimVX + 14, (ty(0) + ty(clearHeight)) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = '600 10px Inter, sans-serif';
    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'center';
    ctx.fillText(`${clearHeight.toFixed(2)}m`, 0, 0);
    ctx.restore();

    // ── Highlight selected member group ──
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 4;
    if (groupData.group === 'TOP_SLAB') {
        ctx.beginPath();
        ctx.moveTo(tx(0), ty(clearHeight));
        ctx.lineTo(tx(totalLength), ty(clearHeight));
        ctx.stroke();
    } else if (groupData.group === 'BOTTOM_SLAB') {
        ctx.beginPath();
        ctx.moveTo(tx(0), ty(0));
        ctx.lineTo(tx(totalLength), ty(0));
        ctx.stroke();
    } else if (groupData.group === 'SIDE_WALL') {
        [0, totalLength].forEach(x => {
            ctx.beginPath();
            ctx.moveTo(tx(x), ty(0));
            ctx.lineTo(tx(x), ty(clearHeight));
            ctx.stroke();
        });
    } else if (groupData.group === 'INTERMEDIATE_WALL') {
        for (let i = 1; i < cells; i++) {
            const x = i * clearSpan;
            ctx.beginPath();
            ctx.moveTo(tx(x), ty(0));
            ctx.lineTo(tx(x), ty(clearHeight));
            ctx.stroke();
        }
    }

    // ── Highlight critical member ──
    const segment = resolveSweepMemberSegment(critical.member_id, model);
    if (segment) {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(tx(segment.x1), ty(segment.y1));
        ctx.lineTo(tx(segment.x2), ty(segment.y2));
        ctx.stroke();

        // Critical member label
        ctx.font = 'bold 10px JetBrains Mono, monospace';
        ctx.fillStyle = '#facc15';
        ctx.textAlign = 'center';
        const mx = (tx(segment.x1) + tx(segment.x2)) / 2;
        const my = (ty(segment.y1) + ty(segment.y2)) / 2;
        ctx.fillText(`M${critical.member_id}`, mx, my - 10);
    }

    // ── Bending Moment Diagram (BMD) ──
    if (critical.bmd && critical.bmd.length > 0) {
        let maxM = 0;
        critical.bmd.forEach(member => {
            member.points.forEach(pt => {
                if (Math.abs(pt.M_max) > maxM) maxM = Math.abs(pt.M_max);
                if (Math.abs(pt.M_min) > maxM) maxM = Math.abs(pt.M_min);
            });
        });

        if (maxM > 0) {
            const scaleM = 45 / maxM;

            critical.bmd.forEach(member => {
                const pts = member.points;
                if (pts.length < 2) return;

                const isLeftWall = member.group === 'SIDE_WALL' && pts[0].X < (totalLength / 2);
                const isRightWall = member.group === 'SIDE_WALL' && pts[0].X > (totalLength / 2);
                const isBottomSlab = member.group === 'BOTTOM_SLAB';
                const isTopSlab = member.group === 'TOP_SLAB';
                const isMidWall = member.group === 'INTERMEDIATE_WALL';

                // Filled BMD ENVELOPE polygon (Max to Min)
                ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
                ctx.strokeStyle = '#38bdf8';
                ctx.lineWidth = 1.5;

                ctx.beginPath();
                
                let peakMaxPt = pts[0];
                let peakMaxVal = 0;
                let peakMinPt = pts[0];
                let peakMinVal = 0;

                // Draw MAX Envelope (forward)
                pts.forEach((pt, i) => {
                    let dX = 0, dY = 0;
                    if (isTopSlab) {
                        dY = pt.M_max * scaleM;
                    } else if (isBottomSlab) {
                        dY = -pt.M_max * scaleM; 
                    } else if (isLeftWall) {
                        dX = pt.M_max * scaleM; 
                    } else if (isRightWall) {
                        dX = -pt.M_max * scaleM; 
                    } else if (isMidWall) {
                        dX = pt.M_max * scaleM; 
                    } else {
                        dY = pt.M_max * scaleM;
                    }

                    if (i === 0) {
                        ctx.moveTo(tx(pt.X) + dX, ty(pt.Y) + dY);
                    } else {
                        ctx.lineTo(tx(pt.X) + dX, ty(pt.Y) + dY);
                    }

                    if (Math.abs(pt.M_max) > Math.abs(peakMaxVal)) {
                        peakMaxVal = pt.M_max;
                        peakMaxPt = pt;
                    }
                });

                // Draw MIN Envelope (backward to close polygon)
                for (let i = pts.length - 1; i >= 0; i--) {
                    const pt = pts[i];
                    let dX = 0, dY = 0;
                    if (isTopSlab) {
                        dY = pt.M_min * scaleM;
                    } else if (isBottomSlab) {
                        dY = -pt.M_min * scaleM; 
                    } else if (isLeftWall) {
                        dX = pt.M_min * scaleM; 
                    } else if (isRightWall) {
                        dX = -pt.M_min * scaleM; 
                    } else if (isMidWall) {
                        dX = pt.M_min * scaleM; 
                    } else {
                        dY = pt.M_min * scaleM;
                    }
                    ctx.lineTo(tx(pt.X) + dX, ty(pt.Y) + dY);

                    if (Math.abs(pt.M_min) > Math.abs(peakMinVal)) {
                        peakMinVal = pt.M_min;
                        peakMinPt = pt;
                    }
                }
                
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

                // ── Peak value labels on BMD Envelope ──
                const drawPeakLabel = (peakPt, peakVal, isMax) => {
                    if (Math.abs(peakVal) > 0.01) {
                        let labelX, labelY;
                        let dX = 0, dY = 0;

                        if (isTopSlab) dY = peakVal * scaleM;
                        else if (isBottomSlab) dY = -peakVal * scaleM;
                        else if (isLeftWall) dX = peakVal * scaleM;
                        else if (isRightWall) dX = -peakVal * scaleM;
                        else if (isMidWall) dX = peakVal * scaleM;
                        else dY = peakVal * scaleM;

                        labelX = tx(peakPt.X) + dX;
                        labelY = ty(peakPt.Y) + dY;

                        const label = `${peakVal.toFixed(2)} kN·m`;
                        ctx.font = 'bold 9px JetBrains Mono, monospace';
                        const tw = ctx.measureText(label).width + 8;
                        
                        // Alternate colors for M_max vs M_min for clarity
                        ctx.fillStyle = isMax ? 'rgba(15, 23, 42, 0.85)' : 'rgba(15, 23, 42, 0.7)';
                        ctx.fillRect(labelX - tw / 2, labelY - 7, tw, 14);
                        ctx.strokeStyle = isMax ? '#38bdf8' : '#e2e8f0';
                        ctx.lineWidth = 0.8;
                        ctx.strokeRect(labelX - tw / 2, labelY - 7, tw, 14);

                        ctx.fillStyle = isMax ? '#7dd3fc' : '#e2e8f0';
                        ctx.textAlign = 'center';
                        ctx.fillText(label, labelX, labelY + 3);
                    }
                };
                
                drawPeakLabel(peakMaxPt, peakMaxVal, true);
                // Only draw min if it's significantly different to avoid label overlap in static places
                if (Math.abs(peakMaxVal - peakMinVal) > 5.0) {
                    drawPeakLabel(peakMinPt, peakMinVal, false);
                }
            });
        }
    }

    // ── Axle loads at critical lead position ──
    const lead = Number(critical.lead_position) || 0;
    const axleOffsets = Array.isArray(vehicle.axle_offsets_m) ? vehicle.axle_offsets_m : [];
    const axleLoads = Array.isArray(vehicle.axle_loads_kN) ? vehicle.axle_loads_kN : [];
    ctx.strokeStyle = '#f87171';
    ctx.fillStyle = '#f87171';
    ctx.lineWidth = 1.6;

    axleOffsets.forEach((off, idx) => {
        const xPos = lead + Number(off || 0);
        if (xPos < 0 || xPos > totalLength) return;
        const px = tx(xPos);
        const y1 = ty(clearHeight) - 42;
        const y2 = ty(clearHeight) - 6;

        ctx.beginPath();
        ctx.moveTo(px, y1);
        ctx.lineTo(px, y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(px, y2);
        ctx.lineTo(px - 4, y2 - 6);
        ctx.lineTo(px + 4, y2 - 6);
        ctx.closePath();
        ctx.fill();

        // Axle load label
        ctx.font = '600 9px JetBrains Mono, monospace';
        ctx.fillStyle = '#fca5a5';
        ctx.textAlign = 'center';
        ctx.fillText(`${Number(axleLoads[idx] || 0).toFixed(0)}kN`, px, y1 - 4);
        ctx.fillStyle = '#f87171';
    });

    // ── Lead marker line ──
    if (lead >= 0 && lead <= totalLength) {
        const lx = tx(lead);
        ctx.strokeStyle = 'rgba(250,204,21,0.6)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lx, margin.top + 14);
        ctx.lineTo(lx, H - margin.bottom + 8);
        ctx.stroke();
        ctx.setLineDash([]);

        // Lead position label
        ctx.font = '600 9px JetBrains Mono, monospace';
        ctx.fillStyle = '#facc15';
        ctx.textAlign = 'center';
        ctx.fillText(`Lead: ${lead.toFixed(2)}m`, lx, margin.top + 10);
    }

    // ── Distance axis ──
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx(0), H - margin.bottom + 8);
    ctx.lineTo(tx(totalLength), H - margin.bottom + 8);
    ctx.stroke();

    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = '#9ca3af';
    for (let x = 0; x <= totalLength + 1e-9; x += tickStep) {
        const px = tx(x);
        ctx.beginPath();
        ctx.moveTo(px, H - margin.bottom + 4);
        ctx.lineTo(px, H - margin.bottom + 12);
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.fillText(x.toFixed(1), px, H - margin.bottom + 24);
    }

    // ── Axis label ──
    ctx.font = '400 10px Inter, sans-serif';
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    ctx.fillText('← Longitudinal Distance (m) →', W / 2, H - margin.bottom + 40);

    // ── Title ──
    ctx.font = '700 14px Inter, sans-serif';
    ctx.fillStyle = '#e5e7eb';
    ctx.textAlign = 'left';
    ctx.fillText('STAAD-Style Critical Position Diagram', margin.left, 22);

    ctx.font = '11px Inter, sans-serif';
    ctx.fillStyle = '#a7b0c2';
    ctx.fillText(`Increment: ${model.sweep_increment}m  |  Positions: ${vehicle.num_positions}  |  ${cells}-Cell Box Culvert`, margin.left, 40);

    // ── Legend (top right) ──
    const legend = [
        { color: '#22c55e', label: 'Frame Members' },
        { color: '#f97316', label: 'Int. Walls' },
        { color: '#facc15', label: 'Critical Member' },
        { color: '#38bdf8', label: 'BMD' },
        { color: '#f87171', label: 'Axle Loads' },
    ];
    ctx.font = '500 9px Inter, sans-serif';
    let lgX = W - 30;
    for (let i = legend.length - 1; i >= 0; i--) {
        const item = legend[i];
        const lw = ctx.measureText(item.label).width + 18;
        lgX -= lw;
        ctx.fillStyle = item.color;
        ctx.fillRect(lgX, 14, 10, 8);
        ctx.fillStyle = '#d1d5db';
        ctx.textAlign = 'left';
        ctx.fillText(item.label, lgX + 14, 22);
    }

    // ── Caption ──
    const groupLabel = {
        TOP_SLAB: 'Top Slab',
        BOTTOM_SLAB: 'Bottom Slab',
        SIDE_WALL: 'Side Walls',
        INTERMEDIATE_WALL: 'Intermediate Walls',
    };
    const effectLabel = getSweepEffectLabel(effectKey);
    caption.textContent = `${vehicle.vehicle_name} | ${groupLabel[groupData.group] || groupData.group} | ${effectLabel}: ${Number(critical.value).toFixed(3)} at lead ${Number(critical.lead_position).toFixed(3)} m (member ${critical.member_id})`;
}

function validateLongitudinalSweepInputs(settings, members, loads) {
    const errors = [];
    const movingLoadText = document.getElementById('ml-std-input')?.value || '';
    const hasMovingLoad = movingLoadText.trim().length > 0;

    if (!String(settings.structure_type || '').startsWith('BOX_CULVERT_')) {
        errors.push('Project Settings > Structure Type must be BOX_CULVERT_1/2/3/4CELL.');
    }
    if (!(settings.total_width > 0)) errors.push('Project Settings > Total Width must be > 0.');
    if (!(settings.culvert_height > 0)) errors.push('Project Settings > Culvert Height must be > 0.');
    if (!(settings.slab_thickness > 0)) errors.push('Project Settings > Top Slab Thickness must be > 0.');
    if (!(settings.bottom_slab_thickness > 0)) errors.push('Project Settings > Bottom Slab Thickness must be > 0.');
    if (!(settings.wall_thickness > 0)) errors.push('Project Settings > Wall Thickness must be > 0.');

    if (!members.length) {
        errors.push('Members tab must contain member rows.');
    } else {
        const groups = new Set(members.map(m => String(m.group || 'GENERAL').toUpperCase()));
        const requiredBaseGroups = ['TOP_SLAB', 'BOTTOM_SLAB', 'LEFT_WALL', 'RIGHT_WALL'];
        for (const g of requiredBaseGroups) {
            if (!groups.has(g)) errors.push(`Members tab must include group "${g}".`);
        }

        const cellMap = {
            BOX_CULVERT_1CELL: 1,
            BOX_CULVERT_2CELL: 2,
            BOX_CULVERT_3CELL: 3,
            BOX_CULVERT_4CELL: 4,
        };
        const numCells = cellMap[String(settings.structure_type || '')] || 1;
        if (numCells >= 2) {
            const middleCount = Array.from(groups).filter(g => g.startsWith('MIDDLE_WALL_')).length;
            if (middleCount < numCells - 1) {
                errors.push(`Members tab needs at least ${numCells - 1} MIDDLE_WALL_* groups for ${numCells} cells.`);
            }
        }
    }

    if (!loads.length) {
        errors.push('Loads tab must contain at least one vehicle load row.');
    } else if (!hasMovingLoad) {
        const recognized = loads.some(lo => {
            const type = String(lo.load_type || '').toUpperCase();
            const text = `${lo.id || ''} ${lo.notes || ''}`.toUpperCase();
            if (type === 'IRC_70R' || type === 'IRC_CLASS_A' || type === 'IRC_CLASS_AA') return true;
            if (type === 'SINGLE_AXLE_BOGIE' || type === 'DOUBLE_AXLE_BOGIE') return true;
            if (text.includes('SINGLE') && text.includes('BOGIE')) return true;
            if (text.includes('DOUBLE') && text.includes('BOGIE')) return true;
            if (text.includes('MAX SINGLE AXLE') || text.includes('MAX BOGIE')) return true;
            return false;
        });
        if (!recognized) {
            errors.push('Loads tab needs recognizable vehicle tags (IRC_70R / IRC_CLASS_A / IRC_CLASS_AA / SINGLE_AXLE_BOGIE / DOUBLE_AXLE_BOGIE / single or double bogie keywords).');
        }
    } else if (hasMovingLoad && !/TYPE\\s+\\d+\\s+LOAD/i.test(movingLoadText)) {
        errors.push('STAAD Moving Load text must include at least one TYPE n LOAD definition.');
    }

    const increment = parseFloat(document.getElementById('ml-increment').value);
    if (!(increment > 0)) errors.push('Results > Increment must be > 0.');

    return errors;
}

async function downloadExcel() {
    try {
        const flow = updateRunReadinessPanel();
        if (!flow.overlapReady) throw new Error('Fix input errors before export.');
        const body = { settings: flow.settings, members: flow.members, loads: flow.loads };
        const resp = await fetch('/api/export/excel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error('Export failed');
        const blob = await resp.blob();
        downloadBlob(blob, `${collectSettings().project_name.replace(/ /g, '_')}_Load_Segmentation.xlsx`);
    } catch (e) { notifyUser('Excel export error: ' + e.message); }
}

async function downloadSTAAD() {
    try {
        const flow = updateRunReadinessPanel();
        if (!flow.overlapReady) throw new Error('Fix input errors before export.');
        const body = { settings: flow.settings, members: flow.members, loads: flow.loads };
        const resp = await fetch('/api/export/staad', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error('Export failed');
        const blob = await resp.blob();
        downloadBlob(blob, `${collectSettings().project_name.replace(/ /g, '_')}_STAAD.txt`);
    } catch (e) { notifyUser('STAAD export error: ' + e.message); }
}

async function downloadCSV() {
    try {
        const flow = updateRunReadinessPanel();
        if (!flow.overlapReady) throw new Error('Fix input errors before export.');
        const body = { settings: flow.settings, members: flow.members, loads: flow.loads };
        const resp = await fetch('/api/export/csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error('Export failed');
        const blob = await resp.blob();
        downloadBlob(blob, 'overlap_results.csv');
    } catch (e) { notifyUser('CSV export error: ' + e.message); }
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
            onDataChanged('loads');
        }
    } catch (e) { notifyUser('Template error: ' + e.message); }
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
            onDataChanged('loads');
        }
    } catch (e) { notifyUser('Template error: ' + e.message); }
}

// ─── Project Save / Load ────────────────────────────────────────────────────

async function saveProject() {
    const data = {
        settings: collectSettings(),
        members: collectMembersForProjectFile(),
        loads: collectLoadsForProjectFile(),
    };
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
            setInputValueById('project-name', s.project_name || '');
            setInputValueById('bridge-name', s.bridge_name || '');
            setInputValueById('engineer', s.engineer || '');
            setInputValueById('project-date', s.project_date || '');
            setInputValueById('comments', s.comments || '');
            setInputValueById('total-width', s.total_width ?? 8.5);
            setInputValueById('structure-type', s.structure_type || 'BRIDGE_DECK');
            setInputValueById('geometry-template', s.geometry_template || 'NONE');
            setInputValueById('reference-axis', s.reference_axis || 'LEFT_EDGE');
            setInputValueById('custom-datum', s.custom_datum ?? 0);
            setInputValueById('culvert-height', s.culvert_height ?? 0);
            setInputValueById('clear-span', s.clear_span ?? 0);
            setInputValueById('num-cells', s.num_cells ?? 1);
            setInputValueById('fill-depth', s.fill_depth ?? 0);
            setInputValueById('slab-thickness', s.slab_thickness ?? 0.3);
            setInputValueById('bottom-slab-thickness', s.bottom_slab_thickness ?? 0.35);
            setInputValueById('wall-thickness', s.wall_thickness ?? 0.3);
            setInputValueById('mid-wall-thickness', s.mid_wall_thickness ?? s.wall_thickness ?? 0.3);
            setInputValueById('haunch-size', s.haunch_size ?? 0);
            if (Array.isArray(s.custom_breakpoints) && s.custom_breakpoints.length) {
                setInputValueById('custom-breakpoints', formatBreakpoints(s.custom_breakpoints));
            }
            if (Array.isArray(s.custom_wall_ranges) && s.custom_wall_ranges.length) {
                setInputValueById('custom-wall-ranges', formatWallRanges(s.custom_wall_ranges));
            }
            setInputValueById('decimal-precision', s.decimal_precision ?? 2);
            setInputValueById('units', s.units || 'm');
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
                    lo.intensity, lo.intensity_end ?? '', lo.direction, lo.notes || '');
            }
        }
        const templateSelect = document.getElementById('geometry-template');
        if (templateSelect) {
            renderGeometryTemplateFields(templateSelect.value || 'NONE');
        }
        onDataChanged('settings');
    }
    event.target.value = '';
}

// ─── CSV Import ─────────────────────────────────────────────────────────────

function parseCSVText(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (ch === '"') {
            if (inQuotes && next === '"') {
                cell += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (!inQuotes && ch === ',') {
            row.push(cell);
            cell = '';
            continue;
        }

        if (!inQuotes && (ch === '\n' || ch === '\r')) {
            if (ch === '\r' && next === '\n') i += 1;
            row.push(cell);
            if (row.some(v => String(v).trim() !== '')) rows.push(row);
            row = [];
            cell = '';
            continue;
        }

        cell += ch;
    }

    row.push(cell);
    if (row.some(v => String(v).trim() !== '')) rows.push(row);
    return rows;
}

function normalizeHeader(value) {
    return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase();
}

function csvEscape(value) {
    const s = value === null || value === undefined ? '' : String(value);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function importMembersCSV() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = (e) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
            const rows = parseCSVText(String(ev.target.result || ''));
            if (rows.length < 2) {
                notifyUser('Members CSV is empty or missing data rows.', 'warning', {
                    hint: 'Include a header row and at least one member row.',
                });
                return;
            }

            const headers = rows[0].map(normalizeHeader);
            const col = Object.fromEntries(headers.map((h, i) => [h, i]));
            const required = ['id', 'start', 'end'];
            const missing = required.filter(h => !(h in col));
            if (missing.length) {
                notifyUser(`Members CSV missing required columns: ${missing.join(', ')}`, 'error', {
                    hint: 'Required columns: id, start, end.',
                });
                return;
            }

            document.getElementById('member-tbody').innerHTML = '';
            let imported = 0;
            let skipped = 0;
            const issues = [];

            for (let i = 1; i < rows.length; i++) {
                const vals = rows[i];
                const get = (name) => (vals[col[name]] ?? '').trim();
                const id = get('id');
                const start = get('start');
                const end = get('end');
                const group = (get('group') || 'GENERAL').toUpperCase();
                const label = get('label');

                if (!id || !start || !end) {
                    skipped += 1;
                    issues.push(`Row ${i + 1}: missing id/start/end.`);
                    continue;
                }

                addMemberRowWithData(id, start, end, '', group, label);
                imported += 1;
            }

            onDataChanged('members');
            if (issues.length) {
                notifyUser(`Imported ${imported} member rows, skipped ${skipped}.\n${issues.slice(0, 8).join('\n')}`, 'warning', {
                    sticky: true,
                });
            } else {
                notifyUser(`Imported ${imported} member rows.`, 'success');
            }
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
            const rows = parseCSVText(String(ev.target.result || ''));
            if (rows.length < 2) {
                notifyUser('Loads CSV is empty or missing data rows.', 'warning', {
                    hint: 'Include a header row and at least one load row.',
                });
                return;
            }

            const headers = rows[0].map(normalizeHeader);
            const col = Object.fromEntries(headers.map((h, i) => [h, i]));
            const required = ['id', 'load_case', 'load_type', 'start', 'end', 'intensity', 'direction'];
            const missing = required.filter(h => !(h in col));
            if (missing.length) {
                notifyUser(`Loads CSV missing required columns: ${missing.join(', ')}`, 'error', {
                    hint: 'Required columns: id, load_case, load_type, start, end, intensity, direction.',
                });
                return;
            }

            document.getElementById('load-tbody').innerHTML = '';
            let imported = 0;
            let skipped = 0;
            const issues = [];

            for (let i = 1; i < rows.length; i++) {
                const vals = rows[i];
                const get = (name) => (vals[col[name]] ?? '').trim();

                const id = get('id') || `L${i}`;
                const loadCase = get('load_case') || 'LC1';
                const loadType = (get('load_type') || 'PARTIAL_UDL').toUpperCase();
                const start = get('start');
                const end = get('end');
                const intensity = get('intensity');
                const intensityEnd = get('intensity_end');
                const direction = (get('direction') || 'GY').toUpperCase();
                const notes = get('notes');

                if (!start || !end || !intensity) {
                    skipped += 1;
                    issues.push(`Row ${i + 1}: missing start/end/intensity.`);
                    continue;
                }

                addLoadRowWithData(
                    id,
                    loadCase,
                    loadType,
                    start,
                    end,
                    intensity,
                    intensityEnd || '',
                    direction,
                    notes || '',
                );
                imported += 1;
            }

            onDataChanged('loads');
            if (issues.length) {
                notifyUser(`Imported ${imported} load rows, skipped ${skipped}.\n${issues.slice(0, 8).join('\n')}`, 'warning', {
                    sticky: true,
                });
            } else {
                notifyUser(`Imported ${imported} load rows.`, 'success');
            }
        };
        reader.readAsText(e.target.files[0]);
    };
    input.click();
}

// ─── CSV Export ─────────────────────────────────────────────────────────────

function exportMembersCSV() {
    const members = collectMembersForProjectFile();
    if (members.length === 0) {
        notifyUser('No members to export.', 'warning', {
            hint: 'Add member rows or import Members CSV first.',
        });
        return;
    }

    let csv = 'id,start,end,group,label\n';
    for (const m of members) {
        csv += `${csvEscape(m.id)},${csvEscape(m.start)},${csvEscape(m.end)},${csvEscape(m.group || 'GENERAL')},${csvEscape(m.label || '')}\n`;
    }
    downloadBlob(new Blob([csv], { type: 'text/csv' }), 'members.csv');
}

function exportLoadsCSV() {
    const loads = collectLoadsForProjectFile();
    if (loads.length === 0) {
        notifyUser('No loads to export.', 'warning', {
            hint: 'Add load rows or import Loads CSV first.',
        });
        return;
    }

    let csv = 'id,load_case,load_type,start,end,intensity,intensity_end,direction,notes\n';
    for (const lo of loads) {
        csv += `${csvEscape(lo.id)},${csvEscape(lo.load_case)},${csvEscape(lo.load_type)},${csvEscape(lo.start)},${csvEscape(lo.end)},${csvEscape(lo.intensity)},${csvEscape(lo.intensity_end !== null ? lo.intensity_end : '')},${csvEscape(lo.direction)},${csvEscape(lo.notes || '')}\n`;
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

function bindLiveInputHandlers() {
    const settingsPanel = document.getElementById('tab-settings');
    if (settingsPanel) {
        settingsPanel.addEventListener('input', (e) => {
            if (e.target && e.target.matches('input, select, textarea')) {
                onDataChanged('settings');
                
                // Auto-sync Box Culvert geometry if a governing input changes
                const boxInputs = [
                    'clear-span', 'num-cells', 'wall-thickness', 'mid-wall-thickness',
                    'haunch-size', 'culvert-height', 'slab-thickness', 'bottom-slab-thickness',
                    'structure-type'
                ];
                if (boxInputs.includes(e.target.id)) {
                    const stype = document.getElementById('structure-type').value;
                    if (stype.startsWith('BOX_CULVERT_') && memberMode === 'auto') {
                        generateBoxCulvertMembers();
                    }
                }
            }
        });
        settingsPanel.addEventListener('change', (e) => {
            if (e.target && e.target.matches('input, select, textarea')) {
                if (e.target.id === 'geometry-template') {
                    handleGeometryTemplateSelection(e.target.value);
                    return;
                }
                onDataChanged('settings');
                
                // For dropdowns (structure-type) the change event is key
                const boxInputs = [
                    'clear-span', 'num-cells', 'wall-thickness', 'mid-wall-thickness',
                    'haunch-size', 'culvert-height', 'slab-thickness', 'bottom-slab-thickness',
                    'structure-type'
                ];
                const boxInputsChangeOnly = ['custom-breakpoints', 'custom-wall-ranges'];
                if (boxInputs.includes(e.target.id) || boxInputsChangeOnly.includes(e.target.id)) {
                    const stype = document.getElementById('structure-type').value;
                    if (stype.startsWith('BOX_CULVERT_') && memberMode === 'auto') {
                        generateBoxCulvertMembers();
                    }
                }
            }
        });
    }

    const memberBody = document.getElementById('member-tbody');
    if (memberBody) {
        memberBody.addEventListener('input', (e) => {
            if (!e.target) return;
            const row = e.target.closest('tr');
            if (row && (e.target.classList.contains('m-start') || e.target.classList.contains('m-end'))) {
                updateMemberWidthCell(row);
            }
            onDataChanged('members');
        });
        memberBody.addEventListener('change', () => onDataChanged('members'));
    }

    const loadBody = document.getElementById('load-tbody');
    if (loadBody) {
        loadBody.addEventListener('input', () => onDataChanged('loads'));
        loadBody.addEventListener('change', () => onDataChanged('loads'));
    }

    const mlIncrement = document.getElementById('ml-increment');
    if (mlIncrement) {
        mlIncrement.addEventListener('input', () => {
            updateRunReadinessPanel();
            scheduleLiveSweep();
        });
        mlIncrement.addEventListener('change', () => {
            updateRunReadinessPanel();
            scheduleLiveSweep();
        });
    }

    const mlStaadInput = document.getElementById('ml-std-input');
    if (mlStaadInput) {
        mlStaadInput.addEventListener('input', () => {
            updateRunReadinessPanel();
            scheduleLiveSweep();
        });
        mlStaadInput.addEventListener('change', () => {
            updateRunReadinessPanel();
            scheduleLiveSweep();
        });
    }

    const autoRun = document.getElementById('auto-run-toggle');
    if (autoRun) {
        autoRun.addEventListener('change', () => {
            if (autoRun.checked) scheduleLiveCalculation();
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Set today's date
    const projectDateEl = document.getElementById('project-date');
    if (projectDateEl) projectDateEl.value = new Date().toISOString().split('T')[0];
    populateGeometryTemplateOptions();
    const geometryTemplate = document.getElementById('geometry-template');
    if (geometryTemplate) renderGeometryTemplateFields(geometryTemplate.value);
    bindLiveInputHandlers();
    toggleWidthMode();

    // Load default example data
    generateAutoMembers();
    loadDefaultLoads();
    updateRunReadinessPanel();

    window.addEventListener('resize', () => {
        if (typeof renderGeometry2DCrossSection === 'function') {
            renderGeometry2DCrossSection();
        }
        if (currentSweepResult && typeof renderLongitudinalSweepViz === 'function') {
            renderLongitudinalSweepViz();
        }
    });
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
    onDataChanged('members');
}

function loadDefaultLoads() {
    // Preload example loads: bridge deck scenario
    addLoadRowWithData('L1', 'LC1', 'PARTIAL_UDL', '0.90', '2.40', '-25', '', 'GY', 'Patch load 1');
    addLoadRowWithData('L2', 'LC1', 'PARTIAL_UDL', '2.10', '5.60', '-18', '', 'GY', 'Patch load 2');
    addLoadRowWithData('L3', 'LC2', 'PARTIAL_UDL', '6.20', '8.10', '-12', '', 'GY', 'Patch load 3');
    onDataChanged('loads');
}

/**
 * Load a complete industry-standard 3-cell box culvert sample project.
 * IRC:6-2017 / IRC:112-2020 compliant design parameters.
 *
 * Typical scenario: 3-cell RCC box culvert for a state highway,
 * 4.5m clear span per cell, 3.5m clear height, 0.6m earth fill.
 */
function loadSampleProject3Cell() {
    // ═══════════════════════════════════════════════════════════════
    // 1. PROJECT SETTINGS
    // ═══════════════════════════════════════════════════════════════
    document.getElementById('project-name').value = 'NH-44 3-Cell Box Culvert';
    document.getElementById('bridge-name').value = 'Km 142+350 Cross Drainage';
    document.getElementById('engineer').value = 'Design Engineer';
    document.getElementById('comments').value = 'IRC:6-2017 loading, IRC:112-2020 design. M35 concrete, Fe500 steel. 0.6m earth fill above top slab.';

    // Structure Configuration — realistic 3-cell box culvert
    document.getElementById('structure-type').value = 'BOX_CULVERT_3CELL';
    document.getElementById('num-cells').value = '3';
    document.getElementById('clear-span').value = '4.5';
    document.getElementById('culvert-height').value = '3.5';
    document.getElementById('slab-thickness').value = '0.50';
    document.getElementById('bottom-slab-thickness').value = '0.55';
    document.getElementById('wall-thickness').value = '0.45';
    document.getElementById('mid-wall-thickness').value = '0.30';
    document.getElementById('haunch-size').value = '0.15';
    document.getElementById('fill-depth').value = '0.6';
    document.getElementById('reference-axis').value = 'LEFT_EDGE';
    document.getElementById('decimal-precision').value = '3';
    document.getElementById('units').value = 'm';

    onDataChanged('settings');

    // ═══════════════════════════════════════════════════════════════
    // 2. GEOMETRY — auto-generated from structure config
    // ═══════════════════════════════════════════════════════════════
    generateBoxCulvertMembers();

    // ═══════════════════════════════════════════════════════════════
    // 3. LOADS — IRC standard load cases
    // ═══════════════════════════════════════════════════════════════
    const totalW = parseFloat(document.getElementById('total-width').value);
    const cullH = 3.5;
    const fillD = 0.6;

    document.getElementById('load-tbody').innerHTML = '';

    // ── LC1: Dead Load (Self Weight) — UDL on top slab ──
    // Concrete unit weight = 25 kN/m³, slab thickness = 0.50m
    // DL intensity = 25 × 0.50 = 12.5 kN/m²
    addLoadRowWithData('L1', 'LC1', 'DEAD_LOAD', '0', totalW, '-12.5', '', 'GY',
        'Self weight top slab: 25×0.50=12.5 kN/m²');

    // ── LC2: SIDL — Earth fill on top slab ──
    // Soil unit weight = 20 kN/m³, fill depth = 0.6m
    // Fill DL = 20 × 0.6 = 12.0 kN/m²
    addLoadRowWithData('L2', 'LC2', 'DEAD_LOAD', '0', totalW, '-12.0', '', 'GY',
        'Earth fill: γs=20×H=0.6 = 12.0 kN/m²');

    // ── LC3: SIDL — Wearing course ──
    // Asphalt unit weight = 22 kN/m³, thickness = 0.075m
    // WC = 22 × 0.075 = 1.65 kN/m²
    addLoadRowWithData('L3', 'LC3', 'WEARING_COURSE', '0', totalW, '-1.65', '', 'GY',
        'WC: γa=22×t=0.075 = 1.65 kN/m²');

    // ── LC4: Earth Pressure on Left Wall ──
    // K₀ = 0.5, γ = 20 kN/m³, H = 3.5m
    // EP at top = K₀ × γ × fill = 0.5 × 20 × 0.6 = 6.0 kN/m²
    // EP at bottom = K₀ × γ × (H + fill) = 0.5 × 20 × 4.1 = 41.0 kN/m²
    addLoadRowWithData('L4', 'LC4', 'EARTH_PRESSURE', '0', '0.45', '-6.0', '-41.0', 'GX',
        'EP Left: K₀γ(h), K₀=0.5, γ=20, TRAP');

    // ── LC5: Earth Pressure on Right Wall ──
    addLoadRowWithData('L5', 'LC5', 'EARTH_PRESSURE', (totalW - 0.45).toFixed(2), totalW, '6.0', '41.0', 'GX',
        'EP Right: K₀γ(h), K₀=0.5, γ=20, TRAP');

    // ── LC6: Hydrostatic (Water Pressure) on Left Wall ──
    // γw = 9.81 kN/m³, max height = 2/3 × 3.5 = 2.33m
    // WP at bottom = 9.81 × 2.33 = 22.86 kN/m²
    addLoadRowWithData('L6', 'LC6', 'HYDROSTATIC', '0', '0.45', '0.01', '22.86', 'GX',
        'WP Left: γw×Hw, γw=9.81, Hw=2.33m');

    // ── LC7: Hydrostatic on Right Wall ──
    addLoadRowWithData('L7', 'LC7', 'HYDROSTATIC', (totalW - 0.45).toFixed(2), totalW, '0.01', '-22.86', 'GX',
        'WP Right: γw×Hw, γw=9.81, Hw=2.33m');

    // ── LC8: Surcharge on Left Wall (from traffic above) ──
    // Surcharge = q × K₀ = 24 × 0.5 = 12.0 kN/m² (uniform)
    addLoadRowWithData('L8', 'LC8', 'SURCHARGE', '0', '0.45', '-12.0', '', 'GX',
        'Surcharge Left: q×K₀ = 24×0.5 = 12 kN/m²');

    // ── LC9: Surcharge on Right Wall ──
    addLoadRowWithData('L9', 'LC9', 'SURCHARGE', (totalW - 0.45).toFixed(2), totalW, '12.0', '', 'GX',
        'Surcharge Right: q×K₀ = 24×0.5 = 12 kN/m²');

    // ── LC10: IRC Class A — Two lane loading (lane 1) ──
    // IRC Class A: 114 kN axle, 2 wheels × 0.25m contact, CTC 1.8m
    // Dispersed wheel load on slab (per metre run):
    // Contact = 0.25 + 2×(0.5+0.6+0.075) = 2.60m dispersed width
    // Intensity = 57 / 2.60 = 21.92 kN/m per wheel
    addLoadRowWithData('L10', 'LC10', 'IRC_CLASS_A', '1.35', '3.95', '-21.92', '', 'GY',
        'IRC Class A Lane 1: 114kN axle dispersed, 0.15m kerb clr');

    // ── LC11: IRC Class A — Two lane loading (lane 2) ──
    addLoadRowWithData('L11', 'LC11', 'IRC_CLASS_A', '5.85', '8.45', '-21.92', '', 'GY',
        'IRC Class A Lane 2: 114kN axle dispersed');

    // ── LC12: IRC 70R Tracked — Single lane ──
    // 700 kN over 4.57m length, 0.84m track width × 2 tracks
    // CTC = 2.06m, dispersed contact width = 0.84 + 2×(0.5+0.6) = 3.04m
    // Intensity per track = 350/(4.57×3.04) = 25.19 kN/m²
    addLoadRowWithData('L12', 'LC12', 'IRC_70R', '3.75', '6.79', '-25.19', '', 'GY',
        'IRC 70R Tracked: 700kN/4.57m, track dispersed @ 3.04m');

    onDataChanged('loads');

    // Show confirmation
    notifyUser('✅ Loaded industry-standard 3-cell box culvert sample project with 12 load cases (DL, SIDL, WC, EP, WP, Surcharge, IRC Class A, IRC 70R).', 'success', {
        hint: 'Navigate to the Results tab and click "Calculate" to analyse.'
    });
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
            notifyUser('Error: ' + data.error);
        }
    } catch (e) { notifyUser('Error: ' + e.message); }
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
            notifyUser('Error: ' + data.error);
        }
    } catch (e) { notifyUser('Error: ' + e.message); }
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
            notifyUser('Error: ' + data.error);
        }
    } catch (e) { notifyUser('Error: ' + e.message); }
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
            notifyUser('Error: ' + data.error);
        }
    } catch (e) { notifyUser('Error: ' + e.message); }
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
            notifyUser('Error: ' + data.error);
        }
    } catch (e) { notifyUser('Error: ' + e.message); }
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
            notifyUser('Error: ' + (data.error || 'No results'));
        }
    } catch (e) { notifyUser('Error: ' + e.message); }
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
            notifyUser('Error: ' + data.error);
        }
    } catch (e) { notifyUser('Error: ' + e.message); }
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
            mid_wall_thickness: parseFloat(document.getElementById('std-mid-wall').value),
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
                notifyUser('Error: ' + data.error);
            }
        }
    } catch (e) { notifyUser('Error: ' + e.message); }
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
            notifyUser('Error: ' + data.error);
        }
    } catch (e) { notifyUser('Error: ' + e.message); }
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
    } catch (e) { notifyUser('Error: ' + e.message); }
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
    } catch (e) { notifyUser('Error: ' + e.message); }
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
    } catch (e) { notifyUser('Error: ' + e.message); }
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
    } catch (e) { notifyUser('Error: ' + e.message); }
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
    } catch (e) { notifyUser('Error: ' + e.message); }
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
    } catch (e) { notifyUser('Error: ' + e.message); }
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
    } catch (e) { notifyUser('Error: ' + e.message); }
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
    } catch (e) { notifyUser('Error: ' + e.message); }
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
    } catch (e) { notifyUser('Error: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW: AUTO DESIGN TAB LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

function switchAdTab(tabId) {
    document.querySelectorAll('#tab-auto-design .diagram-content > div').forEach(div => div.style.display = 'none');
    document.querySelectorAll('#tab-auto-design .diagram-nav .tab-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.style.borderBottom = '2px solid transparent';
        btn.style.fontWeight = 'normal';
    });
    
    document.getElementById(tabId).style.display = 'block';
    const activeBtn = Array.from(document.querySelectorAll('#tab-auto-design .diagram-nav .tab-btn'))
        .find(btn => btn.getAttribute('onclick').includes(tabId));
    if (activeBtn) {
        activeBtn.classList.add('active');
        activeBtn.style.borderBottom = '2px solid var(--primary)';
        activeBtn.style.fontWeight = '600';
    }
}

async function runAutoDesign() {
    const loadingEl = document.getElementById('ad-loading');
    const dashboardEl = document.getElementById('ad-dashboard');
    
    // Hide previous results, show loader
    dashboardEl.style.display = 'none';
    loadingEl.style.display = 'block';
    clearAppMessages();

    // Collect 18 inputs
    const payload = {
        num_cells: parseInt(document.getElementById('ad-cells').value),
        clear_span: parseFloat(document.getElementById('ad-span').value),
        clear_height: parseFloat(document.getElementById('ad-height').value),
        top_slab_thickness: parseFloat(document.getElementById('ad-top').value),
        bottom_slab_thickness: parseFloat(document.getElementById('ad-bot').value),
        wall_thickness: parseFloat(document.getElementById('ad-wall').value),
        mid_wall_thickness: parseFloat(document.getElementById('ad-midwall').value),
        haunch_size: parseFloat(document.getElementById('ad-haunch').value),
        fck: parseFloat(document.getElementById('ad-fck').value),
        fy: parseFloat(document.getElementById('ad-fy').value),
        clear_cover: parseFloat(document.getElementById('ad-cover').value),
        fill_depth: parseFloat(document.getElementById('ad-fill').value),
        wearing_course_thickness: parseFloat(document.getElementById('ad-wc').value),
        gamma_soil: parseFloat(document.getElementById('ad-gamma').value),
        friction_angle: parseFloat(document.getElementById('ad-phi').value),
        allowable_bearing: parseFloat(document.getElementById('ad-sbc').value),
        water_table_depth: parseFloat(document.getElementById('ad-water').value),
        culvert_length: parseFloat(document.getElementById('ad-length').value),
    };

    try {
        const res = await fetch('/api/smart/auto-design', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        
        const result = data.result;
        
        // Render Detailed HTML Table Report
        renderDetailedReportTable(result);
        
        // Build Traffic Light Summary Cards
        renderDesignDashboardSummary(result);
        
        // Show results so canvas elements have non-zero dimensions
        loadingEl.style.display = 'none';
        dashboardEl.style.display = 'block';
        
        // Trigger Diagrams in design_diagrams.js
        if (typeof window.renderAutoDesignDiagrams === 'function') {
            // Slight delay sometimes helps if the browser hasn't painted yet, but directly should usually work
            setTimeout(() => window.renderAutoDesignDiagrams(result, payload), 50);
        }
        
    } catch (e) {
        loadingEl.style.display = 'none';
        notifyUser('Auto Design Error: ' + e.message, 'error');
    }
}

function renderDetailedReportTable(res) {
    const container = document.getElementById('ad-raw-json');
    if (!container) return;
    
    // Clear out any `<pre>` behavior if the element itself is a pre, or just set innerHTML
    container.style.whiteSpace = 'normal';
    container.style.overflowX = 'auto';
    container.style.backgroundColor = 'transparent';
    container.style.padding = '0';
    
    let html = `
    <div style="background: var(--surface); border-radius: 8px; border: 1px solid var(--border); overflow: hidden;">
        <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
            <thead>
                <tr style="background: rgba(0,0,0,0.2); border-bottom: 2px solid var(--border);">
                    <th style="padding: 12px 16px; font-weight: 600; color: var(--text-muted); width: 30%;">Category / Parameter</th>
                    <th style="padding: 12px 16px; font-weight: 600; color: var(--text-muted);">Value / Status</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    // Helper to format values
    const formatValue = (val) => {
        if (typeof val === 'number') return val.toFixed(3).replace(/\.?0+$/, '');
        if (typeof val === 'boolean') return val ? 'Yes' : 'No';
        if (typeof val === 'string') {
            if (val === 'PASS') return '<span style="color: #10b981; font-weight: bold;">PASS</span>';
            if (val === 'FAIL') return '<span style="color: #ef4444; font-weight: bold;">FAIL</span>';
            return val;
        }
        return val;
    };
    
    // Helper to render a section
    const renderSection = (title, obj) => {
        if (!obj) return '';
        let sectionHtml = `
            <tr style="background: rgba(255,255,255,0.02); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);">
                <td colspan="2" style="padding: 12px 16px; font-weight: bold; color: var(--primary); font-size: 1rem; text-transform: uppercase;">
                    ${title}
                </td>
            </tr>
        `;
        
        for (const [key, value] of Object.entries(obj)) {
            // Skip deeply nested objects for simple table, or format them flat
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                // Flatten one level deep for things like top_slab_hog
                if (value.status || value.provided_ast || value.ratio) {
                    const subText = Object.entries(value)
                        .filter(([k,v]) => k !== 'status')
                        .map(([k,v]) => `${k.replace(/_/g, ' ')}: ${formatValue(v)}`)
                        .join(', ');
                        
                    sectionHtml += `
                        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                            <td style="padding: 10px 16px; color: var(--text-secondary); padding-left: 24px;">${key.replace(/_/g, ' ').toUpperCase()}</td>
                            <td style="padding: 10px 16px;">
                                <div style="margin-bottom: 4px;">Status: ${formatValue(value.status)}</div>
                                <div style="font-size: 0.8rem; opacity: 0.7;">${subText}</div>
                            </td>
                        </tr>
                    `;
                } else {
                     sectionHtml += `
                        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                            <td style="padding: 10px 16px; color: var(--text-secondary); padding-left: 24px;">${key.replace(/_/g, ' ').toUpperCase()}</td>
                            <td style="padding: 10px 16px; font-style: italic; opacity: 0.6;">(Complex Object - See Visuals)</td>
                        </tr>
                    `;
                }
            } else {
                sectionHtml += `
                    <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                        <td style="padding: 10px 16px; color: var(--text-secondary); padding-left: 24px;">${key.replace(/_/g, ' ')}</td>
                        <td style="padding: 10px 16px;">${formatValue(value)}</td>
                    </tr>
                `;
            }
        }
        return sectionHtml;
    };
    
    // Add sections
    try {
        html += renderSection('Geometry Overview', res.geometry || res.model);
        html += renderSection('Design Ratios', res.design_ratios);
        if (res.checks) {
            html += renderSection('Bearing Pressure', res.checks.bearing_pressure);
            html += renderSection('Reinforcement Specs', res.checks.reinforcement);
            html += renderSection('Crack Width Check', res.checks.crack_width);
            html += renderSection('Shear Check', res.checks.shear);
        }
        html += renderSection('Base Quantities', res.quantities);
    } catch(e) {
        html += `<tr><td colspan="2" style="padding: 16px; color: #ef4444;">Error parsing report: ${e.message}</td></tr>`;
    }
    
    html += `
            </tbody>
        </table>
    </div>
    `;
    
    container.innerHTML = html;
}

function renderDesignDashboardSummary(res) {
    const container = document.getElementById('ad-summary-cards');
    if (!container) return;
    
    // Status color helper
    const getStatusColor = (status) => status === 'PASS' ? '#10b981' : (status === 'FAIL' ? '#ef4444' : '#f59e0b');
    const getStatusIcon = (status) => status === 'PASS' ? '✅' : (status === 'FAIL' ? '❌' : '⚠️');
    
    let html = '';
    
    // Ratios
    const maxRatioObj = res.design_ratios.critical_ratio || { ratio: 0, check: 'N/A' };
    const overallStatus = maxRatioObj.ratio > 1.0 ? 'FAIL' : 'PASS';
    
    html += `
        <div style="background: linear-gradient(135deg, rgba(255,255,255,0.05), rgba(255,255,255,0.0)); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); border-top: 4px solid ${getStatusColor(overallStatus)}; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.05); position: relative; overflow: hidden;">
            <div style="position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: radial-gradient(circle, ${getStatusColor(overallStatus)}20 0%, transparent 60%); z-index: 0; pointer-events: none;"></div>
            <div style="position: relative; z-index: 1;">
                <div style="font-size: 2.5rem; font-weight: bold; color: ${getStatusColor(overallStatus)}; text-shadow: 0 2px 10px ${getStatusColor(overallStatus)}40;">${getStatusIcon(overallStatus)}</div>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">Overall Design Status</div>
                <div style="font-size: 1.25rem; font-weight: 800; margin-top: 4px; color: var(--text-primary);">Max Ratio: ${maxRatioObj.ratio.toFixed(2)}</div>
                <div style="font-size: 0.8rem; color: var(--primary); margin-top: 4px; background: rgba(var(--primary-rgb), 0.1); display: inline-block; padding: 4px 10px; border-radius: 20px;">Critical: ${maxRatioObj.check}</div>
            </div>
        </div>
    `;
    
    // Bearing Check
    const bearing = res.checks.bearing_pressure;
    if (bearing) {
        const bearingRatio = bearing.utilization;
        const bStatus = bearingRatio <= 1 ? 'PASS' : 'FAIL';
        html += `
            <div style="background: var(--surface); border: 1px solid var(--border); border-left: 4px solid ${getStatusColor(bStatus)}; border-radius: 12px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.02); display: flex; flex-direction: column; justify-content: center;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Soil Bearing</div>
                    <div style="font-size: 0.75rem; font-weight: bold; padding: 2px 8px; border-radius: 10px; background: ${getStatusColor(bStatus)}20; color: ${getStatusColor(bStatus)};">${bStatus}</div>
                </div>
                <div style="font-size: 1.5rem; font-weight: 800; color: var(--text-primary);">${bearing.max_pressure.toFixed(1)} <span style="font-size: 0.9rem; font-weight: 600; color: var(--text-muted);">kN/m²</span></div>
                <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 6px; display: flex; align-items: center; gap: 4px;">
                    <svg style="width:14px; height:14px; opacity:0.7;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    Allowable: ${bearing.allowable} kN/m²
                </div>
            </div>
        `;
    }
    
    // Uplift Check (Modified identical style)
    const uplift = res.checks.uplift;
    if (uplift) {
        html += `
            <div style="background: var(--surface); border: 1px solid var(--border); border-left: 4px solid ${getStatusColor(uplift.status)}; border-radius: 12px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.02); display: flex; flex-direction: column; justify-content: center;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Uplift FOS</div>
                    <div style="font-size: 0.75rem; font-weight: bold; padding: 2px 8px; border-radius: 10px; background: ${getStatusColor(uplift.status)}20; color: ${getStatusColor(uplift.status)};">${uplift.status}</div>
                </div>
                <div style="font-size: 1.5rem; font-weight: 800; color: var(--text-primary);">${(uplift.fos_uplift === 999) ? 'N/A' : uplift.fos_uplift.toFixed(2)}</div>
                <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 6px; display: flex; align-items: center; gap: 4px;">
                    <svg style="width:14px; height:14px; opacity:0.7;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    Required FOS: 1.10
                </div>
            </div>
        `;
    }
    
    // Crack Width (Max)
    if (res.checks.crack_width) {
        const cw = res.checks.crack_width;
        let crackStatus = cw.status || 'PASS';
        let maxCrack = cw.crack_width || 0;
        const exposure = document.getElementById('ad-exposure') ? document.getElementById('ad-exposure').value : 'SEVERE';
        
        html += `
            <div style="background: var(--surface); border: 1px solid var(--border); border-left: 4px solid ${getStatusColor(crackStatus)}; border-radius: 12px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.02); display: flex; flex-direction: column; justify-content: center;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Max Crack Width</div>
                    <div style="font-size: 0.75rem; font-weight: bold; padding: 2px 8px; border-radius: 10px; background: ${getStatusColor(crackStatus)}20; color: ${getStatusColor(crackStatus)};">${crackStatus}</div>
                </div>
                <div style="font-size: 1.5rem; font-weight: 800; color: var(--text-primary);">${maxCrack.toFixed(3)} <span style="font-size: 0.9rem; font-weight: 600; color: var(--text-muted);">mm</span></div>
                <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 6px; display: flex; align-items: center; gap: 4px;">
                    <svg style="width:14px; height:14px; opacity:0.7;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                    Limit: ${cw.permissible.toFixed(3)} mm (${exposure})
                </div>
            </div>
        `;
    }
    
    // Quantities (Big Span Card)
    if (res.quantities) {
        html += `
            <div style="background: linear-gradient(to right, var(--surface), rgba(16, 185, 129, 0.03)); border: 1px solid var(--border); border-left: 4px solid var(--primary); border-radius: 12px; padding: 20px; grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.02);">
                <div>
                    <div style="font-size: 0.85rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;">
                        <svg style="width:16px; height:16px; color: var(--primary);" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                        Baseline BOQ Estimates
                    </div>
                    <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 4px;">Computed for exactly ${res.geometry ? res.geometry.culvert_length : 10}m length segment</div>
                </div>
                <div style="display: flex; gap: 32px;">
                    <div style="text-align: right;">
                        <div style="font-size: 1.5rem; font-weight: 800; color: var(--text-primary);">${res.quantities.total_concrete.toFixed(1)}</div>
                        <div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;">Concrete (m³)</div>
                    </div>
                    <div style="text-align: right; border-left: 1px solid var(--border); padding-left: 32px;">
                        <div style="font-size: 1.5rem; font-weight: 800; color: var(--text-primary);">${res.quantities.total_steel_kg.toFixed(0)}</div>
                        <div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;">Steel (kg)</div>
                    </div>
                    <div style="text-align: right; border-left: 1px solid var(--border); padding-left: 32px;">
                        <div style="font-size: 1.5rem; font-weight: 800; color: var(--text-primary);">${res.quantities.total_formwork.toFixed(1)}</div>
                        <div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;">Formwork (m²)</div>
                    </div>
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}
