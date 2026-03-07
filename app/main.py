"""
Flask application — main entry point.

API routes for calculation, export, and project management.
Serves the single-page frontend application.
"""

from __future__ import annotations
import io
import json
from datetime import date
from flask import Flask, render_template, request, jsonify, send_file

from app.models.schemas import (
    ProjectSettings, MemberSegment, LoadPatch, OverlapResult,
    LoadType, LoadDirection, MemberGroup, StructureType,
    ReferenceAxis, OverhangPolicy, CoordinateUnit, STAADFormat,
)
from app.core.geometry import (
    generate_equal_segments, create_manual_segments,
    generate_box_culvert_members, normalize_positions,
)
from app.core.loads import (
    create_load, apply_dispersion, parse_loads_csv,
    irc_class_aa_tracked, irc_70r_tracked, irc_class_a_wheel_line,
    earth_pressure_load, water_pressure_load, surcharge_load,
    dead_load_fill, wearing_course_load,
)
from app.core.overlap import compute_overlaps, compute_summary
from app.core.validation import validate_all
from app.core.staad_export import generate_staad_text
from app.core.excel_export import generate_excel

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/calculate", methods=["POST"])
def calculate():
    """Run overlap engine and return results."""
    try:
        data = request.json

        settings = _parse_settings(data.get("settings", {}))
        members = _parse_members(data.get("members", []), settings)
        loads = _parse_loads(data.get("loads", []))

        # Validate
        messages = validate_all(settings, members, loads)
        errors = [m for m in messages if m.level == "error"]
        if errors:
            return jsonify({
                "success": False,
                "validation": [m.model_dump() for m in messages],
            }), 400

        # Compute overlaps
        overlaps = compute_overlaps(
            members, loads,
            precision=settings.decimal_precision,
            fill_depth=settings.fill_depth,
            include_zero_overlaps=settings.include_zero_overlaps,
        )

        summary = compute_summary(members, loads, overlaps)
        staad_text = generate_staad_text(overlaps, settings.decimal_precision)

        return jsonify({
            "success": True,
            "overlaps": [r.model_dump() for r in overlaps],
            "summary": summary.model_dump(),
            "staad_text": staad_text,
            "validation": [m.model_dump() for m in messages],
        })

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/export/excel", methods=["POST"])
def export_excel():
    """Generate and download Excel workbook."""
    try:
        data = request.json
        settings = _parse_settings(data.get("settings", {}))
        members = _parse_members(data.get("members", []), settings)
        loads = _parse_loads(data.get("loads", []))

        overlaps = compute_overlaps(
            members, loads,
            precision=settings.decimal_precision,
            fill_depth=settings.fill_depth,
        )
        summary = compute_summary(members, loads, overlaps)

        buffer = generate_excel(
            settings, members, loads, overlaps, summary,
            precision=settings.decimal_precision,
        )

        filename = f"{settings.project_name.replace(' ', '_')}_Load_Segmentation.xlsx"
        return send_file(
            buffer,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name=filename,
        )

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/export/staad", methods=["POST"])
def export_staad():
    """Generate and download STAAD text file."""
    try:
        data = request.json
        settings = _parse_settings(data.get("settings", {}))
        members = _parse_members(data.get("members", []), settings)
        loads = _parse_loads(data.get("loads", []))

        overlaps = compute_overlaps(
            members, loads,
            precision=settings.decimal_precision,
            fill_depth=settings.fill_depth,
        )

        staad_text = generate_staad_text(overlaps, settings.decimal_precision)

        buffer = io.BytesIO(staad_text.encode("utf-8"))
        buffer.seek(0)

        filename = f"{settings.project_name.replace(' ', '_')}_STAAD_Export.txt"
        return send_file(
            buffer,
            mimetype="text/plain",
            as_attachment=True,
            download_name=filename,
        )

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/export/csv", methods=["POST"])
def export_csv():
    """Export overlap results as CSV."""
    try:
        data = request.json
        settings = _parse_settings(data.get("settings", {}))
        members = _parse_members(data.get("members", []), settings)
        loads = _parse_loads(data.get("loads", []))

        overlaps = compute_overlaps(
            members, loads,
            precision=settings.decimal_precision,
            fill_depth=settings.fill_depth,
        )

        import csv
        output = io.StringIO()
        writer = csv.writer(output)

        headers = [
            "load_id", "load_case", "member_id",
            "member_start", "member_end",
            "load_start_global", "load_end_global",
            "overlap_start_global", "overlap_end_global",
            "front_distance_d1", "back_distance_d2",
            "loaded_length", "intensity", "intensity_end",
            "direction", "staad_format", "notes",
        ]
        writer.writerow(headers)

        for r in overlaps:
            writer.writerow([
                r.load_id, r.load_case, r.member_id,
                r.member_start, r.member_end,
                r.load_start_global, r.load_end_global,
                r.overlap_start_global, r.overlap_end_global,
                r.front_distance, r.back_distance,
                r.loaded_length, r.intensity,
                r.intensity_end if r.intensity_end is not None else "",
                r.direction.value, r.staad_format.value, r.notes,
            ])

        buffer = io.BytesIO(output.getvalue().encode("utf-8"))
        buffer.seek(0)

        return send_file(
            buffer,
            mimetype="text/csv",
            as_attachment=True,
            download_name="overlap_results.csv",
        )

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/project/save", methods=["POST"])
def save_project():
    """Download project as JSON."""
    try:
        data = request.json
        buffer = io.BytesIO(json.dumps(data, indent=2).encode("utf-8"))
        buffer.seek(0)
        return send_file(
            buffer,
            mimetype="application/json",
            as_attachment=True,
            download_name="project.json",
        )
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/project/load", methods=["POST"])
def load_project():
    """Upload and parse project JSON."""
    try:
        if "file" in request.files:
            file = request.files["file"]
            data = json.loads(file.read().decode("utf-8"))
        else:
            data = request.json
        return jsonify({"success": True, "data": data})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/templates/irc", methods=["POST"])
