"""
Loads module — load creation, IRC templates, and fill dispersion.

Handles:
- Manual load creation  
- IRC Class AA / 70R / Class A tracked/wheel load templates
- Box culvert earth pressure, water pressure, surcharge presets
- Live load dispersion through fill (IRC 112 — 45° angle method)
"""

from __future__ import annotations
import math
from app.models.schemas import LoadPatch, LoadType, LoadDirection


def create_load(
    load_id: str,
    start: float,
    end: float,
    intensity: float,
    load_case: str = "LC1",
    load_type: LoadType = LoadType.PARTIAL_UDL,
    direction: LoadDirection = LoadDirection.GY,
    intensity_end: float | None = None,
    notes: str = "",
    dispersion_enabled: bool = False,
    fill_depth_override: float | None = None,
    contact_width: float | None = None,
) -> LoadPatch:
    """Create a single load patch."""
    return LoadPatch(
        id=load_id,
        load_case=load_case,
        load_type=load_type,
        start=start,
        end=end,
        intensity=intensity,
        intensity_end=intensity_end,
        direction=direction,
        notes=notes,
        dispersion_enabled=dispersion_enabled,
        fill_depth_override=fill_depth_override,
        contact_width=contact_width,
    )


def apply_dispersion(
    load: LoadPatch,
    fill_depth: float,
    dispersion_angle_deg: float = 45.0,
) -> LoadPatch:
    """
    Apply live load dispersion through earth fill per IRC 112.

    Engineering logic:
    - Load disperses at given angle (default 45°) through fill depth.
    - Effective width = contact_width + 2 × fill_depth × tan(angle)
    - Dispersed intensity = original_intensity × contact_width / effective_width
    - Load patch widens symmetrically about its center.

    Args:
        load: Original LoadPatch
        fill_depth: Depth of earth fill above culvert top slab (m)
        dispersion_angle_deg: Dispersion angle (default 45° per IRC 112)

    Returns:
        New LoadPatch with dispersed width and reduced intensity
    """
    if fill_depth <= 0:
        return load

    contact_width = load.contact_width if load.contact_width else load.span
    angle_rad = math.radians(dispersion_angle_deg)
    spread = 2.0 * fill_depth * math.tan(angle_rad)
    effective_width = contact_width + spread

    # Intensity reduces proportionally to width increase
    # Engineering: same total force, spread over wider area
    scale_factor = contact_width / effective_width
    new_intensity = load.intensity * scale_factor
    new_intensity_end = None
    if load.intensity_end is not None:
        new_intensity_end = load.intensity_end * scale_factor

    # Center of original load
    center = (load.start + load.end) / 2.0
    new_start = center - effective_width / 2.0
    new_end = center + effective_width / 2.0

    return LoadPatch(
        id=load.id,
        load_case=load.load_case,
        load_type=load.load_type,
        start=new_start,
        end=new_end,
        intensity=new_intensity,
        intensity_end=new_intensity_end,
        direction=load.direction,
        notes=f"{load.notes} [Dispersed: {fill_depth}m fill @ {dispersion_angle_deg}°]".strip(),
        dispersion_enabled=True,
        fill_depth_override=fill_depth,
        contact_width=contact_width,
    )


# ─── IRC Load Templates ──────────────────────────────────────────────────────

def irc_class_aa_tracked(
    position_offset: float = 0.0,
    load_case: str = "LC_AA",
    kerb_clearance: float = 1.2,
) -> list[LoadPatch]:
    """
    IRC Class AA Tracked Vehicle — 700 kN total, 2 tracks.

    Track specs:
    - Each track: 350 kN over 0.85m width × 3.6m length
    - CTC between tracks: 2.05m
    - Intensity per track: 350 / 3.6 ≈ 97.22 kN/m (per meter length along span)
    - Min clearance from kerb: 1.2m

    Args:
        position_offset: Distance from left edge to outer edge of left track
        load_case: Load case ID
        kerb_clearance: Min clearance from kerb face (default 1.2m per IRC)

    Returns:
        Two LoadPatch objects (one per track)
    """
    track_width = 0.85  # m
    ctc = 2.05  # Center-to-center between tracks
    track_length = 3.6  # m (along span)
    track_load = 350.0  # kN per track
    intensity = -(track_load / track_length)  # kN/m, negative = downward

    # Gap between inner edges of tracks
    gap = ctc - track_width  # = 1.20m

    # Left track
    left_start = position_offset + kerb_clearance
    left_end = left_start + track_width

    # Right track
    right_start = left_start + ctc
    right_end = right_start + track_width

    return [
        LoadPatch(
            id="AA_T1",
            load_case=load_case,
            load_type=LoadType.IRC_CLASS_AA,
            start=left_start,
            end=left_end,
            intensity=intensity,
            direction=LoadDirection.GY,
            notes=f"IRC Class AA Tracked - Left Track (350kN / {track_length}m)",
            contact_width=track_width,
        ),
        LoadPatch(
            id="AA_T2",
            load_case=load_case,
            load_type=LoadType.IRC_CLASS_AA,
            start=right_start,
            end=right_end,
            intensity=intensity,
            direction=LoadDirection.GY,
            notes=f"IRC Class AA Tracked - Right Track (350kN / {track_length}m)",
            contact_width=track_width,
        ),
    ]


