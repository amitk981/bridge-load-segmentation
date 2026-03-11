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
import re
from dataclasses import dataclass, field
import numpy as np


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


# ─── 3A. Longitudinal Moving-Load Critical Position Sweep ───────────────────

@dataclass
class CriticalValue:
    value: float
    lead_position: float
    member_id: int


@dataclass
class MemberGroupCritical:
    group: str
    max_sagging_moment: CriticalValue
    max_hogging_moment: CriticalValue
    max_shear_force: CriticalValue


def compute_longitudinal_critical_positions(
    clear_span: float = 4.0,
    clear_height: float = 3.0,
    top_slab_thickness: float = 0.30,
    bottom_slab_thickness: float = 0.35,
    wall_thickness: float = 0.30,
    mid_wall_thickness: float = 0.30,
    num_cells: int = 1,
    increment: float = 0.1,
    fck: float = 30.0,
    vehicles: Optional[list[str]] = None,
    custom_vehicles: Optional[list[dict]] = None,
) -> dict:
    """
    Sweep longitudinal vehicle position and find critical response positions.

    Model:
    - 2D frame (top slab, bottom slab, side walls, intermediate walls)
    - Bottom nodes restrained in Ux and Uy, rotation free (FIXED BUT MZ analogue)
    - Moving axle loads applied on top slab elements

    Notes on load trains:
    - 70R wheeled / Class A / bogie loads are represented as concentrated axle
      loads derived from IRC 6:2017 tabulations used in practice.
    - 70R tracked is represented as two equivalent concentrated loads.
    """
    if clear_span <= 0:
        raise ValueError("clear_span must be > 0")
    if clear_height <= 0:
        raise ValueError("clear_height must be > 0")
    if increment <= 0:
        raise ValueError("increment must be > 0")
    if num_cells < 1:
        raise ValueError("num_cells must be >= 1")

    vehicle_library = _irc_vehicle_library()
    selected = []
    if custom_vehicles:
        # Expect custom vehicles to already include required metadata
        for v in custom_vehicles:
            if not v:
                continue
            if not v.get("axle_loads_kN"):
                continue
            vcode = v.get("vehicle_code") or v.get("code") or v.get("name") or "CUSTOM"
            selected.append({
                "vehicle_code": vcode,
                "name": v.get("name", vcode),
                "notes": v.get("notes", "Custom moving load vehicle"),
                "axle_loads_kN": v.get("axle_loads_kN", []),
                "axle_spacings_m": v.get("axle_spacings_m", []),
            })
    else:
        selected_vehicle_codes = vehicles or list(vehicle_library.keys())
        selected = [code for code in selected_vehicle_codes if code in vehicle_library]
        if not selected:
            raise ValueError("No valid vehicle codes selected")

    model = _build_longitudinal_frame_model(
        clear_span=clear_span,
        clear_height=clear_height,
        top_slab_thickness=top_slab_thickness,
        bottom_slab_thickness=bottom_slab_thickness,
        wall_thickness=wall_thickness,
        mid_wall_thickness=mid_wall_thickness,
        num_cells=num_cells,
        fck=fck,
    )

    results = []
    total_length = model["total_length"]
    groups = ["TOP_SLAB", "BOTTOM_SLAB", "SIDE_WALL", "INTERMEDIATE_WALL"]

    for v_code in selected:
        if custom_vehicles:
            vehicle = v_code
            v_code = vehicle.get("vehicle_code", "CUSTOM")
        else:
            vehicle = vehicle_library[v_code]

        axle_loads = list(vehicle["axle_loads_kN"])
        axle_offsets = _axle_offsets(list(vehicle.get("axle_spacings_m", [])))
        if len(axle_offsets) != len(axle_loads):
            n = min(len(axle_offsets), len(axle_loads))
            axle_offsets = axle_offsets[:n]
            axle_loads = axle_loads[:n]
        train_length = axle_offsets[-1] if axle_offsets else 0.0

        envelopes = _init_group_envelopes(groups)

        lead = -train_length
        positions_count = 0
        
        # We will collect envelope points for all elements
        # element_id -> { a_point: {"max": -inf, "min": inf, "X": x, "Y": y} }
        envelope_points = {elem["id"]: {} for elem in model["elements"]}
        
        while lead <= total_length + 1e-9:
            positions_count += 1

            response = _solve_frame_for_vehicle_position(
                model=model,
                lead_position=lead,
                axle_offsets=axle_offsets,
                axle_loads=axle_loads,
                compute_bmd=True,
            )
            
            _update_group_envelopes(envelopes, response["group_forces"], lead)
            
            # Accumulate true BMD Envelope
            for group, gdata in response["group_forces"].items():
                for elem_data in gdata.get("elements", []):
                    eid = elem_data["id"]
                    for pt in elem_data["bmd"]:
                        a = pt["a"]
                        M = pt["M"]
                        if a not in envelope_points[eid]:
                            envelope_points[eid][a] = {
                                "X": pt["X"], "Y": pt["Y"], 
                                "M_max": M, "M_min": M
                            }
                        else:
                            if M > envelope_points[eid][a]["M_max"]:
                                envelope_points[eid][a]["M_max"] = M
                            if M < envelope_points[eid][a]["M_min"]:
                                envelope_points[eid][a]["M_min"] = M

            lead += increment

        group_results = []
        for group in groups:
            env = envelopes[group]
            
            # Fetch the envelope points for elements in this group
            # We construct the envelope array for the UI
            group_elements_bmd = []
            for elem in model["elements"]:
                if elem["group"] == group:
                    pts_dict = envelope_points[elem["id"]]
                    sorted_a = sorted(pts_dict.keys())
                    pts_list = [
                        {
                            "a": a, 
                            "X": pts_dict[a]["X"], 
                            "Y": pts_dict[a]["Y"], 
                            "M_max": round(pts_dict[a]["M_max"], 3), 
                            "M_min": round(pts_dict[a]["M_min"], 3)
                        } 
                        for a in sorted_a
                    ]
                    group_elements_bmd.append({
                        "id": elem["id"],
                        "points": pts_list
                    })

            # For backward compatibility with the critical BMD structure, assign the envelope to all critical effects
            for effect in ["sagging", "hogging", "shear"]:
                # The UI now expects 'bmd' to actually be the envelope of the group!
                env[effect]["bmd"] = group_elements_bmd
                
            group_results.append({
                "group": group,
                "max_sagging_moment": env["sagging"],
                "max_hogging_moment": env["hogging"],
                "max_shear_force": env["shear"],
            })

        results.append({
            "vehicle_code": v_code,
            "vehicle_name": vehicle.get("name", v_code),
            "notes": vehicle.get("notes", ""),
            "axle_loads_kN": axle_loads,
            "axle_offsets_m": axle_offsets,
            "train_length": round(train_length, 3),
            "num_positions": positions_count,
            "group_results": group_results,
        })

    return {
        "model": {
            "clear_span": clear_span,
            "clear_height": clear_height,
            "top_slab_thickness": top_slab_thickness,
            "bottom_slab_thickness": bottom_slab_thickness,
            "wall_thickness": wall_thickness,
            "mid_wall_thickness": mid_wall_thickness,
            "num_cells": num_cells,
            "sweep_increment": increment,
            "total_length": round(total_length, 3),
        },
        "vehicles": results,
    }


