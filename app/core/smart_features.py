"""
Smart Features Engine — Box Culvert Design Automation.

Contains calculation engines for:
1. Impact Factor (IRC 6, Cl. 208)
2. Load Combination Generator (IRC 6:2017 ULS/SLS)
3. Vehicle Position Sweep (worst-case finder)
4. Effective Width / Load Dispersion (IRC 112)
5. Concrete Quantity Estimator (BOQ)
6. Base Pressure / Bearing Check
7. Uplift / Buoyancy Check
8. Reinforcement Helper (IS 456 / IRC 112)
9. Multi-Cell Auto-Generation
10. Skew Angle Correction
11. STAAD .std File Generator
12. BBS (Bar Bending Schedule) Helper
"""

from __future__ import annotations
import math
from typing import Optional
from dataclasses import dataclass, field


# ─── 1. Impact Factor Calculator (IRC 6, Cl. 208) ───────────────────────────

@dataclass
class ImpactFactorResult:
    vehicle_class: str
    span: float
    fill_depth: float
    impact_factor: float
    impact_percent: float
    formula_used: str
    notes: str


def compute_impact_factor(
    vehicle_class: str,
    span: float,
    fill_depth: float = 0.0,
    bridge_type: str = "RC",
) -> ImpactFactorResult:
    """
    Compute impact factor per IRC 6:2017, Cl. 208.

    Args:
        vehicle_class: 'CLASS_A', 'CLASS_B', 'CLASS_AA_TRACKED',
                       'CLASS_AA_WHEELED', '70R_TRACKED', '70R_WHEELED'
        span: effective span in meters
        fill_depth: depth of fill/cushion above top slab in meters
        bridge_type: 'RC' or 'STEEL'
    """
    notes = ""

    # IRC 112: No impact if fill depth > 0.6m
    if fill_depth > 0.6:
        return ImpactFactorResult(
            vehicle_class=vehicle_class,
            span=span,
            fill_depth=fill_depth,
            impact_factor=0.0,
            impact_percent=0.0,
            formula_used="Fill > 0.6m → No impact (IRC 112)",
            notes="Impact not considered when cushion/fill depth exceeds 600mm.",
        )

    if vehicle_class in ("CLASS_A", "CLASS_B"):
        if bridge_type == "RC":
            if span >= 45.0:
                impact = 4.5 / (6.0 + 45.0)
                formula = f"I = 4.5/(6+45) = {impact:.4f} [cap at 45m span]"
            else:
                impact = 4.5 / (6.0 + span)
                formula = f"I = 4.5/(6+{span}) = {impact:.4f}"
        else:  # Steel
            if span >= 45.0:
                impact = 9.0 / (13.5 + 45.0)
                formula = f"I = 9.0/(13.5+45) = {impact:.4f} [cap at 45m span]"
            else:
                impact = 9.0 / (13.5 + span)
                formula = f"I = 9.0/(13.5+{span}) = {impact:.4f}"

    elif vehicle_class in ("CLASS_AA_TRACKED", "70R_TRACKED"):
        if span <= 5.0:
            impact = 0.25
            formula = "25% for tracked, span ≤ 5m"
        elif span <= 9.0:
            # Linear interpolation: 25% at 5m → 10% at 9m
            impact = 0.25 - (0.15 * (span - 5.0) / 4.0)
            formula = f"Linear interpolation: 25% at 5m → 10% at 9m = {impact*100:.1f}%"
        else:
            impact = 0.10
            formula = "10% for tracked, span > 9m"

    elif vehicle_class in ("CLASS_AA_WHEELED", "70R_WHEELED"):
        if span <= 9.0:
            impact = 0.25
            formula = "25% for wheeled, span ≤ 9m"
        else:
            if bridge_type == "RC":
                impact = 4.5 / (6.0 + span) if span < 45 else 4.5 / (6.0 + 45.0)
                formula = f"I = 4.5/(6+{min(span,45)}) = {impact:.4f} [wheeled >9m uses Class A formula]"
            else:
                impact = 9.0 / (13.5 + span) if span < 45 else 9.0 / (13.5 + 45.0)
                formula = f"I = 9.0/(13.5+{min(span,45)}) = {impact:.4f}"
    else:
        impact = 0.0
        formula = "Unknown vehicle class"
        notes = f"Unrecognized vehicle class: {vehicle_class}"

    return ImpactFactorResult(
        vehicle_class=vehicle_class,
        span=span,
        fill_depth=fill_depth,
        impact_factor=round(impact, 4),
        impact_percent=round(impact * 100, 2),
        formula_used=formula,
        notes=notes,
    )


# ─── 2. Load Combination Generator (IRC 6:2017) ─────────────────────────────

@dataclass
class LoadCombination:
    name: str
    combination_type: str  # 'ULS' or 'SLS'
    sls_type: str  # 'RARE', 'FREQUENT', 'QUASI_PERMANENT', '' for ULS
    factors: dict  # load_case_label -> factor
    description: str
    staad_text: str


# IRC 6:2017 Table B.2 (ULS) and Table B.3 (SLS) partial safety factors
ULS_FACTORS = {
    "DL": {"adding": 1.35, "relieving": 1.00},
    "SIDL": {"adding": 1.35, "relieving": 1.00},
    "WC": {"adding": 1.75, "relieving": 1.00},
    "EP": {"adding": 1.50, "relieving": 1.00},
    "LL_LEADING": {"adding": 1.50},
    "LL_ACCOMP": {"adding": 1.15},
    "WP": {"adding": 1.00, "relieving": 1.00},
    "SC": {"adding": 1.20},
    "TEMP_LEADING": {"adding": 1.00},
    "TEMP_ACCOMP": {"adding": 0.60},
}