def irc_70r_tracked(
    position_offset: float = 0.0,
    load_case: str = "LC_70R",
    kerb_clearance: float = 1.2,
) -> list[LoadPatch]:
    """
    IRC 70R Tracked Vehicle — 700 kN total, 2 tracks.

    Track specs:
    - Each track: 350 kN over 0.84m width × 4.57m length
    - CTC: 2.06m
    - Intensity: 350 / 4.57 ≈ 76.59 kN/m
    """
    track_width = 0.84
    ctc = 2.06
    track_length = 4.57
    track_load = 350.0
    intensity = -(track_load / track_length)

    left_start = position_offset + kerb_clearance
    left_end = left_start + track_width
    right_start = left_start + ctc
    right_end = right_start + track_width

    return [
        LoadPatch(
            id="70R_T1",
            load_case=load_case,
            load_type=LoadType.IRC_70R,
            start=left_start,
            end=left_end,
            intensity=intensity,
            direction=LoadDirection.GY,
            notes=f"IRC 70R Tracked - Left Track (350kN / {track_length}m)",
            contact_width=track_width,
        ),
        LoadPatch(
            id="70R_T2",
            load_case=load_case,
            load_type=LoadType.IRC_70R,
            start=right_start,
            end=right_end,
            intensity=intensity,
            direction=LoadDirection.GY,
            notes=f"IRC 70R Tracked - Right Track (350kN / {track_length}m)",
            contact_width=track_width,
        ),
    ]


def irc_class_a_wheel_line(
    position_offset: float = 0.0,
    load_case: str = "LC_A",
    kerb_clearance: float = 0.15,
) -> list[LoadPatch]:
    """
    IRC Class A — simplified as two wheel lines across width.

    Each wheel line carries half the axle load spread over wheel contact width.
    Wheel spacing within axle: 1.2m CTC.
    Contact width per wheel: 250mm = 0.25m.

    For transverse load distribution, each wheel line is modeled as a
    strip load of width 0.25m at the wheel position.

    The heaviest axles (114 kN each) are typically critical:
    - Per wheel: 114/2 = 57 kN
    - Intensity per wheel contact: 57 / 0.25 (along span) — but for transverse
      segmentation, we treat each wheel as a 0.25m wide patch.
    """
    wheel_width = 0.25  # m contact width
    wheel_ctc = 1.80  # m CTC between wheel lines (outer to outer)
    axle_load = 114.0  # kN (heaviest axle)
    wheel_load = axle_load / 2.0  # per wheel
    intensity = -(wheel_load / wheel_width)  # kN/m²·m → kN/m along span

    left_start = position_offset + kerb_clearance
    left_end = left_start + wheel_width
    right_start = left_start + wheel_ctc
    right_end = right_start + wheel_width

    return [
        LoadPatch(
            id="CLA_W1",
            load_case=load_case,
            load_type=LoadType.IRC_CLASS_A,
            start=left_start,
            end=left_end,
            intensity=intensity,
            direction=LoadDirection.GY,
            notes=f"IRC Class A - Left Wheel (114kN axle, {wheel_load}kN/wheel)",
            contact_width=wheel_width,
        ),
        LoadPatch(
            id="CLA_W2",
            load_case=load_case,
            load_type=LoadType.IRC_CLASS_A,
            start=right_start,
            end=right_end,
            intensity=intensity,
            direction=LoadDirection.GY,
            notes=f"IRC Class A - Right Wheel (114kN axle, {wheel_load}kN/wheel)",
            contact_width=wheel_width,
        ),
    ]


# ─── Box Culvert Load Templates ──────────────────────────────────────────────