def parse_staad_moving_load(text: str) -> dict:
    """
    Parse STAAD.Pro DEFINE MOVING LOAD / LOAD GENERATION blocks.

    Returns:
        {
            "types": {type_id: {"loads": [...], "spacings": [...]}},
            "generations": [ {"type_id": int, "x": float|None, "y": float|None, "z": float|None, "xinc": float|None, "count": int|None} ],
            "vehicle_defs": [ {"vehicle_code", "name", "notes", "axle_loads_kN", "axle_spacings_m"} ],
            "used_type_ids": [...],
            "warnings": [...],
            "errors": [...],
        }
    """
    if not text or not str(text).strip():
        return {
            "types": {},
            "generations": [],
            "vehicle_defs": [],
            "used_type_ids": [],
            "warnings": [],
            "errors": ["Moving load text is empty."],
        }

    lines = str(text).replace("\r", "\n").split("\n")
    types: dict[int, dict] = {}
    generations: list[dict] = []
    warnings: list[str] = []
    errors: list[str] = []

    def _extract_numbers(s: str) -> list[float]:
        return [float(x) for x in re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", s)]

    def _is_keyword_line(s: str) -> bool:
        return bool(re.match(r"^(TYPE|DIST|LOAD\s+GENERATION|DEFINE|PERFORM|END)\b", s, re.IGNORECASE))

    def _is_numeric_line(s: str) -> bool:
        if not s:
            return False
        return bool(re.match(r"^[\s0-9+\-\.eE]+-?$", s))

    i = 0
    current_type_id = None
    current_generation_count = None

    while i < len(lines):
        raw = lines[i]
        line = raw.strip()
        if not line:
            i += 1
            continue
        if line.startswith(";") or line.startswith("*"):
            i += 1
            continue

        # LOAD GENERATION header (optional count)
        m_gen = re.match(r"^LOAD\s+GENERATION\s*(\d+)?", line, re.IGNORECASE)
        if m_gen:
            if m_gen.group(1):
                current_generation_count = int(m_gen.group(1))
            i += 1
            continue

        # TYPE n LOAD ...
        m_type = re.match(r"^TYPE\s+(\d+)\s+LOAD\s*(.*)$", line, re.IGNORECASE)
        if m_type:
            type_id = int(m_type.group(1))
            payload = m_type.group(2) or ""
            loads = _extract_numbers(payload)

            j = i + 1
            while j < len(lines):
                nxt = lines[j].strip()
                if not nxt:
                    j += 1
                    continue
                if _is_keyword_line(nxt):
                    break
                if _is_numeric_line(nxt):
                    loads.extend(_extract_numbers(nxt))
                    j += 1
                    continue
                break

            if not loads:
                warnings.append(f"TYPE {type_id}: no LOAD values found.")
            types[type_id] = {"loads": loads, "spacings": []}
            current_type_id = type_id
            i = j
            continue

        # DIST ...
        m_dist = re.match(r"^DIST\s*(.*)$", line, re.IGNORECASE)
        if m_dist:
            payload = m_dist.group(1) or ""
            spacings = _extract_numbers(payload)

            j = i + 1
            while j < len(lines):
                nxt = lines[j].strip()
                if not nxt:
                    j += 1
                    continue
                if _is_keyword_line(nxt):
                    break
                if _is_numeric_line(nxt):
                    spacings.extend(_extract_numbers(nxt))
                    j += 1
                    continue
                break

            if current_type_id is None:
                warnings.append("DIST found before any TYPE definition; ignoring.")
            else:
                types.setdefault(current_type_id, {"loads": [], "spacings": []})
                types[current_type_id]["spacings"] = spacings
            i = j
            continue

        # Generation line: TYPE n x y z XINC dx
        if re.search(r"\bTYPE\s+\d+\b", line, re.IGNORECASE) and re.search(r"\bXINC\b", line, re.IGNORECASE):
            m = re.search(r"\bTYPE\s+(\d+)\b", line, re.IGNORECASE)
            type_id = int(m.group(1)) if m else None
            nums = _extract_numbers(line)
            x = y = z = xinc = None
            if type_id is not None:
                # nums likely: [type_id, x, y, z, xinc]
                if len(nums) >= 4:
                    x = nums[1]
                    y = nums[2]
                    z = nums[3]
                if len(nums) >= 5:
                    xinc = nums[-1]
            generations.append({
                "type_id": type_id,
                "x": x,
                "y": y,
                "z": z,
                "xinc": xinc,
                "count": current_generation_count,
            })
            i += 1
            continue

        i += 1

    if not types:
        errors.append("No TYPE definitions found in moving load text.")

    used_type_ids = [g["type_id"] for g in generations if g.get("type_id") is not None]
    if not used_type_ids:
        used_type_ids = sorted(types.keys())

    vehicle_defs = []
    for type_id in used_type_ids:
        if type_id not in types:
            warnings.append(f"LOAD GENERATION references TYPE {type_id}, but it is not defined.")
            continue
        loads = list(types[type_id].get("loads", []))
        spacings = list(types[type_id].get("spacings", []))
        if not loads:
            warnings.append(f"TYPE {type_id}: no loads found.")
            continue

        if len(spacings) >= len(loads):
            spacings = spacings[:max(0, len(loads) - 1)]
        if len(spacings) < max(0, len(loads) - 1):
            warnings.append(
                f"TYPE {type_id}: spacing count ({len(spacings)}) does not match loads ({len(loads)})."
            )

        gen_note = ""
        gen = next((g for g in generations if g.get("type_id") == type_id), None)
        if gen:
            parts = []
            if gen.get("x") is not None:
                parts.append(f"x={gen['x']}")
            if gen.get("y") is not None:
                parts.append(f"y={gen['y']}")
            if gen.get("z") is not None:
                parts.append(f"z={gen['z']}")
            if gen.get("xinc") is not None:
                parts.append(f"xinc={gen['xinc']}")
            if gen.get("count") is not None:
                parts.append(f"count={gen['count']}")
            if parts:
                gen_note = " | " + ", ".join(parts)

        vehicle_defs.append({
            "vehicle_code": f"STAAD_TYPE_{type_id}",
            "name": f"STAAD Type {type_id}",
            "notes": f"STAAD DEFINE MOVING LOAD TYPE {type_id}{gen_note}",
            "axle_loads_kN": loads,
            "axle_spacings_m": spacings,
        })

    return {
        "types": types,
        "generations": generations,
        "vehicle_defs": vehicle_defs,
        "used_type_ids": used_type_ids,
        "warnings": warnings,
        "errors": errors,
    }


def _irc_vehicle_library() -> dict:
    """
    IRC 6:2017 vehicle presets used for longitudinal critical-position sweep.
    """
    return {
        "CLASS_70R_WHEELED": {
            "name": "Class 70R Wheeled",
            # Axle loads (kN) based on wheel train in IRC figure (8t,12t,12t,17t,17t,17t,17t)
            "axle_loads_kN": [80.0, 120.0, 120.0, 170.0, 170.0, 170.0, 170.0],
            # Spacing between consecutive axles (m)
            "axle_spacings_m": [3.96, 1.52, 2.15, 1.37, 5.05, 1.57],
            "notes": "IRC 70R wheeled train modeled as concentrated axle loads.",
        },
        "CLASS_70R_TRACKED": {
            "name": "Class 70R Tracked",
            # Equivalent two concentrated loads (35t + 35t)
            "axle_loads_kN": [350.0, 350.0],
            # Center-to-center spacing based on 4.57m track lengths with 0.90m gap
            "axle_spacings_m": [5.47],
            "notes": "Tracked loading represented by two equivalent concentrated loads.",
        },
        "CLASS_A": {
            "name": "Class A Train",
            # kN values from Class A axle train (2.7t/6.8t/11.4t groups)
            "axle_loads_kN": [27.0, 27.0, 114.0, 114.0, 68.0, 68.0, 68.0, 68.0, 27.0, 27.0],
            # m spacing between consecutive axles (critical train pattern)
            "axle_spacings_m": [1.10, 3.20, 1.20, 4.30, 3.00, 3.00, 3.00, 1.40, 0.90],
            "notes": "Class A train represented using the standard concentrated axle train pattern.",
        },
        "SINGLE_AXLE_BOGIE": {
            "name": "Single Axle Bogie",
            "axle_loads_kN": [200.0],
            "axle_spacings_m": [],
            "notes": "Single heavy axle (20t equivalent).",
        },
        "DOUBLE_AXLE_BOGIE": {
            "name": "Double Axle Bogie Load",
            "axle_loads_kN": [200.0, 200.0],
            "axle_spacings_m": [1.22],
            "notes": "Double bogie load represented as two 20t equivalent axles.",
        },
    }


def _axle_offsets(spacings: list[float]) -> list[float]:
    offsets = [0.0]
    x = 0.0
    for s in spacings:
        x += s
        offsets.append(round(x, 6))
    return offsets


def _frame_element_matrices(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    area: float,
    inertia: float,
    elastic_modulus: float,
) -> tuple[np.ndarray, np.ndarray]:
    dx = x2 - x1
    dy = y2 - y1
    L = math.hypot(dx, dy)
    if L <= 0:
        raise ValueError("Element length must be > 0")

    c = dx / L
    s = dy / L

    EA_L = elastic_modulus * area / L
    EI = elastic_modulus * inertia
    EI_L = EI / L
    EI_L2 = EI / (L * L)
    EI_L3 = EI / (L * L * L)

    k_local = np.array([
        [EA_L, 0.0, 0.0, -EA_L, 0.0, 0.0],
        [0.0, 12.0 * EI_L3, 6.0 * EI_L2, 0.0, -12.0 * EI_L3, 6.0 * EI_L2],
        [0.0, 6.0 * EI_L2, 4.0 * EI_L, 0.0, -6.0 * EI_L2, 2.0 * EI_L],
        [-EA_L, 0.0, 0.0, EA_L, 0.0, 0.0],
        [0.0, -12.0 * EI_L3, -6.0 * EI_L2, 0.0, 12.0 * EI_L3, -6.0 * EI_L2],
        [0.0, 6.0 * EI_L2, 2.0 * EI_L, 0.0, -6.0 * EI_L2, 4.0 * EI_L],
    ], dtype=float)

    T = np.array([
        [c, s, 0.0, 0.0, 0.0, 0.0],
        [-s, c, 0.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, c, s, 0.0],
        [0.0, 0.0, 0.0, -s, c, 0.0],
        [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
    ], dtype=float)

    return k_local, T


def _build_longitudinal_frame_model(
    clear_span: float,
    clear_height: float,
    top_slab_thickness: float,
    bottom_slab_thickness: float,
    wall_thickness: float,
    mid_wall_thickness: float,
    num_cells: int,
    fck: float,
) -> dict:
    # Material modulus consistent with existing STAAD export logic
    E = 5000.0 * math.sqrt(max(fck, 1.0)) * 1000.0  # kN/m²

    total_length = num_cells * clear_span

    nodes = []
    bottom_nodes = []
    top_nodes = []
    for i in range(num_cells + 1):
        x = i * clear_span
        b_idx = len(nodes)
        nodes.append((x, 0.0))
        t_idx = len(nodes)
        nodes.append((x, clear_height))
        bottom_nodes.append(b_idx)
        top_nodes.append(t_idx)

    elements = []
    top_element_idx_by_span = {}

    def add_element(n1: int, n2: int, group: str, thickness: float):
        x1, y1 = nodes[n1]
        x2, y2 = nodes[n2]
        area = max(thickness, 1e-6) * 1.0
        inertia = 1.0 * max(thickness, 1e-6) ** 3 / 12.0
        k_local, T = _frame_element_matrices(x1, y1, x2, y2, area, inertia, E)
        elements.append({
            "id": len(elements) + 1,
            "n1": n1,
            "n2": n2,
            "group": group,
            "k_local": k_local,
            "T": T,
            "x1": x1,
            "x2": x2,
            "y1": y1,
            "y2": y2,
            "length": math.hypot(x2 - x1, y2 - y1),
        })

    # Horizontal members
    for i in range(num_cells):
        add_element(top_nodes[i], top_nodes[i + 1], "TOP_SLAB", top_slab_thickness)
        top_element_idx_by_span[i] = len(elements) - 1
    for i in range(num_cells):
        add_element(bottom_nodes[i], bottom_nodes[i + 1], "BOTTOM_SLAB", bottom_slab_thickness)

    # Vertical members
    for i in range(num_cells + 1):
        if i == 0 or i == num_cells:
            group = "SIDE_WALL"
            t = wall_thickness
        else:
            group = "INTERMEDIATE_WALL"
            t = mid_wall_thickness
        add_element(bottom_nodes[i], top_nodes[i], group, t)

    n_dof = 3 * len(nodes)
    K = np.zeros((n_dof, n_dof), dtype=float)
    for e in elements:
        k_global = e["T"].T @ e["k_local"] @ e["T"]
        dof = [
            3 * e["n1"], 3 * e["n1"] + 1, 3 * e["n1"] + 2,
            3 * e["n2"], 3 * e["n2"] + 1, 3 * e["n2"] + 2,
        ]
        K[np.ix_(dof, dof)] += k_global

    constrained = set()
    for n in bottom_nodes:
        constrained.add(3 * n)      # Ux
        constrained.add(3 * n + 1)  # Uy
    free = [i for i in range(n_dof) if i not in constrained]

    K_ff = K[np.ix_(free, free)]
    try:
        K_ff_inv = np.linalg.inv(K_ff)
    except np.linalg.LinAlgError as exc:
        raise ValueError("Frame stiffness matrix is singular for the selected geometry") from exc

    return {
        "nodes": nodes,
        "elements": elements,
        "top_element_idx_by_span": top_element_idx_by_span,
        "num_cells": num_cells,
        "clear_span": clear_span,
        "total_length": total_length,
        "n_dof": n_dof,
        "free_dof": free,
        "K_ff_inv": K_ff_inv,
    }


def _init_group_envelopes(groups: list[str]) -> dict:
    envelopes = {}
    for g in groups:
        envelopes[g] = {
            "sagging": {"value": 0.0, "lead_position": None, "member_id": 0},
            "hogging": {"value": 0.0, "lead_position": None, "member_id": 0},
            "shear": {"value": 0.0, "lead_position": None, "member_id": 0},
        }
    return envelopes


def _update_group_envelopes(envelopes: dict, group_forces: dict, lead_position: float):
    for group, gdata in group_forces.items():
        moments = gdata["moments"]  # list[(moment, member_id)]
        shears = gdata["shears"]    # list[(abs_shear, member_id)]
        if not moments and not shears:
            continue

        positive = [(m, mid) for m, mid in moments if m > 0]
        negative = [(m, mid) for m, mid in moments if m < 0]

        if positive:
            sag_val, sag_mid = max(positive, key=lambda x: x[0])
            if sag_val > envelopes[group]["sagging"]["value"]:
                envelopes[group]["sagging"] = {
                    "value": round(sag_val, 3),
                    "lead_position": round(lead_position, 3),
                    "member_id": sag_mid,
                }

        if negative:
            neg_val, neg_mid = min(negative, key=lambda x: x[0])  # most negative
            hog_val = abs(neg_val)
            if hog_val > envelopes[group]["hogging"]["value"]:
                envelopes[group]["hogging"] = {
                    "value": round(hog_val, 3),
                    "lead_position": round(lead_position, 3),
                    "member_id": neg_mid,
                }

        if shears:
            sh_val, sh_mid = max(shears, key=lambda x: x[0])
            if sh_val > envelopes[group]["shear"]["value"]:
                envelopes[group]["shear"] = {
                    "value": round(sh_val, 3),
                    "lead_position": round(lead_position, 3),
                    "member_id": sh_mid,
                }


def _solve_frame_for_vehicle_position(
    model: dict,
    lead_position: float,
    axle_offsets: list[float],
    axle_loads: list[float],
    compute_bmd: bool = False,
) -> dict:
    n_dof = model["n_dof"]
    F_global = np.zeros(n_dof, dtype=float)

    # Per-element equivalent nodal loads in local coordinates
    element_eq_local = [np.zeros(6, dtype=float) for _ in model["elements"]]

    clear_span = model["clear_span"]
    total_length = model["total_length"]
    num_cells = model["num_cells"]

    for offset, load_kN in zip(axle_offsets, axle_loads):
        x = lead_position + offset
        if x < 0.0 or x > total_length:
            continue

        span_idx = int(x / clear_span) if clear_span > 0 else 0
        if span_idx >= num_cells:
            span_idx = num_cells - 1
        if span_idx < 0:
            continue

        elem_idx = model["top_element_idx_by_span"][span_idx]
        elem = model["elements"][elem_idx]

        x0 = span_idx * clear_span
        a = x - x0
        L = clear_span
        if L <= 0:
            continue
        xi = max(0.0, min(1.0, a / L))

        # Hermitian shape functions for beam transverse load at x=xi*L
        N1 = 1.0 - 3.0 * xi * xi + 2.0 * xi * xi * xi
        N2 = L * (xi - 2.0 * xi * xi + xi * xi * xi)
        N3 = 3.0 * xi * xi - 2.0 * xi * xi * xi
        N4 = L * (-xi * xi + xi * xi * xi)

        # Downward load in local y => negative
        P = -abs(load_kN)
        f_local = np.array([0.0, P * N1, P * N2, 0.0, P * N3, P * N4], dtype=float)

        element_eq_local[elem_idx] += f_local

        f_global = elem["T"].T @ f_local
        dof = [
            3 * elem["n1"], 3 * elem["n1"] + 1, 3 * elem["n1"] + 2,
            3 * elem["n2"], 3 * elem["n2"] + 1, 3 * elem["n2"] + 2,
        ]
        F_global[dof] += f_global

    F_ff = F_global[model["free_dof"]]
    try:
        D_ff = model["K_ff_inv"] @ F_ff
    except ValueError:
        D_ff = np.zeros(len(model["free_dof"]))

    D_global = np.zeros(n_dof, dtype=float)
    D_global[model["free_dof"]] = D_ff

    for elem in model["elements"]:
        n1, n2 = elem["n1"], elem["n2"]
        dof = [
            3 * n1, 3 * n1 + 1, 3 * n1 + 2,
            3 * n2, 3 * n2 + 2 + 0, 3 * n2 + 2,
        ]
        dof = [3*n1, 3*n1+1, 3*n1+2, 3*n2, 3*n2+1, 3*n2+2]
        d_global = D_global[dof]
        d_local = elem["T"] @ d_global

        f_local = elem["k_local"] @ d_local - element_eq_local[elem["id"] - 1]
        elem["current_f_local"] = f_local

    group_forces = {}
    for elem in model["elements"]:
        g = elem["group"]
        if g not in group_forces:
            group_forces[g] = {"moments": [], "shears": [], "elements": []}
        
        f = elem["current_f_local"]
        N1, V1, M1, N2, V2, M2 = f
        
        group_forces[g]["moments"].append((M1, elem["id"]))
        group_forces[g]["moments"].append((-M2, elem["id"]))
        group_forces[g]["shears"].append((abs(V1), elem["id"]))
        group_forces[g]["shears"].append((abs(V2), elem["id"]))

        if compute_bmd:
            x1, y1 = elem["x1"], elem["y1"]
            x2, y2 = elem["x2"], elem["y2"]
            L = elem["length"]
            # To compute point moments, we need the actual loads on this element
            element_loads = []
            for offset, load_kN in zip(axle_offsets, axle_loads):
                x = lead_position + offset
                if x < 0.0 or x > total_length:
                    continue
                span_idx = int(x / clear_span) if clear_span > 0 else 0
                if span_idx >= num_cells:
                    span_idx = num_cells - 1
                if span_idx >= 0 and model["top_element_idx_by_span"].get(span_idx) == (elem["id"] - 1):
                    # Local load position
                    a = x - span_idx * clear_span
                    if 0 <= a <= L:
                        element_loads.append({"a": a, "P": -abs(load_kN)})

            # 11 equal sample points
            samples = list(np.linspace(0, L, 11))
            
            elem_bmd = []
            for a in samples:
                M_int = V1 * a - M1
                for ld in element_loads:
                    if ld["a"] < a:
                        M_int += ld["P"] * (a - ld["a"])
                
                X = x1 + (x2 - x1) * (a / L) if L > 0 else x1
                Y = y1 + (y2 - y1) * (a / L) if L > 0 else y1
                elem_bmd.append({"X": X, "Y": Y, "M": round(M_int, 3), "a": round(a, 3)})
            
            group_forces[g]["elements"].append({"id": elem["id"], "bmd": elem_bmd})

    result = {"group_forces": group_forces}
    return result


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
    has_base_tension = q_min < 0
    status = "PASS" if (utilization <= 1.0 and not has_base_tension) else "FAIL"
    if has_base_tension:
        formula += "\nCheck: q_min < 0 indicates base tension/uplift at one edge; increase base width or reduce eccentricity."

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
    mid_wall_thickness: float = None,
    num_cells: int = 1,
    fck: float = 30.0,
    member_loads_text: str = "",
    load_combinations_text: str = "",
) -> str:
    """
    Generate a complete STAAD.Pro input file (.std) for a 2D frame model
    of a box culvert.
    """
    if mid_wall_thickness is None:
        mid_wall_thickness = wall_thickness
        
    total_width = num_cells * clear_span + 2 * wall_thickness + max(0, num_cells - 1) * mid_wall_thickness
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
        if c == 0:
            x = 0.0
        elif c == num_cells:
            x = num_cells * clear_span + wall_thickness + (num_cells - 1) * mid_wall_thickness
        else:
            x = c * clear_span + wall_thickness + (c - 1) * mid_wall_thickness
            
        wall_thick = wall_thickness if (c == 0 or c == num_cells) else mid_wall_thickness
        
        nodes[f"BL{c}"] = node_id
        lines.append(f"{node_id} {x:.4f} 0.000 0.000")
        node_id += 1
        nodes[f"BR{c}"] = node_id
        x2 = x + wall_thick
        lines.append(f"{node_id} {x2:.4f} 0.000 0.000")
        node_id += 1

    # Top slab joints
    y_top = clear_height + bottom_slab_thickness
    for c in range(num_cells + 1):
        if c == 0:
            x = 0.0
        elif c == num_cells:
            x = num_cells * clear_span + wall_thickness + (num_cells - 1) * mid_wall_thickness
        else:
            x = c * clear_span + wall_thickness + (c - 1) * mid_wall_thickness
            
        wall_thick = wall_thickness if (c == 0 or c == num_cells) else mid_wall_thickness
        
        nodes[f"TL{c}"] = node_id
        lines.append(f"{node_id} {x:.4f} {y_top:.4f} 0.000")
        node_id += 1
        nodes[f"TR{c}"] = node_id
        x2 = x + wall_thick
        lines.append(f"{node_id} {x2:.4f} {y_top:.4f} 0.000")
        node_id += 1

    lines.append("")

    # Member incidences
    lines.append("MEMBER INCIDENCES")
    mem_id = 1
    
    bottom_slab_mems = []
    outer_wall_mems = []
    inner_wall_mems = []
    top_slab_mems = []

    # Bottom slab members (connect bottom joints)
    for c in range(num_cells):
        start_node = nodes[f"BR{c}"]
        end_node = nodes[f"BL{c+1}"]
        lines.append(f"{mem_id} {start_node} {end_node}")
        bottom_slab_mems.append(str(mem_id))
        mem_id += 1

    # Wall members (vertical)
    for c in range(num_cells + 1):
        start_node = nodes[f"BR{c}"] if c < num_cells + 1 else nodes[f"BL{c}"]
        end_node = nodes[f"TL{c}"]
        # Use appropriate bottom and top nodes
        bn = nodes.get(f"BR{c}", nodes.get(f"BL{c}"))
        tn = nodes.get(f"TL{c}", nodes.get(f"TR{c}"))
        lines.append(f"{mem_id} {bn} {tn}")
        
        if c == 0 or c == num_cells:
            outer_wall_mems.append(str(mem_id))
        else:
            inner_wall_mems.append(str(mem_id))
            
        mem_id += 1

    # Top slab members
    for c in range(num_cells):
        start_node = nodes[f"TR{c}"]
        end_node = nodes[f"TL{c+1}"]
        lines.append(f"{mem_id} {start_node} {end_node}")
        top_slab_mems.append(str(mem_id))
        mem_id += 1
    lines.append("")

    # Member properties
    E = 5000 * math.sqrt(fck) * 1000  # kN/m²
    lines.append("MEMBER PROPERTY")
    lines.append(f"* Top slab: {top_slab_thickness*1000:.0f}mm thick")
    lines.append(f"* Bottom slab: {bottom_slab_thickness*1000:.0f}mm thick")
    lines.append(f"* Outer Walls: {wall_thickness*1000:.0f}mm thick")
    if num_cells > 1:
        lines.append(f"* Inner Walls: {mid_wall_thickness*1000:.0f}mm thick")
        
    lines.append(f"{' '.join(bottom_slab_mems)} PRIS YD {bottom_slab_thickness:.3f} ZD 1.000")
    lines.append(f"{' '.join(outer_wall_mems)} PRIS YD {wall_thickness:.3f} ZD 1.000")
    if inner_wall_mems:
        lines.append(f"{' '.join(inner_wall_mems)} PRIS YD {mid_wall_thickness:.3f} ZD 1.000")
    lines.append(f"{' '.join(top_slab_mems)} PRIS YD {top_slab_thickness:.3f} ZD 1.000")
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


# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 1: CRITICAL SAFETY FEATURES
# ═══════════════════════════════════════════════════════════════════════════════


# ─── 13. Crack Width Check (IRC 112, Cl. 12.3.4) ────────────────────────────

@dataclass
class CrackWidthResult:
    element: str
    bm_sls: float               # kN·m (SLS moment)
    effective_depth: float      # mm
    breadth: float              # mm
    ast_provided: float         # mm²
    bar_dia: int                # mm
    spacing: int                # mm
    fck: float
    fy: float
    sigma_sr: float             # MPa - stress in steel
    epsilon_sm_cm: float        # differential strain
    sr_max: float               # mm - max crack spacing
    crack_width: float          # mm
    permissible_crack: float    # mm
    status: str                 # PASS / FAIL
    formula: str
    notes: str


def check_crack_width(
    bm_sls: float,
    slab_thickness: float,
    clear_cover: float = 50.0,
    bar_diameter: int = 16,
    bar_spacing: int = 150,
    breadth: float = 1000.0,
    fck: float = 30.0,
    fy: float = 500.0,
    permissible_crack: float = 0.2,
    exposure: str = "MODERATE",
) -> CrackWidthResult:
    """
    Crack width check per IRC 112:2011, Cl. 12.3.4.

    w_k = s_r,max × (ε_sm − ε_cm)

    Where:
        s_r,max = max crack spacing
        ε_sm = mean strain in steel
        ε_cm = mean strain in concrete between cracks
    """
    d = slab_thickness * 1000 - clear_cover - bar_diameter / 2  # mm
    b = breadth

    # Modular ratio
    Es = 200000  # MPa
    Ecm = 5000 * math.sqrt(fck)  # IS 456 short-term
    m = Es / Ecm  # modular ratio

    # Steel area
    bar_area = math.pi * bar_diameter ** 2 / 4
    num_bars = int(b / bar_spacing) + 1
    Ast = num_bars * bar_area  # mm²

    # Reinforcement ratio
    rho_eff = Ast / (b * d) if d > 0 else 0.01

    Mu = abs(bm_sls) * 1e6  # N·mm

    # Stress in steel (cracked section analysis - simplified)
    # Using transformed section: x = d × [-m·ρ + √((m·ρ)² + 2·m·ρ)]
    m_rho = m * rho_eff
    x = d * (-m_rho + math.sqrt(m_rho ** 2 + 2 * m_rho))

    # Lever arm
    z = d - x / 3

    # Steel stress at SLS
    sigma_s = Mu / (Ast * z) if (Ast * z) > 0 else 0

    # Mean strain difference (IRC 112 Eq. 12.6)
    # ε_sm - ε_cm = [σ_s - k_t × (f_ct,eff / ρ_eff) × (1 + α_e × ρ_eff)] / Es
    fct_eff = 0.7 * 0.259 * fck ** (2/3)  # mean tensile strength ~ 0.7 × f_ctm
    alpha_e = Es / Ecm
    kt = 0.5  # long term loading

    numerator = sigma_s - kt * (fct_eff / rho_eff) * (1 + alpha_e * rho_eff)
    eps_sm_cm = max(numerator / Es, 0.6 * sigma_s / Es)

    # Maximum crack spacing (IRC 112 Eq. 12.8)
    # s_r,max = 3.4c + 0.425 × k1 × k2 × φ / ρ_eff
    k1 = 0.8   # high bond bars
    k2 = 0.5   # bending
    sr_max = 3.4 * clear_cover + 0.425 * k1 * k2 * bar_diameter / rho_eff

    # Crack width
    wk = sr_max * eps_sm_cm / 1000  # convert to mm (sr_max in mm, eps dimensionless)
    # Actually sr_max is in mm and eps is dimensionless, result is in mm
    wk = sr_max * eps_sm_cm

    # Permissible crack width per exposure
    perm_map = {"MODERATE": 0.3, "SEVERE": 0.2, "VERY_SEVERE": 0.1, "EXTREME": 0.1}
    if exposure in perm_map:
        permissible_crack = perm_map[exposure]

    status = "PASS" if wk <= permissible_crack else "FAIL"

    formula = (
        f"IRC 112, Cl. 12.3.4\n"
        f"d = {d:.0f}mm, m = Es/Ecm = {m:.1f}\n"
        f"Ast = {Ast:.0f} mm², ρ_eff = {rho_eff:.5f}\n"
        f"NA depth x = {x:.1f}mm, z = {z:.1f}mm\n"
        f"σ_s = Mu/(Ast×z) = {sigma_s:.1f} MPa\n"
        f"f_ct,eff = {fct_eff:.2f} MPa\n"
        f"ε_sm - ε_cm = {eps_sm_cm:.6f}\n"
        f"s_r,max = 3.4×{clear_cover:.0f} + 0.425×{k1}×{k2}×{bar_diameter}/{rho_eff:.5f} = {sr_max:.1f}mm\n"
        f"w_k = {sr_max:.1f} × {eps_sm_cm:.6f} = {wk:.3f}mm"
    )

    notes = ""
    if wk > permissible_crack:
        notes = f"Crack width {wk:.3f}mm > {permissible_crack}mm. Reduce bar spacing or increase bar diameter."
    elif wk > 0.8 * permissible_crack:
        notes = f"Crack width close to limit ({wk:.3f}/{permissible_crack}mm = {wk/permissible_crack*100:.0f}%). Consider reviewing."

    return CrackWidthResult(
        element="Slab/Wall",
        bm_sls=bm_sls,
        effective_depth=round(d, 1),
        breadth=breadth,
        ast_provided=round(Ast, 1),
        bar_dia=bar_diameter,
        spacing=bar_spacing,
        fck=fck, fy=fy,
        sigma_sr=round(sigma_s, 2),
        epsilon_sm_cm=round(eps_sm_cm, 7),
        sr_max=round(sr_max, 1),
        crack_width=round(wk, 3),
        permissible_crack=permissible_crack,
        status=status,
        formula=formula,
        notes=notes,
    )


# ─── 14. Shear Design Check (IS 456 / IRC 112) ──────────────────────────────

@dataclass
class ShearCheckResult:
    element: str
    shear_force: float          # kN
    effective_depth: float      # mm
    breadth: float              # mm
    fck: float
    pt_percent: float           # % tension steel
    tau_v: float                # MPa - nominal shear stress
    tau_c: float                # MPa - shear strength of concrete
    tau_c_max: float            # MPa - maximum shear stress
    shear_status: str           # 'NO SHEAR STEEL', 'PROVIDE SHEAR STEEL', 'SECTION INADEQUATE'
    Vus: float                  # kN - shear to be carried by stirrups
    stirrup_dia: int
    stirrup_spacing: int        # mm
    formula: str
    notes: str


def check_shear(
    shear_force: float,
    slab_thickness: float,
    clear_cover: float = 50.0,
    bar_diameter: int = 16,
    breadth: float = 1000.0,
    fck: float = 30.0,
    fy: float = 500.0,
    ast_provided: float = 0,
    stirrup_dia: int = 8,
) -> ShearCheckResult:
    """
    Shear design check per IS 456:2000, Cl. 40.

    τ_v = V/(b×d) — nominal shear stress
    τ_c from IS 456 Table 19 — design shear strength
    τ_c,max from IS 456 Table 20 — max shear stress
    """
    d = slab_thickness * 1000 - clear_cover - bar_diameter / 2  # mm
    b = breadth

    Vu = abs(shear_force) * 1000  # Convert kN to N

    # Nominal shear stress
    tau_v = Vu / (b * d) if (b * d) > 0 else 0

    # Tension steel percentage
    if ast_provided <= 0:
        # Estimate from minimum steel
        ast_provided = 0.12 / 100 * b * slab_thickness * 1000
    pt = 100 * ast_provided / (b * d)

    # IS 456 Table 19 - Design shear strength τ_c (MPa)
    # Interpolated formula: τ_c = 0.85 × √(0.8×fck) × (√(1+5β)-1) / (6β)
    # where β = 0.8×fck / (6.89×pt) but β ≥ 1
    beta_val = max(1.0, 0.8 * fck / (6.89 * pt)) if pt > 0 else 10.0
    tau_c = 0.85 * math.sqrt(0.8 * fck) * (math.sqrt(1 + 5 * beta_val) - 1) / (6 * beta_val)

    # IS 456 Table 20 - Maximum shear stress τ_c,max
    tau_c_max_table = {15: 2.5, 20: 2.8, 25: 3.1, 30: 3.5, 35: 3.7, 40: 4.0}
    fck_key = min(tau_c_max_table.keys(), key=lambda k: abs(k - fck))
    tau_c_max = tau_c_max_table.get(fck_key, 3.5)

    # Determine status
    Vus = 0
    sv = 0
    if tau_v <= tau_c:
        shear_status = "NO SHEAR STEEL NEEDED"
        notes = "τ_v ≤ τ_c — Concrete alone can resist shear. Provide minimum shear reinforcement."
    elif tau_v <= tau_c_max:
        shear_status = "PROVIDE SHEAR STEEL"
        Vus_N = (tau_v - tau_c) * b * d
        Vus = Vus_N / 1000  # kN
        # Spacing of stirrups: s = 0.87×fy×Asv×d / Vus
        Asv = 2 * math.pi * stirrup_dia ** 2 / 4  # 2-legged stirrup
        if Vus_N > 0:
            sv = int(0.87 * fy * Asv * d / Vus_N)
            sv = min(sv, int(0.75 * d), 300)
            sv = max(sv, 75)
            sv = (sv // 25) * 25  # round to nearest 25mm
        notes = f"Provide {stirrup_dia}mm 2L stirrups @ {sv}mm c/c"
    else:
        shear_status = "SECTION INADEQUATE"
        notes = f"τ_v ({tau_v:.2f}) > τ_c,max ({tau_c_max:.2f}). INCREASE section depth or concrete grade."

    formula = (
        f"IS 456, Cl. 40\n"
        f"d = {d:.0f}mm, b = {b:.0f}mm\n"
        f"τ_v = Vu/(b×d) = {Vu:.0f}/({b:.0f}×{d:.0f}) = {tau_v:.3f} MPa\n"
        f"Ast = {ast_provided:.0f} mm², pt = {pt:.3f}%\n"
        f"τ_c = {tau_c:.3f} MPa (IS 456 Table 19)\n"
        f"τ_c,max = {tau_c_max:.1f} MPa (IS 456 Table 20, M{fck_key})"
    )

    return ShearCheckResult(
        element="Slab/Wall",
        shear_force=shear_force,
        effective_depth=round(d, 1),
        breadth=breadth,
        fck=fck,
        pt_percent=round(pt, 3),
        tau_v=round(tau_v, 3),
        tau_c=round(tau_c, 3),
        tau_c_max=tau_c_max,
        shear_status=shear_status,
        Vus=round(Vus, 2),
        stirrup_dia=stirrup_dia,
        stirrup_spacing=sv,
        formula=formula,
        notes=notes,
    )


# ─── 15. Braking Force Calculator (IRC 6, Cl. 211) ──────────────────────────

@dataclass
class BrakingForceResult:
    vehicle_class: str
    num_lanes: int
    braking_force: float        # kN
    braking_per_meter: float    # kN/m (per unit length)
    bridge_width: float
    fill_depth: float
    applied: bool               # whether braking is applicable
    formula: str
    notes: str


def compute_braking_force(
    vehicle_class: str = "CLASS_A",
    num_lanes: int = 2,
    bridge_width: float = 8.5,
    span: float = 4.0,
    fill_depth: float = 0.0,
) -> BrakingForceResult:
    """
    Braking force per IRC 6:2017, Cl. 211.

    Class A: 20% of first lane LL + 5% of second lane
    70R/Class AA: 20% of train load
    Applied as horizontal force at bearing level.
    Not applicable if fill > 600mm (IRC 112 provision).
    """
    # Standard axle loads per IRC 6
    train_loads = {
        "CLASS_A": 554,          # kN (total of one train)
        "CLASS_B": 332,
        "CLASS_AA_TRACKED": 700,
        "CLASS_AA_WHEELED": 400,
        "70R_TRACKED": 700,
        "70R_WHEELED": 1000,
    }

    total_load = train_loads.get(vehicle_class, 554)

    if fill_depth > 0.6:
        return BrakingForceResult(
            vehicle_class=vehicle_class,
            num_lanes=num_lanes,
            braking_force=0,
            braking_per_meter=0,
            bridge_width=bridge_width,
            fill_depth=fill_depth,
            applied=False,
            formula="Fill depth > 600mm → Braking force not applicable (IRC 112)",
            notes="Braking force is attenuated by earth fill > 600mm. No horizontal braking force applied.",
        )

    # First lane: 20%, subsequent lanes: 5%
    if num_lanes >= 1:
        bf = 0.20 * total_load
        if num_lanes >= 2:
            bf += 0.05 * total_load * (num_lanes - 1)
    else:
        bf = 0

    bf_per_m = bf / bridge_width if bridge_width > 0 else 0

    formula = (
        f"IRC 6, Cl. 211\n"
        f"Vehicle: {vehicle_class}, Total train load = {total_load} kN\n"
        f"Lane 1: 20% × {total_load} = {0.2*total_load:.1f} kN\n"
    )
    if num_lanes >= 2:
        formula += f"Lanes 2+: 5% × {total_load} × {num_lanes-1} = {0.05*total_load*(num_lanes-1):.1f} kN\n"
    formula += f"Total braking = {bf:.1f} kN, per metre = {bf_per_m:.2f} kN/m"

    return BrakingForceResult(
        vehicle_class=vehicle_class,
        num_lanes=num_lanes,
        braking_force=round(bf, 2),
        braking_per_meter=round(bf_per_m, 2),
        bridge_width=bridge_width,
        fill_depth=fill_depth,
        applied=True,
        formula=formula,
        notes="Apply as horizontal UNI load on top slab members in STAAD (GX direction).",
    )


# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2: PROFESSIONAL COMPLETENESS
# ═══════════════════════════════════════════════════════════════════════════════


# ─── 16. Temperature & Shrinkage Load Calculator ─────────────────────────────

@dataclass
class TempShrinkageResult:
    uniform_temp_rise: float        # °C
    uniform_temp_fall: float        # °C
    differential_temp: float        # °C
    shrinkage_strain: float         # × 10⁻⁶
    # Resulting forces per metre width
    axial_force_rise: float         # kN/m (restrained uniform temp)
    axial_force_fall: float
    moment_differential: float      # kN·m/m (from temp gradient)
    shrinkage_force: float          # kN/m
    formula: str
    notes: str
    staad_loads: list               # ready-to-apply load definitions


def compute_temp_shrinkage(
    slab_thickness: float = 0.5,
    wall_thickness: float = 0.4,
    fck: float = 30.0,
    uniform_temp_rise_deg: float = 15.0,
    uniform_temp_fall_deg: float = 10.0,
    differential_temp_deg: float = 17.8,
    shrinkage_strain: float = 300e-6,
    restrained: bool = True,
) -> TempShrinkageResult:
    """
    Temperature and shrinkage effects per IRC 6 & IRC 112.

    Uniform temperature: IRC 6 Cl. 215 (±10 to ±20°C depending on region)
    Differential temperature: IRC 6 Cl. 215.4 (17.8°C for concrete bridges)
    Shrinkage: IS 456 Cl. 6.2.4 (300-400 × 10⁻⁶)
    """
    # Material properties
    Ec = 5000 * math.sqrt(fck)  # MPa
    Ec_kN = Ec * 1000           # kN/m²
    alpha_t = 12e-6             # thermal coefficient for concrete (/°C)

    # --- Uniform Temperature ---
    # Restrained axial force: N = E × α × ΔT × A
    A_slab = slab_thickness * 1.0  # per meter width (m²)

    force_rise = Ec_kN * alpha_t * uniform_temp_rise_deg * A_slab if restrained else 0
    force_fall = Ec_kN * alpha_t * uniform_temp_fall_deg * A_slab if restrained else 0

    # --- Differential Temperature ---
    # Self-equilibrating stress → induces moment
    # M = E × α × ΔT_diff × I / h  (simplified for rectangular section)
    # I = bh³/12, moment = E × α × ΔT × b × h² / 12 (approx)
    h = slab_thickness
    I = 1.0 * h ** 3 / 12  # m⁴ per meter width
    moment_diff = Ec_kN * alpha_t * differential_temp_deg * 1.0 * h ** 2 / 12

    # --- Shrinkage ---
    shrinkage_force_val = Ec_kN * shrinkage_strain * A_slab if restrained else 0

    # Generate STAAD-ready load definitions
    staad_loads = []
    if restrained:
        staad_loads.append({
            "type": "TEMPERATURE_RISE",
            "description": f"Uniform temp rise +{uniform_temp_rise_deg}°C",
            "axial_force": round(force_rise, 2),
            "direction": "GX",
            "intensity": round(force_rise, 2),
        })
        staad_loads.append({
            "type": "TEMPERATURE_FALL",
            "description": f"Uniform temp fall -{uniform_temp_fall_deg}°C",
            "axial_force": round(force_fall, 2),
            "direction": "GX",
            "intensity": round(-force_fall, 2),
        })
        staad_loads.append({
            "type": "TEMP_DIFFERENTIAL",
            "description": f"Temp gradient {differential_temp_deg}°C",
            "moment": round(moment_diff, 2),
            "notes": "Apply as MEMBER LOAD UNIFORM MOMENT",
        })
        staad_loads.append({
            "type": "SHRINKAGE",
            "description": f"Shrinkage strain {shrinkage_strain*1e6:.0f}×10⁻⁶",
            "axial_force": round(shrinkage_force_val, 2),
            "direction": "GX",
            "intensity": round(shrinkage_force_val, 2),
        })

    formula = (
        f"IRC 6 Cl. 215 & IS 456 Cl. 6.2.4\n"
        f"Ec = 5000√{fck} = {Ec:.0f} MPa, α = {alpha_t*1e6:.0f}×10⁻⁶/°C\n\n"
        f"Uniform Rise: N = {Ec_kN:.0f} × {alpha_t} × {uniform_temp_rise_deg} × {A_slab:.3f} = {force_rise:.2f} kN/m\n"
        f"Uniform Fall: N = {Ec_kN:.0f} × {alpha_t} × {uniform_temp_fall_deg} × {A_slab:.3f} = {force_fall:.2f} kN/m\n"
        f"Differential: M = {Ec_kN:.0f} × {alpha_t} × {differential_temp_deg} × {h}² / 12 = {moment_diff:.2f} kN·m/m\n"
        f"Shrinkage: N = {Ec_kN:.0f} × {shrinkage_strain} × {A_slab:.3f} = {shrinkage_force_val:.2f} kN/m"
    )

    notes = (
        "Temperature and shrinkage create restrained forces in box culverts. "
        "Include as separate load cases in STAAD.Pro. "
        "SLS factor: 0.5 (quasi-permanent per IRC 6 Table B.3)."
    )

    return TempShrinkageResult(
        uniform_temp_rise=uniform_temp_rise_deg,
        uniform_temp_fall=uniform_temp_fall_deg,
        differential_temp=differential_temp_deg,
        shrinkage_strain=shrinkage_strain,
        axial_force_rise=round(force_rise, 2),
        axial_force_fall=round(force_fall, 2),
        moment_differential=round(moment_diff, 2),
        shrinkage_force=round(shrinkage_force_val, 2),
        formula=formula,
        notes=notes,
        staad_loads=staad_loads,
    )


# ─── 17. Effective Width Calculator (IRC 112, Cl. 9.4.2) ────────────────────

@dataclass
class EffectiveWidthResult:
    contact_width: float        # m (tyre/track contact)
    dispersion_width: float     # m (after fill dispersion)
    effective_width: float      # m (structural effective width)
    span: float
    load_position: float        # distance from support
    slab_type: str              # 'ONE_WAY' or 'TWO_WAY'
    alpha: float                # coefficient
    formula: str
    notes: str


def compute_effective_width(
    contact_width: float = 0.5,
    span: float = 4.0,
    load_position: float = 2.0,
    slab_width: float = 8.5,
    fill_depth: float = 0.0,
    wearing_course: float = 0.075,
    slab_type: str = "ONE_WAY",
) -> EffectiveWidthResult:
    """
    Effective width for concentrated loads per IRC 112, Cl. 9.4.2.

    For one-way slabs:
        b_eff = α × a × (1 − a/l₀) + b_w

    Where:
        α = coefficient (2.48 for single concentrated load per IRC)
        a = distance of load from nearest support
        l₀ = effective span
        b_w = contact width after dispersion
    """
    # Disperse through fill first
    b_w = contact_width + 2 * (fill_depth + wearing_course)

    a = load_position  # distance from nearest support
    l0 = span

    # Ensure a ≤ l0/2 (take nearest support)
    if a > l0 / 2:
        a = l0 - a  # measure from other support

    if slab_type == "ONE_WAY":
        alpha = 2.48  # IRC coefficient for single conc. load
        b_eff = alpha * a * (1 - a / l0) + b_w

        # b_eff should not exceed actual slab width
        b_eff = min(b_eff, slab_width)

        formula = (
            f"IRC 112, Cl. 9.4.2 (One-Way Slab)\n"
            f"b_w = {contact_width} + 2×({fill_depth}+{wearing_course}) = {b_w:.3f}m\n"
            f"a = {a:.3f}m (from nearest support), l₀ = {l0:.3f}m\n"
            f"α = {alpha}\n"
            f"b_eff = {alpha} × {a:.3f} × (1 − {a:.3f}/{l0:.3f}) + {b_w:.3f}\n"
            f"b_eff = {b_eff:.3f}m"
        )
    else:
        # Two-way slab (Pigeaud's approach - simplified)
        # Use IRC 21 Table 1 / IRC 112 approach
        alpha = 2.48
        b_eff_x = alpha * a * (1 - a / l0) + b_w
        b_eff = min(b_eff_x, slab_width)

        formula = (
            f"IRC 112 (Two-Way Slab - simplified)\n"
            f"b_w = {b_w:.3f}m, a = {a:.3f}m\n"
            f"b_eff ≈ {b_eff:.3f}m\n"
            f"Note: For accurate results, use Pigeaud's coefficient tables."
        )

    notes = ""
    if fill_depth > 0.6:
        notes = "With fill > 600mm, dispersion significantly reduces intensity. Impact factor = 0."
    if b_eff >= slab_width:
        notes += " Effective width = full slab width (load fully distributed)."

    return EffectiveWidthResult(
        contact_width=contact_width,
        dispersion_width=round(b_w, 3),
        effective_width=round(b_eff, 3),
        span=span,
        load_position=load_position,
        slab_type=slab_type,
        alpha=alpha,
        formula=formula,
        notes=notes,
    )


# ─── 18. Deflection Check (IS 456, Cl. 23.2) ────────────────────────────────

@dataclass
class DeflectionResult:
    element: str
    span: float                 # mm
    effective_depth: float      # mm
    pt_provided: float          # % tension steel
    pc_provided: float          # % compression steel
    fs: float                   # MPa - steel stress at service
    basic_ratio: float          # L/d basic (20 for cont, 26 for simply supported)
    mod_factor_tension: float   # from IS 456 Fig 4
    mod_factor_compression: float
    allowable_ld: float         # modified L/d
    actual_ld: float            # actual L/d
    status: str
    formula: str
    notes: str


def check_deflection(
    span: float,
    slab_thickness: float,
    clear_cover: float = 50.0,
    bar_diameter: int = 16,
    ast_provided: float = 0,
    breadth: float = 1000.0,
    fck: float = 30.0,
    fy: float = 500.0,
    support_condition: str = "CONTINUOUS",
    comp_steel: float = 0,
    ast_required: float = 0,
) -> DeflectionResult:
    """
    Deflection check using L/d ratio method per IS 456, Cl. 23.2.

    L/d ≤ basic ratio × mod_factor_tension × mod_factor_compression
    """
    d = slab_thickness * 1000 - clear_cover - bar_diameter / 2  # mm
    L = span * 1000  # mm

    actual_ld = L / d if d > 0 else 999

    # Basic L/d ratio (IS 456 Cl. 23.2.1)
    basic_ratios = {
        "CANTILEVER": 7,
        "SIMPLY_SUPPORTED": 20,
        "CONTINUOUS": 26,
    }
    basic = basic_ratios.get(support_condition, 26)

    # Tension steel modification factor (IS 456 Fig 4)
    if ast_provided <= 0:
        ast_provided = 0.12 / 100 * breadth * slab_thickness * 1000

    pt = 100 * ast_provided / (breadth * d) if d > 0 else 0.12

    # Steel stress at service (approximate):
    # If Ast_required is provided, fs scales with Ast_required/Ast_provided.
    # Otherwise, use a moderate reference steel ratio (pt_ref = 0.5%) so fs
    # decreases with increasing provided steel instead of staying constant.
    if ast_required > 0:
        stress_ratio = ast_required / max(ast_provided, 1e-6)
        fs_basis = f"Ast_req/Ast_prov = {ast_required:.1f}/{ast_provided:.1f}"
    else:
        pt_ref = 0.5  # %
        ast_ref = (pt_ref / 100.0) * breadth * d if d > 0 else ast_provided
        stress_ratio = ast_ref / max(ast_provided, 1e-6)
        fs_basis = f"reference pt={pt_ref:.2f}%"

    stress_ratio = min(1.0, max(0.35, stress_ratio))
    fs = 0.58 * fy * stress_ratio

    # Modification factor for tension reinforcement (IS 456 Fig 4 - curve fit)
    # Approximate curve: MF = 1/(0.225 + 0.00322×fs + 0.625×log10(pt_req))
    # Simplified version:
    if pt <= 0.3:
        mf_tension = 1.8 - 0.5 * (fs / fy)
    elif pt <= 1.0:
        mf_tension = 1.5 - 0.6 * (pt - 0.3) - 0.3 * (fs / fy)
    elif pt <= 2.0:
        mf_tension = 1.1 - 0.2 * (pt - 1.0)
    else:
        mf_tension = 0.8

    mf_tension = max(mf_tension, 1.0)
    mf_tension = min(mf_tension, 2.0)

    # Compression steel modification factor (IS 456 Fig 5)
    pc = 100 * comp_steel / (breadth * d) if (d > 0 and comp_steel > 0) else 0
    if pc <= 0:
        mf_comp = 1.0
    elif pc <= 1.0:
        mf_comp = 1.0 + 0.15 * pc
    elif pc <= 3.0:
        mf_comp = 1.15 + 0.05 * (pc - 1.0)
    else:
        mf_comp = 1.25

    allowable_ld = basic * mf_tension * mf_comp

    status = "PASS" if actual_ld <= allowable_ld else "FAIL"

    formula = (
        f"IS 456, Cl. 23.2\n"
        f"d = {d:.0f}mm, L = {L:.0f}mm\n"
        f"Actual L/d = {actual_ld:.1f}\n"
        f"Basic L/d = {basic} ({support_condition})\n"
        f"pt = {pt:.3f}%, fs = {fs:.0f} MPa ({fs_basis})\n"
        f"MF (tension) = {mf_tension:.2f} (IS 456 Fig 4)\n"
        f"MF (compression) = {mf_comp:.2f} (IS 456 Fig 5)\n"
        f"Allowable L/d = {basic} × {mf_tension:.2f} × {mf_comp:.2f} = {allowable_ld:.1f}"
    )

    notes = ""
    if status == "FAIL":
        notes = f"L/d = {actual_ld:.1f} > {allowable_ld:.1f}. Increase slab depth or provide more compression steel."
    else:
        notes = f"Deflection OK. Utilization = {actual_ld/allowable_ld*100:.0f}%"

    return DeflectionResult(
        element="Slab",
        span=span,
        effective_depth=round(d, 1),
        pt_provided=round(pt, 3),
        pc_provided=round(pc, 3),
        fs=round(fs, 1),
        basic_ratio=basic,
        mod_factor_tension=round(mf_tension, 2),
        mod_factor_compression=round(mf_comp, 2),
        allowable_ld=round(allowable_ld, 1),
        actual_ld=round(actual_ld, 1),
        status=status,
        formula=formula,
        notes=notes,
    )


# ─── 19. Soil Spring Calculator (Winkler Model) ─────────────────────────────

@dataclass
class SoilSpringResult:
    soil_type: str
    ks_value: float             # kN/m³ - subgrade modulus
    spring_stiffness: float     # kN/m per node
    num_springs: int
    node_spacing: float         # m
    formula: str
    notes: str
    staad_commands: str


def compute_soil_springs(
    base_width: float = 5.0,
    culvert_length: float = 1.0,
    soil_type: str = "MEDIUM_CLAY",
    custom_ks: float = 0,
    num_nodes: int = 10,
) -> SoilSpringResult:
    """
    Compute Winkler spring stiffnesses for soil-structure interaction.

    ks values (kN/m³) from Bowles and IS 2950:
    - Loose sand: 4,800 - 16,000
    - Medium sand: 9,600 - 80,000
    - Dense sand: 64,000 - 128,000
    - Soft clay: 12,000 - 24,000
    - Medium clay: 24,000 - 48,000
    - Stiff clay: 48,000 - 96,000
    """
    ks_ranges = {
        "LOOSE_SAND": (4800, 16000, 10000),
        "MEDIUM_SAND": (9600, 80000, 30000),
        "DENSE_SAND": (64000, 128000, 80000),
        "SOFT_CLAY": (12000, 24000, 16000),
        "MEDIUM_CLAY": (24000, 48000, 36000),
        "STIFF_CLAY": (48000, 96000, 60000),
        "HARD_ROCK": (300000, 500000, 400000),
    }

    if custom_ks > 0:
        ks = custom_ks
        soil_desc = f"Custom (ks = {ks:.0f} kN/m³)"
    elif soil_type in ks_ranges:
        low, high, typical = ks_ranges[soil_type]
        ks = typical
        soil_desc = f"{soil_type.replace('_', ' ').title()} (range: {low:,}-{high:,}, typical: {typical:,} kN/m³)"
    else:
        ks = 36000
        soil_desc = "Default medium clay"

    # Spring stiffness per node
    node_spacing = base_width / max(num_nodes - 1, 1)
    # Tributary area per spring = node_spacing × unit length
    tributary_area = node_spacing * culvert_length
    spring_k = ks * tributary_area

    # Edge nodes get half tributary area
    spring_k_edge = spring_k / 2

    # Generate STAAD support commands
    lines = []
    lines.append(f"* Winkler springs: ks = {ks:.0f} kN/m³")
    lines.append(f"* Soil type: {soil_type}")
    lines.append("SUPPORTS")
    for i in range(num_nodes):
        k = spring_k_edge if (i == 0 or i == num_nodes - 1) else spring_k
        lines.append(f"* Node {i+1}: KFY {k:.1f}")
    staad_cmds = "\n".join(lines)

    formula = (
        f"Winkler Spring Model (IS 2950 / Bowles)\n"
        f"Soil: {soil_desc}\n"
        f"ks = {ks:.0f} kN/m³\n"
        f"Node spacing = {base_width:.3f}/{num_nodes-1} = {node_spacing:.3f}m\n"
        f"Tributary area = {node_spacing:.3f} × {culvert_length:.3f} = {tributary_area:.4f} m²\n"
        f"K_spring (interior) = {ks:.0f} × {tributary_area:.4f} = {spring_k:.1f} kN/m\n"
        f"K_spring (edge) = {spring_k_edge:.1f} kN/m"
    )

    notes = (
        "Replace fixed supports in STAAD with spring supports (KFY). "
        "This models elastic foundation and gives more realistic BM in bottom slab. "
        "Use geotechnical report ks value if available."
    )

    return SoilSpringResult(
        soil_type=soil_type,
        ks_value=ks,
        spring_stiffness=round(spring_k, 2),
        num_springs=num_nodes,
        node_spacing=round(node_spacing, 4),
        formula=formula,
        notes=notes,
        staad_commands=staad_cmds,
    )


# ─── 20. Clear Cover Auto-Suggestion (IS 456 Table 16) ──────────────────────

@dataclass
class ClearCoverResult:
    exposure: str
    min_cover_mm: int
    min_grade: str
    max_wc_ratio: float
    min_cement: int             # kg/m³
    notes: str


def suggest_clear_cover(
    exposure: str = "MODERATE",
    element: str = "SLAB",
) -> ClearCoverResult:
    """
    Clear cover suggestions per IS 456:2000 Table 16 & Table 5.

    Exposure conditions:
    - MILD: Protected against weather, internal surfaces
    - MODERATE: Sheltered from rain, buried concrete
    - SEVERE: Exposed to rain, alternate wetting/drying
    - VERY_SEVERE: Coastal, exposed to sea spray
    - EXTREME: Splash zone, tidal zone
    """
    cover_table = {
        # exposure: (min_cover_mm, min_grade, max_wc, min_cement)
        "MILD":        (20, "M20", 0.55, 300),
        "MODERATE":    (30, "M25", 0.50, 300),
        "SEVERE":      (45, "M30", 0.45, 320),
        "VERY_SEVERE": (50, "M35", 0.45, 340),
        "EXTREME":     (75, "M40", 0.40, 360),
    }

    data = cover_table.get(exposure, cover_table["MODERATE"])
    min_cover, min_grade, max_wc, min_cement = data

    # Adjustments for element type
    element_notes = ""
    if element in ("WALL", "SIDE_WALL") and exposure in ("SEVERE", "VERY_SEVERE", "EXTREME"):
        min_cover = max(min_cover, 50)
        element_notes = "Earth-face walls: 50mm minimum (IRC 112). "
    elif element == "BOTTOM_SLAB":
        min_cover = max(min_cover, 50)
        element_notes = "Bottom slab in contact with soil: 50mm minimum. "

    notes = (
        f"{element_notes}"
        f"IS 456 Table 16: {exposure} exposure → {min_cover}mm cover. "
        f"Use {min_grade} or higher. W/C ≤ {max_wc}. "
        f"Min cement content: {min_cement} kg/m³."
    )

    return ClearCoverResult(
        exposure=exposure,
        min_cover_mm=min_cover,
        min_grade=min_grade,
        max_wc_ratio=max_wc,
        min_cement=min_cement,
        notes=notes,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3: PREMIUM DIFFERENTIATORS
# ═══════════════════════════════════════════════════════════════════════════════


# ─── 21. Settlement Calculator ───────────────────────────────────────────────

@dataclass
class SettlementResult:
    immediate_settlement: float     # mm
    consolidation_settlement: float # mm
    total_settlement: float         # mm
    permissible_settlement: float   # mm
    status: str
    formula: str
    notes: str


def compute_settlement(
    base_pressure: float = 100.0,
    base_width: float = 5.0,
    soil_type: str = "MEDIUM_CLAY",
    Es_soil: float = 0,
    Cc: float = 0,
    e0: float = 0,
    clay_thickness: float = 0,
    sigma_0: float = 0,
) -> SettlementResult:
    """
    Settlement calculation for box culvert foundation.

    Immediate settlement (sand): S_i = q × B × (1-μ²) × If / Es
    Consolidation settlement (clay): S_c = Cc/(1+e0) × H × log10((σ0 + Δσ)/σ0)
    """
    # Default soil properties if not provided
    soil_props = {
        "LOOSE_SAND":  {"Es": 10000, "mu": 0.30, "type": "SAND"},
        "MEDIUM_SAND": {"Es": 25000, "mu": 0.30, "type": "SAND"},
        "DENSE_SAND":  {"Es": 50000, "mu": 0.30, "type": "SAND"},
        "SOFT_CLAY":   {"Es": 5000,  "mu": 0.40, "Cc": 0.3, "e0": 1.2, "type": "CLAY"},
        "MEDIUM_CLAY": {"Es": 15000, "mu": 0.35, "Cc": 0.2, "e0": 0.8, "type": "CLAY"},
        "STIFF_CLAY":  {"Es": 30000, "mu": 0.30, "Cc": 0.1, "e0": 0.6, "type": "CLAY"},
        "HARD_ROCK":   {"Es": 500000, "mu": 0.20, "type": "ROCK"},
    }

    props = soil_props.get(soil_type, soil_props["MEDIUM_CLAY"])
    if Es_soil <= 0:
        Es_soil = props["Es"]
    mu = props.get("mu", 0.3)
    soil_class = props.get("type", "CLAY")

    # Immediate settlement (elastic)
    If = 1.0  # influence factor (rectangular foundation, center, ~1.0)
    Si = base_pressure * base_width * (1 - mu ** 2) * If / Es_soil * 1000  # mm

    # Consolidation settlement (clay only)
    Sc = 0
    if soil_class == "CLAY":
        if Cc <= 0:
            Cc = props.get("Cc", 0.2)
        if e0 <= 0:
            e0 = props.get("e0", 0.8)
        if clay_thickness <= 0:
            clay_thickness = base_width  # assume H ≈ B
        if sigma_0 <= 0:
            sigma_0 = 18 * (clay_thickness / 2 + 1)  # approx overburden

        delta_sigma = base_pressure  # stress increase at center of clay
        if sigma_0 > 0:
            Sc = Cc / (1 + e0) * clay_thickness * math.log10((sigma_0 + delta_sigma) / sigma_0) * 1000  # mm

    total = Si + Sc

    # Permissible settlement (IS 1904)
    perm = 50 if soil_class == "SAND" else 75  # mm for isolated footings

    status = "PASS" if total <= perm else "FAIL"

    formula = (
        f"IS 1904 / Terzaghi\n"
        f"Soil: {soil_type}, Es = {Es_soil} kN/m², μ = {mu}\n\n"
        f"Immediate: S_i = {base_pressure}×{base_width}×(1-{mu}²)×{If}/{Es_soil}×1000\n"
        f"S_i = {Si:.2f}mm\n"
    )
    if Sc > 0:
        formula += (
            f"\nConsolidation: S_c = {Cc}/(1+{e0}) × {clay_thickness:.1f} × "
            f"log₁₀(({sigma_0:.1f}+{base_pressure:.1f})/{sigma_0:.1f}) × 1000\n"
            f"S_c = {Sc:.2f}mm\n"
        )
    formula += f"\nTotal = {Si:.2f} + {Sc:.2f} = {total:.2f}mm (permissible: {perm}mm)"

    notes = ""
    if status == "FAIL":
        notes = f"Total settlement {total:.1f}mm > permissible {perm}mm. Consider pile foundation or ground improvement."
    elif total > 0.7 * perm:
        notes = f"Settlement utilization high ({total/perm*100:.0f}%). Monitor during construction."
    else:
        notes = f"Settlement within limits ({total/perm*100:.0f}% utilization)."

    return SettlementResult(
        immediate_settlement=round(Si, 2),
        consolidation_settlement=round(Sc, 2),
        total_settlement=round(total, 2),
        permissible_settlement=perm,
        status=status,
        formula=formula,
        notes=notes,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# COMPLETE AUTO-DESIGN ENGINE
# ═══════════════════════════════════════════════════════════════════════════════

def run_complete_design(
    # ── Group 1: Geometry (8 fields) ──
    num_cells: int = 1,
    clear_span: float = 4.0,
    clear_height: float = 3.0,
    top_slab_thickness: float = 0.30,
    bottom_slab_thickness: float = 0.35,
    wall_thickness: float = 0.30,
    mid_wall_thickness: float = 0.30,
    haunch_size: float = 0.15,
    # ── Group 2: Material (3 fields) ──
    fck: float = 30.0,
    fy: float = 500.0,
    clear_cover: float = 50.0,
    # ── Group 3: Site & Soil (5 fields) ──
    fill_depth: float = 0.6,
    wearing_course_thickness: float = 0.075,
    gamma_soil: float = 18.0,
    friction_angle: float = 30.0,
    allowable_bearing: float = 150.0,
    # ── Group 4: Hydraulic (2 fields) ──
    water_table_depth: float = 0.0,
    culvert_length: float = 10.0,
    # ── Advanced (auto-set defaults) ──
    gamma_water: float = 9.81,
    gamma_concrete: float = 25.0,
    surcharge_intensity: float = 10.0,
    main_bar_dia: int = 16,
    dist_bar_dia: int = 12,
    main_spacing: int = 150,
    dist_spacing: int = 200,
    exposure: str = "MODERATE",
) -> dict:
    """
    Complete end-to-end RCC box culvert design from just 18 inputs.

    Auto-generates:
    1.  All load cases (DL, Fill, WC, EP, WP, Surcharge, IRC vehicles)
    2.  Longitudinal sweep for IRC 70R, Class A, Class AA
    3.  Impact factors per IRC 6 Cl. 208
    4.  Load combinations (ULS + SLS) per IRC 6 Table B.2/B.3
    5.  Bearing pressure check (IRC 78)
    6.  Uplift/buoyancy check
    7.  Reinforcement design (IS 456 / IRC 112)
    8.  Crack width check (IRC 112 Cl. 12.3.4)
    9.  Shear check (IS 456 Cl. 40)
    10. Quantities (concrete, formwork)
    11. BBS (Bar Bending Schedule)
    12. Design ratios and pass/fail dashboard

    Returns:
        dict with keys: geometry, loads, sweep, checks, bbs, quantities,
        combinations, design_ratios, summary
    """
    from app.core.loads import (
        dead_load_fill, wearing_course_load, earth_pressure_load,
        water_pressure_load, surcharge_load,
        irc_class_aa_tracked, irc_70r_tracked, irc_class_a_wheel_line,
        apply_dispersion, create_load,
    )
    from app.core.overlap import compute_overlaps, compute_summary
    from app.core.geometry import generate_standard_box_culvert_members
    from app.core.staad_export import generate_staad_text

    result = {}

    # ═══ Derived geometry ═══
    k0 = round(1 - math.sin(math.radians(friction_angle)), 4)
    total_width = (
        num_cells * clear_span
        + 2 * wall_thickness
        + max(0, num_cells - 1) * mid_wall_thickness
    )
    total_height = clear_height + top_slab_thickness + bottom_slab_thickness

    result["geometry"] = {
        "num_cells": num_cells,
        "clear_span": round(clear_span, 4),
        "clear_height": round(clear_height, 4),
        "total_width": round(total_width, 4),
        "total_height": round(total_height, 4),
        "top_slab_thickness": top_slab_thickness,
        "bottom_slab_thickness": bottom_slab_thickness,
        "wall_thickness": wall_thickness,
        "mid_wall_thickness": mid_wall_thickness,
        "haunch_size": haunch_size,
        "k0": k0,
        "fill_depth": fill_depth,
        "culvert_length": culvert_length,
    }

    # ═══ Auto-generate members ═══
    members = generate_standard_box_culvert_members(
        clear_span=clear_span,
        num_cells=num_cells,
        wall_thickness=wall_thickness,
        mid_wall_thickness=mid_wall_thickness,
        haunch_size=haunch_size,
        start_number=1001,
        increment=1,
    )

    # ═══ Stage 1: Auto-Generate All Load Cases ═══
    generated_loads = {}

    # LC1: Self-weight (handled by STAAD SELFWEIGHT command; provide as info)
    sw_top = -(gamma_concrete * top_slab_thickness)
    sw_bot = -(gamma_concrete * bottom_slab_thickness)
    generated_loads["LC1_SELF_WEIGHT"] = {
        "description": "Self-Weight (DL)",
        "irc_ref": "IRC 6, Cl. 202",
        "top_slab": f"{sw_top:.2f} kN/m² (auto via SELFWEIGHT in STAAD)",
        "bottom_slab": f"{sw_bot:.2f} kN/m²",
        "note": "Applied as SELFWEIGHT Y -1.0 in STAAD",
        "loads": [],
    }

    # LC2: Earth Fill on Top Slab
    if fill_depth > 0:
        fill_load = dead_load_fill(
            width=total_width,
            fill_depth=fill_depth,
            gamma_soil=gamma_soil,
            load_case="LC2",
        )
        fill_load_dict = _load_to_dict(fill_load)
        generated_loads["LC2_EARTH_FILL"] = {
            "description": f"Earth Fill DL ({fill_depth}m × {gamma_soil} kN/m³)",
            "irc_ref": "IRC 6, Cl. 202",
            "intensity": f"{fill_load.intensity:.2f} kN/m²",
            "loads": [fill_load_dict],
        }
    else:
        generated_loads["LC2_EARTH_FILL"] = {
            "description": "Earth Fill DL (not applicable — fill_depth = 0)",
            "loads": [],
        }

    # LC3: Wearing Course
    wc_load = wearing_course_load(
        width=total_width,
        thickness=wearing_course_thickness,
        load_case="LC3",
    )
    generated_loads["LC3_WEARING_COURSE"] = {
        "description": f"Wearing Course ({wearing_course_thickness}m × 22 kN/m³)",
        "irc_ref": "IRC 6, Cl. 202",
        "intensity": f"{wc_load.intensity:.2f} kN/m²",
        "loads": [_load_to_dict(wc_load)],
    }

    # LC4: Earth Pressure — Left Wall
    ep_left = earth_pressure_load(
        height=clear_height,
        gamma_soil=gamma_soil,
        k0=k0,
        load_case="LC4",
        wall_start=0.0,
    )
    generated_loads["LC4_EP_LEFT"] = {
        "description": f"Earth Pressure — Left Wall (K₀={k0}, γ={gamma_soil})",
        "irc_ref": "IS 456 / IRC 112",
        "max_pressure": f"{k0 * gamma_soil * clear_height:.2f} kN/m²",
        "loads": [_load_to_dict(ep_left)],
    }

    # LC5: Earth Pressure — Right Wall
    ep_right = earth_pressure_load(
        height=clear_height,
        gamma_soil=gamma_soil,
        k0=k0,
        load_case="LC5",
        wall_start=0.0,
    )
    # Mirror direction for right wall
    ep_right_dict = _load_to_dict(ep_right)
    ep_right_dict["id"] = "EP_RIGHT"
    ep_right_dict["notes"] = ep_right.notes + " (Right wall — mirrored)"
    generated_loads["LC5_EP_RIGHT"] = {
        "description": f"Earth Pressure — Right Wall (mirrored)",
        "irc_ref": "IS 456 / IRC 112",
        "max_pressure": f"{k0 * gamma_soil * clear_height:.2f} kN/m²",
        "loads": [ep_right_dict],
    }

    # LC6: Water Pressure
    water_height = clear_height  # assume full height water for worst case
    if water_table_depth > 0:
        water_height = max(0, clear_height - water_table_depth)

    if water_height > 0:
        wp = water_pressure_load(
            water_height=water_height,
            gamma_water=gamma_water,
            load_case="LC6",
        )
        generated_loads["LC6_WATER_PRESSURE"] = {
            "description": f"Water Pressure (h={water_height:.2f}m)",
            "irc_ref": "IRC 6, Cl. 213",
            "max_pressure": f"{gamma_water * water_height:.2f} kN/m²",
            "loads": [_load_to_dict(wp)],
        }
    else:
        generated_loads["LC6_WATER_PRESSURE"] = {
            "description": "Water Pressure (not applicable — water table below floor)",
            "loads": [],
        }

    # LC7: Live Load Surcharge
    sc_load = surcharge_load(
        width=clear_height,
        surcharge_intensity=surcharge_intensity,
        k0=k0,
        load_case="LC7",
    )
    generated_loads["LC7_SURCHARGE"] = {
        "description": f"LL Surcharge (q={surcharge_intensity} kN/m², K₀={k0})",
        "irc_ref": "IRC 6, Cl. 214",
        "intensity": f"{surcharge_intensity * k0:.2f} kN/m²",
        "loads": [_load_to_dict(sc_load)],
    }

    # LC8: IRC 70R Tracked
    irc70r_loads = irc_70r_tracked(load_case="LC8")
    # Apply dispersion if fill > 0
    if fill_depth > 0:
        irc70r_loads = [apply_dispersion(lo, fill_depth) for lo in irc70r_loads]
    generated_loads["LC8_70R_TRACKED"] = {
        "description": "IRC 70R Tracked (2 × 350 kN)",
        "irc_ref": "IRC 6, Annex A",
        "loads": [_load_to_dict(lo) for lo in irc70r_loads],
    }

    # LC9: IRC Class A
    class_a_loads = irc_class_a_wheel_line(load_case="LC9")
    if fill_depth > 0:
        class_a_loads = [apply_dispersion(lo, fill_depth) for lo in class_a_loads]
    generated_loads["LC9_CLASS_A"] = {
        "description": "IRC Class A Wheel Line (114 kN heaviest axle)",
        "irc_ref": "IRC 6, Annex A",
        "loads": [_load_to_dict(lo) for lo in class_a_loads],
    }

    # LC10: IRC Class AA Tracked
    class_aa_loads = irc_class_aa_tracked(load_case="LC10")
    if fill_depth > 0:
        class_aa_loads = [apply_dispersion(lo, fill_depth) for lo in class_aa_loads]
    generated_loads["LC10_CLASS_AA"] = {
        "description": "IRC Class AA Tracked (2 × 350 kN)",
        "irc_ref": "IRC 6, Annex A",
        "loads": [_load_to_dict(lo) for lo in class_aa_loads],
    }

    result["loads"] = generated_loads

    # ═══ Stage 2: Impact Factors ═══
    impact_results = {}
    for vehicle in ["CLASS_70R_TRACKED", "CLASS_A", "CLASS_AA_TRACKED"]:
        imp = compute_impact_factor(
            vehicle_class=vehicle,
            span=clear_span,
            fill_depth=fill_depth,
        )
        impact_results[vehicle] = {
            "factor": imp.impact_factor,
            "formula": imp.formula_used,
            "notes": imp.notes,
        }
    result["impact_factors"] = impact_results

    # ═══ Stage 3: Load Combinations ═══
    load_case_map = {
        "DL": 1,
        "SIDL": 2,
        "WC": 3,
        "EP": 4,
        "WP": 5,
        "SC": 6,
        "LL": 7,
    }
    combos = generate_load_combinations(
        load_case_map=load_case_map,
        structure_type="BOX_CULVERT",
        include_sls=True,
    )
    result["combinations"] = [
        {"name": c.name, "type": c.combination_type, "factors": c.factors,
         "description": c.description}
        for c in combos
    ]

    # ═══ Stage 4: Longitudinal Sweep ═══
    sweep_vehicles = ["CLASS_70R_TRACKED", "CLASS_A"]
    try:
        sweep_result = compute_longitudinal_critical_positions(
            clear_span=clear_span,
            clear_height=clear_height,
            num_cells=num_cells,
            increment=0.1,
            vehicles=sweep_vehicles,
            top_slab_thickness=top_slab_thickness,
            bottom_slab_thickness=bottom_slab_thickness,
            wall_thickness=wall_thickness,
            mid_wall_thickness=mid_wall_thickness,
            fck=fck,
        )
        result["sweep"] = sweep_result
    except Exception as e:
        result["sweep"] = {"error": str(e)}

    # ═══ Stage 5: Design Checks ═══
    checks = {}

    # 5a. Bearing Pressure
    # Estimate total vertical load (DL + fill + WC + LL)
    top_slab_sw = gamma_concrete * top_slab_thickness * total_width * culvert_length
    bot_slab_sw = gamma_concrete * bottom_slab_thickness * total_width * culvert_length
    walls_sw = gamma_concrete * wall_thickness * clear_height * culvert_length * 2
    mid_walls_sw = gamma_concrete * mid_wall_thickness * clear_height * culvert_length * max(0, num_cells - 1)
    fill_wt = gamma_soil * fill_depth * total_width * culvert_length if fill_depth > 0 else 0
    wc_wt = 22.0 * wearing_course_thickness * total_width * culvert_length
    # Approx live load (70R = 700 kN spread over culvert length)
    ll_approx = 700.0 if culvert_length >= 4.57 else 700.0 * culvert_length / 4.57
    total_vertical = top_slab_sw + bot_slab_sw + walls_sw + mid_walls_sw + fill_wt + wc_wt + ll_approx

    bearing = check_bearing_pressure(
        total_vertical_load=total_vertical / culvert_length,  # per metre run
        base_width=total_width,
        eccentricity=0.0,
        allowable_bearing=allowable_bearing,
        culvert_length=1.0,
    )
    checks["bearing_pressure"] = {
        "status": bearing.status,
        "max_pressure": bearing.max_base_pressure,
        "min_pressure": bearing.min_base_pressure,
        "allowable": allowable_bearing,
        "formula": bearing.formula,
        "utilization": bearing.utilization_ratio,
    }

    # 5b. Uplift Check
    uplift = check_uplift(
        clear_span=clear_span,
        clear_height=clear_height,
        top_slab_thickness=top_slab_thickness,
        bottom_slab_thickness=bottom_slab_thickness,
        wall_thickness=wall_thickness,
        fill_depth=fill_depth,
        water_table_depth=water_table_depth,
        num_cells=num_cells,
        gamma_concrete=gamma_concrete,
        gamma_soil=gamma_soil,
        gamma_water=gamma_water,
    )
    checks["uplift"] = {
        "status": uplift.status,
        "fos_uplift": uplift.factor_of_safety,
        "stabilising_weight": uplift.stabilizing_force,
        "uplift_force": uplift.destabilizing_force,
        "breakdown": uplift.breakdown,
    }

    # 5c. Reinforcement Design — for each element
    reinforcement = {}
    # Get max BM from sweep if available
    top_slab_bm = 0
    bot_slab_bm = 0
    wall_bm = 0
    top_slab_sf = 0
    bot_slab_sf = 0
    wall_sf = 0

    if isinstance(result.get("sweep"), dict) and "vehicles" in result.get("sweep", {}):
        for veh in result["sweep"]["vehicles"]:
            for gr in veh.get("group_results", []):
                grp = gr.get("group", "")
                max_sag = abs(gr.get("max_sagging", {}).get("value", 0))
                max_hog = abs(gr.get("max_hogging", {}).get("value", 0))
                max_sf_val = abs(gr.get("max_shear", {}).get("value", 0))
                bm_val = max(max_sag, max_hog)
                if grp == "TOP_SLAB":
                    top_slab_bm = max(top_slab_bm, bm_val)
                    top_slab_sf = max(top_slab_sf, max_sf_val)
                elif grp == "BOTTOM_SLAB":
                    bot_slab_bm = max(bot_slab_bm, bm_val)
                    bot_slab_sf = max(bot_slab_sf, max_sf_val)
                elif grp in ("SIDE_WALL", "INTERMEDIATE_WALL"):
                    wall_bm = max(wall_bm, bm_val)
                    wall_sf = max(wall_sf, max_sf_val)

    # Fallback: estimate BM from wl²/12 if sweep gave nothing
    if top_slab_bm == 0:
        # Approximate: w = total load per m, l = clear_span
        w_approx = gamma_concrete * top_slab_thickness + gamma_soil * fill_depth + 22 * wearing_course_thickness + 20
        top_slab_bm = w_approx * clear_span ** 2 / 12
    if bot_slab_bm == 0:
        bot_slab_bm = top_slab_bm * 0.8
    if wall_bm == 0:
        wall_bm = k0 * gamma_soil * clear_height ** 3 / 30 + surcharge_intensity * k0 * clear_height ** 2 / 12

    for elem_name, thickness, bm, sf in [
        ("Top Slab", top_slab_thickness, top_slab_bm, top_slab_sf),
        ("Bottom Slab", bottom_slab_thickness, bot_slab_bm, bot_slab_sf),
        ("Side Wall", wall_thickness, wall_bm, wall_sf),
    ]:
        rebar = compute_reinforcement(
            max_bm=bm,
            slab_thickness=thickness,
            clear_cover=clear_cover,
            bar_diameter=main_bar_dia,
            fck=fck,
            fy=fy,
            breadth=1000.0,
        )
        reinforcement[elem_name] = {
            "max_bm": round(bm, 2),
            "effective_depth": rebar.effective_depth,
            "ast_required": rebar.ast_required,
            "ast_min": rebar.ast_min,
            "ast_provided": rebar.ast_provided,
            "bar_dia": rebar.bar_dia,
            "spacing": rebar.spacing,
            "status": rebar.status,
            "formula": rebar.formula,
        }

    checks["reinforcement"] = reinforcement

    # 5d. Crack Width Check — for critical element (top slab)
    crack = check_crack_width(
        bm_sls=top_slab_bm * 0.7,  # SLS moment ≈ 70% of ULS
        slab_thickness=top_slab_thickness,
        clear_cover=clear_cover,
        bar_diameter=main_bar_dia,
        bar_spacing=reinforcement.get("Top Slab", {}).get("spacing", main_spacing),
        breadth=1000.0,
        fck=fck,
        fy=fy,
        exposure=exposure,
    )
    checks["crack_width"] = {
        "status": crack.status,
        "crack_width": crack.crack_width,
        "permissible": crack.permissible_crack,
        "formula": crack.formula,
        "notes": crack.notes,
    }

    # 5e. Shear Check — for each element
    shear_checks = {}
    for elem_name, thickness, sf_val in [
        ("Top Slab", top_slab_thickness, top_slab_sf if top_slab_sf > 0 else top_slab_bm / clear_span * 2),
        ("Bottom Slab", bottom_slab_thickness, bot_slab_sf if bot_slab_sf > 0 else bot_slab_bm / clear_span * 2),
        ("Side Wall", wall_thickness, wall_sf if wall_sf > 0 else wall_bm / clear_height * 2),
    ]:
        ast_prov = reinforcement.get(elem_name, {}).get("ast_provided", 0)
        shear = check_shear(
            shear_force=sf_val,
            slab_thickness=thickness,
            clear_cover=clear_cover,
            bar_diameter=main_bar_dia,
            breadth=1000.0,
            fck=fck,
            fy=fy,
            ast_provided=ast_prov,
        )
        shear_checks[elem_name] = {
            "status": shear.shear_status,
            "shear_force": round(sf_val, 2),
            "tau_v": shear.tau_v,
            "tau_c": shear.tau_c,
            "tau_c_max": shear.tau_c_max,
            "formula": shear.formula,
            "notes": shear.notes,
        }
    checks["shear"] = shear_checks

    result["checks"] = checks

    # ═══ Stage 6: Quantities ═══
    qty = estimate_quantities(
        clear_span=clear_span,
        clear_height=clear_height,
        top_slab_thickness=top_slab_thickness,
        bottom_slab_thickness=bottom_slab_thickness,
        wall_thickness=wall_thickness,
        culvert_length=culvert_length,
        num_cells=num_cells,
    )
    result["quantities"] = {
        "items": [
            {"component": item.component, "volume": item.volume,
             "formwork_area": item.formwork_area}
            for item in qty.items
        ],
        "total_concrete": qty.total_concrete_volume,
        "total_formwork": qty.total_formwork_area,
        "total_steel_kg": qty.steel_estimate_kg,
    }

    # ═══ Stage 7: BBS ═══
    bbs = generate_bbs(
        clear_span=clear_span,
        clear_height=clear_height,
        top_slab_thickness=top_slab_thickness,
        bottom_slab_thickness=bottom_slab_thickness,
        wall_thickness=wall_thickness,
        culvert_length=culvert_length,
        num_cells=num_cells,
        clear_cover=clear_cover,
        main_bar_dia=main_bar_dia,
        dist_bar_dia=dist_bar_dia,
        main_spacing=reinforcement.get("Top Slab", {}).get("spacing", main_spacing),
        dist_spacing=dist_spacing,
    )
    result["bbs"] = {
        "items": [
            {"bar_mark": item.bar_mark, "member": item.member,
             "bar_dia": item.bar_dia, "shape": item.shape,
             "cut_length": item.cut_length, "quantity": item.quantity,
             "total_length": item.total_length, "weight_per_m": item.weight_per_m,
             "total_weight": item.total_weight}
            for item in bbs.items
        ],
        "total_steel_weight": bbs.total_steel_weight,
        "wastage_percent": bbs.wastage_percent,
        "total_with_wastage": bbs.total_with_wastage,
    }

    # ═══ Stage 8: Design Ratios Dashboard ═══
    design_ratios = []

    # Flexure ratio for each element
    for elem_name in ["Top Slab", "Bottom Slab", "Side Wall"]:
        rebar_data = reinforcement.get(elem_name, {})
        ast_req = rebar_data.get("ast_required", 0)
        ast_prov = rebar_data.get("ast_provided", 0)
        ratio = ast_req / ast_prov if ast_prov > 0 else 999
        design_ratios.append({
            "check": f"Flexure — {elem_name}",
            "ratio": round(ratio, 3),
            "description": f"Ast_req/Ast_prov = {ast_req:.0f}/{ast_prov:.0f}",
            "status": "PASS" if ratio <= 1.0 else "FAIL",
            "traffic_light": "green" if ratio <= 0.85 else ("amber" if ratio <= 1.0 else "red"),
        })

    # Shear ratio
    for elem_name in ["Top Slab", "Bottom Slab", "Side Wall"]:
        sh = shear_checks.get(elem_name, {})
        tau_v = sh.get("tau_v", 0)
        tau_c = sh.get("tau_c", 1)
        ratio = tau_v / tau_c if tau_c > 0 else 999
        design_ratios.append({
            "check": f"Shear — {elem_name}",
            "ratio": round(ratio, 3),
            "description": f"τv/τc = {tau_v:.3f}/{tau_c:.3f}",
            "status": sh.get("status", ""),
            "traffic_light": "green" if ratio <= 0.85 else ("amber" if ratio <= 1.0 else "red"),
        })

    # Crack width ratio
    wk = checks.get("crack_width", {}).get("crack_width", 0)
    wk_perm = checks.get("crack_width", {}).get("permissible", 0.3)
    wk_ratio = wk / wk_perm if wk_perm > 0 else 0
    design_ratios.append({
        "check": "Crack Width — Top Slab",
        "ratio": round(wk_ratio, 3),
        "description": f"wk/wk_perm = {wk:.3f}/{wk_perm:.1f}",
        "status": checks.get("crack_width", {}).get("status", ""),
        "traffic_light": "green" if wk_ratio <= 0.80 else ("amber" if wk_ratio <= 1.0 else "red"),
    })

    # Bearing ratio
    q_max = checks.get("bearing_pressure", {}).get("max_pressure", 0)
    q_allow = checks.get("bearing_pressure", {}).get("allowable", 150)
    bp_ratio = q_max / q_allow if q_allow > 0 else 999
    design_ratios.append({
        "check": "Bearing Pressure",
        "ratio": round(bp_ratio, 3),
        "description": f"q_max/q_allow = {q_max:.1f}/{q_allow:.1f}",
        "status": checks.get("bearing_pressure", {}).get("status", ""),
        "traffic_light": "green" if bp_ratio <= 0.85 else ("amber" if bp_ratio <= 1.0 else "red"),
    })

    # Uplift FOS
    fos = checks.get("uplift", {}).get("fos_uplift", 999)
    design_ratios.append({
        "check": "Uplift / Buoyancy",
        "ratio": round(1.0 / fos if fos > 0 else 999, 3),
        "description": f"FOS = {fos:.2f} (min 1.1 required)",
        "status": checks.get("uplift", {}).get("status", ""),
        "traffic_light": "green" if fos >= 1.5 else ("amber" if fos >= 1.1 else "red"),
    })

    result["design_ratios"] = design_ratios

    # ═══ Stage 9: Critical Load Cases Table ═══
    result["critical_cases"] = [
        {
            "name": "Case I: Box Empty + LL",
            "description": "DL + Fill + WC + EP + Surcharge + LL (with impact)",
            "active_loads": ["LC1", "LC2", "LC3", "LC4", "LC5", "LC7", "LC8/LC9/LC10"],
            "uls_factors": "DL×1.35, SIDL×1.35, WC×1.75, LL×1.50, EP×1.50, SC×1.20",
        },
        {
            "name": "Case II: Box Full + LL",
            "description": "DL + Fill + WC + EP + WP + LL (with impact)",
            "active_loads": ["LC1", "LC2", "LC3", "LC4", "LC5", "LC6", "LC8/LC9/LC10"],
            "uls_factors": "DL×1.35, SIDL×1.35, WC×1.75, LL×1.50, EP×1.50, WP×1.00",
        },
        {
            "name": "Case III: Box Full − LL (Uplift Check)",
            "description": "DL + Fill + WC + EP + WP (no live load — for uplift)",
            "active_loads": ["LC1", "LC2", "LC3", "LC4", "LC5", "LC6"],
            "uls_factors": "DL×1.00, SIDL×1.00, WC×1.00, EP×1.50, WP×1.00",
        },
    ]

    # ═══ Stage 10: Summary ═══
    all_pass = all(
        r.get("traffic_light") in ("green", "amber") for r in design_ratios
    )
    result["summary"] = {
        "overall_status": "PASS" if all_pass else "REVIEW NEEDED",
        "total_load_cases": len(generated_loads),
        "total_design_checks": len(design_ratios),
        "checks_passed": sum(1 for r in design_ratios if r.get("traffic_light") in ("green", "amber")),
        "checks_failed": sum(1 for r in design_ratios if r.get("traffic_light") == "red"),
    }

    return result


def _load_to_dict(load) -> dict:
    """Convert a LoadPatch to a serialisable dict."""
    return {
        "id": load.id,
        "load_case": load.load_case,
        "load_type": load.load_type.value if hasattr(load.load_type, "value") else str(load.load_type),
        "start": load.start,
        "end": load.end,
        "intensity": load.intensity,
        "intensity_end": load.intensity_end,
        "direction": load.direction.value if hasattr(load.direction, "value") else str(load.direction),
        "notes": load.notes,
    }
