"""
Pydantic data models for Bridge Load Segmentation & STAAD.Pro Automation.

Engineering context:
- MemberSegment represents a transverse strip of a bridge deck or box culvert element.
- LoadPatch represents a load acting across the structure width (UDL, patch, IRC vehicle, etc.).
- OverlapResult stores the computed intersection of a load with a member strip,
  including d1/d2 distances needed for STAAD.Pro MEMBER LOAD commands.
"""

from __future__ import annotations
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field, field_validator
from datetime import date


# ─── Enumerations ────────────────────────────────────────────────────────────

class ReferenceAxis(str, Enum):
    LEFT_EDGE = "LEFT_EDGE"
    RIGHT_EDGE = "RIGHT_EDGE"
    CENTERLINE = "CENTERLINE"
    CUSTOM = "CUSTOM"


class LoadDirection(str, Enum):
    """STAAD.Pro global and local direction specifiers."""
    GX = "GX"
    GY = "GY"
    GZ = "GZ"
    X = "X"
    Y = "Y"
    Z = "Z"


class LoadType(str, Enum):
    PARTIAL_UDL = "PARTIAL_UDL"
    PATCH_LOAD = "PATCH_LOAD"
    POINT_BAND = "POINT_BAND"
    IRC_CLASS_AA = "IRC_CLASS_AA"
    IRC_70R = "IRC_70R"
    IRC_CLASS_A = "IRC_CLASS_A"
    EARTH_PRESSURE = "EARTH_PRESSURE"
    SURCHARGE = "SURCHARGE"
    HYDROSTATIC = "HYDROSTATIC"
    DEAD_LOAD = "DEAD_LOAD"
    WEARING_COURSE = "WEARING_COURSE"
    BRAKING = "BRAKING"
    CUSTOM = "CUSTOM"


class StructureType(str, Enum):
    BRIDGE_DECK = "BRIDGE_DECK"
    BOX_CULVERT_1CELL = "BOX_CULVERT_1CELL"
    BOX_CULVERT_2CELL = "BOX_CULVERT_2CELL"
    BOX_CULVERT_3CELL = "BOX_CULVERT_3CELL"
    BOX_CULVERT_4CELL = "BOX_CULVERT_4CELL"


class MemberGroup(str, Enum):
    TOP_SLAB = "TOP_SLAB"
    BOTTOM_SLAB = "BOTTOM_SLAB"
    LEFT_WALL = "LEFT_WALL"
    RIGHT_WALL = "RIGHT_WALL"
    MIDDLE_WALL_1 = "MIDDLE_WALL_1"
    MIDDLE_WALL_2 = "MIDDLE_WALL_2"
    MIDDLE_WALL_3 = "MIDDLE_WALL_3"
    GENERAL = "GENERAL"


class STAADFormat(str, Enum):
    """UNI = uniform, LIN = full-member linear, TRAP = partial trapezoidal."""
    UNI = "UNI"
    LIN = "LIN"
    TRAP = "TRAP"


class CoordinateUnit(str, Enum):
    M = "m"
    MM = "mm"
    FT = "ft"


class OverhangPolicy(str, Enum):
    CLIP = "CLIP"       # Clip loads to bridge width
    REJECT = "REJECT"   # Reject loads exceeding bridge width
    ALLOW = "ALLOW"     # Allow overhanging loads (warn only)


# ─── Core Models ─────────────────────────────────────────────────────────────

class ProjectSettings(BaseModel):
    """Project-level configuration and metadata."""
    project_name: str = "Untitled Project"
    bridge_name: str = ""
    engineer: str = ""
    project_date: str = Field(default_factory=lambda: date.today().isoformat())
    comments: str = ""

    structure_type: StructureType = StructureType.BRIDGE_DECK
    total_width: float = Field(gt=0, description="Overall width of bridge/culvert in chosen units")
    reference_axis: ReferenceAxis = ReferenceAxis.LEFT_EDGE
    custom_datum: float = 0.0

    # Box culvert specific
    culvert_height: float = Field(default=0.0, ge=0, description="Height of culvert walls")
    fill_depth: float = Field(default=0.0, ge=0, description="Earth fill depth above top slab")
    slab_thickness: float = Field(default=0.3, ge=0, description="Slab thickness in chosen units")
    wall_thickness: float = Field(default=0.3, ge=0, description="Wall thickness in chosen units")

    # Settings
    decimal_precision: int = Field(default=2, ge=0, le=6)
    units: CoordinateUnit = CoordinateUnit.M
    overhang_policy: OverhangPolicy = OverhangPolicy.ALLOW
    include_zero_overlaps: bool = False

    # Member numbering
    start_member_number: int = Field(default=1001, ge=1)
    member_increment: int = Field(default=1, ge=1)