def earth_pressure_load(
    height: float,
    gamma_soil: float = 18.0,
    k0: float = 0.5,
    load_case: str = "LC_EP",
    wall_start: float = 0.0,
) -> LoadPatch:
    """
    Lateral earth pressure on culvert wall — trapezoidal (LIN).

    Engineering: P = K₀ × γ_soil × h
    - At top (h=0): pressure = 0 (or surcharge component)
    - At bottom (h=H): pressure = K₀ × γ × H

    Args:
        height: Wall height (m)
        gamma_soil: Unit weight of soil (kN/m³, default 18)
        k0: Earth pressure coefficient (default 0.5 for at-rest)
        load_case: Load case ID
        wall_start: Start position (typically 0 for wall top)

    Returns:
        LoadPatch with trapezoidal intensity (0 at top, max at bottom)
    """
    max_pressure = k0 * gamma_soil * height  # kN/m² at bottom

    return LoadPatch(
        id="EP",
        load_case=load_case,
        load_type=LoadType.EARTH_PRESSURE,
        start=wall_start,
        end=wall_start + height,
        intensity=0.0,  # At top
        intensity_end=max_pressure,  # At bottom (STAAD LIN: w1=0, w2=max)
        direction=LoadDirection.GX,
        notes=f"Earth pressure: K₀={k0}, γ={gamma_soil} kN/m³, H={height}m",
    )


def water_pressure_load(
    water_height: float,
    gamma_water: float = 9.81,
    load_case: str = "LC_WP",
    wall_start: float = 0.0,
) -> LoadPatch:
    """
    Hydrostatic water pressure — triangular (LIN).

    P = γ_water × h
    Zero at water surface, max at bottom.

    Args:
        water_height: Height of water inside culvert (m)
        gamma_water: Unit weight of water (default 9.81 kN/m³)
        load_case: Load case ID
        wall_start: Start position (water surface level on wall)
    """
    max_pressure = gamma_water * water_height

    return LoadPatch(
        id="WP",
        load_case=load_case,
        load_type=LoadType.HYDROSTATIC,
        start=wall_start,
        end=wall_start + water_height,
        intensity=0.0,
        intensity_end=max_pressure,
        direction=LoadDirection.GX,
        notes=f"Water pressure: γw={gamma_water} kN/m³, h={water_height}m",
    )


def surcharge_load(
    width: float,
    surcharge_intensity: float = 10.0,
    k0: float = 0.5,
    load_case: str = "LC_SC",
) -> LoadPatch:
    """
    Surcharge load on wall — uniform horizontal (UNI).

    P = q × K₀ (constant along wall height)

    Args:
        width: Length over which surcharge acts (wall height for walls, slab width for top)
        surcharge_intensity: Surcharge pressure (kN/m²)
        k0: Lateral coefficient
        load_case: Load case ID
    """
    lateral_pressure = surcharge_intensity * k0

    return LoadPatch(
        id="SC",
        load_case=load_case,
        load_type=LoadType.SURCHARGE,
        start=0.0,
        end=width,
        intensity=lateral_pressure,
        direction=LoadDirection.GX,
        notes=f"Surcharge: q={surcharge_intensity} kN/m², K₀={k0}",
    )


def dead_load_fill(
    width: float,
    fill_depth: float,
    gamma_soil: float = 18.0,
    load_case: str = "LC_DL",
) -> LoadPatch:
    """
    Dead load from earth fill on top slab — uniform (UNI).

    P = γ_soil × fill_depth (kN/m²)
    """
    pressure = -(gamma_soil * fill_depth)  # Negative = downward

    return LoadPatch(
        id="DL_FILL",
        load_case=load_case,
        load_type=LoadType.DEAD_LOAD,
        start=0.0,
        end=width,
        intensity=pressure,
        direction=LoadDirection.GY,
        notes=f"Earth fill DL: γ={gamma_soil} kN/m³, depth={fill_depth}m",
    )


def wearing_course_load(
    width: float,
    thickness: float = 0.075,
    gamma_asphalt: float = 22.0,
    load_case: str = "LC_WC",
) -> LoadPatch:
    """
    Wearing course dead load on top slab — uniform (UNI).

    P = γ_asphalt × thickness
    """
    pressure = -(gamma_asphalt * thickness)

    return LoadPatch(
        id="DL_WC",
        load_case=load_case,
        load_type=LoadType.WEARING_COURSE,
        start=0.0,
        end=width,
        intensity=pressure,
        direction=LoadDirection.GY,
        notes=f"Wearing course: γ={gamma_asphalt} kN/m³, t={thickness}m",
    )


def parse_loads_csv(csv_text: str) -> list[LoadPatch]:
    """
    Parse loads from CSV text.

    Expected columns: id, load_case, load_type, start, end, intensity, direction, notes
    Optional: intensity_end
    """
    import csv
    import io

    reader = csv.DictReader(io.StringIO(csv_text))
    loads = []

    for row in reader:
        loads.append(LoadPatch(
            id=row.get("id", f"L{len(loads)+1}"),
            load_case=row.get("load_case", "LC1"),
            load_type=LoadType(row.get("load_type", "PARTIAL_UDL")),
            start=float(row["start"]),
            end=float(row["end"]),
            intensity=float(row["intensity"]),
            intensity_end=float(row["intensity_end"]) if row.get("intensity_end") else None,
            direction=LoadDirection(row.get("direction", "GY")),
            notes=row.get("notes", ""),
        ))

    return loads
