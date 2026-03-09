"""
Test suite for core engine modules.

Covers: geometry segmentation, overlap computation, trapezoidal loads,
        dispersion, STAAD export format, summary statistics.
"""

import pytest
from app.models.schemas import (
    MemberSegment, LoadPatch, LoadType, LoadDirection,
    MemberGroup, StructureType, STAADFormat,
)
from app.core.geometry import generate_equal_segments, generate_box_culvert_members
from app.core.overlap import compute_overlaps, compute_summary
from app.core.loads import (
    apply_dispersion, irc_class_aa_tracked, irc_70r_tracked,
    irc_70r_wheeled, irc_single_axle_bogie, irc_double_axle_bogie,
    earth_pressure_load, water_pressure_load,
)
from app.core.smart_features import (
    compute_longitudinal_critical_positions,
    check_bearing_pressure,
    check_deflection,
)
from app.core.staad_export import generate_staad_text
from app.core.validation import validate_members, validate_loads


# ─── Geometry Tests ──────────────────────────────────────────────────────────

class TestGeometry:

    def test_equal_segments_count(self):
        members = generate_equal_segments(8.5, 10)
        assert len(members) == 10

    def test_equal_segments_coverage(self):
        members = generate_equal_segments(8.5, 10)
        assert members[0].start == 0.0
        assert abs(members[-1].end - 8.5) < 1e-9

    def test_equal_segments_ids(self):
        members = generate_equal_segments(8.5, 5, start_number=2001, increment=2)
        ids = [m.id for m in members]
        assert ids == [2001, 2003, 2005, 2007, 2009]

    def test_equal_segments_no_gaps(self):
        members = generate_equal_segments(10.0, 4)
        for i in range(len(members) - 1):
            assert abs(members[i].end - members[i + 1].start) < 1e-9

    def test_equal_segments_width(self):
        members = generate_equal_segments(12.0, 4)
        for m in members:
            assert abs(m.width - 3.0) < 1e-9

    def test_box_culvert_1cell(self):
        members = generate_box_culvert_members(
            StructureType.BOX_CULVERT_1CELL, 8.5, 3.0
        )
        groups = set(m.group for m in members)
        assert MemberGroup.TOP_SLAB in groups
        assert MemberGroup.BOTTOM_SLAB in groups
        assert MemberGroup.LEFT_WALL in groups
        assert MemberGroup.RIGHT_WALL in groups
        assert MemberGroup.MIDDLE_WALL_1 not in groups

    def test_box_culvert_2cell(self):
        members = generate_box_culvert_members(
            StructureType.BOX_CULVERT_2CELL, 8.5, 3.0
        )
        groups = set(m.group for m in members)
        assert MemberGroup.MIDDLE_WALL_1 in groups


# ─── Overlap Tests ───────────────────────────────────────────────────────────

class TestOverlap:

    def _members(self, width=10.0, num=5):
        return generate_equal_segments(width, num)

    def test_no_overlap(self):
        members = self._members(10, 5)  # 0-2, 2-4, 4-6, 6-8, 8-10
        load = LoadPatch(id="L1", start=11, end=12, intensity=-10, direction=LoadDirection.GY)
        results = compute_overlaps(members, [load])
        assert len(results) == 0

    def test_full_single_member_overlap(self):
        members = self._members(10, 5)  # 0-2, 2-4, ...
        load = LoadPatch(id="L1", start=0, end=2, intensity=-10, direction=LoadDirection.GY)
        results = compute_overlaps(members, [load])
        assert len(results) == 1
        r = results[0]
        assert r.member_id == 1001
        assert r.front_distance == 0.0
        assert r.back_distance == 2.0
        assert r.loaded_length == 2.0

    def test_partial_overlap(self):
        members = self._members(10, 5)  # each 2m wide
        # Load spans from 1 to 3 → overlaps member[0](0-2) and member[1](2-4)
        load = LoadPatch(id="L1", start=1, end=3, intensity=-10, direction=LoadDirection.GY)
        results = compute_overlaps(members, [load])
        assert len(results) == 2

        # First member: overlap = 1 to 2, d1=1, d2=2
        r1 = results[0]
        assert r1.front_distance == 1.0
        assert r1.back_distance == 2.0
        assert r1.loaded_length == 1.0

        # Second member: overlap = 2 to 3, d1=0, d2=1
        r2 = results[1]
        assert r2.front_distance == 0.0
        assert r2.back_distance == 1.0
        assert r2.loaded_length == 1.0

    def test_load_spans_all_members(self):
        members = self._members(10, 5)
        load = LoadPatch(id="L1", start=0, end=10, intensity=-10, direction=LoadDirection.GY)
        results = compute_overlaps(members, [load])
        assert len(results) == 5
        total_loaded = sum(r.loaded_length for r in results)
        assert abs(total_loaded - 10.0) < 1e-9

    def test_trapezoidal_load_interpolation(self):
        """Earth pressure varies 0 at top to 27 at bottom over 3m wall."""
        members = generate_equal_segments(3.0, 3)  # 0-1, 1-2, 2-3

        load = LoadPatch(
            id="EP", start=0, end=3, intensity=0.0,
            intensity_end=27.0, direction=LoadDirection.GX,
        )
        results = compute_overlaps(members, [load])
        assert len(results) == 3

        # First member (0-1): intensity 0 to 9
        assert abs(results[0].intensity - 0.0) < 0.01
        assert abs(results[0].intensity_end - 9.0) < 0.01
        assert results[0].staad_format == STAADFormat.TRAP

        # Second member (1-2): intensity 9 to 18
        assert abs(results[1].intensity - 9.0) < 0.01
        assert abs(results[1].intensity_end - 18.0) < 0.01

        # Third member (2-3): intensity 18 to 27
        assert abs(results[2].intensity - 18.0) < 0.01
        assert abs(results[2].intensity_end - 27.0) < 0.01

    def test_multiple_loads(self):
        members = self._members(10, 5)
        loads = [
            LoadPatch(id="L1", start=0, end=3, intensity=-10, direction=LoadDirection.GY),
            LoadPatch(id="L2", start=7, end=10, intensity=-15, direction=LoadDirection.GY),
        ]
        results = compute_overlaps(members, loads)
        l1_results = [r for r in results if r.load_id == "L1"]
        l2_results = [r for r in results if r.load_id == "L2"]
        assert len(l1_results) == 2  # spans members 1001, 1002
        assert len(l2_results) == 2  # spans members 1004, 1005

    def test_rounding(self):
        members = self._members(10, 3)
        load = LoadPatch(id="L1", start=1.123, end=4.567, intensity=-10, direction=LoadDirection.GY)
        results = compute_overlaps(members, [load], precision=2)
        for r in results:
            assert r.front_distance == round(r.front_distance, 2)
            assert r.back_distance == round(r.back_distance, 2)