class MemberSegment(BaseModel):
    """
    A single transverse strip/member of the bridge deck or culvert element.
    Start and end positions are measured from the reference axis (internally
    normalized to left edge = 0).
    """
    id: int = Field(description="STAAD member number, e.g. 1001")
    start: float = Field(description="Start position from left edge")
    end: float = Field(description="End position from left edge")
    label: str = ""
    group: MemberGroup = MemberGroup.GENERAL

    @field_validator("end")
    @classmethod
    def end_must_exceed_start(cls, v, info):
        start = info.data.get("start")
        if start is not None and v <= start:
            raise ValueError(f"Member end ({v}) must be greater than start ({start})")
        return v

    @property
    def width(self) -> float:
        return self.end - self.start


class LoadPatch(BaseModel):
    """
    A load acting across the bridge/culvert width.

    For uniform loads (UNI): intensity is constant.
    For trapezoidal loads (LIN): intensity = start value, intensity_end = end value.
    """
    id: str = Field(description="Load identifier, e.g. 'L1'")
    load_case: str = Field(default="LC1", description="Load case identifier")
    load_type: LoadType = LoadType.PARTIAL_UDL
    start: float = Field(description="Load start position (from ref axis)")
    end: float = Field(description="Load end position (from ref axis)")
    intensity: float = Field(description="Load intensity (kN/m). Negative = downward for GY")
    intensity_end: Optional[float] = Field(
        default=None,
        description="End intensity for trapezoidal loads (LIN). None = uniform (UNI)"
    )
    direction: LoadDirection = LoadDirection.GY
    notes: str = ""

    # Dispersion through fill
    dispersion_enabled: bool = False
    fill_depth_override: Optional[float] = None  # Override project-level fill depth
    contact_width: Optional[float] = None  # Original contact width before dispersion

    @field_validator("end")
    @classmethod
    def end_must_exceed_start(cls, v, info):
        start = info.data.get("start")
        if start is not None and v <= start:
            raise ValueError(f"Load end ({v}) must be greater than start ({start})")
        return v

    @property
    def span(self) -> float:
        return self.end - self.start

    @property
    def staad_format(self) -> STAADFormat:
        """Determine if this should be exported as UNI or TRAP in STAAD."""
        if self.intensity_end is not None and self.intensity_end != self.intensity:
            return STAADFormat.TRAP
        return STAADFormat.UNI


class OverlapResult(BaseModel):
    """
    Result of overlap computation between one load and one member.

    Engineering meaning:
    - front_distance (d1): distance from member start to where load begins on this member
    - back_distance (d2): distance from member start to where load ends on this member
    - These are exactly the d1 and d2 values for STAAD.Pro MEMBER LOAD UNI/LIN commands.
    """
    load_id: str
    load_case: str
    member_id: int
    member_start: float
    member_end: float
    load_start_global: float
    load_end_global: float
    overlap_start_global: float
    overlap_end_global: float
    front_distance: float = Field(description="d1: distance from member start to overlap start")
    back_distance: float = Field(description="d2: distance from member start to overlap end")
    loaded_length: float
    intensity: float
    intensity_end: Optional[float] = None  # For trapezoidal loads
    direction: LoadDirection = LoadDirection.GY
    load_type: LoadType = LoadType.PARTIAL_UDL
    staad_format: STAADFormat = STAADFormat.UNI
    notes: str = ""


class ValidationMessage(BaseModel):
    """Structured validation feedback."""
    level: str = Field(description="'error' or 'warning'")
    field: str = ""
    message: str = ""


class OverlapSummary(BaseModel):
    """Quick statistics for QA."""
    total_members: int = 0
    total_loads: int = 0
    affected_members: int = 0
    total_overlap_rows: int = 0
    total_loaded_width_by_load: dict[str, float] = Field(default_factory=dict)
    affected_members_by_load: dict[str, int] = Field(default_factory=dict)
    total_loaded_width_by_case: dict[str, float] = Field(default_factory=dict)
