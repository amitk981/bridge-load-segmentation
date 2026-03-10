/**
 * Results Frame Visualization — Enhanced STAAD.Pro-style
 *
 * Renders the bridge cross-section with:
 *  - Gradient-filled load bars with distribution arrows
 *  - Detailed member blocks with ID, range, length AND load intensity
 *  - Overlap zones with glow effects
 *  - Proper dimension lines with bracket end-caps
 *  - d1/d2 annotations with connecting leader lines
 *  - Clean legend, summary card, axis with minor gridlines
 */

function renderResultsFrameViz() {
    const canvas = document.getElementById('results-frame-canvas');
    if (!canvas) return;

    const members = collectMembers();
    const loads = collectLoads();
    const settings = collectSettings();
    const overlaps = currentOverlaps || [];

    if (!members.length || !overlaps.length) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    // ─────────────────────────────────────────────────────────────────────────
    // Colors & Theme
    // ─────────────────────────────────────────────────────────────────────────
    const COL = {
        bg: '#0b0f19',
        bgCard: '#111827',
        grid: '#161b22',
        gridLine: 'rgba(255,255,255,0.04)',
        gridLineMajor: 'rgba(255,255,255,0.08)',
        member: '#22c55e',
        memberGlow: 'rgba(34,197,94,0.15)',
        joint: '#00d4ff',
        loadFillBase: [
            [248, 113, 113], [99, 102, 241], [16, 185, 129],
            [245, 158, 11], [236, 72, 153], [56, 189, 248],
        ],
        overlap: 'rgba(0,212,255,0.20)',
        overlapGlow: 'rgba(0,212,255,0.50)',
        overlapBorder: 'rgba(0,212,255,0.7)',
        d1d2: '#facc15',
        d1d2Muted: 'rgba(250,204,21,0.4)',
        dim: '#6b7280',
        dimLight: '#9ca3af',
        text: '#e5e7eb',
        textBright: '#f9fafb',
        muted: '#4b5563',
        accent: '#00d4ff',
        accentGlow: 'rgba(0,212,255,0.12)',
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Layout — dynamically calculate required height based on content
    // ─────────────────────────────────────────────────────────────────────────
    const totalWidth = settings.total_width || 8.5;
    const margin = { top: 100, right: 50, bottom: 85, left: 70 };
    const drawW = rect.width - margin.left - margin.right;
    const scale = drawW / totalWidth;

    const loadBarH = Math.min(26, 200 / Math.max(loads.length, 1));
    const loadZoneH = Math.max(90, loads.length * (loadBarH + 4) + 10);
    const gapAfterLoads = 25;
    const memberZoneH = 80;
    const gapAfterMembers = 18;
    const d1d2ZoneH = 55;

    const loadY = margin.top;
    const memberY = loadY + loadZoneH + gapAfterLoads;
    const d1d2Y = memberY + memberZoneH + gapAfterMembers;
    const axisY = d1d2Y + d1d2ZoneH + 15;

    // Dynamic canvas height — resize if content needs more space
    const requiredH = axisY + 50;
    const canvasStyleH = Math.max(440, requiredH);
    canvas.style.height = canvasStyleH + 'px';

    // Re-read rect after style change
    const finalRect = canvas.getBoundingClientRect();
    canvas.width = finalRect.width * dpr;
    canvas.height = finalRect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = finalRect.width;
    const H = finalRect.height;

    function tx(x) { return margin.left + x * scale; }

    // ─────────────────────────────────────────────────────────────────────────
    // Background & Grid
    // ─────────────────────────────────────────────────────────────────────────
    // Radial gradient background
    const bgGrad = ctx.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, W);
    bgGrad.addColorStop(0, '#111827');
    bgGrad.addColorStop(1, '#0b0f19');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Minor grid
    const minorStep = totalWidth <= 5 ? 0.25 : totalWidth <= 12 ? 0.5 : 1.0;
    ctx.strokeStyle = COL.gridLine;
    ctx.lineWidth = 0.5;
    for (let gx = 0; gx <= totalWidth; gx += minorStep) {
        ctx.beginPath();
        ctx.moveTo(tx(gx), margin.top - 15);
        ctx.lineTo(tx(gx), axisY + 5);
        ctx.stroke();
    }

    // Major grid
    const majorStep = totalWidth <= 5 ? 1.0 : totalWidth <= 12 ? 2.0 : 5.0;
    ctx.strokeStyle = COL.gridLineMajor;
    ctx.lineWidth = 0.8;
    for (let gx = 0; gx <= totalWidth; gx += majorStep) {
        ctx.beginPath();
        ctx.moveTo(tx(gx), margin.top - 15);
        ctx.lineTo(tx(gx), axisY + 5);
        ctx.stroke();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Title Bar
    // ─────────────────────────────────────────────────────────────────────────
    // Title background strip
    ctx.fillStyle = 'rgba(0,212,255,0.03)';
    ctx.fillRect(0, 0, W, 52);
    ctx.strokeStyle = 'rgba(0,212,255,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 52);
    ctx.lineTo(W, 52);
    ctx.stroke();

    ctx.font = '700 15px Inter, system-ui, sans-serif';
    ctx.fillStyle = COL.textBright;
    ctx.textAlign = 'center';
    ctx.fillText('STAAD.Pro Model — Load-Member Overlap Results', W / 2, 22);

    ctx.font = '400 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = COL.dim;
    const subtitle = `${settings.project_name || 'Bridge Load Analysis'}  ·  Width: ${totalWidth}m  ·  ${members.length} Members  ·  ${loads.length} Loads  ·  ${overlaps.length} Overlaps`;
    ctx.fillText(subtitle, W / 2, 40);

    // ─────────────────────────────────────────────────────────────────────────
    // Legend (top right)
    // ─────────────────────────────────────────────────────────────────────────
    const legendItems = [
        { color: 'rgba(248,113,113,0.7)', label: 'Load Patches', shape: 'rect' },
        { color: COL.member, label: 'Members', shape: 'rect' },
        { color: COL.overlapBorder, label: 'Overlap Zones', shape: 'dash' },
        { color: COL.d1d2, label: 'd1 / d2', shape: 'line' },
    ];

    ctx.font = '500 9px Inter, system-ui, sans-serif';
    let legendX = W - 42;
    for (let i = legendItems.length - 1; i >= 0; i--) {
        const item = legendItems[i];
        const labelW = ctx.measureText(item.label).width;
        legendX -= labelW + 22;
        const ly = 62;

        if (item.shape === 'dash') {
            ctx.strokeStyle = item.color;
            ctx.lineWidth = 2;
            ctx.setLineDash([3, 2]);
            ctx.strokeRect(legendX, ly, 10, 8);
            ctx.setLineDash([]);
        } else if (item.shape === 'line') {
            ctx.strokeStyle = item.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(legendX, ly + 4);
            ctx.lineTo(legendX + 10, ly + 4);
            ctx.stroke();
        } else {
            ctx.fillStyle = item.color;
            roundRect(ctx, legendX, ly, 10, 8, 2);
            ctx.fill();
        }
        ctx.fillStyle = COL.text;
        ctx.textAlign = 'left';
        ctx.fillText(item.label, legendX + 14, ly + 8);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Summary Box (top left)
    // ─────────────────────────────────────────────────────────────────────────
    const totalLoaded = overlaps.reduce((sum, r) => sum + r.loaded_length, 0);
    const maxInt = Math.max(...overlaps.map(r => Math.abs(r.intensity)));

    // Glass card
    ctx.fillStyle = COL.accentGlow;
    roundRect(ctx, 14, 58, 220, 32, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,212,255,0.25)';
    ctx.lineWidth = 1;
    roundRect(ctx, 14, 58, 220, 32, 8);
    ctx.stroke();

    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.fillStyle = COL.accent;
    ctx.textAlign = 'left';
    ctx.fillText(`Overlaps: ${overlaps.length}  ·  Max: ${maxInt} kN/m`, 22, 72);
    ctx.font = '400 9px Inter, system-ui, sans-serif';
    ctx.fillStyle = COL.dimLight;
    ctx.fillText(`Total loaded length: ${totalLoaded.toFixed(2)}m`, 22, 84);

    // ─────────────────────────────────────────────────────────────────────────
    // Section Labels (left side)
    // ─────────────────────────────────────────────────────────────────────────
    ctx.textAlign = 'right';

    // LOADS label
    ctx.font = '700 10px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(248,113,113,0.8)';
    ctx.fillText('LOADS', margin.left - 12, loadY + 15);

    // MEMBERS label
    ctx.fillStyle = COL.member;
    ctx.fillText('MEMBERS', margin.left - 12, memberY + memberZoneH / 2 + 3);

    // d1/d2 label
    ctx.fillStyle = COL.d1d2;
    ctx.fillText('d1/d2', margin.left - 12, d1d2Y + 15);

    // ─────────────────────────────────────────────────────────────────────────
    // LOADS — Gradient Bars with Pressure Arrows
    // ─────────────────────────────────────────────────────────────────────────


    loads.forEach((lo, i) => {
        const x1 = tx(Math.max(0, lo.start));
        const x2 = tx(Math.min(totalWidth, lo.end));
        const w = x2 - x1;
        const y = loadY + i * (loadBarH + 4);
        const rgb = COL.loadFillBase[i % COL.loadFillBase.length];

        // Gradient fill
        const grad = ctx.createLinearGradient(x1, y, x1, y + loadBarH);
        grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.45)`);
        grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.20)`);
        ctx.fillStyle = grad;
        roundRect(ctx, x1, y, w, loadBarH, 4);
        ctx.fill();

        // Stroke
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.8)`;
        ctx.lineWidth = 1.2;
        roundRect(ctx, x1, y, w, loadBarH, 4);
        ctx.stroke();

        // Distribution arrows (evenly spaced down arrows)
        const strokeColor = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        const numArrows = Math.max(3, Math.floor(w / 20));
        for (let a = 0; a < numArrows; a++) {
            const ax = x1 + ((a + 0.5) / numArrows) * w;
            drawPressureArrow(ctx, ax, y + 3, ax, y + loadBarH - 3, strokeColor);
        }

        // Load ID (left)
        ctx.font = 'bold 10px JetBrains Mono, monospace';
        ctx.fillStyle = COL.textBright;
        ctx.textAlign = 'left';
        if (w > 38) {
            ctx.fillText(`${lo.id}`, x1 + 6, y + loadBarH / 2 + 3);
        }

        // Intensity label (right, with unit)
        if (w > 70) {
            ctx.textAlign = 'right';
            ctx.font = '600 9px JetBrains Mono, monospace';
            ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
            ctx.fillText(`${lo.intensity} kN/m`, x2 - 6, y + loadBarH / 2 + 3);
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // MEMBERS — Rich Blocks with Details
    // ─────────────────────────────────────────────────────────────────────────
    const memberPalette = [
        ['#1e3a5f', '#2563eb'], ['#1a4a3f', '#10b981'], ['#3a2a5f', '#8b5cf6'],
        ['#4a2a2a', '#ef4444'], ['#2a3a4a', '#38bdf8'], ['#2f4858', '#6366f1'],
        ['#1a3a4a', '#14b8a6'], ['#3a3a1a', '#eab308'],
    ];

    members.forEach((m, i) => {
        const x = tx(m.start);
        const w = (m.end - m.start) * scale;
        const y = memberY;
        const [fillColor, accentColor] = memberPalette[i % memberPalette.length];

        // Member block with gradient
        const mGrad = ctx.createLinearGradient(x, y, x, y + memberZoneH);
        mGrad.addColorStop(0, fillColor);
        mGrad.addColorStop(1, shadeColor(fillColor, -20));
        ctx.fillStyle = mGrad;
        roundRect(ctx, x, y, w, memberZoneH, 5);
        ctx.fill();

        // Border with accent
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 1.5;
        roundRect(ctx, x, y, w, memberZoneH, 5);
        ctx.stroke();

        // Top accent stripe
        ctx.fillStyle = accentColor;
        ctx.fillRect(x + 1, y + 1, w - 2, 3);

        // Content based on available width
        if (w > 80) {
            // Full info: ID, range, length
            ctx.font = 'bold 12px JetBrains Mono, monospace';
            ctx.fillStyle = COL.textBright;
            ctx.textAlign = 'center';
            ctx.fillText(m.id, x + w / 2, y + 22);

            ctx.font = '400 8px JetBrains Mono, monospace';
            ctx.fillStyle = '#9ca3af';
            ctx.fillText(`${m.start.toFixed(2)} → ${m.end.toFixed(2)}`, x + w / 2, y + 36);
            ctx.fillText(`L = ${(m.end - m.start).toFixed(2)}m`, x + w / 2, y + 48);

            // Member intensity from overlaps
            const memberOverlaps = overlaps.filter(r =>
                r.member_id === m.id || String(r.member_id) === String(m.id)
            );
            if (memberOverlaps.length > 0) {
                const intensities = memberOverlaps.map(r => r.intensity);
                const maxI = Math.max(...intensities.map(Math.abs));
                ctx.font = '600 8px JetBrains Mono, monospace';
                ctx.fillStyle = maxI > 0 ? COL.accent : COL.muted;
                ctx.fillText(`${maxI > 0 ? '-' : ''}${maxI} kN/m`, x + w / 2, y + 62);
            }
        } else if (w > 40) {
            // Medium: ID + length
            ctx.font = 'bold 10px JetBrains Mono, monospace';
            ctx.fillStyle = COL.textBright;
            ctx.textAlign = 'center';
            ctx.fillText(m.id, x + w / 2, y + 25);

            ctx.font = '400 7px JetBrains Mono, monospace';
            ctx.fillStyle = '#9ca3af';
            ctx.fillText(`L=${(m.end - m.start).toFixed(2)}m`, x + w / 2, y + 40);
        } else if (w > 18) {
            // Small: ID only, rotated
            ctx.font = 'bold 9px JetBrains Mono, monospace';
            ctx.fillStyle = COL.textBright;
            ctx.textAlign = 'center';
            ctx.fillText(m.id, x + w / 2, y + memberZoneH / 2 + 3);
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // OVERLAP ZONES — Glow highlights on members
    // ─────────────────────────────────────────────────────────────────────────
    overlaps.forEach((r) => {
        if (r.loaded_length <= 0) return;

        const ox = tx(r.overlap_start_global);
        const ow = r.loaded_length * scale;

        // Glow effect (larger blurred rect behind)
        ctx.fillStyle = 'rgba(0,212,255,0.06)';
        ctx.fillRect(ox - 2, memberY - 2, ow + 4, memberZoneH + 4);

        // Overlap highlight
        ctx.fillStyle = COL.overlap;
        ctx.fillRect(ox, memberY, ow, memberZoneH);

        // Dashed border
        ctx.strokeStyle = COL.overlapBorder;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(ox, memberY, ow, memberZoneH);
        ctx.setLineDash([]);

        // Intensity badge at bottom of overlap
        if (ow > 35) {
            const badgeW = Math.min(ow - 4, 70);
            const badgeX = ox + (ow - badgeW) / 2;
            const badgeY = memberY + memberZoneH - 16;

            ctx.fillStyle = 'rgba(0,212,255,0.15)';
            roundRect(ctx, badgeX, badgeY, badgeW, 14, 3);
            ctx.fill();

            ctx.font = '600 8px JetBrains Mono, monospace';
            ctx.fillStyle = COL.accent;
            ctx.textAlign = 'center';
            ctx.fillText(`${r.intensity} kN/m`, ox + ow / 2, badgeY + 10);
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // d1/d2 DIMENSION LINES — with bracket end-caps & leader lines
    // ─────────────────────────────────────────────────────────────────────────
    const processedMembers = new Set();

    overlaps.forEach((r, idx) => {
        if (r.loaded_length <= 0) return;

        const mem = members.find(m => m.id === r.member_id || String(m.id) === String(r.member_id));
        if (!mem) return;

        const memKey = r.member_id + '_' + r.load_id;
        if (processedMembers.has(memKey)) return;
        processedMembers.add(memKey);

        const memX = tx(mem.start);
        const memEndX = tx(mem.end);
        const memW = memEndX - memX;

        // Stagger vertically to avoid overlapping labels
        const staggerRow = idx % 3;
        const annY = d1d2Y + staggerRow * 18;

        // Leader lines down from member to d1/d2 zone
        ctx.strokeStyle = COL.d1d2Muted;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 3]);
        // Left leader
        ctx.beginPath();
        ctx.moveTo(memX, memberY + memberZoneH);
        ctx.lineTo(memX, annY + 4);
        ctx.stroke();
        // Right leader
        ctx.beginPath();
        ctx.moveTo(memEndX, memberY + memberZoneH);
        ctx.lineTo(memEndX, annY + 4);
        ctx.stroke();
        ctx.setLineDash([]);

        const d1Px = r.front_distance * scale;
        const d2Px = r.back_distance * scale;

        // d1 dimension line
        if (d1Px > 5) {
            drawDimensionLine(ctx, memX, memX + d1Px, annY, `d1=${r.front_distance}`, COL.d1d2);
        }

        // d2 dimension line
        if (d2Px > 5 && d2Px !== d1Px) {
            drawDimensionLine(ctx, memX, memX + d2Px, annY + 10, `d2=${r.back_distance}`, COL.d1d2Muted);
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // DISTANCE AXIS — with major/minor ticks
    // ─────────────────────────────────────────────────────────────────────────
    // Axis line
    ctx.strokeStyle = COL.dim;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(tx(0), axisY);
    ctx.lineTo(tx(totalWidth), axisY);
    ctx.stroke();

    const tickInterval = totalWidth <= 5 ? 0.5 : totalWidth <= 12 ? 1 : 2;
    const minorTickInterval = tickInterval / 2;

    // Minor ticks
    ctx.strokeStyle = COL.muted;
    ctx.lineWidth = 0.5;
    for (let t = 0; t <= totalWidth + 0.001; t += minorTickInterval) {
        const x = tx(t);
        ctx.beginPath();
        ctx.moveTo(x, axisY - 2);
        ctx.lineTo(x, axisY + 2);
        ctx.stroke();
    }

    // Major ticks + labels
    ctx.strokeStyle = COL.dimLight;
    ctx.lineWidth = 1;
    ctx.font = '500 10px JetBrains Mono, monospace';
    ctx.fillStyle = COL.dimLight;
    ctx.textAlign = 'center';

    for (let t = 0; t <= totalWidth + 0.001; t += tickInterval) {
        const x = tx(t);
        ctx.beginPath();
        ctx.moveTo(x, axisY - 5);
        ctx.lineTo(x, axisY + 5);
        ctx.stroke();
        ctx.fillText(t.toFixed(1), x, axisY + 20);
    }

    // Axis label
    ctx.font = '400 10px Inter, system-ui, sans-serif';
    ctx.fillStyle = COL.muted;
    ctx.fillText('← Distance along bridge width (m) →', W / 2, axisY + 38);
}


// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

/**
 * Draw a pressure distribution arrow (small downward arrow)
 */
function drawPressureArrow(ctx, x1, y1, x2, y2, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const headLen = 3.5;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - 0.5), y2 - headLen * Math.sin(angle - 0.5));
    ctx.lineTo(x2 - headLen * Math.cos(angle + 0.5), y2 - headLen * Math.sin(angle + 0.5));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
}

/**
 * Draw arrow for legacy support (used by old visualization.js)
 */
function drawArrow(ctx, x1, y1, x2, y2, color) {
    drawPressureArrow(ctx, x1, y1, x2, y2, color);
}

/**
 * Draw a proper dimension line with bracket end-caps and centered label
 */
function drawDimensionLine(ctx, x1, x2, y, label, color) {
    const bracketH = 5;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);

    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Left bracket
    ctx.beginPath();
    ctx.moveTo(x1, y - bracketH);
    ctx.lineTo(x1, y + bracketH);
    ctx.stroke();

    // Right bracket
    ctx.beginPath();
    ctx.moveTo(x2, y - bracketH);
    ctx.lineTo(x2, y + bracketH);
    ctx.stroke();

    // Label
    const midX = (x1 + x2) / 2;
    const labelW = ctx.measureText(label).width + 6;

    // Label background
    ctx.fillStyle = '#0b0f19';
    ctx.fillRect(midX - labelW / 2, y - 6, labelW, 12);

    ctx.font = 'bold 8px JetBrains Mono, monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(label, midX, y + 3);
}

/**
 * Draw support triangle at bottom of members
 */
function drawSupportTriangle(ctx, x, y, color) {
    const s = 6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - s, y + s * 1.3);
    ctx.lineTo(x + s, y + s * 1.3);
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.stroke();
}

/**
 * Darken / lighten a hex color
 */
function shadeColor(color, percent) {
    const num = parseInt(color.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.max(0, Math.min(255, (num >> 16) + amt));
    const G = Math.max(0, Math.min(255, ((num >> 8) & 0x00FF) + amt));
    const B = Math.max(0, Math.min(255, (num & 0x0000FF) + amt));
    return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
}
