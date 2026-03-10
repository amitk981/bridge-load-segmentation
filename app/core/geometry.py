"""
Geometry module — bridge deck and box culvert strip segmentation.

Handles:
- Equal-width automatic segmentation of bridge deck
- Manual custom-width segments
- Box culvert member group generation (top slab, walls, base slab)
- Reference axis normalization
"""

from __future__ import annotations
from app.models.schemas import (
    MemberSegment, MemberGroup, StructureType, ReferenceAxis
)


def generate_equal_segments(
    total_width: float,
    num_segments: int,
    start_number: int = 1001,
    increment: int = 1,
    group: MemberGroup = MemberGroup.GENERAL,
    label_prefix: str = ""
) -> list[MemberSegment]:
    """
    Divide total_width into num_segments equal strips.

    Engineering note: Each strip becomes a STAAD member. The strip boundaries
    define where load d1/d2 distances are computed relative to.

    Args:
        total_width: Overall width to segment (m)
        num_segments: Number of equal strips
        start_number: Starting member ID (e.g., 1001)
        increment: Member ID increment
        group: Member group assignment
        label_prefix: Optional label prefix

    Returns:
        List of MemberSegment objects with sequential IDs
    """
    if num_segments <= 0:
        raise ValueError("Number of segments must be positive")
    if total_width <= 0:
        raise ValueError("Total width must be positive")

    strip_width = total_width / num_segments
    members = []

    for i in range(num_segments):
        member_id = start_number + i * increment
        start = round(i * strip_width, 10)  # Avoid float artifacts
        end = round((i + 1) * strip_width, 10)
        label = f"{label_prefix}{member_id}" if label_prefix else ""

        members.append(MemberSegment(
            id=member_id,
            start=start,
            end=end,
            label=label,
            group=group,
        ))

    return members


def create_manual_segments(
    rows: list[dict],
    group: MemberGroup = MemberGroup.GENERAL
) -> list[MemberSegment]:
    """
    Create segments from user-defined rows.

    Each row dict must have: id, start, end
    Optional: label, group

    Args:
        rows: List of dicts with member data
        group: Default group if not specified per row

    Returns:
        List of MemberSegment objects
    """
    members = []
    for row in rows:
        members.append(MemberSegment(
            id=int(row["id"]),
            start=float(row["start"]),
            end=float(row["end"]),
            label=row.get("label", ""),
            group=MemberGroup(row["group"]) if "group" in row else group,
        ))
    return members


