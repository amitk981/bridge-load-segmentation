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
    
    // Attempt to draw the 2D cross-section if applicable
    if (typeof renderGeometry2DCrossSection === 'function') {
        renderGeometry2DCrossSection();
    }
}

// ─── 2D Box Culvert Cross-Section Visualization ─────────────────────────────

function renderGeometry2DCrossSection() {
    const container = document.getElementById('geometry-2d-frame-container');
    const canvas = document.getElementById('geometry-2d-canvas');
    if (!container || !canvas) return;

    const stype = document.getElementById('structure-type')?.value || '';
    if (!stype.startsWith('BOX_CULVERT_')) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    
    // ── Input Parameters ──
    const clearSpan = parseFloat(document.getElementById('clear-span').value) || 4.0;
    const numCells = parseInt(document.getElementById('num-cells').value, 10) || 1;
    const extWall = parseFloat(document.getElementById('wall-thickness').value) || 0.3;
    const intWall = parseFloat(document.getElementById('mid-wall-thickness').value) || 0.3;
    const haunch = parseFloat(document.getElementById('haunch-size').value) || 0.0;
    const clearHt = parseFloat(document.getElementById('culvert-height').value) || 3.0;
    const topThk = parseFloat(document.getElementById('slab-thickness').value) || 0.3;
    const botThk = parseFloat(document.getElementById('bottom-slab-thickness').value) || 0.35;
    
    // Derived Dimensions
    const physicalWidth = numCells * clearSpan + 2 * extWall + Math.max(0, numCells - 1) * intWall;
    const physicalHeight = clearHt + topThk + botThk;
    
    // Environments
    const fillDepth = parseFloat(document.getElementById('disp-fill')?.value || document.getElementById('dc-fill')?.value) || 0;
    const waterTable = parseFloat(document.getElementById('dc-wt')?.value) || 0;
    const hasWater = document.getElementById('dc-wt') ? true : false;
    
    // Setup canvas
    const rect = canvas.parentElement.getBoundingClientRect();
    const W = rect.width - 24; 
    const H = 380; // Taller for more details
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    
    // ── Coordinate Mapping ──
    const margin = { top: fillDepth > 0 ? 80 : 50, right: 80, bottom: 60, left: 80 };
    const viewW = W - margin.left - margin.right;
    const viewH = H - margin.top - margin.bottom;
    
    const scaleX = viewW / physicalWidth;
    const scaleY = viewH / (physicalHeight + fillDepth);
    const scale = Math.min(scaleX, scaleY) * 0.95; // 95% to leave breathing room
    
    const drawW = physicalWidth * scale;
    const drawH = physicalHeight * scale;
    const fillScale = fillDepth * scale;
    
    const offsetX = margin.left + (viewW - drawW) / 2;
    const offsetY = H - margin.bottom - drawH; 
    
    // ── Palettes ──
    const COL = {
        concrete: '#1e293b',
        hatch: 'rgba(255, 255, 255, 0.04)',
        outline: '#38bdf8',
        inner: '#0b0f19', // cell empty space
        dimLine: '#64748b',
        dimText: '#e2e8f0',
        calloutLine: '#94a3b8',
        earth: 'rgba(139, 69, 19, 0.15)',
        earthFill: 'rgba(139, 69, 19, 0.08)',
        water: 'rgba(14, 165, 233, 0.15)',
        waterLine: '#0ea5e9',
        centerline: 'rgba(255,255,255,0.1)'
    };
    
    ctx.save();
    ctx.translate(offsetX, offsetY);
    
    // ════════════════════════════════════════════════════════════════
    // 1. Environment Layers (Earth Fill & Water Table)
    // ════════════════════════════════════════════════════════════════
    if (fillDepth > 0) {
        // Fill box
        ctx.fillStyle = COL.earthFill;
        const fillExt = 40; // Extend beyond edges
        ctx.fillRect(-fillExt, -fillScale, drawW + fillExt * 2, fillScale);
        
        // Ground line (Top)
        ctx.beginPath();
        ctx.moveTo(-fillExt, -fillScale);
        ctx.lineTo(drawW + fillExt, -fillScale);
        ctx.strokeStyle = COL.earth;
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Ground hatch
        ctx.beginPath();
        for (let x = -fillExt; x < drawW + fillExt; x += 15) {
            ctx.moveTo(x, -fillScale);
            ctx.lineTo(x + 5, -fillScale + 5);
        }
        ctx.stroke();
    }
    
    if (hasWater && waterTable > 0) {
        const wtY = Math.max(-fillScale, drawH - (waterTable * scale)); // Measured from bottom
        ctx.beginPath();
        ctx.moveTo(-30, wtY);
        ctx.lineTo(drawW + 30, wtY);
        ctx.strokeStyle = COL.waterLine;
        ctx.setLineDash([10, 5, 2, 5]);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Water symbol
        ctx.beginPath();
        ctx.moveTo(-20, wtY);
        ctx.lineTo(-15, wtY - 8);
        ctx.lineTo(-10, wtY);
        ctx.lineTo(-25, wtY);
        ctx.fillStyle = COL.waterLine;
        ctx.fill();
    }
    
    // ════════════════════════════════════════════════════════════════
    // 2. Concrete Geometry
    // ════════════════════════════════════════════════════════════════
    // Base solid
    ctx.fillStyle = COL.concrete;
    ctx.fillRect(0, 0, drawW, drawH);
    
    // Architectural hatching
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, drawW, drawH);
    ctx.clip();
    ctx.beginPath();
    for (let i = -drawH; i < drawW + drawH; i += 12) {
        ctx.moveTo(i, 0);
        ctx.lineTo(i - drawH, drawH);
    }
    ctx.strokeStyle = COL.hatch;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    
    // Punch cells
    ctx.fillStyle = COL.inner;
    let cx = extWall * scale;
    const cy = topThk * scale;
    const cellW = clearSpan * scale;
    const cellH = clearHt * scale;
    const hScale = haunch * scale;
    
    const cellCenters = [];
    
    for (let c = 0; c < numCells; c++) {
        // Draw void
        ctx.beginPath();
        ctx.moveTo(cx + hScale, cy);
        ctx.lineTo(cx + cellW - hScale, cy);
        ctx.lineTo(cx + cellW, cy + hScale);
        ctx.lineTo(cx + cellW, cy + cellH - hScale);
        ctx.lineTo(cx + cellW - hScale, cy + cellH);
        ctx.lineTo(cx + hScale, cy + cellH);
        ctx.lineTo(cx, cy + cellH - hScale);
        ctx.lineTo(cx, cy + hScale);
        ctx.closePath();
        ctx.fill();
        
        ctx.strokeStyle = COL.outline;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        
        cellCenters.push({ x: cx + cellW / 2, y: cy + cellH / 2 });
        cx += cellW + (intWall * scale);
    }
    
    // Outer border
    ctx.strokeStyle = COL.outline;
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, drawW, drawH);
    
    // ════════════════════════════════════════════════════════════════
    // 3. Centerlines
    // ════════════════════════════════════════════════════════════════
    ctx.strokeStyle = COL.centerline;
    ctx.lineWidth = 1;
    ctx.setLineDash([15, 5, 3, 5]);
    
    // Vertical Centerlines for Walls
    const wallCenters = [(extWall * scale) / 2];
    for (let c = 1; c < numCells; c++) {
        wallCenters.push((extWall * scale) + c * cellW + c * (intWall * scale) - (intWall*scale)/2);
    }
    wallCenters.push(drawW - (extWall * scale) / 2);
    
    for (const wx of wallCenters) {
        ctx.beginPath();
        ctx.moveTo(wx, -15);
        ctx.lineTo(wx, drawH + 15);
        ctx.stroke();
    }
    
    // Horizontal Centerlines for Slabs
    ctx.beginPath();
    ctx.moveTo(-15, (topThk * scale) / 2);
    ctx.lineTo(drawW + 15, (topThk * scale) / 2);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(-15, drawH - (botThk * scale) / 2);
    ctx.lineTo(drawW + 15, drawH - (botThk * scale) / 2);
    ctx.stroke();
    
    ctx.setLineDash([]);
    
    // ════════════════════════════════════════════════════════════════
    // 4. Detailed Dimensioning CAD Function
    // ════════════════════════════════════════════════════════════════
    ctx.font = '10px Inter, monospace';
    
    function drawDim(x1, y1, x2, y2, text, offset, tickSize = 4) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len === 0) return;
        const nx = -dy / len;
        const ny = dx / len;
        
        const px1 = x1 + nx * offset;
        const py1 = y1 + ny * offset;
        const px2 = x2 + nx * offset;
        const py2 = y2 + ny * offset;
        
        ctx.strokeStyle = COL.dimLine;
        ctx.lineWidth = 1;
        
        // Ext lines
        ctx.beginPath();
        ctx.moveTo(x1 + nx * Math.sign(offset) * 2, y1 + ny * Math.sign(offset) * 2);
        ctx.lineTo(px1 + nx * Math.sign(offset) * 4, py1 + ny * Math.sign(offset) * 4);
        ctx.moveTo(x2 + nx * Math.sign(offset) * 2, y2 + ny * Math.sign(offset) * 2);
        ctx.lineTo(px2 + nx * Math.sign(offset) * 4, py2 + ny * Math.sign(offset) * 4);
        ctx.stroke();
        
        // Arrow/Tick Line
        ctx.beginPath();
        ctx.moveTo(px1, py1);
        ctx.lineTo(px2, py2);
        ctx.stroke();
        
        // Architectural Ticks (diagonal slashes)
        ctx.beginPath();
        ctx.moveTo(px1 - nx*tickSize - ny*tickSize, py1 - ny*tickSize + nx*tickSize);
        ctx.lineTo(px1 + nx*tickSize + ny*tickSize, py1 + ny*tickSize - nx*tickSize);
        ctx.moveTo(px2 - nx*tickSize - ny*tickSize, py2 - ny*tickSize + nx*tickSize);
        ctx.lineTo(px2 + nx*tickSize + ny*tickSize, py2 + ny*tickSize - nx*tickSize);
        ctx.stroke();
        
        // Text
        ctx.fillStyle = COL.dimText;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.save();
        ctx.translate((px1 + px2) / 2, (py1 + py2) / 2);
        let angle = Math.atan2(dy, dx);
        if (angle > Math.PI/2 || angle < -Math.PI/2) angle += Math.PI;
        ctx.rotate(angle);
        
        // White background pill for text
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = COL.inner;
        ctx.fillRect(-tw/2 - 2, -12, tw + 4, 10);
        
        ctx.fillStyle = COL.dimText;
        ctx.fillText(text, 0, -2);
        ctx.restore();
    }
    
    // Leader Line Callout
    function drawCallout(x, y, text, dirX, dirY, lenX = 30) {
        ctx.strokeStyle = COL.calloutLine;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + dirX, y + dirY);
        const endX = x + dirX + (dirX > 0 ? lenX : -lenX);
        ctx.lineTo(endX, y + dirY);
        ctx.stroke();
        
        ctx.fillStyle = COL.dimText;
        ctx.textAlign = dirX > 0 ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, endX + (dirX > 0 ? 4 : -4), y + dirY);
    }
    
    // ── Overall Dimensions ──
    drawDim(0, drawH, drawW, drawH, `OVERALL WIDTH: ${physicalWidth.toFixed(3)}m`, 35);
    drawDim(0, drawH, 0, 0, `OVERALL HT: ${physicalHeight.toFixed(3)}m`, -45);
    
    // ── Internal Dimensions (Clear Span & Height) ──
    let cxStart = extWall * scale;
    for (let c = 0; c < numCells; c++) {
        // Clear Span at bottom of cell void
        drawDim(cxStart, cy + cellH, cxStart + cellW, cy + cellH, `${clearSpan.toFixed(3)}`, -15);
        cxStart += cellW + (intWall * scale);
    }
    // Clear Height on right side of first cell
    drawDim((extWall + clearSpan) * scale, cy + cellH, (extWall + clearSpan) * scale, cy, `${clearHt.toFixed(3)}`, 15);
    
    // ── Component Wall / Slab Thickness Callouts ──
    // Top Slab (leader extending up)
    drawCallout(drawW/2, cy/2, `Top Slab: ${topThk.toFixed(3)}m`, 30, -30);
    
    // Bottom Slab (leader extending down)
    drawCallout(drawW/2, drawH - (botThk * scale)/2, `Bot Slab: ${botThk.toFixed(3)}m`, 30, 30);
    
    // Left Wall
    drawCallout((extWall * scale)/2, cy + cellH/2, `Left Wall: ${extWall.toFixed(3)}m`, -25, -20);
    
    // Right Wall
    drawCallout(drawW - (extWall * scale)/2, cy + cellH/2, `Right Wall: ${extWall.toFixed(3)}m`, 25, 20);
    
    // Mid Wall (if exists)
    if (numCells > 1) {
        const midW_X = (extWall + clearSpan + intWall/2) * scale;
        drawCallout(midW_X, cy + cellH/2, `Int Wall: ${intWall.toFixed(3)}m`, 25, -25);
    }
    
    // ── Haunch Detail Callout ──
    if (haunch > 0) {
        // Pick the top-left haunch of cell 1
        const hx = extWall * scale;
        const hy = topThk * scale;
        // Draw miniature dimensions for the haunch leg
        ctx.save();
        ctx.strokeStyle = COL.outline;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        // Complete the triangle outline
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx + hScale, hy);
        ctx.lineTo(hx, hy + hScale);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
        
        // Haunch text callout pointing to the diagonal
        drawCallout(hx + hScale/2, hy + hScale/2, `Haunch: ${haunch.toFixed(3)} × ${haunch.toFixed(3)}`, 30, 20);
    }
    
    // ── Environmental Labels ──
    if (fillDepth > 0) {
        drawDim(drawW + 15, -fillScale, drawW + 15, 0, `Earth Fill: ${fillDepth.toFixed(3)}m`, 25);
    }
    
    // ── Decorative Cell Labels (Center Background) ──
    for (let c = 0; c < numCells; c++) {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.font = '700 24px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`CELL ${c + 1}`, cellCenters[c].x, cellCenters[c].y);
    }
    
    // ════════════════════════════════════════════════════════════════
    // 5. Superimpose STAAD Member IDs
    // ════════════════════════════════════════════════════════════════
    const members = typeof collectMembers === 'function' ? collectMembers() : [];
    if (members.length > 0) {
        ctx.fillStyle = '#fef08a'; // Bright yellow for member IDs
        ctx.font = '500 9px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        members.forEach((m, i) => {
            const startX = m.start * scale;
            const endX = m.end * scale;
            const midX = (startX + endX) / 2;
            const len = endX - startX;
            
            let drawX = 0, drawY = 0;
            let staggerY = 0;
            const textStr = `M${m.id}`;
            const tkW = ctx.measureText(textStr).width;
            
            // Check if member is too narrow to fit its own text
            const isTight = len < (tkW + 4);
            
            if (m.group === 'TOP_SLAB') {
                drawX = midX;
                drawY = (topThk * scale) / 2;
                if (isTight) staggerY = (i % 2 === 0) ? -18 : 18;
            } 
            else if (m.group === 'BOTTOM_SLAB') {
                drawX = midX;
                drawY = drawH - (botThk * scale) / 2;
                if (isTight) staggerY = (i % 2 === 0) ? -18 : 18;
            }
            else if (m.group.includes('_WALL')) {
                let wallCenterX = 0;
                if (m.group === 'LEFT_WALL') wallCenterX = (extWall * scale) / 2;
                else if (m.group.startsWith('MIDDLE_WALL_')) {
                    const wallIdx = parseInt(m.group.split('_')[2], 10) || 1;
                    wallCenterX = (extWall + wallIdx * clearSpan + (wallIdx - 0.5) * intWall) * scale;
                }
                else if (m.group === 'RIGHT_WALL') wallCenterX = drawW - (extWall * scale) / 2;
                else wallCenterX = drawW / 2;
                
                drawX = wallCenterX;
                drawY = (topThk * scale) + (clearHt * scale) / 2;
            }
            else {
                drawX = midX;
                drawY = drawH / 2;
            }
            
            if (drawX > 0 && drawY > 0) {
                ctx.save();
                
                // If it's a staggered horizontal member, draw a leader line
                if (staggerY !== 0) {
                    ctx.strokeStyle = '#fde047';
                    ctx.lineWidth = 0.8;
                    ctx.setLineDash([2, 1]);
                    ctx.beginPath();
                    ctx.moveTo(drawX, drawY);
                    ctx.lineTo(drawX, drawY + staggerY);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
                
                ctx.translate(drawX, drawY + staggerY);
                
                // Rotate vertical wall members by -90 degrees
                if (m.group.includes('_WALL')) {
                    ctx.rotate(-Math.PI / 2);
                }
                
                // Background for text contrast
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillRect(-tkW/2 - 2, -6, tkW + 4, 12);
                
                // Text
                ctx.fillStyle = '#fde047'; // Bright yellow
                ctx.fillText(textStr, 0, 0);
                
                ctx.restore();
            }
        });
    }
    
    ctx.restore();
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