SLS_FACTORS = {
    "RARE": {
        "DL": 1.00, "SIDL": 1.00, "WC": 1.00, "EP": 1.00,
        "LL_LEADING": 1.00, "LL_ACCOMP": 0.75,
        "WP": 1.00, "SC": 1.00, "TEMP": 0.60,
    },
    "FREQUENT": {
        "DL": 1.00, "SIDL": 1.00, "WC": 1.00, "EP": 1.00,
        "LL_LEADING": 0.75, "LL_ACCOMP": 0.20,
        "WP": 1.00, "SC": 0.75, "TEMP": 0.50,
    },
    "QUASI_PERMANENT": {
        "DL": 1.00, "SIDL": 1.00, "WC": 1.00, "EP": 1.00,
        "LL_LEADING": 0.00, "LL_ACCOMP": 0.00,
        "WP": 1.00, "SC": 0.00, "TEMP": 0.50,
    },
}


def generate_load_combinations(
    load_case_map: dict,
    structure_type: str = "BOX_CULVERT",
    include_sls: bool = True,
) -> list[LoadCombination]:
    """
    Generate IRC 6:2017 load combinations.

    Args:
        load_case_map: Maps load type labels to STAAD load case numbers.
            Example: {"DL": 1, "SIDL": 2, "LL": 3, "EP": 4, "WP": 5, "SC": 6}
        structure_type: 'BOX_CULVERT' or 'BRIDGE_DECK'
        include_sls: Whether to include SLS combinations
    """
    combinations = []
    combo_num = 101

    # --- ULS Combinations ---

    # ULS 1: Box Empty — DL + SIDL + WC + LL + EP + SC (no water)
    factors = {}
    staad_parts = []
    desc_parts = []
    for label in ("DL", "SIDL", "WC", "EP", "SC"):
        if label in load_case_map:
            f = ULS_FACTORS.get(label, {}).get("adding", 1.35)
            factors[label] = f
            staad_parts.append(f"{load_case_map[label]} {f:.2f}")
            desc_parts.append(f"{label}×{f}")
    if "LL" in load_case_map:
        f = ULS_FACTORS["LL_LEADING"]["adding"]
        factors["LL"] = f
        staad_parts.append(f"{load_case_map['LL']} {f:.2f}")
        desc_parts.append(f"LL×{f}")

    if staad_parts:
        staad = f"LOAD COMBINATION {combo_num}\n" + " ".join(staad_parts)
        combinations.append(LoadCombination(
            name=f"ULS-{combo_num}: Box Empty",
            combination_type="ULS",
            sls_type="",
            factors=factors,
            description=f"DL + SIDL + WC + LL(leading) + EP + SC (No water) — {', '.join(desc_parts)}",
            staad_text=staad,
        ))
        combo_num += 1

    # ULS 2: Box Full — DL + SIDL + WC + LL + EP + WP + SC
    factors = {}
    staad_parts = []
    desc_parts = []
    for label in ("DL", "SIDL", "WC", "EP", "WP", "SC"):
        if label in load_case_map:
            f = ULS_FACTORS.get(label, {}).get("adding", 1.35)
            factors[label] = f
            staad_parts.append(f"{load_case_map[label]} {f:.2f}")
            desc_parts.append(f"{label}×{f}")
    if "LL" in load_case_map:
        f = ULS_FACTORS["LL_LEADING"]["adding"]
        factors["LL"] = f
        staad_parts.append(f"{load_case_map['LL']} {f:.2f}")
        desc_parts.append(f"LL×{f}")

    if staad_parts:
        staad = f"LOAD COMBINATION {combo_num}\n" + " ".join(staad_parts)
        combinations.append(LoadCombination(
            name=f"ULS-{combo_num}: Box Full",
            combination_type="ULS",
            sls_type="",
            factors=factors,
            description=f"DL + SIDL + WC + LL(leading) + EP + WP + SC — {', '.join(desc_parts)}",
            staad_text=staad,
        ))
        combo_num += 1

    # ULS 3: Max Earth Pressure — DL + EP(max) + LL(accompanying)
    factors = {}
    staad_parts = []
    for label in ("DL", "SIDL", "WC"):
        if label in load_case_map:
            f = ULS_FACTORS.get(label, {}).get("adding", 1.35)
            factors[label] = f
            staad_parts.append(f"{load_case_map[label]} {f:.2f}")
    if "EP" in load_case_map:
        f = 1.50
        factors["EP"] = f
        staad_parts.append(f"{load_case_map['EP']} {f:.2f}")
    if "LL" in load_case_map:
        f = ULS_FACTORS["LL_ACCOMP"]["adding"]
        factors["LL"] = f
        staad_parts.append(f"{load_case_map['LL']} {f:.2f}")

    if staad_parts:
        staad = f"LOAD COMBINATION {combo_num}\n" + " ".join(staad_parts)
        combinations.append(LoadCombination(
            name=f"ULS-{combo_num}: Max Earth Pressure",
            combination_type="ULS",
            sls_type="",
            factors=factors,
            description="DL + EP(leading) + LL(accompanying)",
            staad_text=staad,
        ))
        combo_num += 1

    # ULS 4: DL only (for relieving check)
    if "DL" in load_case_map:
        staad = f"LOAD COMBINATION {combo_num}\n{load_case_map['DL']} 1.00"
        combinations.append(LoadCombination(
            name=f"ULS-{combo_num}: DL Only (Relieving)",
            combination_type="ULS",
            sls_type="",
            factors={"DL": 1.00},
            description="Dead load only — for relieving effect check",
            staad_text=staad,
        ))
        combo_num += 1

    # --- SLS Combinations ---
    if include_sls:
        for sls_type, sls_factors in SLS_FACTORS.items():
            factors = {}
            staad_parts = []
            for label, lc_num in load_case_map.items():
                # Map label to SLS factor key
                factor_key = label
                if label == "LL":
                    factor_key = "LL_LEADING"
                elif label == "TEMP":
                    factor_key = "TEMP"
                f = sls_factors.get(factor_key, sls_factors.get(label, 1.00))
                if f > 0:
                    factors[label] = f
                    staad_parts.append(f"{lc_num} {f:.2f}")

            if staad_parts:
                staad = f"LOAD COMBINATION {combo_num}\n" + " ".join(staad_parts)
                combinations.append(LoadCombination(
                    name=f"SLS-{combo_num}: {sls_type.replace('_', ' ').title()}",
                    combination_type="SLS",
                    sls_type=sls_type,
                    factors=factors,
                    description=f"SLS {sls_type.replace('_', ' ').lower()} combination",
                    staad_text=staad,
                ))
                combo_num += 1

    return combinations