def get_irc_template():
    """Generate IRC load template."""
    try:
        data = request.json
        template_type = data.get("template", "IRC_CLASS_AA")
        offset = float(data.get("position_offset", 0.0))
        load_case = data.get("load_case", "LC1")

        if template_type == "IRC_CLASS_AA":
            loads = irc_class_aa_tracked(offset, load_case)
        elif template_type == "IRC_70R":
            loads = irc_70r_tracked(offset, load_case)
        elif template_type == "IRC_CLASS_A":
            loads = irc_class_a_wheel_line(offset, load_case)
        else:
            return jsonify({"success": False, "error": f"Unknown template: {template_type}"}), 400

        return jsonify({
            "success": True,
            "loads": [lo.model_dump() for lo in loads],
        })

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/templates/culvert", methods=["POST"])
def get_culvert_template():
    """Generate box culvert load template."""
    try:
        data = request.json
        template_type = data.get("template", "EARTH_PRESSURE")
        load_case = data.get("load_case", "LC1")

        if template_type == "EARTH_PRESSURE":
            load = earth_pressure_load(
                height=float(data.get("height", 3.0)),
                gamma_soil=float(data.get("gamma_soil", 18.0)),
                k0=float(data.get("k0", 0.5)),
                load_case=load_case,
            )
        elif template_type == "WATER_PRESSURE":
            load = water_pressure_load(
                water_height=float(data.get("water_height", 3.0)),
                load_case=load_case,
            )
        elif template_type == "SURCHARGE":
            load = surcharge_load(
                width=float(data.get("width", 3.0)),
                surcharge_intensity=float(data.get("surcharge_intensity", 10.0)),
                k0=float(data.get("k0", 0.5)),
                load_case=load_case,
            )
        elif template_type == "DEAD_LOAD_FILL":
            load = dead_load_fill(
                width=float(data.get("width", 8.5)),
                fill_depth=float(data.get("fill_depth", 1.0)),
                gamma_soil=float(data.get("gamma_soil", 18.0)),
                load_case=load_case,
            )
        elif template_type == "WEARING_COURSE":
            load = wearing_course_load(
                width=float(data.get("width", 8.5)),
                thickness=float(data.get("thickness", 0.075)),
                load_case=load_case,
            )
        else:
            return jsonify({"success": False, "error": f"Unknown template: {template_type}"}), 400

        return jsonify({
            "success": True,
            "loads": [load.model_dump()],
        })

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ─── Smart Feature API Routes ────────────────────────────────────────────────

