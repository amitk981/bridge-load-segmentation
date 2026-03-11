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
from pydantic import ValidationError

from app.models.schemas import (
    ProjectSettings, MemberSegment, LoadPatch, OverlapResult,
    LoadType, LoadDirection, MemberGroup, StructureType,
    ReferenceAxis, OverhangPolicy, CoordinateUnit, STAADFormat,
)
from app.core.geometry import (
    generate_equal_segments, create_manual_segments,
    generate_box_culvert_members, generate_standard_box_culvert_members,
    generate_members_from_breakpoints, normalize_positions,
)
from app.core.loads import (
    create_load, apply_dispersion, parse_loads_csv,
    irc_class_aa_tracked, irc_70r_tracked, irc_70r_wheeled,
    irc_class_a_wheel_line, irc_single_axle_bogie, irc_double_axle_bogie,
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
        data = request.json or {}
        try:
            settings, members, loads = _parse_request_payload(data)
        except ValueError as e:
            return jsonify({
                "success": False,
                "error": "Input parsing failed",
                "details": [str(e)],
            }), 400

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
        data = request.json or {}
        try:
            settings, members, loads = _parse_request_payload(data)
        except ValueError as e:
            return jsonify({
                "success": False,
                "error": "Input parsing failed",
                "details": [str(e)],
            }), 400

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
        data = request.json or {}
        try:
            settings, members, loads = _parse_request_payload(data)
        except ValueError as e:
            return jsonify({
                "success": False,
                "error": "Input parsing failed",
                "details": [str(e)],
            }), 400

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
        data = request.json or {}
        try:
            settings, members, loads = _parse_request_payload(data)
        except ValueError as e:
            return jsonify({
                "success": False,
                "error": "Input parsing failed",
                "details": [str(e)],
            }), 400

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
    """Generate IRC load templates with full vehicle metadata in notes."""
    try:
        data = request.json
        template_type = data.get("template", "IRC_CLASS_AA")
        offset = float(data.get("position_offset", 0.0))
        load_case = data.get("load_case", "LC1")

        if template_type == "IRC_CLASS_AA":
            loads = irc_class_aa_tracked(offset, load_case)
        elif template_type in ("IRC_70R", "IRC_70R_TRACKED"):
            loads = irc_70r_tracked(offset, load_case)
        elif template_type == "IRC_70R_WHEELED":
            loads = irc_70r_wheeled(offset, load_case)
        elif template_type == "IRC_CLASS_A":
            loads = irc_class_a_wheel_line(offset, load_case)
        elif template_type == "SINGLE_AXLE_BOGIE":
            loads = irc_single_axle_bogie(offset, load_case)
        elif template_type == "DOUBLE_AXLE_BOGIE":
            loads = irc_double_axle_bogie(offset, load_case)
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
    # Phase 1: Critical Safety
    check_crack_width,
    check_shear,
    compute_braking_force,
    # Phase 2: Professional Completeness
    compute_temp_shrinkage,
    compute_effective_width,
    check_deflection,
    compute_soil_springs,
    suggest_clear_cover,
    # Phase 3: Premium
    compute_settlement,
    # Longitudinal moving-load sweep
    compute_longitudinal_critical_positions,
    parse_staad_moving_load,
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


@app.route("/api/smart/longitudinal-critical", methods=["POST"])
def smart_longitudinal_critical():
    """Run longitudinal sweep using current Loads + Members + Settings tabs."""
    try:
        data = request.json or {}
        try:
            settings, members, loads = _parse_request_payload(data)
            increment = _as_required_float(data.get("increment", 0.1), "Results tab: Increment")
        except ValueError as e:
            return jsonify({
                "success": False,
                "error": "Input parsing failed",
                "details": [str(e)],
            }), 400

        moving_load_text = str(data.get("moving_load_text", "") or "").strip()
        moving_load_info = None
        custom_vehicles = None
        vehicles, matched_load_ids = _infer_sweep_vehicles_from_loads(loads)

        if moving_load_text:
            parsed = parse_staad_moving_load(moving_load_text)
            moving_load_info = {
                "used": True,
                "type_ids": parsed.get("used_type_ids", []),
                "warnings": parsed.get("warnings", []),
                "errors": parsed.get("errors", []),
            }
            if parsed.get("errors"):
                return jsonify({
                    "success": False,
                    "error": "STAAD moving load parsing failed",
                    "details": parsed["errors"],
                }), 400
            custom_vehicles = parsed.get("vehicle_defs", [])
            vehicles = [v.get("vehicle_code", v.get("name", "CUSTOM")) for v in custom_vehicles]

        input_errors = _validate_sweep_inputs(settings, members, loads, vehicles, increment)
        if input_errors:
            return jsonify({
                "success": False,
                "error": "Sweep input validation failed",
                "details": input_errors,
            }), 400

        geometry = _infer_sweep_geometry(settings, members)

        result = compute_longitudinal_critical_positions(
            clear_span=geometry["clear_span"],
            clear_height=geometry["clear_height"],
            top_slab_thickness=geometry["top_slab_thickness"],
            bottom_slab_thickness=geometry["bottom_slab_thickness"],
            wall_thickness=geometry["wall_thickness"],
            mid_wall_thickness=geometry["mid_wall_thickness"],
            num_cells=geometry["num_cells"],
            increment=increment,
            fck=float(data.get("fck", 30.0)),
            vehicles=vehicles,
            custom_vehicles=custom_vehicles,
        )

        result["inference"] = {
            "vehicles_from_loads": vehicles if not moving_load_text else [],
            "matched_load_ids": matched_load_ids if not moving_load_text else [],
            "geometry_source": "members + project settings",
            "geometry": geometry,
            "moving_load": moving_load_info or {"used": False},
        }
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
            mid_wall_thickness=float(data.get("mid_wall_thickness", data.get("wall_thickness", 0.3))),
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


# ─── Phase 1: Critical Safety API Routes ─────────────────────────────────────

@app.route("/api/smart/crack-width", methods=["POST"])
def smart_crack_width():
    """Check crack width per IRC 112."""
    try:
        data = request.json
        result = check_crack_width(
            bm_sls=float(data.get("bm_sls", 50)),
            slab_thickness=float(data.get("slab_thickness", 0.5)),
            clear_cover=float(data.get("clear_cover", 50)),
            bar_diameter=int(data.get("bar_diameter", 16)),
            bar_spacing=int(data.get("bar_spacing", 150)),
            fck=float(data.get("fck", 30)),
            fy=float(data.get("fy", 500)),
            exposure=data.get("exposure", "MODERATE"),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/shear-check", methods=["POST"])
def smart_shear_check():
    """Shear design check per IS 456."""
    try:
        data = request.json
        result = check_shear(
            shear_force=float(data.get("shear_force", 100)),
            slab_thickness=float(data.get("slab_thickness", 0.5)),
            clear_cover=float(data.get("clear_cover", 50)),
            bar_diameter=int(data.get("bar_diameter", 16)),
            fck=float(data.get("fck", 30)),
            fy=float(data.get("fy", 500)),
            ast_provided=float(data.get("ast_provided", 0)),
            stirrup_dia=int(data.get("stirrup_dia", 8)),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/braking-force", methods=["POST"])
def smart_braking_force():
    """Compute braking force per IRC 6."""
    try:
        data = request.json
        result = compute_braking_force(
            vehicle_class=data.get("vehicle_class", "CLASS_A"),
            num_lanes=int(data.get("num_lanes", 2)),
            bridge_width=float(data.get("bridge_width", 8.5)),
            span=float(data.get("span", 4.0)),
            fill_depth=float(data.get("fill_depth", 0)),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ─── Phase 2: Professional Completeness API Routes ───────────────────────────

@app.route("/api/smart/temp-shrinkage", methods=["POST"])
def smart_temp_shrinkage():
    """Compute temperature and shrinkage loads."""
    try:
        data = request.json
        result = compute_temp_shrinkage(
            slab_thickness=float(data.get("slab_thickness", 0.5)),
            wall_thickness=float(data.get("wall_thickness", 0.4)),
            fck=float(data.get("fck", 30)),
            uniform_temp_rise_deg=float(data.get("temp_rise", 15)),
            uniform_temp_fall_deg=float(data.get("temp_fall", 10)),
            differential_temp_deg=float(data.get("temp_diff", 17.8)),
            shrinkage_strain=float(data.get("shrinkage_strain", 0.0003)),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/effective-width", methods=["POST"])
def smart_effective_width():
    """Compute effective slab width per IRC 112."""
    try:
        data = request.json
        result = compute_effective_width(
            contact_width=float(data.get("contact_width", 0.5)),
            span=float(data.get("span", 4.0)),
            load_position=float(data.get("load_position", 2.0)),
            slab_width=float(data.get("slab_width", 8.5)),
            fill_depth=float(data.get("fill_depth", 0)),
            wearing_course=float(data.get("wearing_course", 0.075)),
            slab_type=data.get("slab_type", "ONE_WAY"),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/deflection", methods=["POST"])
def smart_deflection():
    """Check deflection per IS 456 L/d method."""
    try:
        data = request.json
        result = check_deflection(
            span=float(data.get("span", 4.0)),
            slab_thickness=float(data.get("slab_thickness", 0.5)),
            clear_cover=float(data.get("clear_cover", 50)),
            bar_diameter=int(data.get("bar_diameter", 16)),
            ast_provided=float(data.get("ast_provided", 0)),
            fck=float(data.get("fck", 30)),
            fy=float(data.get("fy", 500)),
            support_condition=data.get("support_condition", "CONTINUOUS"),
            comp_steel=float(data.get("comp_steel", 0)),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/soil-springs", methods=["POST"])
def smart_soil_springs():
    """Compute Winkler soil spring stiffnesses."""
    try:
        data = request.json
        result = compute_soil_springs(
            base_width=float(data.get("base_width", 5.0)),
            culvert_length=float(data.get("culvert_length", 1.0)),
            soil_type=data.get("soil_type", "MEDIUM_CLAY"),
            custom_ks=float(data.get("custom_ks", 0)),
            num_nodes=int(data.get("num_nodes", 10)),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/clear-cover", methods=["POST"])
def smart_clear_cover():
    """Suggest clear cover per IS 456 Table 16."""
    try:
        data = request.json
        result = suggest_clear_cover(
            exposure=data.get("exposure", "MODERATE"),
            element=data.get("element", "SLAB"),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ─── Phase 3: Premium API Routes ─────────────────────────────────────────────

@app.route("/api/smart/settlement", methods=["POST"])
def smart_settlement():
    """Compute foundation settlement."""
    try:
        data = request.json
        result = compute_settlement(
            base_pressure=float(data.get("base_pressure", 100)),
            base_width=float(data.get("base_width", 5.0)),
            soil_type=data.get("soil_type", "MEDIUM_CLAY"),
            Es_soil=float(data.get("Es_soil", 0)),
            Cc=float(data.get("Cc", 0)),
            e0=float(data.get("e0", 0)),
            clay_thickness=float(data.get("clay_thickness", 0)),
            sigma_0=float(data.get("sigma_0", 0)),
        )
        return jsonify({"success": True, "result": result.__dict__})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/smart/auto-design", methods=["POST"])
def smart_auto_design():
    """
    Complete end-to-end auto-design.

    Accepts 18 geometry/material/soil/hydraulic inputs;
    returns a full design package (loads, checks, diagrams data, BBS, quantities).
    """
    try:
        from app.core.smart_features import run_complete_design

        data = request.json or {}
        result = run_complete_design(
            num_cells=int(data.get("num_cells", 1)),
            clear_span=float(data.get("clear_span", 4.0)),
            clear_height=float(data.get("clear_height", 3.0)),
            top_slab_thickness=float(data.get("top_slab_thickness", 0.30)),
            bottom_slab_thickness=float(data.get("bottom_slab_thickness", 0.35)),
            wall_thickness=float(data.get("wall_thickness", 0.30)),
            mid_wall_thickness=float(data.get("mid_wall_thickness", 0.30)),
            haunch_size=float(data.get("haunch_size", 0.15)),
            fck=float(data.get("fck", 30.0)),
            fy=float(data.get("fy", 500.0)),
            clear_cover=float(data.get("clear_cover", 50.0)),
            fill_depth=float(data.get("fill_depth", 0.6)),
            wearing_course_thickness=float(data.get("wearing_course_thickness", 0.075)),
            gamma_soil=float(data.get("gamma_soil", 18.0)),
            friction_angle=float(data.get("friction_angle", 30.0)),
            allowable_bearing=float(data.get("allowable_bearing", 150.0)),
            water_table_depth=float(data.get("water_table_depth", 0.0)),
            culvert_length=float(data.get("culvert_length", 10.0)),
        )
        return jsonify({"success": True, "result": result})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


def _parse_request_payload(data: dict) -> tuple[ProjectSettings, list[MemberSegment], list[LoadPatch]]:
    """Parse settings, members, and loads with consistent 400-friendly errors."""
    try:
        settings = _parse_settings(data.get("settings", {}))
        members = _parse_members(data.get("members", []), settings)
        loads = _parse_loads(data.get("loads", []))
        return settings, members, loads
    except (ValidationError, ValueError, TypeError, KeyError) as exc:
        raise ValueError(str(exc)) from exc


def _is_missing(value) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def _as_required_float(value, field_name: str) -> float:
    if _is_missing(value):
        raise ValueError(f"{field_name} is required.")
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a valid number.") from exc


def _as_optional_float(value, field_name: str) -> float | None:
    if _is_missing(value):
        return None
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a valid number.") from exc


def _as_required_int(value, field_name: str) -> int:
    if _is_missing(value):
        raise ValueError(f"{field_name} is required.")
    try:
        n = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a valid integer.") from exc
    if not n.is_integer():
        raise ValueError(f"{field_name} must be a whole number.")
    return int(n)


def _as_bool(value, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return bool(value)


def _parse_float_list(value, field_name: str) -> list[float]:
    if _is_missing(value):
        return []
    if isinstance(value, list):
        out = []
        for v in value:
            if _is_missing(v):
                continue
            try:
                out.append(float(v))
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{field_name} must contain valid numbers.") from exc
        return out

    text = str(value)
    parts = [p for p in text.replace(";", ",").replace("|", ",").split(",") if p.strip()]
    out = []
    for p in parts:
        try:
            out.append(float(p.strip()))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field_name} must contain valid numbers.") from exc
    return out


def _parse_range_list(value, field_name: str) -> list[tuple[float, float]]:
    if _is_missing(value):
        return []
    if isinstance(value, list):
        out = []
        for item in value:
            if isinstance(item, (list, tuple)) and len(item) == 2:
                out.append((float(item[0]), float(item[1])))
            else:
                raise ValueError(f"{field_name} must be a list of [start, end] pairs.")
        return out

    text = str(value)
    parts = [p for p in text.replace(";", ",").split(",") if p.strip()]
    out = []
    for p in parts:
        if "-" not in p:
            raise ValueError(f"{field_name} must contain ranges like 0-0.45.")
        a, b = p.split("-", 1)
        out.append((float(a.strip()), float(b.strip())))
    return out


def _parse_settings(data: dict) -> ProjectSettings:
    if not isinstance(data, dict):
        raise ValueError("Project Settings payload must be an object.")

    structure_raw = str(data.get("structure_type", "BRIDGE_DECK")).strip().upper()
    axis_raw = str(data.get("reference_axis", "LEFT_EDGE")).strip().upper()
    units_raw = str(data.get("units", "m")).strip().lower()
    overhang_raw = str(data.get("overhang_policy", "ALLOW")).strip().upper()

    try:
        structure_type = StructureType(structure_raw)
    except ValueError as exc:
        raise ValueError(f'Project Settings: structure_type "{structure_raw}" is invalid.') from exc
    try:
        reference_axis = ReferenceAxis(axis_raw)
    except ValueError as exc:
        raise ValueError(f'Project Settings: reference_axis "{axis_raw}" is invalid.') from exc
    try:
        units = CoordinateUnit(units_raw)
    except ValueError as exc:
        raise ValueError(f'Project Settings: units "{units_raw}" is invalid.') from exc
    try:
        overhang_policy = OverhangPolicy(overhang_raw)
    except ValueError as exc:
        raise ValueError(f'Project Settings: overhang_policy "{overhang_raw}" is invalid.') from exc

    # Box culvert-specific fields (optional, derive if missing)
    wall_thickness = float(data.get("wall_thickness", 0.3))
    mid_wall_thickness = _as_optional_float(data.get("mid_wall_thickness"), "Project Settings: Mid Wall Thickness")
    if mid_wall_thickness is None:
        mid_wall_thickness = wall_thickness

    clear_span = _as_optional_float(data.get("clear_span"), "Project Settings: Clear Span") or 0.0
    haunch_size = _as_optional_float(data.get("haunch_size"), "Project Settings: Haunch Size") or 0.0

    num_cells_raw = data.get("num_cells")
    if _is_missing(num_cells_raw):
        num_cells = {
            StructureType.BOX_CULVERT_1CELL: 1,
            StructureType.BOX_CULVERT_2CELL: 2,
            StructureType.BOX_CULVERT_3CELL: 3,
            StructureType.BOX_CULVERT_4CELL: 4,
        }.get(structure_type, 1)
    else:
        num_cells = _as_required_int(num_cells_raw, "Project Settings: Number of Cells")

    total_width = float(data.get("total_width", 8.5))
    custom_breakpoints = _parse_float_list(data.get("custom_breakpoints"), "Project Settings: Custom Breakpoints")
    custom_wall_ranges = _parse_range_list(data.get("custom_wall_ranges"), "Project Settings: Custom Wall Ranges")

    if custom_breakpoints:
        custom_breakpoints = sorted(set(custom_breakpoints))
        if len(custom_breakpoints) >= 2:
            total_width = custom_breakpoints[-1] - custom_breakpoints[0]
    if structure_type in {
        StructureType.BOX_CULVERT_1CELL,
        StructureType.BOX_CULVERT_2CELL,
        StructureType.BOX_CULVERT_3CELL,
        StructureType.BOX_CULVERT_4CELL,
    }:
        if clear_span <= 0 and total_width > 0:
            denom = max(num_cells, 1)
            clear_span = (total_width - (2 * wall_thickness + max(0, num_cells - 1) * mid_wall_thickness)) / denom
        if clear_span <= 0:
            clear_span = 4.0
        computed_total = num_cells * clear_span + 2 * wall_thickness + max(0, num_cells - 1) * mid_wall_thickness
        if computed_total > 0 and not custom_breakpoints:
            total_width = computed_total

    return ProjectSettings(
        project_name=str(data.get("project_name", "Untitled Project")),
        bridge_name=str(data.get("bridge_name", "")),
        engineer=str(data.get("engineer", "")),
        project_date=str(data.get("project_date", date.today().isoformat())),
        comments=str(data.get("comments", "")),
        structure_type=structure_type,
        total_width=total_width,
        reference_axis=reference_axis,
        custom_datum=float(data.get("custom_datum", 0.0)),
        culvert_height=float(data.get("culvert_height", 0.0)),
        fill_depth=float(data.get("fill_depth", 0.0)),
        slab_thickness=float(data.get("slab_thickness", 0.3)),
        bottom_slab_thickness=float(data.get("bottom_slab_thickness", 0.35)),
        wall_thickness=wall_thickness,
        clear_span=clear_span,
        num_cells=num_cells,
        mid_wall_thickness=mid_wall_thickness,
        haunch_size=haunch_size,
        custom_breakpoints=custom_breakpoints,
        custom_wall_ranges=custom_wall_ranges,
        decimal_precision=int(data.get("decimal_precision", 2)),
        units=units,
        overhang_policy=overhang_policy,
        include_zero_overlaps=_as_bool(data.get("include_zero_overlaps", False), default=False),
        start_member_number=int(data.get("start_member_number", 1001)),
        member_increment=int(data.get("member_increment", 1)),
    )


def _parse_members(data: list, settings: ProjectSettings) -> list[MemberSegment]:
    """Parse members from request data, supporting auto and manual modes."""
    if not data:
        if settings.custom_breakpoints:
            return generate_members_from_breakpoints(
                breakpoints=settings.custom_breakpoints,
                wall_ranges=settings.custom_wall_ranges,
                start_number=settings.start_member_number,
                increment=settings.member_increment,
            )
        if settings.structure_type in {
            StructureType.BOX_CULVERT_1CELL,
            StructureType.BOX_CULVERT_2CELL,
            StructureType.BOX_CULVERT_3CELL,
            StructureType.BOX_CULVERT_4CELL,
        }:
            return generate_standard_box_culvert_members(
                clear_span=settings.clear_span,
                num_cells=settings.num_cells,
                wall_thickness=settings.wall_thickness,
                mid_wall_thickness=settings.mid_wall_thickness,
                haunch_size=settings.haunch_size,
                start_number=settings.start_member_number,
                increment=settings.member_increment,
            )

        return generate_equal_segments(
            total_width=settings.total_width,
            num_segments=12,
            start_number=settings.start_member_number,
            increment=settings.member_increment,
        )
    if not isinstance(data, list):
        raise ValueError("Members tab: rows must be an array.")

    members: list[MemberSegment] = []
    allowed_groups = ", ".join(g.value for g in MemberGroup)

    for idx, row in enumerate(data, start=1):
        if not isinstance(row, dict):
            raise ValueError(f"Members row {idx}: row must be an object.")

        prefix = f"Members row {idx}"
        member_id = _as_required_int(row.get("id"), f"{prefix} > Member ID")
        start = _as_required_float(row.get("start"), f"{prefix} > Start")
        end = _as_required_float(row.get("end"), f"{prefix} > End")
        group_raw = str(row.get("group", "GENERAL")).strip().upper()
        label = str(row.get("label", ""))

        try:
            group = MemberGroup(group_raw)
        except ValueError as exc:
            raise ValueError(
                f'{prefix} > Group "{group_raw}" is invalid. Allowed: {allowed_groups}.'
            ) from exc

        try:
            members.append(MemberSegment(
                id=member_id,
                start=start,
                end=end,
                label=label,
                group=group,
            ))
        except (ValidationError, ValueError) as exc:
            raise ValueError(f"{prefix}: {exc}") from exc

    return members


def _parse_loads(data: list) -> list[LoadPatch]:
    """Parse loads from request data."""
    if not isinstance(data, list):
        raise ValueError("Loads tab: rows must be an array.")

    loads: list[LoadPatch] = []
    allowed_types = ", ".join(t.value for t in LoadType)
    allowed_dirs = ", ".join(d.value for d in LoadDirection)

    for idx, row in enumerate(data, start=1):
        if not isinstance(row, dict):
            raise ValueError(f"Loads row {idx}: row must be an object.")

        prefix = f"Loads row {idx}"
        load_id = str(row.get("id", "")).strip() or f"L{idx}"
        load_case = str(row.get("load_case", "")).strip() or "LC1"
        load_type_raw = str(row.get("load_type", "PARTIAL_UDL")).strip().upper()
        direction_raw = str(row.get("direction", "GY")).strip().upper()

        try:
            load_type = LoadType(load_type_raw)
        except ValueError as exc:
            raise ValueError(
                f'{prefix} > Type "{load_type_raw}" is invalid. Allowed: {allowed_types}.'
            ) from exc
        try:
            direction = LoadDirection(direction_raw)
        except ValueError as exc:
            raise ValueError(
                f'{prefix} > Direction "{direction_raw}" is invalid. Allowed: {allowed_dirs}.'
            ) from exc

        start = _as_required_float(row.get("start"), f"{prefix} > Start")
        end = _as_required_float(row.get("end"), f"{prefix} > End")
        intensity = _as_required_float(row.get("intensity"), f"{prefix} > Intensity")
        intensity_end = _as_optional_float(row.get("intensity_end"), f"{prefix} > Intensity End")

        try:
            loads.append(LoadPatch(
                id=load_id,
                load_case=load_case,
                load_type=load_type,
                start=start,
                end=end,
                intensity=intensity,
                intensity_end=intensity_end,
                direction=direction,
                notes=str(row.get("notes", "")),
                dispersion_enabled=_as_bool(row.get("dispersion_enabled", False), default=False),
                fill_depth_override=_as_optional_float(
                    row.get("fill_depth_override"), f"{prefix} > Fill Depth Override"
                ),
                contact_width=_as_optional_float(row.get("contact_width"), f"{prefix} > Contact Width"),
            ))
        except (ValidationError, ValueError) as exc:
            raise ValueError(f"{prefix}: {exc}") from exc

    return loads


def _validate_sweep_inputs(
    settings: ProjectSettings,
    members: list[MemberSegment],
    loads: list[LoadPatch],
    vehicles: list[str],
    increment: float,
) -> list[str]:
    """Validate required fields/tags for longitudinal sweep auto-calculation."""
    errors: list[str] = []

    if settings.structure_type not in {
        StructureType.BOX_CULVERT_1CELL,
        StructureType.BOX_CULVERT_2CELL,
        StructureType.BOX_CULVERT_3CELL,
        StructureType.BOX_CULVERT_4CELL,
    }:
        errors.append("Project Settings: Structure Type must be BOX_CULVERT_1/2/3/4CELL.")
    if settings.total_width <= 0:
        errors.append("Project Settings: Total Width must be > 0.")
    if settings.culvert_height <= 0:
        errors.append("Project Settings: Culvert Height must be > 0.")
    if settings.slab_thickness <= 0:
        errors.append("Project Settings: Top Slab Thickness must be > 0.")
    if settings.bottom_slab_thickness <= 0:
        errors.append("Project Settings: Bottom Slab Thickness must be > 0.")
    if settings.wall_thickness <= 0:
        errors.append("Project Settings: Wall Thickness must be > 0.")
    if increment <= 0:
        errors.append("Results tab: Increment must be > 0.")

    if not members:
        errors.append("Members tab: at least one member row is required.")
    else:
        groups = {m.group.value for m in members}
        for g in (
            MemberGroup.TOP_SLAB.value,
            MemberGroup.BOTTOM_SLAB.value,
            MemberGroup.LEFT_WALL.value,
            MemberGroup.RIGHT_WALL.value,
        ):
            if g not in groups:
                errors.append(f'Members tab: group "{g}" is required.')

        req_cells = {
            StructureType.BOX_CULVERT_1CELL: 1,
            StructureType.BOX_CULVERT_2CELL: 2,
            StructureType.BOX_CULVERT_3CELL: 3,
            StructureType.BOX_CULVERT_4CELL: 4,
        }.get(settings.structure_type, 1)
        if req_cells >= 2:
            middle_count = len([g for g in groups if g.startswith("MIDDLE_WALL_")])
            if middle_count < req_cells - 1:
                errors.append(
                    f"Members tab: for {req_cells} cells, at least {req_cells - 1} MIDDLE_WALL_* groups are required."
                )

    if not loads:
        errors.append("Loads tab: at least one vehicle load row is required.")
    if not vehicles:
        errors.append(
            "No recognizable sweep vehicle found. Use IRC_70R / IRC_CLASS_A / IRC_CLASS_AA load types, "
            "SINGLE_AXLE_BOGIE / DOUBLE_AXLE_BOGIE load types, or bogie keywords in ID/notes "
            "(single bogie, double bogie, max single axle, max bogie), or paste a STAAD moving load block."
        )

    return errors


def _infer_sweep_vehicles_from_loads(loads: list[LoadPatch]) -> tuple[list[str], list[str]]:
    """
    Infer longitudinal sweep vehicles from Loads tab entries.

    Mapping rules:
    - load_type IRC_70R + text contains 'wheeled'/'wheel' -> CLASS_70R_WHEELED
    - load_type IRC_70R otherwise -> CLASS_70R_TRACKED
    - load_type IRC_CLASS_A -> CLASS_A
    - load_type SINGLE_AXLE_BOGIE -> SINGLE_AXLE_BOGIE
    - load_type DOUBLE_AXLE_BOGIE -> DOUBLE_AXLE_BOGIE
    - text contains 'single' + 'bogie' -> SINGLE_AXLE_BOGIE
    - text contains 'double' + 'bogie' or 'max bogie' -> DOUBLE_AXLE_BOGIE
    """
    vehicles: list[str] = []
    matched_load_ids: list[str] = []

    def add_vehicle(code: str, load_id: str):
        if code not in vehicles:
            vehicles.append(code)
        if load_id not in matched_load_ids:
            matched_load_ids.append(load_id)

    for lo in loads:
        text = f"{lo.id} {lo.notes}".upper()
        code = None

        if lo.load_type == LoadType.IRC_70R:
            if "WHEELED" in text or "WHEEL" in text:
                code = "CLASS_70R_WHEELED"
            else:
                code = "CLASS_70R_TRACKED"
        elif lo.load_type == LoadType.IRC_CLASS_AA:
            # Class AA tracked footprint is treated as tracked heavy vehicle in sweep model.
            code = "CLASS_70R_TRACKED"
        elif lo.load_type == LoadType.IRC_CLASS_A:
            code = "CLASS_A"
        elif lo.load_type == LoadType.SINGLE_AXLE_BOGIE:
            code = "SINGLE_AXLE_BOGIE"
        elif lo.load_type == LoadType.DOUBLE_AXLE_BOGIE:
            code = "DOUBLE_AXLE_BOGIE"
        else:
            # Bogie tags are usually added as custom load IDs/notes
            if ("SINGLE" in text and "BOGIE" in text) or "MAX SINGLE AXLE" in text:
                code = "SINGLE_AXLE_BOGIE"
            elif ("DOUBLE" in text and "BOGIE" in text) or "MAX BOGIE" in text:
                code = "DOUBLE_AXLE_BOGIE"

        if code:
            add_vehicle(code, lo.id)

    return vehicles, matched_load_ids


def _infer_sweep_geometry(
    settings: ProjectSettings,
    members: list[MemberSegment],
) -> dict:
    """
    Infer longitudinal frame geometry from Members tab + project settings.

    Because Members tab is transverse, we use:
    - total width from members envelope or settings.total_width
    - number of cells from middle-wall groups (fallback: structure type)
    - clear height from wall-member envelope (fallback: settings.culvert_height)
    - slab/wall thickness from settings
    """
    total_width = settings.total_width
    if members:
        min_x = min(m.start for m in members)
        max_x = max(m.end for m in members)
        if max_x > min_x:
            total_width = max_x - min_x

    # Cell count from member groups first
    middle_groups = set()
    for m in members:
        g = m.group.value if hasattr(m.group, "value") else str(m.group)
        if g.startswith("MIDDLE_WALL_"):
            middle_groups.add(g)

    if middle_groups:
        num_cells = len(middle_groups) + 1
    else:
        num_cells = settings.num_cells if settings.num_cells > 0 else {
            StructureType.BOX_CULVERT_1CELL: 1,
            StructureType.BOX_CULVERT_2CELL: 2,
            StructureType.BOX_CULVERT_3CELL: 3,
            StructureType.BOX_CULVERT_4CELL: 4,
        }.get(settings.structure_type, 1)

    clear_height = settings.culvert_height if settings.culvert_height > 0 else 3.0
    # Members table stores transverse widths, not vertical coordinates,
    # so do not override height using wall member start/end values.

    wall_t = settings.wall_thickness if settings.wall_thickness > 0 else 0.30
    mid_wall_t = settings.mid_wall_thickness if settings.mid_wall_thickness > 0 else wall_t
    top_t = settings.slab_thickness if settings.slab_thickness > 0 else 0.30
    bottom_t = settings.bottom_slab_thickness if settings.bottom_slab_thickness > 0 else 0.35

    if settings.clear_span > 0:
        clear_span = settings.clear_span
    else:
        denom = max(num_cells, 1)
        clear_span = (total_width - (2 * wall_t + max(0, num_cells - 1) * mid_wall_t)) / denom
        if clear_span <= 0:
            clear_span = total_width / denom if total_width > 0 else 4.0

    return {
        "clear_span": round(clear_span, 4),
        "clear_height": round(clear_height, 4),
        "top_slab_thickness": round(top_t, 4),
        "bottom_slab_thickness": round(bottom_t, 4),
        "wall_thickness": round(wall_t, 4),
        "mid_wall_thickness": round(mid_wall_t, 4),
        "num_cells": int(max(1, num_cells)),
        "total_width": round(total_width, 4),
    }


if __name__ == "__main__":
    app.run(debug=True, port=5000)