# ─── 3. Vehicle Position Sweep ───────────────────────────────────────────────

@dataclass
class SweepResult:
    position_offset: float
    total_load_on_members: float
    max_intensity_member: int
    overlaps_count: int


@dataclass
class SweepSummary:
    vehicle_class: str
    num_positions: int
    worst_position: float
    worst_member_id: int
    worst_intensity: float
    positions: list[SweepResult]


def vehicle_position_sweep(
    members: list,
    vehicle_class: str,
    bridge_width: float,
    kerb_clearance: float,
    step_size: float = 0.1,
    load_case: str = "LC1",
) -> dict:
    """
    Sweep vehicle transverse position across bridge width.
    Returns the worst-case position and envelope results.

    This is a calculation spec — actual overlap computation uses the existing engine.
    Returns positions and offsets for the frontend to iterate.
    """
    # Vehicle widths (CTC of outermost tracks/wheels)
    vehicle_widths = {
        "IRC_CLASS_AA": 2.05,   # 0.85m track + 2.05m CTC
        "IRC_70R": 2.06,        # 0.84m track + 2.06m CTC
        "IRC_CLASS_A": 1.80,    # wheel CTC
    }

    track_widths = {
        "IRC_CLASS_AA": 0.85,
        "IRC_70R": 0.84,
        "IRC_CLASS_A": 0.25,
    }

    kerb_clearances = {
        "IRC_CLASS_AA": 1.2,
        "IRC_70R": 1.2,
        "IRC_CLASS_A": 0.15,
    }

    ctc = vehicle_widths.get(vehicle_class, 2.05)
    tw = track_widths.get(vehicle_class, 0.85)
    kc = kerb_clearances.get(vehicle_class, kerb_clearance)

    # Calculate sweep range
    min_offset = kc  # minimum: kerb clearance from left edge
    # Vehicle occupies from offset to offset + tw (left track) and offset+ctc to offset+ctc+tw (right track)
    max_offset = bridge_width - kc - ctc - tw

    if max_offset < min_offset:
        max_offset = min_offset  # Vehicle can only fit in one position

    positions = []
    offset = min_offset
    while offset <= max_offset + 0.001:
        positions.append(round(offset, 3))
        offset += step_size

    return {
        "vehicle_class": vehicle_class,
        "ctc": ctc,
        "track_width": tw,
        "kerb_clearance": kc,
        "min_offset": round(min_offset, 3),
        "max_offset": round(max_offset, 3),
        "step_size": step_size,
        "num_positions": len(positions),
        "positions": positions,
    }


# ─── 4. Effective Width / Load Dispersion (IRC 112) ─────────────────────────

@dataclass
class DispersionResult:
    original_width: float
    dispersed_width: float
    original_length: float
    dispersed_length: float
    original_intensity: float
    dispersed_intensity: float
    fill_depth: float
    wearing_course: float
    dispersion_angle: float
    formula: str


def compute_dispersion(
    contact_width: float,
    contact_length: float,
    intensity: float,
    fill_depth: float,
    wearing_course_thickness: float = 0.075,
    dispersion_angle: float = 45.0,
) -> DispersionResult:
    """
    Compute load dispersion through fill per IRC 112.

    45° dispersion both longitudinally and transversely:
    dispersed_width = contact_width + 2 × (fill_depth + wearing_course) × tan(angle)
    dispersed_length = contact_length + 2 × (fill_depth + wearing_course) × tan(angle)
    """
    total_depth = fill_depth + wearing_course_thickness
    spread = 2.0 * total_depth * math.tan(math.radians(dispersion_angle))

    dispersed_w = contact_width + spread
    dispersed_l = contact_length + spread

    # Adjusted intensity to maintain total load
    original_area = contact_width * contact_length
    dispersed_area = dispersed_w * dispersed_l

    if dispersed_area > 0:
        dispersed_intensity = intensity * (original_area / dispersed_area)
    else:
        dispersed_intensity = intensity

    formula = (
        f"Dispersed width = {contact_width:.3f} + 2×({fill_depth:.3f}+{wearing_course_thickness:.3f})×tan({dispersion_angle}°) "
        f"= {dispersed_w:.3f}m\n"
        f"Dispersed length = {contact_length:.3f} + 2×({fill_depth:.3f}+{wearing_course_thickness:.3f})×tan({dispersion_angle}°) "
        f"= {dispersed_l:.3f}m\n"
        f"Dispersed intensity = {abs(intensity):.2f} × ({original_area:.4f}/{dispersed_area:.4f}) "
        f"= {abs(dispersed_intensity):.2f} kN/m"
    )

    return DispersionResult(
        original_width=contact_width,
        dispersed_width=round(dispersed_w, 4),
        original_length=contact_length,
        dispersed_length=round(dispersed_l, 4),
        original_intensity=intensity,
        dispersed_intensity=round(dispersed_intensity, 4),
        fill_depth=fill_depth,
        wearing_course=wearing_course_thickness,
        dispersion_angle=dispersion_angle,
        formula=formula,
    )


# ─── 5. Concrete Quantity Estimator ──────────────────────────────────────────