# ─── Dispersion Tests ────────────────────────────────────────────────────────

class TestDispersion:

    def test_dispersion_widens_load(self):
        load = LoadPatch(id="L1", start=3.0, end=4.0, intensity=-100, direction=LoadDirection.GY)
        dispersed = apply_dispersion(load, fill_depth=1.5)
        assert dispersed.span > load.span  # Wider
        assert abs(dispersed.intensity) < abs(load.intensity)  # Less intense

    def test_dispersion_preserves_center(self):
        load = LoadPatch(id="L1", start=3.0, end=4.0, intensity=-100, direction=LoadDirection.GY)
        original_center = (load.start + load.end) / 2
        dispersed = apply_dispersion(load, fill_depth=2.0)
        new_center = (dispersed.start + dispersed.end) / 2
        assert abs(original_center - new_center) < 1e-9

    def test_dispersion_conserves_total_force(self):
        """Total force = intensity × width should be preserved."""
        load = LoadPatch(id="L1", start=3.0, end=4.0, intensity=-100,
                         direction=LoadDirection.GY, contact_width=1.0)
        original_force = abs(load.intensity) * load.span
        dispersed = apply_dispersion(load, fill_depth=1.0)
        dispersed_force = abs(dispersed.intensity) * dispersed.span
        assert abs(original_force - dispersed_force) < 0.01

    def test_zero_fill_no_change(self):
        load = LoadPatch(id="L1", start=3.0, end=4.0, intensity=-100, direction=LoadDirection.GY)
        dispersed = apply_dispersion(load, fill_depth=0.0)
        assert dispersed.start == load.start
        assert dispersed.end == load.end


# ─── Template Tests ──────────────────────────────────────────────────────────

class TestTemplates:

    def test_irc_class_aa_two_tracks(self):
        loads = irc_class_aa_tracked()
        assert len(loads) == 2
        assert loads[0].load_type == LoadType.IRC_CLASS_AA
        assert abs(loads[0].span - 0.85) < 1e-9

    def test_irc_70r_two_tracks(self):
        loads = irc_70r_tracked()
        assert len(loads) == 2
        assert abs(loads[0].span - 0.84) < 1e-9
        assert "Tracked" in loads[0].notes

    def test_irc_70r_wheeled_template(self):
        loads = irc_70r_wheeled()
        assert len(loads) == 2
        assert loads[0].load_type == LoadType.IRC_70R
        assert "Wheeled" in loads[0].notes
        assert "vehicle=CLASS_70R_WHEELED" in loads[0].notes

    def test_single_axle_bogie_template(self):
        loads = irc_single_axle_bogie()
        assert len(loads) == 2
        assert loads[0].load_type == LoadType.SINGLE_AXLE_BOGIE
        assert "Single Axle Bogie" in loads[0].notes

    def test_double_axle_bogie_template(self):
        loads = irc_double_axle_bogie()
        assert len(loads) == 4
        assert loads[0].load_type == LoadType.DOUBLE_AXLE_BOGIE
        assert "Double Axle Bogie" in loads[0].notes

    def test_earth_pressure_trapezoidal(self):
        load = earth_pressure_load(height=3.0)
        assert load.intensity == 0.0
        assert load.intensity_end == 0.5 * 18.0 * 3.0  # K0*gamma*H = 27
        assert load.staad_format == STAADFormat.TRAP

    def test_water_pressure(self):
        load = water_pressure_load(water_height=3.0)
        assert load.intensity == 0.0
        assert abs(load.intensity_end - 9.81 * 3.0) < 0.01


