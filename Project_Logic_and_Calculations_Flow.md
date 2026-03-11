# STAAD Logic and Calculations Flow

This document describes how the application converts user inputs into geometry, loads, overlap calculations, longitudinal moving-load sweeps, and diagrams. It is written to be a single reference for how the UI, backend, and plotting logic work end to end.

Scope:
- Box culvert and bridge deck strip segmentation
- Load definition, dispersion, and overlap calculation (STAAD member load export)
- Longitudinal moving-load sweep and bending moment envelope plotting
- Key assumptions and validation guidance


## 1. System Data Flow (End to End)

1. User fills Project Settings, Members, Loads in the UI.
2. Frontend validates inputs and sends JSON to backend.
3. Backend parses and validates data into typed objects.
4. Overlap engine computes d1/d2 for each load-member intersection.
5. Backend returns overlap results, summary, and STAAD export text.
6. Frontend renders:
   - Geometry and overlap diagram
   - Results frame visualization
   - Longitudinal moving-load sweep diagram (BMD envelope)
7. Optional exports: STAAD, CSV, Excel.

Key entry points:
- UI controller: app/static/js/app.js
- Input validation: app/core/validation.py, app/main.py
- Overlap engine: app/core/overlap.py
- STAAD export: app/core/staad_export.py
- Longitudinal sweep: app/core/smart_features.py
- Visualizations: app/static/js/visualization.js, app/static/js/results_frame_viz.js, app/static/js/app.js (sweep)


## 2. Input Data Model

### 2.1 Project Settings (ProjectSettings)
Source: UI Settings tab and request payload, parsed in app/main.py.

Key fields:
- project_name, bridge_name, engineer, project_date, comments
- structure_type: BRIDGE_DECK, BOX_CULVERT_1CELL..4CELL
- total_width: overall transverse width (m)
- culvert_height: clear height of box (m)
- slab_thickness, bottom_slab_thickness, wall_thickness
- num_cells, clear_span (used in geometry inference)
- reference_axis: LEFT_EDGE, RIGHT_EDGE, CENTERLINE, CUSTOM
- custom_datum: numeric value if CUSTOM reference axis
- decimal_precision, units, overhang_policy

### 2.2 Members (MemberSegment)
Source: Members tab (manual/auto) or auto-generated defaults.

Fields:
- id: unique integer
- start, end: transverse coordinates along bridge width (m)
- group: TOP_SLAB, BOTTOM_SLAB, LEFT_WALL, RIGHT_WALL, MIDDLE_WALL_1/2/3, GENERAL
- label: optional string

Important:
- In the current UI, start/end represent transverse width for ALL groups.
- Wall members are not vertical coordinates here; they are wall thickness ranges across width.
- Longitudinal sweep height is therefore taken from Project Settings (culvert_height), not from member rows.

### 2.3 Loads (LoadPatch)
Source: Loads tab or templates.

Fields:
- id, load_case
- load_type: PARTIAL_UDL, PATCH_LOAD, IRC_CLASS_AA, IRC_70R, IRC_CLASS_A, etc.
- start, end: transverse positions along width (m)
- intensity: kN/m (negative for downward gravity)
- intensity_end: optional for trapezoidal loads
- direction: GX/GY/GZ or X/Y/Z
- notes
- dispersion_enabled, fill_depth_override, contact_width


## 3. Geometry and Member Generation

### 3.1 Equal-width strips
Function: generate_equal_segments() in app/core/geometry.py

- Split total_width into N strips.
- For each strip:
  - start = i * strip_width
  - end = (i + 1) * strip_width

### 3.2 Box culvert auto-members (frontend)
Function: generateBoxCulvertMembers() in app/static/js/app.js

- Creates TOP_SLAB and BOTTOM_SLAB strips across width.
- Creates LEFT_WALL, RIGHT_WALL, and MIDDLE_WALL_* strips as wall thickness ranges along width.
- Updates total_width based on num_cells, clear_span, and wall thicknesses.

### 3.3 Reference axis normalization
Function: normalize_positions() in app/core/geometry.py