@dataclass
class QuantityItem:
    component: str
    length: float       # meters
    width: float        # meters (or depth)
    thickness: float    # meters
    volume: float       # m³
    formwork_area: float  # m²


@dataclass
class QuantityEstimate:
    items: list[QuantityItem]
    total_concrete_volume: float  # m³
    total_formwork_area: float    # m²
    steel_estimate_kg: float     # approximate steel weight
    concrete_weight_tonnes: float
    notes: str


def estimate_quantities(
    clear_span: float,
    clear_height: float,
    top_slab_thickness: float,
    bottom_slab_thickness: float,
    wall_thickness: float,
    culvert_length: float,
    num_cells: int = 1,
    haunch_size: float = 0.15,
    concrete_density: float = 25.0,  # kN/m³
    steel_percent: float = 1.0,      # % of concrete volume
) -> QuantityEstimate:
    """
    Estimate concrete, formwork, and steel quantities for box culvert.
    """
    items = []

    # Top slab
    total_width = num_cells * clear_span + (num_cells + 1) * wall_thickness
    top_vol = total_width * culvert_length * top_slab_thickness
    top_fw = total_width * culvert_length  # soffit formwork
    items.append(QuantityItem(
        component="Top Slab",
        length=culvert_length,
        width=total_width,
        thickness=top_slab_thickness,
        volume=round(top_vol, 3),
        formwork_area=round(top_fw, 2),
    ))

    # Bottom slab
    bot_vol = total_width * culvert_length * bottom_slab_thickness
    # No soffit formwork for bottom slab (on ground) but side formwork
    bot_fw = 2 * culvert_length * bottom_slab_thickness
    items.append(QuantityItem(
        component="Bottom Slab",
        length=culvert_length,
        width=total_width,
        thickness=bottom_slab_thickness,
        volume=round(bot_vol, 3),
        formwork_area=round(bot_fw, 2),
    ))

    # External walls (2 nos)
    wall_vol = wall_thickness * clear_height * culvert_length
    wall_fw = 2 * clear_height * culvert_length  # both faces
    for i, name in enumerate(["Left Wall", "Right Wall"]):
        items.append(QuantityItem(
            component=name,
            length=culvert_length,
            width=wall_thickness,
            thickness=clear_height,
            volume=round(wall_vol, 3),
            formwork_area=round(wall_fw, 2),
        ))

    # Middle walls (num_cells - 1)
    for i in range(num_cells - 1):
        mw_vol = wall_thickness * clear_height * culvert_length
        mw_fw = 2 * clear_height * culvert_length
        items.append(QuantityItem(
            component=f"Middle Wall {i+1}",
            length=culvert_length,
            width=wall_thickness,
            thickness=clear_height,
            volume=round(mw_vol, 3),
            formwork_area=round(mw_fw, 2),
        ))

    # Haunches (4 corners per cell × num_cells × 2 (top+bottom) × length)
    if haunch_size > 0:
        # Haunch is triangular: 0.5 × h × h × length
        num_haunches = num_cells * 4 * 2  # 4 corners, top and bottom
        haunch_vol = num_haunches * 0.5 * haunch_size * haunch_size * culvert_length
        items.append(QuantityItem(
            component=f"Haunches ({num_haunches} nos, {haunch_size}×{haunch_size}m)",
            length=culvert_length,
            width=haunch_size,
            thickness=haunch_size,
            volume=round(haunch_vol, 3),
            formwork_area=round(num_haunches * haunch_size * culvert_length, 2),
        ))

    total_vol = sum(item.volume for item in items)
    total_fw = sum(item.formwork_area for item in items)
    steel_kg = total_vol * concrete_density * 10 * (steel_percent / 100)  # approx
    concrete_wt = total_vol * concrete_density / 10  # tonnes

    return QuantityEstimate(
        items=items,
        total_concrete_volume=round(total_vol, 3),
        total_formwork_area=round(total_fw, 2),
        steel_estimate_kg=round(steel_kg, 1),
        concrete_weight_tonnes=round(concrete_wt, 2),
        notes=f"Steel estimated at {steel_percent}% of concrete by volume. Verify with detailed BBS.",
    )


# ─── 6. Base Pressure / Bearing Capacity Check ──────────────────────────────

@dataclass
class BearingCheckResult:
    total_vertical_load: float      # kN/m run
    base_width: float               # m
    eccentricity: float             # m (0 if concentric)
    max_base_pressure: float        # kN/m²
    min_base_pressure: float        # kN/m²
    allowable_bearing: float        # kN/m²
    utilization_ratio: float        # max_pressure / allowable
    status: str                     # 'PASS' or 'FAIL'
    formula: str


def check_bearing_pressure(
    total_vertical_load: float,
    base_width: float,
    eccentricity: float = 0.0,
    allowable_bearing: float = 150.0,
    culvert_length: float = 1.0,
) -> BearingCheckResult:
    """
    Check base pressure against allowable bearing capacity.

    q = P/A ± M/Z  (for eccentric loading)
    q_max = P/A × (1 + 6e/B)
    q_min = P/A × (1 - 6e/B)
    """
    area = base_width * culvert_length
    if area <= 0:
        return BearingCheckResult(
            total_vertical_load=total_vertical_load,
            base_width=base_width,
            eccentricity=eccentricity,
            max_base_pressure=0, min_base_pressure=0,
            allowable_bearing=allowable_bearing,
            utilization_ratio=0, status="ERROR",
            formula="Invalid base dimensions",
        )

    q_avg = total_vertical_load / area

    if eccentricity == 0:
        q_max = q_avg
        q_min = q_avg
        formula = f"q = P/A = {total_vertical_load:.1f}/{area:.2f} = {q_avg:.2f} kN/m²"
    else:
        factor = 6 * eccentricity / base_width
        q_max = q_avg * (1 + factor)
        q_min = q_avg * (1 - factor)
        formula = (
            f"q_max = P/A × (1 + 6e/B) = {q_avg:.2f} × (1 + 6×{eccentricity:.3f}/{base_width:.3f}) = {q_max:.2f} kN/m²\n"
            f"q_min = P/A × (1 - 6e/B) = {q_avg:.2f} × (1 - 6×{eccentricity:.3f}/{base_width:.3f}) = {q_min:.2f} kN/m²"
        )

    utilization = q_max / allowable_bearing if allowable_bearing > 0 else 999
    status = "PASS" if utilization <= 1.0 else "FAIL"

    return BearingCheckResult(
        total_vertical_load=round(total_vertical_load, 2),
        base_width=round(base_width, 3),
        eccentricity=round(eccentricity, 3),
        max_base_pressure=round(q_max, 2),
        min_base_pressure=round(q_min, 2),
        allowable_bearing=allowable_bearing,
        utilization_ratio=round(utilization, 3),
        status=status,
        formula=formula,
    )


