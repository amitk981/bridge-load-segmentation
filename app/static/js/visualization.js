/**
 * Bridge Load Segmentation — SVG Visualization
 *
 * Renders:
 * - Member strips as colored blocks along a horizontal axis
 * - Load patches as semi-transparent bars above
 * - Overlap regions with highlighting
 * - Labels for member IDs and load IDs
 */

// ─── Color Palettes ─────────────────────────────────────────────────────────

const MEMBER_COLORS = [
    '#1e3a5f', '#1a4a3f', '#3a2a5f', '#4a2a2a', '#2a3a4a',
    '#2f4858', '#1a3a4a', '#3a3a1a', '#4a1a3a', '#1a4a4a',
    '#2a4a2a', '#4a3a1a',
];

const LOAD_COLORS = [
    'rgba(0, 212, 255, 0.35)',
    'rgba(124, 92, 252, 0.35)',
    'rgba(239, 68, 68, 0.35)',
    'rgba(16, 185, 129, 0.35)',
    'rgba(245, 158, 11, 0.35)',
    'rgba(236, 72, 153, 0.35)',
];

const OVERLAP_COLOR = 'rgba(0, 212, 255, 0.15)';

// ─── Geometry Visualization ─────────────────────────────────────────────────

function updateVisualization() {
    const svg = document.getElementById('bridge-svg');
    if (!svg) return;

    const members = collectMembers();
    const loads = collectLoads();
    if (members.length === 0) {
        svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5a6478" font-size="14">Generate members to see visualization</text>';
        return;
    }

    const totalWidth = parseFloat(document.getElementById('total-width').value) || 8.5;
    const containerWidth = svg.parentElement.clientWidth - 32;
    const svgWidth = Math.max(containerWidth, 600);
    const padding = { left: 50, right: 30, top: 20, bottom: 40 };
    const drawWidth = svgWidth - padding.left - padding.right;
    const memberHeight = 56;
    const loadHeight = 18;
    const loadGap = 4;
    const loadsTop = padding.top;
    const membersTop = loads.length > 0
        ? loadsTop + loads.length * (loadHeight + loadGap) + 12
        : padding.top + 6;
    const axisY = membersTop + memberHeight + 10;
    const svgHeight = axisY + 34;

    svg.setAttribute('width', svgWidth);
    svg.setAttribute('height', svgHeight);
    svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);

    const scale = drawWidth / totalWidth;
    let html = '';

    // Load bars
    loads.forEach((lo, i) => {
        const x = padding.left + Math.max(0, lo.start) * scale;
        const endX = padding.left + Math.min(totalWidth, lo.end) * scale;
        const w = Math.max(0, endX - x);
        const y = loadsTop + i * (loadHeight + loadGap);
        const color = LOAD_COLORS[i % LOAD_COLORS.length];

        html += `<rect x="${x}" y="${y}" width="${w}" height="${loadHeight}" fill="${color}" stroke="${color.replace('0.35', '0.6')}" stroke-width="1" rx="3"/>`;
        if (w > 20) {
            html += `<text x="${x + 4}" y="${y + 12}" fill="#e8edf5" font-size="10" font-family="JetBrains Mono, monospace">${lo.id}</text>`;
        }
    });
    if (loads.length > 0) {
        html += `<text x="${padding.left - 8}" y="${loadsTop + 13}" text-anchor="end" fill="#5a6478" font-size="10">Loads</text>`;
    }

    // Axis
    html += `<line x1="${padding.left}" y1="${axisY}" x2="${padding.left + drawWidth}" y2="${axisY}" stroke="#2a3347" stroke-width="1"/>`;

    // Tick marks
    const tickInterval = totalWidth <= 5 ? 0.5 : totalWidth <= 15 ? 1 : 2;
    for (let t = 0; t <= totalWidth; t += tickInterval) {
        const x = padding.left + t * scale;
        html += `<line x1="${x}" y1="${axisY - 4}" x2="${x}" y2="${axisY + 4}" stroke="#5a6478" stroke-width="1"/>`;
        html += `<text x="${x}" y="${axisY + 18}" text-anchor="middle" fill="#5a6478" font-size="10" font-family="JetBrains Mono, monospace">${t.toFixed(1)}</text>`;
    }

    // Member blocks
    members.forEach((m, i) => {
        const x = padding.left + m.start * scale;
        const w = (m.end - m.start) * scale;
        const color = MEMBER_COLORS[i % MEMBER_COLORS.length];

        html += `<rect x="${x}" y="${membersTop}" width="${w}" height="${memberHeight}" fill="${color}" stroke="#2a3347" stroke-width="1" rx="2"/>`;

        // Member ID label
        if (w > 25) {
            html += `<text x="${x + w / 2}" y="${membersTop + memberHeight / 2 + 4}" text-anchor="middle" fill="#8892a8" font-size="${w > 40 ? 10 : 8}" font-family="JetBrains Mono, monospace">${m.id}</text>`;
        }
    });

    // "Members" label
    html += `<text x="${padding.left - 8}" y="${membersTop + memberHeight / 2 + 4}" text-anchor="end" fill="#5a6478" font-size="10" font-family="Inter, sans-serif">Members</text>`;

    svg.innerHTML = html;
}

