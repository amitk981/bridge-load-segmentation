"""
Input validation — structured error/warning messages.

Validates members, loads, and their relationships to the bridge/culvert geometry.
Does NOT silently correct bad data; returns messages for the UI to display.
"""

from __future__ import annotations
from app.models.schemas import (
    MemberSegment, LoadPatch, ProjectSettings, ValidationMessage, OverhangPolicy
)


def validate_members(
    members: list[MemberSegment],
    total_width: float,
) -> list[ValidationMessage]:
    """
    Validate member segments.

    Checks:
    - Each member has end > start (enforced by Pydantic, but double-check)
    - Members are sorted and non-overlapping
    - Members don't exceed total width
    - At least one member exists
    """
    messages = []

    if not members:
        messages.append(ValidationMessage(
            level="error", field="members",
            message="No members defined. Add at least one member strip."
        ))
        return messages

    # Group members by their structural group to avoid false positive overlap
    # errors between slabs and vertical walls which share the same X coordinates.
    from collections import defaultdict
    groups = defaultdict(list)
    for m in members:
        groups[m.group].append(m)

    for group_name, group_members in groups.items():
        # Sort by start position for boundary checks within this group
        sorted_members = sorted(group_members, key=lambda m: m.start)

        for i, m in enumerate(sorted_members):
            if m.end <= m.start:
                messages.append(ValidationMessage(
                    level="error", field=f"member_{m.id}",
                    message=f"Member {m.id} ({m.group}): end ({m.end}) must be > start ({m.start})"
                ))

            if m.start < -1e-9:
                messages.append(ValidationMessage(
                    level="warning", field=f"member_{m.id}",
                    message=f"Member {m.id} ({m.group}): start ({m.start}) is before origin (0)"
                ))

            if m.end > total_width + 1e-9:
                messages.append(ValidationMessage(
                    level="warning", field=f"member_{m.id}",
                    message=f"Member {m.id} ({m.group}): end ({m.end}) exceeds total width ({total_width})"
                ))

            # Check overlap with previous member in the SAME group
            if i > 0:
                prev = sorted_members[i - 1]
                if m.start < prev.end - 1e-9:
                    messages.append(ValidationMessage(
                        level="error", field=f"member_{m.id}",
                        message=f"Member {m.id} ({m.group}) overlaps with member {prev.id}: "
                                f"{m.id} starts at {m.start} but {prev.id} ends at {prev.end}"
                    ))

    return messages


def validate_loads(
    loads: list[LoadPatch],
    total_width: float,
    overhang_policy: OverhangPolicy = OverhangPolicy.ALLOW,
) -> list[ValidationMessage]:
    """
    Validate load definitions.

    Checks:
    - Load start < end
    - Load positions relative to bridge width
    - Intensity is non-zero
    - Overhang policy compliance
    """
    messages = []

    if not loads:
        messages.append(ValidationMessage(
            level="warning", field="loads",
            message="No loads defined."
        ))
        return messages

    for load in loads:
        if load.end <= load.start:
            messages.append(ValidationMessage(
                level="error", field=f"load_{load.id}",
                message=f"Load {load.id}: end ({load.end}) must be > start ({load.start})"
            ))

        if load.intensity == 0 and (load.intensity_end is None or load.intensity_end == 0):
            messages.append(ValidationMessage(
                level="warning", field=f"load_{load.id}",
                message=f"Load {load.id}: intensity is zero"
            ))

        # Check if load exceeds bridge width
        if load.start < -1e-9 or load.end > total_width + 1e-9:
            if overhang_policy == OverhangPolicy.REJECT:
                messages.append(ValidationMessage(
                    level="error", field=f"load_{load.id}",
                    message=f"Load {load.id}: extends beyond bridge width "
                            f"({load.start} to {load.end}, width={total_width}). "
                            f"Rejected by overhang policy."
                ))
            elif overhang_policy == OverhangPolicy.ALLOW:
                messages.append(ValidationMessage(
                    level="warning", field=f"load_{load.id}",
                    message=f"Load {load.id}: extends beyond bridge width "
                            f"({load.start} to {load.end}, width={total_width})"
                ))
            # CLIP: no message, will be clipped in calculation

    return messages


def validate_all(
    settings: ProjectSettings,
    members: list[MemberSegment],
    loads: list[LoadPatch],
) -> list[ValidationMessage]:
    """Run all validations and return combined messages."""
    messages = []
    messages.extend(validate_members(members, settings.total_width))
    messages.extend(validate_loads(loads, settings.total_width, settings.overhang_policy))
    return messages