# ─── 7. Uplift / Buoyancy Check ─────────────────────────────────────────────

@dataclass
class UpliftCheckResult:
    stabilizing_force: float    # kN/m run (weight of structure + fill)
    destabilizing_force: float  # kN/m run (uplift water pressure)
    factor_of_safety: float
    required_fos: float
    status: str                 # 'PASS' or 'FAIL'
    breakdown: dict


def check_uplift(
    clear_span: float,
    clear_height: float,
    top_slab_thickness: float,
    bottom_slab_thickness: float,
    wall_thickness: float,
    fill_depth: float,
    water_table_depth: float,
    num_cells: int = 1,
    gamma_concrete: float = 25.0,
    gamma_soil: float = 18.0,
    gamma_water: float = 10.0,
    required_fos: float = 1.1,
) -> UpliftCheckResult:
    """
    Check stability against flotation/uplift.

    FOS = Stabilizing Forces / Destabilizing Forces ≥ 1.1
    """
    total_width = num_cells * clear_span + (num_cells + 1) * wall_thickness
    total_height = clear_height + top_slab_thickness + bottom_slab_thickness

    # Stabilizing: weight of structure + fill (per meter run)
    # Top slab
    w_top = total_width * top_slab_thickness * gamma_concrete
    # Bottom slab
    w_bot = total_width * bottom_slab_thickness * gamma_concrete
    # Walls
    w_walls = (num_cells + 1) * wall_thickness * clear_height * gamma_concrete
    # Fill on top
    w_fill = total_width * fill_depth * gamma_soil

    stabilizing = w_top + w_bot + w_walls + w_fill

    # Destabilizing: uplift water pressure
    # Height of water below base = total_height + fill_depth - water_table_depth
    submerged_height = total_height + fill_depth - water_table_depth
    if submerged_height <= 0:
        submerged_height = 0

    destabilizing = total_width * submerged_height * gamma_water

    if destabilizing > 0:
        fos = stabilizing / destabilizing
    else:
        fos = 999.0  # No uplift

    status = "PASS" if fos >= required_fos else "FAIL"

    breakdown = {
        "top_slab_weight": round(w_top, 2),
        "bottom_slab_weight": round(w_bot, 2),
        "walls_weight": round(w_walls, 2),
        "fill_weight": round(w_fill, 2),
        "total_stabilizing": round(stabilizing, 2),
        "submerged_height": round(submerged_height, 3),
        "uplift_pressure": round(destabilizing, 2),
    }

    return UpliftCheckResult(
        stabilizing_force=round(stabilizing, 2),
        destabilizing_force=round(destabilizing, 2),
        factor_of_safety=round(fos, 3),
        required_fos=required_fos,
        status=status,
        breakdown=breakdown,
    )


# ─── 8. Reinforcement Helper (IS 456 / IRC 112) ─────────────────────────────

@dataclass
class ReinforcementResult:
    element: str
    max_bm: float           # kN·m
    effective_depth: float  # mm
    breadth: float          # mm
    fck: float              # MPa
    fy: float               # MPa
    ast_required: float     # mm²
    ast_min: float          # mm²
    ast_provided: float     # mm²
    bar_dia: int            # mm
    spacing: int            # mm
    status: str
    formula: str