# ─── STAAD Export Tests ──────────────────────────────────────────────────────

class TestSTAADExport:

    def test_uni_format(self):
        members = generate_equal_segments(10, 5)
        load = LoadPatch(id="L1", start=1, end=3, intensity=-10, direction=LoadDirection.GY)
        overlaps = compute_overlaps(members, [load])
        text = generate_staad_text(overlaps)
        assert "UNI GY" in text
        assert "1001" in text
        assert "MEMBER LOAD" in text

    def test_lin_format(self):
        members = generate_equal_segments(3.0, 3)
        load = LoadPatch(id="EP", start=0, end=3, intensity=0.0,
                         intensity_end=27.0, direction=LoadDirection.GX)
        overlaps = compute_overlaps(members, [load])
        text = generate_staad_text(overlaps)
        assert "TRAP GX" in text

    def test_empty_overlaps(self):
        text = generate_staad_text([])
        assert "No loads" in text


# ─── Validation Tests ────────────────────────────────────────────────────────

class TestValidation:

    def test_no_members_error(self):
        msgs = validate_members([], 10.0)
        assert len(msgs) == 1
        assert msgs[0].level == "error"

    def test_valid_members_no_errors(self):
        members = generate_equal_segments(10.0, 5)
        msgs = validate_members(members, 10.0)
        errors = [m for m in msgs if m.level == "error"]
        assert len(errors) == 0

    def test_no_loads_warning(self):
        msgs = validate_loads([], 10.0)
        assert len(msgs) == 1
        assert msgs[0].level == "warning"


# ─── Summary Tests ───────────────────────────────────────────────────────────

class TestSummary:

    def test_summary_counts(self):
        members = generate_equal_segments(10, 5)
        loads = [
            LoadPatch(id="L1", start=0, end=5, intensity=-10, direction=LoadDirection.GY),
        ]
        overlaps = compute_overlaps(members, loads)
        summary = compute_summary(members, loads, overlaps)

        assert summary.total_members == 5
        assert summary.total_loads == 1
        assert summary.affected_members == 3  # Members 0-2, 2-4, 4-6 partially covered
        assert summary.total_overlap_rows == 3
        assert abs(summary.total_loaded_width_by_load["L1"] - 5.0) < 1e-4


# ─── Longitudinal Sweep Tests ────────────────────────────────────────────────

class TestLongitudinalSweep:

    def test_longitudinal_sweep_returns_requested_vehicles(self):
        result = compute_longitudinal_critical_positions(
            clear_span=4.0,
            clear_height=3.0,
            num_cells=2,
            increment=0.1,
            vehicles=["CLASS_70R_WHEELED", "CLASS_A"],
        )

        vehicles = result["vehicles"]
        assert len(vehicles) == 2
        assert vehicles[0]["vehicle_code"] == "CLASS_70R_WHEELED"
        assert vehicles[1]["vehicle_code"] == "CLASS_A"

    def test_longitudinal_sweep_group_results_present(self):
        result = compute_longitudinal_critical_positions(
            clear_span=4.0,
            clear_height=3.0,
            num_cells=2,
            increment=0.1,
            vehicles=["DOUBLE_AXLE_BOGIE"],
        )
        groups = {g["group"] for g in result["vehicles"][0]["group_results"]}
        assert groups == {"TOP_SLAB", "BOTTOM_SLAB", "SIDE_WALL", "INTERMEDIATE_WALL"}


# ─── Serviceability / Foundation Checks ──────────────────────────────────────

class TestServiceabilityAndFoundationChecks:

    def test_bearing_fails_when_min_pressure_is_negative(self):
        result = check_bearing_pressure(
            total_vertical_load=200.0,
            base_width=4.0,
            eccentricity=0.8,
            allowable_bearing=120.0,
            culvert_length=1.0,
        )
        assert result.min_base_pressure < 0
        assert result.status == "FAIL"

    def test_deflection_service_stress_reduces_with_more_steel(self):
        low_steel = check_deflection(
            span=4.0,
            slab_thickness=0.30,
            ast_provided=400.0,
            support_condition="CONTINUOUS",
        )
        high_steel = check_deflection(
            span=4.0,
            slab_thickness=0.30,
            ast_provided=2400.0,
            support_condition="CONTINUOUS",
        )

        assert high_steel.fs < low_steel.fs
        assert "reference pt=0.50%" in low_steel.formula
