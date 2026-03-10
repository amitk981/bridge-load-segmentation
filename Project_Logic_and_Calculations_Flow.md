# STAAD Logic and Calculations Flow
This document outlines the end-to-end data flow, calculations, and plotting logic implemented in the Box Culvert Bending Moment Diagram (BMD) generation module.

## 1. User Input & Geometry Definition
**Location:** Frontend Dashboard (`app/templates/index.html` & `app/static/js/app.js`)

The civil engineer enters structural configuration via the web UI. These inputs adhere correctly to the standard `JOINT COORDINATES` definition format.
Key inputs include:
- **Total Width (m), Clear Height (m), Clear Span (m)**
- **Wall Thicknesses** (External, Internal) & **Slab Thicknesses** (Top, Bottom)
- **Number of Cells** (`1` to `N` cells)

These are packaged into a JSON payload and submitted via `POST` to the backend when the user clicks **Analysis** or a **Smart Feature Run**.

## 2. Moving Load Library (IRC)
**Location:** Backend (`app/core/smart_features.py`)

A pre-defined library of load configurations (`_irc_vehicle_library`) is stored in Python memory. This contains standard vehicles (e.g., `IRC_70R_TRACKED`, `IRC_CLASS_A_WHEELED`).
Each vehicle consists of:
- `axle_loads_kN`: The list of axle load magnitudes.
- `axle_spacings_m`: The relative offsets of subsequent axles from the leading axle.

## 3. Structural Frame Model Assembly
**Location:** Backend (`app/core/smart_features.py -> _build_longitudinal_frame_model()`)

The python application dynamically builds a 2D stiffness matrix model based on the input geometry.
- **Top and Bottom Slabs** are split into multiple beam elements along the total span.
- **Vertical Walls** (Left, Right, and Intermediate Walls) are set as distinct vertical elements.
- **Nodes** are placed at member intersections.
- The `bottom_slab` nodes can optionally be given supports (pinned, fixed, or free). In the standard box culvert script, nodes at the bottom are constrained in $U_x$ and $U_y$ but free to rotate (`FIXED BUT MZ` analog).
- **Element Properties** are calculated dynamically: Length ($L$), Area ($A$), and Moment of Inertia ($I=bt^3/12$) using the provided wall/slab thicknesses and a unit width ($b=1m$).

We then calculate the local stiffness matrix $k_{local}$ and transformations to global $K_{global}$. This process is the classic Direct Stiffness Method.

## 4. Sweeping the Moving Load
**Location:** Backend (`app/core/smart_features.py -> compute_longitudinal_critical_positions()`)

The vehicle load train runs across the defined bridge span. For a given load trace:
1. The **Lead Axle Position** ranges from `-train_length` to `total_span`.
2. For each step (`increment=0.1` m):
   - The global load array ($F_{global}$) is reset.
   - For every axle currently on the bridge deck, an **Equivalent Nodal Load** is computed on the specific slab element carrying the point load.
   - We utilize **Hermitian Shape Functions** to transfer the local transverse concentrated load into end-node Moments and Shear forces, pushing them into $F_{global}$.
   - The matrix equation $F = K D$ is solved for global displacements $D$.
   - Using $D$, the `current_f_local` end forces ($N, V, M$) are calculated for every element.

## 5. Envelope Accumulation
**Location:** Backend (`app/core/smart_features.py -> _solve_frame_for_vehicle_position()`)

Instead of just recording a single "peak" snapshot, the application generates a complete continuous **Bending Moment Diagram Envelope**.
1. For every element at every sweep step, internal Bending Moments are calculated at 11 uniformly spaced points.
   - $M(x) = V_1 x - M_1 - \sum P_i (x - a_i)$
2. A persistent tracking object (`envelope_points`) stores the max and min values for every spatial point ($x, y$ coordinate).
   - `M_max` tracks the maximum positive (sagging) moment at that exact spatial node.
   - `M_min` tracks the maximum negative (hogging) moment limit.
3. This envelope is returned in the API payload array for all elements (`TOP_SLAB`, `BOTTOM_SLAB`, `SIDE_WALL`, `INTERMEDIATE_WALL`).

## 6. Visualization & Plotting (Tension-Side Convention)
**Location:** Frontend Canvas (`app/static/js/app.js -> renderLongitudinalSweepViz()`)

Civil engineering requires Bending Moment Diagrams to align with the **Tension Face** of the member. The frontend parses the `M_max` and `M_min` bounding points and maps them to plot outwards or inwards appropriately using canvas drawing contexts (`ctx`):

1. **Top Slab:** Positive moment means top compression / bottom tension. Positive $M$ plots downward / inwards into the cell. 
2. **Bottom Slab:** Upward earth pressure causes top tension, so Positive $M$ plots upward / inwards.
3. **Walls (Left/Right):** Soil pressure from outside causes internal tension; Positive $M$ plots towards the center of the box. Bending continuity causing outside tension (hogging) plots outwards.

Both the Max and Min envelopes are drawn sequentially, and a colored translucent polygon (`fillStyle = 'rgba(56, 189, 248, 0.25)'`) fills the gap to create the continuous BMD Envelope diagram. This visual output maps precisely 1:1 with STAAD Pro's `DEFINE ENVELOPE` visual displays, fulfilling the engineer's expectations.