def generate_box_culvert_members(
    structure_type: StructureType,
    total_width: float,
    culvert_height: float,
    num_top_strips: int = 10,
    num_wall_strips: int = 8,
    num_base_strips: int = 41,
    start_number: int = 1001,
    wall_thickness: float = 0.3,
) -> list[MemberSegment]:
    """
    Generate all member groups for a box culvert.

    Member numbering convention:
    - 1001-1xxx: Top slab strips
    - 2001-2xxx: Left wall segments
    - 3001-3xxx: Right wall segments
    - 4001-4xxx: Base slab strips
    - 5001-5xxx: Middle wall 1 segments (if multi-cell)
    - 6001-6xxx: Middle wall 2 segments (if multi-cell)
    - 7001-7xxx: Middle wall 3 segments (if multi-cell)

    Engineering note: For a multi-cell culvert, middle walls act as
    intermediate supports reducing slab spans and bending moments.

    Args:
        structure_type: Single, double, triple, or quad cell
        total_width: Overall culvert width
        culvert_height: Height of walls
        num_top_strips: Number of strips for top slab
        num_wall_strips: Number of strips for each wall
        num_base_strips: Number of strips for base slab
        start_number: Base start number (thousands digit varies by group)
        wall_thickness: Thickness of walls (for clear span calculation)

    Returns:
        List of all MemberSegments across all groups
    """
    members = []

    # Top slab strips (across width)
    members.extend(generate_equal_segments(
        total_width=total_width,
        num_segments=num_top_strips,
        start_number=1001,
        group=MemberGroup.TOP_SLAB,
        label_prefix="TS_"
    ))

    # Base slab strips (across width)
    members.extend(generate_equal_segments(
        total_width=total_width,
        num_segments=num_base_strips,
        start_number=4001,
        group=MemberGroup.BOTTOM_SLAB,
        label_prefix="BS_"
    ))

    # Left wall segments (along height, from top to bottom)
    members.extend(generate_equal_segments(
        total_width=culvert_height,
        num_segments=num_wall_strips,
        start_number=2001,
        group=MemberGroup.LEFT_WALL,
        label_prefix="LW_"
    ))

    # Right wall segments (along height)
    members.extend(generate_equal_segments(
        total_width=culvert_height,
        num_segments=num_wall_strips,
        start_number=3001,
        group=MemberGroup.RIGHT_WALL,
        label_prefix="RW_"
    ))

    # Middle walls based on cell count
    num_cells = _get_cell_count(structure_type)
    if num_cells >= 2:
        # Calculate cell width positions for middle walls
        clear_width = total_width - 2 * wall_thickness
        cell_width = (clear_width - (num_cells - 1) * wall_thickness) / num_cells

        for wall_idx in range(1, num_cells):
            wall_position = wall_thickness + wall_idx * (cell_width + wall_thickness)
            group_map = {
                1: MemberGroup.MIDDLE_WALL_1,
                2: MemberGroup.MIDDLE_WALL_2,
                3: MemberGroup.MIDDLE_WALL_3,
            }
            wall_group = group_map.get(wall_idx, MemberGroup.MIDDLE_WALL_1)
            wall_start_id = (4 + wall_idx) * 1000 + 1

            members.extend(generate_equal_segments(
                total_width=culvert_height,
                num_segments=num_wall_strips,
                start_number=wall_start_id,
                group=wall_group,
                label_prefix=f"MW{wall_idx}_"
            ))

    return members


def normalize_positions(
    members: list[MemberSegment],
    reference_axis: ReferenceAxis,
    total_width: float,
    custom_datum: float = 0.0
) -> list[MemberSegment]:
    """
    Normalize all positions to left-edge = 0 coordinate system.

    Engineering note: Users may define positions from right edge, centerline,
    or a custom datum. Internally we always work from left edge = 0.

    Args:
        members: Members with positions in user's reference system
        reference_axis: User's chosen reference
        total_width: Total bridge/culvert width
        custom_datum: Custom origin position from left edge

    Returns:
        Members with positions adjusted to left-edge reference
    """
    if reference_axis == ReferenceAxis.LEFT_EDGE:
        return members  # Already normalized

    offset = 0.0
    if reference_axis == ReferenceAxis.RIGHT_EDGE:
        # User measures from right; flip positions
        normalized = []
        for m in members:
            normalized.append(MemberSegment(
                id=m.id,
                start=total_width - m.end,
                end=total_width - m.start,
                label=m.label,
                group=m.group,
            ))
        return normalized
    elif reference_axis == ReferenceAxis.CENTERLINE:
        offset = total_width / 2.0
    elif reference_axis == ReferenceAxis.CUSTOM:
        offset = custom_datum

    # Shift all positions by offset
    normalized = []
    for m in members:
        normalized.append(MemberSegment(
            id=m.id,
            start=m.start + offset,
            end=m.end + offset,
            label=m.label,
            group=m.group,
        ))
    return normalized


def _get_cell_count(structure_type: StructureType) -> int:
    """Map structure type to number of cells."""
    return {
        StructureType.BRIDGE_DECK: 0,
        StructureType.BOX_CULVERT_1CELL: 1,
        StructureType.BOX_CULVERT_2CELL: 2,
        StructureType.BOX_CULVERT_3CELL: 3,
        StructureType.BOX_CULVERT_4CELL: 4,
    }.get(structure_type, 0)
