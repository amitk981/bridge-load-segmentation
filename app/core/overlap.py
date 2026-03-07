"""
Overlap calculation engine — core of the application.

Computes the intersection of each load patch with each member strip,
producing front distance (d1) and back distance (d2) for STAAD.Pro
MEMBER LOAD UNI/LIN commands.

Engineering algorithm:
    overlap_start = max(member.start, load.start)
    overlap_end   = min(member.end, load.end)
    if overlap_start < overlap_end:
        d1 = overlap_start - member.start  (front distance from member start)
        d2 = overlap_end   - member.start  (back distance from member start)
"""

from __future__ import annotations
from app.models.schemas import (
    MemberSegment, LoadPatch, OverlapResult, OverlapSummary,
    STAADFormat, MemberGroup
)
from app.core.loads import apply_dispersion


def compute_overlaps(
    members: list[MemberSegment],
    loads: list[LoadPatch],
    precision: int = 2,
    fill_depth: float = 0.0,
    include_zero_overlaps: bool = False,
) -> list[OverlapResult]:
    """
    Compute all load-member overlaps.

    For each (member, load) pair, determines if the load intersects the member
    and computes d1/d2 distances for STAAD.Pro.

    For trapezoidal loads (LIN), the intensity at overlap boundaries is
    linearly interpolated from the original load's intensity gradient.

    Args:
        members: List of member strips (sorted by start position)
        loads: List of load patches
        precision: Decimal places for rounding distances
        fill_depth: Global fill depth for dispersion (used if load has dispersion_enabled)
        include_zero_overlaps: If True, include rows where overlap = 0 (debug mode)

    Returns:
        List of OverlapResult objects for all intersecting pairs
    """
    results = []

    for load in loads:
        # Apply dispersion if enabled
        effective_load = load
        if load.dispersion_enabled:
            depth = load.fill_depth_override if load.fill_depth_override else fill_depth
            if depth > 0:
                effective_load = apply_dispersion(load, depth)

        for member in members:
            overlap_start = max(member.start, effective_load.start)
            overlap_end = min(member.end, effective_load.end)

            has_overlap = overlap_start < overlap_end

            if not has_overlap and not include_zero_overlaps:
                continue

            if has_overlap:
                d1 = round(overlap_start - member.start, precision)
                d2 = round(overlap_end - member.start, precision)
                loaded_length = round(overlap_end - overlap_start, precision)

                # For trapezoidal loads, interpolate intensity at overlap boundaries
                intensity_at_start = effective_load.intensity
                intensity_at_end = effective_load.intensity
                staad_fmt = STAADFormat.UNI

                if effective_load.intensity_end is not None and \
                   effective_load.intensity_end != effective_load.intensity:
                    # Linear interpolation of intensity across the load span
                    # Engineering: earth pressure varies linearly with depth
                    load_span = effective_load.end - effective_load.start
                    if load_span > 0:
                        t_start = (overlap_start - effective_load.start) / load_span
                        t_end = (overlap_end - effective_load.start) / load_span
                        i_range = effective_load.intensity_end - effective_load.intensity
                        intensity_at_start = round(
                            effective_load.intensity + t_start * i_range, precision
                        )
                        intensity_at_end = round(
                            effective_load.intensity + t_end * i_range, precision
                        )
                        staad_fmt = STAADFormat.LIN
                    else:
                        intensity_at_end = None
                else:
                    intensity_at_end = None

                results.append(OverlapResult(
                    load_id=effective_load.id,
                    load_case=effective_load.load_case,
                    member_id=member.id,
                    member_start=round(member.start, precision),
                    member_end=round(member.end, precision),
                    load_start_global=round(effective_load.start, precision),
                    load_end_global=round(effective_load.end, precision),
                    overlap_start_global=round(overlap_start, precision),
                    overlap_end_global=round(overlap_end, precision),
                    front_distance=d1,
                    back_distance=d2,
                    loaded_length=loaded_length,
                    intensity=intensity_at_start,
                    intensity_end=intensity_at_end,
                    direction=effective_load.direction,
                    load_type=effective_load.load_type,
                    staad_format=staad_fmt,
                    notes=effective_load.notes,
                ))
            elif include_zero_overlaps:
                # Zero overlap row for debugging
                results.append(OverlapResult(
                    load_id=effective_load.id,
                    load_case=effective_load.load_case,
                    member_id=member.id,
                    member_start=round(member.start, precision),
                    member_end=round(member.end, precision),
                    load_start_global=round(effective_load.start, precision),
                    load_end_global=round(effective_load.end, precision),
                    overlap_start_global=0.0,
                    overlap_end_global=0.0,
                    front_distance=0.0,
                    back_distance=0.0,
                    loaded_length=0.0,
                    intensity=0.0,
                    direction=effective_load.direction,
                    load_type=effective_load.load_type,
                    staad_format=STAADFormat.UNI,
                    notes="No overlap",
                ))

    return results


def compute_summary(
    members: list[MemberSegment],
    loads: list[LoadPatch],
    overlaps: list[OverlapResult],
) -> OverlapSummary:
    """
    Compute summary statistics for QA.

    Returns:
        OverlapSummary with total counts and per-load/per-case widths
    """
    affected_member_ids = set(r.member_id for r in overlaps if r.loaded_length > 0)

    # Total loaded width per load
    width_by_load: dict[str, float] = {}
    members_by_load: dict[str, set] = {}
    for r in overlaps:
        if r.loaded_length > 0:
            width_by_load[r.load_id] = width_by_load.get(r.load_id, 0.0) + r.loaded_length
            if r.load_id not in members_by_load:
                members_by_load[r.load_id] = set()
            members_by_load[r.load_id].add(r.member_id)

    # Total loaded width per case
    width_by_case: dict[str, float] = {}
    for r in overlaps:
        if r.loaded_length > 0:
            width_by_case[r.load_case] = width_by_case.get(r.load_case, 0.0) + r.loaded_length

    return OverlapSummary(
        total_members=len(members),
        total_loads=len(loads),
        affected_members=len(affected_member_ids),
        total_overlap_rows=len([r for r in overlaps if r.loaded_length > 0]),
        total_loaded_width_by_load={k: round(v, 4) for k, v in width_by_load.items()},
        affected_members_by_load={k: len(v) for k, v in members_by_load.items()},
        total_loaded_width_by_case={k: round(v, 4) for k, v in width_by_case.items()},
    )