If user chooses RIGHT_EDGE, CENTERLINE, or CUSTOM:
- Member start/end are shifted or mirrored to match the internal LEFT_EDGE=0 system.


## 4. Load Creation and Templates

### 4.1 Manual loads
Function: create_load() in app/core/loads.py

Creates a load patch with start/end, intensity, and direction.

### 4.2 IRC templates (transverse)
Functions in app/core/loads.py:
- irc_class_aa_tracked()
- irc_70r_tracked()
- irc_70r_wheeled()
- irc_class_a_wheeled()

These return LoadPatch objects representing transverse wheel lines or tracks with typical IRC dimensions.

### 4.3 Live load dispersion through fill
Function: apply_dispersion() in app/core/loads.py

For fill depth h and dispersion angle theta (default 45 deg):
- effective_width = contact_width + 2 * h * tan(theta)
- intensity scales by contact_width / effective_width

This preserves total load while widening the patch.


## 5. Overlap Calculation (d1/d2)

Function: compute_overlaps() in app/core/overlap.py

For each (member, load) pair:
- overlap_start = max(member.start, load.start)
- overlap_end   = min(member.end, load.end)

If overlap_start < overlap_end:
- d1 = overlap_start - member.start
- d2 = overlap_end - member.start
- loaded_length = overlap_end - overlap_start

Trapezoidal loads:
- If intensity_end differs from intensity, interpolate intensity at overlap boundaries:
  - t = (x - load.start) / (load.end - load.start)
  - intensity(x) = intensity_start + t * (intensity_end - intensity_start)

Outputs:
- OverlapResult rows with d1/d2, intensities, STAAD format UNI/TRAP.


## 6. STAAD Export

Function: generate_staad_text() in app/core/staad_export.py

- Groups overlaps by load case.
- Assigns STAAD load numbers sequentially.
- Emits:
  - UNI load lines: member UNI direction f1 d1 d2
  - TRAP load lines: member TRAP direction w1 w2 d1 d2

Load type mapping (simplified):
- IRC and UDL types -> Live
- Dead load / wearing course -> Dead
- Earth / hydrostatic -> None


## 7. Longitudinal Moving-Load Sweep (Critical Position)

### 7.1 Geometry inference for sweep
Function: _infer_sweep_geometry() in app/main.py

Inputs:
- Project Settings (total_width, culvert_height, wall/slab thickness, structure type)
- Members (for total width and number of cells)

Derived values:
- num_cells: inferred from MIDDLE_WALL_* groups or structure_type
- clear_span:
  - clear_span = (total_width - (2*wall_thickness + (num_cells - 1)*mid_wall_thickness)) / num_cells
- clear_height: from settings.culvert_height

Important:
- Members are transverse strips; wall member start/end are NOT vertical coordinates.
- Height must therefore come from settings.

### 7.2 Frame model assembly (2D)
Function: _build_longitudinal_frame_model() in app/core/smart_features.py

- Nodes are created at (x, y) for each cell boundary:
  - Bottom nodes at y = 0
  - Top nodes at y = clear_height
- Elements:
  - Top slab elements between top nodes
  - Bottom slab elements between bottom nodes
  - Vertical wall elements between bottom and top nodes
- Each element uses:
  - Area A = thickness * 1.0 (unit width)
  - Inertia I = 1.0 * thickness^3 / 12
- 2D frame stiffness matrix (6x6) is assembled into global K
- Boundary conditions:
  - Bottom nodes fixed in Ux and Uy, free rotation (FIXED BUT MZ analog)

### 7.3 Vehicle library and sweep positions
Function: _irc_vehicle_library() in app/core/smart_features.py

The sweep uses vehicle axle loads and spacings for:
- CLASS_70R_WHEELED
- CLASS_70R_TRACKED
- CLASS_A
- SINGLE_AXLE_BOGIE
- DOUBLE_AXLE_BOGIE

Sweep range:
- Lead axle position ranges from -train_length to total_length
- Increment = user-specified (default 0.1 m)

