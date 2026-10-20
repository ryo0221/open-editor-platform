# Geo workspace

Choose **Geo** in the Playground artifact library. Geo is a local geographic editor
for explanation and comparison with synthetic or user-selected local data. It has
one native document and the ordinary Host's command, Undo and immutable-version
history. It requests no background tiles, address lookup or external resources.

## Import, edit and save

Open **Import CSV / GeoJSON**, specify CRS84 longitude/latitude and map scalar
columns explicitly. Preview shows valid/problem rows. A problem blocks the whole
import unless you explicitly choose the listed exclusions. Use `attribute-table`
for a CSV without coordinates; `preserve-null` retains unknown locations.

Select the same stable feature from the map or accessible attribute table. Apply
position/geometry and scalar changes together. Invalid input and IME composition
are retained. Pan, zoom, selection and switching panels do not alter native data.
Point, LineString and simple single-ring Polygon geometry can be created/edited.
Holes and Multi geometry render and round-trip, with geometry editing disabled.
Polygon edit checks detect zero area, closure and self-intersection; they do not
certify shared boundaries or official topology.

Layer presentation supports a single color, categories, explicit class boundaries,
proportional symbols, labels, equality filters and missing values. Rates require an
explicit denominator; zero values, missing values and zero denominators are
separate. Enter indicator, unit and period for the legend. Save a named view to
retain its camera, classes and annotations, then save an immutable native version.
The equirectangular CRS84 renderer wraps short dateline paths and retains poles.
It is not a distance, area, navigation or travel-time calculation.

## Offline boundary backgrounds

In the Map panel, **Read-only boundary backgrounds** offers world countries,
world states/provinces and Japanese municipalities/wards (2017). Turn them on and
choose line colors without changing native content or Undo. Background boundaries
cannot be selected or edited. They use bundled, simplified data with no network
requests. These are historical explanatory boundaries, not an authoritative
current border register.

**Save named view**, then save a version, to retain only dataset ID/version/hash
and visibility/color settings. This explicit view-save is a normal native edit.
Choose that saved view for PNG and Slide map references. PNG credits and its receipt
retain attribution and exact pins; Slide's fixed PNG transfer also retains the
receipt in notes. A missing or mismatched dataset produces a visible diagnostic
and is omitted, preserving user features. CSV/GeoJSON exclude background data.
[Data versions, licenses and public API](geo-background-contract.md).

## Data → Geo → Slide

1. Create/import a Data table and save a version. CSV identifiers with leading
   zeros remain text. Use stable key columns with matching explicit types.
2. Save the current Geo version. In **Data 表との結合**, select the saved Data
   artifact, Geo layer and both key columns. Preview, inspect unmatched/null keys,
   then **Adopt previewed Data version**. Duplicate keys block the join.
3. Joined columns are read-only. Choose a joined numeric column for proportional
   symbols or classes and supply the legend metadata. Save Geo.
4. In Slide's **参照を埋め込む**, discover the Geo map and choose the update mode.
   **固定版 is the default**. **更新連動** must be selected explicitly and follows
   new saved Geo versions. Drafts and proposals do not publish updates.
5. Editing/saving Data shows a refresh candidate in Geo. It does not change Geo
   automatically. Preview/adopt the new Data version, then save Geo to update
   following Slide references. Fixed Slide references and exported PNGs retain
   their previous map. Named-view references preserve the explicitly saved view.

The same native reference validation, permissions, retained captures, fixed/follow
inspection and export behavior used by Data/Graph applies to Geo. Geo is not a
shared collaborative domain or template/reuse domain in this Host.

## Outputs, assets and repeated work

**Generate fixed PNG** uses an explicitly selected saved native version and named
view, includes the legend/credits and provides a provenance receipt with hashes,
input pins, extent, projection and pixels. **Place PNG on Slide** downloads a normal
Slide native artifact containing that immutable image and receipt in notes. Open
that file with the ordinary artifact import. Live references use the separate
reference operation above.

**GeoJSON / CSV export** requires explicit layer/field selection and loss consent.
Joined columns can be selected; the receipt includes both pinned join inputs.
CSV uses RFC4180 UTF-8 with JSON scalar data cells to preserve types. Images omit
hidden attributes, asset notes and photographs. Native JSON preserves the complete
retained resource closure and version history, including private attributes/photos;
review it before sharing. The sources list separately exports a selected original
file, with its original attributes or photo bytes, by explicit user action.

Reimport previews a replacement outside native data and adopts it only after
confirmation. Stable typed external IDs preserve feature/row IDs; ambiguous IDs
block refresh. Old versions remain available. Asset inspection retains ID, notes,
date, accuracy and bounded local PNG/JPEG references even for unknown locations.
Comparison records two pinned versions, selected fields, a coordinate tolerance
and explicit coverage; an absent counterpart is not called a deletion unless
complete coverage is confirmed.

This candidate retains the existing bounded profile: 200 features, 1,000 vertices,
10 layers, 64KiB native content, 100,000 original bytes and 10 original resources.
Derived rows/styles also consume the native budget; 200 features is not a promise
that every attribute/view combination fits. Independent sample Hosts retain 16
versions/4MiB without automatic deletion. Playground Data captures retain at most
16 immutable inputs. Invalid/unknown schema, missing originals/dependencies and
hash conflicts refuse opening/saving/export without deleting the stored artifact.
Back up native JSON before updates; restoring the matching application revision
and importing that JSON preserves its original IDs and retained versions.