from app.core.smart_features import (
    compute_impact_factor,
    generate_load_combinations,
    vehicle_position_sweep,
    compute_dispersion,
    estimate_quantities,
    check_bearing_pressure,
    check_uplift,
    compute_reinforcement,
    generate_multicell_members,
    compute_skew_correction,
    generate_staad_file,
    generate_bbs,
)


@app.route("/api/smart/impact-factor", methods=["POST"])
def smart_impact_factor():
    """Compute IRC impact factor."""
    try:
        data = request.json
        result = compute_impact_factor(
            vehicle_class=data.get("vehicle_class", "CLASS_A"),
            span=float(data.get("span", 6.0)),
            fill_depth=float(data.get("fill_depth", 0.0)),
            bridge_type=data.get("bridge_type", "RC"),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/load-combinations", methods=["POST"])
def smart_load_combinations():
    """Generate IRC 6:2017 load combinations."""
    try:
        data = request.json
        load_case_map = data.get("load_case_map", {})
        if not load_case_map:
            load_case_map = {"DL": 1, "SIDL": 2, "WC": 3, "LL": 4, "EP": 5, "WP": 6, "SC": 7}

        combinations = generate_load_combinations(
            load_case_map=load_case_map,
            structure_type=data.get("structure_type", "BOX_CULVERT"),
            include_sls=data.get("include_sls", True),
        )
        return jsonify({
            "success": True,
            "combinations": [c.__dict__ for c in combinations],
            "staad_text": "\n\n".join(c.staad_text for c in combinations),
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/vehicle-sweep", methods=["POST"])
def smart_vehicle_sweep():
    """Compute vehicle position sweep range."""
    try:
        data = request.json
        result = vehicle_position_sweep(
            members=[],
            vehicle_class=data.get("vehicle_class", "IRC_CLASS_AA"),
            bridge_width=float(data.get("bridge_width", 8.5)),
            kerb_clearance=float(data.get("kerb_clearance", 1.2)),
            step_size=float(data.get("step_size", 0.1)),
        )
        return jsonify({"success": True, "result": result})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/dispersion", methods=["POST"])
def smart_dispersion():
    """Compute load dispersion through fill."""
    try:
        data = request.json
        result = compute_dispersion(
            contact_width=float(data.get("contact_width", 0.85)),
            contact_length=float(data.get("contact_length", 3.6)),
            intensity=float(data.get("intensity", -97.22)),
            fill_depth=float(data.get("fill_depth", 1.0)),
            wearing_course_thickness=float(data.get("wearing_course", 0.075)),
            dispersion_angle=float(data.get("dispersion_angle", 45.0)),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/quantities", methods=["POST"])
def smart_quantities():
    """Estimate concrete quantities."""
    try:
        data = request.json
        result = estimate_quantities(
            clear_span=float(data.get("clear_span", 4.0)),
            clear_height=float(data.get("clear_height", 3.0)),
            top_slab_thickness=float(data.get("top_slab_thickness", 0.3)),
            bottom_slab_thickness=float(data.get("bottom_slab_thickness", 0.35)),
            wall_thickness=float(data.get("wall_thickness", 0.3)),
            culvert_length=float(data.get("culvert_length", 10.0)),
            num_cells=int(data.get("num_cells", 1)),
            haunch_size=float(data.get("haunch_size", 0.15)),
            steel_percent=float(data.get("steel_percent", 1.0)),
        )
        return jsonify({
            "success": True,
            "result": {
                "items": [i.__dict__ for i in result.items],
                "total_concrete_volume": result.total_concrete_volume,
                "total_formwork_area": result.total_formwork_area,
                "steel_estimate_kg": result.steel_estimate_kg,
                "concrete_weight_tonnes": result.concrete_weight_tonnes,
                "notes": result.notes,
            },
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/design-checks", methods=["POST"])
def smart_design_checks():
    """Run bearing pressure and uplift checks."""
    try:
        data = request.json
        results = {}

        # Bearing check
        if data.get("check_bearing", True):
            bearing = check_bearing_pressure(
                total_vertical_load=float(data.get("total_vertical_load", 500)),
                base_width=float(data.get("base_width", 5.0)),
                eccentricity=float(data.get("eccentricity", 0.0)),
                allowable_bearing=float(data.get("allowable_bearing", 150.0)),
                culvert_length=float(data.get("culvert_length", 1.0)),
            )
            results["bearing"] = bearing.__dict__

        # Uplift check
        if data.get("check_uplift", True):
            uplift = check_uplift(
                clear_span=float(data.get("clear_span", 4.0)),
                clear_height=float(data.get("clear_height", 3.0)),
                top_slab_thickness=float(data.get("top_slab_thickness", 0.3)),
                bottom_slab_thickness=float(data.get("bottom_slab_thickness", 0.35)),
                wall_thickness=float(data.get("wall_thickness", 0.3)),
                fill_depth=float(data.get("fill_depth", 1.0)),
                water_table_depth=float(data.get("water_table_depth", 0.5)),
                num_cells=int(data.get("num_cells", 1)),
                required_fos=float(data.get("required_fos", 1.1)),
            )
            results["uplift"] = {
                "stabilizing_force": uplift.stabilizing_force,
                "destabilizing_force": uplift.destabilizing_force,
                "factor_of_safety": uplift.factor_of_safety,
                "required_fos": uplift.required_fos,
                "status": uplift.status,
                "breakdown": uplift.breakdown,
            }

        return jsonify({"success": True, "results": results})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/reinforcement", methods=["POST"])
def smart_reinforcement():
    """Compute required reinforcement."""
    try:
        data = request.json
        elements = data.get("elements", [{"name": "Top Slab", "bm": 150, "thickness": 0.3}])
        results = []
        for elem in elements:
            r = compute_reinforcement(
                max_bm=float(elem.get("bm", 100)),
                slab_thickness=float(elem.get("thickness", 0.3)),
                clear_cover=float(elem.get("clear_cover", 40)),
                bar_diameter=int(elem.get("bar_dia", 16)),
                fck=float(data.get("fck", 30)),
                fy=float(data.get("fy", 500)),
            )
            r_dict = r.__dict__
            r_dict["element"] = elem.get("name", "Slab")
            results.append(r_dict)

        return jsonify({"success": True, "results": results})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/multicell", methods=["POST"])
def smart_multicell():
    """Generate multi-cell member layout."""
    try:
        data = request.json
        members = generate_multicell_members(
            num_cells=int(data.get("num_cells", 2)),
            clear_span=float(data.get("clear_span", 4.0)),
            clear_height=float(data.get("clear_height", 3.0)),
            wall_thickness=float(data.get("wall_thickness", 0.3)),
            slab_thickness=float(data.get("slab_thickness", 0.3)),
            start_id=int(data.get("start_id", 1001)),
        )
        return jsonify({"success": True, "members": members})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/skew", methods=["POST"])
def smart_skew():
    """Compute skew correction factors."""
    try:
        data = request.json
        result = compute_skew_correction(
            skew_angle=float(data.get("skew_angle", 0)),
            normal_span=float(data.get("normal_span", 4.0)),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/staad-file", methods=["POST"])
def smart_staad_file():
    """Generate complete STAAD .std file."""
    try:
        data = request.json
        staad_content = generate_staad_file(
            project_name=data.get("project_name", "Box Culvert"),
            clear_span=float(data.get("clear_span", 4.0)),
            clear_height=float(data.get("clear_height", 3.0)),
            top_slab_thickness=float(data.get("top_slab_thickness", 0.3)),
            bottom_slab_thickness=float(data.get("bottom_slab_thickness", 0.35)),
            wall_thickness=float(data.get("wall_thickness", 0.3)),
            num_cells=int(data.get("num_cells", 1)),
            fck=float(data.get("fck", 30)),
            member_loads_text=data.get("member_loads_text", ""),
            load_combinations_text=data.get("load_combinations_text", ""),
        )

        if data.get("download", False):
            buffer = io.BytesIO(staad_content.encode("utf-8"))
            buffer.seek(0)
            return send_file(
                buffer, mimetype="text/plain",
                as_attachment=True, download_name="box_culvert.std",
            )

        return jsonify({"success": True, "staad_content": staad_content})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/bbs", methods=["POST"])
def smart_bbs():
    """Generate Bar Bending Schedule."""
    try:
        data = request.json
        result = generate_bbs(
            clear_span=float(data.get("clear_span", 4.0)),
            clear_height=float(data.get("clear_height", 3.0)),
            top_slab_thickness=float(data.get("top_slab_thickness", 0.3)),
            bottom_slab_thickness=float(data.get("bottom_slab_thickness", 0.35)),
            wall_thickness=float(data.get("wall_thickness", 0.3)),
            culvert_length=float(data.get("culvert_length", 10.0)),
            num_cells=int(data.get("num_cells", 1)),
            main_bar_dia=int(data.get("main_bar_dia", 16)),
            dist_bar_dia=int(data.get("dist_bar_dia", 12)),
            main_spacing=int(data.get("main_spacing", 150)),
            dist_spacing=int(data.get("dist_spacing", 200)),
        )
        return jsonify({
            "success": True,
            "result": {
                "items": [i.__dict__ for i in result.items],
                "total_steel_weight": result.total_steel_weight,
                "wastage_percent": result.wastage_percent,
                "total_with_wastage": result.total_with_wastage,
            },
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

def _parse_settings(data: dict) -> ProjectSettings:
    return ProjectSettings(
        project_name=data.get("project_name", "Untitled Project"),
        bridge_name=data.get("bridge_name", ""),
        engineer=data.get("engineer", ""),
        project_date=data.get("project_date", date.today().isoformat()),
        comments=data.get("comments", ""),
        structure_type=StructureType(data.get("structure_type", "BRIDGE_DECK")),
        total_width=float(data.get("total_width", 8.5)),
        reference_axis=ReferenceAxis(data.get("reference_axis", "LEFT_EDGE")),
        custom_datum=float(data.get("custom_datum", 0.0)),
        culvert_height=float(data.get("culvert_height", 0.0)),
        fill_depth=float(data.get("fill_depth", 0.0)),
        slab_thickness=float(data.get("slab_thickness", 0.3)),
        wall_thickness=float(data.get("wall_thickness", 0.3)),
        decimal_precision=int(data.get("decimal_precision", 2)),
        units=CoordinateUnit(data.get("units", "m")),
        overhang_policy=OverhangPolicy(data.get("overhang_policy", "ALLOW")),
        include_zero_overlaps=bool(data.get("include_zero_overlaps", False)),
        start_member_number=int(data.get("start_member_number", 1001)),
        member_increment=int(data.get("member_increment", 1)),
    )


def _parse_members(data: list, settings: ProjectSettings) -> list[MemberSegment]:
    """Parse members from request data, supporting auto and manual modes."""
    if not data:
        # Auto-generate from settings
        return generate_equal_segments(
            total_width=settings.total_width,
            num_segments=12,
            start_number=settings.start_member_number,
            increment=settings.member_increment,
        )

    members = []
    for row in data:
        members.append(MemberSegment(
            id=int(row["id"]),
            start=float(row["start"]),
            end=float(row["end"]),
            label=row.get("label", ""),
            group=MemberGroup(row.get("group", "GENERAL")),
        ))
    return members


def _parse_loads(data: list) -> list[LoadPatch]:
    """Parse loads from request data."""
    loads = []
    for row in data:
        loads.append(LoadPatch(
            id=str(row.get("id", f"L{len(loads)+1}")),
            load_case=row.get("load_case", "LC1"),
            load_type=LoadType(row.get("load_type", "PARTIAL_UDL")),
            start=float(row["start"]),
            end=float(row["end"]),
            intensity=float(row["intensity"]),
            intensity_end=float(row["intensity_end"]) if row.get("intensity_end") else None,
            direction=LoadDirection(row.get("direction", "GY")),
            notes=row.get("notes", ""),
            dispersion_enabled=bool(row.get("dispersion_enabled", False)),
            fill_depth_override=float(row["fill_depth_override"]) if row.get("fill_depth_override") else None,
            contact_width=float(row["contact_width"]) if row.get("contact_width") else None,
        ))
    return loads


if __name__ == "__main__":
    app.run(debug=True, port=5000)