### 7.3A STAAD moving-load input (optional override)
If the user pastes a STAAD block into the Results tab, the sweep uses those
TYPE trains instead of the IRC vehicle library.

Input format supported:
- DEFINE MOVING LOAD
- TYPE n LOAD <axle1> <axle2> ...
- DIST <spacing1> <spacing2> ...
- LOAD GENERATION <count> (optional)
- TYPE n <x> <y> <z> XINC <dx> (optional)

Parsing behavior:
- Each TYPE definition becomes one sweep vehicle (STAAD Type n).
- DIST values are treated as consecutive axle spacings.
- If LOAD GENERATION types are present, only those types are used.

### 7.4 Equivalent nodal loads (Hermitian shape functions)
For each axle load on the bridge:
- Identify the top slab element (span) it falls on
- Use Hermitian shape functions to distribute point load to element nodes
- Assemble global load vector F

### 7.5 Solve and internal forces
- Solve K * D = F for global displacements
- Convert to element local displacements and local end forces
- For each element, store end moments and shears

### 7.6 Bending moment diagram (per element)
For each element and sweep position:
- Sample 11 points along element length
- Compute internal moment at each point:
  - M(x) = V1 * x - M1 + sum(P_i * (x - a_i)) for loads to the left

### 7.7 Envelope accumulation
Across all sweep positions:
- Track M_max and M_min at every sample point
- Build per-group envelope arrays for:
  - TOP_SLAB
  - BOTTOM_SLAB
  - SIDE_WALL
  - INTERMEDIATE_WALL

Critical values tracked per group:
- Max sagging moment
- Max hogging moment
- Max shear force


## 8. Visualization Logic

### 8.1 Geometry (plan view)
File: app/static/js/visualization.js

- Draws member strips and load patches along width
- Shows overlap zones and labels

### 8.2 Results frame visualization
File: app/static/js/results_frame_viz.js

- Draws members and loads with d1/d2 annotation
- Shows overlap highlights and summary card

### 8.3 Longitudinal sweep visualization (BMD envelope)
File: app/static/js/app.js -> renderLongitudinalSweepViz()

- Uses model.total_length and model.clear_height to scale the frame
- Draws top slab, bottom slab, walls, and supports
- Plots BMD envelope:
  - Top slab: positive moment plotted inward (down)
  - Bottom slab: positive moment plotted inward (up)
  - Walls: positive moment plotted toward the cell interior
- Draws axle positions at the critical lead position

Important:
- Incorrect clear_height produces a distorted diagram (length shown as height)
- Height is now taken from Project Settings only


## 9. Reference Input Provided (STAAD Baseline)

This section preserves the engineer-provided baseline input for external STAAD verification.

### 9.1 JOINT COORDINATES

```
1   0.000  10.775  0
2   0.450  10.775  0
3   0.950  10.775  0
4   10.800 10.775  0
5   10.450 10.775  0
6   9.950  10.775  0

8   21.150 10.775  0
9   20.650 10.775  0
10  11.150 10.775  0
11  11.650 10.775  0
12  16.150 10.775  0
13  5.450  10.775  0
14  21.600 10.775  0

20  0.000  0       0
21  0.000  0.4     0
22  0.000  0.900   0

24  0.000  10.4    0
25  0.000  9.900   0
26  0.000  5.400   0
27  10.800 0       0
28  10.800 0.4     0
29  10.800 0.900   0

31  10.800 10.4    0
32  10.800 9.900   0
33  10.800 5.400   0

41  21.600 0       0
42  21.600 0.4     0
43  21.600 0.900   0

45  21.600 10.4    0
46  21.600 9.900   0
47  21.600 5.400   0
48  0.527  0       0
49  1.054  0       0
50  1.580  0       0
51  2.107  0       0
52  2.634  0       0
53  3.161  0       0
54  3.688  0       0
55  4.215  0       0
56  4.741  0       0
57  5.268  0       0
58  5.795  0       0
59  6.322  0       0
60  6.849  0       0
61  7.376  0       0
62  7.902  0       0
63  8.429  0       0
64  8.956  0       0
65  9.483  0       0
66  10.010 0       0
67  10.537 0       0
68  11.063 0       0
69  11.590 0       0
70  12.117 0       0
71  12.644 0       0
72  13.171 0       0
73  13.698 0       0
74  14.224 0       0
75  14.751 0       0
76  15.278 0       0
77  15.805 0       0
78  16.332 0       0
79  16.859 0       0
80  17.385 0       0
81  17.912 0       0
82  18.439 0       0
83  18.966 0       0
84  19.493 0       0
85  20.020 0       0
86  20.546 0       0
87  21.073 0       0

89  0.450  0       0
90  0.950  0       0
91  9.950  0       0
92  10.450 0       0
93  11.150 0       0
94  11.650 0       0
95  20.650 0       0
96  21.150 0       0

101 0      6.4     0
102 21.6   6.4     0
```

