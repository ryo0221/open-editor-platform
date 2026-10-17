/** UI guidance only: preserve diagnostic codes and never change acceptance decisions. */
export function importDiagnosticText(code: string): string {
  const help: Record<string, string> = {
    'csv-column-mapping':
      'Check exact CSV header names (including case and spaces). Assign both coordinate columns and map every remaining column; remove mappings for columns that are not in this file.',
    'csv-header': 'Use one non-empty, unique name per CSV header column.',
    'attribute-type':
      'Check the selected Type for this column/property or correct the source value. CSV numbers use decimal notation without grouping separators; booleans must be true or false. Use string for codes with leading zeros. GeoJSON values must already have the selected type.',
    'coordinate-number':
      'Both coordinates must be finite numbers, not blank text. Correct the source row. If both are empty and location is unknown, explicitly choose preserve-null; a single missing coordinate is still an error.',
    'coordinate-range':
      'Check the coordinate columns and order. Longitude must be between -180 and 180; latitude between -90 and 90. Correct the source if needed; coordinates are not swapped automatically.',
    'csv-column-count':
      'Check separators and quoting: this data record must have the same number of columns as the header.',
    'unmapped-property':
      'Add a mapping for every GeoJSON property. Property names must match exactly; nothing is dropped automatically.',
    'nested-property':
      'This property contains an object or array, which scalar import cannot accept. Keep the original and prepare an explicitly converted scalar source, or exclude the row.',
    'geojson-legacy-crs':
      'This GeoJSON declares a legacy CRS. Supply RFC7946 coordinates in longitude, latitude order; this importer does not reproject data.',
    'null-geometry':
      'If there are no other errors, the record is retained without a location. It can appear in the table but has no map point.',
    'missing-external-id':
      'No source ID was supplied. The preview assigns an internal stable ID; this warning does not remove the record.',
    'duplicate-external-id':
      'Source IDs repeat. Records remain separate with distinct internal IDs; no first-match row is chosen.',
  };
  return Object.hasOwn(help, code) ? `${code} — ${help[code]}` : code;
}
