/**
 * design_diagrams.js
 * Renders the 4 specialized visual tabs for the Auto Design Results Dashboard
 */

window.renderAutoDesignDiagrams = function(result, payload) {
    // 1. Geometry & Loads (using existing results_frame_viz.js logic if possible, or custom)
    renderGeometryAndLoads(result, payload);
    
    // 2. BMD/SFD Envelopes
    renderEnvelopes(result);
    
    // 3. Base Pressure
    renderBasePressure(result);
    
    // 4. Reinforcement
    renderReinforcement(result);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Geometry & Loads
// ─────────────────────────────────────────────────────────────────────────────
function renderGeometryAndLoads(result, payload) {
    const canvas = document.getElementById('ad-viz-geometry');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // High DPI Canvas Scaling
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    
    const w = rect.width;
    const h = rect.height;
    
    // Clear
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);
    
    // ─────────────────────────────────────────────────────────
    // Helper: Create Concrete Hatch Pattern
    // ─────────────────────────────────────────────────────────
    function createConcretePattern() {
        const pCanvas = document.createElement('canvas');
        pCanvas.width = 40;
        pCanvas.height = 40;
        const pCtx = pCanvas.getContext('2d');
        
        pCtx.fillStyle = '#e2e8f0'; // Base light gray
        pCtx.fillRect(0, 0, 40, 40);
        
        // Random aggregate and sand dots
        pCtx.fillStyle = '#94a3b8';
        for (let i = 0; i < 15; i++) {
            pCtx.beginPath();
            pCtx.arc(Math.random() * 40, Math.random() * 40, Math.random() * 1.5, 0, Math.PI * 2);
            pCtx.fill();
        }
        // Small triangles (aggregate)
        pCtx.strokeStyle = '#cbd5e1';
        pCtx.lineWidth = 1;
        for (let i=0; i<3; i++) {
            const tx = Math.random()*30;
            const ty = Math.random()*30;
            pCtx.beginPath();
            pCtx.moveTo(tx, ty);
            pCtx.lineTo(tx+3, ty+4);
            pCtx.lineTo(tx-2, ty+5);
            pCtx.closePath();
            pCtx.stroke();
        }
        return ctx.createPattern(pCanvas, 'repeat');
    }

    const concretePattern = createConcretePattern();

    // Calculate Drawing Scale
    const model = (result && result.model) || (result && result.geometry) || {};
    const propModel = model && model.properties ? model.properties : model;
    const totalW = propModel.total_width || payload.clear_span + 2 * payload.wall_thickness;
    const totalH = payload.clear_height + payload.top_slab_thickness + payload.bottom_slab_thickness;
    
    // Allow more margin for detailed dimensions
    const margin = 100;
    const scaleX = (w - margin * 2) / totalW;
    const scaleY = (h - margin * 2) / totalH;
    const scale = Math.min(scaleX, scaleY);
    
    const cx = w / 2;
    const cy = h / 2 + 40; // Shift down slightly
    
    // Draw Ground Level & Soil Fill
    const groundY = cy - (totalH / 2 * scale) - (payload.fill_depth + payload.wearing_course_thickness) * scale;
    
    // Soil Fill Gradient
    const fillH = (payload.fill_depth + payload.wearing_course_thickness) * scale;
    const fillGrad = ctx.createLinearGradient(0, groundY, 0, groundY + fillH);
    fillGrad.addColorStop(0, 'rgba(163, 230, 53, 0.2)'); // Light green top
    fillGrad.addColorStop(1, 'rgba(120, 113, 108, 0.2)'); // Brownish bottom
    
    ctx.fillStyle = fillGrad;
    ctx.fillRect(cx - (totalW / 2 * scale + 50), groundY, totalW * scale + 100, fillH);
    
    // GL Line
    ctx.beginPath();
    ctx.moveTo(cx - (totalW / 2 * scale) - 80, groundY);
    ctx.lineTo(cx + (totalW / 2 * scale) + 80, groundY);
    ctx.strokeStyle = '#65a30d'; // Earth green
    ctx.lineWidth = 2.5;
    ctx.stroke();
    
    // GL Marker
    ctx.fillStyle = '#4d7c0f';
    ctx.font = 'bold 12px Inter';
    ctx.fillText('▼ G.L.', cx + (totalW / 2 * scale) + 20, groundY - 8);

    // Box Coordinates
    const boxLeft = cx - (totalW / 2 * scale);
    const boxTop = cy - (totalH / 2 * scale);
    const boxW = totalW * scale;
    const boxH = totalH * scale;
    
    // Apply Drop Shadow for Box Culvert Depth
    ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = 10;
    ctx.shadowOffsetY = 15;
    
    // Outer boundary (Solid base)
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(boxLeft, boxTop, boxW, boxH);
    
    // Reset shadow for internal details
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    
    // Draw Concrete Pattern Layer
    ctx.fillStyle = concretePattern;
    ctx.fillRect(boxLeft, boxTop, boxW, boxH);
    
    // Outer Border
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(boxLeft, boxTop, boxW, boxH);
    
    // Cut out inner cells
    const cW = (propModel.clear_span || payload.clear_span) * scale;
    const cH = payload.clear_height * scale;
    const tT = payload.top_slab_thickness * scale;
    const bT = payload.bottom_slab_thickness * scale;
    const ow = payload.wall_thickness * scale;
    const mw = payload.mid_wall_thickness * scale;
    const haunch = payload.haunch_size * scale;
    
    let currentX = boxLeft + ow;
    const numCells = propModel.num_cells || payload.num_cells || 1;
    
    for (let c = 0; c < numCells; c++) {
        // Cut out opening
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(currentX, boxTop + tT, cW, cH);
        
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(currentX, boxTop + tT, cW, cH);
        
        // Draw Haunches (Top Left, Top Right, Bot Left, Bot Right)
        if (haunch > 0) {
            ctx.fillStyle = concretePattern;
            ctx.strokeStyle = '#64748b';
            ctx.lineWidth = 1.5;
            // TL
            ctx.beginPath(); ctx.moveTo(currentX, boxTop + tT); ctx.lineTo(currentX + haunch, boxTop + tT); ctx.lineTo(currentX, boxTop + tT + haunch); ctx.fill(); ctx.stroke();
            // TR
            ctx.beginPath(); ctx.moveTo(currentX + cW, boxTop + tT); ctx.lineTo(currentX + cW - haunch, boxTop + tT); ctx.lineTo(currentX + cW, boxTop + tT + haunch); ctx.fill(); ctx.stroke();
            // BL
            ctx.beginPath(); ctx.moveTo(currentX, boxTop + tT + cH); ctx.lineTo(currentX + haunch, boxTop + tT + cH); ctx.lineTo(currentX, boxTop + tT + cH - haunch); ctx.fill(); ctx.stroke();
            // BR
            ctx.beginPath(); ctx.moveTo(currentX + cW, boxTop + tT + cH); ctx.lineTo(currentX + cW - haunch, boxTop + tT + cH); ctx.lineTo(currentX + cW, boxTop + tT + cH - haunch); ctx.fill(); ctx.stroke();
        }
        
        // Centerlines (Subtle dashes)
        ctx.beginPath();
        ctx.moveTo(currentX + cW/2, boxTop + tT);
        ctx.lineTo(currentX + cW/2, boxTop + tT + cH);
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1;
        ctx.setLineDash([15, 10, 5, 10]);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Cell Number Label
        ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';
        ctx.font = 'bold 36px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`C${c+1}`, currentX + cW/2, boxTop + tT + cH/2);
        
        // Clear Span & Height Dimensions (Inside Cell)
        ctx.fillStyle = '#64748b';
        ctx.font = '11px Inter';
        // Width
        ctx.beginPath(); ctx.moveTo(currentX, boxTop + tT + cH/2 + 30); ctx.lineTo(currentX + cW, boxTop + tT + cH/2 + 30); ctx.lineWidth=0.5; ctx.stroke();
        ctx.fillText(`${(propModel.clear_span || payload.clear_span).toFixed(3)}m`, currentX + cW/2, boxTop + tT + cH/2 + 25);
        // Height
        ctx.beginPath(); ctx.moveTo(currentX + cW/2 - 30, boxTop + tT); ctx.lineTo(currentX + cW/2 - 30, boxTop + tT + cH); ctx.stroke();
        ctx.save();
        ctx.translate(currentX + cW/2 - 35, boxTop + tT + cH/2);
        ctx.rotate(-Math.PI/2);
        ctx.fillText(`${payload.clear_height.toFixed(3)}m`, 0, 0);
        ctx.restore();
        
        currentX += cW + mw; // Move to next cell
    }
    
    ctx.textBaseline = 'alphabetic'; // reset
    
    // ─────────────────────────────────────────────────────────
    // External Engineering Dimensions
    // ─────────────────────────────────────────────────────────
    const dimColor = '#3b82f6';
    ctx.fillStyle = dimColor;
    ctx.strokeStyle = dimColor;
    ctx.lineWidth = 1;
    ctx.font = '500 12px Inter';
    ctx.textAlign = 'center';
    
    const drawDim = (x1, y1, x2, y2, text, offsetDir, offsetDist) => {
        // Offset points
        const dx = x2 - x1; const dy = y2 - y1;
        const len = Math.sqrt(dx*dx + dy*dy);
        const nx = -dy/len * offsetDir; const ny = dx/len * offsetDir;
        
        const px1 = x1 + nx * offsetDist; const py1 = y1 + ny * offsetDist;
        const px2 = x2 + nx * offsetDist; const py2 = y2 + ny * offsetDist;
        
        // Extension lines
        ctx.beginPath(); ctx.moveTo(x1+(nx*5), y1+(ny*5)); ctx.lineTo(px1+(nx*5), py1+(ny*5)); ctx.strokeStyle='rgba(59,130,246,0.5)'; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2+(nx*5), y2+(ny*5)); ctx.lineTo(px2+(nx*5), py2+(ny*5)); ctx.stroke();
        
        // Main line
        ctx.beginPath(); ctx.moveTo(px1, py1); ctx.lineTo(px2, py2); ctx.strokeStyle=dimColor; ctx.stroke();
        
        // Ticks (Arch style slashes)
        ctx.beginPath(); ctx.moveTo(px1-4, py1+4); ctx.lineTo(px1+4, py1-4); ctx.lineWidth=1.5; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px2-4, py2+4); ctx.lineTo(px2+4, py2-4); ctx.stroke();
        ctx.lineWidth=1;
        
        // Text
        ctx.save();
        ctx.translate((px1+px2)/2 + nx*8, (py1+py2)/2 + ny*8);
        if (Math.abs(dy) > Math.abs(dx)) ctx.rotate(-Math.PI/2); // Vertical
        ctx.fillText(text, 0, 4);
        ctx.restore();
    };
    
    // Top Overall Width
    drawDim(boxLeft, boxTop, boxLeft+boxW, boxTop, `${totalW.toFixed(3)}m`, 1, 30);
    
    // Left Overall Height
    drawDim(boxLeft, boxTop, boxLeft, boxTop+boxH, `${totalH.toFixed(3)}m`, 1, 40);
    
    // Thickness callouts
    // Top Slab
    drawDim(boxLeft-20, boxTop, boxLeft-20, boxTop+tT, `${payload.top_slab_thickness.toFixed(3)}`, 1, 20);
    // Bottom Slab
    drawDim(boxLeft-20, boxTop+boxH-bT, boxLeft-20, boxTop+boxH, `${payload.bottom_slab_thickness.toFixed(3)}`, 1, 20);
    
    // ─────────────────────────────────────────────────────────
    // Applied Dynamic Loads Visualization
    // ─────────────────────────────────────────────────────────
    ctx.strokeStyle = '#ef4444';
    ctx.fillStyle = '#ef4444';
    const arrowY = groundY;
    
    // Draw wheels for a generic vehicle
    for (let i = 0; i < 4; i++) {
        const ax = boxLeft + boxW * 0.2 + i * (boxW * 0.6 / 3);
        
        // Shaft
        ctx.beginPath();
        ctx.moveTo(ax, arrowY - 35);
        ctx.lineTo(ax, arrowY - 5);
        ctx.lineWidth = 2.5;
        ctx.stroke();
        
        // Arrow head
        ctx.beginPath();
        ctx.moveTo(ax, arrowY);
        ctx.lineTo(ax - 6, arrowY - 12);
        ctx.lineTo(ax + 6, arrowY - 12);
        ctx.fill();
        
        // Wheel representation
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(ax - 15, arrowY - 45, 30, 10);
    }
    
    ctx.fillStyle = '#ef4444';
    ctx.font = 'bold 12px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('IRC Live Loads Automated (70R, Class A, AA)', cx, arrowY - 55);
    ctx.textAlign = 'left';
    
    // ─────────────────────────────────────────────────────────
    // Footer Watermark & Properties
    // ─────────────────────────────────────────────────────────
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 13px Inter';
    ctx.fillText(`Material Properties`, 20, h - 45);
    ctx.font = '400 12px Inter';
    ctx.fillStyle = '#475569';
    ctx.fillText(`Concrete: M${payload.fck}   |   Steel: Fe${payload.fy}`, 20, h - 25);
    ctx.fillText(`Clear Cover: ${payload.clear_cover}mm   |   Soil Dens: ${payload.gamma_soil}kN/m³`, 20, h - 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Envelopes (BMD / SFD)
// ─────────────────────────────────────────────────────────────────────────────
function renderEnvelopes(result) {
    const canvas = document.getElementById('ad-viz-sfd');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const dpr = window.devicePixelRatio || 1;
    let rect = canvas.getBoundingClientRect();
    if (rect.width === 0) {
        const geomCanvas = document.getElementById('ad-viz-geometry');
        if (geomCanvas) rect = geomCanvas.getBoundingClientRect();
    }
    
    const w = rect.width || 800;
    const h = rect.height || 500;
    
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);
    
    // Premium Dot Grid Background
    ctx.fillStyle = '#cbd5e1';
    for (let x = 0; x < w; x += 20) {
        for (let y = 0; y < h; y += 20) {
            ctx.beginPath();
            ctx.arc(x, y, 1, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    
    // Glassmorphism Header Card
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.05)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.beginPath();
    ctx.roundRect(w/2 - 300, 20, 600, 70, 12);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    
    ctx.fillStyle = '#0f172a';
    ctx.font = '800 18px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('BMD ENVELOPE (CRITICAL COMBINATIONS)', w / 2, 45);
    
    ctx.font = '500 13px Inter';
    ctx.fillStyle = '#64748b';
    ctx.fillText('Derived from Longitudinal Sweep (IRC 70R, Class A, Class AA) at 0.1L increments', w / 2, 70);
    
    // Center Neutral Axis Line
    const cy = h/2 + 30;
    const margin = 80;
    const drawW = w - margin * 2;
    
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); 
    ctx.moveTo(margin, cy); 
    ctx.lineTo(w - margin, cy); 
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px Inter';
    ctx.fillText('Neutral Axis / Reference Line', margin + 80, cy - 10);
    
    // Supports (Nodes)
    ctx.fillStyle = '#334155';
    ctx.beginPath(); ctx.arc(margin, cy, 6, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(w - margin, cy, 6, 0, Math.PI*2); ctx.fill();
    ctx.fillText('Left Wall', margin, cy + 25);
    ctx.fillText('Right Wall', w - margin, cy + 25);

    // Sagging (Positive Bending, standard bottom)
    const sagGrad = ctx.createLinearGradient(0, cy, 0, cy + 180);
    sagGrad.addColorStop(0, 'rgba(59, 130, 246, 0.05)');
    sagGrad.addColorStop(1, 'rgba(59, 130, 246, 0.4)');
    
    ctx.beginPath();
    ctx.moveTo(margin, cy);
    ctx.quadraticCurveTo(w/2, cy + 300, w - margin, cy);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineTo(margin, cy);
    ctx.fillStyle = sagGrad;
    ctx.fill();
    
    // Sagging Peak Label
    ctx.fillStyle = '#1d4ed8'; // Darker blue
    ctx.font = 'bold 13px Inter';
    ctx.fillText('Max Sagging (+)', w/2, cy + 160);
    
    // Hogging (Negative Bending, drawn up)
    const hogGrad = ctx.createLinearGradient(0, cy, 0, cy - 100);
    hogGrad.addColorStop(0, 'rgba(239, 68, 68, 0.05)');
    hogGrad.addColorStop(1, 'rgba(239, 68, 68, 0.4)');
    
    // Left Support Hogging
    ctx.beginPath();
    ctx.moveTo(margin, cy);
    ctx.lineTo(margin, cy - 100);
    ctx.quadraticCurveTo(margin + 120, cy - 40, margin + 250, cy);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineTo(margin, cy);
    ctx.fillStyle = hogGrad;
    ctx.fill();
    
    ctx.fillStyle = '#b91c1c';
    ctx.fillText('Max Hogging (-)', margin + 30, cy - 110);
    
    // Right Support Hogging
    ctx.beginPath();
    ctx.moveTo(w - margin, cy);
    ctx.lineTo(w - margin, cy - 100);
    ctx.quadraticCurveTo(w - margin - 120, cy - 40, w - margin - 250, cy);
    ctx.strokeStyle = '#ef4444';
    ctx.stroke();
    ctx.lineTo(w - margin, cy);
    ctx.fillStyle = hogGrad;
    ctx.fill();
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Base Pressure
// ─────────────────────────────────────────────────────────────────────────────
function renderBasePressure(result) {
    const canvas = document.getElementById('ad-viz-pressure');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const dpr = window.devicePixelRatio || 1;
    let rect = canvas.getBoundingClientRect();
    if (rect.width === 0) {
        const geomCanvas = document.getElementById('ad-viz-geometry');
        if (geomCanvas) rect = geomCanvas.getBoundingClientRect();
    }
    
    const w = rect.width || 800;
    const h = rect.height || 400; // pressure tab is 400px high in HTML
    
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);
    
    const bearing = result.checks.bearing_pressure;
    if (!bearing) return;
    
    const qmax = bearing.max_pressure;
    const qmin = bearing.min_pressure;
    const allow = bearing.allowable;
    
    const marginX = 120;
    const baseY = h / 2 - 80;
    const baseW = w - marginX * 2;
    
    // Header
    ctx.fillStyle = '#0f172a';
    ctx.font = '800 18px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('SOIL BEARING PRESSURE DISTRIBUTION', w / 2, 45);
    ctx.font = '500 13px Inter';
    ctx.fillStyle = '#64748b';
    ctx.fillText('Analysis across the culvert base width under Critical Load Combinations', w / 2, 70);
    
    // Draw Box Bottom (Stylized as a thick raft foundation)
    // Shadow for depth
    ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
    ctx.shadowBlur = 15;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 10;
    
    ctx.fillStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.roundRect(marginX, baseY - 40, baseW, 40, [4, 4, 0, 0]);
    ctx.fill();
    
    ctx.shadowColor = 'transparent'; // Reset shadow
    
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(marginX, baseY - 40, baseW, 40);
    
    // Pattern on raft
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    for(let i=0; i<baseW; i+=20) {
        ctx.beginPath(); ctx.moveTo(marginX + i, baseY - 40); ctx.lineTo(marginX + i + 10, baseY); ctx.lineWidth=1; ctx.strokeStyle='rgba(148, 163, 184, 0.3)'; ctx.stroke();
    }
    
    // Ground Interface Line
    ctx.beginPath();
    ctx.moveTo(marginX - 50, baseY);
    ctx.lineTo(marginX + baseW + 50, baseY);
    ctx.strokeStyle = '#84cc16';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Calculate vertical scaling for pressures (leave room for allowable line)
    const maxVal = Math.max(qmax, allow) * 1.3;
    const scaleP = (h - baseY - 60) / maxVal;
    
    const p1 = baseY + (qmax * scaleP);
    const p2 = baseY + (qmin * scaleP);
    
    const ratio = qmax / allow;
    const isFail = ratio > 1;
    
    // Draw Trapezoidal Pressure Distribution
    ctx.beginPath();
    ctx.moveTo(marginX, baseY);
    ctx.lineTo(marginX, p1);
    ctx.lineTo(marginX + baseW, p2);
    ctx.lineTo(marginX + baseW, baseY);
    ctx.closePath();
    
    // Pressure Gradient
    const pGrad = ctx.createLinearGradient(0, baseY, 0, Math.max(p1, p2));
    if (isFail) {
        pGrad.addColorStop(0, 'rgba(239, 68, 68, 0.1)');
        pGrad.addColorStop(1, 'rgba(239, 68, 68, 0.6)');
    } else {
        pGrad.addColorStop(0, 'rgba(16, 185, 129, 0.1)');
        pGrad.addColorStop(1, 'rgba(16, 185, 129, 0.5)');
    }
    
    ctx.fillStyle = pGrad;
    ctx.fill();
    ctx.strokeStyle = isFail ? '#dc2626' : '#059669';
    ctx.lineWidth = 3;
    ctx.stroke();
    
    // Pressure vectors (Arrows pushing up into base)
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isFail ? 'rgba(220, 38, 38, 0.5)' : 'rgba(5, 150, 105, 0.5)';
    ctx.fillStyle = isFail ? 'rgba(220, 38, 38, 0.5)' : 'rgba(5, 150, 105, 0.5)';
    
    for (let i = 0; i <= 10; i++) {
        const x = marginX + (i/10) * baseW;
        // Interpret height of trapezoid at this x
        const pHeight = p1 + (p2 - p1) * (i/10);
        
        ctx.beginPath(); ctx.moveTo(x, pHeight - 5); ctx.lineTo(x, baseY + 10); ctx.stroke();
        // Upload pointing arrow head
        ctx.beginPath(); ctx.moveTo(x, baseY + 5); ctx.lineTo(x - 4, baseY + 12); ctx.lineTo(x + 4, baseY + 12); ctx.fill();
    }
    
    // Draw Allowable Line with distinct animated-style dashed stroke
    const allowY = baseY + (allow * scaleP);
    ctx.beginPath();
    ctx.moveTo(marginX - 40, allowY);
    ctx.lineTo(marginX + baseW + 40, allowY);
    ctx.strokeStyle = '#ea580c'; // Vibrant orange
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Text Labels formatting
    ctx.fillStyle = '#0f172a';
    ctx.font = '800 16px Inter';
    
    // Add pill background for readability
    const drawPillText = (text, tx, ty, clr, bg) => {
        ctx.font = '700 15px Inter';
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.roundRect(tx - tw/2 - 12, ty - 20, tw + 24, 28, 14); ctx.fill();
        ctx.fillStyle = clr;
        ctx.textAlign = 'center';
        ctx.fillText(text, tx, ty);
        ctx.textAlign = 'left';
    };
    
    drawPillText(`${qmax.toFixed(1)} kN/m²`, marginX, p1 + 30, isFail ? '#ef4444' : '#0f172a', 'rgba(241, 245, 249, 0.9)');
    drawPillText(`${qmin.toFixed(1)} kN/m²`, marginX + baseW, p2 + 30, '#0f172a', 'rgba(241, 245, 249, 0.9)');
    
    // Allowable SBC Badge
    ctx.fillStyle = '#fff7ed';
    ctx.strokeStyle = '#fdba74';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(w/2 - 100, allowY + 15, 200, 30, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c2410c';
    ctx.font = 'bold 13px Inter';
    ctx.textAlign = 'center';
    ctx.fillText(`Allowable SBC = ${allow} kN/m²`, w/2, allowY + 35);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Reinforcement
// ─────────────────────────────────────────────────────────────────────────────
function renderReinforcement(result) {
    const canvas = document.getElementById('ad-viz-rebar');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const dpr = window.devicePixelRatio || 1;
    let rect = canvas.getBoundingClientRect();
    if (rect.width === 0) {
        const geomCanvas = document.getElementById('ad-viz-geometry');
        if (geomCanvas) rect = geomCanvas.getBoundingClientRect();
    }
    
    const w = rect.width || 800;
    const h = rect.height || 500;
    
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);
    
    // Helper: Create Concrete Hatch Pattern (Reuse from Geometry)
    const pCanvas = document.createElement('canvas');
    pCanvas.width = 40; pCanvas.height = 40;
    const pCtx = pCanvas.getContext('2d');
    pCtx.fillStyle = '#e2e8f0'; pCtx.fillRect(0, 0, 40, 40);
    pCtx.fillStyle = '#94a3b8';
    for (let i = 0; i < 15; i++) {
        pCtx.beginPath(); pCtx.arc(Math.random()*40, Math.random()*40, Math.random()*1.5, 0, Math.PI*2); pCtx.fill();
    }
    pCtx.strokeStyle = '#cbd5e1'; pCtx.lineWidth = 1;
    for (let i=0; i<3; i++) {
        const tx = Math.random()*30; const ty = Math.random()*30;
        pCtx.beginPath(); pCtx.moveTo(tx, ty); pCtx.lineTo(tx+3, ty+4); pCtx.lineTo(tx-2, ty+5); pCtx.closePath(); pCtx.stroke();
    }
    const concretePattern = ctx.createPattern(pCanvas, 'repeat');
    
    // Header
    ctx.fillStyle = '#0f172a';
    ctx.font = '800 18px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('MAIN FLEXURE REINFORCEMENT REQUIREMENTS', w / 2, 45);
    ctx.font = '500 13px Inter';
    ctx.fillStyle = '#64748b';
    ctx.fillText('Critical section sizing for ULS Bending Moment (Requires min 0.2% Ast)', w / 2, 70);
    ctx.textAlign = 'left';
    
    // Outline Geometry (Stylized proportional rendering)
    const cx = w / 2;
    const cy = h / 2 + 20;
    
    const boxW = Math.min(w * 0.5, 500);
    const boxH = Math.min(h * 0.45, 250);
    const thick = 35; // Visual thickness
    const leftX = cx - boxW / 2;
    const topY = cy - boxH / 2;
    
    // Outer shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
    ctx.shadowBlur = 15;
    ctx.shadowOffsetX = 5;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = concretePattern;
    ctx.fillRect(leftX, topY, boxW, boxH);
    ctx.shadowColor = 'transparent';
    
    // Clear out inner cell
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(leftX + thick, topY + thick, boxW - thick*2, boxH - thick*2);
    
    // Outlines
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.strokeRect(leftX, topY, boxW, boxH);
    ctx.strokeStyle = '#94a3b8';
    ctx.strokeRect(leftX + thick, topY + thick, boxW - thick*2, boxH - thick*2);
    
    // Rebar Graphical Indicators
    const drawRebarLine = (x1, y1, x2, y2, color, isDots = false) => {
        if (!isDots) {
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
            ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.stroke();
            // Glow
            ctx.strokeStyle = color.replace('1)', '0.3)'); ctx.lineWidth = 8; ctx.stroke();
        } else {
            const dx = x2 - x1; const dy = y2 - y1;
            const len = Math.sqrt(dx*dx + dy*dy);
            const count = Math.floor(len / 15);
            ctx.fillStyle = color;
            for(let i=0; i<=count; i++) {
                ctx.beginPath(); ctx.arc(x1 + (dx/count)*i, y1 + (dy/count)*i, 3.5, 0, Math.PI*2); ctx.fill();
            }
        }
    };
    
    const tensionColor = 'rgba(239, 68, 68, 1)'; // Red
    const compColor = 'rgba(59, 130, 246, 1)'; // Blue
    const coverLine = 12;
    
    // Draw graphical rebars (Tension faces primarily)
    // Top Slab
    drawRebarLine(leftX + 10, topY + coverLine, leftX + boxW - 10, topY + coverLine, tensionColor, true); // Top Hogging
    drawRebarLine(leftX + thick + 10, topY + thick - coverLine, leftX + boxW - thick - 10, topY + thick - coverLine, compColor, true); // Bot Sagging
    
    // Bottom Slab
    drawRebarLine(leftX + thick + 10, topY + boxH - thick + coverLine, leftX + boxW - thick - 10, topY + boxH - thick + coverLine, compColor, true); // Top Sagging
    drawRebarLine(leftX + 10, topY + boxH - coverLine, leftX + boxW - 10, topY + boxH - coverLine, tensionColor, true); // Bot Hogging
    
    // Walls
    drawRebarLine(leftX + thick - coverLine, topY + 10, leftX + thick - coverLine, topY + boxH - 10, tensionColor, false); // Left Wall inner
    drawRebarLine(leftX + boxW - thick + coverLine, topY + 10, leftX + boxW - thick + coverLine, topY + boxH - 10, tensionColor, false); // Right Wall inner
    
    // Formatting helper & Pill Drawer
    const drawBadge = (el, textPrefix, tx, ty, align='center') => {
        const isPass = el && el.status !== 'FAIL';
        const text = isPass ? `T${el.bar_dia} @ ${Math.round(el.spacing_provided)} c/c` : 'Requires Custom Design';
        const fullText = `${textPrefix}: ${text}`;
        
        ctx.font = '700 13px Inter';
        const tw = ctx.measureText(fullText).width;
        
        // Background Pill
        ctx.fillStyle = isPass ? 'rgba(241, 245, 249, 0.95)' : 'rgba(254, 242, 242, 0.95)';
        ctx.strokeStyle = isPass ? '#cbd5e1' : '#fca5a5';
        ctx.lineWidth = 1;
        
        let startX = tx;
        if (align === 'center') startX = tx - tw/2 - 12;
        else if (align === 'right') startX = tx - tw - 24;
        
        ctx.beginPath();
        ctx.shadowColor = 'rgba(0,0,0,0.05)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2;
        ctx.roundRect(startX, ty - 20, tw + 24, 28, 14);
        ctx.fill(); ctx.stroke();
        ctx.shadowColor = 'transparent';
        
        // Text
        ctx.fillStyle = isPass ? '#334155' : '#dc2626';
        ctx.textAlign = 'left';
        
        // Split and colorize prefix vs value
        const split = fullText.split(': ');
        ctx.font = '600 13px Inter';
        ctx.fillStyle = '#64748b';
        ctx.fillText(split[0] + ':', startX + 12, ty);
        
        ctx.font = '700 13px Inter';
        ctx.fillStyle = isPass ? '#0f172a' : '#dc2626';
        ctx.fillText(split[1], startX + 12 + ctx.measureText(split[0] + ': ').width, ty);
    };
    
    // Layout Badges
    // Top Slab
    drawBadge(rft.top_slab_hog, 'Top Face (Hog)', cx, topY - 15, 'center');
    drawBadge(rft.top_slab_sag, 'Bot Face (Sag)', cx, topY + thick + 35, 'center');
    
    // Bottom Slab
    drawBadge(rft.bot_slab_sag, 'Top Face (Sag)', cx, topY + boxH - thick - 20, 'center');
    drawBadge(rft.bot_slab_hog, 'Bot Face (Hog)', cx, topY + boxH + 25, 'center');
    
    // Outer Walls (Left)
    drawBadge(rft.outer_walls, 'Inner Face', leftX - 10, cy, 'right');
    // Outer Walls (Right)
    drawBadge(rft.outer_walls, 'Inner Face', leftX + boxW + 10, cy, 'left');
    
    // Legend Footer
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, h - 40, w, 40);
    ctx.strokeStyle = '#e2e8f0'; ctx.beginPath(); ctx.moveTo(0, h-40); ctx.lineTo(w, h-40); ctx.stroke();
    
    ctx.fillStyle = '#64748b';
    ctx.font = '500 12px Inter';
    ctx.textAlign = 'left';
    ctx.fillText('Note: Reinforcement calculated based on Working Stress / Limit State of Collapse (IRC:112)', 20, h - 15);
    
    // Legend colors
    ctx.fillStyle = tensionColor; ctx.beginPath(); ctx.arc(w - 180, h - 20, 5, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#334155'; ctx.fillText('Tension', w - 170, h - 16);
    
    ctx.fillStyle = compColor; ctx.beginPath(); ctx.arc(w - 90, h - 20, 5, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#334155'; ctx.fillText('Distribution', w - 80, h - 16);
}