### 9.2 Moving load definitions (STAAD)

```
DEFINE MOVING LOAD
TYPE 1 LOAD 200
DIST 0
TYPE 2 LOAD 200 200
DIST 1.22
TYPE 3 LOAD 70 70 70 70 70 70 70 70 70 70
DIST 0.507778 0.507778 0.507778 0.507778 0.507778 0.507778 0.507778 0.507778 0.507778
TYPE 4 LOAD 80 120 120 170 170 170 170
DIST 3.96 1.52 2.13 1.37 3.05 1.37
TYPE 5 LOAD 170 170 170 170 120 120 80
DIST 1.37 3.05 1.37 2.13 1.52 3.96
TYPE 6 LOAD 27 27 114 114 68 68 68 68
DIST 1.1 3.2 1.2 4.3 3 3 3
TYPE 7 LOAD 68 68 68 68 114 114 27 27
DIST 3 3 3 4.3 1.2 3.2 1.1

LOAD GENERATION 350
TYPE 4 -13.4 10.775 0 XINC 0.1
LOAD GENERATION 350
TYPE 5 -13.4 10.775 0 XINC 0.1
LOAD GENERATION 216
TYPE 1 0 10.775 0 XINC 0.1
LOAD GENERATION 229
TYPE 2 -1.22 10.775 0 XINC 0.1
LOAD GENERATION 262
TYPE 3 -4.57 10.775 0 XINC 0.1
LOAD GENERATION 404
TYPE 6 -18.8 10.775 0 XINC 0.1
LOAD GENERATION 404
TYPE 7 -18.8 10.775 0 XINC 0.1

PERFORM ANALYSIS
DEFINE ENVELOPE
1 TO 350 ENVELOPE 1 TYPE STRENGTH
351 TO 700 ENVELOPE 2 TYPE STRENGTH
701 TO 916 ENVELOPE 3 TYPE STRENGTH
917 TO 1145 ENVELOPE 4 TYPE STRENGTH
1146 TO 1407 ENVELOPE 5 TYPE STRENGTH
1408 TO 1811 ENVELOPE 6 TYPE STRENGTH
1812 TO 2215 ENVELOPE 7 TYPE STRENGTH
END DEFINE ENVELOPE
```

Note:
- These definitions are preserved for external STAAD verification.
- The app longitudinal sweep uses its own IRC vehicle library in app/core/smart_features.py.
- If you want the sweep to match these exact trains, the library must be updated to reflect the same axle spacing and loads.


## 10. Known Limitations and Validation Notes

- Longitudinal sweep is a simplified 2D frame model (no skew, no 3D effects).
- Load dispersion uses a 45-degree method; adjust if your design code requires a different approach.
- Member table positions are transverse only; do not use them as vertical coordinates.
- STAAD export is member-load based; you should still run full STAAD analysis for final design.

Recommended validation:
- Compare STAAD BMD envelope with the sweep diagram for the same increment and vehicle.
- Ensure matching sign conventions when comparing sagging/hogging results.
- If the sweep diagram looks vertically distorted, verify Project Settings -> Culvert Height.