// ─── Results Visualization (with loads and overlaps) ────────────────────────

function updateResultsVisualization() {
    const svg = document.getElementById('results-svg');
    if (!svg) return;

    const members = collectMembers();
    const loads = collectLoads();
    const overlaps = resultsDirty ? [] : (currentOverlaps || []);
    if (members.length === 0) {
        svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5a6478" font-size="14">Add members to preview results visualization</text>';
        return;
    }
    const totalWidth = parseFloat(document.getElementById('total-width').value) || 8.5;

    const containerWidth = svg.parentElement.clientWidth - 32;
    const svgWidth = Math.max(containerWidth, 600);
    const padding = { left: 50, right: 30, top: 20, bottom: 40 };
    const drawWidth = svgWidth - padding.left - padding.right;
    const memberHeight = 45;
    const loadHeight = 25;
    const loadGap = 4;
    const loadsTop = padding.top;
    const membersTop = loadsTop + loads.length * (loadHeight + loadGap) + 15;
    const svgHeight = membersTop + memberHeight + 50;

    svg.setAttribute('width', svgWidth);
    svg.setAttribute('height', svgHeight);
    svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);

    const scale = drawWidth / totalWidth;
    let html = '';

    // Load bars
    loads.forEach((lo, i) => {
        const x = padding.left + Math.max(0, lo.start) * scale;
        const endX = padding.left + Math.min(totalWidth, lo.end) * scale;
        const w = endX - x;
        const y = loadsTop + i * (loadHeight + loadGap);
        const color = LOAD_COLORS[i % LOAD_COLORS.length];

        html += `<rect x="${x}" y="${y}" width="${w}" height="${loadHeight}" fill="${color}" stroke="${color.replace('0.35', '0.6')}" stroke-width="1" rx="3"/>`;
        html += `<text x="${x + 4}" y="${y + loadHeight / 2 + 4}" fill="#e8edf5" font-size="10" font-family="JetBrains Mono, monospace">${lo.id}</text>`;
    });

    // "Loads" label
    if (loads.length > 0) {
        html += `<text x="${padding.left - 8}" y="${loadsTop + 15}" text-anchor="end" fill="#5a6478" font-size="10">Loads</text>`;
    }

    // Member blocks
    members.forEach((m, i) => {
        const x = padding.left + m.start * scale;
        const w = (m.end - m.start) * scale;
        const color = MEMBER_COLORS[i % MEMBER_COLORS.length];

        html += `<rect x="${x}" y="${membersTop}" width="${w}" height="${memberHeight}" fill="${color}" stroke="#2a3347" stroke-width="1" rx="2"/>`;

        if (w > 20) {
            html += `<text x="${x + w / 2}" y="${membersTop + memberHeight / 2 + 4}" text-anchor="middle" fill="#8892a8" font-size="${w > 35 ? 9 : 7}" font-family="JetBrains Mono, monospace">${m.id}</text>`;
        }
    });

    // Overlap highlights
    for (const r of overlaps) {
        if (r.loaded_length > 0) {
            const x = padding.left + r.overlap_start_global * scale;
            const w = r.loaded_length * scale;
            html += `<rect x="${x}" y="${membersTop}" width="${w}" height="${memberHeight}" fill="${OVERLAP_COLOR}" stroke="rgba(0,212,255,0.5)" stroke-width="1" stroke-dasharray="3,2"/>`;
        }
    }

    // "Members" label
    html += `<text x="${padding.left - 8}" y="${membersTop + memberHeight / 2 + 4}" text-anchor="end" fill="#5a6478" font-size="10">Members</text>`;

    // Axis
    const axisY = membersTop + memberHeight + 12;
    html += `<line x1="${padding.left}" y1="${axisY}" x2="${padding.left + drawWidth}" y2="${axisY}" stroke="#2a3347" stroke-width="1"/>`;

    const tickInterval = totalWidth <= 5 ? 0.5 : totalWidth <= 15 ? 1 : 2;
    for (let t = 0; t <= totalWidth; t += tickInterval) {
        const x = padding.left + t * scale;
        html += `<line x1="${x}" y1="${axisY - 4}" x2="${x}" y2="${axisY + 4}" stroke="#5a6478" stroke-width="1"/>`;
        html += `<text x="${x}" y="${axisY + 18}" text-anchor="middle" fill="#5a6478" font-size="10" font-family="JetBrains Mono, monospace">${t.toFixed(1)}</text>`;
    }

    svg.innerHTML = html;
}
