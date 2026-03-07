/**
 * STAAD.Pro-style 2D Frame Visualization for Box Culvert.
 *
 * Renders joints, members, supports, loads, dimensions,
 * and annotations on a Canvas element — resembling the
 * STAAD.Pro viewport rendering.
 */

const StaadViz = (() => {

    // ── Colors (STAAD.Pro-like dark theme) ──
    const C = {
        bg: '#0d1117',
        grid: '#161b22',
        gridLine: '#21262d',
        member: '#4ade80',    // green members
        joint: '#00d4ff',    // cyan joints
        jointFill: '#0d1117',
        support: '#facc15',    // yellow supports
        loadDL: '#f87171',    // red - gravity loads
        loadEP: '#818cf8',    // purple - earth pressure
        loadWP: '#38bdf8',    // blue - water pressure
        dim: '#9ca3af',    // gray dimensions
        text: '#e5e7eb',
        textMuted: '#6b7280',
        accent: '#00d4ff',
        title: '#f9fafb',
    };

    // ── Main render function ──
    function render(canvasId, params) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        // High-DPI support
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        const W = rect.width;
        const H = rect.height;

        // Parse parameters
        const cs = params.clear_span || 4.0;
        const ch = params.clear_height || 3.0;
        const tw = params.wall_thickness || 0.3;
        const ts = params.top_slab || 0.3;
        const bs = params.bottom_slab || 0.35;
        const nc = params.num_cells || 1;
        const fd = params.fill_depth || 0;
        const fck = params.fck || 30;

        const totalW = nc * cs + (nc + 1) * tw;
        const totalH = ch + ts + bs;

        // ── Coordinate mapping ──
        const margin = { top: 80, right: 80, bottom: 80, left: 80 };
        const drawW = W - margin.left - margin.right;
        const drawH = H - margin.top - margin.bottom;

        // Scale to fit, maintaining aspect ratio
        const scaleX = drawW / (totalW + 2.0); // extra space for loads/dims
        const scaleY = drawH / (totalH + 2.0);
        const scale = Math.min(scaleX, scaleY);

        const offsetX = margin.left + (drawW - totalW * scale) / 2 + 0.5 * scale;
        const offsetY = margin.top + 0.5 * scale;

        function tx(x) { return offsetX + x * scale; }
        function ty(y) { return offsetY + (totalH - y) * scale; } // flip Y

        // ── Draw background and grid ──
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, W, H);

        // Draw subtle grid
        ctx.strokeStyle = C.gridLine;
        ctx.lineWidth = 0.5;
        const gridStep = 0.5;
        for (let gx = 0; gx <= totalW + 1; gx += gridStep) {
            ctx.beginPath();
            ctx.moveTo(tx(gx - 0.5), ty(-0.5));
            ctx.lineTo(tx(gx - 0.5), ty(totalH + 0.5));
            ctx.stroke();
        }
        for (let gy = -0.5; gy <= totalH + 1; gy += gridStep) {
            ctx.beginPath();
            ctx.moveTo(tx(-0.5), ty(gy));
            ctx.lineTo(tx(totalW + 0.5), ty(gy));
            ctx.stroke();
        }

        // ── Define joints ──
        const joints = [];
        let jid = 1;

        // Bottom joints (left to right)
        for (let c = 0; c <= nc; c++) {
            const x_outer_left = c * (cs + tw);
            const x_inner = x_outer_left + (c === 0 ? 0 : 0);
            joints.push({ id: jid++, x: x_outer_left, y: 0, label: 'B' });
            joints.push({ id: jid++, x: x_outer_left + tw, y: 0, label: 'B' });
        }

        // Top joints (left to right)
        for (let c = 0; c <= nc; c++) {
            const x_outer_left = c * (cs + tw);
            joints.push({ id: jid++, x: x_outer_left, y: bs + ch, label: 'T' });
            joints.push({ id: jid++, x: x_outer_left + tw, y: bs + ch, label: 'T' });
        }

        // ── Define members ──
        const members = [];
        let mid = 1;

        // Bottom slab members
        for (let c = 0; c < nc; c++) {
            const j1 = 1 + c * 2 + 1; // right of wall c
            const j2 = 1 + (c + 1) * 2; // left of wall c+1
            members.push({
                id: mid++,
                j1: joints[j1],
                j2: joints[j2 - 1] || joints[j2],
                group: 'BOTTOM_SLAB',
                thickness: bs,
            });
        }

        // Wall members (vertical)
        const bottomCount = (nc + 1) * 2;
        for (let c = 0; c <= nc; c++) {
            // Left face of wall c — bottom to top
            const bj = c * 2; // bottom joint index
            const tj = bottomCount + c * 2; // top joint index
            members.push({
                id: mid++,
                j1: joints[bj],
                j2: joints[tj],
                group: c === 0 ? 'LEFT_WALL' : (c === nc ? 'RIGHT_WALL' : 'MID_WALL'),
                thickness: tw,
            });
            // Right face
            members.push({
                id: mid++,
                j1: joints[bj + 1],
                j2: joints[tj + 1],
                group: c === 0 ? 'LEFT_WALL' : (c === nc ? 'RIGHT_WALL' : 'MID_WALL'),
                thickness: tw,
            });
        }

        // Top slab members
        for (let c = 0; c < nc; c++) {
            const j1 = bottomCount + c * 2 + 1;
            const j2 = bottomCount + (c + 1) * 2;
            members.push({
                id: mid++,
                j1: joints[j1],
                j2: joints[j2 - 1] || joints[j2],
                group: 'TOP_SLAB',
                thickness: ts,
            });
        }

        // ── Draw filled structure (concrete appearance) ──
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = C.member;

        // Bottom slab fill
        ctx.fillRect(tx(0), ty(bs), totalW * scale, bs * scale);
        // Top slab fill
        ctx.fillRect(tx(0), ty(bs + ch + ts), totalW * scale, ts * scale);
        // Wall fills
        for (let c = 0; c <= nc; c++) {
            const wx = c * (cs + tw);
            ctx.fillRect(tx(wx), ty(bs + ch), tw * scale, ch * scale);
        }

        ctx.globalAlpha = 1.0;

        // ── Draw member outlines ──
        ctx.strokeStyle = C.member;
        ctx.lineWidth = 2.5;

        // Bottom slab outline
        ctx.strokeRect(tx(0), ty(bs), totalW * scale, bs * scale);
        // Top slab outline
        ctx.strokeRect(tx(0), ty(bs + ch + ts), totalW * scale, ts * scale);
        // Walls
        for (let c = 0; c <= nc; c++) {
            const wx = c * (cs + tw);
            ctx.strokeRect(tx(wx), ty(bs + ch), tw * scale, ch * scale);
        }

        // ── Draw member labels ──
        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillStyle = '#22c55e';

        // Bottom slab label
        ctx.textAlign = 'center';
        ctx.fillText(`Bottom Slab (${bs * 1000}mm)`, tx(totalW / 2), ty(bs / 2) + 4);

        // Top slab label
        ctx.fillText(`Top Slab (${ts * 1000}mm)`, tx(totalW / 2), ty(bs + ch + ts / 2) + 4);

        // Wall labels
        ctx.save();
        ctx.translate(tx(-tw / 2 - 0.15), ty(bs + ch / 2));
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(`Left Wall (${tw * 1000}mm)`, 0, 0);
        ctx.restore();

        ctx.save();
        ctx.translate(tx(totalW + tw / 2 + 0.15), ty(bs + ch / 2));
        ctx.rotate(Math.PI / 2);
        ctx.fillText(`Right Wall (${tw * 1000}mm)`, 0, 0);
        ctx.restore();

        // Middle wall labels
        for (let c = 1; c < nc; c++) {
            const wx = c * (cs + tw) + tw / 2;
            ctx.save();
            ctx.translate(tx(wx), ty(bs + ch / 2));
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(`Mid Wall ${c}`, 0, 0);
            ctx.restore();
        }

        // ── Draw joints ──
        const mainJoints = [];
        // 4 corner joints for single cell
        mainJoints.push({ id: 1, x: 0, y: 0 });
        mainJoints.push({ id: 2, x: totalW, y: 0 });
        mainJoints.push({ id: 3, x: 0, y: totalH });
        mainJoints.push({ id: 4, x: totalW, y: totalH });

        // Inner corners
        mainJoints.push({ id: 5, x: tw, y: bs });
        mainJoints.push({ id: 6, x: totalW - tw, y: bs });
        mainJoints.push({ id: 7, x: tw, y: bs + ch });
        mainJoints.push({ id: 8, x: totalW - tw, y: bs + ch });

        // Middle wall joints
        for (let c = 1; c < nc; c++) {
            const wx = c * (cs + tw);
            mainJoints.push({ id: 8 + c * 4 - 3, x: wx, y: bs });
            mainJoints.push({ id: 8 + c * 4 - 2, x: wx + tw, y: bs });
            mainJoints.push({ id: 8 + c * 4 - 1, x: wx, y: bs + ch });
            mainJoints.push({ id: 8 + c * 4, x: wx + tw, y: bs + ch });
        }

        mainJoints.forEach(j => {
            ctx.beginPath();
            ctx.arc(tx(j.x), ty(j.y), 5, 0, Math.PI * 2);
            ctx.fillStyle = C.jointFill;
            ctx.fill();
            ctx.strokeStyle = C.joint;
            ctx.lineWidth = 2;
            ctx.stroke();

            // Joint number
            ctx.font = 'bold 10px JetBrains Mono, monospace';
            ctx.fillStyle = C.joint;
            ctx.textAlign = 'center';
            ctx.fillText(j.id, tx(j.x), ty(j.y) - 10);
        });

        // ── Draw supports (triangles at bottom) ──
        function drawSupport(x, y) {
            const sx = tx(x);
            const sy = ty(y);
            const sz = 12;

            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx - sz, sy + sz * 1.4);
            ctx.lineTo(sx + sz, sy + sz * 1.4);
            ctx.closePath();
            ctx.strokeStyle = C.support;
            ctx.lineWidth = 2;
            ctx.stroke();

            // Ground hatching
            ctx.beginPath();
            for (let i = -sz; i <= sz; i += 5) {
                ctx.moveTo(sx + i, sy + sz * 1.4);
                ctx.lineTo(sx + i - 5, sy + sz * 1.4 + 7);
            }
            ctx.strokeStyle = C.support;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        drawSupport(0, 0);
        drawSupport(totalW, 0);
        for (let c = 1; c < nc; c++) {
            drawSupport(c * (cs + tw), 0);
            drawSupport(c * (cs + tw) + tw, 0);
        }

        // ── Draw loads ──

        // DL + LL arrows on top slab (downward, red)
        const numArrows = Math.max(8, Math.floor(totalW / 0.4));
        ctx.strokeStyle = C.loadDL;
        ctx.fillStyle = C.loadDL;
        ctx.lineWidth = 1.5;
        const arrowTop = totalH + 0.6;

        for (let i = 0; i <= numArrows; i++) {
            const ax = (i / numArrows) * totalW;
            const startY = arrowTop;
            const endY = totalH;

            ctx.beginPath();
            ctx.moveTo(tx(ax), ty(startY));
            ctx.lineTo(tx(ax), ty(endY));
            ctx.stroke();

            // Arrowhead
            const ahx = tx(ax);
            const ahy = ty(endY);
            ctx.beginPath();
            ctx.moveTo(ahx, ahy);
            ctx.lineTo(ahx - 3, ahy - 8);
            ctx.lineTo(ahx + 3, ahy - 8);
            ctx.closePath();
            ctx.fill();
        }

        // Top load line
        ctx.beginPath();
        ctx.moveTo(tx(0), ty(arrowTop));
        ctx.lineTo(tx(totalW), ty(arrowTop));
        ctx.stroke();

        // Load label
        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillStyle = C.loadDL;
        ctx.textAlign = 'center';
        ctx.fillText('DL + LL + SIDL (Gravity Loads) ↓', tx(totalW / 2), ty(arrowTop + 0.3));

        // Earth pressure on left wall (triangular, pointing right)
        ctx.strokeStyle = C.loadEP;
        ctx.fillStyle = C.loadEP;
        ctx.lineWidth = 1.5;

        const epSteps = 8;
        for (let i = 0; i <= epSteps; i++) {
            const frac = i / epSteps;
            const wy = bs + ch * (1 - frac); // from top to bottom
            const arrowLen = frac * 0.8; // triangular: 0 at top, max at bottom

            if (arrowLen > 0.05) {
                ctx.beginPath();
                ctx.moveTo(tx(-arrowLen), ty(wy));
                ctx.lineTo(tx(0), ty(wy));
                ctx.stroke();

                // Arrowhead
                const ahx = tx(0);
                const ahy = ty(wy);
                ctx.beginPath();
                ctx.moveTo(ahx, ahy);
                ctx.lineTo(ahx - 8, ahy - 3);
                ctx.lineTo(ahx - 8, ahy + 3);
                ctx.closePath();
                ctx.fill();
            }
        }

        // EP triangle outline
        ctx.beginPath();
        ctx.moveTo(tx(0), ty(bs + ch));
        ctx.lineTo(tx(-0.8), ty(bs));
        ctx.lineTo(tx(0), ty(bs));
        ctx.strokeStyle = C.loadEP;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.font = '600 10px Inter, sans-serif';
        ctx.fillStyle = C.loadEP;
        ctx.textAlign = 'right';
        ctx.fillText('EP', tx(-0.9), ty(bs + ch / 2) + 4);
        ctx.font = '500 9px Inter, sans-serif';
        ctx.fillText('K₀γH', tx(-0.9), ty(bs + ch / 2) + 16);

        // Earth pressure on right wall (pointing left)
        for (let i = 0; i <= epSteps; i++) {
            const frac = i / epSteps;
            const wy = bs + ch * (1 - frac);
            const arrowLen = frac * 0.8;

            if (arrowLen > 0.05) {
                ctx.beginPath();
                ctx.moveTo(tx(totalW + arrowLen), ty(wy));
                ctx.lineTo(tx(totalW), ty(wy));
                ctx.stroke();

                const ahx = tx(totalW);
                const ahy = ty(wy);
                ctx.beginPath();
                ctx.moveTo(ahx, ahy);
                ctx.lineTo(ahx + 8, ahy - 3);
                ctx.lineTo(ahx + 8, ahy + 3);
                ctx.closePath();
                ctx.fill();
            }
        }

        // Right EP triangle outline
        ctx.beginPath();
        ctx.moveTo(tx(totalW), ty(bs + ch));
        ctx.lineTo(tx(totalW + 0.8), ty(bs));
        ctx.lineTo(tx(totalW), ty(bs));
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.font = '600 10px Inter, sans-serif';
        ctx.fillText('EP', tx(totalW + 0.9), ty(bs + ch / 2) + 4);

        // Water pressure on bottom slab (upward, blue)
        ctx.strokeStyle = C.loadWP;
        ctx.fillStyle = C.loadWP;
        ctx.lineWidth = 1;

        const wpArrows = Math.max(6, Math.floor(totalW / 0.6));
        for (let i = 0; i <= wpArrows; i++) {
            const ax = tw + (i / wpArrows) * (totalW - 2 * tw);
            ctx.beginPath();
            ctx.moveTo(tx(ax), ty(-0.4));
            ctx.lineTo(tx(ax), ty(0));
            ctx.stroke();

            const ahx = tx(ax);
            const ahy = ty(0);
            ctx.beginPath();
            ctx.moveTo(ahx, ahy);
            ctx.lineTo(ahx - 3, ahy + 8);
            ctx.lineTo(ahx + 3, ahy + 8);
            ctx.closePath();
            ctx.fill();
        }

        ctx.beginPath();
        ctx.moveTo(tx(tw), ty(-0.4));
        ctx.lineTo(tx(totalW - tw), ty(-0.4));
        ctx.stroke();

        ctx.font = '500 9px Inter, sans-serif';
        ctx.fillStyle = C.loadWP;
        ctx.textAlign = 'center';
        ctx.fillText('Water Pressure ↑ (γw × Hw)', tx(totalW / 2), ty(-0.55));

        // ── Dimension lines ──
        ctx.strokeStyle = C.dim;
        ctx.fillStyle = C.dim;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);

        // Horizontal: clear span
        const dimY = -1.2;
        for (let c = 0; c < nc; c++) {
            const x1 = c * (cs + tw) + tw;
            const x2 = x1 + cs;

            ctx.beginPath();
            ctx.moveTo(tx(x1), ty(dimY));
            ctx.lineTo(tx(x2), ty(dimY));
            ctx.stroke();

            // Tick marks
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(tx(x1), ty(dimY - 0.1));
            ctx.lineTo(tx(x1), ty(dimY + 0.1));
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(tx(x2), ty(dimY - 0.1));
            ctx.lineTo(tx(x2), ty(dimY + 0.1));
            ctx.stroke();

            ctx.font = '600 11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`${cs}m clear`, tx((x1 + x2) / 2), ty(dimY) + 15);
            ctx.setLineDash([4, 3]);
        }

        // Vertical: clear height
        const dimX = totalW + 1.3;
        ctx.beginPath();
        ctx.moveTo(tx(dimX), ty(bs));
        ctx.lineTo(tx(dimX), ty(bs + ch));
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(tx(dimX - 0.1), ty(bs));
        ctx.lineTo(tx(dimX + 0.1), ty(bs));
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tx(dimX - 0.1), ty(bs + ch));
        ctx.lineTo(tx(dimX + 0.1), ty(bs + ch));
        ctx.stroke();

        ctx.save();
        ctx.translate(tx(dimX + 0.2), ty(bs + ch / 2));
        ctx.rotate(-Math.PI / 2);
        ctx.font = '600 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${ch}m clear height`, 0, 0);
        ctx.restore();

        // Total width dimension
        ctx.setLineDash([4, 3]);
        const dimY2 = totalH + 1.2;
        ctx.beginPath();
        ctx.moveTo(tx(0), ty(dimY2));
        ctx.lineTo(tx(totalW), ty(dimY2));
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(tx(0), ty(dimY2 - 0.1));
        ctx.lineTo(tx(0), ty(dimY2 + 0.1));
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tx(totalW), ty(dimY2 - 0.1));
        ctx.lineTo(tx(totalW), ty(dimY2 + 0.1));
        ctx.stroke();

        ctx.font = '600 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${totalW.toFixed(1)}m total width`, tx(totalW / 2), ty(dimY2 + 0.2));

        ctx.setLineDash([]);

        // ── Title ──
        ctx.font = '700 15px Inter, sans-serif';
        ctx.fillStyle = C.title;
        ctx.textAlign = 'center';
        ctx.fillText('STAAD.Pro — Box Culvert 2D Frame Model', W / 2, 24);

        // Subtitle
        ctx.font = '500 11px Inter, sans-serif';
        ctx.fillStyle = C.textMuted;
        ctx.fillText(
            `${nc}-Cell  |  M${fck} Concrete  |  Fe500 Steel  |  Fill: ${fd}m`,
            W / 2, 42
        );

        // ── Legend ──
        const legendX = 16;
        let legendY = H - 60;
        ctx.font = '500 10px Inter, sans-serif';
        ctx.textAlign = 'left';

        const legendItems = [
            { color: C.member, label: 'Concrete Members' },
            { color: C.joint, label: 'Joints / Nodes' },
            { color: C.support, label: 'Fixed Supports' },
            { color: C.loadDL, label: 'Gravity Loads (DL+LL)' },
            { color: C.loadEP, label: 'Earth Pressure' },
            { color: C.loadWP, label: 'Water Pressure' },
        ];

        legendItems.forEach((item, i) => {
            const lx = legendX + (i % 3) * 160;
            const ly = legendY + Math.floor(i / 3) * 18;
            ctx.fillStyle = item.color;
            ctx.fillRect(lx, ly, 12, 10);
            ctx.fillStyle = C.text;
            ctx.fillText(item.label, lx + 18, ly + 9);
        });

        // ── Member numbering (STAAD member IDs) ──
        ctx.font = 'bold 11px JetBrains Mono, monospace';
        ctx.fillStyle = '#fbbf24';
        ctx.textAlign = 'center';

        // Bottom slab member ID
        ctx.fillText('M1', tx(totalW / 2), ty(bs / 2) - 10);

        // Left wall member ID
        ctx.save();
        ctx.translate(tx(tw / 2), ty(bs + ch / 2));
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('M2', 0, -12);
        ctx.restore();

        // Right wall member ID
        ctx.save();
        ctx.translate(tx(totalW - tw / 2), ty(bs + ch / 2));
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('M3', 0, -12);
        ctx.restore();

        // Top slab member ID
        ctx.fillText('M4', tx(totalW / 2), ty(bs + ch + ts / 2) - 10);

        // Middle walls
        for (let c = 1; c < nc; c++) {
            const wx = c * (cs + tw) + tw / 2;
            ctx.save();
            ctx.translate(tx(wx), ty(bs + ch / 2));
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(`M${c + 3}`, 0, -12);
            ctx.restore();
        }

        // ── Haunch indicators (small triangles at corners) ──
        ctx.fillStyle = 'rgba(74, 222, 128, 0.3)';
        const hz = 0.15; // haunch size

        // Inner corners
        const corners = [
            { x: tw, y: bs, dx: 1, dy: 1 },
            { x: totalW - tw, y: bs, dx: -1, dy: 1 },
            { x: tw, y: bs + ch, dx: 1, dy: -1 },
            { x: totalW - tw, y: bs + ch, dx: -1, dy: -1 },
        ];

        corners.forEach(c => {
            ctx.beginPath();
            ctx.moveTo(tx(c.x), ty(c.y));
            ctx.lineTo(tx(c.x + c.dx * hz), ty(c.y));
            ctx.lineTo(tx(c.x), ty(c.y + c.dy * hz));
            ctx.closePath();
            ctx.fill();
        });

        // ── Support type label ──
        ctx.font = '500 9px Inter, sans-serif';
        ctx.fillStyle = C.support;
        ctx.textAlign = 'center';
        ctx.fillText('FIXED (MZ released)', tx(totalW / 2), ty(-1.6));
    }

    return { render };
})();


/**
 * Render the STAAD visualization from current Smart Tools inputs.
 */
function renderStaadVisualization() {
    const params = {
        clear_span: parseFloat(document.getElementById('std-span')?.value || '4.0'),
        clear_height: parseFloat(document.getElementById('std-height')?.value || '3.0'),
        wall_thickness: parseFloat(document.getElementById('std-wall')?.value || '0.3'),
        top_slab: parseFloat(document.getElementById('std-top')?.value || '0.3'),
        bottom_slab: parseFloat(document.getElementById('std-bot')?.value || '0.35'),
        num_cells: parseInt(document.getElementById('std-cells')?.value || '1'),
        fill_depth: parseFloat(document.getElementById('if-fill')?.value || '0'),
        fck: parseFloat(document.getElementById('std-fck')?.value || '30'),
    };

    document.getElementById('staad-viz-container').style.display = 'block';
    // Small delay to let display:block take effect
    setTimeout(() => StaadViz.render('staad-viz-canvas', params), 50);
}