def compute_reinforcement(
    max_bm: float,
    slab_thickness: float,
    clear_cover: float = 40.0,
    bar_diameter: int = 16,
    breadth: float = 1000.0,
    fck: float = 30.0,
    fy: float = 500.0,
) -> ReinforcementResult:
    """
    Calculate required reinforcement per IS 456 / IRC 112.

    Uses simplified rectangular stress block method.
    Ast = (0.5 × fck / fy) × [1 - √(1 - 4.6Mu/(fck × b × d²))] × b × d
    """
    d = slab_thickness * 1000 - clear_cover - bar_diameter / 2  # effective depth in mm
    b = breadth  # mm

    Mu = abs(max_bm) * 1e6  # Convert kN·m to N·mm

    # Check if section is adequate
    Mu_lim = 0.133 * fck * b * d * d  # Limiting moment for singly reinforced

    if Mu > Mu_lim:
        status = "DOUBLY REINFORCED REQUIRED"
        # Still calculate for singly reinforced part
        ast_req = (0.5 * fck / fy) * (1 - math.sqrt(max(0, 1 - 4.6 * Mu / (fck * b * d * d)))) * b * d
    else:
        status = "OK"
        ratio = 4.6 * Mu / (fck * b * d * d)
        if ratio > 1:
            ratio = 1
        ast_req = (0.5 * fck / fy) * (1 - math.sqrt(max(0, 1 - ratio))) * b * d

    # Minimum steel (IS 456, Cl. 26.5.2.1): 0.12% for HYSD bars
    ast_min = 0.12 / 100 * b * slab_thickness * 1000

    ast_design = max(ast_req, ast_min)

    # Calculate spacing for given bar diameter
    bar_area = math.pi * bar_diameter ** 2 / 4
    if ast_design > 0:
        spacing = int(bar_area / ast_design * b)
        spacing = min(spacing, 300)  # Max spacing 300mm or 3d
        spacing = max(spacing, 75)   # Min practical spacing
        # Round down to nearest 5mm
        spacing = (spacing // 5) * 5
    else:
        spacing = 200

    ast_provided = bar_area / spacing * b

    formula = (
        f"d = {slab_thickness*1000:.0f} - {clear_cover:.0f} - {bar_diameter/2:.0f} = {d:.0f}mm\n"
        f"Mu = {max_bm:.2f} kN·m = {Mu:.0f} N·mm\n"
        f"Ast = (0.5×{fck}/{fy}) × [1 - √(1 - 4.6×{Mu:.0f}/({fck}×{b:.0f}×{d:.0f}²))] × {b:.0f} × {d:.0f}\n"
        f"Ast_req = {ast_req:.1f} mm²\n"
        f"Ast_min = 0.12% × {b:.0f} × {slab_thickness*1000:.0f} = {ast_min:.1f} mm²\n"
        f"Provide: {bar_diameter}mm dia @ {spacing}mm c/c → Ast = {ast_provided:.1f} mm²"
    )

    return ReinforcementResult(
        element="Slab",
        max_bm=max_bm,
        effective_depth=round(d, 1),
        breadth=breadth,
        fck=fck,
        fy=fy,
        ast_required=round(ast_design, 1),
        ast_min=round(ast_min, 1),
        ast_provided=round(ast_provided, 1),
        bar_dia=bar_diameter,
        spacing=spacing,
        status=status,
        formula=formula,
    )


# ─── 9. Multi-Cell Auto-Generation ──────────────────────────────────────────

def generate_multicell_members(
    num_cells: int,
    clear_span: float,
    clear_height: float,
    wall_thickness: float,
    slab_thickness: float,
    start_id: int = 1001,
) -> list[dict]:
    """
    Generate member definitions for a multi-cell box culvert.
    Returns members for top slab, bottom slab, walls.
    """
    members = []
    member_id = start_id

    total_width = num_cells * clear_span + (num_cells + 1) * wall_thickness

    # Top slab members (divide into strips)
    num_strips = max(num_cells * 4, 8)
    strip_width = total_width / num_strips
    for i in range(num_strips):
        members.append({
            "id": member_id,
            "start": round(i * strip_width, 4),
            "end": round((i + 1) * strip_width, 4),
            "group": "TOP_SLAB",
            "label": f"TS-{i+1}",
        })
        member_id += 1

    # Wall members
    for c in range(num_cells + 1):
        wall_start = c * (clear_span + wall_thickness)
        wall_end = wall_start + wall_thickness
        group = "LEFT_WALL" if c == 0 else ("RIGHT_WALL" if c == num_cells else f"MIDDLE_WALL_{c}")
        members.append({
            "id": member_id,
            "start": round(wall_start, 4),
            "end": round(wall_end, 4),
            "group": group,
            "label": f"W-{c+1}",
        })
        member_id += 1

    # Bottom slab members
    for i in range(num_strips):
        members.append({
            "id": member_id,
            "start": round(i * strip_width, 4),
            "end": round((i + 1) * strip_width, 4),
            "group": "BOTTOM_SLAB",
            "label": f"BS-{i+1}",
        })
        member_id += 1

    return members


# ─── 10. Skew Angle Correction ──────────────────────────────────────────────

@dataclass
class SkewCorrectionResult:
    skew_angle: float
    normal_span: float
    skew_span: float
    moment_correction_factor: float
    shear_correction_factor: float
    effective_width_factor: float
    notes: str


def compute_skew_correction(
    skew_angle: float,
    normal_span: float,
) -> SkewCorrectionResult:
    """
    Compute correction factors for skew box culvert.

    Skew span = normal span / cos(θ)
    Moment increases ~5-30% for skew >10°
    """
    angle_rad = math.radians(skew_angle)
    cos_a = math.cos(angle_rad)

    skew_span = normal_span / cos_a if cos_a > 0 else normal_span

    # Empirical correction factors (from research literature)
    if skew_angle <= 10:
        moment_cf = 1.0
        shear_cf = 1.0
    elif skew_angle <= 20:
        moment_cf = 1.0 + 0.01 * (skew_angle - 10)
        shear_cf = 1.0 + 0.015 * (skew_angle - 10)
    elif skew_angle <= 30:
        moment_cf = 1.10 + 0.015 * (skew_angle - 20)
        shear_cf = 1.15 + 0.02 * (skew_angle - 20)
    elif skew_angle <= 45:
        moment_cf = 1.25 + 0.01 * (skew_angle - 30)
        shear_cf = 1.35 + 0.015 * (skew_angle - 30)
    else:
        moment_cf = 1.40
        shear_cf = 1.60

    width_factor = cos_a

    notes = ""
    if skew_angle > 30:
        notes = "⚠️ Skew > 30°: Consider 3D FE analysis. Correction factors are approximate."
    elif skew_angle > 15:
        notes = "Moderate skew: Correction factors applied. Verify with detailed analysis."

    return SkewCorrectionResult(
        skew_angle=skew_angle,
        normal_span=round(normal_span, 3),
        skew_span=round(skew_span, 3),
        moment_correction_factor=round(moment_cf, 3),
        shear_correction_factor=round(shear_cf, 3),
        effective_width_factor=round(width_factor, 3),
        notes=notes,
    )


# ─── 11. STAAD .std File Generator ──────────────────────────────────────────

def generate_staad_file(
    project_name: str,
    clear_span: float,
    clear_height: float,
    top_slab_thickness: float,
    bottom_slab_thickness: float,
    wall_thickness: float,
    num_cells: int = 1,
    fck: float = 30.0,
    member_loads_text: str = "",
    load_combinations_text: str = "",
) -> str:
    """
    Generate a complete STAAD.Pro input file (.std) for a 2D frame model
    of a box culvert.
    """
    total_width = num_cells * clear_span + (num_cells + 1) * wall_thickness
    total_height = clear_height + top_slab_thickness + bottom_slab_thickness

    lines = []

    # Header
    lines.append(f"STAAD PLANE")
    lines.append(f"START JOB INFORMATION")
    lines.append(f"ENGINEER DATE {project_name}")
    lines.append(f"END JOB INFORMATION")
    lines.append(f"INPUT WIDTH 79")
    lines.append(f"UNIT METER KN")
    lines.append("")

    # Joint coordinates (2D frame model)
    lines.append("JOINT COORDINATES")
    node_id = 1
    nodes = {}

    # Bottom slab joints
    for c in range(num_cells + 1):
        x = c * (clear_span + wall_thickness)
        nodes[f"BL{c}"] = node_id
        lines.append(f"{node_id} {x:.4f} 0.000 0.000")
        node_id += 1
        nodes[f"BR{c}"] = node_id
        x2 = x + wall_thickness
        lines.append(f"{node_id} {x2:.4f} 0.000 0.000")
        node_id += 1

    # Top slab joints
    y_top = clear_height + bottom_slab_thickness
    for c in range(num_cells + 1):
        x = c * (clear_span + wall_thickness)
        nodes[f"TL{c}"] = node_id
        lines.append(f"{node_id} {x:.4f} {y_top:.4f} 0.000")
        node_id += 1
        nodes[f"TR{c}"] = node_id
        x2 = x + wall_thickness
        lines.append(f"{node_id} {x2:.4f} {y_top:.4f} 0.000")
        node_id += 1

    lines.append("")

    # Member incidences
    lines.append("MEMBER INCIDENCES")
    mem_id = 1

    # Bottom slab members (connect bottom joints)
    for c in range(num_cells):
        start_node = nodes[f"BR{c}"]
        end_node = nodes[f"BL{c+1}"]
        lines.append(f"{mem_id} {start_node} {end_node}")
        mem_id += 1

    # Wall members (vertical)
    for c in range(num_cells + 1):
        start_node = nodes[f"BR{c}"] if c < num_cells + 1 else nodes[f"BL{c}"]
        end_node = nodes[f"TL{c}"]
        # Use appropriate bottom and top nodes
        bn = nodes.get(f"BR{c}", nodes.get(f"BL{c}"))
        tn = nodes.get(f"TL{c}", nodes.get(f"TR{c}"))
        lines.append(f"{mem_id} {bn} {tn}")
        mem_id += 1

    # Top slab members
    for c in range(num_cells):
        start_node = nodes[f"TR{c}"]
        end_node = nodes[f"TL{c+1}"]
        lines.append(f"{mem_id} {start_node} {end_node}")
        mem_id += 1
    lines.append("")

    # Member properties
    E = 5000 * math.sqrt(fck) * 1000  # kN/m²
    lines.append("MEMBER PROPERTY")
    lines.append(f"* Top slab: {top_slab_thickness*1000:.0f}mm thick")
    lines.append(f"* Bottom slab: {bottom_slab_thickness*1000:.0f}mm thick")
    lines.append(f"* Walls: {wall_thickness*1000:.0f}mm thick")
    lines.append(f"1 TO {mem_id-1} PRIS YD {top_slab_thickness:.3f} ZD 1.000")
    lines.append("")

    # Constants
    lines.append("CONSTANTS")
    lines.append(f"E {E:.0f} ALL")
    lines.append(f"POISSON 0.2 ALL")
    lines.append(f"DENSITY {25.0:.1f} ALL")
    lines.append("")

    # Supports
    lines.append("SUPPORTS")
    bottom_nodes = []
    for c in range(num_cells + 1):
        bottom_nodes.append(str(nodes[f"BL{c}"]))
        bottom_nodes.append(str(nodes[f"BR{c}"]))
    lines.append(f"{' '.join(bottom_nodes)} FIXED BUT MZ")
    lines.append("")

    # Load cases
    lines.append("LOAD 1 LOADTYPE Dead TITLE SELF WEIGHT")
    lines.append("SELFWEIGHT Y -1.0")
    lines.append("")

    # Insert member loads if provided
    if member_loads_text:
        lines.append("LOAD 2 LOADTYPE Live TITLE APPLIED LOADS")
        lines.append(member_loads_text)
        lines.append("")

    # Load combinations
    if load_combinations_text:
        lines.append(load_combinations_text)
        lines.append("")

    # Analysis
    lines.append("PERFORM ANALYSIS")
    lines.append("")
    lines.append("FINISH")

    return "\n".join(lines)


# ─── 12. BBS (Bar Bending Schedule) Helper ───────────────────────────────────

@dataclass
class BBSItem:
    bar_mark: str
    member: str
    bar_dia: int          # mm
    shape: str            # 'STRAIGHT', 'L-BEND', 'U-BEND', 'CRANKED'
    cut_length: float     # m
    quantity: int
    total_length: float   # m
    weight_per_m: float   # kg/m
    total_weight: float   # kg


@dataclass
class BBSSchedule:
    items: list[BBSItem]
    total_steel_weight: float  # kg
    wastage_percent: float
    total_with_wastage: float  # kg


def generate_bbs(
    clear_span: float,
    clear_height: float,
    top_slab_thickness: float,
    bottom_slab_thickness: float,
    wall_thickness: float,
    culvert_length: float,
    num_cells: int = 1,
    clear_cover: float = 40,  # mm
    main_bar_dia: int = 16,
    dist_bar_dia: int = 12,
    main_spacing: int = 150,
    dist_spacing: int = 200,
) -> BBSSchedule:
    """
    Generate BBS for box culvert.
    Weights per meter: 8mm=0.395, 10mm=0.617, 12mm=0.888, 16mm=1.578, 20mm=2.466, 25mm=3.853, 32mm=6.313
    """
    weight_per_m = {
        8: 0.395, 10: 0.617, 12: 0.888, 16: 1.578,
        20: 2.466, 25: 3.853, 32: 6.313,
    }

    items = []
    bar_mark = 1
    total_width = num_cells * clear_span + (num_cells + 1) * wall_thickness

    # Development length (approx 40d)
    ld_main = 40 * main_bar_dia / 1000  # m
    ld_dist = 40 * dist_bar_dia / 1000

    cc = clear_cover / 1000  # m

    # --- Top Slab Main Bars ---
    cut_len = total_width - 2 * cc + 2 * (0.3)  # + 2 hooks/bends ~ 300mm
    num_bars = int(culvert_length * 1000 / main_spacing) + 1
    wpm = weight_per_m.get(main_bar_dia, 1.578)
    items.append(BBSItem(
        bar_mark=f"A{bar_mark}",
        member="Top Slab Main (Bottom)",
        bar_dia=main_bar_dia,
        shape="STRAIGHT",
        cut_length=round(cut_len, 3),
        quantity=num_bars,
        total_length=round(cut_len * num_bars, 2),
        weight_per_m=wpm,
        total_weight=round(cut_len * num_bars * wpm, 2),
    ))
    bar_mark += 1

    # Top Slab Distribution Bars
    cut_len_d = culvert_length - 2 * cc
    num_bars_d = int(total_width * 1000 / dist_spacing) + 1
    wpm_d = weight_per_m.get(dist_bar_dia, 0.888)
    items.append(BBSItem(
        bar_mark=f"A{bar_mark}",
        member="Top Slab Distribution",
        bar_dia=dist_bar_dia,
        shape="STRAIGHT",
        cut_length=round(cut_len_d, 3),
        quantity=num_bars_d,
        total_length=round(cut_len_d * num_bars_d, 2),
        weight_per_m=wpm_d,
        total_weight=round(cut_len_d * num_bars_d * wpm_d, 2),
    ))
    bar_mark += 1

    # --- Bottom Slab Main Bars ---
    items.append(BBSItem(
        bar_mark=f"A{bar_mark}",
        member="Bottom Slab Main (Top)",
        bar_dia=main_bar_dia,
        shape="STRAIGHT",
        cut_length=round(total_width - 2 * cc + 2 * 0.3, 3),
        quantity=num_bars,
        total_length=round((total_width - 2 * cc + 0.6) * num_bars, 2),
        weight_per_m=wpm,
        total_weight=round((total_width - 2 * cc + 0.6) * num_bars * wpm, 2),
    ))
    bar_mark += 1

    # Bottom Slab Distribution
    items.append(BBSItem(
        bar_mark=f"A{bar_mark}",
        member="Bottom Slab Distribution",
        bar_dia=dist_bar_dia,
        shape="STRAIGHT",
        cut_length=round(cut_len_d, 3),
        quantity=num_bars_d,
        total_length=round(cut_len_d * num_bars_d, 2),
        weight_per_m=wpm_d,
        total_weight=round(cut_len_d * num_bars_d * wpm_d, 2),
    ))
    bar_mark += 1

    # --- Wall Main Bars (each external wall) ---
    wall_cut = clear_height - 2 * cc + 2 * 0.3 + ld_main  # + dev length into slab
    num_wall_bars = int(culvert_length * 1000 / main_spacing) + 1
    for wall_name in ["Left Wall", "Right Wall"]:
        items.append(BBSItem(
            bar_mark=f"A{bar_mark}",
            member=f"{wall_name} Main (Inner Face)",
            bar_dia=main_bar_dia,
            shape="L-BEND",
            cut_length=round(wall_cut, 3),
            quantity=num_wall_bars,
            total_length=round(wall_cut * num_wall_bars, 2),
            weight_per_m=wpm,
            total_weight=round(wall_cut * num_wall_bars * wpm, 2),
        ))
        bar_mark += 1

    # Wall Distribution Bars
    for wall_name in ["Left Wall", "Right Wall"]:
        wall_dist_cut = culvert_length - 2 * cc
        wall_dist_qty = int(clear_height * 1000 / dist_spacing) + 1
        items.append(BBSItem(
            bar_mark=f"A{bar_mark}",
            member=f"{wall_name} Distribution",
            bar_dia=dist_bar_dia,
            shape="STRAIGHT",
            cut_length=round(wall_dist_cut, 3),
            quantity=wall_dist_qty,
            total_length=round(wall_dist_cut * wall_dist_qty, 2),
            weight_per_m=wpm_d,
            total_weight=round(wall_dist_cut * wall_dist_qty * wpm_d, 2),
        ))
        bar_mark += 1

    # Middle walls
    for mw in range(num_cells - 1):
        items.append(BBSItem(
            bar_mark=f"A{bar_mark}",
            member=f"Middle Wall {mw+1} Main",
            bar_dia=main_bar_dia,
            shape="L-BEND",
            cut_length=round(wall_cut, 3),
            quantity=num_wall_bars * 2,  # both faces
            total_length=round(wall_cut * num_wall_bars * 2, 2),
            weight_per_m=wpm,
            total_weight=round(wall_cut * num_wall_bars * 2 * wpm, 2),
        ))
        bar_mark += 1

    total_wt = sum(item.total_weight for item in items)
    wastage = 3.0  # 3% wastage
    total_with_wastage = total_wt * (1 + wastage / 100)

    return BBSSchedule(
        items=items,
        total_steel_weight=round(total_wt, 2),
        wastage_percent=wastage,
        total_with_wastage=round(total_with_wastage, 2),
    )
