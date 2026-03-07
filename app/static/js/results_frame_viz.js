/**
 * Results Frame Visualization — STAAD.Pro-style
 *
 * Renders the bridge cross-section / box culvert frame
 * with actual calculated loads, member strips, overlap zones,
 * d1/d2 annotations, intensities, and STAAD member IDs.
 *
 * Called after each calculation with real data.
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
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;

    // ── Colors ──
    const COL = {
        bg: '#0d1117',
        grid: '#161b22',
        gridLine: '#21262d',
        member: '#22c55e',
        memberFill: 'rgba(34,197,94,0.10)',
        joint: '#00d4ff',
        loadFill: 'rgba(248,113,113,0.25)',
        loadStroke: 'rgba(248,113,113,0.7)',
        loadArrow: '#f87171',
        overlap: 'rgba(0,212,255,0.25)',
        overlapBr: 'rgba(0,212,255,0.6)',
        d1d2: '#facc15',
        dim: '#6b7280',
        text: '#e5e7eb',
        muted: '#4b5563',
        accent: '#00d4ff',
        title: '#f9fafb',
    };

    // ── Layout ──
    const totalWidth = settings.total_width || 8.5;
    const margin = { top: 100, right: 40, bottom: 80, left: 55 };
    const drawW = W - margin.left - margin.right;
    const scale = drawW / totalWidth;

    // Vertical sections
    const loadZoneH = 100;   // Area for load patches
    const memberZoneH = 70;  // Area for member strips
    const overlapZoneH = 50; // Area for overlap detail
    const totalNeeded = margin.top + loadZoneH + 20 + memberZoneH + 20 + overlapZoneH + margin.bottom;

    function tx(x) { return margin.left + x * scale; }

    // ── Clear & Background ──
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);

    // Grid
    const gridStep = totalWidth <= 5 ? 0.25 : totalWidth <= 15 ? 0.5 : 1.0;
    ctx.strokeStyle = COL.gridLine;
    ctx.lineWidth = 0.5;
    for (let gx = 0; gx <= totalWidth; gx += gridStep) {
        ctx.beginPath();
        ctx.moveTo(tx(gx), margin.top - 30);
        ctx.lineTo(tx(gx), H - margin.bottom + 30);
        ctx.stroke();
    }

    // ── Title ──
    ctx.font = '700 14px Inter, sans-serif';
    ctx.fillStyle = COL.title;
    ctx.textAlign = 'center';
    ctx.fillText('STAAD.Pro Model — Load-Member Overlap Results', W / 2, 22);

    ctx.font = '500 11px Inter, sans-serif';
    ctx.fillStyle = COL.muted;
    ctx.fillText(
        `${settings.project_name || 'Project'}  |  Width: ${totalWidth}m  |  ${members.length} Members  |  ${loads.length} Loads  |  ${overlaps.length} Overlaps`,
        W / 2, 40
    );

    // ── Section Labels ──
    ctx.font = '600 10px Inter, sans-serif';
    ctx.textAlign = 'right';

    const loadY = margin.top;
    const memberY = margin.top + loadZoneH + 20;
    const overlapY = memberY + memberZoneH + 20;

    ctx.fillStyle = COL.loadArrow;
    ctx.fillText('LOADS', margin.left - 8, loadY + 15);

    ctx.fillStyle = COL.member;
    ctx.fillText('MEMBERS', margin.left - 8, memberY + 15);

    ctx.fillStyle = COL.accent;
    ctx.fillText('d1/d2', margin.left - 8, overlapY + 15);

    // ── Draw Loads (positioned above member zone) ──
    const loadColors = [
        'rgba(248,113,113, 0.4)', 'rgba(99,102,241, 0.4)', 'rgba(16,185,129, 0.4)',
        'rgba(245,158,11, 0.4)', 'rgba(236,72,153, 0.4)', 'rgba(56,189,248, 0.4)',
    ];
    const loadStrokeColors = [
        '#f87171', '#6366f1', '#10b981', '#f59e0b', '#ec4899', '#38bdf8',
    ];

    const loadBarH = Math.min(22, (loadZoneH - 10) / Math.max(loads.length, 1));

    loads.forEach((lo, i) => {
        const x1 = tx(Math.max(0, lo.start));
        const x2 = tx(Math.min(totalWidth, lo.end));
        const w = x2 - x1;
        const y = loadY + i * (loadBarH + 3);
        const color = loadColors[i % loadColors.length];
        const sColor = loadStrokeColors[i % loadStrokeColors.length];

        // Load bar
        ctx.fillStyle = color;
        ctx.strokeStyle = sColor;
        ctx.lineWidth = 1.5;
        roundRect(ctx, x1, y, w, loadBarH, 3);
        ctx.fill();
        ctx.stroke();

        // Down arrows
        ctx.fillStyle = sColor;
        const numArrows = Math.max(3, Math.floor(w / 25));
        for (let a = 0; a < numArrows; a++) {
            const ax = x1 + ((a + 0.5) / numArrows) * w;
            drawArrow(ctx, ax, y + 2, ax, y + loadBarH - 2, sColor);
        }

        // Load label
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.fillStyle = COL.text;
        ctx.textAlign = 'left';
        if (w > 40) {
            ctx.fillText(`${lo.id}`, x1 + 4, y + loadBarH / 2 + 3);
        }

        // Intensity label
        ctx.textAlign = 'right';
        ctx.font = '500 8px JetBrains Mono, monospace';
        ctx.fillStyle = sColor;
        if (w > 80) {
            ctx.fillText(`${lo.intensity} kN/m`, x2 - 4, y + loadBarH / 2 + 3);
        }
    });

    // ── Draw Members ──
    const memberColors = [
        '#1e3a5f', '#1a4a3f', '#3a2a5f', '#4a2a2a', '#2a3a4a',
        '#2f4858', '#1a3a4a', '#3a3a1a',
    ];

    members.forEach((m, i) => {
        const x = tx(m.start);
        const w = (m.end - m.start) * scale;
        const y = memberY;
        const color = memberColors[i % memberColors.length];

        // Member block
        ctx.fillStyle = color;
        ctx.strokeStyle = COL.member;
        ctx.lineWidth = 1.5;
        roundRect(ctx, x, y, w, memberZoneH, 4);
        ctx.fill();
        ctx.stroke();

        // Member ID
        ctx.font = 'bold 11px JetBrains Mono, monospace';
        ctx.fillStyle = COL.text;
        ctx.textAlign = 'center';
        if (w > 30) {
            ctx.fillText(m.id, x + w / 2, y + 18);
        }

        // Member range
        ctx.font = '500 8px JetBrains Mono, monospace';
        ctx.fillStyle = '#9ca3af';
        if (w > 50) {
            ctx.fillText(`${m.start.toFixed(2)} → ${m.end.toFixed(2)}`, x + w / 2, y + 32);
            ctx.fillText(`L = ${(m.end - m.start).toFixed(2)}m`, x + w / 2, y + 44);
        }

        // Support triangles at member ends
        drawSupportTriangle(ctx, x, y + memberZoneH, COL.d1d2);
        drawSupportTriangle(ctx, x + w, y + memberZoneH, COL.d1d2);
    });

    // ── Draw Overlap Zones & d1/d2 ──
    overlaps.forEach((r, idx) => {
        if (r.loaded_length <= 0) return;

        // Find member for this overlap
        const mem = members.find(m => m.id === r.member_id || m.id === String(r.member_id));
        if (!mem) return;

        // Overlap on member strip
        const ox = tx(r.overlap_start_global);
        const ow = r.loaded_length * scale;

        // Highlight on member
        ctx.fillStyle = COL.overlap;
        ctx.strokeStyle = COL.overlapBr;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.fillRect(ox, memberY, ow, memberZoneH);
        ctx.strokeRect(ox, memberY, ow, memberZoneH);
        ctx.setLineDash([]);

        // d1/d2 annotations below member zone
        const memX = tx(mem.start);
        const d1X = memX + r.front_distance * scale;
        const d2X = memX + r.back_distance * scale;
        const annY = overlapY + (idx % 3) * 16;

        // d1 line
        ctx.strokeStyle = COL.d1d2;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(memX, annY);
        ctx.lineTo(d1X, annY);
        ctx.stroke();

        // d2 line
        ctx.beginPath();
        ctx.moveTo(memX, annY + 4);
        ctx.lineTo(d2X, annY + 4);
        ctx.stroke();
        ctx.setLineDash([]);

        // d1 label
        ctx.font = 'bold 8px JetBrains Mono, monospace';
        ctx.fillStyle = COL.d1d2;
        ctx.textAlign = 'center';
        if (ow > 30) {
            ctx.fillText(`d1=${r.front_distance}`, (memX + d1X) / 2, annY - 3);
            ctx.fillText(`d2=${r.back_distance}`, (memX + d2X) / 2, annY + 14);
        }

        // Intensity annotation on overlap
        ctx.font = '600 8px JetBrains Mono, monospace';
        ctx.fillStyle = COL.accent;
        ctx.textAlign = 'center';
        if (ow > 40) {
            ctx.fillText(`${r.intensity} kN/m`, ox + ow / 2, memberY + memberZoneH - 6);
        }
    });

    // ── Distance Axis ──
    const axisY = H - margin.bottom + 10;
    ctx.strokeStyle = COL.dim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx(0), axisY);
    ctx.lineTo(tx(totalWidth), axisY);
    ctx.stroke();

    // Ticks & labels
    const tickInterval = totalWidth <= 5 ? 0.5 : totalWidth <= 12 ? 1 : 2;
    ctx.font = '500 10px JetBrains Mono, monospace';
    ctx.fillStyle = COL.dim;
    ctx.textAlign = 'center';

    for (let t = 0; t <= totalWidth + 0.001; t += tickInterval) {
        const x = tx(t);
        ctx.beginPath();
        ctx.moveTo(x, axisY - 4);
        ctx.lineTo(x, axisY + 4);
        ctx.stroke();
        ctx.fillText(t.toFixed(1), x, axisY + 18);
    }

    ctx.fillText('← Distance along bridge width (m) →', W / 2, axisY + 36);

    // ── Legend ──
    const legendItems = [
        { color: loadStrokeColors[0], label: 'Load Patches' },
        { color: COL.member, label: 'Members' },
        { color: COL.overlapBr, label: 'Overlap Zones' },
        { color: COL.d1d2, label: 'd1/d2 Distances' },
    ];

    ctx.font = '500 9px Inter, sans-serif';
    const legendStartX = W - 440;

    legendItems.forEach((item, i) => {
        const lx = legendStartX + i * 110;
        const ly = 58;
        ctx.fillStyle = item.color;
        ctx.fillRect(lx, ly, 10, 8);
        ctx.fillStyle = COL.text;
        ctx.textAlign = 'left';
        ctx.fillText(item.label, lx + 14, ly + 8);
    });

    // ── Summary box ──
    const totalLoaded = overlaps.reduce((sum, r) => sum + r.loaded_length, 0);
    const maxInt = Math.max(...overlaps.map(r => Math.abs(r.intensity)));

    ctx.fillStyle = 'rgba(0,212,255,0.08)';
    roundRect(ctx, 12, 50, 200, 36, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,212,255,0.3)';
    ctx.lineWidth = 1;
    roundRect(ctx, 12, 50, 200, 36, 6);
    ctx.stroke();

    ctx.font = '600 9px Inter, sans-serif';
    ctx.fillStyle = COL.accent;
    ctx.textAlign = 'left';
    ctx.fillText(`Overlaps: ${overlaps.length}  |  Max: ${maxInt} kN/m`, 20, 66);
    ctx.fillText(`Total loaded: ${totalLoaded.toFixed(2)}m`, 20, 80);
}

// ── Helper: Rounded Rectangle ──
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

// ── Helper: Small Arrow ──
function drawArrow(ctx, x1, y1, x2, y2, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const headLen = 4;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - 0.4), y2 - headLen * Math.sin(angle - 0.4));
    ctx.lineTo(x2 - headLen * Math.cos(angle + 0.4), y2 - headLen * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
}

// ── Helper: Support Triangle ──
function drawSupportTriangle(ctx, x, y, color) {
    const s = 5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - s, y + s * 1.2);
    ctx.lineTo(x + s, y + s * 1.2);
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
}
